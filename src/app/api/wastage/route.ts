import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { convertQty } from '@/lib/uom'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const startDate = searchParams.get('startDate')
  const endDate   = searchParams.get('endDate')
  const itemId    = searchParams.get('itemId')
  const reason    = searchParams.get('reason')
  const rcId      = searchParams.get('rcId')

  const logs = await prisma.wastageLog.findMany({
    where: {
      AND: [
        startDate ? { date: { gte: new Date(startDate) } } : {},
        endDate   ? { date: { lte: new Date(endDate) } }  : {},
        itemId    ? { inventoryItemId: itemId }            : {},
        reason    ? { reason }                             : {},
        // revenueCenterId is NOT NULL on WastageLog (legacy nulls backfilled to the default
        // RC), so the filter is just the concrete rcId — no null rows to union in.
        rcId      ? { revenueCenterId: rcId }              : {},
      ],
    },
    include: { inventoryItem: true },
    orderBy: { date: 'desc' },
  })
  return NextResponse.json(logs)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { inventoryItemId, qtyWasted, unit, reason, loggedBy, notes, date } = body

  const revenueCenterId: string | null = body.revenueCenterId ?? null
  if (!revenueCenterId) {
    return NextResponse.json({ error: 'A revenue center must be selected to record this.' }, { status: 400 })
  }

  const item = await prisma.inventoryItem.findUnique({ where: { id: inventoryItemId } })
  const ppbu = item ? parseFloat(String(item.pricePerBaseUnit)) : 0
  const qtyBase = item ? convertQty(parseFloat(qtyWasted), unit, item.baseUnit) : parseFloat(qtyWasted)
  const costImpact = qtyBase * ppbu

  const log = await prisma.wastageLog.create({
    data: {
      inventoryItemId,
      date:            date ? new Date(date) : new Date(),
      qtyWasted:       parseFloat(qtyWasted),
      unit,
      reason:          reason || 'UNKNOWN',
      costImpact,
      loggedBy:        loggedBy || 'System',
      notes,
      revenueCenterId,
    },
    include: { inventoryItem: true },
  })
  return NextResponse.json(log, { status: 201 })
}
