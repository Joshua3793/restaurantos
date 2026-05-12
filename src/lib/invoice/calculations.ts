// Pure calculation functions for invoice line item math.
// All inputs are ScanItem fields (strings from API); parse with Number() before use.

import type { ScanItem } from '@/components/invoices/types'
import { comparePricesNormalized, toPricePerSIBase } from '@/lib/invoice-format'
import { derivePricingMode } from './predicates'

// ── Line math check ───────────────────────────────────────────────────────────
// Returns the computed vs. scanned line total so callers can show "check:" row.
export function computeLineMath(item: ScanItem): {
  computed: number
  entered: number
  matches: boolean
  delta: number
} | null {
  const mode = derivePricingMode(item)
  let computed: number

  if (mode === 'per_weight') {
    if (!item.rate || !item.totalQty) return null
    computed = Number(item.rate) * Number(item.totalQty)
  } else {
    if (!item.rawUnitPrice || !item.rawQty) return null
    const pq    = Number(item.invoicePackQty)  || 1
    const ps    = Number(item.invoicePackSize) || 1
    const pt    = item.rawPriceType ?? 'CASE'
    const price = Number(item.rawUnitPrice)
    const qty   = Number(item.rawQty)
    if (pt === 'PKG')      computed = qty * pq * price
    else if (pt === 'UOM') computed = qty * pq * ps * price
    else                   computed = qty * price
  }

  if (!item.rawLineTotal) return null
  const entered = Number(item.rawLineTotal)
  const delta   = computed - entered
  return { computed, entered, delta, matches: Math.abs(delta) <= 0.02 }
}

// ── Cost per UOM ──────────────────────────────────────────────────────────────
// Returns the normalised cost per base measurement unit (e.g. $/ml, $/g, $/ea).
export function computeCostPerUOM(item: ScanItem): { value: number; uom: string } | null {
  const mode = derivePricingMode(item)

  if (mode === 'per_weight') {
    if (!item.rate || !item.rateUOM) return null
    return { value: Number(item.rate), uom: item.rateUOM }
  }

  // per_case: price / (packQty × packSize) = $/packUOM
  if (!item.rawUnitPrice || !item.invoicePackQty || !item.invoicePackSize || !item.invoicePackUOM) return null
  const total = Number(item.invoicePackQty) * Number(item.invoicePackSize)
  if (total <= 0) return null
  return { value: Number(item.rawUnitPrice) / total, uom: item.invoicePackUOM }
}

// ── Variance vs. linked inventory item ───────────────────────────────────────
// Re-uses the existing comparePricesNormalized helper so the normalisation
// logic stays in one place.
export function computeVariance(item: ScanItem): {
  percent: number
  direction: 'up' | 'down'
} | null {
  if (!item.priceDiffPct) return null
  const pct = Number(item.priceDiffPct)
  if (Math.abs(pct) < 0.1) return null
  return { percent: Math.abs(pct), direction: pct > 0 ? 'up' : 'down' }
}

// ── Normalised price comparison (for "Inventory result" row) ─────────────────
// Uses pricePerBaseUnit (stored SI price, e.g. $/g or $/ml) from the matched
// inventory item — the canonical value written on every approve — so the
// comparison is accurate regardless of pack-format differences on either side.
export function computeNormalisedPrices(item: ScanItem): {
  pctDiff: number
  invoicePPB: number
  inventoryPPB: number
  baseUnit: string
} | null {
  const costPerUOM = computeCostPerUOM(item)
  if (!costPerUOM || !item.matchedItem) return null

  // Convert invoice per-unit cost to SI base (e.g. $/kg → $/g)
  const invoiceNorm = toPricePerSIBase(costPerUOM.value, costPerUOM.uom)
  if (!invoiceNorm) return null

  // Inventory's stored pricePerBaseUnit is already in SI base units
  const invPPB    = Number(item.matchedItem.pricePerBaseUnit)
  const baseUnit  = item.matchedItem.baseUnit  // e.g. "g", "ml", "each"

  if (!baseUnit || invPPB <= 0 || invoiceNorm.base !== baseUnit) return null

  return {
    pctDiff:      Math.round(((invoiceNorm.price - invPPB) / invPPB) * 10000) / 100,
    invoicePPB:   invoiceNorm.price,
    inventoryPPB: invPPB,
    baseUnit,
  }
}

// ── Invoice total reconciliation ──────────────────────────────────────────────
// Compares sum-of-lines against the OCR'd invoice subtotal.
// Returns a suggested fix when exactly one line can explain the gap (gap < $5,
// adjusting that line's total closes it within $0.01).
export function reconcileInvoiceTotals(
  items: ScanItem[],
  invoiceSubtotal: number | null,
): {
  sumOfLines: number
  invoiceSubtotal: number | null
  delta: number
  status: 'match' | 'mismatch' | 'unknown'
  suggestedFixItemId: string | null
  suggestedFixValue: number | null
} {
  const active    = items.filter(i => i.action !== 'SKIP')
  const sumOfLines = active.reduce((s, i) => s + (i.rawLineTotal ? Number(i.rawLineTotal) : 0), 0)

  if (invoiceSubtotal === null) {
    return { sumOfLines, invoiceSubtotal: null, delta: 0, status: 'unknown', suggestedFixItemId: null, suggestedFixValue: null }
  }

  const delta   = invoiceSubtotal - sumOfLines
  const matches = Math.abs(delta) < 0.02

  if (matches) {
    return { sumOfLines, invoiceSubtotal, delta: 0, status: 'match', suggestedFixItemId: null, suggestedFixValue: null }
  }

  // Look for exactly one line that could explain the gap via a digit-misread.
  // Conservative: only suggest when |gap| < $5 and the adjustment is < 10% of that line's total.
  let suggestedFixItemId: string | null = null
  let suggestedFixValue:  number | null = null

  if (Math.abs(delta) < 5) {
    const candidates = active.filter(i => {
      if (!i.rawLineTotal) return false
      const lt       = Number(i.rawLineTotal)
      const adjusted = lt + delta
      return adjusted > 0 && Math.abs(delta / lt) < 0.10
    })
    if (candidates.length === 1) {
      suggestedFixItemId = candidates[0].id
      suggestedFixValue  = Math.round((Number(candidates[0].rawLineTotal) + delta) * 100) / 100
    }
  }

  return { sumOfLines, invoiceSubtotal, delta, status: 'mismatch', suggestedFixItemId, suggestedFixValue }
}
