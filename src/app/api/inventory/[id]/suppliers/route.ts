import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getSupplierOffers } from '@/lib/supplier-offers'
import { requireSession, AuthError } from '@/lib/auth'
import { setPrimaryOffer, syncPrimaryOfferToItem } from '@/lib/primary-offer'
import { propagatePrepCostChanges } from '@/lib/recipeCosts'
import { seesItemMoney, redactOffer } from '@/lib/inventory-redact'
import { offerListedPrice } from '@/lib/offer-price'
import { invalidatesTheoretical } from '@/lib/theoretical-cache'
import {
  validateBox, normalizeCode, boxRefusal, itemRefusal, sameProductWhere,
  BOX_ITEM_SELECT, DUPLICATE_BOX_ERROR, ITEM_NOT_FOUND, type BoxInput,
} from '@/lib/box-rules'

export const dynamic = 'force-dynamic'

// GET /api/inventory/[id]/suppliers — offers + derived history stats
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const offers = await getSupplierOffers(params.id)
  // STAFF: which suppliers carry it and their pack format, never what they charge.
  return NextResponse.json(seesItemMoney(user.role) ? offers : offers.map(o => redactOffer(o)))
}

// PATCH /api/inventory/[id]/suppliers — { offerId } → set primary (clears siblings)
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  // Switching the primary offer re-prices the item — an item edit, MANAGER+.
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const body = await req.json().catch(() => ({}))
  if (!body.offerId) return NextResponse.json({ error: 'offerId required' }, { status: 400 })
  const offer = await prisma.inventorySupplierPrice.findFirst({
    where: { id: body.offerId, inventoryItemId: params.id },
    select: { id: true },
  })
  if (!offer) return NextResponse.json({ error: 'Offer not found' }, { status: 404 })
  const result = await setPrimaryOffer(params.id, body.offerId)
  // A primary switch is a spine change — propagate to dependent PREP recipes so
  // their costs (and every report/recipe/count read) reflect the new price now.
  // Matches the manual-edit path; session-scoped PriceAlerts are not created here.
  if (result.changed) await propagatePrepCostChanges([params.id])
  return NextResponse.json({ ok: true, repriced: result.changed, ppb: result.newPpb })
}

const ITEM_STALE = 'Someone saved this item a moment ago. Reload to see their change before saving yours.'
/** Thrown inside the transaction when the item moved on after the read. */
class StaleItem extends Error {}

// POST /api/inventory/[id]/suppliers — add a supplier box.
// Body { supplierId, supplierItemCode?, packChain, pricing, makePrimary?, expectedLastUpdated }
// (the ITEM's lastUpdated). An item's first box is always its main box; after
// that a new box is main only when asked. A main box re-prices the item (R4).
async function handlePOST(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = (await req.json().catch(() => null)) ?? {}
  const code = body.supplierItemCode
  if (typeof body.supplierId !== 'string' || !body.supplierId || !body.packChain || !body.pricing
    || !body.expectedLastUpdated
    || (code != null && typeof code !== 'string')
    || (body.makePrimary !== undefined && typeof body.makePrimary !== 'boolean')) {
    return NextResponse.json({ error: 'Reload the item and try again.', code: 'BAD_FIELD' }, { status: 400 })
  }

  const item = await prisma.inventoryItem.findUnique({ where: { id: params.id }, select: BOX_ITEM_SELECT })
  if (!item) return NextResponse.json(ITEM_NOT_FOUND, { status: 404 })
  const refused = itemRefusal(item)
  if (refused) return NextResponse.json(refused, { status: 409 })

  // R8 — the add names the item version it was made from.
  if (new Date(body.expectedLastUpdated).getTime() !== item.lastUpdated.getTime()) {
    return NextResponse.json({ error: ITEM_STALE, code: 'STALE' }, { status: 409 })
  }

  const supplier = await prisma.supplier.findUnique({ where: { id: body.supplierId }, select: { id: true, name: true } })
  if (!supplier) return NextResponse.json({ error: "That supplier doesn't exist.", code: 'NOT_FOUND' }, { status: 404 })

  const box: BoxInput = {
    supplierId: supplier.id, supplierItemCode: normalizeCode(code),
    packChain: body.packChain, pricing: body.pricing,
  }
  const bad = boxRefusal(validateBox(item, box))
  if (bad) return NextResponse.json(bad, { status: 400 })

  const dup = await prisma.inventorySupplierPrice.findFirst({
    where: { inventoryItemId: params.id, supplierId: supplier.id, ...sameProductWhere(box.supplierItemCode ?? null) },
    select: { id: true },
  })
  if (dup) return NextResponse.json({ error: DUPLICATE_BOX_ERROR, code: 'DUPLICATE_BOX' }, { status: 409 })

  let isPrimary: boolean
  try {
    isPrimary = await prisma.$transaction(async (tx) => {
      // The write re-checks the version read — and locks the item row, so two
      // adds to a box-less item cannot both become its main box.
      const { count } = await tx.inventoryItem.updateMany({
        where: { id: params.id, lastUpdated: item.lastUpdated },
        data: { lastUpdated: new Date() },
      })
      if (count === 0) throw new StaleItem()
      const boxes = await tx.inventorySupplierPrice.count({ where: { inventoryItemId: params.id } })
      const primary = boxes === 0 || body.makePrimary === true
      // One main box per item (partial unique index): clear the old one first.
      if (primary && boxes > 0) {
        await tx.inventorySupplierPrice.updateMany({ where: { inventoryItemId: params.id }, data: { isPrimary: false } })
      }
      await tx.inventorySupplierPrice.create({
        data: {
          inventoryItemId: params.id,
          supplierId: supplier.id,
          supplierName: supplier.name,
          supplierItemCode: box.supplierItemCode ?? null,
          packChain: box.packChain as unknown as Prisma.InputJsonValue,
          pricing: box.pricing as unknown as Prisma.InputJsonValue,
          // DEPRECATED NOT NULL column (dropped by Stage 1e) — filled, never read.
          lastPrice: offerListedPrice({ pricing: box.pricing }),
          isPrimary: primary,
          lastInvoiceSessionId: null,
          packQty: null, packSize: null, packUOM: null,
          lastUpdated: new Date(),
        },
      })
      if (primary) await syncPrimaryOfferToItem(params.id, tx)
      return primary
    })
  } catch (e) {
    if (e instanceof StaleItem) return NextResponse.json({ error: ITEM_STALE, code: 'STALE' }, { status: 409 })
    // A same-product box added between the check and the create.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return NextResponse.json({ error: DUPLICATE_BOX_ERROR, code: 'DUPLICATE_BOX' }, { status: 409 })
    }
    throw e
  }

  // A new main box is a spine change — re-cost the PREP recipes that use the item.
  if (isPrimary) await propagatePrepCostChanges([params.id])
  return NextResponse.json(await getSupplierOffers(params.id))
}

// Stock-valuing writes drop the cached theoretical-stock map (inventory list, cost chrome).
export const POST = invalidatesTheoretical(handlePOST)
