/**
 * UOM conversion utilities specific to the stock count system.
 *
 * Every inventory item stores stockOnHand in its baseUnit.
 * During a count, the user may enter quantities in a different UOM
 * (e.g. purchaseUnit = "box" containing 20 each, or "kg" when baseUnit = "lb").
 * These functions handle converting back to baseUnit for persistence.
 */

import { UOM_GROUPS, convertQty } from './uom'

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

  // 2. Base unit — always available (1:1 with stockOnHand).
  add(item.baseUnit, 1)

  // 3. A single compatible "partner" unit for weight/volume bases so staff
  //    can count in whichever system their scale uses.
  const WEIGHT_PARTNERS: Record<string, string> = {
    lb: 'kg', kg: 'lb', g: 'oz', oz: 'g',
  }
  const VOLUME_PARTNERS: Record<string, string> = {
    l: 'fl oz', ml: 'l', 'fl oz': 'l',
  }

  const partners: Record<string, string> = { ...WEIGHT_PARTNERS, ...VOLUME_PARTNERS }
  const partnerLabel = partners[item.baseUnit.toLowerCase()]

  if (partnerLabel) {
    // Compute conversion factor via UOM_GROUPS
    for (const group of UOM_GROUPS) {
      const baseDef    = group.units.find(u => u.label.toLowerCase() === item.baseUnit.toLowerCase())
      const partnerDef = group.units.find(u => u.label.toLowerCase() === partnerLabel.toLowerCase())
      if (baseDef && partnerDef) {
        // 1 partnerLabel = (partnerDef.toBase / baseDef.toBase) baseUnits
        add(partnerDef.label, partnerDef.toBase / baseDef.toBase)
        break
      }
    }
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

  // Fall back to standard weight/volume conversion
  const converted = convertQty(qty, selectedUom, item.baseUnit)
  return converted
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

  return convertQty(baseQty, item.baseUnit, selectedUom)
}
