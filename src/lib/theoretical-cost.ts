// src/lib/theoretical-cost.ts
import { fetchRecipeWithCost } from './recipeCosts'

export interface TheoreticalCostResult {
  /** Σ qtySold × cost-per-sold-unit across all line items with a resolvable cost. */
  theoreticalCost: number
  /** Distinct recipes sold that had a resolvable cost. */
  costedRecipes: number
  /** Distinct recipes sold (denominator for coverage). */
  totalRecipes: number
}

/**
 * Sum theoretical plate cost over sold line items.
 * Dedupes recipe lookups; reuses fetchRecipeWithCost so nested PREP costs
 * resolve correctly (do NOT re-implement cost resolution here — see the
 * nested-PREP cost bug history).
 *
 * Cost per sold unit = totalCost / baseYieldQty — the same convention the Menu page
 * and RecipeCard use ("cost / yieldUnit", "totalCost ÷ menuPrice"). We deliberately do
 * NOT key off costPerPortion: that needs a portionSize most MENU recipes never set, and
 * it measures cost per *portion*, not per sold menu item (a sales line's qtySold counts
 * menu items, not portions). A recipe with no resolvable ingredient cost (totalCost 0 or
 * baseYieldQty 0) is treated as uncosted: it contributes 0 and counts against coverage.
 */
export async function theoreticalCostForLineItems(
  lineItems: Array<{ recipeId: string; qtySold: number }>,
): Promise<TheoreticalCostResult> {
  const distinctIds = Array.from(new Set(lineItems.map(li => li.recipeId)))
  const recipes = await Promise.all(distinctIds.map(id => fetchRecipeWithCost(id)))

  const costPerSoldUnit = new Map<string, number | null>()
  distinctIds.forEach((id, i) => {
    const r = recipes[i]
    const unit = r && r.baseYieldQty > 0 && r.totalCost > 0 ? r.totalCost / r.baseYieldQty : null
    costPerSoldUnit.set(id, unit)
  })

  let theoreticalCost = 0
  let costedRecipes = 0
  for (const id of distinctIds) {
    if (costPerSoldUnit.get(id) != null) costedRecipes++
  }
  for (const li of lineItems) {
    const unit = costPerSoldUnit.get(li.recipeId)
    if (unit != null) theoreticalCost += li.qtySold * unit
  }
  return { theoreticalCost, costedRecipes, totalRecipes: distinctIds.length }
}
