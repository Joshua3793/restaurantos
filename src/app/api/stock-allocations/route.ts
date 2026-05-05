import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

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

  const available = Number(item.stockOnHand)
  if (available < qty) {
    return NextResponse.json(
      { error: `Not enough stock. Available: ${available.toFixed(2)} ${item.countUOM || item.baseUnit}` },
      { status: 400 },
    )
  }

  const defaultRc = await prisma.revenueCenter.findFirst({ where: { isDefault: true } })

  await prisma.$transaction([
    prisma.inventoryItem.update({
      where: { id: inventoryItemId },
      data: { stockOnHand: { decrement: qty } },
    }),
    prisma.stockAllocation.upsert({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: rcId, inventoryItemId } },
      update: { quantity: { increment: qty } },
      create: { revenueCenterId: rcId, inventoryItemId, quantity: qty },
    }),
    ...(defaultRc
      ? [prisma.stockTransfer.create({
          data: { fromRcId: defaultRc.id, toRcId: rcId, inventoryItemId, quantity: qty, notes: notes || null },
        })]
      : []),
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
  if (parLevel !== null && parLevel !== undefined && Number(parLevel) < 0) {
    return NextResponse.json({ error: 'parLevel must be >= 0' }, { status: 400 })
  }
  if (reorderQty !== null && reorderQty !== undefined && Number(reorderQty) <= 0) {
    return NextResponse.json({ error: 'reorderQty must be > 0' }, { status: 400 })
  }

  const allocation = await prisma.stockAllocation.upsert({
    where: { revenueCenterId_inventoryItemId: { revenueCenterId: rcId, inventoryItemId } },
    update: {
      ...(parLevel !== undefined  ? { parLevel:  parLevel  === null ? null : Number(parLevel)  } : {}),
      ...(reorderQty !== undefined ? { reorderQty: reorderQty === null ? null : Number(reorderQty) } : {}),
    },
    create: {
      revenueCenterId: rcId,
      inventoryItemId,
      quantity: 0,
      parLevel:  parLevel  ?? null,
      reorderQty: reorderQty ?? null,
    },
  })

  return NextResponse.json(allocation)
}
