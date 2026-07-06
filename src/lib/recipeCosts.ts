/**
 * Server-side recipe cost computation helpers.
 * All costs are computed at query time from live inventory pricePerBaseUnit.
 * Unit conversions are applied so e.g. 5 kg of an item priced per g costs correctly.
 */
import { prisma } from './prisma'
import { convertQty, convertQtyBridged, dimensionallyCostable } from './uom'
import { getUnitConv } from './utils'
import { dimensionOf, DIMENSION_BASE, eachMeasureOf, densityOf, PRICING_SELECT, asChainItem, pricePerBaseUnit as chainPricePerBaseUnit } from './item-model'

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
  /** Allergens this single ingredient contributes — from its inventory item, or for a
   * linked PREP the aggregated allergen set synced onto the prep's inventory item. */
  allergens: string[]
  /**
   * True when `unit` is a DIFFERENT physical dimension than the ingredient's
   * baseUnit (e.g. counting an each-item in grams). convertQty silently passes
   * the qty through unchanged across dimensions, so the line would be mis-costed.
   * When true, `lineCost` is forced to 0 (no garbage contribution).
   */
  dimensionConflict: boolean
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
  /** Count of ingredients whose unit is a different dimension than the item's base unit. */
  dimensionConflicts: number
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
      inventoryItem: ({ itemName: string; baseUnit: string; allergens?: string[]; densityGPerMl?: unknown } & Parameters<typeof asChainItem>[0]) | null
      linkedRecipe: { name: string; inventoryItem?: { allergens?: string[] } | null } | null
      _linkedRecipeCostPerUnit?: number  // cost per 1 unit of the linked recipe's yieldUnit
      _linkedRecipeYieldUnit?: string    // yieldUnit of the linked recipe
    }>
  }
): { totalCost: number; costPerPortion: number | null; foodCostPct: number | null; dimensionConflicts: number; ingredients: IngredientWithCost[] } {

  const ingredientsWithCost: IngredientWithCost[] = recipe.ingredients.map(ing => {
    const qty = Number(ing.qtyBase)
    let pricePerBaseUnit = 0
    let ingredientName = 'Unknown'
    let ingredientType: 'inventory' | 'recipe' = 'inventory'
    let lineCostQty = qty   // qty converted to the ingredient's base unit for cost maths
    let ingredientBaseUnit = ing.unit  // fallback: use current unit as base
    // True only when the recipe unit can't be costed against the ingredient's
    // base unit — i.e. COUNT↔measured (e.g. `g` of a per-each item), where the
    // conversion is undefined. Weight↔volume is tolerated (density≈1 kitchen
    // convention; convertQty passes it through 1:1).
    let dimensionConflict = false
    let allergens: string[] = []

    if (ing.inventoryItem) {
      pricePerBaseUnit   = chainPricePerBaseUnit(asChainItem(ing.inventoryItem))
      ingredientName     = ing.inventoryItem.itemName
      ingredientType     = 'inventory'
      ingredientBaseUnit = ing.inventoryItem.baseUnit
      allergens          = ing.inventoryItem.allergens ?? []
      const ingBridge    = eachMeasureOf(ing.inventoryItem)
      const ingDensity   = densityOf(ing.inventoryItem)
      dimensionConflict  = !dimensionallyCostable(ing.unit, ingredientBaseUnit, ingBridge)
      // Convert recipe unit → inventory base unit before multiplying by price.
      // Density bridges weight↔volume; ingBridge bridges count↔measured.
      lineCostQty = convertQtyBridged(qty, ing.unit, ing.inventoryItem.baseUnit, ingBridge, ingDensity)
    } else if (ing.linkedRecipe) {
      pricePerBaseUnit   = ing._linkedRecipeCostPerUnit ?? 0
      ingredientName     = ing.linkedRecipe.name
      ingredientType     = 'recipe'
      allergens          = ing.linkedRecipe.inventoryItem?.allergens ?? []
      // Convert recipe unit → linked recipe's yield unit before multiplying by price
      const yieldUnit    = ing._linkedRecipeYieldUnit ?? ing.unit
      ingredientBaseUnit = yieldUnit
      dimensionConflict  = !dimensionallyCostable(ing.unit, yieldUnit)
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
      // On a dimension conflict the converted qty is meaningless — contribute 0
      // rather than a garbage number.
      lineCost: dimensionConflict ? 0 : lineCostQty * pricePerBaseUnit,
      ingredientBaseUnit,
      allergens,
      dimensionConflict,
    }
  })

  const dimensionConflicts = ingredientsWithCost.filter(i => i.dimensionConflict).length
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

  return { totalCost, costPerPortion, foodCostPct, dimensionConflicts, ingredients: ingredientsWithCost }
}

/**
 * Effective per-serving cost + food-cost % for a MENU dish. Prefers the recipe's
 * own costPerPortion, but most menu dishes set no portionSize (one recipe = one
 * plate), which leaves costPerPortion null. In that case fall back to
 * totalCost ÷ baseYieldQty so the dish still reports a real cost instead of a
 * blank. Used by the Sales report and Menu Engineering.
 */
export function dishServingCost(r: {
  costPerPortion: number | null; totalCost: number; baseYieldQty: number; menuPrice: number | null
}): { cost: number | null; foodCostPct: number | null } {
  const cost = r.costPerPortion ?? (r.baseYieldQty > 0 ? r.totalCost / r.baseYieldQty : r.totalCost)
  const foodCostPct = cost != null && r.menuPrice != null && r.menuPrice > 0
    ? (cost / r.menuPrice) * 100
    : null
  return { cost, foodCostPct }
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
  inventoryItem: ({ baseUnit: string } & Parameters<typeof asChainItem>[0]) | null
}): { costPerUnit: number; yieldUnit: string } {
  const item = linked.inventoryItem
  return {
    costPerUnit: item ? chainPricePerBaseUnit(asChainItem(item)) : 0,
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
          inventoryItem: { select: { itemName: true, allergens: true, ...PRICING_SELECT } },
          linkedRecipe: {
            select: {
              name: true,
              yieldUnit: true,
              inventoryItem: { select: { allergens: true, ...PRICING_SELECT } },
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

  const { totalCost, costPerPortion, foodCostPct, dimensionConflicts, ingredients } = computeRecipeCost({
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
    dimensionConflicts,
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

  // Item-model chain (authoritative). The spine + count system require `baseUnit`
  // to be the CANONICAL SI base for the dimension (g / ml / each) — i.e. the unit
  // where getUnitConv(baseUnit) === 1. Writing the recipe's yieldUnit verbatim
  // (e.g. "lb", "kg", "l") produces a non-canonical base, which silently breaks
  // every count conversion (counting 1 kg stores 1000 base units) and makes the
  // displayed pricePerBaseUnit diverge from getUnitConv-based readers.
  //
  // So we express the batch as ONE "batch" container whose content is the yield
  // converted into canonical base units: e.g. a 20 lb yield → { unit: 'batch',
  // per: 9071.84 } over baseUnit "g". ppb = totalCost / batchInBase is then a
  // genuine per-canonical-base price, and the count UI offers batch + g/kg/lb.
  const prepDimension = dimensionOf(yieldUnit)
  const canonBase     = DIMENSION_BASE[prepDimension]
  const batchInBase   = baseYieldQty * (getUnitConv(yieldUnit) || 1)
  const prepChain     = [{ unit: 'batch', per: batchInBase }]
  const prepPricing   = { mode: 'PACK' as const, purchasePrice: recipe.totalCost }

  await prisma.inventoryItem.update({
    where: { id: recipe.inventoryItemId },
    data: {
      itemName:           recipe.name,
      purchasePrice:      recipe.totalCost,
      baseUnit:           canonBase,
      allergens:          recipe.allergens,
      dimension:          prepDimension,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      packChain:          prepChain as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pricing:            prepPricing as any,
      countUnit:          'batch',
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
        where: { id: outId }, select: { ...PRICING_SELECT },
      })
      try {
        await syncPrepToInventory(recipeId)
      } catch (e) {
        console.error(`[propagatePrepCostChanges] sync failed for recipe ${recipeId}:`, e)
        continue
      }
      const after = await prisma.inventoryItem.findUnique({
        where: { id: outId }, select: { ...PRICING_SELECT },
      })

      const a = before ? chainPricePerBaseUnit(asChainItem(before)) : 0
      const b = after ? chainPricePerBaseUnit(asChainItem(after)) : 0
      const moved = a === 0 ? b !== 0 : Math.abs(a - b) / Math.abs(a) > 1e-6
      if (moved) { movedOutputs.add(outId); queue.push(outId) }
    }
  }

  return [...movedOutputs]
}

/**
 * Re-sync a PREP recipe's cost to its linked InventoryItem AND cascade to every
 * dependent prep. The single entry point for every recipe-mutation path; no-op for
 * non-PREP or unlinked recipes. Awaited by callers so the cascade completes before
 * the response; callers wrap in .catch() so a rare sync failure never fails the edit.
 */
export async function resyncPrepRecipe(recipeId: string): Promise<void> {
  const recipe = await prisma.recipe.findUnique({
    where: { id: recipeId },
    select: { type: true, inventoryItemId: true },
  })
  if (!recipe || recipe.type !== 'PREP' || !recipe.inventoryItemId) return
  await syncPrepToInventory(recipeId)                      // this recipe's own output item
  await propagatePrepCostChanges([recipe.inventoryItemId]) // cascade to consumers
}
