import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)

  const [suppliers, monthAgg, prevMonthAgg, invoiceAgg] = await Promise.all([
    prisma.supplier.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { inventory: true } },
        aliases: { select: { id: true, name: true }, orderBy: { createdAt: 'asc' } },
      },
    }),
    prisma.invoiceSession.groupBy({
      by: ['supplierId'],
      where: {
        status: 'APPROVED',
        supplierId: { not: null },
        approvedAt: { gte: monthStart, lt: monthEnd },
      },
      _sum: { total: true },
    }),
    prisma.invoiceSession.groupBy({
      by: ['supplierId'],
      where: {
        status: 'APPROVED',
        supplierId: { not: null },
        approvedAt: { gte: prevMonthStart, lt: monthStart },
      },
      _sum: { total: true },
    }),
    prisma.invoiceSession.groupBy({
      by: ['supplierId'],
      where: { status: 'APPROVED', supplierId: { not: null } },
      _count: true,
    }),
  ])

  const monthMap = Object.fromEntries(monthAgg.map(r => [r.supplierId, Number(r._sum.total ?? 0)]))
  const prevMap = Object.fromEntries(prevMonthAgg.map(r => [r.supplierId, Number(r._sum.total ?? 0)]))
  const countMap = Object.fromEntries(invoiceAgg.map(r => [r.supplierId, r._count]))

  const result = suppliers.map(s => ({
    ...s,
    monthSpend: monthMap[s.id] ?? 0,
    prevMonthSpend: prevMap[s.id] ?? 0,
    invoiceCount: countMap[s.id] ?? 0,
  }))

  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { aliases, ...supplierData } = body
  const supplier = await prisma.supplier.create({
    data: {
      ...supplierData,
      ...(aliases && aliases.length > 0
        ? { aliases: { create: (aliases as string[]).map((name: string) => ({ name: name.trim() })) } }
        : {}),
    },
    include: { aliases: { select: { id: true, name: true } } },
  })
  return NextResponse.json(supplier, { status: 201 })
}
