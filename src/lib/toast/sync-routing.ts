/**
 * Pure decision logic for the Toast sales sync. Extracted from `sales-sync.ts`
 * so the three rules that historically lost revenue are testable without a
 * database or the Toast API.
 */

/**
 * Sentinel `ToastRevenueCenterMap.toastGuid` naming "orders that arrive with no
 * revenue center at all". Catering tickets are entered against no Toast revenue
 * center, so without this row their un-menu-routed lines have nowhere to go.
 * Behaves exactly like a real RC GUID row: it may target a leaf RC or a location.
 */
export const NO_RC_ROUTE_GUID = 'no-revenue-center'

export interface LineRouteInput {
  /** `ToastItemMap.toastMenu` for this selection's item, if the item is mapped. */
  itemMenu: string | null | undefined
  /** The RC resolved from the order's own `revenueCenter` GUID, if any. */
  orderRc: string | undefined
  /** The RC configured for orders with no `revenueCenter` (see NO_RC_ROUTE_GUID). */
  noRcFallback: string | undefined
  /** Toast menu name → leaf RC id, from the `menu:<NAME>` sentinel rows. */
  menuRoutes: Map<string, string>
}

/**
 * Decide which revenue center a single line item belongs to.
 *
 * Precedence: the item's menu route wins (it is the most specific signal and
 * lets one order split across RCs), then the order's own revenue center, then
 * the no-RC fallback. `undefined` means the line genuinely cannot be placed.
 */
export function resolveLineRc({
  itemMenu,
  orderRc,
  noRcFallback,
  menuRoutes,
}: LineRouteInput): string | undefined {
  const menuRc = itemMenu ? menuRoutes.get(itemMenu) : undefined
  return menuRc ?? orderRc ?? noRcFallback
}

/**
 * Distinct business days touched by a modified-window pull, oldest first.
 *
 * This is why the trailing re-sync works at all: an order created weeks after
 * its event carries the ORIGINAL (backdated) business date, so it drags that
 * long-settled day back into scope even though the modified window is short.
 */
export function businessDatesTouched(
  orders: { businessDate?: number | null }[],
): number[] {
  const days = new Set<number>()
  for (const o of orders) if (o.businessDate) days.add(o.businessDate)
  return [...days].sort((a, b) => a - b)
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** Re-read a little before the last sync so nothing falls through the seam. */
const OVERLAP_MS = 6 * HOUR_MS
const COLD_START_MS = 7 * DAY_MS
const MAX_LOOKBACK_MS = 30 * DAY_MS

/**
 * Start of the "what changed recently?" window. Resumes from the last successful
 * sync (with overlap), defaults to a week on a cold start, and caps a long outage
 * at 30 days so one run can't try to pull the entire order history.
 */
export function resyncWindowStart(lastSyncedAt: Date | null | undefined, now: Date): Date {
  const floor = now.getTime() - MAX_LOOKBACK_MS
  const from = lastSyncedAt
    ? lastSyncedAt.getTime() - OVERLAP_MS
    : now.getTime() - COLD_START_MS
  return new Date(Math.min(Math.max(from, floor), now.getTime()))
}

/**
 * Revenue centers holding a stored Toast row for a day that produced no revenue
 * on this pull — i.e. every order behind it was voided or moved since.
 *
 * A zero-order pull is deliberately treated as "no evidence": a genuinely closed
 * day and an empty/failed API response are indistinguishable, and deleting real
 * revenue on the strength of an empty response is far worse than leaving a stale
 * row for a day that had no sales anyway.
 */
export function staleToastRcIds({
  storedRcIds,
  activeRcIds,
  ordersPulled,
}: {
  storedRcIds: string[]
  activeRcIds: string[]
  ordersPulled: number
}): string[] {
  if (ordersPulled === 0) return []
  const active = new Set(activeRcIds)
  return storedRcIds.filter((id) => !active.has(id))
}
