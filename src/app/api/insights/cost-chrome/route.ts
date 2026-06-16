import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { startOfWeek } from '@/lib/dates'
import { getTheoreticalStockMap } from '@/lib/count-expected'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'

export const dynamic = 'force-dynamic'

/**
 * GET /api/insights/cost-chrome
 *
 * Powers the dark live food-cost % strip mounted on every spine page.
 * Returns the 4 values shown in the strip + provenance fields for the
 * audit drawer.
 *
 * Optional `rcId` filters sales/purchases/wastage AND the on-hand inventory
 * value to a single revenue center, mirroring the inventory page's stock
 * model (default RC = global pool, non-default RC = its StockAllocation,
 * no RC = global pool + all non-default allocations).
 */
export async function GET(req: NextRequest) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const rcId = searchParams.get('rcId') || undefined

  const now = new Date()
  // Week-to-date: start of Monday this week (00:00 local)
  const weekStart = startOfWeek(now)
  const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const fourteenDaysAgo = new Date(now); fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14)

  const salesFilter = rcId ? { revenueCenterId: rcId } : {}
  const purchaseSessionFilter = rcId ? { revenueCenterId: rcId } : {}

  const [
    inventory,
    salesWTD,
    purchasesWTD,
    sales7d,
    sales7to14d,
    purchases7d,
    purchases7to14d,
    lastInvoice,
    targetRC,
  ] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { isActive: true, isStocked: true },
      select: { id: true, stockOnHand: true, ...PRICING_SELECT },
    }),
    prisma.salesEntry.findMany({
      where: { date: { gte: weekStart }, ...salesFilter },
      select: { totalRevenue: true, foodSalesPct: true },
    }),
    prisma.invoiceScanItem.aggregate({
      where: {
        approved: true,
        splitToSessionId: null,
        session: { approvedAt: { gte: weekStart }, ...purchaseSessionFilter },
      },
      _sum: { rawLineTotal: true },
    }),
    prisma.salesEntry.findMany({
      where: { date: { gte: sevenDaysAgo }, ...salesFilter },
      select: { totalRevenue: true, foodSalesPct: true },
    }),
    prisma.salesEntry.findMany({
      where: { date: { gte: fourteenDaysAgo, lt: sevenDaysAgo }, ...salesFilter },
      select: { totalRevenue: true, foodSalesPct: true },
    }),
    prisma.invoiceScanItem.aggregate({
      where: {
        approved: true,
        splitToSessionId: null,
        session: { approvedAt: { gte: sevenDaysAgo }, ...purchaseSessionFilter },
      },
      _sum: { rawLineTotal: true },
    }),
    prisma.invoiceScanItem.aggregate({
      where: {
        approved: true,
        splitToSessionId: null,
        session: { approvedAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo }, ...purchaseSessionFilter },
      },
      _sum: { rawLineTotal: true },
    }),
    prisma.invoiceSession.findFirst({
      where: { approvedAt: { not: null }, ...(rcId ? { revenueCenterId: rcId } : {}) },
      orderBy: { approvedAt: 'desc' },
      select: { approvedAt: true, supplierName: true, total: true },
    }),
    rcId
      ? prisma.revenueCenter.findUnique({ where: { id: rcId }, select: { targetFoodCostPct: true } })
      : Promise.resolve<{ targetFoodCostPct: { toString: () => string } | null } | null>(null),
  ])

  // ── On hand: RC-aware inventory value (mirrors the inventory page) ─────
  // "Theoretical" = last-counted baseline + purchases − sales − wastage − prep since
  // last count, using getTheoreticalStockMap (same engine as the inventory list).
  //
  // Pass the selected rcId to the engine whenever ANY RC is selected (default or
  // not) so the banner is scoped to that RC, exactly like the inventory list.
  // null is used only for the unfiltered "all RCs" view, where the map returns ΣRC.
  const theoreticalRcId: string | null = rcId || null
  const itemIds = inventory.map(it => it.id)
  const theoreticalMap = await getTheoreticalStockMap(theoreticalRcId, itemIds)

  // onHand:
  //   concrete RC → Σ theoreticalMap[item] × price   (map already scoped to rcId)
  //   no RC (all) → Σ theoreticalMap[item] × price   (map is the ΣRC sum)
  // No separate allocation add-back: each per-RC map already includes that RC's
  // allocation-based stock, and getTheoreticalStockMap(rcId) returns 0 for items
  // not allocated to a non-default RC. Price is computed on-read from the chain.
  const onHand = inventory.reduce(
    (sum, it) => sum + (theoreticalMap.get(it.id) ?? Number(it.stockOnHand)) * pricePerBaseUnit(asChainItem(it)),
    0,
  )
  const sourceItemCount = inventory.length

  // ── Food cost % WTD ───────────────────────────────────────────────────
  const foodSalesWTD = salesWTD.reduce(
    (sum, s) => sum + Number(s.totalRevenue) * Number(s.foodSalesPct),
    0,
  )
  const purchasesWTDTotal = Number(purchasesWTD._sum.rawLineTotal ?? 0)
  const foodCostPct = foodSalesWTD > 0
    ? (purchasesWTDTotal / foodSalesWTD) * 100
    : null

  // ── 7d variance (food-cost $ delta this 7d vs prior 7d) ───────────────
  const foodSales7d  = sales7d.reduce(    (s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
  const foodSalesP7d = sales7to14d.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
  const purch7d  = Number(purchases7d._sum.rawLineTotal     ?? 0)
  const purchP7d = Number(purchases7to14d._sum.rawLineTotal ?? 0)
  // Variance: did food-cost $ change vs prior week? Positive = went up (bad).
  const variance7d = (foodSales7d > 0 || foodSalesP7d > 0)
    ? (purch7d - purchP7d)
    : null

  // ── Target ────────────────────────────────────────────────────────────
  // Per-RC if filtered; otherwise use the default RC target if defined; fallback 27.0
  let targetPct: number = 27.0
  if (targetRC?.targetFoodCostPct != null) {
    targetPct = Number(targetRC.targetFoodCostPct)
  } else {
    const defaultRc = await prisma.revenueCenter.findFirst({
      where: { isDefault: true },
      select: { targetFoodCostPct: true },
    })
    if (defaultRc?.targetFoodCostPct != null) targetPct = Number(defaultRc.targetFoodCostPct)
  }

  return NextResponse.json({
    foodCostPct,            // number | null  — WTD %
    targetPct,              // number          — target %
    variance7d,             // number | null  — $ delta vs prior 7d
    onHand,                 // number          — total inventory $
    lastInvoiceAt: lastInvoice?.approvedAt ?? null,
    lastInvoiceSupplier: lastInvoice?.supplierName ?? null,
    sourceItemCount,
    rcId: rcId ?? null,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
