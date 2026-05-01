/**
 * UOM conversion utilities specific to the stock count system.
 *
 * Every inventory item stores stockOnHand in its baseUnit.
 * During a count, the user may enter quantities in a different UOM
 * (e.g. purchaseUnit = "box" containing 20 each, or "kg" when baseUnit = "lb").
 * These functions handle converting back to baseUnit for persistence.
 */

import { UOM_GROUPS, convertQty, getUnitGroup } from './uom'

export interface CountableUom {
  label: string
  /** How many baseUnits make up 1 of this UOM. */
  toBase: number
}

interface ItemDims {
  baseUnit: string
  purchaseUnit: string
  qtyPerPurchaseUnit: number
  packSize: number
  packUOM: string
}

/**
 * Returns the UOM options a user can choose from when counting an item.
 * Order: purchaseUnit first (most common counting unit), then baseUnit, then
 * a compatible weight/volume partner if applicable.
 */
export function getCountableUoms(item: ItemDims): CountableUom[] {
  const seen = new Set<string>()
  const result: CountableUom[] = []

  const add = (label: string, toBase: number) => {
    const key = label.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    result.push({ label, toBase })
  }

  // 1. Purchase/pack unit (e.g. "box", "bag", "case") — listed first so it's
  //    the default when counting physical packs off a shelf.
  if (item.purchaseUnit && item.purchaseUnit.toLowerCase() !== item.baseUnit.toLowerCase()) {
    const unitsPerPurchase = Number(item.qtyPerPurchaseUnit) * Number(item.packSize)
    if (unitsPerPurchase > 0) {
      add(item.purchaseUnit, unitsPerPurchase)
    }
  }

  // 1.5. Intermediate pack unit (e.g. "pkg" in case×pkg×each).
  // Only for custom units not in UOM_GROUPS — weight/volume packUOMs (kg, lb…)
  // are already covered by step 3 with the correct conversion factor.
  if (
    item.packUOM &&
    item.packUOM.toLowerCase() !== item.baseUnit.toLowerCase() &&
    item.packUOM.toLowerCase() !== item.purchaseUnit.toLowerCase() &&
    getUnitGroup(item.packUOM) === null
  ) {
    const unitsPerPack = Number(item.packSize)
    if (unitsPerPack > 0) add(item.packUOM, unitsPerPack)
  }

  // 2. Base unit — always available (1:1 with stockOnHand).
  add(item.baseUnit, 1)

  // 3. All practical units from the same weight/volume group so staff can
  //    use whatever scale or measure they have on hand.
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
      // 1 unitLabel = (unitDef.toBase / baseDef.toBase) baseUnits
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

  // Check purchase/pack unit first (custom factor, not in UOM_GROUPS)
  if (sel === item.purchaseUnit.toLowerCase()) {
    const unitsPerPurchase = Number(item.qtyPerPurchaseUnit) * Number(item.packSize)
    if (unitsPerPurchase > 0) return qty * unitsPerPurchase
  }

  // Check intermediate pack unit (e.g. "pkg") — only for custom units not in UOM_GROUPS
  if (
    item.packUOM &&
    sel === item.packUOM.toLowerCase() &&
    sel !== item.purchaseUnit.toLowerCase() &&
    getUnitGroup(item.packUOM) === null
  ) {
    const unitsPerPack = Number(item.packSize)
    if (unitsPerPack > 0) return qty * unitsPerPack
  }

  // Fall back to standard weight/volume conversion
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
    const unitsPerPurchase = Number(item.qtyPerPurchaseUnit) * Number(item.packSize)
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
