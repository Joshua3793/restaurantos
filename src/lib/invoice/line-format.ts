// Which pack format does an invoice line speak? An item with several suppliers
// has several packs; the item's own chain is only the PRIMARY supplier's. Reading
// every line through the item's chain is what forced a second item per supplier
// (spec 2026-09-20-item-consolidation). Pure + client-safe.

import { type ChainItem, type PackLink, type Pricing, basePerPurchase, dimensionOf } from '@/lib/item-model'

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

/**
 * The ChainItem a line should be received/priced through: the supplier offer's
 * chain + pricing when it has a usable one, else the item unchanged. The chain
 * must have finite per values; the price must be a finite number > 0, else it
 * falls back to the item's pricing. Base unit and bridges always stay the item's.
 * (A pack PRINTED on the line still wins — that rule lives inside lineReceivedBaseUnits.)
 */
export function resolveLineFormat(item: ChainItem, offer: OfferFormat | null | undefined): ChainItem {
  const chain = Array.isArray(offer?.packChain) ? (offer!.packChain as PackLink[]) : []
  if (chain.length === 0 || !(basePerPurchase(chain) > 0)) return item
  // Verify all per values are finite numbers
  if (!chain.every(link => Number.isFinite(Number(link.per)))) return item

  const p = offer?.pricing as Pricing | null | undefined
  const packPriceOk = p?.mode === 'PACK' && Number.isFinite(Number(p.purchasePrice)) && Number(p.purchasePrice) > 0
  const ratePriceOk = Number.isFinite(Number(p?.rate)) && Number(p?.rate) > 0
  const rateOk = p?.mode === 'RATE' && !!p.rateUnit && dimensionOf(p.rateUnit) === item.dimension && ratePriceOk
  const pricing: Pricing = packPriceOk || rateOk ? (p as Pricing) : item.pricing
  return { ...item, packChain: chain, pricing }
}
