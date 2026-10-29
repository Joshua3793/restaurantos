/**
 * By-products ("Comes off this batch") — the pure maths shared by the server
 * costing and the recipe editor. A PREP batch can yield more than its main
 * output (a brisket also gives trim and fat); each by-product is credited at
 * its own item's live price, and the batch cost the rest of the app reads is
 * ingredients − credits. No Prisma here: the editor imports this too.
 */
import { formatCurrency, getUnitDimension } from './utils'
import { convertQty } from './uom'
import type { CostBasis } from './cost-basis'

export interface ByproductWithCredit {
  id: string
  sortOrder: number
  inventoryItemId: string
  itemName: string
  qty: number
  unit: string
  notes: string | null
  /** The by-product item's base unit — the editor's unit picker filters on it. */
  itemBaseUnit: string
  pricePerBaseUnit: number
  /** qty × the item's price, through the same conversion an ingredient line uses. */
  credit: number
  /** Same meaning as on an ingredient line: the unit can't be costed against the item. */
  dimensionConflict: boolean
  costBasis: CostBasis
  /** Linked to an item whose price is $0 — "no price yet", never a silent $0 credit. */
  unpriced: boolean
  // ── Editor-only fields, filled by the server readers (absent in pure costing). ──
  /** ISO — the item's version, sent back with a price edit (stale-save guard). */
  itemLastUpdated?: string
  itemPackChain?: unknown
  itemPricing?: unknown
  /** The item has supplier boxes: its price lives on the primary box, read-only here. */
  hasOffers?: boolean
  primarySupplierName?: string | null
}

/** The batch cost after credits. Never below $0 — an over-credit is flagged, not negative. */
export function netCost(gross: number, credit: number): number {
  return Math.max(0, gross - credit)
}

export function creditGuardMessage(credit: number, gross: number): string {
  return `Credits ${formatCurrency(credit)} are more than the batch costs ${formatCurrency(gross)} — check the weights`
}

/** Grams for a weight or volume amount (ml read as g — the kitchen density≈1
 *  convention the costing already uses); null for anything else. */
function toGrams(qty: number, unit: string): number | null {
  const dim = getUnitDimension(unit)
  if (dim === 'weight') return convertQty(qty, unit, 'g')
  if (dim === 'volume') return convertQty(qty, unit, 'ml')
  return null
}

/**
 * Where a batch's raw weight went: main yield, each by-product, and what was
 * lost (cooking, trimming to waste). All in grams. Null when the batch yields
 * a count, or when nothing else comes off it — the bar has nothing to say.
 */
export function yieldBreakdown(r: {
  ingredients: Array<{ qtyBase: number; unit: string; ingredientType: 'inventory' | 'recipe' | 'custom' }>
  baseYieldQty: number
  yieldUnit: string
  byproducts: Array<{ itemName: string; qty: number; unit: string }>
}): { input: number; main: number; parts: Array<{ name: string; qty: number }>; lost: number; overflow: boolean } | null {
  const main = toGrams(r.baseYieldQty, r.yieldUnit)
  if (main === null || r.byproducts.length === 0) return null
  const input = r.ingredients.reduce((s, i) => s + (toGrams(i.qtyBase, i.unit) ?? 0), 0)
  const parts = r.byproducts.map(b => ({ name: b.itemName, qty: toGrams(b.qty, b.unit) ?? 0 }))
  const out = main + parts.reduce((s, p) => s + p.qty, 0)
  return { input, main, parts, lost: input - out, overflow: out > input * 1.02 }
}
