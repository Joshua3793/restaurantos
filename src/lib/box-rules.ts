// The rules a supplier box (an `InventorySupplierPrice` row) must meet. PURE.
//
// A box stores only its own pack (packChain) and price (pricing); the ITEM it
// belongs to supplies the measure, the base unit and the bridges (each-measure,
// density). So a box is judged as the item would be if it adopted the box —
// exactly what `syncPrimaryOfferToItem` does when the box is (or becomes) main.

import {
  DIMENSION_BASE, densityOf, eachMeasureOf, validateChainItem,
  type ChainItem, type Dimension, type PackLink, type Pricing,
} from '@/lib/item-model'
import { normItemCode } from '@/lib/invoice/line-format'
import { tombstonedRows, TOMBSTONE_EDIT_ERROR } from '@/lib/item-merge-rows'

/** The item facts a box is judged against — a Prisma item row fits directly. */
export interface ChainRowLike {
  dimension: string
  baseUnit: string | null
  isStocked: boolean
  eachMeasureQty?: unknown
  eachMeasureUnit?: string | null
  densityGPerMl?: unknown
}

export interface BoxInput {
  supplierId: string
  supplierItemCode?: string | null
  packChain: PackLink[]
  pricing: Pricing
}

/** [] when the box fits the item. A stocked item's box must be priced above $0
 *  ('price must be above $0'); every other entry means the box does not fit how
 *  the item is measured. */
export function validateBox(item: ChainRowLike, box: BoxInput): string[] {
  const dimension = item.dimension as Dimension
  const ci: ChainItem = {
    dimension,
    baseUnit: item.baseUnit ?? DIMENSION_BASE[dimension],
    packChain: Array.isArray(box.packChain) ? box.packChain : [],
    pricing: box.pricing,
    eachMeasure: eachMeasureOf(item),
    densityGPerMl: densityOf(item),
  }
  const errs = validateChainItem(ci, { requirePositivePrice: item.isStocked })
  const mode = (box.pricing as { mode?: unknown } | null | undefined)?.mode
  if (mode !== 'PACK' && mode !== 'RATE') errs.push('pricing must be PACK or RATE')
  return errs
}

/** A supplier's product code as stored on a box: trimmed, upper-case, '' → null. */
export function normalizeCode(code: string | null | undefined): string | null {
  return normItemCode(code) || null
}

// ── The routes' shared refusals (plain data; the routes wrap them in a response) ──

/** Prisma select for the item every box route reads first. */
export const BOX_ITEM_SELECT = {
  id: true, mergedIntoId: true, lastUpdated: true, dimension: true, baseUnit: true, isStocked: true,
  eachMeasureQty: true, eachMeasureUnit: true, densityGPerMl: true,
  recipe: { select: { id: true } },
} as const

export const PREP_OWNED_BOX_ERROR = 'A recipe-made item has no supplier boxes.'

export const ITEM_NOT_FOUND = { error: "That item doesn't exist.", code: 'NOT_FOUND' } as const

/** The 409 every box route shares for an item that cannot have boxes edited:
 *  merged away (tombstone), or recipe-made (priced by its recipe, never a box). */
export function itemRefusal(item: { id: string; mergedIntoId: string | null; recipe: unknown }):
  { error: string; code: 'TOMBSTONE' | 'PREP_OWNED' } | null {
  if (tombstonedRows([item]).length) return { error: TOMBSTONE_EDIT_ERROR, code: 'TOMBSTONE' }
  if (item.recipe) return { error: PREP_OWNED_BOX_ERROR, code: 'PREP_OWNED' }
  return null
}
export const DUPLICATE_BOX_ERROR = 'This supplier already has a box for this product. Edit that box instead.'
const ZERO = 'price must be above $0'

/** `validateBox` errors → the 400 the routes send, or null when there are none.
 *  ZERO_PRICE only when $0 is the box's ONLY problem: a box that does not fit
 *  the item at all (say an unknown pricing mode, which also reads as $0) is
 *  INVALID, with every reason in `details`. */
export function boxRefusal(errors: string[]):
  { error: string; code: 'ZERO_PRICE' | 'INVALID'; details?: string[] } | null {
  if (!errors.length) return null
  if (errors.every(e => e === ZERO)) return { error: "A stocked item's box needs a price above $0.", code: 'ZERO_PRICE' }
  return { error: "That box doesn't fit how this item is measured.", code: 'INVALID', details: errors }
}

/** Prisma `where` for "this supplier's box with this product code" — the same
 *  product the unique index (inventoryItemId, supplierId, COALESCE(code, ''))
 *  keys on, matched case-insensitively as the invoice matcher does. */
export function sameProductWhere(code: string | null) {
  return code
    ? { supplierItemCode: { equals: code, mode: 'insensitive' as const } }
    : { OR: [{ supplierItemCode: null }, { supplierItemCode: '' }] }
}
