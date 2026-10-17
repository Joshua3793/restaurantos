// The recipe page's rules for an ingredient line with no amount.

interface LineLike {
  ingredientType: 'inventory' | 'recipe' | 'custom' | string
  qtyBase: number
  notes: string | null
}

/**
 * A qty-0 line that carries a note was left without an amount on purpose — a
 * scanned "salt to taste" line is saved linked (so it carries the item's
 * allergens), qty 0, with the page's words as its note.
 */
function deliberatelyNoQty(ing: LineLike): boolean {
  return ing.qtyBase === 0 && !!ing.notes?.trim()
}

/** The gold "Needs qty" mark: an item line with no amount that is not a deliberate "to taste". */
export function ingredientNeedsQty(ing: LineLike): boolean {
  return ing.ingredientType === 'inventory' && (!ing.qtyBase || ing.qtyBase === 0) && !deliberatelyNoQty(ing)
}

/** Open the amount box (focused) on first paint: an empty line that is waiting for its amount. */
export function opensQtyEditor(ing: LineLike): boolean {
  return ing.qtyBase === 0 && !deliberatelyNoQty(ing)
}
