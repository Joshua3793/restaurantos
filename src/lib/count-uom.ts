/**
 * UOM conversion utilities specific to the stock count system.
 *
 * Every inventory item stores stockOnHand in its baseUnit.
 * During a count, the user may enter quantities in a different UOM
 * (e.g. purchaseUnit = "bag" containing 20 kg, or "kg" when baseUnit = "g").
 * These functions handle converting back to baseUnit for persistence.
 */

import { UOM_GROUPS, convertQty, getUnitGroup } from './uom'

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
  qtyPerPurchaseUnit: number
  packSize: number
  packUOM: string
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return n.toString()
  if (n >= 10) return Math.round(n).toString()
  return n.toFixed(1)
}

/**
 * Returns the UOM options a user can choose from when counting an item.
 * Order: purchaseUnit first (most common counting unit), then baseUnit, then
 * a compatible weight/volume partner if applicable.
 */
export function getCountableUoms(item: ItemDims): CountableUom[] {
  const seen = new Set<string>()
  const result: CountableUom[] = []

  const add = (label: string, toBase: number, hint?: string) => {
    const key = label.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    result.push({ label, toBase, hint })
  }

  // 1. Purchase unit (e.g. "bag", "case") — listed first.
  //    toBase must account for packUOM → baseUnit conversion (e.g. kg → g).
  //    hint shows the quantity in the most human-readable unit:
  //      - standard packUOM (kg, l…): "20 kg"
  //      - custom packUOM (pkg, each…): "72 each" (collapsed to baseUnit)
  if (item.purchaseUnit && item.purchaseUnit.toLowerCase() !== item.baseUnit.toLowerCase()) {
    const packConv = convertQty(Number(item.packSize), item.packUOM, item.baseUnit)
    const unitsPerPurchase = Number(item.qtyPerPurchaseUnit) * packConv
    if (unitsPerPurchase > 0) {
      const rawQty = Number(item.qtyPerPurchaseUnit) * Number(item.packSize)
      const isStandardPack = getUnitGroup(item.packUOM) !== null
      const hint = isStandardPack
        ? `${fmtNum(rawQty)} ${item.packUOM}`
        : `${fmtNum(unitsPerPurchase)} ${item.baseUnit}`
      add(item.purchaseUnit, unitsPerPurchase, hint)
    }
  }

  // 1.5. Intermediate pack unit (e.g. "pkg" in case×pkg×each).
  //      Only for custom units not in UOM_GROUPS — standard packUOMs (kg, lb…)
  //      are already covered by step 3 with the correct conversion factor.
  if (
    item.packUOM &&
    item.packUOM.toLowerCase() !== item.baseUnit.toLowerCase() &&
    item.packUOM.toLowerCase() !== item.purchaseUnit.toLowerCase() &&
    getUnitGroup(item.packUOM) === null
  ) {
    const unitsPerPack = Number(item.packSize)
    if (unitsPerPack > 0) {
      add(item.packUOM, unitsPerPack, `${fmtNum(unitsPerPack)} ${item.baseUnit}`)
    }
  }

  // 2. Base unit — always available (1:1 with stockOnHand). No hint needed.
  add(item.baseUnit, 1)

  // 3. All practical units from the same weight/volume group.
  //    No hint: kg, lb, g, oz are self-explanatory to the user.
  const PRACTICAL_WEIGHT = ['kg', 'lb', 'g', 'oz']
  const PRACTICAL_VOLUME = ['l', 'ml', 'fl oz', 'cup', 'qt']

  for (const group of UOM_GROUPS) {
    const baseDef = group.units.find(u => u.label.toLowerCase() === item.baseUnit.toLowerCase())
    if (!baseDef) continue

    const practical =
      group.label === 'Weight' ? PRACTICAL_WEIGHT :
      group.label === 'Volume' ? PRACTICAL_VOLUME :
      [] // Count items: no extra unit conversions beyond purchaseUnit

    for (const unitLabel of practical) {
      const unitDef = group.units.find(u => u.label === unitLabel)
      if (!unitDef) continue
      add(unitDef.label, unitDef.toBase / baseDef.toBase)
    }
    break
  }

  return result
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

  // Purchase unit — apply packUOM→baseUnit conversion factor
  if (sel === item.purchaseUnit.toLowerCase()) {
    const packConv = convertQty(Number(item.packSize), item.packUOM, item.baseUnit)
    const unitsPerPurchase = Number(item.qtyPerPurchaseUnit) * packConv
    if (unitsPerPurchase > 0) return qty * unitsPerPurchase
  }

  // Intermediate pack unit (e.g. "pkg") — only for custom units not in UOM_GROUPS
  if (
    item.packUOM &&
    sel === item.packUOM.toLowerCase() &&
    sel !== item.purchaseUnit.toLowerCase() &&
    getUnitGroup(item.packUOM) === null
  ) {
    const unitsPerPack = Number(item.packSize)
    if (unitsPerPack > 0) return qty * unitsPerPack
  }

  // Standard weight/volume conversion
  return convertQty(qty, selectedUom, item.baseUnit)
}

/**
 * Convert a baseUnit quantity to the selectedUom — used for displaying the
 * expected quantity in whatever unit the user has chosen.
 */
export function convertBaseToCountUom(
  baseQty: number,
  selectedUom: string,
  item: ItemDims,
): number {
  const sel = selectedUom.toLowerCase()
  const base = item.baseUnit.toLowerCase()

  if (sel === base) return baseQty

  if (sel === item.purchaseUnit.toLowerCase()) {
    const packConv = convertQty(Number(item.packSize), item.packUOM, item.baseUnit)
    const unitsPerPurchase = Number(item.qtyPerPurchaseUnit) * packConv
    if (unitsPerPurchase > 0) return baseQty / unitsPerPurchase
  }

  if (
    item.packUOM &&
    sel === item.packUOM.toLowerCase() &&
    sel !== item.purchaseUnit.toLowerCase() &&
    getUnitGroup(item.packUOM) === null
  ) {
    const unitsPerPack = Number(item.packSize)
    if (unitsPerPack > 0) return baseQty / unitsPerPack
  }

  return convertQty(baseQty, item.baseUnit, selectedUom)
}
