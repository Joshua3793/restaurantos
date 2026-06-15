import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit } from '@/lib/utils'
import { assertKnownUnit, UnitError } from '@/lib/uom'
import { resolveCountUom } from '@/lib/count-uom'
import { getTheoreticalStockMap } from '@/lib/count-expected'

/** Attach theoreticalStock, countedStock, lastCountDate to each item row. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attachTheoreticalFields<T extends Record<string, any>>(
  items: T[],
  theoMap: Map<string, number>,
): (T & { theoreticalStock: number; countedStock: number; lastCountDate: string | null })[] {
  return items.map(item => {
    // Use a pre-set countedStock when the caller already captured the raw value (e.g. the
    // "All RCs" path pre-sets it before inflating stockOnHand with allocTotal). Otherwise
    // derive it from the current stockOnHand.
    const counted = item.countedStock !== undefined ? Number(item.countedStock) : Number(item.stockOnHand)
    const theoretical = theoMap.has(item.id) ? theoMap.get(item.id)! : counted
    const lastCountDate = item.lastCountDate
      ? (item.lastCountDate instanceof Date ? item.lastCountDate.toISOString() : String(item.lastCountDate))
      : null
    return {
      ...item,
      theoreticalStock: theoretical,
      countedStock: counted,
      lastCountDate,
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

  const itemWhere = {
    AND: [
      search ? { itemName: { contains: search, mode: 'insensitive' as const } } : {},
      category ? { category } : {},
      supplierId ? { supplierId } : {},
      storageAreaId ? { storageAreaId } : {},
      isActive !== null && isActive !== '' ? { isActive: isActive === 'true' } : {},
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
        (isActive === null || isActive === '' || String(i.isActive) === isActive)
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
  const { purchasePrice, qtyPerPurchaseUnit, packSize, packUOM, countUOM, qtyUOM, innerQty, priceType, supplierId, storageAreaId, ...rest } = body
  const pp    = parseFloat(purchasePrice)
  const qty   = parseFloat(qtyPerPurchaseUnit)
  const rawPs = parseFloat(packSize ?? '')
  const hasWeightPerEach = rawPs > 0
  const ps    = hasWeightPerEach ? rawPs : 1
  // Force packUOM to 'each' when no weight-per-each entered. Validate + normalize
  // packUOM/qtyUOM against the UOM backbone — they feed the pricing math directly.
  let pu: string, qu: string
  try {
    pu = assertKnownUnit(hasWeightPerEach ? (packUOM ?? 'each') : 'each', 'packUOM')
    qu = assertKnownUnit(qtyUOM ?? 'each', 'qtyUOM')
  } catch (e) { if (e instanceof UnitError) return NextResponse.json({ error: e.message }, { status: 400 }); throw e }
  const iq    = innerQty != null ? Number(innerQty) : null
  // Count UOM derives from the purchase format: keep an explicit, still-valid
  // choice (switchable per item) but never let it sit at a stale/invalid value —
  // fall back to the derived primary so count sessions read the right unit.
  const cu    = resolveCountUom({
    baseUnit:           '',                 // unused by the derivation
    purchaseUnit:       rest.purchaseUnit ?? 'each',
    qtyPerPurchaseUnit: qty,
    qtyUOM:             qu,
    innerQty:           iq,
    packSize:           ps,
    packUOM:            pu,
    countUOM:           hasWeightPerEach ? (countUOM ?? 'each') : 'each',
  })
  const pt: 'CASE' | 'UOM' = priceType === 'UOM' ? 'UOM' : 'CASE'
  const pricePerBaseUnit = calcPricePerBaseUnit(pp, qty, qu, iq, ps, pu, pt)
  const conversionFactor = calcConversionFactor(cu, qty, qu, iq, ps, pu)
  const baseUnit         = deriveBaseUnit(qu, pu, hasWeightPerEach ? rawPs : 0)
  const item = await prisma.inventoryItem.create({
    data: {
      ...rest,
      purchasePrice: pp,
      qtyPerPurchaseUnit: qty,
      packSize: ps,
      packUOM: pu,
      countUOM: cu,
      qtyUOM: qu,
      innerQty: iq,
      priceType: pt,
      conversionFactor,
      pricePerBaseUnit,
      baseUnit,
      supplierId: supplierId || null,
      storageAreaId: storageAreaId || null,
    },
    include: { supplier: true, storageArea: true },
  })
  return NextResponse.json(item, { status: 201 })
}
