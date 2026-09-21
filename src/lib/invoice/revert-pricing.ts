// Rolling an item's price back when an APPROVED invoice session is deleted.
// Pure, because the two DELETE routes (bulk + single) must revert identically
// and neither has a test harness of its own.
//
// What the rollback has to work with:
//  • `InvoiceScanItem.previousPrice` — a bare NUMBER, captured at MATCH time as
//    `offer.lastPrice ?? item.purchasePrice` (invoice-matcher.ts). It is
//    therefore the price in whatever denomination that source used: a per-case
//    price for a pack-priced item/offer, a $/kg rate for a rate-priced one.
//    Nothing records WHICH.
//  • the item as it is NOW — post-approve `pricing`, but its pack chain and
//    bridges untouched (an invoice never rewrites a format).
//  • the session's own `PriceAlert` rows — `previousPrice` there is the item's
//    exact PRE-approve $/base unit, frozen by the approve that is being undone.
//    Only written when the move was ≥ 15 %, so it is proof when present, absent
//    otherwise. That is the only pre-approve state this schema persists.
//
// The bug this exists to fix: the old inline revert read the item's POST-approve
// pricing MODE and poured `previousPrice` into it. Once approve could turn a
// `PACK $4.99` each-item into `RATE $15.98/lb` (Cilantro), the rollback wrote
// `RATE $4.99/lb` = $1.50/each — a third price the item never had.

import {
  type ChainItem, type PackLink, type Pricing,
  asChainItem, basePerPurchase, pricePerBaseUnit,
} from '@/lib/item-model'
import { rateCrossesItemDimension } from '@/lib/invoice/approve-format'

export type RevertBasis =
  /** The item is pack-priced: `previousPrice` is that pack price. Unchanged. */
  | 'pack'
  /** A rate in the item's OWN dimension: `previousPrice` is that rate. Unchanged. */
  | 'rate-same-dimension'
  /** Cross-dimension rate + the alert proves the pre-state was a pack price. */
  | 'cross-rate-proven-pack'
  /** Cross-dimension rate + the alert proves the pre-state was this rate shape. */
  | 'cross-rate-proven-rate'
  /** Cross-dimension rate + an alert that neither candidate reproduces — restore
   *  the proven $/base itself (previousPrice came from an offer on a third basis). */
  | 'cross-rate-restored-ppb'
  /** No alert ⇒ the price moved < 15 %; only the pack reading lands there. */
  | 'cross-rate-nearest-pack'
  /** No alert ⇒ the price moved < 15 %; only the rate reading lands there (a
   *  SECOND weight invoice on an already rate-priced item). */
  | 'cross-rate-nearest-rate'
  /** Nothing decides — assume the pack price a weight approve converts FROM. */
  | 'cross-rate-assumed-pack'

/** The item row the revert reads: Prisma JSON columns, bridges included. */
export interface RevertItemRow {
  dimension?: string | null
  baseUnit?: string | null
  packChain?: unknown
  pricing?: unknown
  eachMeasureQty?: unknown
  eachMeasureUnit?: string | null
  densityGPerMl?: unknown
}

/**
 * Item id → the item's $/base BEFORE this session touched it, read off the
 * session's own PriceAlert rows (`previousPrice` there is `oldPpb`). First alert
 * wins: a session can re-price one item on several lines, and only the first
 * quotes the pre-session price. Prisma Decimal arrives as a string.
 */
export function priorPpbFromAlerts(
  alerts: ReadonlyArray<{ inventoryItemId: string; previousPrice: unknown }>,
): Map<string, number> {
  const byItem = new Map<string, number>()
  for (const a of alerts ?? []) {
    if (byItem.has(a.inventoryItemId)) continue
    const ppb = Number(a.previousPrice)
    if (Number.isFinite(ppb) && ppb > 0) byItem.set(a.inventoryItemId, ppb)
  }
  return byItem
}

const near = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.abs(b) * 1e-4

/**
 * The `pricing` (and the legacy headline `purchasePrice`) an item should be
 * rolled back to.
 *
 * Same-dimension shapes keep TODAY's behaviour byte for byte — every live item
 * is one of those, so a rollback's number can only change for an item carrying a
 * cross-dimension rate, which only a weight-basis approve on this branch can
 * write.
 *
 * For that one shape the pre-approve state is not recorded anywhere, so the two
 * readings of `previousPrice` — a pack price over the item's chain, or a rate in
 * the unit the item now carries — are told apart by what IS recorded:
 *  1. the session's PriceAlert froze the exact pre-approve $/base: take the
 *     reading that reproduces it. That is proof, not a guess. If neither does
 *     (the matcher took `previousPrice` off a supplier OFFER whose basis differs
 *     from the item's), restore that $/base itself over the untouched chain;
 *  2. NO alert, on a line that did re-price, means the approve measured a move
 *     of less than 15 % (that is the only reason it stayed silent) — so the
 *     pre-approve $/base sat within 15 % of the price the item carries now.
 *     Exactly one reading normally lands there, and it wins; the other is out by
 *     the bridge factor (Cilantro: $4.99 vs $1.50 per each).
 *  3. nothing decides → the pack price, the state a weight-basis approve
 *     converts FROM. See the report for what that can still get wrong.
 */
export function revertedPricing(a: {
  previousPrice: number
  item: RevertItemRow
  /** The item's pre-approve $/base, from this session's PriceAlert. */
  priorPpb?: number | null
}): { pricing: Pricing; purchasePrice: number; basis: RevertBasis } {
  const prev = Number(a.previousPrice)
  const item: ChainItem = asChainItem({
    dimension: (a.item.dimension ?? '') as string,
    baseUnit: a.item.baseUnit ?? '',
    packChain: a.item.packChain,
    pricing: a.item.pricing,
    eachMeasureQty: a.item.eachMeasureQty,
    eachMeasureUnit: a.item.eachMeasureUnit ?? null,
    densityGPerMl: a.item.densityGPerMl,
  })
  const pack = (p: number) => ({
    pricing: { mode: 'PACK', purchasePrice: p } as Pricing,
    purchasePrice: p,
  })

  const current = a.item.pricing as { mode?: string; rateUnit?: string } | null
  if (current?.mode !== 'RATE') return { ...pack(prev), basis: 'pack' }

  const rateUnit = current.rateUnit || a.item.baseUnit || 'each'
  const rate = (r: number) => ({
    pricing: { mode: 'RATE', rate: r, rateUnit } as Pricing,
    purchasePrice: r,
  })
  if (!rateCrossesItemDimension(rateUnit, a.item)) return { ...rate(prev), basis: 'rate-same-dimension' }

  // ── Cross-dimension rate: only a weight-basis approve writes this shape ──
  const ppbOf = (pricing: Pricing) => pricePerBaseUnit({ ...item, pricing })
  const asPack = ppbOf(pack(prev).pricing)
  const asRate = ppbOf(rate(prev).pricing)

  const proof = a.priorPpb != null ? Number(a.priorPpb) : NaN
  if (Number.isFinite(proof) && proof > 0) {
    if (near(asPack, proof)) return { ...pack(prev), basis: 'cross-rate-proven-pack' }
    if (near(asRate, proof)) return { ...rate(prev), basis: 'cross-rate-proven-rate' }
    const per = basePerPurchase((item.packChain as PackLink[]) ?? [])
    if (per > 0 && Number.isFinite(per)) return { ...pack(proof * per), basis: 'cross-rate-restored-ppb' }
  }

  // No alert ⇒ the approve measured a move under ALERT_THRESHOLD, so the
  // pre-approve $/base is within that band of the item's CURRENT $/base. The
  // reading that lands in the band is the one the item actually had; the other
  // is out by the bridge factor. A little slack over the 15 % the approve tests,
  // for rounding and for a price that moved the other way.
  const now = pricePerBaseUnit(item)
  if (now > 0) {
    const off = (p: number) => (p > 0 ? Math.abs(p - now) / now : Infinity)
    const packOff = off(asPack), rateOff = off(asRate)
    const inBand = (d: number) => d <= 0.2
    if (inBand(packOff) && packOff <= rateOff) return { ...pack(prev), basis: 'cross-rate-nearest-pack' }
    if (inBand(rateOff)) return { ...rate(prev), basis: 'cross-rate-nearest-rate' }
  }
  return { ...pack(prev), basis: 'cross-rate-assumed-pack' }
}
