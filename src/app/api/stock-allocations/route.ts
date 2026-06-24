import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { convertCountQtyToBase, convertBaseToCountUom } from '@/lib/count-uom'

// GET /api/stock-allocations?itemId= — allocations for a specific inventory item
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const itemId = searchParams.get('itemId')

  if (!itemId) return NextResponse.json({ error: 'itemId required' }, { status: 400 })

  const allocations = await prisma.stockAllocation.findMany({
    where: { inventoryItemId: itemId },
    include: { revenueCenter: { select: { id: true, name: true, color: true } } },
  })

  return NextResponse.json(allocations)
}

// POST /api/stock-allocations — pull qty from main pool (stockOnHand) into an RC
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { inventoryItemId, rcId, quantity, notes } = body

  if (!inventoryItemId || !rcId || !quantity) {
    return NextResponse.json(
      { error: 'inventoryItemId, rcId, and quantity are required' },
      { status: 400 },
    )
  }

  const qty = parseFloat(String(quantity))
  if (isNaN(qty) || qty <= 0) {
    return NextResponse.json({ error: 'Quantity must be a positive number' }, { status: 400 })
  }

  const item = await prisma.inventoryItem.findUnique({ where: { id: inventoryItemId } })
  if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 })

  // `quantity` arrives in the item's countUOM (e.g. kg), but stockOnHand is
  // stored in baseUnit (e.g. g). Convert before decrementing / comparing —
  // otherwise pulling 2.28 kg decremented stockOnHand by 2.28 g, leaving the
  // main pool ~unchanged while the RC allocation showed the full amount.
  const countUOM = item.countUnit || item.baseUnit
  const dims = {
    dimension: item.dimension,
    baseUnit:  item.baseUnit,
    packChain: item.packChain,
    countUnit: item.countUnit,
  }
  const qtyBase     = convertCountQtyToBase(qty, countUOM, dims)
  const availBase   = Number(item.stockOnHand)
  if (availBase < qtyBase) {
    const availDisplay = convertBaseToCountUom(availBase, countUOM, dims)
    return NextResponse.json(
      { error: `Not enough stock. Available: ${availDisplay.toFixed(2)} ${countUOM}` },
      { status: 400 },
    )
  }

  const defaultRc = await prisma.revenueCenter.findFirst({ where: { isDefault: true } })

  await prisma.$transaction([
    prisma.inventoryItem.update({
      where: { id: inventoryItemId },
      data: { stockOnHand: { decrement: qtyBase } },
    }),
    // Allocation + transfer quantities are persisted in baseUnit — the canonical
    // unit for all stock (matches stockOnHand and count-finalize). Display layers
    // convert to countUOM. Writing the raw countUOM `qty` here made the inventory
    // list (which treats the value as baseUnit) show ~0 after a pull.
    prisma.stockAllocation.upsert({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: rcId, inventoryItemId } },
      update: { quantity: { increment: qtyBase } },
      create: { revenueCenterId: rcId, inventoryItemId, quantity: qtyBase },
    }),
    ...(defaultRc
      ? [prisma.stockTransfer.create({
          data: { fromRcId: defaultRc.id, toRcId: rcId, inventoryItemId, quantity: qtyBase, notes: notes || null },
        })]
      : []),
    // Stock in an RC implies membership — otherwise the item would hold stock there but
    // be invisible in that RC's count. Idempotent.
    prisma.itemRevenueCenter.upsert({
      where: { inventoryItemId_revenueCenterId: { inventoryItemId, revenueCenterId: rcId } },
      create: { inventoryItemId, revenueCenterId: rcId },
      update: {},
    }),
  ])

  return NextResponse.json({ ok: true })
}

// PATCH /api/stock-allocations — upsert parLevel/reorderQty for one RC+item pair
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { inventoryItemId, rcId, parLevel, reorderQty } = body

  if (!inventoryItemId || !rcId) {
    return NextResponse.json({ error: 'inventoryItemId and rcId are required' }, { status: 400 })
  }
  if (parLevel !== null && parLevel !== undefined) {
    const p = Number(parLevel)
    if (isNaN(p) || p < 0) {
      return NextResponse.json({ error: 'parLevel must be a number >= 0' }, { status: 400 })
    }
  }
  if (reorderQty !== null && reorderQty !== undefined) {
    const r = Number(reorderQty)
    if (isNaN(r) || r <= 0) {
      return NextResponse.json({ error: 'reorderQty must be a number > 0' }, { status: 400 })
    }
  }

  try {
    const allocation = await prisma.stockAllocation.upsert({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: rcId, inventoryItemId } },
      update: {
        ...(parLevel !== undefined ? { parLevel: parLevel === null ? null : Number(parLevel) } : {}),
        ...(reorderQty !== undefined ? { reorderQty: reorderQty === null ? null : Number(reorderQty) } : {}),
      },
      create: {
        revenueCenterId: rcId,
        inventoryItemId,
        quantity: 0,
        parLevel: parLevel ?? null,
        reorderQty: reorderQty ?? null,
      },
    })
    return NextResponse.json(allocation)
  } catch (err) {
    console.error('PATCH /api/stock-allocations', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
