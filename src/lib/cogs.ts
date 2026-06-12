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

const ms = (v: Date | null): number => (v ? v.getTime() : 0)

/**
 * Global, snapshot-based COGS for a date range.
 * Opening = most recent finalized count ≤ startMs; Closing = most recent ≤ endMs.
 * Purchases summed from approved InvoiceSession scan items in range.
 * (Global only — per-RC actual COGS needs per-RC snapshots; not supported.)
 *
 * NOTE: "purchases" here = ALL approved, non-split scan items by session
 * approvedAt. This intentionally differs from the legacy /api/reports/cogs
 * route, which sums legacy Invoice rows + scan items filtered to
 * action IN ['UPDATE_PRICE','ADD_SUPPLIER']. The two surfaces can therefore
 * report slightly different "actual food cost %" for the same period. A
 * future task should converge them on one canonical purchase definition.
 */
export async function computePeriodCogs(startMs: number, endMs: number): Promise<PeriodCogs> {
  const sessions = await prisma.countSession.findMany({
    where: { status: 'FINALIZED', finalizedAt: { not: null } },
    select: { id: true, finalizedAt: true, totalCountedValue: true },
  })
  // Sort descending so the first match in find() is the most recent ≤ bound.
  sessions.sort((a, b) => ms(b.finalizedAt) - ms(a.finalizedAt))

  const opening = sessions.find(s => ms(s.finalizedAt) <= startMs) ?? null
  const closing = sessions.find(s => ms(s.finalizedAt) <= endMs) ?? null

  const openingValue = opening ? Number(opening.totalCountedValue) : 0
  const closingValue = closing ? Number(closing.totalCountedValue) : 0

  // Half-open start (gt, not gte): a purchase approved at the exact instant of
  // the opening count is already reflected in that count's on-hand value, so
  // including it here would double-count it.
  const purchasesAgg = await prisma.invoiceScanItem.aggregate({
    where: {
      approved: true,
      splitToSessionId: null,
      session: { approvedAt: { gt: new Date(startMs), lte: new Date(endMs) } },
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
