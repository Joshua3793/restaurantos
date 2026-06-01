/**
 * UOM conversion utilities specific to the stock count system.
 *
 * Every inventory item stores stockOnHand in its baseUnit.
 * During a count, the user may enter quantities in a different UOM
 * (e.g. purchaseUnit = "bag" containing 20 kg, or "kg" when baseUnit = "g").
 * These functions handle converting back to baseUnit for persistence.
 */

import { convertQty } from './uom'
import { deriveBaseUnit, getUnitConv } from './utils'

export interface CountableUom {
  label: string
  /** How many baseUnits make up 1 of this UOM. */
  toBase: number
  /** Human-readable description of what 1 of this unit contains, e.g. "20 kg" or "12 each". */
  hint?: string
  /** Chip/option text shown in the UI — e.g. "case (25kg)", "pkg (9 × 85g)". Falls back to label. */
  display?: string
}

interface ItemDims {
  baseUnit: string
  purchaseUnit: string
  qtyPerPurchaseUnit: number | { toString(): string }
  qtyUOM?: string | null
  innerQty?: { toString(): string } | number | null
  packSize: number | { toString(): string }
  packUOM: string
  countUOM: string
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return n.toString()
  if (n >= 10) return Math.round(n).toString()
  return n.toFixed(1)
}

function buildCaseHint(item: ItemDims): string {
  const qty = Number(item.qtyPerPurchaseUnit)
  const qtyUOM = item.qtyUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'

  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']

  if (weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)) {
    const total = qty * getUnitConv(qtyUOM)
    return total >= 1000 && weightUnits.includes(qtyUOM)
      ? `${total / 1000} kg`
      : `${qty} ${qtyUOM}`
  }
  if (qtyUOM === 'pack' && innerQty != null) {
    if (ps > 0 && pu !== 'each') {
      return `${qty} packs × ${innerQty} × ${ps}${pu}`
    }
    return `${qty} packs × ${innerQty} each`
  }
  if (ps > 0 && pu !== 'each') {
    return `${qty} × ${ps}${pu}`
  }
  return `${qty} each`
}

/** Helper: total base units per 1 purchase unit */
function calcConversionFactorForItem(item: ItemDims): number {
  const qtyUOM = item.qtyUOM ?? 'each'
  const qty = Number(item.qtyPerPurchaseUnit)
  const ps  = Number(item.packSize ?? 0)
  const pu  = item.packUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null

  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  if (weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)) {
    return qty * getUnitConv(qtyUOM)
  }
  if (qtyUOM === 'pack' && innerQty != null) {
    return qty * innerQty * ps * getUnitConv(pu)
  }
  return qty * ps * getUnitConv(pu)
}

/**
 * Returns the stored countUOM if it's still valid for this item's purchase
 * structure, otherwise falls back to the first valid option.
 */
export function resolveCountUom(item: ItemDims): string {
  const stored = item.countUOM ?? 'each'
  const valid = getCountableUoms(item).map(u => u.label)
  return valid.includes(stored) ? stored : (valid[0] ?? stored)
}

/**
 * Returns the UOM options a user can choose from when counting an item.
 * Derived from purchase structure — not a hardcoded list.
 */
export function getCountableUoms(item: ItemDims): CountableUom[] {
  const uoms: CountableUom[] = []
  const qtyUOM = item.qtyUOM ?? 'each'
  const base = deriveBaseUnit(qtyUOM, item.packUOM ?? 'each')
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null
  const hasInnerQty = innerQty != null && innerQty > 0
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'
  const hasWeight = base === 'g' || base === 'ml'
  const hasItemWeight = hasWeight && ps > 0

  // ── display helpers ────────────────────────────────────────────────────────
  const WV_W = ['g', 'kg', 'lb', 'oz', 'mg']
  const WV_V = ['ml', 'l', 'lt', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp', 'gal']
  const isWV = (u: string) => { const x = (u || '').toLowerCase(); return WV_W.includes(x) || WV_V.includes(x) }
  const fmtWV = (val: number, unit: string) => {
    const x = (unit || '').toLowerCase()
    // keep up to 2 decimals (trim trailing zeros) so a 3.25kg wheel reads "3.25kg", not "3.3kg"
    const n = Number.isInteger(val) ? val.toString() : parseFloat(val.toFixed(2)).toString()
    return `${n}${x === 'l' || x === 'lt' ? 'L' : x}`
  }

  const qty = Number(item.qtyPerPurchaseUnit)
  const purchaseToBase = calcConversionFactorForItem(item)

  // Describe what the purchase unit contains so we can label it "case (…)".
  // isContainer = false → the purchase unit is a bare UOM (e.g. "kg") — keep its raw name.
  let isContainer = false
  let caseFmt = ''
  if (qtyUOM === 'pack' && hasInnerQty) {
    isContainer = true; caseFmt = `${fmtNum(qty)} pkg`
  } else if (isWV(qtyUOM)) {
    if (qty > 1) { isContainer = true; caseFmt = fmtWV(qty, qtyUOM) }   // e.g. 25kg bag, 2L carton
  } else { // qtyUOM === 'each'
    if (isWV(pu) && ps > 0) {                                          // each = a weight chunk (Millet 25kg, Havarti 3.25kg)
      isContainer = true; caseFmt = qty > 1 ? `${fmtNum(qty)} × ${fmtWV(ps, pu)}` : fmtWV(ps, pu)
    } else if ((pu ?? 'each').toLowerCase() === 'each' && ps > 1) {    // case of N pieces (60 each)
      isContainer = true; caseFmt = `${fmtNum(qty > 1 ? qty * ps : ps)} each`
    }
  }

  // Purchase unit (case / bag / etc.) — label stays the conversion token; display adds the container word.
  uoms.push({
    label: item.purchaseUnit,
    toBase: purchaseToBase,
    hint: buildCaseHint(item),
    display: isContainer ? `case (${caseFmt})` : item.purchaseUnit,
  })

  // Pack level (only when qtyUOM = "pack")
  if (qtyUOM === 'pack' && hasInnerQty) {
    const packBaseUnits = innerQty! * ps * getUnitConv(pu)
    const hint = packBaseUnits > 0 ? `${fmtNum(packBaseUnits)} ${base}` : `${innerQty} each`
    uoms.push({ label: 'pack', toBase: packBaseUnits > 0 ? packBaseUnits : innerQty!, hint, display: `pkg (${fmtNum(innerQty!)} × ${fmtWV(ps, pu)})` })
  }

  // Each (individual item) — omitted when redundant: 1 case/pkg = 1 each, or there is no real per-each weight
  if (hasItemWeight) {
    const eachToBase = ps * getUnitConv(pu)
    const redundant = eachToBase >= purchaseToBase || eachToBase <= 1
    if (!redundant) uoms.push({ label: 'each', toBase: eachToBase, hint: `${ps} ${pu}`, display: `each (${fmtWV(ps, pu)})` })
  } else if (qtyUOM === 'each' || qtyUOM === 'pack') {
    // count-based each (e.g. individual shells) — drop only when the purchase unit is itself a single each
    if (!(qtyUOM === 'each' && purchaseToBase <= 1)) uoms.push({ label: 'each', toBase: 1, display: 'each' })
  }

  // Weight/volume options — only when item actually has a weight/volume per each
  if (base === 'g' && hasItemWeight) {
    uoms.push(
      { label: 'kg', toBase: 1000, hint: '1,000 g', display: 'kg' },
      { label: 'g',  toBase: 1, display: 'g' },
      { label: 'lb', toBase: 453.592, hint: '454 g', display: 'lb' },
    )
  }
  if (base === 'ml' && hasItemWeight) {
    uoms.push(
      { label: 'l',  toBase: 1000, hint: '1,000 ml', display: 'l' },
      { label: 'ml', toBase: 1, display: 'ml' },
    )
  }

  return uoms
}

/**
 * Convert a quantity entered by the user (in selectedUom) to the item's baseUnit.
 * This is what gets written to stockOnHand.
 */
export function convertCountQtyToBase(
  qty: number,
  selectedUom: string,
  item: ItemDims,
): number {
  const sel = selectedUom.toLowerCase()
  const base = item.baseUnit.toLowerCase()
  if (sel === base) return qty

  const qtyUOM = (item.qtyUOM ?? 'each').toLowerCase()
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null

  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)

  const itemBaseUnits = ps * getUnitConv(pu)
  const packBaseUnits = (innerQty ?? 1) * itemBaseUnits

  // Purchase unit
  if (sel === item.purchaseUnit.toLowerCase()) {
    const qtyNum = Number(item.qtyPerPurchaseUnit)
    if (isWeightQty) return qty * qtyNum * getUnitConv(qtyUOM)
    if (qtyUOM === 'pack' && innerQty != null) return qty * qtyNum * packBaseUnits
    return qty * qtyNum * (itemBaseUnits > 0 ? itemBaseUnits : 1)
  }

  // Pack level
  if (sel === 'pack' && qtyUOM === 'pack' && innerQty != null) {
    return qty * packBaseUnits
  }

  // Each
  if (sel === 'each') {
    return itemBaseUnits > 0 ? qty * itemBaseUnits : qty
  }

  // Standard weight/volume conversion (kg, g, lb, ml, l, etc.)
  return convertQty(qty, selectedUom, item.baseUnit)
}

/**
 * Convert a baseUnit quantity to the selectedUom — for displaying expected quantities.
 */
export function convertBaseToCountUom(
  baseQty: number,
  selectedUom: string,
  item: ItemDims,
): number {
  const sel = selectedUom.toLowerCase()
  const base = item.baseUnit.toLowerCase()
  if (sel === base) return baseQty

  const qtyUOM = (item.qtyUOM ?? 'each').toLowerCase()
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null

  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)

  const itemBaseUnits = ps * getUnitConv(pu)
  const packBaseUnits = (innerQty ?? 1) * itemBaseUnits

  // Purchase unit
  if (sel === item.purchaseUnit.toLowerCase()) {
    const qtyNum = Number(item.qtyPerPurchaseUnit)
    if (isWeightQty) {
      const purchaseBaseUnits = qtyNum * getUnitConv(qtyUOM)
      return purchaseBaseUnits > 0 ? baseQty / purchaseBaseUnits : 0
    }
    if (qtyUOM === 'pack' && innerQty != null) {
      const purchaseBaseUnits = qtyNum * packBaseUnits
      return purchaseBaseUnits > 0 ? baseQty / purchaseBaseUnits : 0
    }
    const purchaseBaseUnits = qtyNum * (itemBaseUnits > 0 ? itemBaseUnits : 1)
    return purchaseBaseUnits > 0 ? baseQty / purchaseBaseUnits : 0
  }

  // Pack level
  if (sel === 'pack' && qtyUOM === 'pack' && innerQty != null) {
    return packBaseUnits > 0 ? baseQty / packBaseUnits : 0
  }

  // Each
  if (sel === 'each') {
    return itemBaseUnits > 0 ? baseQty / itemBaseUnits : baseQty
  }

  // Standard weight/volume
  return convertQty(baseQty, item.baseUnit, selectedUom)
}
