import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getSupplierOffers } from '@/lib/supplier-offers'
import { requireSession, AuthError } from '@/lib/auth'
import { ensurePrimary, syncPrimaryOfferToItem } from '@/lib/primary-offer'
import { propagatePrepCostChanges } from '@/lib/recipeCosts'
import { offerListedPrice } from '@/lib/offer-price'
import { normItemCode } from '@/lib/invoice/line-format'
import { invalidatesTheoretical } from '@/lib/theoretical-cache'
import {
  validateBox, normalizeCode, boxRefusal, itemRefusal, sameProductWhere,
  BOX_ITEM_SELECT, DUPLICATE_BOX_ERROR, ITEM_NOT_FOUND, type BoxInput,
} from '@/lib/box-rules'
import type { PackLink, Pricing } from '@/lib/item-model'

export const dynamic = 'force-dynamic'

// One supplier box (an InventorySupplierPrice row) of one item: edit it or
// remove it. Both name the BOX's version (`expectedLastUpdated` = the box's
// lastUpdated), and both keep the item equal to its main box (R4).

type Ctx = { params: { id: string; offerId: string } }

const BOX_STALE = 'Someone changed this supplier box a moment ago. Reload to see their change before saving yours.'
const BOX_GONE = { error: 'That supplier box is no longer there. Reload the item.', code: 'NOT_FOUND' } as const
const ZERO_PRICE_ERROR = 'price must be above $0'
const BAD_FIELD = { error: 'Reload the item and try again.', code: 'BAD_FIELD' } as const
/** Thrown inside a transaction when the box moved on after the read. */
class StaleBox extends Error {}

/** The role gate, the item refusals and the box's own version check, shared by
 *  PATCH and DELETE. Returns a response to send, or the item + box to act on. */
async function loadBox(req: NextRequest, { params }: Ctx) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return { res: NextResponse.json({ error: e.message }, { status: e.status }) }
    throw e
  }
  const body = (await req.json().catch(() => null)) ?? {}
  if (!body.expectedLastUpdated) return { res: NextResponse.json(BAD_FIELD, { status: 400 }) }

  const item = await prisma.inventoryItem.findUnique({ where: { id: params.id }, select: BOX_ITEM_SELECT })
  if (!item) return { res: NextResponse.json(ITEM_NOT_FOUND, { status: 404 }) }
  const refused = itemRefusal(item)
  if (refused) return { res: NextResponse.json(refused, { status: 409 }) }

  const box = await prisma.inventorySupplierPrice.findFirst({
    where: { id: params.offerId, inventoryItemId: params.id },
    select: {
      id: true, supplierId: true, supplierItemCode: true, packChain: true, pricing: true,
      isPrimary: true, lastUpdated: true,
    },
  })
  if (!box) return { res: NextResponse.json(BOX_GONE, { status: 404 }) }

  // R8 — the save names the box version it was made from.
  if (new Date(body.expectedLastUpdated).getTime() !== box.lastUpdated.getTime()) {
    return { res: NextResponse.json({ error: BOX_STALE, code: 'STALE' }, { status: 409 }) }
  }
  return { body, item, box }
}

// PATCH /api/inventory/[id]/suppliers/[offerId] — edit a box's pack, price or
// product code. Body { packChain?, pricing?, supplierItemCode?, expectedLastUpdated }.
// The merged box is judged whole against the item; a main box re-prices the item.
async function handlePATCH(req: NextRequest, ctx: Ctx) {
  const loaded = await loadBox(req, ctx)
  if (loaded.res) return loaded.res
  const { body, item, box } = loaded
  const { id, offerId } = ctx.params

  const code = body.supplierItemCode
  if ((body.packChain === undefined && body.pricing === undefined && code === undefined)
    || (code != null && typeof code !== 'string')) {
    return NextResponse.json(BAD_FIELD, { status: 400 })
  }

  const next: BoxInput = {
    supplierId: box.supplierId,
    supplierItemCode: code !== undefined ? normalizeCode(code) : box.supplierItemCode,
    packChain: (body.packChain ?? box.packChain) as PackLink[],
    pricing: (body.pricing ?? box.pricing) as Pricing,
  }
  // Judge only what this save changes: an error the stored box already had is
  // excused while its chain is untouched (a legacy box can still get a new code
  // or price). A changed chain is judged whole, and a $0 price is never excused.
  const chainChanged = body.packChain !== undefined
    && JSON.stringify(body.packChain) !== JSON.stringify(box.packChain)
  const stored = chainChanged
    ? new Set<string>()
    : new Set(validateBox(item, {
      supplierId: box.supplierId, supplierItemCode: box.supplierItemCode,
      packChain: box.packChain as PackLink[], pricing: box.pricing as Pricing,
    }))
  const errors = validateBox(item, next).filter(e => !stored.has(e) || e === ZERO_PRICE_ERROR)
  const bad = boxRefusal(errors)
  if (bad) return NextResponse.json(bad, { status: 400 })

  // A new product code must not collide with another box of the same supplier.
  if (normItemCode(next.supplierItemCode) !== normItemCode(box.supplierItemCode)) {
    const dup = await prisma.inventorySupplierPrice.findFirst({
      where: {
        id: { not: offerId }, inventoryItemId: id, supplierId: box.supplierId,
        ...sameProductWhere(next.supplierItemCode ?? null),
      },
      select: { id: true },
    })
    if (dup) return NextResponse.json({ error: DUPLICATE_BOX_ERROR, code: 'DUPLICATE_BOX' }, { status: 409 })
  }

  let synced: { changed: boolean } = { changed: false }
  try {
    synced = await prisma.$transaction(async (tx) => {
      // The write itself re-checks the version it read, closing the window
      // between the read-time STALE check and this update.
      const { count } = await tx.inventorySupplierPrice.updateMany({
        where: { id: offerId, inventoryItemId: id, lastUpdated: box.lastUpdated },
        data: {
          packChain: next.packChain as unknown as Prisma.InputJsonValue,
          pricing: next.pricing as unknown as Prisma.InputJsonValue,
          supplierItemCode: next.supplierItemCode ?? null,
          // DEPRECATED NOT NULL column (dropped by Stage 1e) — kept in step, never read.
          lastPrice: offerListedPrice({ pricing: next.pricing }),
          lastUpdated: new Date(),
        },
      })
      if (count === 0) throw new StaleBox()
      // Always sync: it is a no-op unless a main box exists, and it re-reads which
      // box is main INSIDE this transaction, so a promote/demote that raced the
      // read-time `box.isPrimary` can never leave the item behind its main box.
      return syncPrimaryOfferToItem(id, tx)
    })
  } catch (e) {
    if (e instanceof StaleBox) return NextResponse.json({ error: BOX_STALE, code: 'STALE' }, { status: 409 })
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return NextResponse.json({ error: DUPLICATE_BOX_ERROR, code: 'DUPLICATE_BOX' }, { status: 409 })
    }
    throw e
  }

  // The main box's price IS the item's — re-cost the PREP recipes that use it.
  if (synced.changed) await propagatePrepCostChanges([id])
  return NextResponse.json(await getSupplierOffers(id))
}

// DELETE /api/inventory/[id]/suppliers/[offerId] — remove a box.
// Body { expectedLastUpdated }. Removing the main box promotes the most recently
// updated remaining box and the item follows it; removing the LAST box leaves the
// item's own pack and price as they were (editable again on the item).
async function handleDELETE(req: NextRequest, ctx: Ctx) {
  const loaded = await loadBox(req, ctx)
  if (loaded.res) return loaded.res
  const { box } = loaded
  const { id, offerId } = ctx.params

  let promoted: string | null = null
  try {
    promoted = await prisma.$transaction(async (tx) => {
      const primariesBefore = (await tx.inventorySupplierPrice.findMany({
        where: { inventoryItemId: id, isPrimary: true }, select: { id: true },
      })).map(b => b.id)
      const { count } = await tx.inventorySupplierPrice.deleteMany({
        where: { id: offerId, inventoryItemId: id, lastUpdated: box.lastUpdated },
      })
      if (count === 0) throw new StaleBox()
      // Always settle the main box (a no-op when exactly one exists) so a
      // concurrent promote/demote can't leave the item with none. The item
      // re-follows when the deleted box was main or a box was just promoted.
      const next = await ensurePrimary(id, tx)
      const unchanged = next != null && primariesBefore.length === 1 && primariesBefore[0] === next
      if (next && !unchanged) {
        await syncPrimaryOfferToItem(id, tx)
        return next
      }
      return null
    })
  } catch (e) {
    if (e instanceof StaleBox) return NextResponse.json({ error: BOX_STALE, code: 'STALE' }, { status: 409 })
    throw e
  }

  if (promoted) await propagatePrepCostChanges([id])
  return NextResponse.json(await getSupplierOffers(id))
}

// Stock-valuing writes drop the cached theoretical-stock map (inventory list, cost chrome).
export const PATCH = invalidatesTheoretical(handlePATCH)
export const DELETE = invalidatesTheoretical(handleDELETE)
