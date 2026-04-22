import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const yearStart = new Date(now.getFullYear(), 0, 1)
  const ninetyDaysAgo = new Date(now)
  ninetyDaysAgo.setDate(now.getDate() - 90)

  const [monthAgg, prevMonthAgg, yearAgg, yearCount, lastSession, priceAlerts, items] =
    await Promise.all([
      prisma.invoiceSession.aggregate({
        where: { supplierId: id, status: 'APPROVED', approvedAt: { gte: monthStart, lt: monthEnd } },
        _sum: { total: true },
      }),
      prisma.invoiceSession.aggregate({
        where: { supplierId: id, status: 'APPROVED', approvedAt: { gte: prevMonthStart, lt: monthStart } },
        _sum: { total: true },
      }),
      prisma.invoiceSession.aggregate({
        where: { supplierId: id, status: 'APPROVED', approvedAt: { gte: yearStart } },
        _sum: { total: true },
      }),
      prisma.invoiceSession.count({
        where: { supplierId: id, status: 'APPROVED', approvedAt: { gte: yearStart } },
      }),
      prisma.invoiceSession.findFirst({
        where: { supplierId: id, status: 'APPROVED' },
        orderBy: { approvedAt: 'desc' },
        select: { approvedAt: true },
      }),
      prisma.priceAlert.findMany({
        where: { session: { supplierId: id }, createdAt: { gte: ninetyDaysAgo } },
        select: {
          previousPrice: true,
          newPrice: true,
          changePct: true,
          createdAt: true,
          inventoryItem: { select: { itemName: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.inventoryItem.findMany({
        where: { supplierId: id },
        orderBy: { itemName: 'asc' },
        select: { id: true, itemName: true, pricePerBaseUnit: true, baseUnit: true },
      }),
    ])

  const monthSpend = Number(monthAgg._sum.total ?? 0)
  const prevMonthSpend = Number(prevMonthAgg._sum.total ?? 0)
  const monthSpendChangePct =
    prevMonthSpend === 0 ? 0 : Math.round(((monthSpend - prevMonthSpend) / prevMonthSpend) * 100)

  return NextResponse.json({
    monthSpend,
    monthSpendChangePct,
    yearSpend: Number(yearAgg._sum.total ?? 0),
    yearInvoiceCount: yearCount,
    lastApprovedAt: lastSession?.approvedAt?.toISOString() ?? null,
    priceChanges: priceAlerts.map(a => ({
      itemName: a.inventoryItem.itemName,
      oldPrice: Number(a.previousPrice),
      newPrice: Number(a.newPrice),
      pctChange: Number(a.changePct),
      date: a.createdAt.toISOString().split('T')[0],
    })),
    items: items.map(i => ({
      id: i.id,
      itemName: i.itemName,
      pricePerBaseUnit: Number(i.pricePerBaseUnit),
      baseUnit: i.baseUnit,
    })),
  })
}
