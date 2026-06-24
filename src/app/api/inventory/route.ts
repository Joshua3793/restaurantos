import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  DIMENSION_BASE, pricePerBaseUnit as chainPricePerBaseUnit,
  validateChainItem, withPpb, asChainItem, type ChainItem,
} from '@/lib/item-model'
import { getTheoreticalStockMap } from '@/lib/count-expected'

/** Attach theoreticalStock, countedStock, lastCountDate to each item row. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attachTheoreticalFields<T extends Record<string, any>>(
  items: T[],
  theoMap: Map<string, number>,
): (T & { theoreticalStock: number; countedStock: number; lastCountDate: string | null; pricePerBaseUnit: number })[] {
  return items.map(item => {
    // Use a pre-set countedStock when the caller already captured the raw value (e.g. the
    // "All RCs" path pre-sets it before inflating stockOnHand with allocTotal). Otherwise
    // derive it from the current stockOnHand.
    const counted = item.countedStock !== undefined ? Number(item.countedStock) : Number(item.stockOnHand)
    const theoretical = theoMap.has(item.id) ? theoMap.get(item.id)! : counted
    const lastCountDate = item.lastCountDate
      ? (item.lastCountDate instanceof Date ? item.lastCountDate.toISOString() : String(item.lastCountDate))
      : null
    // Re-populate the `pricePerBaseUnit` response field by computing it from the
    // chain so client readers (inventory/page, GlobalSearch, setup/categories,
    // wastage selectedItem) survive the legacy column drop.
    return {
      ...item,
      theoreticalStock: theoretical,
      countedStock: counted,
      lastCountDate,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pricePerBaseUnit: chainPricePerBaseUnit(asChainItem(item as any)),
    }
  })
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const search      = searchParams.get('search') || ''
  const category    = searchParams.get('category') || ''
  const supplierId  = searchParams.get('supplierId') || ''
  const storageAreaId = searchParams.get('storageAreaId') || ''
  const isActive    = searchParams.get('isActive')
  const rcId        = searchParams.get('rcId') || ''
  const isDefault   = searchParams.get('isDefault') === 'true'
  // Non-stocked (recipe-only) items are hidden from the operational list by default;
  // the inventory page passes includeNonStocked=true to reveal them.
  const includeNonStocked = searchParams.get('includeNonStocked') === 'true'

  const itemWhere = {
    AND: [
      search ? { itemName: { contains: search, mode: 'insensitive' as const } } : {},
      category ? { category } : {},
      supplierId ? { supplierId } : {},
      storageAreaId ? { storageAreaId } : {},
      isActive !== null && isActive !== '' ? { isActive: isActive === 'true' } : {},
      includeNonStocked ? {} : { isStocked: true },
    ],
  }

  const itemInclude = {
    supplier: true,
    storageArea: true,
    recipe: { select: { id: true, name: true } },
  }

  // Non-default RC: only show items that have been allocated to this RC
  if (rcId && !isDefault) {
    const allocations = await prisma.stockAllocation.findMany({
      where: { revenueCenterId: rcId },
      include: { inventoryItem: { include: itemInclude } },
      orderBy: [{ inventoryItem: { category: 'asc' } }, { inventoryItem: { itemName: 'asc' } }],
    })
    const lc = search.toLowerCase()
    const items = allocations
      .map(a => ({
        ...a.inventoryItem,
        rcStock:    Number(a.quantity),
        parLevel:   a.parLevel   !== null ? Number(a.parLevel)   : null,
        reorderQty: a.reorderQty !== null ? Number(a.reorderQty) : null,
      }))
      .filter(i =>
        (!search      || i.itemName?.toLowerCase().includes(lc)) &&
        (!category    || i.category === category) &&
        (!supplierId  || i.supplierId === supplierId) &&
        (!storageAreaId || i.storageAreaId === storageAreaId) &&
        (isActive === null || isActive === '' || String(i.isActive) === isActive) &&
        (includeNonStocked || i.isStocked !== false)
      )
    const itemIds = items.map(i => i.id)
    const theoMap = await getTheoreticalStockMap(rcId, itemIds)
    return NextResponse.json(attachTheoreticalFields(items, theoMap), {
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  // Default RC (Cafe): stockOnHand IS Cafe's pool – return as-is
  if (rcId && isDefault) {
    const [items, allocations] = await Promise.all([
      prisma.inventoryItem.findMany({
        where: itemWhere,
        include: itemInclude,
        orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
      }),
      prisma.stockAllocation.findMany({
        where: { revenueCenterId: rcId },
        select: { inventoryItemId: true, parLevel: true, reorderQty: true },
      }),
    ])
    const allocByItemId = Object.fromEntries(allocations.map(a => [a.inventoryItemId, a]))
    const result = items.map(i => {
      const alloc = allocByItemId[i.id]
      return {
        ...i,
        parLevel:   alloc?.parLevel !== null && alloc?.parLevel !== undefined ? Number(alloc.parLevel) : null,
        reorderQty: alloc?.reorderQty !== null && alloc?.reorderQty !== undefined ? Number(alloc.reorderQty) : null,
      }
    })
    const itemIds = result.map(i => i.id)
    const theoMap = await getTheoreticalStockMap(rcId, itemIds)
    return NextResponse.json(attachTheoreticalFields(result, theoMap), { headers: { 'Cache-Control': 'no-store' } })
  }

  // "All Revenue Centers": total physical stock = stockOnHand (Cafe pool) + all RC allocations
  // Exclude default-RC allocations: the default RC's stock already lives in stockOnHand, so
  // summing its allocation on top would double-count it.
  const rawItems = await prisma.inventoryItem.findMany({
    where: itemWhere,
    include: {
      ...itemInclude,
      stockAllocations: { where: { revenueCenter: { isDefault: false } }, select: { quantity: true } },
    },
    orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
  })
  const items = rawItems.map(({ stockAllocations, ...item }) => {
    const rawStockOnHand = Number(item.stockOnHand)  // actual last-counted value — used for countedStock anchor
    const allocTotal = stockAllocations.reduce((s, a) => s + Number(a.quantity), 0)
    // stockOnHand is inflated for display (pooled total across all RCs), but we pre-attach
    // countedStock from the raw value so attachTheoreticalFields sees the true last-counted figure.
    return { ...item, stockOnHand: rawStockOnHand + allocTotal, countedStock: rawStockOnHand }
  })
  const itemIds = items.map(i => i.id)
  const theoMap = await getTheoreticalStockMap(null, itemIds)
  return NextResponse.json(attachTheoreticalFields(items, theoMap), {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function POST(req: NextRequest) {
  const body = await req.json()

  // The chain columns (dimension/baseUnit/packChain/pricing/countUnit) are the
  // single source of truth. Every create path (inventory add, count quick-add,
  // CSV import) sends a chain body — there is no legacy-field create path.
  const { dimension, packChain, pricing, countUnit, supplierId, storageAreaId, revenueCenterId, ...rest } = body
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
