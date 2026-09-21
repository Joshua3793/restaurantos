// Approve-time format decisions for an invoice line. Pure, so the one place
// that can silently corrupt every recipe cost is unit-testable.
// (spec 2026-09-20-item-consolidation)

import { type ChainItem, type PackLink, type Pricing, basePerPurchase, pricePerBaseUnit } from '@/lib/item-model'
import type { OfferFormat } from '@/lib/invoice/line-format'

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
 *  - this supplier already has an offer → compare against its chain;
 *  - a new supplier on an item that already has offers → there is nothing to
 *    compare against, so the guard stays silent and the line's pack simply
 *    becomes this supplier's offer;
 *  - an item with no offers at all → the item's chain IS its only pack, so keep
 *    today's behaviour exactly.
 */
export function packReference(
  itemChain: PackLink[], lineOffer: OfferFormat | null, itemHasOffers: boolean,
): { baseTotal: number; against: 'offer' | 'item' } | null {
  const offerChain = Array.isArray(lineOffer?.packChain) ? (lineOffer!.packChain as PackLink[]) : []
  const offerTotal = offerChain.length ? basePerPurchase(offerChain) : 0
  if (offerTotal > 0) return { baseTotal: offerTotal, against: 'offer' }
  if (itemHasOffers) return null
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

