// ONE conversion for every stock MOVEMENT (a sale's ingredient draw, a prep
// log's draw-down and yield, a wastage line): a quantity in the recipe's or
// log's unit → the item's base unit, through the item's bridges.
//
// This is the same rule recipe costing prices with (dimensionallyCostable +
// convertQtyBridged in src/lib/recipeCosts.ts). Theoretical stock used to call
// bare convertQty here, which passes a cross-dimension quantity through 1:1 —
// 200 g of a per-each bun depleted 200 buns. A movement that genuinely cannot
// be converted (count ↔ measured, no each-measure) now contributes 0 AND is
// reported as `unbridged`, so the drawer can say "not counted — set 1 each = ? g"
// instead of silently inventing a number.
//
// Pure and client-safe: imports only uom + item-model.
import { dimensionallyCostable, convertQtyBridged } from '@/lib/uom'
import { eachMeasureOf, densityOf } from '@/lib/item-model'

/** The item fields a movement conversion needs — spread into any Prisma select. */
export const MOVEMENT_ITEM_SELECT = {
  id: true, baseUnit: true, dimension: true,
  eachMeasureQty: true, eachMeasureUnit: true, densityGPerMl: true,
} as const

export interface MovementItem {
  baseUnit: string
  dimension: string | null
  eachMeasureQty: unknown
  eachMeasureUnit: string | null
  densityGPerMl: unknown
}

/** A movement the item's bridges cannot convert, kept in its own unit for display. */
export interface Unbridged { qty: number; unit: string }

export type MovementQty =
  | { qtyBase: number; unbridged: null }
  | { qtyBase: 0; unbridged: Unbridged }

/**
 * `qty` of `unit` → the item's base unit.
 *  • same dimension           → convertQty (byte-identical to before)
 *  • weight ↔ volume          → through density when the item has one, else 1:1
 *                               (today's tolerated kitchen convention, as costing)
 *  • count ↔ measured, bridge → through the each-measure
 *  • count ↔ measured, none   → 0 + unbridged
 */
export function movementQtyBase(qty: number, unit: string, item: MovementItem): MovementQty {
  const bridge = eachMeasureOf(item)
  if (!dimensionallyCostable(unit, item.baseUnit, bridge)) {
    return { qtyBase: 0, unbridged: { qty, unit } }
  }
  return { qtyBase: convertQtyBridged(qty, unit, item.baseUnit, bridge, densityOf(item)), unbridged: null }
}
