// Display formatters for invoice line items.
// All return plain strings — no JSX.

import type { ScanItem } from '@/components/invoices/types'
import { formatCurrency as baseFmt } from '@/lib/utils'
import { derivePricingMode, isWeightVolUOM } from './predicates'

// Re-export the existing currency formatter so callers import from one place.
export { formatCurrency } from '@/lib/utils'

// ── Quantity with unit ────────────────────────────────────────────────────────
export function formatQuantity(value: number, uom: string): string {
  const n = value === Math.floor(value) ? String(value) : value.toFixed(2)
  return `${n} ${uom}`
}

// ── Pack summary (subtitle line) ──────────────────────────────────────────────
// Examples:
//   per_case:   "4 × 3L per cs"  |  "1 cs · 8 ea per cs"
//   per_weight: "4 cs · 10 lb nominal"  |  "1 cs · 3 lb nominal · 3.20 lb received"
export function formatPackSummary(item: ScanItem): string {
  const mode  = derivePricingMode(item)
  const qty   = item.rawQty           ? Number(item.rawQty)           : null
  const pq    = item.invoicePackQty   ? Number(item.invoicePackQty)   : null
  const ps    = item.invoicePackSize  ? Number(item.invoicePackSize)  : null
  const pUOM  = item.invoicePackUOM   ?? null

  if (mode === 'per_weight') {
    const rateUOM    = item.rateUOM ?? item.qtyOrderedUOM ?? 'lb'
    const nominal    = item.nominalWeight ? Number(item.nominalWeight) : (pq && ps ? pq * ps : null)
    const measured   = item.qtyOrdered   ? Number(item.qtyOrdered)   : (item.totalQty ? Number(item.totalQty) : null)
    const parts: string[] = []
    if (qty)     parts.push(`${qty} cs`)
    if (nominal) parts.push(`${nominal} ${rateUOM} nominal`)
    if (measured && item.isCatchweight) parts.push(`${measured.toFixed(2)} ${rateUOM} received`)
    return parts.join(' · ') || '—'
  }

  // per_case
  const parts: string[] = []
  if (pq && ps && pUOM) parts.push(`${pq} × ${ps}${pUOM} per cs`)
  else if (pq && pUOM)  parts.push(`${pq} ${pUOM}/cs`)
  return parts.join(' · ') || '—'
}

// ── Rate label (below line total in collapsed row) ────────────────────────────
// Returns null when the rate would be redundant:
//   - per_case + qty === 1  → total already says it all
//   - per_weight with no rate data
// Examples:
//   "$18.79/lb · 40 lb"   (per_weight)
//   "$55.13/cs · 4 cs"    (per_case, qty > 1)
export function formatRateLabel(item: ScanItem): string | null {
  const mode = derivePricingMode(item)

  if (mode === 'per_weight') {
    if (!item.rate || !item.rateUOM) return null
    const qty    = item.qtyOrdered ?? item.totalQty
    const qtyUOM = item.qtyOrderedUOM ?? item.rateUOM
    const rate   = `${baseFmt(Number(item.rate))}/${item.rateUOM}`
    return qty ? `${rate} · ${Number(qty).toFixed(2)} ${qtyUOM}` : rate
  }

  // per_case: suppress when qty === 1 (rate = total, redundant)
  if (!item.rawQty || Number(item.rawQty) === 1) return null
  if (!item.rawUnitPrice) return null
  return `${baseFmt(Number(item.rawUnitPrice))}/cs · ${Number(item.rawQty)} cs`
}

// ── Check-row formula string ──────────────────────────────────────────────────
// "40 × $18.79 = $751.60"
export function formatCheckFormula(item: ScanItem): string | null {
  const mode = derivePricingMode(item)
  if (mode === 'per_weight') {
    if (!item.rate || !item.qtyOrdered) return null
    const total = Number(item.rate) * Number(item.qtyOrdered)
    return `${Number(item.qtyOrdered).toFixed(2)} × ${baseFmt(Number(item.rate))} = ${baseFmt(total)}`
  }
  if (!item.rawQty || !item.rawUnitPrice) return null
  const qty   = Number(item.rawQty)
  const price = Number(item.rawUnitPrice)
  const total = qty * price
  return `${qty} × ${baseFmt(price)} = ${baseFmt(total)}`
}

// ── Case structure label ──────────────────────────────────────────────────────
// "total per case: 12 L · cost per ml: $0.0046"
export function formatCaseSummary(item: ScanItem): string | null {
  const pq   = item.invoicePackQty  ? Number(item.invoicePackQty)  : null
  const ps   = item.invoicePackSize ? Number(item.invoicePackSize) : null
  const pUOM = item.invoicePackUOM  ?? null
  const price = item.rawUnitPrice   ? Number(item.rawUnitPrice)    : null
  if (!pq || !ps || !pUOM) return null
  const totalPerCase = pq * ps
  const parts = [`total per case: ${totalPerCase} ${pUOM}`]
  if (price && totalPerCase > 0 && !isWeightVolUOM(pUOM) === false) {
    // only show cost/unit for weight or volume UOMs where it's meaningful
  }
  if (price && totalPerCase > 0) {
    const costPerUnit = price / totalPerCase
    parts.push(`cost per ${pUOM}: ${baseFmt(costPerUnit)}`)
  }
  return parts.join(' · ')
}
