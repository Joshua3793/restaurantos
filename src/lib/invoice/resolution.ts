// Issue-resolution model for the redesigned invoice drawer.
// The mock groups every problem on a line into `.issue` blocks, each ending in a
// decision. The progress bar ("X of N resolved"), the per-issue rendering, and
// the Approve-gate all read from these helpers so they never disagree.

import type { ScanItem } from '@/components/invoices/types'
import {
  isUnlinked, hasModeMismatch, hasFormatMismatch, hasMathCheck, hasPriceChange,
} from './predicates'
import type { IssueKind } from '@/components/invoices/v2/atoms'

// A line is treated as a "charge" (Other line items — no COGS impact) when the
// user has skipped it. Skipped lines never need a decision.
export function isCharge(item: ScanItem): boolean {
  return item.action === 'SKIP'
}

export interface ResolveOpts {
  /** line ids the user chose to write the detected mode back to the product */
  modeWriteback: boolean
  /** line ids where the user accepted/acknowledged the price change */
  priceAck: boolean
}

// Big price jumps (>15%) on a linked item are the only price deltas promoted to
// a decision-required `.issue` — smaller drifts surface only as a variance pill.
export function isBigPriceChange(item: ScanItem): boolean {
  return !!item.matchedItem && hasPriceChange(item, 15)
}

// Which issue badges a line currently shows, and whether each is resolved.
export function lineIssues(item: ScanItem, opts: ResolveOpts): Array<{ kind: IssueKind; resolved: boolean }> {
  if (isCharge(item)) return []
  const out: Array<{ kind: IssueKind; resolved: boolean }> = []

  // New SKU / needs link — only resolvable by linking, creating, or skipping
  // (all of which make isUnlinked() false), so while present it is unresolved.
  if (isUnlinked(item)) out.push({ kind: 'sku', resolved: false })

  // Mode mismatch — resolved by writing the mode back to the product. The
  // "treat as per-case once" path flips the line's pricingMode, which clears
  // hasModeMismatch() entirely, so it drops out of this list when chosen.
  if (hasModeMismatch(item)) out.push({ kind: 'mode', resolved: opts.modeWriteback })

  // Format mismatch — resolved by editing pack structure (clears the flag).
  if (hasFormatMismatch(item) && !hasModeMismatch(item)) out.push({ kind: 'mode', resolved: false })

  // Big price change — resolved once acknowledged.
  if (isBigPriceChange(item)) out.push({ kind: 'price', resolved: opts.priceAck })

  return out
}

// True when a line still has at least one issue awaiting a decision.
export function lineUnresolved(item: ScanItem, opts: ResolveOpts): boolean {
  // A math check is a hard blocker even though it has no badge of its own.
  if (!isCharge(item) && hasMathCheck(item)) return true
  return lineIssues(item, opts).some(i => !i.resolved)
}
