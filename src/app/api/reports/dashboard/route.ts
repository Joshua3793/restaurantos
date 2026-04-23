import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const now = new Date()
  const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7)
  const monthAgo = new Date(now); monthAgo.setDate(monthAgo.getDate() - 30)

  const [inventory, weekWastage, monthWastage, recentInvoices, weeklySales, weeklyPurchases] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { isActive: true },
      select: {
        id: true, itemName: true, category: true, baseUnit: true,
        stockOnHand: true, conversionFactor: true, pricePerBaseUnit: true, purchasePrice: true,
        lastCountDate: true,
        supplier: { select: { name: true } },
      },
    }),
    prisma.wastageLog.aggregate({ where: { date: { gte: weekAgo } }, _sum: { costImpact: true } }),
    prisma.wastageLog.aggregate({ where: { date: { gte: monthAgo } }, _sum: { costImpact: true } }),
    prisma.invoice.findMany({ take: 5, orderBy: { createdAt: 'desc' }, include: { supplier: true } }),
    prisma.salesEntry.findMany({ where: { date: { gte: weekAgo } } }),
    // Approved invoice spend in the last 7 days as proxy for purchase cost
    prisma.invoiceScanItem.aggregate({
      where: { approved: true, session: { approvedAt: { gte: weekAgo } } },
      _sum: { rawLineTotal: true },
    }),
  ])

  // Correct inventory value: stockOnHand (purchase units) × conversionFactor × pricePerBaseUnit
  const totalInventoryValue = inventory.reduce((sum, item) => {
    return sum
      + parseFloat(String(item.stockOnHand))
      * parseFloat(String(item.conversionFactor))
      * parseFloat(String(item.pricePerBaseUnit))
  }, 0)

  const weeklyWastageCost  = parseFloat(String(weekWastage._sum.costImpact  ?? 0))
  const monthlyWastageCost = parseFloat(String(monthWastage._sum.costImpact ?? 0))
  const weeklyPurchaseCost = parseFloat(String(weeklyPurchases._sum.rawLineTotal ?? 0))

  // Out-of-stock: only items that have been counted before (lastCountDate set) and are now at zero
  // Items that have never been counted are "unknown" not "out of stock"
  const outOfStockCount = inventory.filter(
    item => parseFloat(String(item.stockOnHand)) <= 0 && item.lastCountDate !== null
  ).length

  // Top 10 items by total inventory value (most capital tied up)
  const topByValue = [...inventory]
    .map(item => ({
      ...item,
      inventoryValue: parseFloat(String(item.stockOnHand))
        * parseFloat(String(item.conversionFactor))
        * parseFloat(String(item.pricePerBaseUnit)),
    }))
    .sort((a, b) => b.inventoryValue - a.inventoryValue)
    .slice(0, 10)

  const weeklyRevenue = weeklySales.reduce((sum, s) => sum + parseFloat(String(s.totalRevenue)), 0)
  const weeklyFoodSales = weeklySales.reduce((sum, s) => {
    return sum + parseFloat(String(s.totalRevenue)) * parseFloat(String(s.foodSalesPct))
  }, 0)

  // Food cost % = purchase spend / food sales (standard restaurant metric)
  // Falls back to wastage % if no purchase data available
  const foodCostNumerator = weeklyPurchaseCost > 0 ? weeklyPurchaseCost : weeklyWastageCost
  const foodCostPct = weeklyFoodSales > 0 ? (foodCostNumerator / weeklyFoodSales) * 100 : 0
  const foodCostLabel = weeklyPurchaseCost > 0 ? 'Purchases / food sales' : 'Wastage / food sales'

  // Out-of-stock items list (top 5 by last value, for alerts)
  // Exclude "never-stocked" items (those that have never been counted or received)
  const outOfStockItems = inventory
    .filter(item => parseFloat(String(item.stockOnHand)) <= 0 && item.lastCountDate !== null)
    .map(item => ({
      id: item.id,
      itemName: item.itemName,
      category: item.category,
      lastValue: parseFloat(String(item.pricePerBaseUnit)) * parseFloat(String(item.conversionFactor)),
    }))
    .sort((a, b) => b.lastValue - a.lastValue)
    .slice(0, 5)

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
  }, {
    headers: { 'Cache-Control': 'private, max-age=10, stale-while-revalidate=60' },
  })
}
