// Approve-time format decisions for an invoice line. Pure, so the one place
// that can silently corrupt every recipe cost is unit-testable.
// (spec 2026-09-20-item-consolidation)

import {
  type ChainItem, type Dimension, type PackLink, type Pricing,
  basePerPurchase, dimensionOf, pricePerBaseUnit, ratePerBase,
} from '@/lib/item-model'
import { canonicalUom, UNIT_FACTORS } from '@/lib/uom'
import type { OfferFormat } from '@/lib/invoice/line-format'
import type { ReceivedVia } from '@/lib/invoice/line-qty'

/** A row-shaped item: `dimension` is a plain string at runtime whatever the type
 *  says (Prisma rows, hand-built ChainItems), and can be absent entirely. */
export interface ItemDims { dimension?: string | null; baseUnit?: string | null }

/**
 * The item's dimension — or null when it is genuinely UNKNOWN. Mirrors the
 * private `itemDimension` in item-model.ts (the spine's own rule): normalise the
 * stored string, else derive it from the base unit, else give up. Unknown must
 * NOT read as "another dimension" — that is what priced 56 live offers at $0.
 */
export function itemDimensionOf(item: ItemDims): Dimension | null {
  const d = String(item?.dimension ?? '').trim().toUpperCase()
  if (d === 'MASS' || d === 'VOLUME' || d === 'COUNT') return d
  return item?.baseUnit ? dimensionOf(item.baseUnit) : null
}

/**
 * Is a price quoted per `rateUnit` denominated in a DIFFERENT dimension than the
 * item it is about to be written onto ($/lb on an item counted in `each`)? That
 * shape can only be produced by a weight-basis approve through the item's own
 * bridge — which is exactly why both the offer-chain decision below and the
 * DELETE rollback (invoice/revert-pricing.ts) key off it.
 *
 * An item with no resolvable dimension is NOT cross-dimension (see above).
 */
export function rateCrossesItemDimension(rateUnit: string | null | undefined, item: ItemDims): boolean {
  const id = itemDimensionOf(item)
  if (id === null || !rateUnit) return false
  return dimensionOf(rateUnit) !== id
}

/** A weight/volume unit the canonical table knows — never a count or container. */
function isMeasureUnit(u: string | null | undefined): boolean {
  if (!u || !u.trim()) return false
  const f = UNIT_FACTORS[canonicalUom(u)]
  return !!f && f.dim !== 'count'
}

const moneyAgrees = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.02)

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
 * Is this line's printed "pack" really the QUANTITY SOLD rather than a pack?
 *
 * On a weight-priced line the pack columns often carry the delivery itself —
 * `1 × 12 lb`. Building an offer chain from that mints "5,443 each per case" on
 * an item whose case holds 24, which lands on the ITEM the moment a human makes
 * that offer primary. So such a line keeps the chain we already hold and stores
 * only its RATE over it; the printed format survives in the provenance triple.
 *
 * But ONLY when the rate crosses the item's dimension. The first cut of this
 * ("UOM mode on any item carrying an each-measure") also caught a MASS item that
 * merely has a count↔weight bridge configured — Sausage, billed $15.95/kg on an
 * item based in `g`. There the printed pack IS a pack in the item's own units,
 * and freezing the chain stopped that offer's format from ever refreshing (and,
 * with no offer chain and an empty item chain, stored a chain that reads $0).
 */
export function packIsTheQuantity(a: { isUomMode: boolean; rateUnit: string; item: ItemDims }): boolean {
  return a.isUomMode && rateCrossesItemDimension(a.rateUnit, a.item)
}

/**
 * An offer chain that can actually be priced. `offerPricePerBase` reads an EMPTY
 * chain as "unpriced" ⇒ $0 whatever the pricing says, so a RATE offer stored
 * over one is invisible to every cross-supplier comparison. One nominal
 * container stands in: with RATE pricing the chain is not a divisor, it only has
 * to exist — and it matches what the item's own empty chain already prices as
 * (`basePerPurchase([]) === 1`), so `packReference` reads the same number it
 * reads today.
 *
 * A chain whose links are BROKEN (`per: 0`) is deliberately left alone: it still
 * prices a RATE correctly (the chain is unused), while replacing it would make
 * `packReference` compare the next invoice's pack against an invented one
 * container and skip the line.
 */
export function nonEmptyOfferChain(chain: PackLink[] | null | undefined, topUnit: string): PackLink[] {
  return Array.isArray(chain) && chain.length > 0 ? chain : [{ unit: topUnit?.trim() || 'case', per: 1 }]
}

/**
 * The rate a WEIGHT-basis line is really priced at, per `rateUnit`.
 *
 * `scanItem.rate` is whatever OCR read out of a "price" column, and its unit is
 * `rateUOM`. Now that a line received by weight is PRICED by weight, a line
 * carrying `rate 41.88 / rateUOM 'CS'` (a per-CASE price) would be written as
 * $41.88 per POUND. So the printed rate is trusted only when:
 *  • its `rateUOM` is a weight/volume unit — it is a rate, by its own label; or
 *  • it carries no unit at all AND rate × the received weight reproduces the
 *    line total, which is the same proof `billedWeightIsPriced` uses.
 * Otherwise the rate is DERIVED from the money that is not in doubt:
 * `lineTotal ÷ received weight`, which makes `received × $/base = lineTotal`
 * true by construction. With nothing to divide (no total, or a rate unit this
 * item has no bridge to) the caller's own value stands — the dimension guard
 * downstream is what refuses those.
 */
export function weightBasisRate(a: {
  rate: number | null | undefined
  rateUOM: string | null | undefined
  rawLineTotal: number | null | undefined
  /** Base units the line delivered (`lineReceived(...).base`). */
  receivedBase: number
  /** The unit the rate will be stored per — already resolved by the caller. */
  rateUnit: string
  item: Pick<ChainItem, 'dimension' | 'baseUnit' | 'eachMeasure' | 'densityGPerMl'>
  /** What the caller would otherwise write. */
  fallback: number
}): { rate: number; source: 'printed' | 'reconciled' | 'derived' | 'fallback' } {
  // $/base for a rate of exactly 1 per rateUnit == 1 ÷ (base units in one
  // rateUnit) — the spine's own bridge, so the quantity below is expressed
  // exactly as `ratePerBase` will read it back.
  const perOne = ratePerBase(1, a.rateUnit, a.item)
  const received = Number(a.receivedBase)
  const qtyInRateUnit = received > 0 && perOne > 0 ? received * perOne : 0
  const total = Number(a.rawLineTotal)
  const printed = Number(a.rate)
  const derived = qtyInRateUnit > 0 && total > 0 ? total / qtyInRateUnit : 0

  if (Number.isFinite(printed) && printed > 0) {
    if (isMeasureUnit(a.rateUOM)) return { rate: printed, source: 'printed' }
    if (!a.rateUOM?.trim() && derived > 0 && moneyAgrees(printed * qtyInRateUnit, total))
      return { rate: printed, source: 'reconciled' }
  }
  if (derived > 0) return { rate: derived, source: 'derived' }
  return { rate: a.fallback, source: 'fallback' }
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

