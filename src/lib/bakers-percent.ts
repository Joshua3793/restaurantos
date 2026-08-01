import { convertQty, getUnitGroup } from '@/lib/uom'

/** The minimum an ingredient must expose to take part in baker's percentages. */
export interface BakersIngredient {
  id: string
  qtyBase: number | string
  unit: string | null
}

/** Compute baker's percentages relative to a base (reference) ingredient.
 *  Weight and volume both included; volume uses 1 ml = 1 g approximation.
 *  Count / each ingredients are excluded (return null).
 *
 *  Returns `{}` when the base ingredient is missing from the list or can't be
 *  expressed in grams — callers treat an empty map as "no baker's % to show". */
export function computeBakersPercents(
  ingredients: BakersIngredient[],
  baseIngId: string
): Record<string, number | null> {
  const base = ingredients.find(i => i.id === baseIngId)
  if (!base) return {}

  const toGrams = (qty: number, unit: string | null | undefined): number | null => {
    if (!unit) return null
    const group = getUnitGroup(unit)
    if (group === 'Weight') return convertQty(qty, unit, 'g')
    if (group === 'Volume') return convertQty(qty, unit, 'ml') // 1 ml ≈ 1 g
    return null
  }

  const baseGrams = toGrams(Number(base.qtyBase), base.unit)
  if (baseGrams === null || baseGrams <= 0) return {}

  return Object.fromEntries(
    ingredients.map(ing => {
      if (ing.id === baseIngId) return [ing.id, 100]
      const grams = toGrams(Number(ing.qtyBase), ing.unit)
      return [ing.id, grams === null ? null : Math.round((grams / baseGrams) * 1000) / 10]
    })
  )
}
