import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveLocationRcIds } from '@/lib/rc-scope'
import { getTheoreticalStock } from '@/lib/count-expected'

// GET /api/stock-transfers?itemId=&rcId= — list transfers
export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const itemId = searchParams.get('itemId')
  const rcId   = searchParams.get('rcId')
  const locationId = searchParams.get('locationId')
  const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null

  const transfers = await prisma.stockTransfer.findMany({
    where: {
      ...(itemId ? { inventoryItemId: itemId } : {}),
      ...(locRcIds
        ? { OR: [{ fromRcId: { in: locRcIds } }, { toRcId: { in: locRcIds } }] }
        : rcId ? { OR: [{ fromRcId: rcId }, { toRcId: rcId }] } : {}),
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

// POST /api/stock-transfers — move stock between two RCs.
// THEORETICAL move: records a StockTransfer row only. It does NOT write real stock
// (StockAllocation.quantity is untouched); the transfer feeds the theoretical-stock
// engine (buildTransferMap) so the source RC's theoretical drops and the destination's
// rises. `quantity` is in baseUnit. Only a count ever changes real stock in hand.
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

  // Guard against moving more than the source RC's THEORETICAL on-hand (baseUnit).
  const sourceQty = (await getTheoreticalStock(inventoryItemId, fromRcId)) ?? 0
  if (sourceQty < qty) {
    return NextResponse.json({
      error: `Insufficient stock. Source RC has ${sourceQty} units available.`,
    }, { status: 400 })
  }

  await prisma.$transaction([
    // The transfer IS the movement — a theoretical event, no real-stock write.
    prisma.stockTransfer.create({
      data: { fromRcId, toRcId, inventoryItemId, quantity: qty, notes: notes || null },
    }),
    // Stock in the destination RC implies membership so it appears in that RC's count.
    prisma.itemRevenueCenter.upsert({
      where: { inventoryItemId_revenueCenterId: { inventoryItemId, revenueCenterId: toRcId } },
      create: { inventoryItemId, revenueCenterId: toRcId },
      update: {},
    }),
  ])

  return NextResponse.json({ ok: true })
}
