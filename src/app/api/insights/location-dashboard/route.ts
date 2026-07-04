import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveScopedRcIds } from '@/lib/rc-scope'
import { startOfWeek } from '@/lib/dates'

export const dynamic = 'force-dynamic'

/**
 * GET /api/insights/location-dashboard?locationId=...&from=...&to=...
 *
 * Read-only aggregate for a LOCATION. A location holds no stock of its own — it
 * is the sum of its child revenue centers. For each in-scope child RC this
 * returns the SAME purchases-÷-food-sales food-cost-% measure the live
 * cost-chrome strip shows (see api/insights/cost-chrome), per RC, plus a
 * revenue-weighted blend across RCs.
 *
 * This fixes the motivating bug: a Cafe location with a FOOD (Kitchen) + DRINK
 * (Bar) RC now reports food cost % and pour cost % as SEPARATE per-RC lines and
 * a single revenue-weighted blended COGS %, instead of a meaningless "100% food".
 *
 * Window: defaults to week-to-date (Monday 00:00 → now), matching cost-chrome.
 */
export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const locationId = searchParams.get('locationId')
  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 })
  }

  // Window — match cost-chrome: week-to-date by default. `from`/`to` override.
  const now = new Date()
  const from = searchParams.get('from') ? new Date(searchParams.get('from')!) : startOfWeek(now)
  const to = searchParams.get('to') ? new Date(searchParams.get('to')! + 'T23:59:59.999Z') : now

  // Child RCs of the location, intersected with the caller's scope.
  const allowed = await resolveScopedRcIds(user)
  const childRcs = await prisma.revenueCenter.findMany({
    where: { locationId, isActive: true },
    select: { id: true, name: true, type: true, targetCostPct: true, targetFoodCostPct: true },
    orderBy: { name: 'asc' },
  })
  const inScope = childRcs.filter(rc => allowed === null || allowed.has(rc.id))

  // Empty-but-valid payload when nothing is in scope.
  if (inScope.length === 0) {
    return NextResponse.json({
      locationId,
      from: from.toISOString(),
      to: to.toISOString(),
      totalSales: 0,
      blendedCostPct: null,
      blendedTargetPct: null,
      revenueCenters: [],
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // Per-RC sales + purchases for the window, in parallel.
  // costPct = (purchases ÷ food-sales) × 100 — the same measure cost-chrome shows.
  const perRc = await Promise.all(inScope.map(async rc => {
    const [salesRows, purchases] = await Promise.all([
      prisma.salesEntry.findMany({
        where: { date: { gte: from, lte: to }, revenueCenterId: rc.id },
        select: { totalRevenue: true, foodSalesPct: true },
      }),
      prisma.invoiceScanItem.aggregate({
        where: {
          approved: true,
          splitToSessionId: null,
          session: { purchaseDate: { gte: from, lte: to }, revenueCenterId: rc.id },
        },
        _sum: { rawLineTotal: true },
      }),
    ])

    // Sales = total revenue in the window for this RC.
    const sales = salesRows.reduce((s, e) => s + Number(e.totalRevenue), 0)
    // Cost-of-goods denominator mirrors cost-chrome: revenue weighted by the
    // food-sales share, so a DRINK RC's pour cost is measured against drink sales.
    const costSales = salesRows.reduce(
      (s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct),
      0,
    )
    const cogs = Number(purchases._sum.rawLineTotal ?? 0)
    const costPct = costSales > 0 ? (cogs / costSales) * 100 : null
    // targetCostPct is canonical; targetFoodCostPct is a deprecated alias.
    const rawTarget = rc.targetCostPct ?? rc.targetFoodCostPct
    const targetCostPct = rawTarget != null ? Number(rawTarget) : null

    return { id: rc.id, name: rc.name, type: rc.type, sales, cogs, costPct, targetCostPct }
  }))

  // Location blend — revenue-weighted across RCs with sales > 0.
  const totalSales = perRc.reduce((s, r) => s + r.sales, 0)
  const withSales = perRc.filter(r => r.sales > 0)
  const weightBase = withSales.reduce((s, r) => s + r.sales, 0)

  const blendedCostPct = weightBase > 0
    ? withSales.reduce((s, r) => s + (r.costPct ?? 0) * r.sales, 0) / weightBase
    : null
  const targetWeightBase = withSales
    .filter(r => r.targetCostPct != null)
    .reduce((s, r) => s + r.sales, 0)
  const blendedTargetPct = targetWeightBase > 0
    ? withSales
        .filter(r => r.targetCostPct != null)
        .reduce((s, r) => s + (r.targetCostPct as number) * r.sales, 0) / targetWeightBase
    : null

  return NextResponse.json({
    locationId,
    from: from.toISOString(),
    to: to.toISOString(),
    totalSales,
    blendedCostPct,
    blendedTargetPct,
    revenueCenters: perRc,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
