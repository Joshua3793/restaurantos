// Which pack format does an invoice line speak? An item with several suppliers
// has several packs; the item's own chain is only the PRIMARY supplier's. Reading
// every line through the item's chain is what forced a second item per supplier
// (spec 2026-09-20-item-consolidation). Pure + client-safe.

import { type ChainItem, type PackLink, type Pricing, basePerPurchase, dimensionOf, pricePerBaseUnit } from '@/lib/item-model'

/** The slice of an InventorySupplierPrice row this module reads. */
export interface OfferFormat {
  supplierId?: string | null
  supplierName?: string | null
  packChain?: unknown
  pricing?: unknown
}

export interface SupplierRef {
  supplierId?: string | null
  supplierName?: string | null
  /** Supplier.name — offers are stored under it; sessions may carry an OCR variant. */
  canonicalName?: string | null
}

/** The offer belonging to a line's supplier. supplierId is the reliable join. */
export function pickOffer<T extends OfferFormat>(offers: T[] | null | undefined, ref: SupplierRef): T | null {
  if (!offers?.length) return null
  if (ref.supplierId) {
    const byId = offers.find(o => o.supplierId === ref.supplierId)
    if (byId) return byId
  }
  for (const name of [ref.canonicalName, ref.supplierName]) {
    if (!name) continue
    const byName = offers.find(o => o.supplierName === name)
    if (byName) return byName
  }
  return null
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
  const rateOk = p?.mode === 'RATE' && usable(p.rate) && !!p.rateUnit && dimensionOf(p.rateUnit) === item.dimension
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
