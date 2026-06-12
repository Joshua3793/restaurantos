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

/** A finalized-count inventory snapshot bounding one end of a period. */
export interface SnapshotBound {
  sessionId: string
  sessionDate: Date
  value: number
  byCategory: Record<string, number>
}

/**
 * Resolve the opening/closing finalized-count inventory bounding a period —
 * the SINGLE source of truth for global period inventory bounds, shared by
 * computePeriodCogs and /api/reports/cogs so they can't drift.
 *
 * opening = most recent finalized count ≤ startMs; closing = most recent ≤ endMs.
 * Value is summed from the session's InventorySnapshot rows (priced totalValue).
 * This equals CountSession.totalCountedValue by construction (count-finalize
 * writes both from the same per-line value), but the snapshot rows additionally
 * carry the per-category breakdown the COGS report needs. Returns null for a
 * bound when no finalized count precedes it. Global only.
 */
export async function periodSnapshotBounds(startMs: number, endMs: number): Promise<{
  opening: SnapshotBound | null
  closing: SnapshotBound | null
}> {
  const sessions = await prisma.countSession.findMany({
    where: { status: 'FINALIZED', finalizedAt: { not: null } },
    select: {
      id: true, finalizedAt: true, sessionDate: true,
      snapshots: { select: { totalValue: true, category: true } },
    },
  })
  // Sort descending so the first match in find() is the most recent ≤ bound.
  sessions.sort((a, b) => ms(b.finalizedAt) - ms(a.finalizedAt))

  const pick = (boundMs: number): SnapshotBound | null => {
    const s = sessions.find(x => ms(x.finalizedAt) <= boundMs)
    if (!s) return null
    let value = 0
    const byCategory: Record<string, number> = {}
    for (const snap of s.snapshots) {
      const v = Number(snap.totalValue)
      value += v
      byCategory[snap.category] = (byCategory[snap.category] ?? 0) + v
    }
    return { sessionId: s.id, sessionDate: s.sessionDate, value, byCategory }
  }

  return { opening: pick(startMs), closing: pick(endMs) }
}

/**
 * Global, snapshot-based COGS for a date range.
 * Opening/closing via the canonical {@link periodSnapshotBounds}; purchases via
 * the canonical {@link periodPurchases} (global scope).
 * (Global only — per-RC actual COGS needs per-RC snapshots; not supported.)
 */
export async function computePeriodCogs(startMs: number, endMs: number): Promise<PeriodCogs> {
  const { opening, closing } = await periodSnapshotBounds(startMs, endMs)

  const openingValue = opening?.value ?? 0
  const closingValue = closing?.value ?? 0

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
    openingSessionId: opening?.sessionId ?? null,
    closingSessionId: closing?.sessionId ?? null,
    needsCounts: !opening || !closing || opening.sessionId === closing.sessionId,
  }
}
