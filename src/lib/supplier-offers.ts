// Server-only helpers for supplier offers: per-supplier price history derived
// from approved invoice lines, and the volatility metric shown in the UI.
// History is NOT stored — every approved scan item already records the price,
// pack, supplier (via its session) and date.

import { prisma } from '@/lib/prisma'
import { getUnitConv } from '@/lib/utils'

export interface SupplierOfferStats {
  id: string
  supplierName: string
  supplierId: string | null
  isPrimary: boolean
  lastPrice: number
  pricePerBaseUnit: number
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
  itemFallback: { qtyPerPurchaseUnit: unknown; packSize: unknown; packUOM: string | null },
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
  const pq = num(line.invoicePackQty) ?? num(itemFallback.qtyPerPurchaseUnit) ?? 1
  const ps = num(line.invoicePackSize) ?? num(itemFallback.packSize) ?? 1
  const pu = line.invoicePackUOM ?? itemFallback.packUOM ?? 'each'
  const conv = getUnitConv(pu)
  const divisor = pq * ps * conv
  return divisor > 0 ? price / divisor : null
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
      select: { qtyPerPurchaseUnit: true, packSize: true, packUOM: true },
    }),
  ])
  if (!item || offers.length === 0) return []

  const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const lines = await prisma.invoiceScanItem.findMany({
    where: {
      matchedItemId: inventoryItemId,
      approved: true,
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] },
      session: { status: 'APPROVED', approvedAt: { gte: since } },
    },
    select: {
      newPrice: true, rate: true, rateUOM: true, pricingMode: true,
      invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
      session: { select: { supplierName: true, approvedAt: true, invoiceDate: true } },
    },
    orderBy: { session: { approvedAt: 'asc' } },
  })

  const bySupplier = new Map<string, { date: string; ppb: number }[]>()
  for (const l of lines) {
    const supplier = l.session?.supplierName
    if (!supplier) continue
    const ppb = scanLinePricePerBase(l, item)
    if (ppb === null) continue
    const date = l.session.invoiceDate ?? l.session.approvedAt?.toISOString().slice(0, 10) ?? ''
    if (!bySupplier.has(supplier)) bySupplier.set(supplier, [])
    bySupplier.get(supplier)!.push({ date, ppb })
  }

  return offers.map(o => {
    const history = bySupplier.get(o.supplierName) ?? []
    const volatility = volatilityOf(history.map(h => h.ppb))
    return {
      id: o.id,
      supplierName: o.supplierName,
      supplierId: o.supplierId,
      isPrimary: o.isPrimary,
      lastPrice: Number(o.lastPrice),
      pricePerBaseUnit: Number(o.pricePerBaseUnit),
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
