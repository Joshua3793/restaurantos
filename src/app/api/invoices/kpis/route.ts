// src/app/api/invoices/kpis/route.ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const now = new Date()

  // ISO week: Monday-based
  const dayOfWeek = now.getDay()
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const weekStart = new Date(now)
  weekStart.setDate(now.getDate() + diffToMonday)
  weekStart.setHours(0, 0, 0, 0)

  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekStart.getDate() + 7)  // Sunday 23:59:59 (exclusive upper bound = next Monday)

  const prevWeekStart = new Date(weekStart)
  prevWeekStart.setDate(weekStart.getDate() - 7)
  const prevWeekEnd = new Date(weekStart) // prevWeekEnd === weekStart (exclusive end for previous ISO week)

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  const [
    weekAgg,
    prevWeekAgg,
    monthAgg,
    monthCount,
    priceAlertCount,
    awaitingCount,
    lineItems,
  ] = await Promise.all([
    prisma.invoiceSession.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: weekStart, lt: weekEnd } },
      _sum: { total: true },
    }),
    prisma.invoiceSession.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: prevWeekStart, lt: prevWeekEnd } },
      _sum: { total: true },
    }),
    prisma.invoiceSession.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: monthStart, lt: monthEnd } },
      _sum: { total: true },
    }),
    prisma.invoiceSession.count({
      where: { status: 'APPROVED', approvedAt: { gte: monthStart, lt: monthEnd } },
    }),
    prisma.priceAlert.count({
      where: { acknowledged: false },
    }),
    prisma.invoiceSession.count({
      where: { status: 'REVIEW' },
    }),
    prisma.invoiceLineItem.findMany({
      // Invoice records are created at approval time, so createdAt ≈ approvedAt
      where: { invoice: { createdAt: { gte: monthStart, lt: monthEnd } } },
      include: { inventoryItem: { select: { category: true } } },
    }),
  ])

  const weekSpend = Number(weekAgg._sum.total ?? 0)
  const prevWeekSpend = Number(prevWeekAgg._sum.total ?? 0)
  const weekSpendChangePct = prevWeekSpend === 0
    ? 0
    : Math.round(((weekSpend - prevWeekSpend) / prevWeekSpend) * 100)

  // Group line items by category
  const categoryMap: Record<string, number> = {}
  for (const item of lineItems) {
    const cat = item.inventoryItem.category
    categoryMap[cat] = (categoryMap[cat] ?? 0) + Number(item.lineTotal)
  }
  const topCategories = Object.entries(categoryMap)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([category, spend]) => ({ category, spend }))

  return NextResponse.json({
    weekSpend,
    weekSpendChangePct,
    monthSpend: Number(monthAgg._sum.total ?? 0),
    monthInvoiceCount: monthCount,
    priceAlertCount,
    awaitingApprovalCount: awaitingCount,
    topCategories,
  })
}
