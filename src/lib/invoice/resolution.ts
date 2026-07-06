// Issue-resolution model for the redesigned invoice drawer.
// The mock groups every problem on a line into `.issue` blocks, each ending in a
// decision. The progress bar ("X of N resolved"), the per-issue rendering, and
// the Approve-gate all read from these helpers so they never disagree.

import type { ScanItem } from '@/components/invoices/types'
import {
  isUnlinked, hasMathCheck, hasPriceChange,
  needsTrustCheck, derivePricingMode,
} from './predicates'
import { classifyDimensionRelationship } from './classify'
import { computeNormalisedPrices, computeLineMath } from './calculations'
import { offerPricePerBase } from '@/lib/supplier-offers'
import { lineReceivedCountQty } from '@/lib/invoice/line-qty'
import { formatCurrency } from '@/lib/invoice/formatters'
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

// ── Live reasons — the ONE source of truth for "why this line needs attention" ─
// Every reason a line is flagged, in plain English, recomputed from current state.
// `title` is the short headline (badge / strip row); `summary` is the one-line
// explanation with live values. The attention strip, the issue badges, the
// progress bar, and the Approve-gate all derive from this list so they can never
// disagree — and so a line with several problems shows each one, resolving them
// independently as the user fixes each.
export interface LineReason {
  kind: IssueKind
  /** Short headline, e.g. "Line math $2.40 off" or "Price ↑ 32%". */
  title: string
  /** Plain-English explanation with live values. */
  summary: string
  /** False while the reason still needs a decision. */
  resolved: boolean
}

// Format a scanned quantity compactly (drop trailing zeros: 12, 2.5, 0.75).
const fmtQty = (v: unknown): string => {
  const n = Number(v)
  if (!Number.isFinite(n)) return '?'
  return String(Math.round(n * 1000) / 1000)
}

export function lineReasons(item: ScanItem, opts: ResolveOpts, sessionSupplier?: SupplierRef | null): LineReason[] {
  if (isCharge(item)) return []
  const out: LineReason[] = []
  const itemName = item.matchedItem?.itemName ?? item.rawDescription ?? 'this line'

  // New SKU / needs link — only resolvable by linking, creating, or skipping
  // (all of which make isUnlinked() false), so while present it is unresolved.
  if (isUnlinked(item)) {
    out.push({
      kind: 'sku',
      title: 'Not linked',
      summary: `“${item.rawDescription ?? 'This line'}” isn’t linked to an inventory item yet — link, create, or skip it.`,
      resolved: false,
    })
  }

  // Dimension relationship — either a hard conflict (re-link required) or a
  // recoverable bridge (set a density/eachMeasure factor to resolve).
  if (item.matchedItem) {
    const verdict = classifyDimensionRelationship(item).verdict
    if (verdict === 'TRUE_CONFLICT') {
      out.push({
        kind: 'conflict',
        title: 'Dimension conflict',
        summary: `Billed by a different measure than “${itemName}” is tracked in — link the right item.`,
        resolved: false,
      })
    } else if (verdict === 'DENSITY_BRIDGE' || verdict === 'PACK_BRIDGE') {
      out.push({
        kind: 'bridge',
        title: 'Needs a unit bridge',
        summary: `The invoice units don’t line up with “${itemName}” — confirm the bridge so it can be costed.`,
        resolved: false,
      })
    }
  }

  // Line math — computed qty × price doesn't reconcile to the scanned line total.
  // A hard blocker (the numbers must agree before a price can be trusted), now a
  // first-class reason instead of a silent one buried in the math zone.
  if (hasMathCheck(item)) {
    const math = computeLineMath(item)
    if (math) {
      const eq = derivePricingMode(item) === 'per_weight'
        ? `${fmtQty(item.totalQty)} × ${formatCurrency(Number(item.rate))} = ${formatCurrency(math.computed)}`
        : `${fmtQty(item.rawQty)} × ${formatCurrency(Number(item.rawUnitPrice))} = ${formatCurrency(math.computed)}`
      out.push({
        kind: 'math',
        title: `Line math ${formatCurrency(Math.abs(math.delta))} off`,
        summary: `${eq}, but the invoice line total reads ${formatCurrency(math.entered)}. Fix the scanned numbers so they reconcile.`,
        resolved: false,
      })
    }
  }

  // Big price change — resolved once acknowledged.
  if (isBigPriceChange(item, sessionSupplier)) {
    const norm = computeNormalisedPrices(item)
    const pct = norm ? norm.pctDiff : Number(item.priceDiffPct ?? 0)
    out.push({
      kind: 'price',
      title: `Price ${pct > 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(0)}%`,
      summary: `Cost moved ${Math.abs(pct).toFixed(0)}% from the last price — approving re-costs every recipe that uses it.`,
      resolved: opts.priceAck,
    })
  }

  // Low-trust line — resolved once the user confirms it looks right.
  if (needsTrustCheck(item)) {
    out.push({
      kind: 'conf',
      title: 'Check line',
      summary: item.ocrConfidence === 'low'
        ? 'The scanner wasn’t fully confident reading this line — confirm it looks right.'
        : 'Matched by description similarity only — confirm it’s the right product.',
      resolved: opts.confAck,
    })
  }

  // Unbalanced RC split — blocks approval until the quantities reconcile.
  if (hasInvalidRcSplit(item)) {
    out.push({
      kind: 'rcsplit',
      title: 'Split doesn’t balance',
      summary: 'The revenue-center split doesn’t add up to the received quantity.',
      resolved: false,
    })
  }

  return out
}

// Which issue badges a line currently shows, and whether each is resolved.
// `sessionSupplier` scopes the big-price check to the invoice's supplier —
// pass it wherever the session is in scope so the card and the approve gate agree.
export function lineIssues(item: ScanItem, opts: ResolveOpts, sessionSupplier?: SupplierRef | null): Array<{ kind: IssueKind; resolved: boolean }> {
  return lineReasons(item, opts, sessionSupplier).map(r => ({ kind: r.kind, resolved: r.resolved }))
}

// True when a line still has at least one issue awaiting a decision.
export function lineUnresolved(item: ScanItem, opts: ResolveOpts, sessionSupplier?: SupplierRef | null): boolean {
  return lineReasons(item, opts, sessionSupplier).some(r => !r.resolved)
}
