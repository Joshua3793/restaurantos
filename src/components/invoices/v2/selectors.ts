// Pure functions used by InvoiceDrawerV2.
// Variance, filter predicates, sort weight, header reconciliation,
// and the small "detect product's default pricing mode" helper.
//
// All inputs are plain values — no React, no fetch, no I/O — so these can
// be reasoned about (and later unit-tested) in isolation.

import { getUnitConv } from '@/lib/utils'
import type { ScanItem, Session, PricingMode } from '../types'

// Tailwind utility class names used by chips/borders so the row/chip components
// stay declarative. Keep palette consistent with v1 (gold = brand).
export const TONE = {
  danger:  { bg: 'bg-red-50',     border: 'border-red-200',    text: 'text-red-700',    dot: 'bg-red-400'    },
  warning: { bg: 'bg-amber-50',   border: 'border-amber-200',  text: 'text-amber-700',  dot: 'bg-amber-400'  },
  info:    { bg: 'bg-blue-50',    border: 'border-blue-200',   text: 'text-blue-700',   dot: 'bg-blue-400'   },
  success: { bg: 'bg-emerald-50', border: 'border-emerald-200',text: 'text-emerald-700',dot: 'bg-emerald-400'},
  neutral: { bg: 'bg-gray-50',    border: 'border-gray-200',   text: 'text-gray-600',   dot: 'bg-gray-300'   },
} as const
export type Tone = keyof typeof TONE

const WEIGHT_UOMS = new Set(['kg', 'g', 'lb', 'oz'])
const VOLUME_UOMS = new Set(['l', 'ml', 'fl_oz', 'gal'])

const norm = (u: string | null | undefined): string => (u ?? '').toLowerCase().trim()
const isWeight = (u: string | null | undefined) => WEIGHT_UOMS.has(norm(u))
const isVolume = (u: string | null | undefined) => VOLUME_UOMS.has(norm(u))
export const isWeightOrVolume = (u: string | null | undefined) => isWeight(u) || isVolume(u)

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

// ── Mode detection ────────────────────────────────────────────────────────────
// OCR may set pricingMode = null on legacy data. Fall back to inferring from
// the legacy rawPriceType/totalQty/rate fields.
export function effectiveMode(item: ScanItem): PricingMode {
  if (item.pricingMode === 'per_case' || item.pricingMode === 'per_weight' || item.pricingMode === 'unknown') {
    return item.pricingMode
  }
  // Inference rule for pre-refactor scan items:
  if (num(item.rate) != null && num(item.totalQty) != null) return 'per_weight'
  if (item.rawPriceType === 'UOM' && isWeightOrVolume(item.invoicePackUOM)) return 'per_weight'
  return 'per_case'
}

// The linked product's saved default mode. Derived from priceType +
// packUOM since InventoryItem has no explicit defaultPricingMode column
// — UOM-priced with a weight/volume packUOM ≈ per_weight, else per_case.
export function productDefaultMode(item: ScanItem): PricingMode | null {
  const inv = item.matchedItem
  if (!inv) return null
  if (inv.priceType === 'UOM' && isWeightOrVolume(inv.packUOM)) return 'per_weight'
  return 'per_case'
}

// ── Variance ──────────────────────────────────────────────────────────────────
// "New cost per inventory base unit" in the linked product's baseUnit
// (e.g. $/g, $/ml, $/each). Returns null when the math doesn't ground out.
//
// per_case rows:
//   total base units per case = packQty × packSize × unitsOf(packUOM → baseUOM)
//   newCostPerBase            = unitPrice ÷ (total base units per case)
// per_weight rows:
//   newCostPerBase            = rate ÷ unitsOf(baseUOM → rateUOM)
//   (i.e. if rate is $/lb and base is g, $/g = $/lb ÷ 453.59)
// Conversion only succeeds within the same dimension (weight↔weight,
// volume↔volume). Cross-dimension returns null.
export function newCostPerBaseUnit(item: ScanItem): number | null {
  const inv = item.matchedItem
  if (!inv) return null

  const mode = effectiveMode(item)
  const baseUOM = norm(inv.baseUnit) || 'each'

  if (mode === 'per_weight') {
    const rate    = num(item.rate)        ?? num(item.rawUnitPrice)
    const rateUOM = norm(item.rateUOM ?? item.invoicePackUOM ?? item.totalQtyUOM)
    if (rate == null || !rateUOM) return null
    // unitsPerRate = how many baseUOM in 1 rateUOM (e.g. 453.59 g per lb)
    const unitsPerRate = unitsOf(rateUOM, baseUOM)
    if (unitsPerRate == null || unitsPerRate <= 0) return null
    return rate / unitsPerRate
  }

  // per_case (and 'unknown' → treat as per_case for cost-comparison purposes)
  const unitPrice = num(item.rawUnitPrice)
  if (unitPrice == null) return null

  const packQty  = num(item.invoicePackQty)  ?? num(inv.qtyPerPurchaseUnit) ?? 1
  const packSize = num(item.invoicePackSize) ?? num(inv.packSize)           ?? 1
  const packUOM  = norm(item.invoicePackUOM) || norm(inv.packUOM) || 'each'
  if (packQty <= 0 || packSize <= 0) return null

  // unitsPerPack = how many baseUOM in 1 packUOM (e.g. 1000 g per kg)
  const unitsPerPack = unitsOf(packUOM, baseUOM)
  if (unitsPerPack == null || unitsPerPack <= 0) return null

  const totalBaseUnitsPerCase = packQty * packSize * unitsPerPack
  if (totalBaseUnitsPerCase <= 0) return null
  return unitPrice / totalBaseUnitsPerCase
}

// How many `to` units are in one `from` unit. E.g. unitsOf('lb', 'g') = 453.59
// (453.59 grams in 1 pound). Returns null when the conversion crosses
// dimensions or one side is unknown.
//
// getUnitConv returns "units of the canonical base for this dimension":
//   g → 1, kg → 1000, lb → 453.59, oz → 28.35
//   ml → 1, l → 1000
//   each → 1 (its own dimension)
// So unitsOf(from, to) = getUnitConv(from) / getUnitConv(to) when both
// resolve to the same dimension. Same-dimension is checked first to keep
// cross-dimension conversions from silently returning a meaningless ratio.
export function unitsOf(from: string, to: string): number | null {
  const f = norm(from)
  const t = norm(to)
  if (!f || !t) return null
  if (f === t) return 1
  const fromIsW = isWeight(f), toIsW = isWeight(t)
  const fromIsV = isVolume(f), toIsV = isVolume(t)
  const fromIsE = f === 'each', toIsE = t === 'each'
  if ((fromIsW && !toIsW) || (fromIsV && !toIsV) || (fromIsE && !toIsE)) return null
  const fc = getUnitConv(f)
  const tc = getUnitConv(t)
  if (!Number.isFinite(fc) || !Number.isFinite(tc) || tc === 0) return null
  return fc / tc
}

// Back-compat alias — earlier code imported this name.
export const convFactor = unitsOf

// Signed variance vs the linked product's last applied price-per-base-unit.
// Returns null when no link, no previous cost, or new cost can't be computed.
export function varianceOf(item: ScanItem): number | null {
  const inv = item.matchedItem
  if (!inv) return null
  const prev = num(inv.pricePerBaseUnit)
  if (prev == null || prev <= 0) return null
  const next = newCostPerBaseUnit(item)
  if (next == null) return null
  return (next - prev) / prev
}

// ── Filter predicates ─────────────────────────────────────────────────────────
export const isPriceDelta    = (l: ScanItem) => {
  const v = varianceOf(l)
  return v != null && Math.abs(v) >= 0.02
}
export const isCatchweight   = (l: ScanItem) => l.isCatchweight === true
export const isNeedsLink     = (l: ScanItem) =>
  l.matchedItemId == null && l.action !== 'CREATE_NEW' && l.action !== 'SKIP'
export const isModeMismatch  = (l: ScanItem) => {
  if (!l.matchedItem) return false
  const pdm = productDefaultMode(l)
  const em  = effectiveMode(l)
  return pdm !== null && em !== 'unknown' && pdm !== em
}
export const isLowConfidence = (l: ScanItem) => l.ocrConfidence === 'low'
export const isUnknownMode   = (l: ScanItem) => effectiveMode(l) === 'unknown'
export const isCrossCheckFail = (l: ScanItem) => {
  const qty   = num(l.rawQty)
  const price = num(l.rawUnitPrice)
  const lt    = num(l.rawLineTotal)
  const rate  = num(l.rate)
  const tq    = num(l.totalQty)
  if (lt == null || lt <= 0) return false
  const mode = effectiveMode(l)
  let computed: number | null = null
  if (mode === 'per_weight' && rate != null && tq != null) computed = rate * tq
  else if (qty != null && price != null) computed = qty * price
  if (computed == null || computed <= 0) return false
  return Math.abs(computed - lt) / lt > 0.05
}

// Active filter — these strings are also used as chip keys.
export type V2Filter = 'all' | 'price_delta' | 'catchweight' | 'needs_link' | 'mismatch' | 'low_conf' | 'unknown_mode'

export function applyFilter(items: ScanItem[], filter: V2Filter): ScanItem[] {
  switch (filter) {
    case 'price_delta':  return items.filter(isPriceDelta)
    case 'catchweight':  return items.filter(isCatchweight)
    case 'needs_link':   return items.filter(isNeedsLink)
    case 'mismatch':     return items.filter(isModeMismatch)
    case 'low_conf':     return items.filter(isLowConfidence)
    case 'unknown_mode': return items.filter(isUnknownMode)
    default:             return items
  }
}

// "Exceptions first" sort weight: higher = appears earlier.
// Within the same weight, falls back to invoice order (sortOrder).
export function exceptionWeight(l: ScanItem): number {
  return (isUnknownMode(l)    ? 8 : 0)
       + (isLowConfidence(l)  ? 4 : 0)
       + (isNeedsLink(l)      ? 3 : 0)
       + (isModeMismatch(l)   ? 2 : 0)
       + (isPriceDelta(l)     ? 1 : 0)
}
export function sortByExceptionsFirst(items: ScanItem[]): ScanItem[] {
  return [...items].sort((a, b) => {
    const w = exceptionWeight(b) - exceptionWeight(a)
    if (w !== 0) return w
    return a.sortOrder - b.sortOrder
  })
}

// ── Header reconciliation ─────────────────────────────────────────────────────
// Sum the OCR-detected fees and taxes; check that they reconcile to the
// invoice's reported grand total within 1¢.
export function headerReconciliation(s: Session): {
  computed: number | null
  diff: number | null
  match: boolean | null
} {
  const sub  = num(s.subtotal)
  const total = num(s.total)
  if (sub == null || total == null) return { computed: null, diff: null, match: null }
  const fees = (num(s.fuelSurcharge) ?? 0)
             + (num(s.freight) ?? 0)
             + (num(s.minimumOrderFee) ?? 0)
             + (num(s.gst) ?? 0)
             + (num(s.hst) ?? 0)
             + (num(s.pst) ?? 0)
             - (num(s.discount) ?? 0)
             + (s.otherCharges ?? []).reduce((sum, oc) => sum + (Number(oc.amount) || 0), 0)
  // If none of the breakdown fields are populated (older sessions), use the
  // single legacy `tax` column instead so we don't falsely flag a mismatch.
  const breakdownPopulated =
    [s.fuelSurcharge, s.freight, s.minimumOrderFee, s.gst, s.hst, s.pst, s.discount].some(v => num(v) != null)
    || ((s.otherCharges ?? []).length > 0)
  const taxFallback = breakdownPopulated ? 0 : (num(s.tax) ?? 0)
  const computed = sub + fees + taxFallback
  const diff = total - computed
  const match = Math.abs(diff) < 0.01
  return { computed, diff, match }
}

// ── Tax aggregate for header display ──────────────────────────────────────────
// Sum of split taxes when present, else the legacy single tax column.
export function taxAggregate(s: Session): number | null {
  const split = (num(s.gst) ?? 0) + (num(s.hst) ?? 0) + (num(s.pst) ?? 0)
  if ([s.gst, s.hst, s.pst].some(v => num(v) != null)) return split
  return num(s.tax)
}

// Total fees for header display ("fuel $X · freight $Y").
export function feesAggregate(s: Session): number {
  return (num(s.fuelSurcharge) ?? 0)
       + (num(s.freight) ?? 0)
       + (num(s.minimumOrderFee) ?? 0)
}

// ── Per-row math expression ───────────────────────────────────────────────────
// Returns the operands and operators needed to render the row's math card.
// Components don't compute math themselves — they receive these tokens and
// just render them, which keeps the LineItemRow declarative.
export interface MathTokens {
  mode: PricingMode
  catchweight: boolean
  lhs: { value: string; uom: string; ordHint: string | null }  // e.g. "3.20" "lb" "(ord 3.00)"
  rhs: { value: string; uom: string }                          // e.g. "$19.89" "lb"
  result: string                                               // e.g. "$63.65"
}

export function mathTokens(item: ScanItem): MathTokens {
  const mode = effectiveMode(item)
  const fmt$ = (n: number | null) => n == null ? '$—' : `$${n.toFixed(2)}`
  const fmtN = (n: number | null) => n == null ? '—' : String(Number(n.toFixed(4)).toString())

  if (mode === 'per_weight') {
    const totalQty = num(item.totalQty)
    const rate     = num(item.rate) ?? num(item.rawUnitPrice)
    const rateUOM  = (item.rateUOM ?? item.totalQtyUOM ?? item.invoicePackUOM ?? '').toLowerCase()
    const tqUOM    = (item.totalQtyUOM ?? rateUOM).toLowerCase()
    const lineTot  = num(item.rawLineTotal)
    const ordered  = num(item.qtyOrdered)
    const ordHint  = item.isCatchweight && ordered != null && totalQty != null && ordered !== totalQty
      ? `(ord ${fmtN(ordered)})`
      : null
    return {
      mode,
      catchweight: item.isCatchweight === true,
      lhs:   { value: fmtN(totalQty), uom: tqUOM || '',  ordHint },
      rhs:   { value: fmt$(rate),      uom: rateUOM || '' },
      result: fmt$(lineTot ?? (rate != null && totalQty != null ? rate * totalQty : null)),
    }
  }

  // per_case (and unknown shown as case-like with mode pill flagging it)
  const qty   = num(item.rawQty)
  const unit  = (item.rawUnit ?? 'cs').toLowerCase()
  const price = num(item.rawUnitPrice)
  const lt    = num(item.rawLineTotal)
  return {
    mode,
    catchweight: false,
    lhs:    { value: fmtN(qty), uom: unit, ordHint: null },
    rhs:    { value: fmt$(price), uom: unit },
    result: fmt$(lt ?? (price != null && qty != null ? price * qty : null)),
  }
}

// ── Pack description for row meta line ────────────────────────────────────────
export function packDescription(item: ScanItem): string {
  const pq  = num(item.invoicePackQty)
  const ps  = num(item.invoicePackSize)
  const puo = item.invoicePackUOM
  if (pq != null && ps != null && puo) return `${pq} × ${ps}${puo}`
  if (ps != null && puo) return `${ps}${puo}`
  const qs = num(item.rawQty)
  const u  = item.rawUnit
  if (qs != null && u) return `${qs} ${u}`
  return ''
}
