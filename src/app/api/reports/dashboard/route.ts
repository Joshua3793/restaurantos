import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const now = new Date()
  const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7)
  const monthAgo = new Date(now); monthAgo.setDate(monthAgo.getDate() - 30)

  const [inventory, weekWastage, monthWastage, recentInvoices, weeklySales] = await Promise.all([
    prisma.inventoryItem.findMany({ include: { supplier: true } }),
    prisma.wastageLog.findMany({ where: { date: { gte: weekAgo } }, include: { inventoryItem: true } }),
    prisma.wastageLog.findMany({ where: { date: { gte: monthAgo } }, include: { inventoryItem: true } }),
    prisma.invoice.findMany({ take: 5, orderBy: { createdAt: 'desc' }, include: { supplier: true } }),
    prisma.salesEntry.findMany({ where: { date: { gte: weekAgo } } }),
  ])

  const totalInventoryValue = inventory.reduce((sum, item) => {
    return sum + parseFloat(String(item.stockOnHand)) * parseFloat(String(item.pricePerBaseUnit))
  }, 0)

  const weeklyWastageCost = weekWastage.reduce((sum, log) => sum + parseFloat(String(log.costImpact)), 0)
  const monthlyWastageCost = monthWastage.reduce((sum, log) => sum + parseFloat(String(log.costImpact)), 0)

  const lowStockCount = inventory.filter(item => parseFloat(String(item.stockOnHand)) < 3).length

  const topExpensive = [...inventory]
    .sort((a, b) => parseFloat(String(b.pricePerBaseUnit)) - parseFloat(String(a.pricePerBaseUnit)))
    .slice(0, 10)

  const weeklyRevenue = weeklySales.reduce((sum, s) => sum + parseFloat(String(s.totalRevenue)), 0)
  const weeklyFoodSales = weeklySales.reduce((sum, s) => {
    return sum + parseFloat(String(s.totalRevenue)) * parseFloat(String(s.foodSalesPct))
  }, 0)

  const estimatedFoodCostPct = weeklyFoodSales > 0 ? (weeklyWastageCost / weeklyFoodSales) * 100 : 0

  return NextResponse.json({
    totalInventoryValue,
    weeklyWastageCost,
    monthlyWastageCost,
    lowStockCount,
    topExpensiveItems: topExpensive,
    recentInvoices,
    weeklyRevenue,
    estimatedFoodCostPct,
    inventoryCount: inventory.length,
  })
}
