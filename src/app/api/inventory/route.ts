import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit } from '@/lib/utils'

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
    return NextResponse.json(items, {
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
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  }

  // "All Revenue Centers": total physical stock = stockOnHand (Cafe pool) + all RC allocations
  const rawItems = await prisma.inventoryItem.findMany({
    where: itemWhere,
    include: { ...itemInclude, stockAllocations: { select: { quantity: true } } },
    orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
  })
  const items = rawItems.map(({ stockAllocations, ...item }) => {
    const allocTotal = stockAllocations.reduce((s, a) => s + Number(a.quantity), 0)
    return { ...item, stockOnHand: Number(item.stockOnHand) + allocTotal }
  })
  return NextResponse.json(items, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { purchasePrice, qtyPerPurchaseUnit, packSize, packUOM, countUOM, supplierId, storageAreaId, ...rest } = body
  const pp  = parseFloat(purchasePrice)
  const qty = parseFloat(qtyPerPurchaseUnit)
  const ps  = parseFloat(packSize  ?? '1')
  const pu  = packUOM  ?? 'each'
  const cu  = countUOM ?? 'each'
  const pricePerBaseUnit = calcPricePerBaseUnit(pp, qty, ps, pu)
  const conversionFactor = calcConversionFactor(cu, qty, ps, pu)
  const baseUnit         = deriveBaseUnit(pu)
  const item = await prisma.inventoryItem.create({
    data: {
      ...rest,
      purchasePrice: pp,
      qtyPerPurchaseUnit: qty,
      packSize: ps,
      packUOM: pu,
      countUOM: cu,
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
