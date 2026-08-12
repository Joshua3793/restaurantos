import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  DIMENSION_BASE,
  validateChainItem, withPpb, dimensionOf, type ChainItem,
} from '@/lib/item-model'
import { requireSession, AuthError } from '@/lib/auth'
import { fetchInventoryList, parseInventoryListParams } from '@/lib/inventory-list'

export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const { rows } = await fetchInventoryList(user, parseInventoryListParams(searchParams))
  return NextResponse.json(rows, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const body = await req.json()

  // The chain columns (dimension/baseUnit/packChain/pricing/countUnit) are the
  // single source of truth. Every create path (inventory add, count quick-add,
  // CSV import) sends a chain body — there is no legacy-field create path.
  const { dimension, packChain, pricing, countUnit, supplierId, storageAreaId, revenueCenterId,
          eachMeasureQty, eachMeasureUnit, ...rest } = body
  if (!packChain) {
    return NextResponse.json({ error: 'packChain is required' }, { status: 400 })
  }
  // Strip any stray non-column keys the client may have sent.
  delete rest.pricePerBaseUnit; delete rest.baseUnit
  delete rest.dimension; delete rest.pricing; delete rest.countUnit

  const ci: ChainItem = {
    dimension,
    baseUnit: DIMENSION_BASE[dimension as keyof typeof DIMENSION_BASE],
    packChain,
    pricing,
    countUnit,
  }
  const errors = validateChainItem(ci)
  if (errors.length) return NextResponse.json({ error: errors.join('; ') }, { status: 400 })

  // Non-stocked (recipe-only) items carry no inventory value — pin spine price to 0.
  const isStocked = body.isStocked !== false

  // A declared opening stock IS an initial count: stamp lastCountDate/lastCountQty so
  // the value becomes a dated baseline rather than an undated, never-counted balance
  // whose later receipts the theoretical engine would otherwise have to treat as
  // epoch-wide. Only when a positive opening stock is provided (0 = nothing to anchor).
  const openingStock = Number(rest.stockOnHand)
  const hasOpeningStock = Number.isFinite(openingStock) && openingStock > 0

  const item = await prisma.inventoryItem.create({
    data: {
      ...rest,
      isStocked,
      ...(hasOpeningStock ? { lastCountDate: new Date(), lastCountQty: openingStock } : {}),
      // chain columns (authoritative)
      dimension,
      packChain: packChain as any,
      pricing: pricing as any,
      countUnit,
      baseUnit: ci.baseUnit,
      supplierId: supplierId || null,
      storageAreaId: storageAreaId || null,
      // Count↔weight bridge — valid in either direction (see [id] PUT route),
      // so not gated on dimension; the unit must be a measured one.
      eachMeasureQty: Number(eachMeasureQty) > 0 && eachMeasureUnit && dimensionOf(String(eachMeasureUnit)) !== 'COUNT'
        ? Number(eachMeasureQty) : null,
      eachMeasureUnit: Number(eachMeasureQty) > 0 && eachMeasureUnit && dimensionOf(String(eachMeasureUnit)) !== 'COUNT'
        ? String(eachMeasureUnit) : null,
    },
    include: { supplier: true, storageArea: true },
  })

  // A new item joins exactly the RC chosen at creation (default RC if none) — its first
  // ItemRevenueCenter membership, so it shows up in that RC's counts. More RCs are added
  // later via the item drawer / inventory bulk action.
  const chosenRc =
    revenueCenterId ||
    (await prisma.revenueCenter.findFirst({ where: { isDefault: true }, select: { id: true } }))?.id
  if (chosenRc) {
    await prisma.itemRevenueCenter
      .create({ data: { inventoryItemId: item.id, revenueCenterId: chosenRc } })
      .catch(e => console.error('[inventory POST] membership create', e))
  }

  return NextResponse.json(withPpb(item), { status: 201 })
}
