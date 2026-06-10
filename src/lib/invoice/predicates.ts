// Pure predicates for invoice line item state — no React imports.
// These are the single source of truth for card accent colours, filter chips,
// and footer task counts.

import type { ScanItem } from '@/components/invoices/types'

const WEIGHT_VOL = new Set(['kg', 'g', 'lb', 'oz', 'l', 'ml'])
export const isWeightVolUOM = (uom: string | null | undefined) =>
  !!uom && WEIGHT_VOL.has(uom.toLowerCase())

// ── Pricing mode ─────────────────────────────────────────────────────────────
// Priority:
//   1. line.pricingMode if explicitly set by OCR
//   2. line.rate + line.qtyOrdered present → per_weight
//   3. packUOM is a weight/vol unit → per_weight
//   4. fallback: per_case
export function derivePricingMode(item: ScanItem): 'per_case' | 'per_weight' {
  if (item.pricingMode === 'per_weight') return 'per_weight'
  if (item.pricingMode === 'per_case')   return 'per_case'
  if (item.rate && item.qtyOrdered)      return 'per_weight'
  if (isWeightVolUOM(item.invoicePackUOM)) return 'per_weight'
  return 'per_case'
}

// ── Catchweight ───────────────────────────────────────────────────────────────
// True when the item was priced by weight AND the actual received weight
// differs from the nominal pack weight (i.e. qtyOrdered ≠ nominalWeight).
export function isCatchweight(item: ScanItem): boolean {
  if (item.isCatchweight) return true
  if (derivePricingMode(item) !== 'per_weight') return false
  const actual  = item.qtyOrdered   ? Number(item.qtyOrdered)   : null
  const nominal = item.nominalWeight ? Number(item.nominalWeight) : null
  if (actual === null || nominal === null) return false
  return Math.abs(actual - nominal) > 0.01
}

// ── Format mismatch ───────────────────────────────────────────────────────────
// Kept as a distinct state from mode mismatch (per-brief decision).
//
// The stored `formatMismatch` flag is the *resolution* switch — "Use invoice
// format" / "Revert to inventory format" clear it. But upstream matching can set
// it as a false positive (e.g. invoice 4×4L vs inventory 4×4L). So we only treat
// it as a real issue when the flag is set AND the invoice pack format genuinely
// differs from the linked item's stored format. If we don't have full invoice
// pack data to compare, we trust the flag.
const numEq = (a: string | number | null | undefined, b: string | number | null | undefined): boolean => {
  const na = Number(a), nb = Number(b)
  if (Number.isNaN(na) || Number.isNaN(nb)) return String(a ?? '').trim() === String(b ?? '').trim()
  return Math.abs(na - nb) < 1e-9
}
const uomEq = (a: string | null | undefined, b: string | null | undefined): boolean =>
  String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

export function hasFormatMismatch(item: ScanItem): boolean {
  if (item.formatMismatch !== true) return false
  const inv = item.matchedItem
  if (!inv) return false
  const { invoicePackQty, invoicePackSize, invoicePackUOM } = item
  if (invoicePackQty != null && invoicePackSize != null && invoicePackUOM != null) {
    const sameFormat =
      numEq(inv.qtyPerPurchaseUnit, invoicePackQty) &&
      numEq(inv.packSize, invoicePackSize) &&
      uomEq(inv.packUOM, invoicePackUOM)
    if (sameFormat) return false // false positive — formats actually match
  }
  return true
}

// ── Mode mismatch ─────────────────────────────────────────────────────────────
// True when the line is linked AND the detected pricing mode disagrees with
// the linked inventory item's expected mode.
// InventoryItem.priceType: 'UOM' → per_weight, 'CASE'/'PKG' → per_case.
export function hasModeMismatch(item: ScanItem): boolean {
  if (!item.matchedItem) return false
  const detected      = derivePricingMode(item)
  const inventoryMode = item.matchedItem.priceType === 'UOM' ? 'per_weight' : 'per_case'
  return detected !== inventoryMode
}

// ── Price change ──────────────────────────────────────────────────────────────
export function hasPriceChange(item: ScanItem, thresholdPct = 3): boolean {
  if (!item.priceDiffPct) return false
  return Math.abs(Number(item.priceDiffPct)) > thresholdPct
}

// ── Unlinked ──────────────────────────────────────────────────────────────────
export function isUnlinked(item: ScanItem): boolean {
  return (
    !item.matchedItemId &&
    // CREATE_NEW only counts as a decision when the user actually configured
    // the new item (newItemData from the AddNewItemModal). Legacy scan items
    // auto-set to CREATE_NEW by the matcher carry no data and still need one.
    !(item.action === 'CREATE_NEW' && item.newItemData) &&
    item.action !== 'SKIP'
  )
}

// ── Math check ────────────────────────────────────────────────────────────────
// True when the computed qty × price does not match the scanned line total
// within a $0.02 tolerance.
export function hasMathCheck(item: ScanItem): boolean {
  if (item.action === 'SKIP') return false
  const mode = derivePricingMode(item)

  let computed: number
  if (mode === 'per_weight') {
    // Use totalQty (actual delivered weight), not qtyOrdered (cases ordered).
    // These differ for catchweight items: rate × totalQty = lineTotal, not rate × qtyOrdered.
    if (!item.rate || !item.totalQty) return false
    computed = Number(item.rate) * Number(item.totalQty)
  } else {
    if (!item.rawUnitPrice || !item.rawQty) return false
    const pq = Number(item.invoicePackQty) || 1
    const ps = Number(item.invoicePackSize) || 1
    const pt = item.rawPriceType ?? 'CASE'
    const price = Number(item.rawUnitPrice)
    const qty   = Number(item.rawQty)
    if (pt === 'PKG')      computed = qty * pq * price
    else if (pt === 'UOM') computed = qty * pq * ps * price
    else                   computed = qty * price  // CASE
  }

  if (!item.rawLineTotal) return false
  return Math.abs(computed - Number(item.rawLineTotal)) > 0.02
}

// ── Trust check ───────────────────────────────────────────────────────────────
// True when the line needs an explicit "looks right" confirmation before it
// can write a price: Claude flagged the OCR as low-confidence, or the link is
// only a fuzzy MEDIUM match that would auto-update the price.
export function needsTrustCheck(item: ScanItem): boolean {
  if (item.action === 'SKIP') return false
  if (item.ocrConfidence === 'low') return true
  return (
    item.matchConfidence === 'MEDIUM' &&
    (item.action === 'UPDATE_PRICE' || item.action === 'ADD_SUPPLIER')
  )
}

// ── Accent colour ─────────────────────────────────────────────────────────────
// Single source of truth for card left-border accent and chip colour.
export type Accent = 'danger' | 'warn' | 'info' | 'success' | null

export function pickAccent(item: ScanItem): Accent {
  if (item.action === 'SKIP') return null
  if (isUnlinked(item))       return 'danger'
  if (hasFormatMismatch(item) || hasModeMismatch(item) || hasMathCheck(item)) return 'warn'
  if (hasPriceChange(item, 15)) return 'warn'
  if (hasPriceChange(item, 3))  return 'info'
  if (item.matchedItemId)       return 'success'
  return null
}
