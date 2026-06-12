// src/lib/cogs.ts
import { prisma } from './prisma'

export interface PeriodCogs {
  openingValue: number
  closingValue: number
  purchases: number
  cogs: number              // opening + purchases − closing
  foodSales: number
  openingSessionId: string | null
  closingSessionId: string | null
  /** True when fewer than two finalized counts bound the period. */
  needsCounts: boolean
}

const ms = (v: Date | number | string | null | undefined): number => {
  if (!v) return 0
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  return new Date(String(v).replace(' ', 'T')).getTime()
}

/**
 * Global, snapshot-based COGS for a date range.
 * Opening = most recent finalized count ≤ startMs; Closing = most recent ≤ endMs.
 * Purchases summed from approved InvoiceSession scan items in range.
 * (Global only — per-RC actual COGS needs per-RC snapshots; not supported.)
 */
export async function computePeriodCogs(startMs: number, endMs: number): Promise<PeriodCogs> {
  const sessions = await prisma.countSession.findMany({
    where: { status: 'FINALIZED' },
    select: { id: true, finalizedAt: true, totalCountedValue: true },
  })
  sessions.sort((a, b) => ms(a.finalizedAt) - ms(b.finalizedAt))

  const opening = [...sessions].reverse().find(s => ms(s.finalizedAt) <= startMs) ?? null
  const closing = [...sessions].reverse().find(s => ms(s.finalizedAt) <= endMs) ?? null

  const openingValue = opening ? Number(opening.totalCountedValue) : 0
  const closingValue = closing ? Number(closing.totalCountedValue) : 0

  const purchasesAgg = await prisma.invoiceScanItem.aggregate({
    where: {
      approved: true,
      splitToSessionId: null,
      session: { approvedAt: { gte: new Date(startMs), lte: new Date(endMs) } },
    },
    _sum: { rawLineTotal: true },
  })
  const purchases = Number(purchasesAgg._sum.rawLineTotal ?? 0)

  const salesAgg = await prisma.salesEntry.findMany({
    where: { date: { gte: new Date(startMs), lte: new Date(endMs) } },
    select: { totalRevenue: true, foodSalesPct: true },
  })
  const foodSales = salesAgg.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)

  return {
    openingValue, closingValue, purchases,
    cogs: openingValue + purchases - closingValue,
    foodSales,
    openingSessionId: opening?.id ?? null,
    closingSessionId: closing?.id ?? null,
    needsCounts: !opening || !closing || opening.id === closing.id,
  }
}
