import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { theoreticalCostForLineItems } from '@/lib/theoretical-cost'
import { periodPurchases, periodSnapshotBounds, type SnapshotBound } from '@/lib/cogs'
import { asChainItem, pricePerBaseUnit } from '@/lib/item-model'
import { resolveLocationRcIds } from '@/lib/rc-scope'

// ── GET /api/reports/cogs ─────────────────────────────────────────────────────
// Without params → legacy dashboard data (weekly trends, wastage, inventory)
// With ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD → COGS calculation
export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession('MANAGER') }
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
  const locationId = searchParams.get('locationId')
  const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null

  // COGS pieces for ONE scope (a specific RC, or the default pool). Opening/closing
  // inventory = the FULL counts bounding the period by sessionDate; purchases = approved
  // non-split scan items by session.purchaseDate (invoice date). Counted stock is the ONLY inventory
  // source (no StockAllocation fallback — allocations aren't counted values).
  const cogsForScope = async (scope: { rcId: string; isDefault: boolean }) => {
    const { opening, closing } =
      await periodSnapshotBounds(rangeStart.getTime(), rangeEnd.getTime(), scope)
    const { total, byCategory: purchByCat, invoiceCount } =
      await periodPurchases(rangeStart.getTime(), rangeEnd.getTime(), scope)
    return {
      opening, closing,
      beginningValue: opening?.value ?? 0,
      endingValue: closing?.value ?? 0,
      beginByCategory: opening?.byCategory ?? {},
      endByCategory: closing?.byCategory ?? {},
      totalPurchases: total, purchasesByCategory: purchByCat, invoiceCount,
      // A single FULL count can't bound both ends (COGS collapses to purchases).
      sameBoundingCount: !!opening && opening.sessionId === closing?.sessionId,
      fullyBracketed: !!opening && !!closing && opening.sessionId !== closing.sessionId,
    }
  }

  let beginningValue = 0, endingValue = 0, totalPurchases = 0, invoiceCount = 0
  let beginByCategory: Record<string, number> = {}
  let endByCategory: Record<string, number> = {}
  let purchasesByCategory: Record<string, number> = {}
  let beginSession: SnapshotBound | null = null
  let endSession: SnapshotBound | null = null
  let sameBoundingCount = false
  let rcCoverage: { total: number; counted: number; uncounted: string[] } | null = null

  if (rcId && !locRcIds) {
    const r = await cogsForScope({ rcId, isDefault })
    beginningValue = r.beginningValue; endingValue = r.endingValue
    totalPurchases = r.totalPurchases; invoiceCount = r.invoiceCount
    beginByCategory = r.beginByCategory; endByCategory = r.endByCategory
    purchasesByCategory = r.purchasesByCategory
    beginSession = r.opening; endSession = r.closing
    sameBoundingCount = r.sameBoundingCount
  } else {
    // "All RCs" (or a Location lens) = Σ per-RC COGS, each revenue center bracketed by its
    // OWN counts (the default RC reads the global pool). Mirrors getTheoreticalStockMap's
    // ALL = ΣRC. A location lens restricts the set to that location's child RCs.
    // An RC lacking an opening+closing bracket falls back to purchases-only for its
    // slice and is reported in rcCoverage.uncounted so the UI can caveat the total.
    const rcs = await prisma.revenueCenter.findMany({
      where: { isActive: true, ...(locRcIds ? { id: { in: locRcIds } } : {}) },
      select: { id: true, name: true, isDefault: true },
    })
    const parts = await Promise.all(
      rcs.map(rc => cogsForScope({ rcId: rc.id, isDefault: rc.isDefault }).then(p => ({ rc, p }))),
    )
    const uncounted: string[] = []
    for (const { rc, p } of parts) {
      beginningValue += p.beginningValue
      endingValue += p.endingValue
      totalPurchases += p.totalPurchases
      invoiceCount += p.invoiceCount
      for (const [k, v] of Object.entries(p.beginByCategory)) beginByCategory[k] = (beginByCategory[k] ?? 0) + v
      for (const [k, v] of Object.entries(p.endByCategory)) endByCategory[k] = (endByCategory[k] ?? 0) + v
      for (const [k, v] of Object.entries(p.purchasesByCategory)) purchasesByCategory[k] = (purchasesByCategory[k] ?? 0) + v
      if (!p.fullyBracketed) uncounted.push(rc.name)
    }
    rcCoverage = { total: rcs.length, counted: rcs.length - uncounted.length, uncounted }
  }

  // Food sales
  // Shared sales scope: date range + RC filter. Reused by both the food-sales
  // denominator and the theoretical-cost numerator so they stay comparable in
  // RC mode (a global numerator over RC-scoped sales would be inflated).
  // revenueCenterId is NOT NULL on SalesEntry now (legacy nulls were backfilled to the
  // default RC), so default and non-default both filter by the concrete rcId — there are
  // no null-RC rows left to union in.
  const salesWhere = {
    date: { gte: rangeStart, lte: rangeEnd },
    // SalesEntry.revenueCenterId is NOT NULL → location lens aggregates across its child
    // RCs with a plain `in`; else a single RC; else all.
    ...(locRcIds ? { revenueCenterId: { in: locRcIds } } : rcId ? { revenueCenterId: rcId } : {}),
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
      needsCount: rcId ? !beginSession : (rcCoverage!.counted === 0),
    },
    purchases: { total: totalPurchases, invoiceCount },
    endingInventory: {
      value: endingValue,
      sessionDate: endSession?.sessionDate ?? null,
      sessionId: endSession?.sessionId ?? null,
      needsCount: rcId ? !endSession : false,
      // Ending falls on the same FULL count as beginning → no end-of-period count yet.
      sameAsOpening: sameBoundingCount,
    },
    // Scope echoed back so the UI can phrase "No full count for <RC>" correctly.
    scope: rcId ? (isDefault ? 'default' : 'rc') : 'all',
    // For "All RCs": how many of the N revenue centers have a full opening+closing
    // bracket (the rest fall back to purchases-only for their slice). Null for single-RC.
    rcCoverage,
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
