// Which pack format does an invoice line speak? An item with several suppliers
// has several packs; the item's own chain is only the PRIMARY supplier's. Reading
// every line through the item's chain is what forced a second item per supplier
// (spec 2026-09-20-item-consolidation). Pure + client-safe.

import { type ChainItem, type PackLink, type Pricing, basePerPurchase, rateIsCostable, pricePerBaseUnit } from '@/lib/item-model'

/** The slice of an InventorySupplierPrice row this module reads. */
export interface OfferFormat {
  supplierId?: string | null
  supplierName?: string | null
  /** this supplier's SKU for the product the offer describes */
  supplierItemCode?: string | null
  isPrimary?: boolean | null
  packChain?: unknown
  pricing?: unknown
}

export interface SupplierRef {
  supplierId?: string | null
  supplierName?: string | null
  /** Supplier.name — offers are stored under it; sessions may carry an OCR variant. */
  canonicalName?: string | null
  /** The line's SKU. One supplier can sell an item as several products (a
   *  merged "Mushrooms Mix" is six Sysco SKUs, each its own box), so the SKU
   *  picks WHICH of that supplier's offers the line speaks. */
  itemCode?: string | null
}

/** SKUs compare trimmed and case-blind; blank is "no SKU". */
export function normItemCode(code: string | null | undefined): string {
  return (code ?? '').trim().toUpperCase()
}

/** Every offer belonging to a line's supplier. supplierId is the reliable join,
 *  then the canonical name, then the raw (OCR) name — the first key that finds
 *  any rows wins, so one supplier's rows are never mixed with another's. */
export function supplierOffers<T extends OfferFormat>(offers: T[] | null | undefined, ref: SupplierRef): T[] {
  if (!offers?.length) return []
  if (ref.supplierId) {
    const byId = offers.filter(o => o.supplierId === ref.supplierId)
    if (byId.length) return byId
  }
  for (const name of [ref.canonicalName, ref.supplierName]) {
    if (!name) continue
    const byName = offers.filter(o => o.supplierName === name)
    if (byName.length) return byName
  }
  return []
}

/**
 * The offer a line speaks. A supplier usually has one offer per item, but a
 * merged item keeps one per SKU (each with its own box), so:
 *   1. the offer carrying the line's SKU;
 *   2. else one of this supplier's offers with no SKU recorded (legacy row);
 *   3. else, when the supplier has exactly one offer, that one — the same
 *      product under a new SKU (a supplier re-coding an item is routine);
 *   4. else null — a SKU this item has never had from this supplier is a new
 *      product whose pack becomes its own offer.
 * A line with no SKU reads the supplier's primary offer, else its first.
 */
export function pickOffer<T extends OfferFormat>(offers: T[] | null | undefined, ref: SupplierRef): T | null {
  const mine = supplierOffers(offers, ref)
  if (mine.length === 0) return null
  const code = normItemCode(ref.itemCode)
  if (!code) return mine.find(o => o.isPrimary) ?? mine[0]
  const exact = mine.find(o => normItemCode(o.supplierItemCode) === code)
  if (exact) return exact
  const uncoded = mine.find(o => !normItemCode(o.supplierItemCode))
  if (uncoded) return uncoded
  return mine.length === 1 ? mine[0] : null
}

/** Beyond this factor an offer's $/base vs the item's is data corruption, not a price difference. */
export const IMPLAUSIBLE_PRICE_RATIO = 20

/**
 * The ChainItem a line should be received/priced through: the supplier offer's
 * chain when it has a usable one (else the item unchanged), and the offer's pricing
 * only when its price is a finite number > 0 (else the item's pricing — never a
 * silent $0) and within IMPLAUSIBLE_PRICE_RATIO of the item's own $/base. Base unit
 * and bridges always stay the item's.
 * (A pack PRINTED on the line still wins — that rule lives inside lineReceivedBaseUnits.)
 */
export function resolveLineFormat(item: ChainItem, offer: OfferFormat | null | undefined): ChainItem {
  const chain = Array.isArray(offer?.packChain) ? (offer!.packChain as PackLink[]) : []
  if (chain.length === 0 || !(basePerPurchase(chain) > 0)) return item

  const p = offer?.pricing as Pricing | null | undefined
  const usable = (v: unknown) => Number.isFinite(Number(v)) && Number(v) > 0
  const packOk = p?.mode === 'PACK' && usable(p.purchasePrice)
  const rateOk = p?.mode === 'RATE' && usable(p.rate) && !!p.rateUnit && rateIsCostable(p.rateUnit, item)
  if (!packOk && !rateOk) return { ...item, packChain: chain }

  // Suppliers legitimately differ in price, but not by orders of magnitude: an
  // offer more than IMPLAUSIBLE_PRICE_RATIO x off the item's own $/base is a
  // corrupt row (a rate stored per g instead of per kg, a per-lb price stored as a
  // case price). Trusting it mis-reads a unit-less billed weight by the same
  // factor, so keep the item's pricing. An unpriced item cannot judge.
  const adopted: ChainItem = { ...item, packChain: chain, pricing: p as Pricing }
  const own = pricePerBaseUnit(item)
  const theirs = pricePerBaseUnit(adopted)
  const implausible = own > 0 && theirs > 0
    && (theirs / own > IMPLAUSIBLE_PRICE_RATIO || own / theirs > IMPLAUSIBLE_PRICE_RATIO)
  return implausible ? { ...item, packChain: chain } : adopted
}
