/**
 * Server-side recipe cost computation helpers.
 * All costs are computed at query time from live inventory pricePerBaseUnit.
 * Unit conversions are applied so e.g. 5 kg of an item priced per g costs correctly.
 */
import { prisma } from './prisma'
import { convertQty } from './uom'
import { getUnitConv } from './utils'

export interface IngredientWithCost {
  id: string
  sortOrder: number
  qtyBase: number
  unit: string
  notes: string | null
  recipePercent: number | null
  inventoryItemId: string | null
  linkedRecipeId: string | null
  ingredientName: string
  ingredientType: 'inventory' | 'recipe'
  pricePerBaseUnit: number
  lineCost: number
  /** The base unit of the linked inventory item / recipe — used to filter compatible UOM options in the UI */
  ingredientBaseUnit: string
}

export interface RecipeWithCost {
  id: string
  name: string
  type: string
  categoryId: string
  categoryName: string
  categoryColor: string | null
  inventoryItemId: string | null
  baseYieldQty: number
  yieldUnit: string
  portionSize: number | null
  portionUnit: string | null
  menuPrice: number | null
  isActive: boolean
  notes: string | null
  steps: string[]
  createdAt: Date
  updatedAt: Date
  ingredients: IngredientWithCost[]
  totalCost: number
  costPerPortion: number | null
  foodCostPct: number | null
  allergens: string[]
  baseIngredientId: string | null
}

// Prisma returns Decimal for numeric DB columns; accept Decimal alongside number | string
// (Decimal implements toNumber() and toString() so Number() works on all three)
type Numeric = number | string | { toNumber(): number; toString(): string }

/** Compute cost for a recipe, applying unit conversions for every ingredient. */
export function computeRecipeCost(
  recipe: {
    baseYieldQty: Numeric
    portionSize: Numeric | null
    menuPrice: Numeric | null
    ingredients: Array<{
      id: string
      sortOrder: number
      qtyBase: Numeric
      unit: string
      notes: string | null
      recipePercent?: Numeric | null
      inventoryItemId: string | null
      linkedRecipeId: string | null
      inventoryItem: { itemName: string; baseUnit: string; pricePerBaseUnit: Numeric } | null
      linkedRecipe: { name: string } | null
      _linkedRecipeCostPerUnit?: number  // cost per 1 unit of the linked recipe's yieldUnit
      _linkedRecipeYieldUnit?: string    // yieldUnit of the linked recipe
    }>
  }
): { totalCost: number; costPerPortion: number | null; foodCostPct: number | null; ingredients: IngredientWithCost[] } {

  const ingredientsWithCost: IngredientWithCost[] = recipe.ingredients.map(ing => {
    const qty = Number(ing.qtyBase)
    let pricePerBaseUnit = 0
    let ingredientName = 'Unknown'
    let ingredientType: 'inventory' | 'recipe' = 'inventory'
    let lineCostQty = qty   // qty converted to the ingredient's base unit for cost maths
    let ingredientBaseUnit = ing.unit  // fallback: use current unit as base

    if (ing.inventoryItem) {
      pricePerBaseUnit   = Number(ing.inventoryItem.pricePerBaseUnit)
      ingredientName     = ing.inventoryItem.itemName
      ingredientType     = 'inventory'
      ingredientBaseUnit = ing.inventoryItem.baseUnit
      // Convert recipe unit → inventory base unit before multiplying by price
      lineCostQty = convertQty(qty, ing.unit, ing.inventoryItem.baseUnit)
    } else if (ing.linkedRecipe) {
      pricePerBaseUnit   = ing._linkedRecipeCostPerUnit ?? 0
      ingredientName     = ing.linkedRecipe.name
      ingredientType     = 'recipe'
      // Convert recipe unit → linked recipe's yield unit before multiplying by price
      const yieldUnit    = ing._linkedRecipeYieldUnit ?? ing.unit
      ingredientBaseUnit = yieldUnit
      lineCostQty        = convertQty(qty, ing.unit, yieldUnit)
    }

    return {
      id: ing.id,
      sortOrder: ing.sortOrder,
      qtyBase: qty,
      unit: ing.unit,
      notes: ing.notes,
      recipePercent: ing.recipePercent !== undefined && ing.recipePercent !== null ? Number(ing.recipePercent) : null,
      inventoryItemId: ing.inventoryItemId,
      linkedRecipeId: ing.linkedRecipeId,
      ingredientName,
      ingredientType,
      pricePerBaseUnit,
      lineCost: lineCostQty * pricePerBaseUnit,
      ingredientBaseUnit,
    }
  })

  const totalCost    = ingredientsWithCost.reduce((s, i) => s + i.lineCost, 0)
  const baseYieldQty = Number(recipe.baseYieldQty)
  const portionSize  = recipe.portionSize !== null ? Number(recipe.portionSize) : null
  const menuPrice    = recipe.menuPrice   !== null ? Number(recipe.menuPrice)   : null

  let costPerPortion: number | null = null
  if (portionSize !== null && portionSize > 0 && baseYieldQty > 0) {
    const portions = baseYieldQty / portionSize
    costPerPortion = portions > 0 ? totalCost / portions : null
  }

  const foodCostPct =
    costPerPortion !== null && menuPrice !== null && menuPrice > 0
      ? (costPerPortion / menuPrice) * 100
      : null

  return { totalCost, costPerPortion, foodCostPct, ingredients: ingredientsWithCost }
}

/**
 * Cost per 1 unit of a linked PREP sub-recipe's yield, read from the spine.
 *
 * A PREP recipe's fully-resolved cost — including any nested PREP-in-PREP
 * ingredients — is canonically stored on its synced `InventoryItem.pricePerBaseUnit`
 * (see `syncPrepToInventory`). Read that value directly.
 *
 * Re-deriving the cost by summing the sub-recipe's own ingredient rows (the old
 * approach) silently drops any ingredient that is itself a linked PREP recipe —
 * those rows have no `inventoryItem`, so they were counted as $0, undercounting
 * every recipe that nests a prep inside a prep (e.g. Hollandaise → Clarified Butter).
 *
 * Returns the cost per 1 unit of `yieldUnit`, where `yieldUnit` is the synced
 * item's `baseUnit` (the unit `pricePerBaseUnit` is denominated in).
 */
export function linkedRecipeUnitCost(linked: {
  yieldUnit: string
  inventoryItem: { pricePerBaseUnit: Numeric; baseUnit: string } | null
}): { costPerUnit: number; yieldUnit: string } {
  const item = linked.inventoryItem
  return {
    costPerUnit: item ? Number(item.pricePerBaseUnit) : 0,
    yieldUnit:   item?.baseUnit ?? linked.yieldUnit,
  }
}

/** Fetch a full recipe with computed costs, resolving linked recipe costs. */
export async function fetchRecipeWithCost(id: string): Promise<RecipeWithCost | null> {
  const recipe = await prisma.recipe.findUnique({
    where: { id },
    include: {
      category: true,
      ingredients: {
        include: {
          inventoryItem: { select: { itemName: true, baseUnit: true, pricePerBaseUnit: true, allergens: true } },
          linkedRecipe: {
            select: {
              name: true,
              yieldUnit: true,
              inventoryItem: { select: { baseUnit: true, pricePerBaseUnit: true, allergens: true } },
            },
          },
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })
  if (!recipe) return null

  // Resolve linked recipe cost-per-unit (with conversion inside the linked recipe too)
  const ingredientsWithLinked = recipe.ingredients.map(ing => {
    let linkedCostPerUnit = 0
    let linkedYieldUnit   = ing.unit
    if (ing.linkedRecipe) {
      const resolved    = linkedRecipeUnitCost(ing.linkedRecipe)
      linkedCostPerUnit = resolved.costPerUnit
      linkedYieldUnit   = resolved.yieldUnit
    }
    return { ...ing, _linkedRecipeCostPerUnit: linkedCostPerUnit, _linkedRecipeYieldUnit: linkedYieldUnit }
  })

  const { totalCost, costPerPortion, foodCostPct, ingredients } = computeRecipeCost({
    ...recipe,
    ingredients: ingredientsWithLinked,
  })

  const allergens = Array.from(new Set(recipe.ingredients.flatMap(ing => [
    ...(ing.inventoryItem?.allergens ?? []),
    // Linked PREP allergens come off its synced InventoryItem, which carries the
    // recipe's full (incl. nested) allergen set — see syncPrepToInventory.
    ...(ing.linkedRecipe?.inventoryItem?.allergens ?? []),
  ])))

  return {
    id: recipe.id,
    name: recipe.name,
    type: recipe.type,
    categoryId: recipe.categoryId,
    categoryName: recipe.category.name,
    categoryColor: recipe.category.color,
    inventoryItemId: recipe.inventoryItemId,
    baseYieldQty: Number(recipe.baseYieldQty),
    yieldUnit: recipe.yieldUnit,
    portionSize: recipe.portionSize !== null ? Number(recipe.portionSize) : null,
    portionUnit: recipe.portionUnit,
    menuPrice: recipe.menuPrice !== null ? Number(recipe.menuPrice) : null,
    isActive: recipe.isActive,
    notes: recipe.notes,
    steps: recipe.steps,
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
    ingredients,
    totalCost,
    costPerPortion,
    foodCostPct,
    allergens,
    baseIngredientId: recipe.baseIngredientId ?? null,
  }
}

/**
 * After any ingredient change on a PREP recipe, sync cost to its linked InventoryItem.
 * Updates ALL pricing fields so the inventory display matches the recipe exactly.
 */
export async function syncPrepToInventory(recipeId: string) {
  const recipe = await fetchRecipeWithCost(recipeId)
  if (!recipe || recipe.type !== 'PREP' || !recipe.inventoryItemId) return

  const baseYieldQty     = recipe.baseYieldQty > 0 ? recipe.baseYieldQty : 1
  const yieldUnit        = recipe.yieldUnit
  const pricePerBaseUnit = recipe.totalCost / baseYieldQty

  // Preserve the user-chosen countUOM; only recompute conversionFactor from it
  const current = await prisma.inventoryItem.findUnique({
    where:  { id: recipe.inventoryItemId },
    select: { countUOM: true },
  })
  const countUOM = current?.countUOM ?? yieldUnit

  // conversionFactor = how many baseUnits per 1 countUnit
  // Uses getUnitConv (same constants as pricing) so recipe costs stay consistent with inventory
  let conversionFactor = getUnitConv(countUOM) / getUnitConv(yieldUnit)
  // 'batch' is a special pseudo-unit: 1 batch = full recipe yield
  if (countUOM.toLowerCase() === 'batch') conversionFactor = baseYieldQty
  // Incompatible or unknown units: getUnitConv returns 1 for both → ratio = 1 (safe fallback)

  await prisma.inventoryItem.update({
    where: { id: recipe.inventoryItemId },
    data: {
      purchasePrice:      recipe.totalCost,
      pricePerBaseUnit,
      baseUnit:           yieldUnit,
      packUOM:            yieldUnit,
      packSize:           baseYieldQty,
      qtyPerPurchaseUnit: 1,
      purchaseUnit:       'batch',
      conversionFactor,
      allergens:          recipe.allergens,
      lastUpdated: new Date(),
    },
  })
}

/**
 * Propagate spine price changes to every PREP recipe that depends on the changed
 * inventory items — directly OR transitively (prep-in-prep) — by re-syncing each
 * affected PREP recipe's computed cost back to its linked InventoryItem.
 *
 * Why this is needed: a PREP recipe's cost is computed live from its ingredients'
 * `pricePerBaseUnit`, but the recipe's OWN synced `InventoryItem.pricePerBaseUnit`
 * (the spine value every OTHER recipe / report / count reads) is written only by
 * `syncPrepToInventory`. Historically that ran only on a recipe edit, so an
 * invoice price change left every PREP using that ingredient — and every PREP
 * using THAT prep's output (e.g. Hollandaise → Clarified Butter) — stale until
 * someone re-saved it.
 *
 * Algorithm: worklist over the dependency graph. Seed with the changed items;
 * re-sync each consuming PREP; if its output price actually moves, enqueue that
 * output item so recipes built on it re-sync too. The re-triggering yields
 * leaf-first ordering without an explicit topological sort, and a per-recipe
 * sync cap bounds the work even if the graph contains a cycle.
 *
 * @returns ids of PREP output InventoryItems whose pricePerBaseUnit changed
 *          (useful for cascading recipe-cost alerts to MENU recipes).
 */
export async function propagatePrepCostChanges(changedItemIds: string[]): Promise<string[]> {
  const seedIds = [...new Set(changedItemIds.filter(Boolean))]
  if (seedIds.length === 0) return []

  const prepRecipes = await prisma.recipe.findMany({
    where: { type: 'PREP', inventoryItemId: { not: null } },
    select: {
      id: true,
      inventoryItemId: true,
      ingredients: { select: { inventoryItemId: true, linkedRecipeId: true } },
    },
  })
  if (prepRecipes.length === 0) return []

  // recipeId → its synced output InventoryItem id
  const outputItemOf = new Map<string, string>()
  for (const r of prepRecipes) if (r.inventoryItemId) outputItemOf.set(r.id, r.inventoryItemId)

  // input InventoryItem id → PREP recipes that consume it. A linkedRecipe
  // ingredient depends on that sub-recipe's OUTPUT item (the spine it reads).
  const consumersOfItem = new Map<string, Set<string>>()
  const addConsumer = (itemId: string | null | undefined, recipeId: string) => {
    if (!itemId) return
    const set = consumersOfItem.get(itemId) ?? new Set<string>()
    set.add(recipeId)
    consumersOfItem.set(itemId, set)
  }
  for (const r of prepRecipes) {
    for (const ing of r.ingredients) {
      addConsumer(ing.inventoryItemId, r.id)
      if (ing.linkedRecipeId) addConsumer(outputItemOf.get(ing.linkedRecipeId), r.id)
    }
  }

  const movedOutputs = new Set<string>()
  const syncCount = new Map<string, number>()
  const maxSyncsPerRecipe = prepRecipes.length + 2  // safety bound for cyclic graphs

  const queue: string[] = [...seedIds]
  while (queue.length > 0) {
    const itemId = queue.shift()!
    const consumers = consumersOfItem.get(itemId)
    if (!consumers) continue
    for (const recipeId of consumers) {
      const n = syncCount.get(recipeId) ?? 0
      if (n >= maxSyncsPerRecipe) continue
      syncCount.set(recipeId, n + 1)

      const outId = outputItemOf.get(recipeId)
      if (!outId) continue
      const before = await prisma.inventoryItem.findUnique({
        where: { id: outId }, select: { pricePerBaseUnit: true },
      })
      try {
        await syncPrepToInventory(recipeId)
      } catch (e) {
        console.error(`[propagatePrepCostChanges] sync failed for recipe ${recipeId}:`, e)
        continue
      }
      const after = await prisma.inventoryItem.findUnique({
        where: { id: outId }, select: { pricePerBaseUnit: true },
      })

      const a = Number(before?.pricePerBaseUnit ?? 0)
      const b = Number(after?.pricePerBaseUnit ?? 0)
      const moved = a === 0 ? b !== 0 : Math.abs(a - b) / Math.abs(a) > 1e-6
      if (moved) { movedOutputs.add(outId); queue.push(outId) }
    }
  }

  return [...movedOutputs]
}
