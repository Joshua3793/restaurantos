// Server-only helpers for supplier offers: per-supplier price history derived
// from approved invoice lines, and the volatility metric shown in the UI.
// History is NOT stored — every approved scan item already records the price,
// pack, supplier (via its session) and date.

import { prisma } from '@/lib/prisma'
import { getUnitConv } from '@/lib/utils'
import { pricePerBaseUnit as chainPpb } from '@/lib/item-model'

/**
 * An offer's price-per-base-unit, derived from its per-offer pack chain
 * (the design's ItemOffer semantics) so cross-supplier comparison is a single
 * numeric compare. Returns 0 for an offer with no chain (should not occur
 * post-backfill — every offer row carries a packChain+pricing).
 */
export function offerPricePerBase(offer: {
  packChain?: unknown
  pricing?: unknown
}): number {
  const chain = Array.isArray(offer.packChain) ? offer.packChain : null
  const pricing = offer.pricing && typeof offer.pricing === 'object' ? offer.pricing : null
  if (chain && chain.length && pricing) {
    // pricePerBaseUnit reads only packChain + pricing; dimension/baseUnit unused.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return chainPpb({ packChain: chain, pricing } as any)
  }
  return 0 // no chain ⇒ unpriced offer
}

export interface SupplierOfferStats {
  id: string
  supplierName: string
  supplierId: string | null
  isPrimary: boolean
  lastPrice: number
  /** Chain-derived from the offer's packChain+pricing (0 if it carries no chain). */
  pricePerBaseUnit: number
  packChain: unknown
  pricing: unknown
  packQty: number | null
  packSize: number | null
  packUOM: string | null
  supplierItemCode: string | null
  lastUpdated: string
  lastInvoiceSessionId: string | null
  /** approved purchases of this item from this supplier in the trailing 90 days */
  purchases90d: number
  /** coefficient of variation of $/base-unit over those purchases; null when < 3 */
  volatility: number | null
  stability: 'stable' | 'variable' | 'volatile' | null
  history: { date: string; ppb: number }[]
}

// CV thresholds (spec §4): <5% stable · 5–15% variable · >15% volatile.
export function stabilityOf(volatility: number | null): SupplierOfferStats['stability'] {
  if (volatility === null) return null
  if (volatility < 0.05) return 'stable'
  if (volatility <= 0.15) return 'variable'
  return 'volatile'
}

/** Coefficient of variation (stddev ÷ mean). Null when fewer than 3 samples. */
export function volatilityOf(prices: number[]): number | null {
  if (prices.length < 3) return null
  const mean = prices.reduce((s, p) => s + p, 0) / prices.length
  if (mean <= 0) return null
  const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length
  return Math.sqrt(variance) / mean
}

/**
 * Normalise one approved scan line to $/base-unit.
 * per_weight lines: rate ÷ conv(rateUOM). per_case: price ÷ (packQty × packSize × conv(packUOM)).
 * Falls back to the item's current pack when the line carries none.
 */
export function scanLinePricePerBase(
  line: {
    newPrice: unknown
    rate: unknown
    rateUOM: string | null
    pricingMode: string | null
    invoicePackQty: unknown
    invoicePackSize: unknown
    invoicePackUOM: string | null
  },
  // Item fallback is the item's stored CHAIN (its pack format lives there now,
  // not in legacy columns). packQty = top container inner count (1 for a single
  // link); packSize = leaf base content; packUOM = the item's base unit.
  itemFallback: { packChain: unknown; baseUnit: string | null },
): number | null {
  const num = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  if (line.pricingMode === 'per_weight' && num(line.rate) && line.rateUOM) {
    const conv = getUnitConv(line.rateUOM)
    return conv > 0 ? num(line.rate)! / conv : null
  }
  const price = num(line.newPrice)
  if (!price) return null
  const chain = Array.isArray(itemFallback.packChain)
    ? (itemFallback.packChain as { unit: string; per: number }[]) : []
  const leaf = chain[chain.length - 1]
  const fbPackQty  = chain.length >= 2 ? num(chain[0].per) : 1
  const fbPackSize = leaf ? num(leaf.per) : null
  const pq = num(line.invoicePackQty) ?? fbPackQty ?? 1
  const ps = num(line.invoicePackSize) ?? fbPackSize ?? 1
  const pu = line.invoicePackUOM ?? itemFallback.baseUnit ?? 'each'
  const conv = getUnitConv(pu)
  const divisor = pq * ps * conv
  return divisor > 0 ? price / divisor : null
}

/**
 * The canonical name for offer rows: the Supplier entity's name when the
 * session resolved one, else the raw OCR name. Collapses OCR name variants
 * ("Sysco Canada, Inc." vs "Sysco Canada, Inc. - Vancouver") onto one offer.
 */
export async function canonicalSupplierName(
  supplierId: string | null | undefined,
  fallbackName: string,
): Promise<string> {
  if (!supplierId) return fallbackName
  const s = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true } })
  return s?.name ?? fallbackName
}

const HISTORY_WINDOW_DAYS = 90

/** Offers for one inventory item, enriched with trailing-90-day history stats. */
export async function getSupplierOffers(inventoryItemId: string): Promise<SupplierOfferStats[]> {
  const [offers, item] = await Promise.all([
    prisma.inventorySupplierPrice.findMany({
      where: { inventoryItemId },
      orderBy: { lastUpdated: 'desc' },
    }),
    prisma.inventoryItem.findUnique({
      where: { id: inventoryItemId },
      select: { packChain: true, baseUnit: true },
    }),
  ])
  if (!item || offers.length === 0) return []

  const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const lines = await prisma.invoiceScanItem.findMany({
    where: {
      matchedItemId: inventoryItemId,
      approved: true,
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] },
      // Price history windows on the invoice's own date (purchaseDate), not approval
      // time, so a June-dated invoice's price lands in June's trend. See purchase-date.ts.
      session: { status: 'APPROVED', purchaseDate: { gte: since } },
    },
    select: {
      newPrice: true, rate: true, rateUOM: true, pricingMode: true,
      invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
      session: { select: { supplierName: true, supplierId: true, purchaseDate: true, invoiceDate: true } },
    },
    orderBy: { session: { purchaseDate: 'asc' } },
  })

  // Group history by supplier identity: supplierId when the session resolved
  // one (collapses raw OCR name variants), else the raw name.
  const keyOf = (id: string | null | undefined, name: string | null | undefined) => id ?? name ?? ''
  const bySupplier = new Map<string, { date: string; ppb: number }[]>()
  for (const l of lines) {
    const key = keyOf(l.session?.supplierId, l.session?.supplierName)
    if (!key) continue
    const ppb = scanLinePricePerBase(l, item)
    if (ppb === null) continue
    const date = l.session!.invoiceDate ?? l.session!.purchaseDate?.toISOString().slice(0, 10) ?? ''
    if (!bySupplier.has(key)) bySupplier.set(key, [])
    bySupplier.get(key)!.push({ date, ppb })
  }

  return offers.map(o => {
    const history = bySupplier.get(keyOf(o.supplierId, o.supplierName)) ?? []
    const volatility = volatilityOf(history.map(h => h.ppb))
    return {
      id: o.id,
      supplierName: o.supplierName,
      supplierId: o.supplierId,
      isPrimary: o.isPrimary,
      lastPrice: Number(o.lastPrice),
      // Chain-derived from the offer's packChain+pricing (0 if no chain).
      pricePerBaseUnit: offerPricePerBase(o),
      packChain: o.packChain ?? null,
      pricing: o.pricing ?? null,
      packQty: o.packQty !== null ? Number(o.packQty) : null,
      packSize: o.packSize !== null ? Number(o.packSize) : null,
      packUOM: o.packUOM,
      supplierItemCode: o.supplierItemCode,
      lastUpdated: o.lastUpdated.toISOString(),
      lastInvoiceSessionId: o.lastInvoiceSessionId,
      purchases90d: history.length,
      volatility,
      stability: stabilityOf(volatility),
      history,
    }
  })
}
