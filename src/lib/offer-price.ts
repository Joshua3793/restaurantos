// Pure pricing for a supplier offer, priced WITH its item. An
// `InventorySupplierPrice` row stores only its own packChain + pricing — no
// dimension, no baseUnit, no bridges. A $/lb RATE offer on an `each` item is only
// priceable through the ITEM's each-measure, so the item is a required argument:
// omitting it is exactly the bug that made 56 live offers read $0 once the price
// formula became dimension-aware (Task 1).
//
// Pure + client-safe (imports only ./item-model, which imports only ./utils) so
// `src/lib/invoice/resolution.ts` — imported by 'use client' review-UI components
// — can import this file directly instead of pulling in `supplier-offers.ts`,
// which imports the Prisma singleton at module top.

import { pricePerBaseUnit as chainPpb, asChainItem, dimensionOf } from './item-model'

/** The item's own facts, with the offer's chain + pricing standing in for its
 *  pricing. The ONE place an offer's price meets the item's base unit + bridges. */
const pricedWithItem = (offer: { packChain?: unknown; pricing?: unknown }, item: OfferItem) => chainPpb(asChainItem({
  dimension: item.dimension ?? dimensionOf(item.baseUnit ?? 'each'),
  baseUnit:  item.baseUnit ?? 'each',
  packChain: offer.packChain,
  pricing:   offer.pricing,
  eachMeasureQty: item.eachMeasureQty, eachMeasureUnit: item.eachMeasureUnit ?? null, densityGPerMl: item.densityGPerMl,
}))

/**
 * The item facts a supplier offer needs in order to be priced: the base unit
 * every offer's $/base is expressed in, and the bridges (each-measure, density)
 * that let a cross-dimension RATE offer be expressed against it. A row shape, so
 * callers can pass a Prisma `InventoryItem` row or the client's `InventoryMatch`
 * directly — `dimension` is optional because `InventoryMatch.dimension` is
 * optional; when omitted it is derived from `baseUnit` below, so a caller can
 * never reintroduce the $0 bug by leaving it out.
 */
export interface OfferItem {
  dimension?: string
  baseUnit: string | null
  eachMeasureQty?: unknown
  eachMeasureUnit?: string | null
  densityGPerMl?: unknown
}

/**
 * An offer's price-per-base-unit, derived from its OWN pack chain + pricing but
 * priced against the ITEM's base unit and bridges.
 *  • PACK offer            → purchasePrice ÷ product of the chain's `per` — the
 *                            item is irrelevant (unchanged from before Task 1).
 *  • same-dimension RATE   → rate ÷ conv(rateUnit) — unchanged from before Task 1.
 *  • cross-dimension RATE  → priced only through the item's each-measure /
 *                            density; 0 ("unpriced") when the item has no bridge.
 *  • no chain              → 0 ("unpriced"), as before.
 */
export function offerPricePerBase(offer: { packChain?: unknown; pricing?: unknown }, item: OfferItem): number {
  const chain = Array.isArray(offer.packChain) ? offer.packChain : null
  const pricing = offer.pricing && typeof offer.pricing === 'object' ? offer.pricing : null
  if (!chain || !chain.length || !pricing) return 0 // no chain ⇒ unpriced offer

  // The offer supplies the pack and the price; the ITEM supplies the base unit and
  // the bridges. A $/lb offer on an `each` item is only priceable through the
  // item's each-measure — which is why the item is a required argument.
  return pricedWithItem({ packChain: chain, pricing }, item)
}

/**
 * The $/base an item takes on when it ADOPTS `primary` as its spine
 * (`syncPrimaryOfferToItem`). Same formula, same bridges — a separate export only
 * because the adoption path must keep one pre-existing edge semantics that
 * `offerPricePerBase` deliberately tightened: an offer row whose `packChain` is
 * present but EMPTY is still priced (it is `basePerPurchase([]) === 1`), because
 * the spine write's only refusal has always been a non-positive ppb, and turning
 * one of those rows into "unpriced" here would change a stored number.
 *
 * Pricing it WITHOUT the item's bridges is the trap this exists to close: a
 * bridged `$/lb` primary reads 0, and the caller's "never write a zero ppb" guard
 * then makes the sync a PERMANENT SILENT NO-OP — the item keeps a stale price for
 * ever, with nothing logged.
 */
export function primaryOfferPpb(primary: { packChain?: unknown; pricing?: unknown }, item: OfferItem): number {
  return pricedWithItem(primary, item)
}
