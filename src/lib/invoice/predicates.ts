// Pure predicates for invoice line item state — no React imports.
// These are the single source of truth for card accent colours, filter chips,
// and footer task counts.

import type { ScanItem } from '@/components/invoices/types'
import { isMeasuredUnit } from '@/lib/utils'
import { isKnownUnit } from '@/lib/uom'
import { buildOffer, scanItemToOfferInput } from './offer'
import { dimensionOf, eachMeasureOf } from '@/lib/item-model'

// A UOM that measures weight or volume (vs a count/case unit). Delegates to the
// canonical helper so it canonicalizes and covers the full unit set.
export const isWeightVolUOM = (uom: string | null | undefined) =>
  !!uom && isMeasuredUnit(uom)

/**
 * True when any of the line's billed/pack units is outside the UOM backbone
 * (neither a measurement nor a container unit — e.g. a malformed OCR token like
 * "325g"). The purchase math stays safe (buildPurchaseMap falls back to the pack
 * structure, never a silent ×1), but the line should be flagged for a quick fix.
 */
export const hasUnknownUom = (item: ScanItem): boolean =>
  [item.rawUnit, item.totalQtyUOM, item.invoicePackUOM, item.rateUOM]
    .some(u => u != null && String(u).trim() !== '' && !isKnownUnit(u))

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

// ── Dimension conflict ────────────────────────────────────────────────────────
/** True when the invoice line's dimension differs from the linked item's — the
 *  only hard blocker under the pack-chain model (e.g. a $/kg rate on an each item). */
export function hasDimensionConflict(item: ScanItem): boolean {
  if (!item.matchedItem) return false
  const offer = buildOffer(scanItemToOfferInput(item))
  const md = item.matchedItem as {
    dimension?: string; baseUnit?: string
    eachMeasureQty?: unknown; eachMeasureUnit?: string | null
  }
  const itemDim = (md.dimension as 'MASS' | 'VOLUME' | 'COUNT' | undefined) ?? dimensionOf(md.baseUnit ?? 'each')
  if (offer.dimension === itemDim) return false
  // A measured offer (MASS/VOLUME) on a COUNT item is BRIDGEABLE, not a conflict,
  // when the item carries an each-measure spanning that dimension.
  const bridge = eachMeasureOf(md)
  if (itemDim === 'COUNT' && bridge && dimensionOf(bridge.unit) === offer.dimension) return false
  return true
}

// ── Price change ──────────────────────────────────────────────────────────────
export function hasPriceChange(item: ScanItem, thresholdPct = 3): boolean {
  if (!item.priceDiffPct) return false
  return Math.abs(Number(item.priceDiffPct)) > thresholdPct
}

// ── Unlinked ──────────────────────────────────────────────────────────────────
export function isUnlinked(item: ScanItem): boolean {
  if (item.action === 'SKIP') return false
  // CREATE_NEW only counts as a decision when the user actually configured
  // the new item (newItemData from the AddNewItemModal). Legacy scan items
  // auto-set to CREATE_NEW by the matcher carry no data and still need one.
  if (item.action === 'CREATE_NEW' && item.newItemData) return false
  // "Linked" means a CONFIRMED link. A still-PENDING line is undecided even when the
  // matcher pre-filled a LOW-confidence matchedItemId *suggestion* — approve skips
  // action==='PENDING', so such a line must surface for review (the user confirms the
  // suggestion, which upgrades action to ADD_SUPPLIER/UPDATE_PRICE) rather than read as
  // auto-matched and then silently fail to reach inventory.
  return !item.matchedItemId || item.action === 'PENDING'
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
    // per_case: the printed unit price is the CASE price, so the line total is
    // simply cases × case-price (qty × price). The old per-PKG/per-UOM split was
    // a rawPriceType concept, abolished with the mode-first OCR model.
    const price = Number(item.rawUnitPrice)
    const qty   = Number(item.rawQty)
    computed = qty * price
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
  if (isUnlinked(item))         return 'danger'
  if (hasDimensionConflict(item)) return 'danger' // hard, unresolvable blocker
  if (hasMathCheck(item))       return 'warn'
  if (hasPriceChange(item, 15)) return 'warn'
  if (hasPriceChange(item, 3))  return 'info'
  if (item.matchedItemId)       return 'success'
  return null
}
