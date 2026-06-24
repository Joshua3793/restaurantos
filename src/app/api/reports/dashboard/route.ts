import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { startOfWeek } from '@/lib/dates'
import { theoreticalCostForLineItems } from '@/lib/theoretical-cost'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit, withPpb } from '@/lib/item-model'

export async function GET(req: NextRequest) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const rcId      = searchParams.get('rcId') || ''
  const isDefault = searchParams.get('isDefault') === 'true'

  const now = new Date()
  const weekAgo  = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7)
  const monthAgo = new Date(now); monthAgo.setDate(monthAgo.getDate() - 30)
  const weekStart = startOfWeek(now)

  // Optional analysis range (Reports Overview date-range picker). `from`/`to` are
  // calendar dates (YYYY-MM-DD) interpreted at UTC boundaries — matching how sales
  // `date` is stored (date-only → UTC midnight). Using UTC (not local) boundaries is
  // essential: a sale dated 2026-06-01 lives at 00:00Z, so a local-midnight "start of
  // June 1" (07:00Z in Pacific) would wrongly exclude it.
  // When BOTH are present every time-windowed metric is computed over that single
  // window; when absent the legacy behaviour is preserved byte-for-byte (rolling-7d
  // cards + WTD food-cost block), so the `pass` / `signals` consumers — which never
  // send a range — are unaffected.
  const fromParam = searchParams.get('from')
  const toParam   = searchParams.get('to')
  const hasRange  = !!fromParam && !!toParam
  const periodStart = hasRange ? new Date(`${fromParam}T00:00:00.000Z`) : null
  const periodEnd   = hasRange ? new Date(`${toParam}T23:59:59.999Z`)   : null
  // Card metrics default to rolling-7d (weekAgo); food-cost block defaults to WTD (weekStart).
  // A supplied range overrides both with the same window.
  const cardsWin = hasRange ? { gte: periodStart!, lte: periodEnd! } : { gte: weekAgo }
  const fcWin    = hasRange ? { gte: periodStart!, lte: periodEnd! } : { gte: weekStart }

  // Sales / wastage filter: if a specific RC is selected, filter by it; otherwise all
  const rcFilter = rcId ? { revenueCenterId: rcId } : {}

  const [inventoryRaw, weekWastage, monthWastage, recentInvoices, weeklySales, weeklyPurchases, salesWTD, purchasesWTD] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { isActive: true, isStocked: true },
      select: {
        id: true, itemName: true, category: true,
        stockOnHand: true, ...PRICING_SELECT, purchasePrice: true,
        lastCountDate: true,
        supplier: { select: { name: true } },
        stockAllocations: { select: { quantity: true, revenueCenterId: true } },
      },
    }),
    prisma.wastageLog.aggregate({ where: { date: cardsWin,          ...rcFilter }, _sum: { costImpact: true } }),
    prisma.wastageLog.aggregate({ where: { date: { gte: monthAgo }, ...rcFilter }, _sum: { costImpact: true } }),
    prisma.invoiceSession.findMany({
      take: 8,
      orderBy: { createdAt: 'desc' },
      where: { status: { not: 'UPLOADING' } },
      select: { id: true, status: true, supplierName: true, invoiceNumber: true, invoiceDate: true, total: true, createdAt: true },
    }),
    prisma.salesEntry.findMany({ where: { date: cardsWin, ...rcFilter } }),
    prisma.invoiceScanItem.aggregate({
      where: { approved: true, splitToSessionId: null, session: { approvedAt: cardsWin } },
      _sum: { rawLineTotal: true },
    }),
    prisma.salesEntry.findMany({
      where: { date: fcWin, ...rcFilter },
      select: {
        totalRevenue: true, foodSalesPct: true, covers: true,
        lineItems: { select: { recipeId: true, qtySold: true } },
      },
    }),
    prisma.invoiceScanItem.aggregate({
      where: {
        approved: true,
        splitToSessionId: null,
        session: { approvedAt: fcWin, ...(rcId ? { revenueCenterId: rcId } : {}) },
      },
      _sum: { rawLineTotal: true },
    }),
  ])

  // Build per-item effective stock based on selected RC:
  // - No RC selected ("All"): stockOnHand + all allocations = true total physical stock
  // - Default RC (Cafe): stockOnHand only (the Cafe pool after pulls)
  // - Non-default RC (Catering etc.): only items allocated to that RC, using that allocation qty
  const toItem = (item: Omit<typeof inventoryRaw[0], 'stockAllocations'>, stock: number) => ({
    ...item, stockOnHand: stock,
  })

  const inventory = rcId && !isDefault
    // Non-default RC: only items with an allocation for this RC, stock = allocation qty
    ? inventoryRaw.flatMap(({ stockAllocations, ...item }) => {
        const alloc = stockAllocations.find(a => a.revenueCenterId === rcId)
        return alloc ? [toItem(item, Number(alloc.quantity))] : []
      })
    : inventoryRaw.map(({ stockAllocations, ...item }) =>
        toItem(item,
          rcId && isDefault
            // Default RC (Cafe): pool after pulls
            ? Number(item.stockOnHand)
            // All: Cafe pool + every allocation
            : Number(item.stockOnHand) + stockAllocations.reduce((s, a) => s + Number(a.quantity), 0)
        )
      )

  // Inventory value: stockOnHand (baseUnit) × pricePerBaseUnit
  const totalInventoryValue = inventory.reduce((sum, item) =>
    sum + item.stockOnHand * pricePerBaseUnit(asChainItem(item)), 0)

  const weeklyWastageCost  = parseFloat(String(weekWastage._sum.costImpact  ?? 0))
  const monthlyWastageCost = parseFloat(String(monthWastage._sum.costImpact ?? 0))
  const weeklyPurchaseCost = parseFloat(String(weeklyPurchases._sum.rawLineTotal ?? 0))

  // Out-of-stock: items that have been counted before and are now at zero
  const outOfStockCount = inventory.filter(
    item => item.stockOnHand <= 0 && item.lastCountDate !== null
  ).length

  const topByValue = [...inventory]
    // withPpb re-populates the computed pricePerBaseUnit reports/page.tsx reads off topItems.
    .map(item => ({
      ...withPpb(item),
      inventoryValue: item.stockOnHand * pricePerBaseUnit(asChainItem(item)),
    }))
    .sort((a, b) => b.inventoryValue - a.inventoryValue)
    .slice(0, 10)

  const weeklyRevenue = weeklySales.reduce((sum, s) => sum + parseFloat(String(s.totalRevenue)), 0)
  const weeklyFoodSales = weeklySales.reduce((sum, s) =>
    sum + parseFloat(String(s.totalRevenue)) * parseFloat(String(s.foodSalesPct)), 0)

  const foodCostNumerator = weeklyPurchaseCost > 0 ? weeklyPurchaseCost : weeklyWastageCost
  const foodCostPct  = weeklyFoodSales > 0 ? (foodCostNumerator / weeklyFoodSales) * 100 : 0
  const foodCostLabel = weeklyPurchaseCost > 0 ? 'Purchases / food sales' : 'Wastage / food sales'

  const outOfStockItems = inventory
    .filter(item => item.stockOnHand <= 0 && item.lastCountDate !== null)
    .map(item => ({
      id: item.id, itemName: item.itemName, category: item.category,
      lastValue: pricePerBaseUnit(asChainItem(item)),
    }))
    .sort((a, b) => b.lastValue - a.lastValue)
    .slice(0, 5)

  // ── WTD food-cost block (single Monday-WTD window; all cells comparable) ──
  const foodSalesWTD = salesWTD.reduce(
    (s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
  const revenueWTD = salesWTD.reduce((s, e) => s + Number(e.totalRevenue), 0)
  const purchasesWTDTotal = Number(purchasesWTD._sum.rawLineTotal ?? 0)

  const wtdLineItems = salesWTD.flatMap(e => e.lineItems)
  const theo = await theoreticalCostForLineItems(wtdLineItems)

  const purchaseFoodCostPct  = foodSalesWTD > 0 ? (purchasesWTDTotal / foodSalesWTD) * 100 : null
  const theoreticalFoodCostPct = foodSalesWTD > 0 ? (theo.theoreticalCost / foodSalesWTD) * 100 : null

  const coversWTD = salesWTD.reduce((s, e) => s + (e.covers ?? 0), 0)
  const avgCheck     = coversWTD > 0 ? revenueWTD / coversWTD : null
  const revPerCover  = coversWTD > 0 ? foodSalesWTD / coversWTD : null
  const costPerCover = coversWTD > 0 ? theo.theoreticalCost / coversWTD : null

  // Wastage % uses the existing rolling-7d wastage $ + 7d food sales so the two
  // wastage figures (the $ cell and this %) share one window.
  const wastagePctOfSales = weeklyFoodSales > 0 ? (weeklyWastageCost / weeklyFoodSales) * 100 : null

  return NextResponse.json({
    totalInventoryValue,
    weeklyWastageCost,
    monthlyWastageCost,
    outOfStockCount,
    outOfStockItems,
    topExpensiveItems: topByValue,
    recentInvoices,
    weeklyRevenue,
    weeklyFoodSales,
    weeklyPurchaseCost,
    estimatedFoodCostPct: foodCostPct,
    foodCostLabel,
    inventoryCount: inventory.length,
    weekStartWTD: weekStart.toISOString(),
    appliedRange: hasRange ? { from: periodStart!.toISOString(), to: periodEnd!.toISOString() } : null,
    foodSalesWTD,
    purchasesWTD: purchasesWTDTotal,
    purchaseFoodCostPct,
    theoreticalCostWTD: theo.theoreticalCost,
    theoreticalFoodCostPct,
    theoreticalCoverage: { costed: theo.costedRecipes, total: theo.totalRecipes },
    wastagePctOfSales,
    coversWTD,
    avgCheck,
    revPerCover,
    costPerCover,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
