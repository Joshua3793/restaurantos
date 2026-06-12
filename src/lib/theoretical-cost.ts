// src/lib/theoretical-cost.ts
import { fetchRecipeWithCost } from './recipeCosts'

export interface TheoreticalCostResult {
  /** Σ qtySold × costPerPortion across all line items with a resolvable cost. */
  theoreticalCost: number
  /** Distinct recipes sold that had a resolvable costPerPortion. */
  costedRecipes: number
  /** Distinct recipes sold (denominator for coverage). */
  totalRecipes: number
}

/**
 * Sum theoretical plate cost over sold line items.
 * Dedupes recipe lookups; reuses fetchRecipeWithCost so nested PREP costs
 * resolve correctly (do NOT re-implement cost resolution here — see the
 * nested-PREP cost bug history).
 * A recipe whose costPerPortion is null (e.g. no portionSize) is treated as
 * uncosted: it contributes 0 and counts against coverage.
 */
export async function theoreticalCostForLineItems(
  lineItems: Array<{ recipeId: string; qtySold: number }>,
): Promise<TheoreticalCostResult> {
  const distinctIds = Array.from(new Set(lineItems.map(li => li.recipeId)))
  const recipes = await Promise.all(distinctIds.map(id => fetchRecipeWithCost(id)))

  const costPerPortion = new Map<string, number | null>()
  distinctIds.forEach((id, i) => costPerPortion.set(id, recipes[i]?.costPerPortion ?? null))

  let theoreticalCost = 0
  let costedRecipes = 0
  for (const id of distinctIds) {
    const cpp = costPerPortion.get(id)
    if (cpp != null) costedRecipes++
  }
  for (const li of lineItems) {
    const cpp = costPerPortion.get(li.recipeId)
    if (cpp != null) theoreticalCost += li.qtySold * cpp
  }
  return { theoreticalCost, costedRecipes, totalRecipes: distinctIds.length }
}
