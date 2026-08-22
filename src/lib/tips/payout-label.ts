/**
 * Pure formatting for a payout's "paid" line on the staff-facing /tips/me
 * screen. Split out of MyPayoutDetail.tsx so it can be unit tested directly —
 * vitest's transform pipeline here can't import a .tsx file containing JSX,
 * only plain .ts.
 */

// A legacy flat snapshot (pre-payout-history) has no recorded `paidAt`, and
// `readSnapshot` in lib/tips/snapshot.ts backfills that gap with
// `new Date(0).toISOString()` rather than inventing a real date. `me.ts`
// passes that sentinel straight through as a normal ISO string, so without
// this guard a cook would see "paid Jan 1" for a payout nobody actually knows
// the pay date of. Treat the sentinel — and any other unparseable string —
// the same way `null` is already treated: as no known date.
const EPOCH_SENTINEL = new Date(0).toISOString()

/** `null` when `iso` is missing, the epoch sentinel, or otherwise unparseable. */
export function dateLabel(iso: string | null): string | null {
  if (!iso || iso === EPOCH_SENTINEL) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
}

/** The " · paid Aug 12 by Dana" / " · paid by Dana" / "" line under the amount. */
export function paidLine(paidAt: string | null, paidByName: string | null): string {
  const label = dateLabel(paidAt)
  if (label) return ` · paid ${label}${paidByName ? ` by ${paidByName}` : ''}`
  if (paidByName) return ` · paid by ${paidByName}`
  return ''
}
