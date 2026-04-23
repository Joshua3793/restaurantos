import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/stock-transfers?itemId=&rcId= — list transfers
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const itemId = searchParams.get('itemId')
  const rcId   = searchParams.get('rcId')

  const transfers = await prisma.stockTransfer.findMany({
    where: {
      ...(itemId ? { inventoryItemId: itemId } : {}),
      ...(rcId ? { OR: [{ fromRcId: rcId }, { toRcId: rcId }] } : {}),
    },
    include: {
      fromRc: { select: { id: true, name: true, color: true } },
      toRc:   { select: { id: true, name: true, color: true } },
      inventoryItem: { select: { id: true, itemName: true, baseUnit: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  return NextResponse.json(transfers)
}

// POST /api/stock-transfers — execute a pull (transfer stock between RCs)
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { fromRcId, toRcId, inventoryItemId, quantity, notes } = body

  if (!fromRcId || !toRcId || !inventoryItemId || !quantity) {
    return NextResponse.json({ error: 'fromRcId, toRcId, inventoryItemId, and quantity are required' }, { status: 400 })
  }

  if (fromRcId === toRcId) {
    return NextResponse.json({ error: 'Source and destination must be different' }, { status: 400 })
  }

  const qty = parseFloat(quantity)
  if (isNaN(qty) || qty <= 0) {
    return NextResponse.json({ error: 'Quantity must be a positive number' }, { status: 400 })
  }

  // Check source allocation
  const sourceAllocation = await prisma.stockAllocation.findUnique({
    where: { revenueCenterId_inventoryItemId: { revenueCenterId: fromRcId, inventoryItemId } },
  })

  const sourceQty = sourceAllocation ? Number(sourceAllocation.quantity) : 0
  if (sourceQty < qty) {
    return NextResponse.json({
      error: `Insufficient allocation. Source RC has ${sourceQty} units available.`,
    }, { status: 400 })
  }

  await prisma.$transaction([
    // Decrement source
    prisma.stockAllocation.upsert({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: fromRcId, inventoryItemId } },
      update: { quantity: { decrement: qty } },
      create: { revenueCenterId: fromRcId, inventoryItemId, quantity: 0 },
    }),
    // Increment destination
    prisma.stockAllocation.upsert({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: toRcId, inventoryItemId } },
      update: { quantity: { increment: qty } },
      create: { revenueCenterId: toRcId, inventoryItemId, quantity: qty },
    }),
    // Audit log
    prisma.stockTransfer.create({
      data: { fromRcId, toRcId, inventoryItemId, quantity: qty, notes: notes || null },
    }),
  ])

  return NextResponse.json({ ok: true })
}
