// src/lib/cogs.ts
import { prisma } from './prisma'
import { resolveItemBound, type BoundSession, type ItemBound } from './cogs-bounds'

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
 * Purchases = approved, non-split InvoiceScanItems whose session.purchaseDate is
 * in [startMs, endMs], summed on rawLineTotal. purchaseDate is the invoice's own
 * date (see src/lib/purchase-date.ts), so a June-dated invoice approved in July
 * still lands in June. This matches the live cost-chrome spine aggregate exactly:
 * NO action filter (a received line whose price didn't
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
      session: { purchaseDate: { gte: new Date(startMs), lte: new Date(endMs) }, ...sessionRc },
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
 * A counted inventory position bounding one end of a period. `sessionId` /
 * `sessionDate` name the FULL count that defines the bound; the value is built per
 * item (see {@link ItemBound}) and the coverage fields say how much of it the
 * bounding count itself observed.
 */
export type SnapshotBound = ItemBound

/**
 * Resolve the opening/closing counted inventory bounding a period — the SINGLE
 * source of truth for period inventory bounds, shared by computePeriodCogs and
 * /api/reports/cogs so they can't drift.
 *
 * A bound is anchored on the latest FULL count with sessionDate ≤ the bound (the
 * effective count date the user chose, NOT `finalizedAt` — otherwise a count taken
 * on the 1st but approved on the 10th would be excluded from a period starting the
 * 1st). That count defines WHICH items the bound covers. Each item's VALUE is its
 * most recent observed snapshot (COUNTED or CARRIED — never THEORETICAL/SKIPPED)
 * from any finalized count ≤ the bound, quick and partial counts included: a
 * prep-only count updates the prep items and everything else keeps the last
 * quantity somebody actually counted. The merge is `resolveItemBound`.
 *
 * RC scope mirrors the rest of the app: a snapshot's revenue center is its session's
 * (InventorySnapshot has no RC column). A global (rc=null) count writes the default
 * pool, so the default RC and the "All RCs" view both read global counts; a
 * non-default RC reads only its own RC-scoped counts.
 *
 * Returns null for a bound when no FULL count precedes it.
 */
export interface SnapshotScope {
  rcId?: string | null
  /** When the selected RC is the default pool, read global counts (which wrote that pool). */
  isDefault?: boolean
}

export async function periodSnapshotBounds(
  startMs: number, endMs: number, scope: SnapshotScope = {},
): Promise<{ opening: SnapshotBound | null; closing: SnapshotBound | null }> {
  // A default-RC count may be tagged with the global null pool OR the default RC's own
  // id (depending how it was created), so the default reads both; a non-default RC reads
  // only its own counts; an unscoped call falls back to the global pool. ("All RCs" is
  // computed as ΣRC by the caller — it never calls this without an rcId.)
  const rcWhere = scope.rcId
    ? (scope.isDefault
        ? { OR: [{ revenueCenterId: scope.rcId }, { revenueCenterId: null }] }
        : { revenueCenterId: scope.rcId })
    : { revenueCenterId: null }

  const rows = await prisma.countSession.findMany({
    where: { status: 'FINALIZED', sessionDate: { lte: new Date(endMs) }, ...rcWhere },
    select: {
      id: true, type: true, sessionDate: true, finalizedAt: true,
      snapshots: { select: { inventoryItemId: true, totalValue: true, category: true, source: true } },
    },
  })
  const sessions: BoundSession[] = rows.map(r => ({
    ...r,
    snapshots: r.snapshots.map(s => ({ ...s, totalValue: Number(s.totalValue) })),
  }))

  return { opening: resolveItemBound(sessions, startMs), closing: resolveItemBound(sessions, endMs) }
}

/**
 * Snapshot-based COGS for a date range.
 * Opening/closing via the canonical {@link periodSnapshotBounds}; purchases via
 * the canonical {@link periodPurchases}. `scope` (default `{}` = global) is
 * threaded to both so a single RC can be bracketed by its own counts/purchases;
 * for the "All RCs" view (ΣRC) the caller sums per-RC results (a default-pool
 * count can't be split across RCs). SalesEntry.revenueCenterId is NOT NULL, so
 * the food-sales denominator filters on the concrete rcId only.
 */
export async function computePeriodCogs(
  startMs: number, endMs: number, scope: SnapshotScope = {},
): Promise<PeriodCogs> {
  const { opening, closing } = await periodSnapshotBounds(startMs, endMs, scope)

  const openingValue = opening?.value ?? 0
  const closingValue = closing?.value ?? 0

  const { total: purchases } = await periodPurchases(startMs, endMs, scope)

  const salesAgg = await prisma.salesEntry.findMany({
    where: {
      date: { gte: new Date(startMs), lte: new Date(endMs) },
      ...(scope.rcId ? { revenueCenterId: scope.rcId } : {}),
    },
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
