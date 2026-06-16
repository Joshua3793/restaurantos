import { prisma } from '@/lib/prisma'
import { linkedRecipeUnitCost } from '@/lib/recipeCosts'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'

/**
 * Recalculates totalCost, costPerPortion, and foodCostPct for any recipe
 * that uses one of the changed inventory items. Optionally creates RecipeAlerts.
 */
export async function recalculateRecipeCosts(
  changedItemIds: string[],
  sessionId?: string
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
              inventoryItem: { select: { ...PRICING_SELECT } },
            },
          },
        },
      },
    },
  })

  const alerts: { recipeId: string; changePct: number }[] = []

  for (const recipe of recipes) {
    let newTotalCost = 0

    for (const ing of recipe.ingredients) {
      const qty = Number(ing.qtyBase)

      if (ing.inventoryItem) {
        newTotalCost += qty * pricePerBaseUnit(asChainItem(ing.inventoryItem))
      } else if (ing.linkedRecipe) {
        // Sub-recipe cost comes off the spine (synced InventoryItem), which already
        // accounts for nested PREP-in-PREP ingredients. See linkedRecipeUnitCost.
        const { costPerUnit } = linkedRecipeUnitCost(ing.linkedRecipe)
        newTotalCost += qty * costPerUnit
      }
    }

    const portionSize = Number(recipe.portionSize) || 0
    const baseYield   = Number(recipe.baseYieldQty) || 1
    const portions    = portionSize > 0 ? baseYield / portionSize : 1
    const newCostPerPortion = portions > 0 ? newTotalCost / portions : newTotalCost
    const menuPrice   = Number(recipe.menuPrice) || 0
    const newFoodCostPct = menuPrice > 0 ? newCostPerPortion / menuPrice : null

    // Fetch current stored cost to compute change pct
    const currentRecipe = await prisma.recipe.findUnique({
      where: { id: recipe.id },
      select: { menuPrice: true },
    })
    // We don't store totalCost on Recipe yet — estimate from ingredients at old prices
    // For simplicity, compare newCostPerPortion vs what was stored implicitly
    // We'll just emit an alert based on the diff magnitude if sessionId is provided

    // Update recipe — we don't currently store totalCost/costPerPortion in schema
    // so we only create alerts when we have a prior reference
    // For now, emit change pct relative to 0 baseline when no prior exists
    const changePct = 0 // Will be computed after we store a baseline

    if (sessionId && newFoodCostPct !== null) {
      const exceededThreshold = newFoodCostPct > 0.30
      if (exceededThreshold) {
        // Create a recipe alert for threshold exceeded
        const existing = await prisma.recipeAlert.findFirst({
          where: { sessionId, recipeId: recipe.id },
        })
        if (!existing) {
          await prisma.recipeAlert.create({
            data: {
              sessionId,
              recipeId: recipe.id,
              previousCost: newCostPerPortion, // best we can do without stored history
              newCost: newCostPerPortion,
              changePct: 0,
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

/**
 * Compute the theoretical cost of a recipe from current inventory prices.
 * Returns { totalCost, costPerPortion, foodCostPct }
 */
export async function computeRecipeCost(recipeId: string): Promise<{
  totalCost: number
  costPerPortion: number
  foodCostPct: number | null
}> {
  const recipe = await prisma.recipe.findUniqueOrThrow({
    where: { id: recipeId },
    include: {
      ingredients: {
        include: {
          inventoryItem: { select: { ...PRICING_SELECT } },
          linkedRecipe: {
            select: {
              yieldUnit: true,
              inventoryItem: { select: { ...PRICING_SELECT } },
            },
          },
        },
      },
    },
  })

  let totalCost = 0
  for (const ing of recipe.ingredients) {
    const qty = Number(ing.qtyBase)
    if (ing.inventoryItem) {
      totalCost += qty * pricePerBaseUnit(asChainItem(ing.inventoryItem))
    } else if (ing.linkedRecipe) {
      // Sub-recipe cost from the spine (synced InventoryItem) — includes nested PREP.
      const { costPerUnit } = linkedRecipeUnitCost(ing.linkedRecipe)
      totalCost += qty * costPerUnit
    }
  }

  const portionSize = Number(recipe.portionSize) || 0
  const baseYield   = Number(recipe.baseYieldQty) || 1
  const portions    = portionSize > 0 ? baseYield / portionSize : 1
  const costPerPortion = portions > 0 ? totalCost / portions : totalCost
  const menuPrice = Number(recipe.menuPrice) || 0
  const foodCostPct = menuPrice > 0 ? costPerPortion / menuPrice : null

  return { totalCost, costPerPortion, foodCostPct }
}
