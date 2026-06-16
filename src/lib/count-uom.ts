/**
 * UOM conversion utilities specific to the stock count system.
 *
 * Every inventory item stores stockOnHand in its baseUnit.
 * During a count, the user may enter quantities in a different UOM
 * (e.g. purchaseUnit = "bag" containing 20 kg, or "kg" when baseUnit = "g").
 * These functions handle converting back to baseUnit for persistence.
 */

import { convertQty, canonicalUom, CONTAINER_UNITS, purchaseUnitToken } from './uom'
import { deriveBaseUnit, getUnitConv, getUnitDimension, isMeasuredUnit } from './utils'

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

  if (isMeasuredUnit(qtyUOM)) {
    const total = qty * getUnitConv(qtyUOM)
    return total >= 1000 && getUnitDimension(qtyUOM) === 'weight'
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

  if (isMeasuredUnit(qtyUOM)) {
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
 * Human-readable pack display derived ONLY from the structured columns (never a stored
 * string). The container token comes from purchaseUnit via purchaseUnitToken (tolerant of
 * legacy display strings); the numbers come from qtyPerPurchaseUnit/innerQty/packSize/packUOM.
 * Single source for every pack label.
 */
export function formatPurchaseDisplay(item: ItemDims): string {
  const token = purchaseUnitToken(item.purchaseUnit)
  const isContainerTok = CONTAINER_UNITS.has(token)
  const qtyUOM = item.qtyUOM ?? 'each'
  const qty = Number(item.qtyPerPurchaseUnit)
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null
  const fmtWV = (val: number, unit: string) => {
    const x = (unit || '').toLowerCase()
    const n = Number.isInteger(val) ? val.toString() : parseFloat(val.toFixed(2)).toString()
    return `${n}${x === 'l' || x === 'lt' ? 'L' : x}`
  }
  let detail = ''
  if (qtyUOM === 'pack' && innerQty && innerQty > 0) detail = `${fmtNum(qty)} pkg`
  else if (isMeasuredUnit(qtyUOM) && qty > 1) detail = fmtWV(qty, qtyUOM)
  else if (isMeasuredUnit(pu) && ps > 0) detail = qty > 1 ? `${fmtNum(qty)} × ${fmtWV(ps, pu)}` : fmtWV(ps, pu)
  else if ((pu ?? 'each').toLowerCase() === 'each' && ps > 1) detail = `${fmtNum(qty > 1 ? qty * ps : ps)} each`

  if (isContainerTok) return detail ? `${token} (${detail})` : token
  if (detail) return detail
  return token || 'each'
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
  const fmtWV = (val: number, unit: string) => {
    const x = (unit || '').toLowerCase()
    // keep up to 2 decimals (trim trailing zeros) so a 3.25kg wheel reads "3.25kg", not "3.3kg"
    const n = Number.isInteger(val) ? val.toString() : parseFloat(val.toFixed(2)).toString()
    return `${n}${x === 'l' || x === 'lt' ? 'L' : x}`
  }

  const purchaseToBase = calcConversionFactorForItem(item)

  // Purchase unit (case / bag / etc.) — label is the canonical container token; display derives from structured cols.
  uoms.push({
    label: purchaseUnitToken(item.purchaseUnit),
    toBase: purchaseToBase,
    hint: buildCaseHint(item),
    display: formatPurchaseDisplay(item),
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
      { label: 'lb', toBase: 453.592, hint: '454 g', display: 'lb' },
      { label: 'g',  toBase: 1, display: 'g' },
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

  const isWeightQty = isMeasuredUnit(qtyUOM)

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

export type CountEntry = { unit: string; qty: number }

/** Sum a mixed-unit count to base units. Each entry converts independently. */
export function countEntriesToBase(entries: CountEntry[] | null | undefined, item: ItemDims): number {
  if (!entries || entries.length === 0) return 0
  return entries.reduce((sum, e) => sum + convertCountQtyToBase(Number(e.qty) || 0, e.unit, item), 0)
}

/** Resolve a line's counted base: entries if present, else the single qty/uom. */
export function lineCountedBase(
  line: { entries?: unknown; countedQty: number | { toString(): string } | null; selectedUom: string },
  item: ItemDims,
): number {
  const entries = Array.isArray(line.entries) ? (line.entries as CountEntry[]) : null
  if (entries && entries.length) return countEntriesToBase(entries, item)
  return line.countedQty != null ? convertCountQtyToBase(Number(line.countedQty), line.selectedUom, item) : 0
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

  const isWeightQty = isMeasuredUnit(qtyUOM)

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
