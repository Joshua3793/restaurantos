import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { theoreticalCostForLineItems } from '@/lib/theoretical-cost'
import { periodPurchases, periodSnapshotBounds } from '@/lib/cogs'
import { asChainItem, pricePerBaseUnit } from '@/lib/item-model'

// ── GET /api/reports/cogs ─────────────────────────────────────────────────────
// Without params → legacy dashboard data (weekly trends, wastage, inventory)
// With ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD → COGS calculation
export async function GET(req: NextRequest) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const startDateStr = searchParams.get('startDate')
  const endDateStr   = searchParams.get('endDate')

  // ── Legacy dashboard mode ─────────────────────────────────────────────────
  if (!startDateStr || !endDateStr) {
    const now = new Date()
    const eightWeeksAgo = new Date(now)
    eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56)

    const [sales, wastage, inventory] = await Promise.all([
      prisma.salesEntry.findMany({ where: { date: { gte: eightWeeksAgo } }, orderBy: { date: 'asc' } }),
      prisma.wastageLog.findMany({ where: { date: { gte: eightWeeksAgo } }, include: { inventoryItem: true } }),
      prisma.inventoryItem.findMany({ where: { isStocked: true } }),
    ])

    const weeklyData: Record<string, { week: string; revenue: number; wastage: number; foodCostPct: number }> = {}
    for (const s of sales) {
      const ws = new Date(s.date); ws.setDate(ws.getDate() - ws.getDay())
      const key = ws.toISOString().slice(0, 10)
      if (!weeklyData[key]) weeklyData[key] = { week: key, revenue: 0, wastage: 0, foodCostPct: 0 }
      weeklyData[key].revenue += Number(s.totalRevenue)
    }
    for (const w of wastage) {
      const ws = new Date(w.date); ws.setDate(ws.getDate() - ws.getDay())
      const key = ws.toISOString().slice(0, 10)
      if (!weeklyData[key]) weeklyData[key] = { week: key, revenue: 0, wastage: 0, foodCostPct: 0 }
      weeklyData[key].wastage += Number(w.costImpact)
    }
    const weeklyArray = Object.values(weeklyData)
      .map(w => ({ ...w, foodCostPct: w.revenue > 0 ? (w.wastage / w.revenue) * 100 : 0 }))
      .sort((a, b) => a.week.localeCompare(b.week))

    const wastageByCategory: Record<string, number> = {}
    for (const w of wastage) {
      const cat = w.inventoryItem.category
      wastageByCategory[cat] = (wastageByCategory[cat] || 0) + Number(w.costImpact)
    }
    const inventoryByCategory: Record<string, number> = {}
    for (const item of inventory) {
      const cat = item.category
      inventoryByCategory[cat] = (inventoryByCategory[cat] || 0) +
        Number(item.stockOnHand) * pricePerBaseUnit(asChainItem(item))
    }
    const wastageByItem: Record<string, { name: string; cost: number }> = {}
    for (const w of wastage) {
      if (!wastageByItem[w.inventoryItemId])
        wastageByItem[w.inventoryItemId] = { name: w.inventoryItem.itemName, cost: 0 }
      wastageByItem[w.inventoryItemId].cost += Number(w.costImpact)
    }
    const topWasted = Object.values(wastageByItem).sort((a, b) => b.cost - a.cost).slice(0, 10)
    return NextResponse.json({ weeklyData: weeklyArray, wastageByCategory, inventoryByCategory, topWasted })
  }

  // ── COGS mode ─────────────────────────────────────────────────────────────
  const rangeStart = new Date(startDateStr)
  const rangeEnd   = new Date(endDateStr + 'T23:59:59.999Z')

  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'

  // Opening/closing inventory = the FULL counts bounding the period, by sessionDate,
  // RC-scoped (default RC + All read global counts; a non-default RC reads its own).
  // Canonical shared resolver (periodSnapshotBounds in src/lib/cogs.ts). Counted stock
  // is the ONLY source — no StockAllocation fallback (allocations aren't counted values
  // and have no time dimension; the default RC has none, which is what produced $0).
  const { opening: beginSession, closing: endSession } =
    await periodSnapshotBounds(rangeStart.getTime(), rangeEnd.getTime(), { rcId, isDefault })

  const beginningValue = beginSession?.value ?? 0
  const beginByCategory: Record<string, number> = beginSession?.byCategory ?? {}
  const endingValue = endSession?.value ?? 0
  const endByCategory: Record<string, number> = endSession?.byCategory ?? {}

  // A single FULL count can't bound both ends: when opening === closing the ending
  // inventory is assumed unchanged (COGS = purchases) and flagged so the UI can warn.
  const sameBoundingCount = !!beginSession && beginSession.sessionId === endSession?.sessionId

  // Purchases in range — canonical spine definition (see periodPurchases in
  // src/lib/cogs.ts): approved, non-split scan items by session.approvedAt,
  // RC-scoped. No action filter and no legacy Invoice rows, so this stays
  // consistent with the live cost-chrome food-cost number and with
  // computePeriodCogs (used by /api/insights/food-cost-variance).
  const { total: totalPurchases, byCategory: purchasesByCategory, invoiceCount } =
    await periodPurchases(rangeStart.getTime(), rangeEnd.getTime(), { rcId, isDefault })

  // Food sales
  // Shared sales scope: date range + RC filter. Reused by both the food-sales
  // denominator and the theoretical-cost numerator so they stay comparable in
  // RC mode (a global numerator over RC-scoped sales would be inflated).
  // revenueCenterId is NOT NULL on SalesEntry now (legacy nulls were backfilled to the
  // default RC), so default and non-default both filter by the concrete rcId — there are
  // no null-RC rows left to union in.
  const salesWhere = {
    date: { gte: rangeStart, lte: rangeEnd },
    ...(rcId ? { revenueCenterId: rcId } : {}),
  }
  const salesEntries = await prisma.salesEntry.findMany({ where: salesWhere })
  const foodSales = salesEntries.reduce(
    (s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0
  )

  const cogs = Math.round((beginningValue + totalPurchases - endingValue) * 100) / 100
  const foodCostPct = foodSales > 0 ? Math.round((cogs / foodSales) * 10000) / 100 : 0

  // Theoretical cost over the same range + RC scope (recipe-based), for variance.
  const cogsLineItems = await prisma.saleLineItem.findMany({
    where: { sale: salesWhere },
    select: { recipeId: true, qtySold: true },
  })
  const cogsTheo = await theoreticalCostForLineItems(cogsLineItems)

  const actualFoodCostPct      = foodSales > 0 ? (cogs / foodSales) * 100 : null
  const theoreticalFoodCostPct = foodSales > 0 ? (cogsTheo.theoreticalCost / foodSales) * 100 : null
  const foodCostVariancePts =
    actualFoodCostPct != null && theoreticalFoodCostPct != null
      ? actualFoodCostPct - theoreticalFoodCostPct : null

  // By category breakdown
  const allCats = new Set([
    ...Object.keys(beginByCategory),
    ...Object.keys(endByCategory),
    ...Object.keys(purchasesByCategory),
  ])
  const byCategory = Array.from(allCats).map(category => {
    const bv = beginByCategory[category] || 0
    const ev = endByCategory[category] || 0
    const pv = purchasesByCategory[category] || 0
    return { category, beginningValue: bv, endingValue: ev, purchases: pv, cogs: Math.round((bv + pv - ev) * 100) / 100 }
  }).sort((a, b) => a.category.localeCompare(b.category))

  return NextResponse.json({
    startDate: startDateStr,
    endDate:   endDateStr,
    beginningInventory: {
      value: beginningValue,
      sessionDate: beginSession?.sessionDate ?? null,
      sessionId: beginSession?.sessionId ?? null,
      needsCount: !beginSession,
    },
    purchases: { total: totalPurchases, invoiceCount },
    endingInventory: {
      value: endingValue,
      sessionDate: endSession?.sessionDate ?? null,
      sessionId: endSession?.sessionId ?? null,
      needsCount: !endSession,
      // Ending falls on the same FULL count as beginning → no end-of-period count yet.
      sameAsOpening: sameBoundingCount,
    },
    // Scope echoed back so the UI can phrase "No full count for <RC>" correctly.
    scope: rcId ? (isDefault ? 'default' : 'rc') : 'all',
    cogs,
    foodSales,
    foodCostPct,
    byCategory,
    actualFoodCostPct,
    theoreticalFoodCostPct,
    foodCostVariancePts,
    theoreticalCost: cogsTheo.theoreticalCost,
    theoreticalCoverage: { costed: cogsTheo.costedRecipes, total: cogsTheo.totalRecipes },
  })
}
