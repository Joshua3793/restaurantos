import { prisma } from '@/lib/prisma'
import { linkedRecipeUnitCost } from '@/lib/recipeCosts'
import { portionsPerBatch } from '@/lib/recipe-portions'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'

/**
 * Recalculates totalCost, costPerPortion, and foodCostPct for any recipe
 * that uses one of the changed inventory items. Optionally creates RecipeAlerts.
 */
export async function recalculateRecipeCosts(
  changedItemIds: string[],
  sessionId?: string,
  // Pre-approval ppb per item that changed (raw items just repriced + prep
  // outputs snapshotted before the prep cascade). Lets us compute the real
  // cost change on the fly. Items not in the map didn't move (old == current).
  priorPpbByItem?: Map<string, number>,
): Promise<{ recipeId: string; changePct: number }[]> {
  if (changedItemIds.length === 0) return []

  // Find all recipes that directly use any of the changed items
  const affectedIngredients = await prisma.recipeIngredient.findMany({
    where: { inventoryItemId: { in: changedItemIds } },
    select: { recipeId: true },
    distinct: ['recipeId'],
  })

  const affectedRecipeIds = affectedIngredients.map(i => i.recipeId)
  if (affectedRecipeIds.length === 0) return []

  const recipes = await prisma.recipe.findMany({
    where: { id: { in: affectedRecipeIds } },
    include: {
      ingredients: {
        include: {
          inventoryItem: { select: { id: true, ...PRICING_SELECT } },
          linkedRecipe: {
            select: {
              yieldUnit: true,
              inventoryItem: { select: { id: true, ...PRICING_SELECT } },
            },
          },
        },
      },
    },
  })

  const alerts: { recipeId: string; changePct: number }[] = []

  for (const recipe of recipes) {
    let newTotalCost = 0
    let oldTotalCost = 0

    for (const ing of recipe.ingredients) {
      const qty = Number(ing.qtyBase)

      if (ing.inventoryItem) {
        const cur = pricePerBaseUnit(asChainItem(ing.inventoryItem))
        // Old ppb when the caller captured a pre-approval price for this item;
        // otherwise it didn't move, so old == current and contributes 0 change.
        const old = priorPpbByItem?.get(ing.inventoryItem.id) ?? cur
        newTotalCost += qty * cur
        oldTotalCost += qty * old
      } else if (ing.linkedRecipe) {
        // Sub-recipe cost comes off the spine (synced InventoryItem), which already
        // accounts for nested PREP-in-PREP ingredients. See linkedRecipeUnitCost.
        const { costPerUnit } = linkedRecipeUnitCost(ing.linkedRecipe)
        const linkedItemId = ing.linkedRecipe.inventoryItem?.id
        const oldUnit = (linkedItemId != null ? priorPpbByItem?.get(linkedItemId) : undefined) ?? costPerUnit
        newTotalCost += qty * costPerUnit
        oldTotalCost += qty * oldUnit
      }
    }

    const portions = portionsPerBatch(
      Number(recipe.baseYieldQty) || 1,
      recipe.yieldUnit,
      recipe.portionSize !== null ? Number(recipe.portionSize) : null,
      recipe.portionUnit,
    ) ?? 1
    const newCostPerPortion = portions > 0 ? newTotalCost / portions : newTotalCost
    const oldCostPerPortion = portions > 0 ? oldTotalCost / portions : oldTotalCost
    const menuPrice   = Number(recipe.menuPrice) || 0
    const newFoodCostPct = menuPrice > 0 ? newCostPerPortion / menuPrice : null

    // Cost change is computed on the fly from old → new ingredient prices. No
    // cached cost is stored on the recipe — that would be a divergence bug
    // (every cost reads the pricePerBaseUnit spine at query time).
    const changePct = oldCostPerPortion > 0
      ? ((newCostPerPortion - oldCostPerPortion) / oldCostPerPortion) * 100
      : 0

    if (sessionId && newFoodCostPct !== null) {
      const exceededThreshold = newFoodCostPct > 0.30
      if (exceededThreshold) {
        const existing = await prisma.recipeAlert.findFirst({
          where: { sessionId, recipeId: recipe.id },
        })
        if (!existing) {
          await prisma.recipeAlert.create({
            data: {
              sessionId,
              recipeId: recipe.id,
              previousCost: oldCostPerPortion,
              newCost: newCostPerPortion,
              changePct,
              newFoodCostPct,
              exceededThreshold,
            },
          })
        }
      }
    }

    alerts.push({ recipeId: recipe.id, changePct })
  }

  return alerts
}
