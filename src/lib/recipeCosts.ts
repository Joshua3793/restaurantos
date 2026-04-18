/**
 * Server-side recipe cost computation helpers.
 * All costs are computed at query time from live inventory pricePerBaseUnit.
 * Unit conversions are applied so e.g. 5 kg of an item priced per g costs correctly.
 */
import { prisma } from './prisma'
import { convertQty } from './uom'

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
  createdAt: Date
  updatedAt: Date
  ingredients: IngredientWithCost[]
  totalCost: number
  costPerPortion: number | null
  foodCostPct: number | null
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
      linkedRecipe: { name: string; baseYieldQty: Numeric; portionSize: Numeric | null } | null
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

/** Fetch a full recipe with computed costs, resolving linked recipe costs. */
export async function fetchRecipeWithCost(id: string): Promise<RecipeWithCost | null> {
  const recipe = await prisma.recipe.findUnique({
    where: { id },
    include: {
      category: true,
      ingredients: {
        include: {
          inventoryItem: { select: { itemName: true, baseUnit: true, pricePerBaseUnit: true } },
          linkedRecipe: {
            include: {
              ingredients: {
                include: {
                  inventoryItem: { select: { baseUnit: true, pricePerBaseUnit: true } },
                },
              },
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
      const linkedTotal = ing.linkedRecipe.ingredients.reduce((s, li) => {
        const baseUnit     = li.inventoryItem?.baseUnit ?? li.unit
        const qtyInBase    = convertQty(Number(li.qtyBase), li.unit, baseUnit)
        return s + qtyInBase * Number(li.inventoryItem?.pricePerBaseUnit ?? 0)
      }, 0)
      const linkedYield  = Number(ing.linkedRecipe.baseYieldQty)
      linkedCostPerUnit  = linkedYield > 0 ? linkedTotal / linkedYield : 0
      linkedYieldUnit    = ing.linkedRecipe.yieldUnit
    }
    return { ...ing, _linkedRecipeCostPerUnit: linkedCostPerUnit, _linkedRecipeYieldUnit: linkedYieldUnit }
  })

  const { totalCost, costPerPortion, foodCostPct, ingredients } = computeRecipeCost({
    ...recipe,
    ingredients: ingredientsWithLinked,
  })

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
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
    ingredients,
    totalCost,
    costPerPortion,
    foodCostPct,
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

  // conversionFactor = how many yieldUnits per 1 countUnit
  // e.g. countUOM='l', yieldUnit='ml' → convertQty(1,'l','ml') = 1000
  let conversionFactor = convertQty(1, countUOM, yieldUnit)
  // 'batch' is a special pseudo-unit: 1 batch = full recipe yield
  if (countUOM.toLowerCase() === 'batch') conversionFactor = baseYieldQty
  // If incompatible dimensions, convertQty returns 1 unchanged — that's our fallback

  await prisma.inventoryItem.update({
    where: { id: recipe.inventoryItemId },
    data: {
      purchasePrice:      recipe.totalCost,   // cost of making one batch
      pricePerBaseUnit,                        // cost per yieldUnit (e.g. $/ml)
      baseUnit:           yieldUnit,           // e.g. 'ml', 'g', 'each'
      packUOM:            yieldUnit,           // pack unit = yield unit
      packSize:           baseYieldQty,        // how much one batch produces
      qtyPerPurchaseUnit: 1,                   // 1 batch per "purchase"
      purchaseUnit:       'batch',
      conversionFactor,
      lastUpdated: new Date(),
    },
  })
}
