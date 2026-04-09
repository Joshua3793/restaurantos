import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/reports/cogs-from-counts?startDate=&endDate=
// COGS formula: Opening Stock + Purchases - Closing Stock
// Uses finalized count sessions as opening/closing stock snapshots
// Purchases pulled from invoices in the date range
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const startDate = searchParams.get('startDate')
  const endDate   = searchParams.get('endDate')

  if (!startDate || !endDate) {
    return NextResponse.json({ error: 'startDate and endDate are required' }, { status: 400 })
  }

  const startMs = new Date(startDate).getTime()
  const endMs   = new Date(endDate + 'T23:59:59.999Z').getTime()

  function toMs(v: Date | number | string | null | undefined): number | null {
    if (v == null) return null
    if (typeof v === 'number') return v
    if (v instanceof Date) return v.getTime()
    return new Date(String(v).replace(' ', 'T')).getTime()
  }

  const allSessions = await prisma.countSession.findMany({
    where: { status: 'FINALIZED' },
    select: { id: true, finalizedAt: true, totalCountedValue: true, sessionDate: true, countedBy: true },
  })
  allSessions.sort((a, b) => (toMs(a.finalizedAt as never) ?? 0) - (toMs(b.finalizedAt as never) ?? 0))

  // Find opening stock: last finalized session BEFORE start date
  const opening = [...allSessions].reverse().find(s => {
    const ms = toMs(s.finalizedAt as never)
    return ms !== null && ms < startMs
  }) ?? null

  // Find closing stock: last finalized session ON OR BEFORE end date
  const closing = [...allSessions].reverse().find(s => {
    const ms = toMs(s.finalizedAt as never)
    return ms !== null && ms <= endMs
  }) ?? null

  const start = new Date(startDate)
  const end   = new Date(endDate)
  end.setHours(23, 59, 59, 999)

  // Purchases: sum of invoice totals in range
  const invoices = await prisma.invoice.findMany({
    where: {
      invoiceDate: { gte: start, lte: end },
      status: { not: 'CANCELLED' },
    },
    select: { id: true, invoiceDate: true, invoiceNumber: true, totalAmount: true, supplier: { select: { name: true } } },
    orderBy: { invoiceDate: 'asc' },
  })
  const totalPurchases = invoices.reduce((s, inv) => s + Number(inv.totalAmount), 0)

  const openingValue = opening ? Number(opening.totalCountedValue) : 0
  const closingValue = closing ? Number(closing.totalCountedValue) : 0
  const cogs         = openingValue + totalPurchases - closingValue
  const cogsMargin   = null // requires sales data hookup

  return NextResponse.json({
    period: { startDate, endDate },
    opening: opening ? { ...opening, value: openingValue } : null,
    closing: closing ? { ...closing, value: closingValue } : null,
    purchases: { total: totalPurchases, invoices },
    cogs,
    cogsMargin,
  })
}
