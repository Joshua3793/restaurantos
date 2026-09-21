// Approve-time format decisions for an invoice line. Pure, so the one place
// that can silently corrupt every recipe cost is unit-testable.
// (spec 2026-09-20-item-consolidation)

import { type ChainItem, type PackLink, type Pricing, basePerPurchase, pricePerBaseUnit } from '@/lib/item-model'
import type { OfferFormat } from '@/lib/invoice/line-format'
import type { ReceivedVia } from '@/lib/invoice/line-qty'

/**
 * Price a line by WEIGHT or by CASE? It follows how the line was RECEIVED, which
 * line-first receiving has already decided with proof (the line's own money):
 *  • received by weight (`billed-weight` / `shipped-unit`) → WEIGHT, whatever the
 *    item is. Quantity × price then equals the line total by construction.
 *  • otherwise the old rule: a per-weight line → WEIGHT, EXCEPT on an item with an
 *    each-measure, where a printed weight is the SIZE of one each (Brioche
 *    "8 × 1100 g" per case), not the quantity sold → CASE.
 */
export function pricingBasisFor(a: { via: ReceivedVia; ocrPerWeight: boolean; itemHasEachMeasure: boolean }): 'WEIGHT' | 'CASE' {
  if (a.via === 'billed-weight' || a.via === 'shipped-unit') return 'WEIGHT'
  return a.ocrPerWeight && !a.itemHasEachMeasure ? 'WEIGHT' : 'CASE'
}

/**
 * What an invoice line's PRINTED pack should be checked against at approve.
 *
 * The pack guard exists because a supplier moving a 3 kg tub to a 20 kg case
 * makes the printed case price wrong over the stale chain by exactly that ratio
 * (Baking Powder: $37.61/kg instead of $5.64/kg). But the item's own chain is
 * only the PRIMARY supplier's pack — checking every line against it punished
 * every OTHER supplier for the crime of selling a different case, which is how
 * one product ended up duplicated per supplier.
 *
 * So the reference is THIS supplier's previous pack:
 *  - this supplier already has an offer with a usable chain → compare against it;
 *  - a supplier NEVER SEEN on this item (no offer row at all) while the item does
 *    have offers → there is nothing to compare against, so the guard stays silent
 *    and the line's pack simply becomes this supplier's offer;
 *  - anything else — an item with no offers at all, or an offer row that exists
 *    but carries no usable chain — falls back to the item's chain, which is the
 *    pre-branch behaviour.
 *
 * That last case is load-bearing and is why the silence is keyed on `lineOffer ==
 * null` rather than on "we failed to read a pack". An offer row with an empty or
 * broken chain is not evidence that this supplier is new; for the PRIMARY supplier
 * the item's chain IS their pack (primary-offer.ts keeps the two in sync), so
 * going silent there would let a changed pack write a case price over a stale
 * chain again — the Baking-Powder corruption ($37.61/kg instead of $5.64/kg).
 */
export function packReference(
  itemChain: PackLink[], lineOffer: OfferFormat | null, itemHasOffers: boolean,
): { baseTotal: number; against: 'offer' | 'item' } | null {
  const offerChain = Array.isArray(lineOffer?.packChain) ? (lineOffer!.packChain as PackLink[]) : []
  const offerTotal = offerChain.length ? basePerPurchase(offerChain) : 0
  if (offerTotal > 0) return { baseTotal: offerTotal, against: 'offer' }
  if (lineOffer == null && itemHasOffers) return null
  const itemTotal = basePerPurchase(itemChain)
  return itemTotal > 0 ? { baseTotal: itemTotal, against: 'item' } : null
}

/**
 * $/base implied by a CASE-priced line, divided by the pack the line is
 * RECORDED under — `speaks` is `resolveLineFormat(item, thisSupplier'sOffer)`:
 * the supplier's own chain when it has one, else the item's.
 *
 * Deliberately NOT the invoice's own printed pack. This number is compared with
 * the item's current ppb to raise the PriceAlert, and it must therefore sit on
 * the same basis as the spine write, which stores `pricing` over the item's
 * (== the primary offer's) chain. Dividing by the printed pack instead would
 * make the alert's % disagree with the price actually written whenever OCR's
 * pack differs from the stored one but stays inside the guard's tolerance.
 *
 * `pricing.mode` is forced to PACK: the caller only reaches this on a per-case
 * line, and an offer carrying a stale RATE must not hijack the denominator.
 */
export function casePricePerBase(speaks: ChainItem, casePrice: number): number {
  return pricePerBaseUnit({ ...speaks, pricing: { mode: 'PACK', purchasePrice: casePrice } })
}

/**
 * The format a line's RECEIPT must be frozen through: the pack it speaks, plus
 * the pricing THIS approval is about to write.
 *
 * `lineReceivedBaseUnits` branches on `pricing.mode` — RATE means the billed
 * quantity IS a measured amount, PACK means it is a count of containers to
 * expand. `speaks` carries the PRE-write mode (the item's, or this supplier's
 * previous offer's), which is the wrong one exactly when the invoice changes it:
 * a supplier's FIRST per-weight invoice on a case-priced item has no offer to
 * borrow a RATE from, so "18.4 KG" was expanded as 18.4 CASES — 166,924 g frozen
 * for an 18.4 kg delivery. The mode the line resolved to is the one the item and
 * the offer both end up storing, so freeze through it.
 *
 * A no-op whenever the modes already agree, which is the common case.
 */
export function freezeFormat(speaks: ChainItem, newPricing: Pricing): ChainItem {
  return { ...speaks, pricing: newPricing }
}

