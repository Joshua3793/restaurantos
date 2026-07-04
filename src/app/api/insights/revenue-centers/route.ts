// src/app/api/insights/revenue-centers/route.ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/insights/revenue-centers
 * Per-center week-to-date spend, running food cost %, and item count, plus
 * roll-up totals for the KPI strip. Mirrors cost-chrome's WTD math, grouped by RC.
 */
export async function GET() {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const weekStart = startOfWeek(new Date())

  const [rcs, sales, scanItems, allocCounts] = await Promise.all([
    prisma.revenueCenter.findMany({ select: { id: true, isActive: true, targetCostPct: true, targetFoodCostPct: true } }),
    prisma.salesEntry.findMany({
      where: { date: { gte: weekStart } },
      select: { revenueCenterId: true, totalRevenue: true, foodSalesPct: true },
    }),
    prisma.invoiceScanItem.findMany({
      where: { approved: true, splitToSessionId: null, session: { purchaseDate: { gte: weekStart } } },
      select: { rawLineTotal: true, session: { select: { revenueCenterId: true } } },
    }),
    prisma.stockAllocation.groupBy({ by: ['revenueCenterId'], _count: { _all: true } }),
  ])

  // Σ food sales per RC
  const foodSalesByRc = new Map<string, number>()
  for (const s of sales) {
    if (!s.revenueCenterId) continue
    const add = Number(s.totalRevenue) * Number(s.foodSalesPct)
    foodSalesByRc.set(s.revenueCenterId, (foodSalesByRc.get(s.revenueCenterId) ?? 0) + add)
  }

  // Σ approved spend per RC (by the session's RC, matching cost-chrome)
  const spendByRc = new Map<string, number>()
  for (const it of scanItems) {
    const rcId = it.session?.revenueCenterId
    if (!rcId) continue
    spendByRc.set(rcId, (spendByRc.get(rcId) ?? 0) + Number(it.rawLineTotal ?? 0))
  }

  const itemCountByRc = new Map<string, number>()
  for (const a of allocCounts) itemCountByRc.set(a.revenueCenterId, a._count._all)

  const centers: Record<string, { spendWTD: number; runningFoodCostPct: number | null; itemCount: number }> = {}
  for (const rc of rcs) {
    const spendWTD = spendByRc.get(rc.id) ?? 0
    const foodSales = foodSalesByRc.get(rc.id) ?? 0
    centers[rc.id] = {
      spendWTD,
      runningFoodCostPct: foodSales > 0 ? (spendWTD / foodSales) * 100 : null,
      itemCount: itemCountByRc.get(rc.id) ?? 0,
    }
  }

  // Totals
  const activeCenters = rcs.filter(rc => rc.isActive)
  const activeCount = activeCenters.length
  const totalCount = rcs.length
  const allocatedWTD = rcs.reduce((sum, rc) => sum + (centers[rc.id]?.spendWTD ?? 0), 0)

  // Spend-weighted blended target over active centers that have a target.
  const withTarget = activeCenters.filter(rc => (rc.targetCostPct ?? rc.targetFoodCostPct) != null)
  let blendedTargetPct: number | null = null
  if (withTarget.length) {
    const weightSum = withTarget.reduce((s, rc) => s + (centers[rc.id]?.spendWTD ?? 0), 0)
    if (weightSum > 0) {
      blendedTargetPct = withTarget.reduce(
        (s, rc) => s + Number(rc.targetCostPct ?? rc.targetFoodCostPct) * (centers[rc.id]?.spendWTD ?? 0), 0,
      ) / weightSum
    } else {
      // No spend yet — fall back to a simple average.
      blendedTargetPct = withTarget.reduce((s, rc) => s + Number(rc.targetCostPct ?? rc.targetFoodCostPct), 0) / withTarget.length
    }
  }

  return NextResponse.json(
    { centers, totals: { activeCount, totalCount, blendedTargetPct, allocatedWTD } },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

function startOfWeek(d: Date): Date {
  // Monday as week start. Returns local 00:00 of that Monday.
  const out = new Date(d)
  const day = out.getDay() || 7 // Sun = 0 → 7
  if (day !== 1) out.setHours(-24 * (day - 1))
  out.setHours(0, 0, 0, 0)
  return out
}
