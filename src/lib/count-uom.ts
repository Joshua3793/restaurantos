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

  // Purchase unit (case / bag / etc.)
  uoms.push({ label: item.purchaseUnit, toBase: calcConversionFactorForItem(item), hint: buildCaseHint(item) })

  // Pack level (only when qtyUOM = "pack")
  if (qtyUOM === 'pack' && hasInnerQty) {
    const packBaseUnits = innerQty! * ps * getUnitConv(pu)
    const hint = packBaseUnits > 0 ? `${fmtNum(packBaseUnits)} ${base}` : `${innerQty} each`
    uoms.push({ label: 'pack', toBase: packBaseUnits > 0 ? packBaseUnits : innerQty!, hint })
  }

  // Each (individual item)
  if (hasItemWeight) {
    uoms.push({ label: 'each', toBase: ps * getUnitConv(pu), hint: `${ps} ${pu}` })
  } else if (qtyUOM === 'each' || qtyUOM === 'pack') {
    uoms.push({ label: 'each', toBase: 1 })
  }

  // Weight/volume options
  if (base === 'g') {
    uoms.push(
      { label: 'kg', toBase: 1000, hint: '1,000 g' },
      { label: 'g',  toBase: 1 },
      { label: 'lb', toBase: 453.592, hint: '454 g' },
    )
  }
  if (base === 'ml') {
    uoms.push(
      { label: 'l',  toBase: 1000, hint: '1,000 ml' },
      { label: 'ml', toBase: 1 },
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
