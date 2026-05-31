import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildConsumptionMap, buildPurchaseMap, buildWastageMap, computeExpected } from '@/lib/count-expected'

export const dynamic = 'force-dynamic'

// ── GET /api/count/areas?rcId=&isDefault= ─────────────────────────────────────
// Per-storage-area count overview for the area-based count landing.
// onHandValue mirrors the session-create baseline: default RC (or no RC) uses
// global stockOnHand; a non-default RC uses StockAllocation.quantity (fallback 0).
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'

  const [areas, items] = await Promise.all([
    prisma.storageArea.findMany({ orderBy: { name: 'asc' } }),
    prisma.inventoryItem.findMany({
      where: { isActive: true },
      select: { id: true, storageAreaId: true, stockOnHand: true, pricePerBaseUnit: true, lastCountDate: true, lastCountQty: true },
    }),
  ])

  // RC-aware on-hand baseline (matches POST /api/count/sessions)
  let isDefaultRc = true
  const allocMap = new Map<string, number>()
  if (rcId) {
    const rc = await prisma.revenueCenter.findUnique({ where: { id: rcId }, select: { isDefault: true } })
    isDefaultRc = !!rc?.isDefault
    if (!isDefaultRc) {
      const allocs = await prisma.stockAllocation.findMany({
        where: { revenueCenterId: rcId, inventoryItemId: { in: items.map(i => i.id) } },
        select: { inventoryItemId: true, quantity: true },
      })
      for (const a of allocs) allocMap.set(a.inventoryItemId, Number(a.quantity))
    }
  }
  const baseStock = (it: { id: string; stockOnHand: unknown }) =>
    rcId && !isDefaultRc ? (allocMap.get(it.id) ?? 0) : Number(it.stockOnHand)

  // Drift = value of theoretical movement (sales/purchases/wastage) since each item's
  // last count. Build the movement maps over the earliest last-count window (mirrors
  // POST /api/count/sessions), then per item: |expected − baseStock| × price.
  const earliestLastCount = items
    .map(i => i.lastCountDate)
    .filter(Boolean)
    .sort((a, b) => (a as Date).getTime() - (b as Date).getTime())[0] as Date | undefined
  const [consumptionMap, purchaseMap, wastageMap] = earliestLastCount
    ? await Promise.all([
        buildConsumptionMap(earliestLastCount, rcId),
        buildPurchaseMap(earliestLastCount, rcId),
        buildWastageMap(earliestLastCount, items.map(i => i.id), rcId),
      ])
    : [new Map<string, number>(), new Map<string, number>(), new Map<string, number>()]

  type Agg = { itemCount: number; onHandValue: number; drift: number; lastCountDate: Date | null }
  const agg = new Map<string, Agg>()
  for (const it of items) {
    if (!it.storageAreaId) continue   // unassigned items are only reachable via a full count
    const cur = agg.get(it.storageAreaId) ?? { itemCount: 0, onHandValue: 0, drift: 0, lastCountDate: null }
    const price = Number(it.pricePerBaseUnit)
    const bs = baseStock(it)
    cur.itemCount += 1
    cur.onHandValue += bs * price
    if (it.lastCountDate) {
      const expected = computeExpected(it.id, bs, consumptionMap, purchaseMap, wastageMap)
      cur.drift += Math.abs(expected - bs) * price
    }
    if (it.lastCountDate && (!cur.lastCountDate || it.lastCountDate > cur.lastCountDate)) cur.lastCountDate = it.lastCountDate
    agg.set(it.storageAreaId, cur)
  }

  // Active (in-progress / pending) sessions for this RC → area → most-recent session id
  const sessions = await prisma.countSession.findMany({
    where: {
      status: { in: ['IN_PROGRESS', 'PENDING_REVIEW'] },
      ...(rcId
        ? (isDefault ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] } : { revenueCenterId: rcId })
        : {}),
    },
    orderBy: { startedAt: 'desc' },
    select: { id: true, areaFilter: true },
  })
  const activeByArea = new Map<string, string>()
  for (const s of sessions) {
    const ids = s.areaFilter ? s.areaFilter.split(',').map(x => x.trim()).filter(Boolean) : []
    for (const id of ids) if (!activeByArea.has(id)) activeByArea.set(id, s.id)
  }

  const result = areas
    .map(a => {
      const x = agg.get(a.id) ?? { itemCount: 0, onHandValue: 0, drift: 0, lastCountDate: null }
      return {
        id: a.id,
        name: a.name,
        itemCount: x.itemCount,
        onHandValue: x.onHandValue,
        drift: x.drift,
        lastCountDate: x.lastCountDate,
        activeSessionId: activeByArea.get(a.id) ?? null,
      }
    })
    .filter(a => a.itemCount > 0)

  return NextResponse.json(result, { headers: { 'Cache-Control': 'private, max-age=10, stale-while-revalidate=60' } })
}
