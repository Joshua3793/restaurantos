// Units a waste entry can be logged in, and its cost estimate — both through the
// SAME movement rule the server books the entry with (src/lib/movement-qty.ts), so
// the form never offers a unit the save would refuse and the preview never prices
// 2 kg as 2 g.
//
// The old picker offered every unit of the base unit's family plus 'batch' (and
// pkg/case for per-each items). None of those has a fixed size for a raw item:
// 'batch' on Butter was refused by the server, 'case' on Buns booked 1 case as 1 bun.
//
// Pure and client-safe.
import { movementQtyBase, type MovementItem } from '@/lib/movement-qty'
import { eachMeasureOf } from '@/lib/item-model'
import { unitMeasure } from '@/lib/uom'

export interface WasteItem extends MovementItem {
  id: string
  itemName: string
  /** Computed $/base from the inventory list; null when the viewer can't see money. */
  pricePerBaseUnit?: number | string | null
}

const WEIGHT = ['g', 'kg', 'lb', 'oz']
const VOLUME = ['ml', 'l']

/** Sensible units for one item, its own base unit first. */
export function wasteUnits(item: Pick<WasteItem, 'baseUnit' | 'eachMeasureQty' | 'eachMeasureUnit'> | null | undefined): string[] {
  if (!item) return ['each']
  const dim = unitMeasure(item.baseUnit)
  let units: string[]
  if (dim === 'weight') units = WEIGHT
  else if (dim === 'volume') units = VOLUME
  else {
    // A per-each item can be logged by weight/volume only through its each-measure
    // (1 loaf = 1100 g); without one, grams cannot become loaves.
    const bridge = eachMeasureOf(item as MovementItem)
    const bd = bridge ? unitMeasure(bridge.unit) : null
    units = ['each', ...(bd === 'weight' ? WEIGHT : bd === 'volume' ? VOLUME : [])]
  }
  return [item.baseUnit, ...units.filter(u => u !== item.baseUnit)]
}

/** Estimated cost of `qty` `unit` of the item, or null when it can't be priced. */
export function wasteCost(item: WasteItem | null | undefined, qty: number, unit: string): number | null {
  if (!item || !(qty > 0) || item.pricePerBaseUnit == null) return null
  const ppb = Number(item.pricePerBaseUnit)
  if (!Number.isFinite(ppb)) return null
  const conv = movementQtyBase(qty, unit, item)
  if (conv.unbridged) return null
  return conv.qtyBase * ppb
}

/** "2 kg", "0.5 l", "12 each" — trims trailing zeros. */
export function fmtWasteQty(qty: number | string, unit: string): string {
  const n = Number(qty)
  const s = Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(qty)
  return `${s} ${unit}`
}
