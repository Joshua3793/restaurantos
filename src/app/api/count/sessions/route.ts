import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildConsumptionMap, buildPurchaseMap, buildWastageMap, computeExpected } from '@/lib/count-expected'

// ── GET /api/count/sessions ───────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'

  const sessions = await prisma.countSession.findMany({
    where: rcId
      ? (isDefault
          ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
          : { revenueCenterId: rcId })
      : {},
    orderBy: { startedAt: 'desc' },
    include: { lines: { select: { countedQty: true, skipped: true } } },
  })

  return NextResponse.json(
    sessions.map(s => {
      const total   = s.lines.length
      const counted = s.lines.filter(l => l.countedQty !== null && !l.skipped).length
      const skipped = s.lines.filter(l => l.skipped).length
      const { lines, ...rest } = s
      return { ...rest, counts: { total, counted, skipped } }
    }),
    { headers: { 'Cache-Control': 'private, max-age=10, stale-while-revalidate=60' } }
  )
}

// ── POST /api/count/sessions ──────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const {
    label, type = 'FULL', areaFilter, countedBy, sessionDate, revenueCenterId,
  } = await req.json()

  const areaIds: string[] = areaFilter
    ? areaFilter.split(',').map((s: string) => s.trim()).filter(Boolean)
    : []

  const items = await prisma.inventoryItem.findMany({
    where: {
      isActive: true,
      ...(areaIds.length > 0 ? { storageAreaId: { in: areaIds } } : {}),
    },
    orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
  })

  const itemIds = items.map(i => i.id)

  // Earliest "last count date" across all items — defines the lookback window
  const earliestLastCount = items
    .map(i => i.lastCountDate)
    .filter(Boolean)
    .sort((a, b) => ((a as Date) > (b as Date) ? 1 : -1))[0] as Date | undefined

  // ── Maps: consumption, purchases, wastage ──────────────────────────────────
  const [consumptionMap, purchaseMap, wastageMap] = await Promise.all([
    earliestLastCount
      ? buildConsumptionMap(earliestLastCount, revenueCenterId)
      : Promise.resolve(new Map<string, number>()),
    earliestLastCount
      ? buildPurchaseMap(earliestLastCount, revenueCenterId)
      : Promise.resolve(new Map<string, number>()),
    earliestLastCount
      ? buildWastageMap(earliestLastCount, itemIds, revenueCenterId)
      : Promise.resolve(new Map<string, number>()),
  ])

  // ── RC stock baseline ──────────────────────────────────────────────────────
  // For the default RC: baseline is global stockOnHand.
  // For a non-default RC: baseline is StockAllocation.quantity, falling back to
  // 0 (NOT global stockOnHand) when this RC has never been counted — otherwise
  // the first RC count would inflate the baseline by the entire warehouse total.
  const stockAllocationMap = new Map<string, number>()
  let isDefaultRc = false
  if (revenueCenterId && itemIds.length > 0) {
    const rc = await prisma.revenueCenter.findUnique({
      where: { id: revenueCenterId },
      select: { isDefault: true },
    })
    isDefaultRc = !!rc?.isDefault
    const allocations = await prisma.stockAllocation.findMany({
      where: { revenueCenterId, inventoryItemId: { in: itemIds } },
      select: { inventoryItemId: true, quantity: true },
    })
    for (const a of allocations) {
      stockAllocationMap.set(a.inventoryItemId, Number(a.quantity))
    }
  }

  const session = await prisma.countSession.create({
    data: {
      label:       label?.trim() || (type === 'FULL' ? 'Full count' : 'Partial count'),
      sessionDate: sessionDate ? new Date(sessionDate) : new Date(),
      type,
      areaFilter:      areaFilter || null,
      revenueCenterId: revenueCenterId || null,
      countedBy,
      lines: {
        create: items.map((item, i) => {
          const baseStock = revenueCenterId
            ? (stockAllocationMap.has(item.id)
                ? stockAllocationMap.get(item.id)!
                : (isDefaultRc ? Number(item.stockOnHand) : 0))
            : Number(item.stockOnHand)

          const expected = computeExpected(item.id, baseStock, consumptionMap, purchaseMap, wastageMap)

          return {
            inventoryItemId: item.id,
            expectedQty:     expected,
            selectedUom:     item.countUOM || item.baseUnit,
            priceAtCount:    item.pricePerBaseUnit,
            sortOrder:       i,
          }
        }),
      },
    },
    include: {
      lines: {
        include: { inventoryItem: { include: { storageArea: true } } },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })

  // Enrich lines with per-RC parLevel from StockAllocation for display
  const parMap2 = new Map<string, number>()
  if (revenueCenterId) {
    const allocs = await prisma.stockAllocation.findMany({
      where: { revenueCenterId, inventoryItemId: { in: itemIds } },
      select: { inventoryItemId: true, parLevel: true },
    })
    for (const a of allocs) {
      if (a.parLevel != null) parMap2.set(a.inventoryItemId, Number(a.parLevel))
    }
  }
  const enrichedLines = session.lines.map(l => ({
    ...l,
    inventoryItem: { ...l.inventoryItem, parLevel: parMap2.get(l.inventoryItemId) ?? null },
  }))

  return NextResponse.json(
    { ...session, lines: enrichedLines, counts: { total: session.lines.length, counted: 0, skipped: 0 } },
    { status: 201 },
  )
}
