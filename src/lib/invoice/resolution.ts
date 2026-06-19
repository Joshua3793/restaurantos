// Issue-resolution model for the redesigned invoice drawer.
// The mock groups every problem on a line into `.issue` blocks, each ending in a
// decision. The progress bar ("X of N resolved"), the per-issue rendering, and
// the Approve-gate all read from these helpers so they never disagree.

import type { ScanItem } from '@/components/invoices/types'
import {
  isUnlinked, hasDimensionConflict, hasMathCheck, hasPriceChange,
  needsTrustCheck,
} from './predicates'
import { computeNormalisedPrices } from './calculations'
import { offerPricePerBase } from '@/lib/supplier-offers'
import { lineReceivedCountQty } from '@/lib/invoice/line-qty'
import type { IssueKind } from '@/components/invoices/v2/atoms'

/** An RC split that doesn't sum to the line's received quantity blocks approval. */
export function hasInvalidRcSplit(item: ScanItem): boolean {
  const split = item.rcSplit
  if (!Array.isArray(split) || split.length === 0) return false
  if (!item.matchedItem) return true
  const entries = split.filter(e => e && e.rcId && Number(e.qty) > 0)
  if (entries.length === 0) return true
  const { qty: total } = lineReceivedCountQty(item as unknown as Parameters<typeof lineReceivedCountQty>[0], {
    dimension: item.matchedItem.dimension ?? 'COUNT',
    baseUnit:  item.matchedItem.baseUnit ?? 'each',
    packChain: item.matchedItem.packChain,
    pricing:   item.matchedItem.pricing,
    countUnit: item.matchedItem.countUnit ?? null,
  })
  if (!(total > 0)) return true
  const sum = entries.reduce((s, e) => s + Number(e.qty), 0)
  return Math.abs(sum - total) > Math.max(0.001, total * 0.005)
}

// A line is treated as a "charge" (Other line items — no COGS impact) when the
// user has skipped it. Skipped lines never need a decision.
export function isCharge(item: ScanItem): boolean {
  return item.action === 'SKIP'
}

export interface ResolveOpts {
  /** line ids where the user accepted/acknowledged the price change */
  priceAck: boolean
  /** line ids where the user confirmed a low-trust line (low OCR conf / fuzzy match) */
  confAck: boolean
}

// ── Supplier offers on the matched item ──────────────────────────────────────
export interface SupplierRef { supplierId?: string | null; supplierName?: string | null }

// Offers are stored under the canonical Supplier name; sessions may carry a raw
// OCR variant. supplierId is the reliable join — name is the fallback.
function offerMatches(o: { supplierId?: string | null; supplierName: string }, ref: SupplierRef): boolean {
  if (ref.supplierId && o.supplierId) return o.supplierId === ref.supplierId
  return !!ref.supplierName && o.supplierName === ref.supplierName
}

export function offerForSupplier(item: ScanItem, ref: SupplierRef) {
  if (!item.matchedItem?.supplierPrices) return null
  if (!ref.supplierId && !ref.supplierName) return null
  return item.matchedItem.supplierPrices.find(o => offerMatches(o, ref)) ?? null
}

/** Cheapest OTHER supplier's offer, for the supplier-switch note. */
export function cheapestOtherOffer(item: ScanItem, ref: SupplierRef) {
  const offers = (item.matchedItem?.supplierPrices ?? [])
    .filter(o => !offerMatches(o, ref) && offerPricePerBase(o) > 0)
  if (offers.length === 0) return null
  return offers.reduce((min, o) => offerPricePerBase(o) < offerPricePerBase(min) ? o : min)
}

// Big price jumps (>15%) on a linked item are the only price deltas promoted to
// a decision-required `.issue` — smaller drifts surface only as a variance pill.
export function isBigPriceChange(item: ScanItem, ref?: SupplierRef | null): boolean {
  if (!item.matchedItem) return false
  // Prefer the unit-normalised comparison (handles $/cs vs $/L etc.) — the stored
  // priceDiffPct can be computed in mismatched units and read as a huge jump when
  // the real per-base-unit price is unchanged. Fall back to the stored pct only
  // when prices can't be normalised (e.g. per-case with no base unit).
  const norm = computeNormalisedPrices(item)
  if (norm) {
    // The trigger is SPINE-relative: approving re-costs every recipe at the item's
    // pricePerBaseUnit, so if the invoice price matches the current spine there is
    // nothing to acknowledge — even when this supplier's stored offer is stale.
    // (Comparing against the offer instead let a bad/stale offerPPB raise a phantom
    // "Price ↑ 0%" alert while the spine — and the displayed pct — were unchanged.)
    if (Math.abs(norm.pctDiff) <= 15) return false
    // Spine moved >15%, but suppress the ack when the move is purely a supplier
    // switch: THIS supplier's own last $/base is flat (≤3%), so the spine jump came
    // from a different supplier. The SupplierSwitchNote covers this case instead.
    const offer = ref ? offerForSupplier(item, ref) : null
    const offerPPB = offer ? offerPricePerBase(offer) : 0
    if (offerPPB > 0 && Math.abs(((norm.invoicePPB - offerPPB) / offerPPB) * 100) <= 3) return false
    return true
  }
  return hasPriceChange(item, 15)
}

// Which issue badges a line currently shows, and whether each is resolved.
// `sessionSupplier` scopes the big-price check to the invoice's supplier —
// pass it wherever the session is in scope so the card and the approve gate agree.
export function lineIssues(item: ScanItem, opts: ResolveOpts, sessionSupplier?: SupplierRef | null): Array<{ kind: IssueKind; resolved: boolean }> {
  if (isCharge(item)) return []
  const out: Array<{ kind: IssueKind; resolved: boolean }> = []

  // New SKU / needs link — only resolvable by linking, creating, or skipping
  // (all of which make isUnlinked() false), so while present it is unresolved.
  if (isUnlinked(item)) out.push({ kind: 'sku', resolved: false })

  // Dimension conflict — the invoice line's dimension differs from the linked
  // item's (e.g. $/kg priced onto an each item). Terminal/unresolvable: it can
  // only be cleared by re-linking, so it always blocks approve.
  if (hasDimensionConflict(item)) out.push({ kind: 'conflict', resolved: false })

  // Big price change — resolved once acknowledged.
  if (isBigPriceChange(item, sessionSupplier)) out.push({ kind: 'price', resolved: opts.priceAck })

  // Low-trust line — resolved once the user confirms it looks right.
  if (needsTrustCheck(item)) out.push({ kind: 'conf', resolved: opts.confAck })

  return out
}

// True when a line still has at least one issue awaiting a decision.
export function lineUnresolved(item: ScanItem, opts: ResolveOpts, sessionSupplier?: SupplierRef | null): boolean {
  // A math check is a hard blocker even though it has no badge of its own.
  if (!isCharge(item) && hasMathCheck(item)) return true
  // An unbalanced RC split blocks approval until the quantities reconcile.
  if (!isCharge(item) && hasInvalidRcSplit(item)) return true
  return lineIssues(item, opts, sessionSupplier).some(i => !i.resolved)
}
