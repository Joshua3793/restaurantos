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

/** Optional revenue-center scope for period purchases. */
export interface PurchaseScope {
  rcId?: string | null
  /** When the RC is the default pool, also include unassigned (null-RC) sessions. */
  isDefault?: boolean
}

/**
 * Canonical period-purchases definition — the SINGLE source of truth for
 * "what was purchased in a date range", shared by computePeriodCogs and
 * /api/reports/cogs so they can never diverge.
 *
 * Purchases = approved, non-split InvoiceScanItems whose session.approvedAt is
 * in [startMs, endMs], summed on rawLineTotal. This matches the live cost-chrome
 * spine aggregate exactly: NO action filter (a received line whose price didn't
 * change is still a purchase) and NO legacy Invoice rows (that flow is dead and
 * the live food-cost number already ignores it). Items with a null rawLineTotal
 * contribute 0, mirroring the spine. RC scope is applied on the session.
 *
 * Returns the total, a per-category breakdown (by matchedItem.category), and the
 * number of distinct contributing sessions.
 */
export async function periodPurchases(
  startMs: number, endMs: number, scope: PurchaseScope = {},
): Promise<{ total: number; byCategory: Record<string, number>; invoiceCount: number }> {
  const sessionRc = scope.rcId
    ? (scope.isDefault
        ? { OR: [{ revenueCenterId: scope.rcId }, { revenueCenterId: null }] }
        : { revenueCenterId: scope.rcId })
    : {}

  const items = await prisma.invoiceScanItem.findMany({
    where: {
      approved: true,
      splitToSessionId: null,
      session: { approvedAt: { gte: new Date(startMs), lte: new Date(endMs) }, ...sessionRc },
    },
    select: { rawLineTotal: true, sessionId: true, matchedItem: { select: { category: true } } },
  })

  let total = 0
  const byCategory: Record<string, number> = {}
  const sessions = new Set<string>()
  for (const it of items) {
    if (it.rawLineTotal == null) continue
    const amt = Number(it.rawLineTotal)
    total += amt
    sessions.add(it.sessionId)
    const cat = it.matchedItem?.category ?? 'UNCATEGORIZED'
    byCategory[cat] = (byCategory[cat] ?? 0) + amt
  }
  return { total, byCategory, invoiceCount: sessions.size }
}

/**
 * Global, snapshot-based COGS for a date range.
 * Opening = most recent finalized count ≤ startMs; Closing = most recent ≤ endMs.
 * Purchases via the canonical {@link periodPurchases} (global scope).
 * (Global only — per-RC actual COGS needs per-RC snapshots; not supported.)
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

  const { total: purchases } = await periodPurchases(startMs, endMs)

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
