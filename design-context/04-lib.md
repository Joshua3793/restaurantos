# Fergie's OS — Backend lib (data shapes & logic)

Costing/UOM spine, count, prep, invoice helpers, auth, prisma, supabase, uploadthing.


---

## `src/lib/uom.ts`

```ts
/**
 * Unit of Measure definitions and conversion utilities.
 * Used for recipe ingredient cost calculations — both server-side and client-side.
 */

export interface UomGroup {
  label: string
  base: string
  units: { label: string; toBase: number }[]
}

export const UOM_GROUPS: UomGroup[] = [
  {
    label: 'Weight',
    base: 'g',
    units: [
      { label: 'mg',  toBase: 0.001 },
      { label: 'g',   toBase: 1 },
      { label: 'kg',  toBase: 1000 },
      { label: 'oz',  toBase: 28.3495 },
      { label: 'lb',  toBase: 453.592 },
    ],
  },
  {
    label: 'Volume',
    base: 'ml',
    units: [
      { label: 'ml',    toBase: 1 },
      { label: 'cl',    toBase: 10 },
      { label: 'dl',    toBase: 100 },
      { label: 'l',     toBase: 1000 },
      { label: 'tsp',   toBase: 4.92892 },
      { label: 'tbsp',  toBase: 14.7868 },
      { label: 'fl oz', toBase: 29.5735 },
      { label: 'cup',   toBase: 236.588 },
      { label: 'pt',    toBase: 473.176 },
      { label: 'qt',    toBase: 946.353 },
    ],
  },
  {
    label: 'Count',
    base: 'each',
    units: [
      { label: 'each',    toBase: 1 },
      { label: 'pcs',     toBase: 1 },
      { label: 'slice',   toBase: 1 },
      { label: 'bunch',   toBase: 1 },
      { label: 'portion', toBase: 1 },
      { label: 'serve',   toBase: 1 },
      { label: 'batch',   toBase: 1 },
    ],
  },
]

/** Flat list of every unit for dropdowns */
export const ALL_UNITS = UOM_GROUPS.flatMap(g =>
  g.units.map(u => ({ label: u.label, group: g.label, toBase: u.toBase }))
)

/**
 * Convert `qty` from `fromUnit` to `toUnit`.
 * Returns the original qty unchanged if the units are incompatible or unrecognised.
 */
export function convertQty(qty: number, fromUnit: string, toUnit: string): number {
  if (!fromUnit || !toUnit) return qty
  const from = fromUnit.trim().toLowerCase()
  const to   = toUnit.trim().toLowerCase()
  if (from === to) return qty

  for (const group of UOM_GROUPS) {
    const fromDef = group.units.find(u => u.label.toLowerCase() === from)
    const toDef   = group.units.find(u => u.label.toLowerCase() === to)
    if (fromDef && toDef) {
      // qty × toBase(from) → qty in group base, then ÷ toBase(to) → target unit
      return (qty * fromDef.toBase) / toDef.toBase
    }
  }

  // Different or unrecognised groups — pass through unchanged
  return qty
}

/** Return the group name ('Weight' | 'Volume' | 'Count') for a unit, or null. */
export function getUnitGroup(unit: string): string | null {
  const u = unit.trim().toLowerCase()
  for (const group of UOM_GROUPS) {
    if (group.units.some(gu => gu.label.toLowerCase() === u)) return group.label
  }
  return null
}

```


---

## `src/lib/utils.ts`

```ts
// Unit conversion factors — all weight → g, all volume → ml, count → 1
export const UNIT_CONV: Record<string, number> = {
  // weight
  g: 1, mg: 0.001, kg: 1000, lb: 453.592, oz: 28.3495,
  // volume
  ml: 1, cl: 10, dl: 100, l: 1000, lt: 1000, 'fl oz': 29.5735, tsp: 4.92892, tbsp: 14.7868, cup: 236.588, gal: 3785.41,
  // count
  each: 1, ea: 1,
}

export const PACK_UOMS = ['each', 'g', 'kg', 'lb', 'oz', 'ml', 'l'] as const

export const PURCHASE_UNITS = [
  'case', 'bag', 'box', 'bottle', 'pack', 'tray',
  'sleeve', 'dozen', 'pallet', 'jug', 'each',
] as const

export const QTY_UOMS = ['each', 'pack', 'kg', 'g', 'lb', 'oz', 'l', 'ml'] as const

// Grouped count UOMs by dimension
export const WEIGHT_COUNT_UOMS = ['g', 'kg', 'lb', 'oz'] as const
export const VOLUME_COUNT_UOMS = ['ml', 'cl', 'l', 'fl oz', 'cup', 'tsp', 'tbsp'] as const
export const EACH_COUNT_UOMS   = ['each', 'pkg', 'case', 'portion', 'serve', 'batch'] as const

export const COUNT_UOMS = [
  ...EACH_COUNT_UOMS,
  ...WEIGHT_COUNT_UOMS,
  ...VOLUME_COUNT_UOMS,
] as const

/** Returns 'weight', 'volume', or 'count' for a given unit string */
export function getUnitDimension(unit: string): 'weight' | 'volume' | 'count' {
  const u = unit?.toLowerCase() ?? 'each'
  if (['g', 'mg', 'kg', 'lb', 'oz'].includes(u)) return 'weight'
  if (['ml', 'cl', 'dl', 'l', 'lt', 'fl oz', 'tsp', 'tbsp', 'cup', 'pt', 'qt', 'gal'].includes(u)) return 'volume'
  return 'count'
}

/** Returns the valid Count UOM options for a given base unit */
export function compatibleCountUnits(baseUnit: string): string[] {
  const dim = getUnitDimension(baseUnit)
  if (dim === 'weight') return [...WEIGHT_COUNT_UOMS, 'batch']
  if (dim === 'volume') return [...VOLUME_COUNT_UOMS, 'batch']
  return [...EACH_COUNT_UOMS]
}

export function getUnitConv(uom: string): number {
  return UNIT_CONV[uom?.toLowerCase()] ?? 1
}

/** Price per base unit (g, ml, or each) based on purchase structure */
export function calcPricePerBaseUnit(
  purchasePrice: number,
  qtyPerPurchaseUnit: number,
  qtyUOM: string,
  innerQty: number | null,
  packSize: number,
  packUOM: string,
  priceType: 'CASE' | 'UOM' = 'CASE',
): number {
  if (priceType === 'UOM') {
    const conv = getUnitConv(packUOM)
    return conv > 0 ? purchasePrice / conv : 0
  }
  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)

  let divisor: number
  if (isWeightQty) {
    divisor = qtyPerPurchaseUnit * getUnitConv(qtyUOM)
  } else if (qtyUOM === 'pack' && innerQty != null) {
    divisor = qtyPerPurchaseUnit * innerQty * packSize * getUnitConv(packUOM)
  } else {
    divisor = qtyPerPurchaseUnit * packSize * getUnitConv(packUOM)
  }
  return divisor > 0 ? purchasePrice / divisor : 0
}

/** Derive the base unit (g / ml / each) from qtyUOM and packUOM */
export function deriveBaseUnit(qtyUOM: string, packUOM: string, packSize?: number): string {
  const q = qtyUOM?.toLowerCase() ?? ''
  const p = packUOM?.toLowerCase() ?? ''
  const weightUnits = ['g', 'mg', 'kg', 'lb', 'oz']
  const volumeUnits = ['ml', 'l', 'lt', 'fl oz', 'tsp', 'tbsp', 'cup', 'gal']
  if (weightUnits.includes(q)) return 'g'
  if (volumeUnits.includes(q)) return 'ml'
  // Only infer base unit from packUOM when an actual weight/volume per-each was entered
  if (packSize !== undefined && packSize <= 0) return 'each'
  if (weightUnits.includes(p)) return 'g'
  if (volumeUnits.includes(p)) return 'ml'
  return 'each'
}

/** Conversion factor: how many base units equal 1 counting unit */
export function calcConversionFactor(
  countUOM: string,
  qtyPerPurchaseUnit: number,
  qtyUOM: string,
  innerQty: number | null,
  packSize: number,
  packUOM: string,
): number {
  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)

  const itemBaseUnits = packSize * getUnitConv(packUOM)
  const packBaseUnits = (innerQty ?? 1) * itemBaseUnits

  // 'each' must be resolved before the UNIT_CONV short-circuit — weight-based
  // items (e.g. 250 g per head) must return 250, not 1.
  if (countUOM === 'each') return itemBaseUnits > 0 ? itemBaseUnits : 1

  // Standard dimensional units (g, kg, ml, l, etc.)
  if (countUOM in UNIT_CONV) return UNIT_CONV[countUOM]

  if (countUOM === 'case' || countUOM === qtyUOM) {
    if (isWeightQty) return qtyPerPurchaseUnit * getUnitConv(qtyUOM)
    return qtyPerPurchaseUnit * packBaseUnits
  }
  if (countUOM === 'pack') return packBaseUnits
  return 1
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
}

export function formatUnitPrice(amount: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(amount)
}

export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Format a qty+unit pair with automatic up-conversion (1000g→1 kg, 1000ml→1 L). */
export function formatQtyUnit(qty: number, unit: string): string {
  const u = unit.toLowerCase()
  if (u === 'g' && qty >= 1000)  return `${+(qty / 1000).toPrecision(4).replace(/\.?0+$/, '')} kg`
  if (u === 'ml' && qty >= 1000) return `${+(qty / 1000).toPrecision(4).replace(/\.?0+$/, '')} L`
  return `${qty} ${unit}`
}

export const CATEGORY_COLORS: Record<string, string> = {
  BREAD: 'bg-amber-100 text-amber-800',
  DAIRY: 'bg-blue-100 text-blue-800',
  DRY: 'bg-yellow-100 text-yellow-800',
  FISH: 'bg-cyan-100 text-cyan-800',
  MEAT: 'bg-red-100 text-red-800',
  PREPD: 'bg-purple-100 text-purple-800',
  PROD: 'bg-green-100 text-green-800',
  CHM: 'bg-gray-100 text-gray-800',
}

export const CATEGORIES = ['BREAD', 'DAIRY', 'DRY', 'FISH', 'MEAT', 'PREPD', 'PROD', 'CHM'] as const
export const BASE_UNITS = ['g', 'ml', 'each', 'kg', 'l'] as const
export const INVOICE_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETE'] as const
export const WASTAGE_REASONS = ['SPOILAGE', 'OVERPRODUCTION', 'PREP_TRIM', 'BURNT', 'DROPPED', 'EXPIRED', 'STAFF_MEAL', 'UNKNOWN'] as const
export const RECIPE_CATEGORIES = ['APPETIZER', 'MAIN', 'DESSERT', 'BEVERAGE', 'SIDE', 'SAUCE', 'SOUP', 'SALAD', 'BREAD', 'OTHER'] as const

```


---

## `src/lib/recipeCosts.ts`

```ts
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
          inventoryItem: { select: { itemName: true, baseUnit: true, pricePerBaseUnit: true, allergens: true } },
          linkedRecipe: {
            include: {
              ingredients: {
                include: {
                  inventoryItem: { select: { baseUnit: true, pricePerBaseUnit: true, allergens: true } },
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

  const allergens = Array.from(new Set(recipe.ingredients.flatMap(ing => [
    ...(ing.inventoryItem?.allergens ?? []),
    ...(ing.linkedRecipe?.ingredients.flatMap(li => li.inventoryItem?.allergens ?? []) ?? []),
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

```


---

## `src/lib/recipe-costs.ts`

```ts
import { prisma } from '@/lib/prisma'

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
          inventoryItem: { select: { id: true, pricePerBaseUnit: true, baseUnit: true } },
          linkedRecipe: {
            include: {
              ingredients: {
                include: { inventoryItem: { select: { pricePerBaseUnit: true, baseUnit: true } } },
              },
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
        newTotalCost += qty * Number(ing.inventoryItem.pricePerBaseUnit)
      } else if (ing.linkedRecipe) {
        // Sub-recipe cost: sum its own ingredients
        let subCost = 0
        for (const subIng of ing.linkedRecipe.ingredients) {
          if (subIng.inventoryItem) {
            subCost += Number(subIng.qtyBase) * Number(subIng.inventoryItem.pricePerBaseUnit)
          }
        }
        const subYield = Number(ing.linkedRecipe.baseYieldQty) || 1
        const costPerUnit = subCost / subYield
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
          inventoryItem: { select: { pricePerBaseUnit: true } },
          linkedRecipe: {
            include: {
              ingredients: {
                include: { inventoryItem: { select: { pricePerBaseUnit: true } } },
              },
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
      totalCost += qty * Number(ing.inventoryItem.pricePerBaseUnit)
    } else if (ing.linkedRecipe) {
      let subCost = 0
      for (const subIng of ing.linkedRecipe.ingredients) {
        if (subIng.inventoryItem) {
          subCost += Number(subIng.qtyBase) * Number(subIng.inventoryItem.pricePerBaseUnit)
        }
      }
      const subYield = Number(ing.linkedRecipe.baseYieldQty) || 1
      totalCost += qty * (subCost / subYield)
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

```


---

## `src/lib/count-uom.ts`

```ts
/**
 * UOM conversion utilities specific to the stock count system.
 *
 * Every inventory item stores stockOnHand in its baseUnit.
 * During a count, the user may enter quantities in a different UOM
 * (e.g. purchaseUnit = "bag" containing 20 kg, or "kg" when baseUnit = "g").
 * These functions handle converting back to baseUnit for persistence.
 */

import { convertQty } from './uom'
import { deriveBaseUnit, getUnitConv } from './utils'

export interface CountableUom {
  label: string
  /** How many baseUnits make up 1 of this UOM. */
  toBase: number
  /** Human-readable description of what 1 of this unit contains, e.g. "20 kg" or "12 each". */
  hint?: string
}

interface ItemDims {
  baseUnit: string
  purchaseUnit: string
  qtyPerPurchaseUnit: number | { toString(): string }
  qtyUOM?: string | null
  innerQty?: { toString(): string } | number | null
  packSize: number | { toString(): string }
  packUOM: string
  countUOM: string
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return n.toString()
  if (n >= 10) return Math.round(n).toString()
  return n.toFixed(1)
}

function buildCaseHint(item: ItemDims): string {
  const qty = Number(item.qtyPerPurchaseUnit)
  const qtyUOM = item.qtyUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'

  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']

  if (weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)) {
    const total = qty * getUnitConv(qtyUOM)
    return total >= 1000 && weightUnits.includes(qtyUOM)
      ? `${total / 1000} kg`
      : `${qty} ${qtyUOM}`
  }
  if (qtyUOM === 'pack' && innerQty != null) {
    if (ps > 0 && pu !== 'each') {
      return `${qty} packs × ${innerQty} × ${ps}${pu}`
    }
    return `${qty} packs × ${innerQty} each`
  }
  if (ps > 0 && pu !== 'each') {
    return `${qty} × ${ps}${pu}`
  }
  return `${qty} each`
}

/** Helper: total base units per 1 purchase unit */
function calcConversionFactorForItem(item: ItemDims): number {
  const qtyUOM = item.qtyUOM ?? 'each'
  const qty = Number(item.qtyPerPurchaseUnit)
  const ps  = Number(item.packSize ?? 0)
  const pu  = item.packUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null

  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  if (weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)) {
    return qty * getUnitConv(qtyUOM)
  }
  if (qtyUOM === 'pack' && innerQty != null) {
    return qty * innerQty * ps * getUnitConv(pu)
  }
  return qty * ps * getUnitConv(pu)
}

/**
 * Returns the stored countUOM if it's still valid for this item's purchase
 * structure, otherwise falls back to the first valid option.
 */
export function resolveCountUom(item: ItemDims): string {
  const stored = item.countUOM ?? 'each'
  const valid = getCountableUoms(item).map(u => u.label)
  return valid.includes(stored) ? stored : (valid[0] ?? stored)
}

/**
 * Returns the UOM options a user can choose from when counting an item.
 * Derived from purchase structure — not a hardcoded list.
 */
export function getCountableUoms(item: ItemDims): CountableUom[] {
  const uoms: CountableUom[] = []
  const qtyUOM = item.qtyUOM ?? 'each'
  const base = deriveBaseUnit(qtyUOM, item.packUOM ?? 'each')
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null
  const hasInnerQty = innerQty != null && innerQty > 0
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'
  const hasWeight = base === 'g' || base === 'ml'
  const hasItemWeight = hasWeight && ps > 0

  // Purchase unit (case / bag / etc.)
  uoms.push({ label: item.purchaseUnit, toBase: calcConversionFactorForItem(item), hint: buildCaseHint(item) })

  // Pack level (only when qtyUOM = "pack")
  if (qtyUOM === 'pack' && hasInnerQty) {
    const packBaseUnits = innerQty! * ps * getUnitConv(pu)
    const hint = packBaseUnits > 0 ? `${fmtNum(packBaseUnits)} ${base}` : `${innerQty} each`
    uoms.push({ label: 'pack', toBase: packBaseUnits > 0 ? packBaseUnits : innerQty!, hint })
  }

  // Each (individual item)
  if (hasItemWeight) {
    uoms.push({ label: 'each', toBase: ps * getUnitConv(pu), hint: `${ps} ${pu}` })
  } else if (qtyUOM === 'each' || qtyUOM === 'pack') {
    uoms.push({ label: 'each', toBase: 1 })
  }

  // Weight/volume options — only when item actually has a weight/volume per each
  if (base === 'g' && hasItemWeight) {
    uoms.push(
      { label: 'kg', toBase: 1000, hint: '1,000 g' },
      { label: 'g',  toBase: 1 },
      { label: 'lb', toBase: 453.592, hint: '454 g' },
    )
  }
  if (base === 'ml' && hasItemWeight) {
    uoms.push(
      { label: 'l',  toBase: 1000, hint: '1,000 ml' },
      { label: 'ml', toBase: 1 },
    )
  }

  return uoms
}

/**
 * Convert a quantity entered by the user (in selectedUom) to the item's baseUnit.
 * This is what gets written to stockOnHand.
 */
export function convertCountQtyToBase(
  qty: number,
  selectedUom: string,
  item: ItemDims,
): number {
  const sel = selectedUom.toLowerCase()
  const base = item.baseUnit.toLowerCase()
  if (sel === base) return qty

  const qtyUOM = (item.qtyUOM ?? 'each').toLowerCase()
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null

  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)

  const itemBaseUnits = ps * getUnitConv(pu)
  const packBaseUnits = (innerQty ?? 1) * itemBaseUnits

  // Purchase unit
  if (sel === item.purchaseUnit.toLowerCase()) {
    const qtyNum = Number(item.qtyPerPurchaseUnit)
    if (isWeightQty) return qty * qtyNum * getUnitConv(qtyUOM)
    if (qtyUOM === 'pack' && innerQty != null) return qty * qtyNum * packBaseUnits
    return qty * qtyNum * (itemBaseUnits > 0 ? itemBaseUnits : 1)
  }

  // Pack level
  if (sel === 'pack' && qtyUOM === 'pack' && innerQty != null) {
    return qty * packBaseUnits
  }

  // Each
  if (sel === 'each') {
    return itemBaseUnits > 0 ? qty * itemBaseUnits : qty
  }

  // Standard weight/volume conversion (kg, g, lb, ml, l, etc.)
  return convertQty(qty, selectedUom, item.baseUnit)
}

/**
 * Convert a baseUnit quantity to the selectedUom — for displaying expected quantities.
 */
export function convertBaseToCountUom(
  baseQty: number,
  selectedUom: string,
  item: ItemDims,
): number {
  const sel = selectedUom.toLowerCase()
  const base = item.baseUnit.toLowerCase()
  if (sel === base) return baseQty

  const qtyUOM = (item.qtyUOM ?? 'each').toLowerCase()
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null

  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)

  const itemBaseUnits = ps * getUnitConv(pu)
  const packBaseUnits = (innerQty ?? 1) * itemBaseUnits

  // Purchase unit
  if (sel === item.purchaseUnit.toLowerCase()) {
    const qtyNum = Number(item.qtyPerPurchaseUnit)
    if (isWeightQty) {
      const purchaseBaseUnits = qtyNum * getUnitConv(qtyUOM)
      return purchaseBaseUnits > 0 ? baseQty / purchaseBaseUnits : 0
    }
    if (qtyUOM === 'pack' && innerQty != null) {
      const purchaseBaseUnits = qtyNum * packBaseUnits
      return purchaseBaseUnits > 0 ? baseQty / purchaseBaseUnits : 0
    }
    const purchaseBaseUnits = qtyNum * (itemBaseUnits > 0 ? itemBaseUnits : 1)
    return purchaseBaseUnits > 0 ? baseQty / purchaseBaseUnits : 0
  }

  // Pack level
  if (sel === 'pack' && qtyUOM === 'pack' && innerQty != null) {
    return packBaseUnits > 0 ? baseQty / packBaseUnits : 0
  }

  // Each
  if (sel === 'each') {
    return itemBaseUnits > 0 ? baseQty / itemBaseUnits : baseQty
  }

  // Standard weight/volume
  return convertQty(baseQty, item.baseUnit, selectedUom)
}

```


---

## `src/lib/count-constants.ts`

```ts
/** Variance percentage above which a count line is flagged as "large variance". */
export const LARGE_VARIANCE_PCT = 15

```


---

## `src/lib/count-expected.ts`

```ts
import { prisma } from '@/lib/prisma'
import { convertQty } from '@/lib/uom'
import { getUnitConv } from '@/lib/utils'

type IngredientWithLinks = {
  inventoryItemId: string | null
  inventoryItem:   { id: string; baseUnit: string } | null
  linkedRecipeId:  string | null
  linkedRecipe: null | {
    id: string
    inventoryItemId: string | null
    inventoryItem:   { id: string; baseUnit: string } | null
    ingredients: Array<{
      inventoryItemId: string | null
      inventoryItem:   { id: string; baseUnit: string } | null
      qtyBase: string | number | { toString(): string }
      unit: string
    }>
  }
  qtyBase: string | number | { toString(): string }
  unit: string
}

type RecipeForExpansion = {
  id: string
  ingredients: IngredientWithLinks[]
}

function expandRecipeIngredients(
  recipe: RecipeForExpansion,
  batches: number,
  map: Map<string, number>,
  visitedRecipes: Set<string>,
): void {
  if (visitedRecipes.has(recipe.id)) return
  visitedRecipes.add(recipe.id)

  for (const ing of recipe.ingredients) {
    if (ing.inventoryItemId && ing.inventoryItem) {
      const consumed = convertQty(Number(ing.qtyBase) * batches, ing.unit, ing.inventoryItem.baseUnit)
      map.set(ing.inventoryItemId, (map.get(ing.inventoryItemId) ?? 0) + consumed)
    }

    if (ing.linkedRecipeId && ing.linkedRecipe && !visitedRecipes.has(ing.linkedRecipeId)) {
      const prep = ing.linkedRecipe
      if (prep.inventoryItemId && prep.inventoryItem) {
        const consumed = convertQty(Number(ing.qtyBase) * batches, ing.unit, prep.inventoryItem.baseUnit)
        map.set(prep.inventoryItemId, (map.get(prep.inventoryItemId) ?? 0) + consumed)
      }
    }
  }
}

export async function buildConsumptionMap(
  since: Date,
  rcId?: string | null,
): Promise<Map<string, number>> {
  const lineItems = await prisma.saleLineItem.findMany({
    where: {
      sale: {
        date: { gte: since },
        ...(rcId ? { revenueCenterId: rcId } : {}),
      },
    },
    include: {
      recipe: {
        include: {
          ingredients: {
            include: {
              inventoryItem: { select: { id: true, baseUnit: true } },
              linkedRecipe: {
                include: {
                  inventoryItem: { select: { id: true, baseUnit: true } },
                  ingredients: {
                    include: { inventoryItem: { select: { id: true, baseUnit: true } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  })

  const map = new Map<string, number>()
  for (const li of lineItems) {
    const recipe = li.recipe
    const portionsPerBatch =
      recipe.portionSize && Number(recipe.portionSize) > 0
        ? Number(recipe.baseYieldQty) / Number(recipe.portionSize)
        : 1
    const batches = li.qtySold / portionsPerBatch
    expandRecipeIngredients(recipe, batches, map, new Set<string>())
  }
  return map
}

export async function buildPurchaseMap(
  since: Date,
  rcId?: string | null,
): Promise<Map<string, number>> {
  const map = new Map<string, number>()

  if (rcId) {
    const scanItems = await prisma.invoiceScanItem.findMany({
      where: {
        session: {
          revenueCenterId: rcId,
          status: 'APPROVED',
          createdAt: { gte: since },
        },
        approved: true,
        action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] },
        matchedItemId: { not: null },
        rawQty: { not: null },
      },
      select: {
        matchedItemId: true,
        rawQty: true,
        invoicePackQty:  true,
        invoicePackSize: true,
        invoicePackUOM:  true,
        matchedItem: {
          select: {
            id: true, baseUnit: true,
            qtyPerPurchaseUnit: true, packSize: true, packUOM: true,
          },
        },
      },
    })

    for (const si of scanItems) {
      if (!si.matchedItemId || !si.matchedItem) continue
      const qty = Number(si.rawQty ?? 0)
      if (qty <= 0) continue

      let baseUnits: number
      const packQty  = si.invoicePackQty  ? Number(si.invoicePackQty)  : 0
      const packSize = si.invoicePackSize ? Number(si.invoicePackSize) : 0
      const packUOM  = si.invoicePackUOM ?? null

      if (packQty > 0 && packSize > 0 && packUOM) {
        baseUnits = convertQty(qty * packQty * packSize, packUOM, si.matchedItem.baseUnit)
      } else {
        const unitsPerCase =
          Number(si.matchedItem.qtyPerPurchaseUnit) * Number(si.matchedItem.packSize)
        baseUnits = qty * unitsPerCase
      }

      map.set(si.matchedItemId, (map.get(si.matchedItemId) ?? 0) + baseUnits)
    }
  } else {
    const purchaseRows = await prisma.invoiceLineItem.findMany({
      where: {
        invoice: {
          invoiceDate: { gte: since },
          status: { not: 'CANCELLED' },
        },
      },
      include: {
        inventoryItem: {
          select: {
            id: true, baseUnit: true,
            qtyPerPurchaseUnit: true, packSize: true, packUOM: true,
          },
        },
      },
    })

    for (const p of purchaseRows) {
      if (!p.inventoryItem) continue
      const unitsPerCase =
        Number(p.inventoryItem.qtyPerPurchaseUnit) *
        Number(p.inventoryItem.packSize) *
        getUnitConv(p.inventoryItem.packUOM)
      const baseUnits = Number(p.qtyPurchased) * unitsPerCase
      map.set(p.inventoryItemId!, (map.get(p.inventoryItemId!) ?? 0) + baseUnits)
    }
  }

  return map
}

export async function buildWastageMap(
  since: Date,
  itemIds: string[],
  rcId?: string | null,
): Promise<Map<string, number>> {
  const wastageRows = await prisma.wastageLog.findMany({
    where: {
      date:            { gte: since },
      inventoryItemId: { in: itemIds },
      ...(rcId ? { revenueCenterId: rcId } : {}),
    },
    select: {
      inventoryItemId: true,
      qtyWasted:       true,
      unit:            true,
      inventoryItem:   { select: { baseUnit: true } },
    },
  })

  const map = new Map<string, number>()
  for (const w of wastageRows) {
    const converted = convertQty(Number(w.qtyWasted), w.unit, w.inventoryItem.baseUnit)
    map.set(w.inventoryItemId, (map.get(w.inventoryItemId) ?? 0) + converted)
  }
  return map
}

/**
 * Compute theoretical expected qty for an inventory item given its base stock
 * and the consumption/purchase/wastage maps for a period.
 */
export function computeExpected(
  itemId: string,
  baseStock: number,
  consumptionMap: Map<string, number>,
  purchaseMap: Map<string, number>,
  wastageMap: Map<string, number>,
): number {
  const consumption = consumptionMap.get(itemId) ?? 0
  const purchases   = purchaseMap.get(itemId)    ?? 0
  const wastage     = wastageMap.get(itemId)     ?? 0
  return Math.max(0, baseStock + purchases - consumption - wastage)
}

```


---

## `src/lib/count-offline.ts`

```ts
const QUEUE_KEY = 'count_queue_v1'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CountMutation {
  id:        string
  ts:        number
  sessionId: string
  lineId:    string
  type:      'count' | 'skip'
  qty?:      number
}

// ── Session cache ──────────────────────────────────────────────────────────────
// Keyed by sessionId so multiple sessions can be cached independently.

export function saveCountSessionCache(sessionId: string, data: unknown): void {
  try {
    localStorage.setItem(`count_session_${sessionId}`, JSON.stringify({ data, ts: Date.now() }))
  } catch { /* quota exceeded or private browsing */ }
}

export function loadCountSessionCache<T>(sessionId: string): T | null {
  try {
    const raw = localStorage.getItem(`count_session_${sessionId}`)
    if (!raw) return null
    return (JSON.parse(raw) as { data: T }).data
  } catch { return null }
}

// ── Queue ──────────────────────────────────────────────────────────────────────

export function enqueueCountMutation(m: Omit<CountMutation, 'id' | 'ts'>): void {
  try {
    const queue = loadCountQueue()
    queue.push({
      ...m,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ts: Date.now(),
    })
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch { /* graceful degradation */ }
}

export function loadCountQueue(): CountMutation[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    return raw ? (JSON.parse(raw) as CountMutation[]) : []
  } catch { return [] }
}

export function clearCountQueue(): void {
  try { localStorage.removeItem(QUEUE_KEY) } catch { /* ok */ }
}

export function pendingCountForSession(sessionId: string): number {
  return loadCountQueue().filter(m => m.sessionId === sessionId).length
}

// ── Deduplication ──────────────────────────────────────────────────────────────
// Keep only the last mutation per lineId — both count and skip replace each other.

function deduplicateQueue(queue: CountMutation[]): CountMutation[] {
  const lastPerLine = new Map<string, CountMutation>()
  for (const m of queue) lastPerLine.set(m.lineId, m)
  // Return in original insertion order, deduplicated
  const seen = new Set<string>()
  const result: CountMutation[] = []
  for (const m of queue) {
    if (lastPerLine.get(m.lineId) === m && !seen.has(m.lineId)) {
      result.push(m)
      seen.add(m.lineId)
    }
  }
  return result
}

// ── Flush ──────────────────────────────────────────────────────────────────────

export async function flushCountQueue(): Promise<{ synced: number; failed: number }> {
  const queue = loadCountQueue()
  if (queue.length === 0) return { synced: 0, failed: 0 }

  const deduped = deduplicateQueue(queue)
  let synced = 0
  let failed = 0

  for (const m of deduped) {
    try {
      await fetch(`/api/count/sessions/${m.sessionId}/lines/${m.lineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m.type === 'skip' ? { skipped: true } : { countedQty: m.qty }),
      })
      synced++
    } catch {
      failed++
    }
  }

  if (failed === 0) clearCountQueue()
  return { synced, failed }
}

```


---

## `src/lib/prep-utils.ts`

```ts
export type PrepPriority = '911' | 'NEEDED_TODAY' | 'LATER'

export const PREP_PRIORITY_ORDER: PrepPriority[] = ['911', 'NEEDED_TODAY', 'LATER']

export const PREP_PRIORITY_META: Record<PrepPriority, {
  label: string
  badgeClass: string
  borderClass: string
  bgClass: string
  headingClass: string
  emoji: string
}> = {
  '911': {
    label: 'Critical',
    emoji: '🔴',
    badgeClass: 'bg-red-100 text-red-700 font-bold',
    borderClass: 'border-l-4 border-red-500',
    bgClass: 'bg-red-50',
    headingClass: 'text-red-700',
  },
  'NEEDED_TODAY': {
    label: 'Needed Today',
    emoji: '🟠',
    badgeClass: 'bg-orange-100 text-orange-700',
    borderClass: 'border-l-4 border-orange-400',
    bgClass: 'bg-orange-50',
    headingClass: 'text-orange-700',
  },
  'LATER': {
    label: 'Looking Good',
    emoji: '🟢',
    badgeClass: 'bg-green-100 text-green-700',
    borderClass: 'border-l-4 border-green-400',
    bgClass: 'bg-white',
    headingClass: 'text-green-700',
  },
}

export const PREP_STATUS_META: Record<string, { label: string; badgeClass: string }> = {
  NOT_STARTED: { label: 'Not Started', badgeClass: 'bg-gray-100 text-gray-500' },
  IN_PROGRESS: { label: 'In Progress', badgeClass: 'bg-blue-100 text-blue-700' },
  DONE:        { label: 'Done',        badgeClass: 'bg-green-100 text-green-700' },
  PARTIAL:     { label: 'Partial',     badgeClass: 'bg-amber-100 text-amber-700' },
  BLOCKED:     { label: 'Blocked',     badgeClass: 'bg-red-100 text-red-700' },
  SKIPPED:     { label: 'Skipped',     badgeClass: 'bg-gray-100 text-gray-400' },
}

export const PREP_CATEGORIES = ['MISC', 'SAUCE', 'DRESSING', 'PROTEIN', 'BAKED', 'GARNISH', 'BASE', 'PICKLED', 'DAIRY']
export const PREP_STATIONS   = ['Cold', 'Hot', 'Pastry', 'Butchery', 'Garde Manger']

/**
 * Compute the priority for a prep item.
 * manualOverride wins unconditionally.
 * _minThreshold is deprecated — kept for call-site compat during transition, ignored.
 */
export function computePriority(
  onHand: number,
  parLevel: number,
  _minThreshold: number,
  targetToday: number | null,
  manualOverride: string | null,
): PrepPriority {
  if (manualOverride) return manualOverride as PrepPriority
  if (onHand <= 0 && parLevel > 0) return '911'
  if (targetToday !== null && onHand < targetToday) return '911'
  if (onHand < parLevel) return 'NEEDED_TODAY'
  return 'LATER'
}

/** max(parLevel - onHand, targetToday - onHand, 0) */
export function computeSuggestedQty(
  onHand: number,
  parLevel: number,
  targetToday: number | null,
): number {
  const base = parLevel - onHand
  if (targetToday !== null) return Math.max(targetToday - onHand, base, 0)
  return Math.max(base, 0)
}

/**
 * Compute the scale factor for ingredient deduction / output credit.
 * unit='batch' → scale = actualPrepQty (each batch = one recipe run)
 * unit matches recipe yieldUnit → scale = actualPrepQty / baseYieldQty
 * otherwise → scale = 1, unitMismatch = true
 */
/**
 * Total estimated minutes of work remaining across all items.
 * Excludes items whose todayLog status is DONE or SKIPPED.
 */
export function computeWorkloadMinutes(
  items: Array<{ estimatedPrepTime: number | null; todayLog?: { status: string } | null }>,
): number {
  return items.reduce((sum, item) => {
    const status = item.todayLog?.status ?? 'NOT_STARTED'
    if (status === 'DONE' || status === 'SKIPPED') return sum
    return sum + (item.estimatedPrepTime ?? 0)
  }, 0)
}

export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return '0min'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}min`
  if (m === 0) return `${h}h`
  return `${h}h ${m}min`
}

export function computeScale(
  actualPrepQty: number,
  unit: string,
  recipeYieldUnit: string,
  recipeBaseYieldQty: number,
): { scale: number; unitMismatch: boolean } {
  if (unit === 'batch') return { scale: actualPrepQty, unitMismatch: false }
  if (unit === recipeYieldUnit && recipeBaseYieldQty > 0) {
    return { scale: actualPrepQty / recipeBaseYieldQty, unitMismatch: false }
  }
  return { scale: 1, unitMismatch: true }
}

```


---

## `src/lib/prep-offline.ts`

```ts
import type { PrepItemRich } from '@/components/prep/types'

const CACHE_KEY = 'prep_items_v1'
const QUEUE_KEY = 'prep_queue_v1'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface OfflineMutation {
  id:         string
  ts:         number
  type:       'isOnList_toggle' | 'status' | 'priority'
  itemId:     string
  isOnList?:  boolean         // for isOnList_toggle
  logId?:     string | null   // null or '_opt_<itemId>' = not yet on server (status type)
  status?:    string
  actualQty?: number
  priority?:  string
}

// ── Cache ──────────────────────────────────────────────────────────────────────

export function savePrepCache(items: PrepItemRich[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ items, ts: Date.now() }))
  } catch { /* quota exceeded or private browsing */ }
}

export function loadPrepCache(): { items: PrepItemRich[]; ts: number } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed?.items)) return null
    return parsed as { items: PrepItemRich[]; ts: number }
  } catch { return null }
}

// ── Queue ──────────────────────────────────────────────────────────────────────

export function enqueueMutation(m: Omit<OfflineMutation, 'id' | 'ts'>): void {
  try {
    const queue = loadQueue()
    queue.push({
      ...m,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ts: Date.now(),
    })
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch { /* graceful degradation */ }
}

export function loadQueue(): OfflineMutation[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    return raw ? (JSON.parse(raw) as OfflineMutation[]) : []
  } catch { return [] }
}

export function clearQueue(): void {
  try { localStorage.removeItem(QUEUE_KEY) } catch { /* ok */ }
}

// ── Deduplication ──────────────────────────────────────────────────────────────
// For status and priority mutations, keep only the last one per item.
// Schedule add/remove are kept in order (they're intentional distinct ops).

function deduplicateQueue(queue: OfflineMutation[]): OfflineMutation[] {
  const lastIsOnList = new Map<string, OfflineMutation>()
  const lastStatus   = new Map<string, OfflineMutation>()
  const lastPriority = new Map<string, OfflineMutation>()
  for (const m of queue) {
    if (m.type === 'isOnList_toggle') lastIsOnList.set(m.itemId, m)
    if (m.type === 'status')          lastStatus.set(m.itemId, m)
    if (m.type === 'priority')        lastPriority.set(m.itemId, m)
  }

  const seenIsOnList = new Set<string>()
  const seenStatus   = new Set<string>()
  const seenPriority = new Set<string>()
  const result: OfflineMutation[] = []

  for (const m of queue) {
    if (m.type === 'isOnList_toggle' && lastIsOnList.get(m.itemId) === m && !seenIsOnList.has(m.itemId)) {
      result.push(m)
      seenIsOnList.add(m.itemId)
    } else if (m.type === 'status' && lastStatus.get(m.itemId) === m && !seenStatus.has(m.itemId)) {
      result.push(m)
      seenStatus.add(m.itemId)
    } else if (m.type === 'priority' && lastPriority.get(m.itemId) === m && !seenPriority.has(m.itemId)) {
      result.push(m)
      seenPriority.add(m.itemId)
    }
  }

  return result
}

// ── Flush ──────────────────────────────────────────────────────────────────────

export async function flushQueue(): Promise<{ synced: number; failed: number }> {
  const queue = loadQueue()
  if (queue.length === 0) return { synced: 0, failed: 0 }

  const deduped = deduplicateQueue(queue)
  let synced = 0
  let failed = 0

  for (const m of deduped) {
    try {
      if (m.type === 'isOnList_toggle') {
        await fetch(`/api/prep/items/${m.itemId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isOnList: m.isOnList }),
        })
        synced++

      } else if (m.type === 'status') {
        let logId = m.logId

        // If we still have no real ID, create the log first
        if (!logId) {
          const log = await fetch('/api/prep/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prepItemId: m.itemId }),
          }).then(r => r.json())
          logId = log.id
        }

        // PUT triggers inventory transaction for DONE/PARTIAL
        await fetch(`/api/prep/logs/${logId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: m.status,
            ...(m.actualQty !== undefined ? { actualPrepQty: m.actualQty } : {}),
          }),
        })
        synced++

      } else if (m.type === 'priority') {
        await fetch(`/api/prep/items/${m.itemId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ manualPriorityOverride: m.priority }),
        })
        synced++
      }
    } catch {
      failed++
    }
  }

  clearQueue()
  return { synced, failed }
}

```


---

## `src/lib/allergens.ts`

```ts
export interface AllergenDef {
  key: string   // matches DB value e.g. "Wheat/Gluten"
  label: string // full display name
  abbr: string  // 3-letter badge label
  bg: string    // Tailwind bg class (kept for reference)
  hex: string   // inline background color — avoids Tailwind purge issues
  dark: boolean // true → white text, false → dark text
}

export const ALLERGENS: AllergenDef[] = [
  { key: 'Wheat/Gluten', label: 'Wheat / Gluten', abbr: 'GLU', bg: 'bg-amber-500',  hex: '#f59e0b', dark: true  },
  { key: 'Milk',         label: 'Milk',            abbr: 'MLK', bg: 'bg-sky-500',    hex: '#0ea5e9', dark: true  },
  { key: 'Eggs',         label: 'Eggs',            abbr: 'EGG', bg: 'bg-yellow-400', hex: '#facc15', dark: false },
  { key: 'Peanuts',      label: 'Peanuts',         abbr: 'PNT', bg: 'bg-orange-500', hex: '#f97316', dark: true  },
  { key: 'Tree Nuts',    label: 'Tree Nuts',       abbr: 'NUT', bg: 'bg-stone-500',  hex: '#78716c', dark: true  },
  { key: 'Sesame',       label: 'Sesame',          abbr: 'SES', bg: 'bg-lime-500',   hex: '#84cc16', dark: true  },
  { key: 'Soy',          label: 'Soy',             abbr: 'SOY', bg: 'bg-green-600',  hex: '#16a34a', dark: true  },
  { key: 'Fish',         label: 'Fish',            abbr: 'FSH', bg: 'bg-teal-500',   hex: '#14b8a6', dark: true  },
  { key: 'Shellfish',    label: 'Shellfish',       abbr: 'SHL', bg: 'bg-red-500',    hex: '#ef4444', dark: true  },
]

export const ALLERGEN_MAP = Object.fromEntries(ALLERGENS.map(a => [a.key, a]))

```


---

## `src/lib/inventory-import.ts`

```ts
import { calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit } from '@/lib/utils'
import * as XLSX from 'xlsx'

// ── Allowed values ───────────────────────────────────────────────────────────
export const PRICE_BASES = [
  'Per Case', 'Per Each', 'Per kg', 'Per g', 'Per L', 'Per mL', 'Per lb', 'Per oz',
] as const
export type PriceBasis = typeof PRICE_BASES[number]

export const CONTENT_UNITS = ['each', 'kg', 'g', 'L', 'mL', 'lb', 'oz'] as const
export type ContentUnit = typeof CONTENT_UNITS[number]

export const IMPORT_HEADERS = [
  'Item Name', 'Purchase Price', 'Price Basis',
  'Case Contains', 'Content Unit', 'Stock On Hand', 'Barcode',
] as const

// ── Row & report types ───────────────────────────────────────────────────────
export interface RawRow {
  rowNumber: number   // 1-based data row (header excluded)
  itemName: string
  purchasePrice: string
  priceBasis: string
  caseContains: string
  contentUnit: string
  stockOnHand: string
  barcode: string
}

export interface InventoryCreatePayload {
  itemName: string
  category: string                 // always 'UNASSIGNED'
  purchaseUnit: string
  qtyPerPurchaseUnit: number
  qtyUOM: string
  packSize: number
  packUOM: string
  innerQty: number | null
  priceType: 'CASE' | 'UOM'
  countUOM: string
  purchasePrice: number
  pricePerBaseUnit: number
  conversionFactor: number
  baseUnit: string
  stockOnHand: number              // stored in base units
  barcode: string | null
  isActive: boolean
}

export type RowStatus = 'valid' | 'error' | 'duplicate'

export interface RowReport {
  rowNumber: number
  itemName: string
  status: RowStatus
  errors: string[]
  payload?: InventoryCreatePayload
  computed?: { pricePerBaseUnit: number; baseUnit: string }
}

export interface ImportReport {
  rows: RowReport[]
  validCount: number
  errorCount: number
  duplicateCount: number
}

// ── Normalization ────────────────────────────────────────────────────────────
const PRICE_BASIS_SYNONYMS: Record<string, PriceBasis> = {
  'per case': 'Per Case', 'case': 'Per Case',
  'per each': 'Per Each', 'each': 'Per Each', 'ea': 'Per Each',
  'per kg': 'Per kg', 'kg': 'Per kg', 'kilogram': 'Per kg', 'per kilogram': 'Per kg',
  'per g': 'Per g', 'g': 'Per g', 'gram': 'Per g', 'per gram': 'Per g',
  'per l': 'Per L', 'l': 'Per L', 'litre': 'Per L', 'liter': 'Per L',
  'per litre': 'Per L', 'per liter': 'Per L',
  'per ml': 'Per mL', 'ml': 'Per mL', 'per millilitre': 'Per mL',
  'per lb': 'Per lb', 'lb': 'Per lb', 'pound': 'Per lb', 'per pound': 'Per lb',
  'per oz': 'Per oz', 'oz': 'Per oz', 'ounce': 'Per oz', 'per ounce': 'Per oz',
}

const CONTENT_UNIT_SYNONYMS: Record<string, ContentUnit> = {
  'each': 'each', 'ea': 'each',
  'kg': 'kg', 'kilogram': 'kg',
  'g': 'g', 'gram': 'g',
  'l': 'L', 'litre': 'L', 'liter': 'L',
  'ml': 'mL', 'millilitre': 'mL',
  'lb': 'lb', 'pound': 'lb',
  'oz': 'oz', 'ounce': 'oz',
}

export function normalizePriceBasis(raw: string): PriceBasis | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  return PRICE_BASIS_SYNONYMS[key] ?? null
}

export function normalizeContentUnit(raw: string): ContentUnit | null {
  const key = raw.trim().toLowerCase()
  return CONTENT_UNIT_SYNONYMS[key] ?? null
}

// ── Row → payload mapping ────────────────────────────────────────────────────
// qtyUOM values use lowercase engine keys (matching UNIT_CONV in utils.ts).
// purchaseUnit values use display-case strings shown to users.
const BASIS_TO_QTY_UOM: Record<Exclude<PriceBasis, 'Per Case'>, string> = {
  'Per Each': 'each', 'Per kg': 'kg', 'Per g': 'g',
  'Per L': 'l', 'Per mL': 'ml', 'Per lb': 'lb', 'Per oz': 'oz',
}
const BASIS_TO_PURCHASE_UNIT: Record<Exclude<PriceBasis, 'Per Case'>, string> = {
  'Per Each': 'each', 'Per kg': 'kg', 'Per g': 'g',
  'Per L': 'L', 'Per mL': 'mL', 'Per lb': 'lb', 'Per oz': 'oz',
}
const CONTENT_UNIT_TO_QTY_UOM: Record<ContentUnit, string> = {
  each: 'each', kg: 'kg', g: 'g', L: 'l', mL: 'ml', lb: 'lb', oz: 'oz',
}

export function mapRowToPayload(row: RawRow): InventoryCreatePayload {
  const basis = normalizePriceBasis(row.priceBasis)
  if (!basis) throw new Error(`mapRowToPayload called on invalid Price Basis: ${row.priceBasis}`)

  const price = Number(row.purchasePrice)
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(`mapRowToPayload: invalid Purchase Price: ${row.purchasePrice}`)
  }

  let qtyUOM: string
  let qtyPerPurchaseUnit: number
  let purchaseUnit: string

  if (basis === 'Per Case') {
    const contentUnit = normalizeContentUnit(row.contentUnit)
    if (!contentUnit) throw new Error(`mapRowToPayload: invalid Content Unit: ${row.contentUnit}`)
    qtyUOM = CONTENT_UNIT_TO_QTY_UOM[contentUnit]
    qtyPerPurchaseUnit = Number(row.caseContains)
    if (!Number.isFinite(qtyPerPurchaseUnit) || qtyPerPurchaseUnit <= 0) {
      throw new Error(`mapRowToPayload: invalid Case Contains: ${row.caseContains}`)
    }
    purchaseUnit = 'Case'
  } else {
    qtyUOM = BASIS_TO_QTY_UOM[basis]
    qtyPerPurchaseUnit = 1
    purchaseUnit = BASIS_TO_PURCHASE_UNIT[basis]
  }

  const packSize = 1
  const packUOM = 'each'
  const innerQty = null
  const priceType = 'CASE' as const
  const countUOM = qtyUOM

  const pricePerBaseUnit = calcPricePerBaseUnit(
    price, qtyPerPurchaseUnit, qtyUOM, innerQty, packSize, packUOM, priceType,
  )
  const conversionFactor = calcConversionFactor(
    countUOM, qtyPerPurchaseUnit, qtyUOM, innerQty, packSize, packUOM,
  )
  const baseUnit = deriveBaseUnit(qtyUOM, packUOM)

  const enteredStock = row.stockOnHand.trim() === '' ? 0 : Number(row.stockOnHand)
  if (!Number.isFinite(enteredStock) || enteredStock < 0) {
    throw new Error(`mapRowToPayload: invalid Stock On Hand: ${row.stockOnHand}`)
  }
  const stockOnHand = enteredStock * conversionFactor

  return {
    itemName: row.itemName.trim(),
    category: 'UNASSIGNED',
    purchaseUnit,
    qtyPerPurchaseUnit,
    qtyUOM,
    packSize,
    packUOM,
    innerQty,
    priceType,
    countUOM,
    purchasePrice: price,
    pricePerBaseUnit,
    conversionFactor,
    baseUnit,
    stockOnHand,
    barcode: row.barcode.trim() || null,
    isActive: true,
  }
}

// ── File parsing ─────────────────────────────────────────────────────────────
/**
 * Parses a .csv or .xlsx buffer into RawRows. Throws Error with a
 * human-readable message on unreadable files or missing columns.
 */
export function parseImportFile(buffer: Buffer): RawRow[] {
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(buffer, { type: 'buffer' })
  } catch {
    throw new Error('Could not read this file — make sure it is a .csv or .xlsx')
  }
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('The file has no sheets')
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
    header: 1, blankrows: true, defval: '',
  })
  if (matrix.length === 0) throw new Error('The file is empty')

  const headerRaw = (matrix[0] as unknown[]).map(h => String(h ?? '').trim())
  const headerLower = headerRaw.map(h => h.toLowerCase())
  const importHeadersLower = IMPORT_HEADERS.map(h => h.toLowerCase())
  const missing = IMPORT_HEADERS.filter((_, i) => !headerLower.includes(importHeadersLower[i]))
  if (missing.length > 0) {
    throw new Error(`Missing required columns: ${missing.join(', ')}`)
  }
  const colIndex = (name: string) => headerLower.indexOf(name.toLowerCase())

  const rows: RawRow[] = []
  for (let i = 1; i < matrix.length; i++) {
    const r = matrix[i] as unknown[]
    const cell = (name: string) => String(r[colIndex(name)] ?? '').trim()
    if (IMPORT_HEADERS.every(h => cell(h) === '')) continue   // skip blank rows
    rows.push({
      rowNumber: i + 1,
      itemName: cell('Item Name'),
      purchasePrice: cell('Purchase Price'),
      priceBasis: cell('Price Basis'),
      caseContains: cell('Case Contains'),
      contentUnit: cell('Content Unit'),
      stockOnHand: cell('Stock On Hand'),
      barcode: cell('Barcode'),
    })
  }
  return rows
}

// ── Validation ───────────────────────────────────────────────────────────────
/**
 * Classifies each row as valid / error / duplicate.
 * @param existingNamesLower lowercased trimmed names of items already in the DB
 */
export function validateRows(rows: RawRow[], existingNamesLower: Set<string>): ImportReport {
  const seenInFile = new Set<string>()
  const reports: RowReport[] = []

  for (const row of rows) {
    const errors: string[] = []
    const name = row.itemName.trim()
    const nameLower = name.toLowerCase()

    if (!name) errors.push('Item Name is required')

    const price = Number(row.purchasePrice)
    if (row.purchasePrice.trim() === '' || !Number.isFinite(price) || price < 0) {
      errors.push('Purchase Price must be a number of 0 or more')
    }

    const basis = normalizePriceBasis(row.priceBasis)
    if (!basis) {
      errors.push(`Price Basis "${row.priceBasis}" not recognized — use one of: ${PRICE_BASES.join(', ')}`)
    }

    if (basis === 'Per Case') {
      const caseContains = Number(row.caseContains)
      if (row.caseContains.trim() === '' || !Number.isFinite(caseContains) || caseContains <= 0) {
        errors.push('Case Contains must be a number greater than 0 for Per Case items')
      }
      if (!normalizeContentUnit(row.contentUnit)) {
        errors.push(`Content Unit "${row.contentUnit}" not recognized — use one of: ${CONTENT_UNITS.join(', ')}`)
      }
    }

    if (row.stockOnHand.trim() !== '') {
      const stock = Number(row.stockOnHand)
      if (!Number.isFinite(stock) || stock < 0) {
        errors.push('Stock On Hand must be a number of 0 or more')
      }
    }

    if (errors.length > 0) {
      reports.push({ rowNumber: row.rowNumber, itemName: name, status: 'error', errors })
      continue
    }

    if (existingNamesLower.has(nameLower) || seenInFile.has(nameLower)) {
      reports.push({ rowNumber: row.rowNumber, itemName: name, status: 'duplicate', errors: [] })
      continue
    }
    seenInFile.add(nameLower)

    try {
      const payload = mapRowToPayload(row)
      reports.push({
        rowNumber: row.rowNumber,
        itemName: name,
        status: 'valid',
        errors: [],
        payload,
        computed: { pricePerBaseUnit: payload.pricePerBaseUnit, baseUnit: payload.baseUnit },
      })
    } catch (e) {
      reports.push({
        rowNumber: row.rowNumber,
        itemName: name,
        status: 'error',
        errors: [e instanceof Error ? e.message : 'Could not compute pricing for this row'],
      })
    }
  }

  return {
    rows: reports,
    validCount: reports.filter(r => r.status === 'valid').length,
    errorCount: reports.filter(r => r.status === 'error').length,
    duplicateCount: reports.filter(r => r.status === 'duplicate').length,
  }
}

```


---

## `src/lib/invoice-format.ts`

```ts
export interface InvoiceFormat {
  packQty: number   // units per purchase (e.g. 4 for "4 jugs/crate")
  packSize: number  // size per unit (e.g. 4 for "4L/jug")
  packUOM: string   // unit of measure (e.g. "L", "kg", "each")
}

/**
 * Parse pack format from a product description string.
 * Handles patterns like:
 *   "4/4L"      → { packQty:4, packSize:4, packUOM:"l" }
 *   "6x500ml"   → { packQty:6, packSize:500, packUOM:"ml" }
 *   "2KG"       → { packQty:1, packSize:2, packUOM:"kg" }
 *   "6/12-ct"   → { packQty:6, packSize:12, packUOM:"each" }
 *   "24 count"  → { packQty:1, packSize:24, packUOM:"each" }
 *   "6x4"       → { packQty:6, packSize:4, packUOM:"each" }
 */
export function parseFormatFromDescription(description: string): InvoiceFormat | null {
  const lower = description.toLowerCase()

  // "4/4L" or "4/500ml" — qty / size + volume/weight UOM
  const slashVolumeMatch = lower.match(/(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*(l|ml|kg|g|lb|oz)\b/)
  if (slashVolumeMatch) return { packQty: +slashVolumeMatch[1], packSize: +slashVolumeMatch[2], packUOM: slashVolumeMatch[3] }

  // "4x4L" or "6x500ml"
  const xVolumeMatch = lower.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(l|ml|kg|g|lb|oz)\b/)
  if (xVolumeMatch) return { packQty: +xVolumeMatch[1], packSize: +xVolumeMatch[2], packUOM: xVolumeMatch[3] }

  // "6/12-ct", "6/12ct", "6/12 count" — qty / count
  const slashCountMatch = lower.match(/(\d+)\s*\/\s*(\d+)\s*[-\s]?(?:count|ct|pc|pcs|pieces?)\b/)
  if (slashCountMatch) return { packQty: +slashCountMatch[1], packSize: +slashCountMatch[2], packUOM: 'each' }

  // "6x4" or "6x12" with no UOM — treat as count packs
  const xCountMatch = lower.match(/(\d+)\s*x\s*(\d+)\b(?!\s*(?:l|ml|kg|g|lb|oz))/)
  if (xCountMatch) return { packQty: +xCountMatch[1], packSize: +xCountMatch[2], packUOM: 'each' }

  // "24 count", "24-ct", "12 each", "12 pc" — single count pack
  const singleCountMatch = lower.match(/(\d+)\s*[-\s]?(?:count|ct|pcs?|pieces?|each|ea)\b/)
  if (singleCountMatch) return { packQty: 1, packSize: +singleCountMatch[1], packUOM: 'each' }

  // "2KG", "500ML", "4L" — single volume/weight size, no multiplier
  const singleVolumeMatch = lower.match(/(\d+(?:\.\d+)?)\s*(l|ml|kg|g|lb|oz)\b/)
  if (singleVolumeMatch) return { packQty: 1, packSize: +singleVolumeMatch[1], packUOM: singleVolumeMatch[2] }

  return null
}

// ── Unit normalisation ──────────────────────────────────────────────────────
// Maps every unit label → its SI base (ml for volume, g for weight, each for count)
// and the factor needed to convert 1 of this unit into that base.
// e.g. 1 L = 1000 ml  →  factor = 1000
export const UNIT_SCALE: Record<string, { base: string; factor: number }> = {
  // Volume
  ml:       { base: 'ml', factor: 1 },
  milliliter: { base: 'ml', factor: 1 },
  l:        { base: 'ml', factor: 1000 },
  liter:    { base: 'ml', factor: 1000 },
  litre:    { base: 'ml', factor: 1000 },
  // Weight
  g:        { base: 'g',  factor: 1 },
  gram:     { base: 'g',  factor: 1 },
  kg:       { base: 'g',  factor: 1000 },
  kilogram: { base: 'g',  factor: 1000 },
  lb:       { base: 'g',  factor: 453.592 },
  lbs:      { base: 'g',  factor: 453.592 },
  oz:       { base: 'g',  factor: 28.3495 },
  ounce:    { base: 'g',  factor: 28.3495 },
  // Count
  each:     { base: 'each', factor: 1 },
  unit:     { base: 'each', factor: 1 },
  piece:    { base: 'each', factor: 1 },
  pc:       { base: 'each', factor: 1 },
}

/** Convert a price-per-unit to price-per-SI-base-unit. Returns null if unit unknown. */
export function toPricePerSIBase(pricePerUnit: number, unit: string): { price: number; base: string } | null {
  const scale = UNIT_SCALE[unit.toLowerCase()]
  if (!scale) return null
  return { price: pricePerUnit / scale.factor, base: scale.base }
}

/**
 * Compare two prices that may be in different but compatible units.
 * e.g. invoice: $19.96/kg  vs  inventory: $0.02/g  →  +0.2% diff
 *
 * Returns { pctDiff, invoicePPB, inventoryPPB, baseUnit } or null when
 * units are incompatible (e.g. kg vs ml).
 */
export function comparePricesNormalized(
  invoicePPU: number, invoiceUnit: string,
  inventoryPPU: number, inventoryUnit: string,
): {
  pctDiff: number
  invoicePPB: number     // invoice price per SI base unit
  inventoryPPB: number   // inventory price per SI base unit
  baseUnit: string       // common SI base (g / ml / each)
} | null {
  const invNorm  = toPricePerSIBase(invoicePPU,    invoiceUnit)
  const invtNorm = toPricePerSIBase(inventoryPPU,  inventoryUnit)
  if (!invNorm || !invtNorm || invNorm.base !== invtNorm.base) return null
  if (invtNorm.price <= 0) return null
  return {
    pctDiff:      Math.round(((invNorm.price - invtNorm.price) / invtNorm.price) * 10000) / 100,
    invoicePPB:   invNorm.price,
    inventoryPPB: invtNorm.price,
    baseUnit:     invNorm.base,
  }
}

/**
 * Given the invoice's per-unit price and format, return what the inventory's
 * purchasePrice should become (normalized to the inventory item's purchase format).
 *
 * e.g. invoice: $44.09 / 16L = $2.756/L = $0.002756/mL
 *      inventory: qtyPerPurchaseUnit=4, packSize=4, packUOM="L" → total 16L
 *      → newPurchasePrice = $0.002756/mL × 16,000 mL = $44.09
 */
export function calcNewPurchasePrice(
  invoicePPU: number,   // $/invoiceUnit
  invoiceUnit: string,
  invQtyPerPurchase: number,  // inventory qtyPerPurchaseUnit
  invPackSize: number,         // inventory packSize
  invPackUOM: string,          // inventory packUOM
): number | null {
  const invScale  = UNIT_SCALE[invoiceUnit.toLowerCase()]
  const invtScale = UNIT_SCALE[invPackUOM.toLowerCase()]
  if (!invScale || !invtScale || invScale.base !== invtScale.base) return null

  // Convert invoice price to per-SI-base, then scale to inventory pack
  const invoicePPBase = invoicePPU / invScale.factor   // $/g or $/ml
  const invTotalBase  = invQtyPerPurchase * invPackSize * invtScale.factor  // total g or ml per purchase
  if (invTotalBase <= 0) return null
  return invoicePPBase * invTotalBase
}

/** Price per base unit for an invoice line (no unit normalization — raw) */
export function calcInvoicePricePerBase(unitPrice: number, fmt: InvoiceFormat): number | null {
  const total = fmt.packQty * fmt.packSize
  if (total <= 0) return null
  return unitPrice / total
}

/** % diff between invoice pricePerBase and inventory pricePerBase (same unit, no conversion) */
export function calcPricePerBaseDiff(invoicePPB: number, inventoryPPB: number): number | null {
  if (inventoryPPB <= 0) return null
  return Math.round(((invoicePPB - inventoryPPB) / inventoryPPB) * 10000) / 100
}

```


---

## `src/lib/invoice-matcher.ts`

```ts
import { prisma } from '@/lib/prisma'
import type { OcrLineItem } from '@/lib/invoice-ocr'
import { parseFormatFromDescription, comparePricesNormalized, calcNewPurchasePrice } from '@/lib/invoice-format'

// Normalises common OCR abbreviations to the canonical purchaseUnit strings used in inventory
const UOM_ALIASES: Record<string, string> = {
  cs:      'case',
  cases:   'case',
  cse:     'case',
  ctn:     'case',
  carton:  'case',
  bx:      'case',
  box:     'case',
  boxes:   'case',
  ea:      'each',
  pc:      'each',
  pcs:     'each',
  piece:   'each',
  pieces:  'each',
  ct:      'each',
  bt:      'each',
  bottle:  'each',
  btl:     'each',
  btls:    'each',
  pk:      'pack',
  pkg:     'pack',
  packs:   'pack',
  bg:      'bag',
  bag:     'bag',
  bags:    'bag',
}

function normalizeUOM(uom: string): string {
  const lower = uom.trim().toLowerCase()
  return UOM_ALIASES[lower] ?? lower
}

export type MatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
export type LineItemAction = 'PENDING' | 'UPDATE_PRICE' | 'ADD_SUPPLIER' | 'CREATE_NEW' | 'SKIP'

export interface MatchResult {
  matchedItemId: string | null
  matchConfidence: MatchConfidence
  matchScore: number
  action: LineItemAction
  previousPrice: number | null
  newPrice: number | null
  priceDiffPct: number | null
  formatMismatch: boolean
  invoicePackQty: number | null
  invoicePackSize: number | null
  invoicePackUOM: string | null
  needsFormatConfirm: boolean
  totalQty: number | null
  totalQtyUOM: string | null
}

interface InventoryItem {
  id: string
  itemName: string
  purchaseUnit: string
  pricePerBaseUnit: number
  purchasePrice: number
  baseUnit: string
  qtyPerPurchaseUnit: number
  packSize: number
  packUOM: string
  // Pre-computed at load time for efficiency
  _normName?: string[]
  _keyName?: string[]
}

// Generic food descriptors that appear in many products and should not drive matching
const STOP_WORDS = new Set([
  'fresh', 'frozen', 'dried', 'whole', 'sliced', 'diced', 'chopped', 'minced',
  'organic', 'natural', 'pure', 'premium', 'select', 'choice', 'fancy', 'extra',
  'low', 'high', 'ultra', 'super', 'regular', 'original', 'classic',
  'white', 'black', 'red', 'green', 'yellow', 'dark', 'light',
  'large', 'small', 'medium', 'mini', 'jumbo', 'bulk', 'size',
  'and', 'the', 'for', 'with', 'from',
])

// Normalize: lowercase, strip punctuation, split into meaningful words
function normalize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2)
}

// Key words: normalize then remove stop words (what the product actually is)
function keyWords(s: string): string[] {
  return normalize(s).filter(w => !STOP_WORDS.has(w))
}

// Compute a match score (0–100) between an invoice description and an inventory item
// Uses pre-normalized name arrays when available (set by matchLineItems for efficiency)
function scoreMatch(description: string, item: InventoryItem, descNorm: string[], descKey: string[]): number {
  const nameNorm = item._normName ?? normalize(item.itemName)
  const nameKey  = item._keyName  ?? keyWords(item.itemName)

  // ── Exact match ──────────────────────────────────────────────────────────
  if (descNorm.join(' ') === nameNorm.join(' ')) return 100

  // ── Key word overlap (the core signal) ───────────────────────────────────
  if (descKey.length === 0 || nameKey.length === 0) return 0

  const descKeySet = new Set(descKey)
  const nameKeySet = new Set(nameKey)

  const overlapCount = nameKey.filter(w => descKeySet.has(w)).length

  // Hard requirement: at least one key word must overlap
  if (overlapCount === 0) return 0

  // Jaccard-style ratio over key words
  const union = new Set([...descKey, ...nameKey]).size
  const jaccardScore = (overlapCount / union) * 100

  // Coverage: what fraction of the inventory name's key words appear in the description
  const nameCoverage = overlapCount / nameKey.length

  let score = Math.max(jaccardScore, nameCoverage * 75)

  // Bonus: all inventory key words are in the description (full name covered)
  if (nameKey.every(w => descKeySet.has(w))) {
    score = Math.max(score, 70)
    // Extra bonus if name key words appear in order at the start
    if (descKey.slice(0, nameKey.length).join(' ') === nameKey.join(' ')) score = Math.max(score, 85)
  }

  // Bonus: first key word of both sides matches (same product type)
  if (descKey[0] && nameKey[0] && descKey[0] === nameKey[0]) score += 12

  // Strong penalty: first key words are completely different product types
  if (descKey[0] && nameKey[0] && descKey[0] !== nameKey[0]
      && !nameKeySet.has(descKey[0]) && !descKeySet.has(nameKey[0])) {
    score *= 0.4
  }

  return Math.min(Math.round(score), 99)
}

function confidenceFromScore(score: number): MatchConfidence {
  if (score >= 65) return 'HIGH'
  if (score >= 40) return 'MEDIUM'
  if (score >= 25) return 'LOW'
  return 'NONE'
}

function buildMatchResult(
  ocrItem: OcrLineItem,
  bestItem: InventoryItem,
  confidence: MatchConfidence,
  bestScore: number,
  format?: { packQty: number; packSize: number; packUOM: string } | null,
  formatConfirmed = false   // true only when format came from a saved learned rule
): OcrLineItem & MatchResult {
  const previousPrice = Number(bestItem.purchasePrice)
  // For per_weight items, the rate ($/kg) is the meaningful price to carry forward —
  // rawUnitPrice is the line total per container (e.g. $292/case) which changes each
  // shipment based on catch-weight and should never overwrite purchasePrice.
  const effectiveUnitPrice = ocrItem.pricingMode === 'per_weight' && ocrItem.rate != null
    ? Number(ocrItem.rate)
    : ocrItem.unitPrice
  const rawUnitPrice = effectiveUnitPrice

  let newPrice: number | null = rawUnitPrice ?? null
  let priceDiffPct: number | null = null
  let invoicePackQty: number | null = null
  let invoicePackSize: number | null = null
  let invoicePackUOM: string | null = null
  let needsFormatConfirm = false

  if (format) {
    // Always store the parsed format for display
    invoicePackQty = format.packQty
    invoicePackSize = format.packSize
    invoicePackUOM = format.packUOM

    if (formatConfirmed && rawUnitPrice !== null) {
      // ── Per-base comparison — only when the user previously confirmed this format ──
      // Convert invoice price to per-packUOM (e.g. $/L), then normalize to SI base
      const total = format.packQty * format.packSize
      if (total > 0) {
        const invoicePricePerPackUOM = rawUnitPrice / total  // e.g. $2.756/L
        // Recompute inventory's price-per-packUOM from raw fields so we never
        // rely on the stored pricePerBaseUnit (which can be stale / mis-scaled).
        const invPackTotal = Number(bestItem.qtyPerPurchaseUnit) * Number(bestItem.packSize)
        const invPricePerPackUOM = invPackTotal > 0 ? Number(bestItem.purchasePrice) / invPackTotal : 0
        const normalized = comparePricesNormalized(
          invoicePricePerPackUOM, format.packUOM,    // invoice: $/packUOM
          invPricePerPackUOM,     bestItem.packUOM   // inventory: $/packUOM (recomputed)
        )

        if (normalized) {
          priceDiffPct = normalized.pctDiff
          // Calculate newPrice normalized to inventory's purchase format
          const calcPrice = calcNewPurchasePrice(
            invoicePricePerPackUOM, format.packUOM,
            Number(bestItem.qtyPerPurchaseUnit), Number(bestItem.packSize), bestItem.packUOM
          )
          if (calcPrice !== null) newPrice = calcPrice
        } else {
          // Truly incompatible units (e.g. kg vs mL) — fall back to direct comparison
          if (previousPrice > 0) {
            priceDiffPct = Math.round(((rawUnitPrice - previousPrice) / previousPrice) * 10000) / 100
          }
          needsFormatConfirm = true
        }
      }
    } else {
      // Format auto-parsed but not yet confirmed — use direct price comparison,
      // show the parsed format hint, and prompt user to confirm it
      if (previousPrice > 0 && rawUnitPrice !== null) {
        priceDiffPct = Math.round(((rawUnitPrice - previousPrice) / previousPrice) * 10000) / 100
      }
      // Flag for confirmation only if the item has a non-trivial format
      const hasComplexFormat = bestItem.packUOM && bestItem.packUOM.toLowerCase() !== 'each'
        && Number(bestItem.packSize) > 1
      needsFormatConfirm = !!(hasComplexFormat && rawUnitPrice !== null)
    }
  } else {
    // No format info — direct purchase price comparison
    if (previousPrice > 0 && rawUnitPrice !== null) {
      priceDiffPct = Math.round(((rawUnitPrice - previousPrice) / previousPrice) * 10000) / 100
    }
    newPrice = rawUnitPrice ?? null
    const hasComplexFormat = bestItem.packUOM && bestItem.packUOM.toLowerCase() !== 'each'
      && Number(bestItem.packSize) > 1
    needsFormatConfirm = !!(hasComplexFormat && rawUnitPrice !== null)
  }

  let action: LineItemAction = 'PENDING'
  if (confidence === 'HIGH' || confidence === 'MEDIUM') {
    action = (priceDiffPct !== null && Math.abs(priceDiffPct) > 0.1) ? 'UPDATE_PRICE' : 'ADD_SUPPLIER'
  }

  const formatMismatch = !!(
    ocrItem.qtyShippedUOM &&
    bestItem.purchaseUnit &&
    normalizeUOM(ocrItem.qtyShippedUOM) !== normalizeUOM(bestItem.purchaseUnit)
  )

  return {
    ...ocrItem,
    matchedItemId: bestItem.id,
    matchConfidence: confidence,
    matchScore: bestScore,
    action,
    previousPrice,
    newPrice,
    priceDiffPct: priceDiffPct ?? null,
    formatMismatch,
    invoicePackQty,
    invoicePackSize,
    invoicePackUOM,
    needsFormatConfirm,
    totalQty:    ocrItem.totalQty    ?? null,
    totalQtyUOM: ocrItem.totalQtyUOM ?? ocrItem.packUOM ?? null,
  }
}

export async function matchLineItems(
  ocrItems: OcrLineItem[],
  supplierName?: string | null
): Promise<(OcrLineItem & MatchResult)[]> {
  const inventoryItems = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true,
      itemName: true,
      purchaseUnit: true,
      pricePerBaseUnit: true,
      purchasePrice: true,
      baseUnit: true,
      qtyPerPurchaseUnit: true,
      packSize: true,
      packUOM: true,
    },
  })

  // Load learned rules — gracefully fall back to empty if the table doesn't exist yet
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let learnedRules: any[] = []
  try {
    learnedRules = await prisma.invoiceMatchRule.findMany({
      where: {
        rawDescription: { in: ocrItems.map(i => i.description) },
        supplierName: { in: [supplierName ?? '', ''] },
      },
      include: {
        inventoryItem: {
          select: {
            id: true,
            itemName: true,
            purchaseUnit: true,
            pricePerBaseUnit: true,
            purchasePrice: true,
            baseUnit: true,
            qtyPerPurchaseUnit: true,
            packSize: true,
            packUOM: true,
          },
        },
      },
      orderBy: { useCount: 'desc' },
    })
  } catch {
    // Table may not exist yet — proceed with fuzzy matching only
  }

  // Build learned map: description → best rule (supplier-specific beats generic)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const learnedMap = new Map<string, any>()
  for (const rule of learnedRules) {
    const existing = learnedMap.get(rule.rawDescription)
    if (!existing || (rule.supplierName !== '' && existing.supplierName === '')) {
      learnedMap.set(rule.rawDescription, rule)
    }
  }

  // Pre-normalize all inventory item names once — avoids re-computing per OCR item
  const normalizedItems = inventoryItems.map(item => ({
    ...item,
    _normName: normalize(item.itemName),
    _keyName:  keyWords(item.itemName),
  })) as unknown as InventoryItem[]

  return ocrItems.map((ocrItem) => {
    // ── 1. Check learned rules first ───────────────────────────────────────
    const learned = learnedMap.get(ocrItem.description)
    if (learned?.inventoryItem) {
      const hasLearnedFormat = !!(learned.invoicePackQty && learned.invoicePackSize)
      const learnedFormat = hasLearnedFormat ? {
        packQty: Number(learned.invoicePackQty),
        packSize: Number(learned.invoicePackSize),
        packUOM: learned.invoicePackUOM ?? 'each',
      } : parseFormatFromDescription(ocrItem.description)

      return buildMatchResult(
        ocrItem,
        learned.inventoryItem as unknown as InventoryItem,
        'HIGH',
        100,
        learnedFormat,
        hasLearnedFormat
      )
    }

    // ── 2. Fuzzy score every inventory item (using pre-normalized names) ───
    const descNorm = normalize(ocrItem.description)
    const descKey  = keyWords(ocrItem.description)
    let bestScore = 0
    let bestItem: InventoryItem | null = null

    for (const item of normalizedItems) {
      const score = scoreMatch(ocrItem.description, item, descNorm, descKey)
      if (score > bestScore) {
        bestScore = score
        bestItem = item
      }
    }

    const confidence = confidenceFromScore(bestScore)

    if (!bestItem || confidence === 'NONE') {
      return {
        ...ocrItem,
        matchedItemId: null,
        matchConfidence: 'NONE' as MatchConfidence,
        matchScore: bestScore,
        action: 'CREATE_NEW' as LineItemAction,
        previousPrice: null,
        newPrice: ocrItem.unitPrice,
        priceDiffPct: null,
        formatMismatch: false,
        invoicePackQty:  ocrItem.packQty  ?? null,
        invoicePackSize: ocrItem.packSize ?? null,
        invoicePackUOM:  ocrItem.packUOM  ?? null,
        needsFormatConfirm: false,
        totalQty:    ocrItem.totalQty    ?? null,
        totalQtyUOM: ocrItem.totalQtyUOM ?? ocrItem.packUOM ?? null,
      }
    }

    const ocrHasPack = !!(ocrItem.packQty || ocrItem.packSize)
    const ocrFormat = ocrHasPack ? {
      packQty:  ocrItem.packQty  ?? 1,
      packSize: ocrItem.packSize ?? 1,
      packUOM:  ocrItem.packUOM  ?? 'each',
    } : null
    const format = ocrFormat ?? parseFormatFromDescription(ocrItem.description)
    return buildMatchResult(ocrItem, bestItem, confidence, bestScore, format, ocrHasPack)
  })
}

// Save a learned match rule. Call this when a user confirms (or overrides) a match.
export async function saveMatchRule(
  rawDescription: string,
  inventoryItemId: string,
  supplierName?: string | null,
  format?: { packQty: number; packSize: number; packUOM: string } | null
): Promise<void> {
  await prisma.invoiceMatchRule.upsert({
    where: {
      rawDescription_supplierName: {
        rawDescription,
        supplierName: supplierName || '',
      },
    },
    create: {
      rawDescription,
      supplierName: supplierName || '',
      inventoryItemId,
      invoicePackQty: format?.packQty ?? null,
      invoicePackSize: format?.packSize ?? null,
      invoicePackUOM: format?.packUOM ?? null,
    },
    update: {
      inventoryItemId,
      useCount: { increment: 1 },
      lastUsed: new Date(),
      ...(format ? { invoicePackQty: format.packQty, invoicePackSize: format.packSize, invoicePackUOM: format.packUOM } : {}),
    },
  })
}

```


---

## `src/lib/invoice-ocr.ts`

```ts
import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'

const OCR_MODEL = 'claude-sonnet-4-6'

// Claude Code's shell sets ANTHROPIC_API_KEY="" which dotenv won't override.
// Fall back to reading the .env file directly so local dev always works.
function resolveAnthropicKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try {
    const envPath = path.resolve(process.cwd(), '.env')
    const raw = fs.readFileSync(envPath, 'utf-8')
    const match = raw.match(/^ANTHROPIC_API_KEY=["']?([^"'\r\n]+)["']?/m)
    return match?.[1] ?? ''
  } catch {
    return ''
  }
}

// Learning mode: used for the first few invoices from a new supplier.
// Higher quality image + more thinking tokens → slower but more accurate format detection.
// Normal mode: faster, cheaper — used once the supplier format is well understood.
//
// max_tokens is the TOTAL budget (thinking + text). With extended thinking, thinking
// tokens are subtracted from this total, leaving the remainder for JSON output.
// A 100-item invoice needs ~20–25k output tokens; a 150-item one needs ~30k.
// Previous values (20k normal / 32k learning) only left 10–17k for text — any large
// invoice hit the ceiling, truncated the JSON, and caused a parse error → ERROR status.
const NORMAL_MAX_TOKENS   = 40000   // ~32k text budget after 8k thinking
const NORMAL_THINKING     =  8000   // reduced from 10k — saves time, more output room
const LEARNING_MAX_TOKENS = 48000   // ~36k text budget after 12k thinking
const LEARNING_THINKING   = 12000   // reduced from 15k — still plenty for format discovery

// Claude API hard limit per image (bytes after base64 decode)
const API_IMAGE_LIMIT = 5 * 1024 * 1024

// Claude API limit is 5MB per image. Phone photos are often 8–15MB.
// Compress using sharp (native, excluded from webpack via serverExternalPackages).
async function compressImageForClaude(
  base64Data: string,
  learning = false
): Promise<{ data: string; mediaType: 'image/jpeg' }> {
  const sharp = (await import('sharp')).default
  const inputBuffer = Buffer.from(base64Data, 'base64')

  // Learning mode: larger max dimension, higher quality — preserve more detail for
  // format analysis. Normal mode: smaller, faster.
  const maxPx   = learning ? 3500 : 2500
  const quality = learning ? 95   : 90

  let resized = await sharp(inputBuffer)
    .rotate()
    .resize(maxPx, maxPx, { fit: 'inside', withoutEnlargement: true })
    .normalize()
    .sharpen({ sigma: 1.2, m2: 0.5 })
    .jpeg({ quality })
    .toBuffer()

  if (learning) {
    if (resized.length > 4.8 * 1024 * 1024) {
      resized = await sharp(resized).jpeg({ quality: 85 }).toBuffer()
    }
    if (resized.length > API_IMAGE_LIMIT) {
      resized = await sharp(resized)
        .resize(2500, 2500, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer()
    }
  } else {
    let q = quality
    while (resized.length > 4 * 1024 * 1024 && q > 60) {
      q -= 15
      resized = await sharp(resized).jpeg({ quality: q }).toBuffer()
    }
    if (resized.length > 4 * 1024 * 1024) {
      resized = await sharp(resized)
        .resize(1800, 1800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer()
    }
  }

  return { data: resized.toString('base64'), mediaType: 'image/jpeg' }
}

// ── Base system prompt ─────────────────────────────────────────────────────────
// Format examples are intentionally kept out of BASE — they live in the per-supplier
// hints so they're only paid for once the supplier is known. Keeps token cost flat.
const BASE_PROMPT = `You are an expert invoice parser for a restaurant supply chain system.
Extract every product line item and all header data from the invoice image(s).
If multiple pages are provided, treat them as one invoice and combine all line items.
Return ONLY valid JSON matching the schema below. No markdown, no commentary.

═══════════════════════════════════════════════════════
OUTPUT SCHEMA
═══════════════════════════════════════════════════════
{
  "supplierName":    string | null,
  "invoiceNumber":   string | null,
  "invoiceDate":     "YYYY-MM-DD" | null,
  "poNumber":        string | null,
  "subtotal":        number | null,
  "discount":        number | null,
  "fuelSurcharge":   number | null,
  "freight":         number | null,
  "minimumOrderFee": number | null,
  "gst":             number | null,
  "hst":             number | null,
  "pst":             number | null,
  "otherCharges":    [ { "label": string, "amount": number } ],
  "total":           number | null,
  "lineItems": [ {
    "description":       string,
    "supplierItemCode":  string | null,
    "lineCategory":      string | null,
    "pricingMode":       "per_case" | "per_weight" | "unknown",
    "pricingModeSignal": "explicit_per_column" | "price_uom_is_weight"
                       | "weight_column_present" | "math_inference"
                       | "default_case" | "indeterminate",
    "qtyOrdered":    number | null,
    "qtyOrderedUOM": string | null,
    "qtyShipped":    number | null,
    "qtyShippedUOM": string | null,
    "packQty":  number | null,
    "packSize": number | null,
    "packUOM":  string | null,
    "unitPrice":   number | null,
    "rate":        number | null,
    "rateUOM":     string | null,
    "totalQty":    number | null,
    "totalQtyUOM": string | null,
    "isCatchweight": boolean,
    "nominalWeight": number | null,
    "lineTotal":     number | null,
    "taxFlag":       string | null,
    "lineTaxAmount": number | null,
    "confidence":      "low" | "medium" | "high",
    "confidenceNotes": string | null,
    "bbox": { "page": 0, "x": 0.0, "y": 0.0, "w": 1.0, "h": 0.05 } | null
  } ]
}

═══════════════════════════════════════════════════════
UNIVERSAL PURCHASE STRUCTURE
═══════════════════════════════════════════════════════
Every line follows a 3-level hierarchy:
  CASE = outer unit shipped (case, box, bag, ea)
  PKG  = packages inside each case
  UNIT = what each pkg contains (volume, weight, or count)

Pricing is ONE of two modes:
  per_case   — invoice states $/case; lineTotal = qtyShipped × unitPrice
  per_weight — invoice states $/kg or $/lb; lineTotal = totalQty × rate
               (rate is the PRIMARY price field for per_weight items)

═══════════════════════════════════════════════════════
STEP 0 — COLUMN LAYOUT DISCOVERY (run once before processing rows)
═══════════════════════════════════════════════════════
If a supplier hint is provided below, use its column definitions directly.

If no supplier hint is available, scan the invoice header row to identify:
  a) ANCHOR column — product code / item number that appears on every real
     product row. Rows missing this anchor are headers, subtotals, or notes.
  b) MODE column — "per", "U/M", "UNIT", or similar, adjacent to the price
     column. Values: kg/lb → per_weight rows; cs/ea/pc/bx → per_case rows.
     If no explicit mode column, look for $/kg or $/lb labels on the price.
  c) WEIGHT column — numeric values labeled KG or LB, positioned between
     the qty columns and the price/total columns. This is totalQty for
     per_weight rows. It is NOT the same as qtyShipped.
  d) PRICE column — dollar amount per unit. Labeled $/kg, $/lb, $/cs, PRICE,
     UNIT PRICE, etc.
  e) TOTAL column — the rightmost dollar column (EXTENSION, AMOUNT, TOTAL).

Record this layout and apply it consistently to every line.

═══════════════════════════════════════════════════════
STEP 1 — Is this a real product line?
═══════════════════════════════════════════════════════
Skip rows matching ANY of:
  • Category headers (DAIRY, PRODUCE, FROZEN, COOLER, DRY, PAPER, BEVERAGE, GROCERY...)
    — especially when wrapped in dashes (-- DAIRY --) or asterisks (** DRY **)
  • Category subtotals: "Total NN.NN" rows with no item code
  • Non-product charges: fuel surcharge, freight, delivery fee, minimum order,
    recycling / bottle / environmental fees → capture into HEADER fields, not line items
  • Tax lines: GST, HST, PST, QST, TVQ (standalone or summary)
  • Page aggregates: page total, order total, subtotal, invoice total
  • Column header rows, boilerplate/legal/payment terms
  • Traceability sub-lines: LOT#, MSC-C-XXXXX, ASC-C-XXXXX, fishing method,
    habitat (WILD), grade lines
  • Brand-name-only continuation rows
  • End-of-invoice category summary tables

═══════════════════════════════════════════════════════
STEP 2 — Detect pricing mode. Walk rules in order; first match wins.
═══════════════════════════════════════════════════════
Record which fired in pricingModeSignal.
  (a) explicit_per_column:
      Row has "per" / "U/M" column adjacent to unit price.
      → per_weight if UOM is kg, lb, g, oz
      → per_case   if UOM is cs, pk, ea, pc, ct, bx, bg
  (b) price_uom_is_weight:
      Unit price label is $/kg, $/lb, /KG, /LB, $/oz, etc.
      → per_weight
  (c) weight_column_present:
      Dedicated weight column populated AND (weight × price ≈ lineTotal) within 2%.
      → per_weight
  (d) math_inference:
      Try (qtyShipped × unitPrice ≈ lineTotal) and (weight × price ≈ lineTotal).
      Whichever passes within 2% wins.
  (e) default_case:
      No weight signals → per_case.

If none of (a)–(e) resolves confidently:
  pricingMode = "unknown", signal = "indeterminate", confidence = "low".

═══════════════════════════════════════════════════════
STEP 3 — Extract fields per mode.
═══════════════════════════════════════════════════════
Universal (always extract):
  description       — exact product text. Merge multi-row descriptions; drop
                      brand-only continuation rows.
  supplierItemCode  — per-line product code
  qtyOrdered, qtyOrderedUOM, qtyShipped, qtyShippedUOM
    UOM is the column label as shown (CS, PC, PK, EA, LB, KG).
    Normalize: LITRE→L, MILLILITRE→ml, KILOGRAM→kg, POUNDS→lb,
               OUNCE→oz, EACH→each
  packQty, packSize, packUOM — nominal pack composition from PACK column
                               or description ("4/4L", "6x500ml")
  lineTotal         — total charged for this row
  taxFlag           — row-level tax code (B, G, GP) or null
  lineTaxAmount     — inline tax on row (Snow Cap style)
  lineCategory      — category label/code shown on the row (Sysco section
                      header above, Gordon "Cust Cat" code)

Mode-specific:
  per_case:
    unitPrice = $/case shown on row
    rate, rateUOM, totalQty, totalQtyUOM = null
  per_weight:
    rate        = $/kg or $/lb shown on row  ← PRIMARY price field
    rateUOM     = UOM of rate (kg, lb, g, oz)
    totalQty    = ACTUAL weight/volume delivered for the line — read from the
                  dedicated WEIGHT column. NEVER derive from description math
                  or from qtyShipped when qtyShippedUOM is a container unit.
    totalQtyUOM = matching UOM (same as rateUOM)
    unitPrice   = lineTotal ÷ qtyShipped  (secondary: per-container cost as
                  shipped — equals rate only when qtyShipped is itself a weight)

⚠ unitPrice is ALWAYS populated whenever qtyShipped > 0 and lineTotal is known.
  For per_weight, rate is what matters for price comparison; unitPrice is secondary.

═══════════════════════════════════════════════════════
STEP 4 — Cross-check math.
═══════════════════════════════════════════════════════
  per_case:   qtyShipped × unitPrice ≈ lineTotal
  per_weight: totalQty   × rate      ≈ lineTotal
Bands:
  within 1% → confidence = "high"
  1–5%      → confidence = "medium"
  > 5%      → confidence = "low" (re-examine row first — likely you read a
              value from the wrong row)

═══════════════════════════════════════════════════════
STEP 5 — Catchweight (per_weight rows only)
═══════════════════════════════════════════════════════
isCatchweight = true if ANY of:
  (a) qtyShippedUOM is a container unit (CS, PK, EA, BX, BG, PC) — item is
      priced by weight but shipped as discrete containers whose actual weight
      varies per shipment.
  (b) qtyOrderedUOM is a weight UOM AND qtyOrdered ≠ qtyShipped (weight
      variance between ordered and delivered).
  (c) packUOM is a weight/volume UOM AND (packQty × packSize) differs from
      totalQty by > 2% (actual weight differs from nominal pack spec).
Set nominalWeight = packQty × packSize when (c) applies and values are known.
Otherwise nominalWeight = null.
For per_case rows: isCatchweight = false, nominalWeight = null.

═══════════════════════════════════════════════════════
ROW ALIGNMENT — READ HORIZONTALLY, NEVER BORROW
═══════════════════════════════════════════════════════
Invoice tables are row-structured. For each line:
  • Read all fields from the SAME row.
  • Never pull qty/price/total from an adjacent row.
  • Multi-row items: rows 2+ may continue the description (brand,
    certifications, fishing method). Merge their text into description;
    they hold NO financial data.
  • Two-row items (Legends Haul / Acecard): row 1 has everything; row 2 is
    brand only — skip row 2 entirely, do not create a new line item.

If a field is genuinely absent, use null. Never invent values.

═══════════════════════════════════════════════════════
HEADER FIELDS
═══════════════════════════════════════════════════════
Capture every fee/charge/tax from the summary block (or non-product lines
skipped in STEP 1):
  subtotal        — pre-tax, pre-fee product total
  discount        — line or order-level discount
  fuelSurcharge   — "fuel charge", "fuel surcharge", "fuel"
  freight         — "freight", "delivery charge"
  minimumOrderFee — "min order fee", "minimum order"
  gst, hst, pst   — Canadian taxes (federal / harmonized / provincial)
  otherCharges    — anything else: [{label, amount}, ...]
  total           — grand total

Single combined "Tax" without a split → put in gst.
"GST/HST" combined → put in hst.

═══════════════════════════════════════════════════════
CONFIDENCE
═══════════════════════════════════════════════════════
high   — all fields clearly legible AND cross-check within 1%.
medium — partially obscured/handwritten but extracted with reasonable
         certainty, OR cross-check within 1–5%.
low    — at least one numeric field genuinely hard to read OR cross-check
         > 5% OR borderline skip-vs-product judgment.

For "low", fill confidenceNotes (< 50 chars): "smudged unit price",
"ambiguous 5 vs 6 in qty", "line total cut off", "handwritten — uncertain".
For "medium"/"high", confidenceNotes = null.

Do NOT mark "low" just because a field was null. Flag only when an
extracted value could be wrong.

═══════════════════════════════════════════════════════
BOUNDING BOX
═══════════════════════════════════════════════════════
For each line item, return the bounding box of the entire row (spanning all
columns) as fractions of the image/page dimensions:
  { "page": <0-indexed file index>,
    "x": <left edge / image width>,
    "y": <top edge / image height>,
    "w": <row width / image width>,
    "h": <row height / image height> }
All values are 0.0–1.0. If the position cannot be determined, return null.

═══════════════════════════════════════════════════════
NUMERIC FORMATTING
═══════════════════════════════════════════════════════
  • Numbers only — no currency symbols, no thousand separators (12.50 not "$12,500")
  • Dates in YYYY-MM-DD
  • null only when a field is genuinely impossible to determine
  • isCatchweight is always boolean — never null
  • otherCharges is always an array — [] if none
  • lineItems is always an array — [] if no products
  • Preserve product descriptions exactly as written`

// ── Supplier-specific format hints ─────────────────────────────────────────────
// Keyed by normalized substring of supplier name. Injected into the prompt when
// the session's supplier is already known, giving Claude exact column layouts
// and worked examples (which BASE_PROMPT deliberately omits to keep tokens low).
const SUPPLIER_HINTS: Record<string, string> = {
  sysco: `
SUPPLIER IDENTIFIED: SYSCO CANADA
Columns (L→R): ITEM NO. | QTY.ORD | QTY.SHPD | B UNIT | PACK SIZE FORMAT
             | BRAND | DESCRIPTION | WEIGHT | PRICE | EXTENSION

ANCHOR: Every product row starts with a 6-7 digit ITEM NO. Skip rows without one.

MODE DETECTION:
  WEIGHT column populated AND PRICE label shows $/lb or $/kg
    → per_weight, signal: price_uom_is_weight
  Otherwise
    → per_case,   signal: default_case

FIELD MAPPING (per_case):
  qtyOrdered = QTY.ORD,  qtyOrderedUOM = "cs"
  qtyShipped = QTY.SHPD, qtyShippedUOM = "cs"
  packQty    = B UNIT
  packSize, packUOM = parse PACK SIZE FORMAT
    "1 KG" → 1,"kg"  |  "3 L" → 3,"L"  |  "8 EA" → 8,"each"  |  "100CT" → 100,"each"
  unitPrice  = PRICE ($/case)
  lineTotal  = EXTENSION
  rate, rateUOM, totalQty, totalQtyUOM = null

FIELD MAPPING (per_weight):
  qtyOrdered, qtyShipped, qtyShippedUOM as above ("cs")
  packQty/packSize/packUOM as above (nominal)
  rate        = PRICE ($/lb or $/kg)
  rateUOM     = UOM from price label (lb or kg)
  totalQty    = WEIGHT column
  totalQtyUOM = same UOM as rateUOM
  unitPrice   = EXTENSION ÷ QTY.SHPD   (case cost as shipped)
  lineTotal   = EXTENSION

CATCHWEIGHT: Sysco rarely shows ordered-vs-shipped weight separately. Generally false.
Set true only if a nominal weight in description differs from WEIGHT column.

EXAMPLES:
  ITEM 7296313  ORD 1 / SHPD 1  B-UNIT 4  PACK "3 L"  PRICE 55.13  EXT 55.13
    → per_case, signal: default_case
       qtyShipped: 1, qtyShippedUOM: "cs", packQty: 4, packSize: 3, packUOM: "L"
       unitPrice: 55.13, lineTotal: 55.13

  ITEM 2697985  ORD 1 / SHPD 1  PACK "25 LB"  WEIGHT 26.4  PRICE 2.28  EXT 60.24
    (price column labeled $/LB)
    → per_weight, signal: price_uom_is_weight
       qtyShipped: 1, qtyShippedUOM: "cs", packQty: 1, packSize: 25, packUOM: "lb"
       rate: 2.28, rateUOM: "lb", totalQty: 26.4, totalQtyUOM: "lb"
       unitPrice: 60.24, lineTotal: 60.24

SKIP (no item number):
  • Category headers: "-- DAIRY PRODUCTS --", "-- CANNED AND DRY --", etc.
  • "Total NN.NN" subtotal rows
  • Final summary: P.S.T./T.V.P., ORDER TOTAL, CUBE, PIECES`,

  gordon: `
SUPPLIER IDENTIFIED: GFS / GORDON FOOD SERVICE
Columns: Item Code(7d) | Qty Ord | Qty Ship | Unit | Pack Size | Brand
       | Item Description | Ø | Cust Cat | Unit Price | (tax) | Extended Price

ANCHOR: Every product row starts with a 7-digit Item Code. Skip rows without one.

MODE DETECTION: mostly per_case (signal: default_case).
Gordon rarely sells by weight; treat as per_case unless the Unit Price column
clearly shows $/kg or $/lb (then per_weight, price_uom_is_weight).

FIELD MAPPING (per_case):
  qtyOrdered = Qty Ord,   qtyOrderedUOM = Unit column value (CS, EA)
  qtyShipped = Qty Ship,  qtyShippedUOM = Unit column value
  packQty, packSize, packUOM = parse Pack Size column
    "1x24 UN" → packQty:1, packSize:24, packUOM:"each"
    "2x5 KG"  → packQty:2, packSize:5,  packUOM:"kg"
    "1x4 L"   → packQty:1, packSize:4,  packUOM:"L"
  lineCategory = Cust Cat value (PR, DS, GR, etc.) — capture as the row's category code
  unitPrice   = Unit Price ($/case)
  lineTotal   = Extended Price

CATCHWEIGHT: Gordon does not show ordered-vs-shipped weight. Always false.

EXAMPLE:
  ITEM 1453800  Qty 1 CS  Pack "1x24 UN"  Brand Markon
  Desc "LETTUCE LEAF BUTTER PREM"  Cat PR  Unit $47.76  Ext $47.76
    → per_case, signal: default_case
       qtyShipped: 1, qtyShippedUOM: "cs", packQty: 1, packSize: 24, packUOM: "each"
       lineCategory: "PR", unitPrice: 47.76, lineTotal: 47.76

SKIP (no item code):
  • "Totals: N  Total [Category] Pieces XX.XX" — category subtotal rows
  • "Page Total: XX.XX"
  • End-of-invoice Category Summary / Category Recap table
  • Footer: Product Total, Misc, Sub total, PST/QST, GST/HST, Invoice Total
  • Non-product fees in Category Summary: "Fuel Charge", "Minimum Order Fee"
    → capture these into HEADER fields (fuelSurcharge, minimumOrderFee)`,

  'snow cap': `
SUPPLIER IDENTIFIED: SNOW CAP ENTERPRISES
Columns: BIN LOC. | ITEM NO. | QUAN. | DESCRIPTION | SIZE | UNIT PRICE | AMOUNT

ANCHOR: Every product row has a BIN LOC. code ("WF-22-1", "CB-10-1", etc.) AND an ITEM NO.

MODE DETECTION: ALWAYS per_case (signal: default_case).
Snow Cap never prices by weight.

FIELD MAPPING:
  qtyOrdered = QUAN., qtyOrderedUOM = "cs"  (use "ea" only when SIZE makes it obvious)
  qtyShipped = QUAN., qtyShippedUOM = same as qtyOrderedUOM
  packQty, packSize, packUOM = parse SIZE column:
    "9/3LB"  → packQty:9,  packSize:3,   packUOM:"lb"
    "4/4L"   → packQty:4,  packSize:4,   packUOM:"L"
    "20KG"   → packQty:1,  packSize:20,  packUOM:"kg"
    "2.5KG"  → packQty:1,  packSize:2.5, packUOM:"kg"
    "100PC"  → packQty:1,  packSize:100, packUOM:"each"
    "9L"     → packQty:1,  packSize:9,   packUOM:"L"
    "1KG"    → packQty:1,  packSize:1,   packUOM:"kg"
  unitPrice = UNIT PRICE ($/case)
  lineTotal = AMOUNT = QUAN × UNIT PRICE
  rate, rateUOM, totalQty, totalQtyUOM = null
  isCatchweight = false

INLINE TAX: Snow Cap sometimes prints "GST: 1.32  PST: 1.85" at the end of an
item row. These are taxes on that line — capture the larger one in
lineTaxAmount and put the code in taxFlag ("G" for GST, "P" for PST).
Do NOT subtract them from lineTotal.

EXAMPLE:
  BIN WF-22-1  ITEM S1095  QUAN 1  DESC "Salt Diamond Crystal Kosher"
  SIZE "9/3LB"  UNIT PRICE 111.87  AMOUNT 111.87
    → per_case, signal: default_case
       qtyShipped: 1, qtyShippedUOM: "cs", packQty: 9, packSize: 3, packUOM: "lb"
       unitPrice: 111.87, lineTotal: 111.87

SKIP:
  • Category headers in "** ... **": "** DRY **", "** COOLER **", "** FROZEN **",
    "** PRODUCE **"
  • LOT# lines beneath items (traceability, not a product)
  • Delivery instruction header text
  • Footer: subtotals, tax summary rows`,

  'legends haul': `
SUPPLIER IDENTIFIED: LEGENDS HAUL / ACECARD FOOD GROUP
(Acecard Food Group LTD is the legal entity that trades as Legends Haul — same supplier.)
Columns: PRODUCT ID | ORDERED | SHIPPED | unit(PC/PK/CS) | DESCRIPTION/SIZE/BRAND
       | TAX | WEIGHT | PRICE | per | AMOUNT

TWO-ROW ITEMS — CRITICAL: Each product occupies exactly TWO rows:
  Row 1: PRODUCT ID + all financial data
  Row 2: Brand name only ("BRITCO", "JBS/CARGIL", "WHITEVEAL", "GOLDENVALL")
  → Do NOT create a line item for Row 2. Merge brand into Row 1's description.

ANCHOR: Real product rows have a 5-digit PRODUCT ID. Brand rows have none.

MODE DETECTION: per column drives mode (signal: explicit_per_column)
  per = KG → per_weight
  per = CS → per_case

FIELD MAPPING (per_weight, per=KG):
  qtyOrdered  = ORDERED, qtyOrderedUOM = unit column (CS/PC/PK)
  qtyShipped  = SHIPPED, qtyShippedUOM = unit column
  packQty/packSize/packUOM from DESCRIPTION (nominal reference only)
  rate        = PRICE ($/kg)  ← PRIMARY price field
  rateUOM     = "kg"
  totalQty    = WEIGHT column (AUTHORITATIVE — actual delivered kg, NEVER derive
                from description arithmetic or from qtyShipped)
  totalQtyUOM = "kg"
  unitPrice   = AMOUNT ÷ SHIPPED  (per-container cost as shipped)
  lineTotal   = AMOUNT
  isCatchweight: true — all per_weight rows with qtyShippedUOM=CS/PC/PK are
                 catchweight (actual delivered weight varies per shipment)
  nominalWeight: packQty × packSize when both are known and differ from totalQty
                 by > 2% (e.g. "4x7kg" nominal 28kg vs 36.1 KG weight); else null

FIELD MAPPING (per_case, per=CS):
  qtyOrdered, qtyShipped, qtyShippedUOM from ORDERED/SHIPPED/unit columns
  packQty/packSize/packUOM from DESCRIPTION
  unitPrice = PRICE ($/case)
  lineTotal = AMOUNT
  rate, rateUOM, totalQty, totalQtyUOM = null
  isCatchweight = false
  (WEIGHT column may still show a kg value — informational only, ignore for pricing)

⚠ UNIT COLUMN IS NOT A MULTIPLIER: "4 PC" of "Beef Brisket 4x7kg" means 4 pieces
(qtyShipped: 4), NOT 16. Description's pack notation is nominal case format only.

⚠ DESCRIPTION SIZE IS NOMINAL: NEVER derive totalQty from description arithmetic.
WEIGHT column is always authoritative for per_weight rows.

EXAMPLES:
  PRODUCT 10126  SHIPPED 1 CS  "Pork Butt BL Fresh 6/cs / BRITCO"
  WEIGHT 29.500 KG  PRICE 9.90  per KG  AMOUNT 292.05
    → per_weight, signal: explicit_per_column
       qtyShipped: 1, qtyShippedUOM: "cs", packQty: 6, packSize: null, packUOM: null
       rate: 9.90, rateUOM: "kg", totalQty: 29.5, totalQtyUOM: "kg"
       unitPrice: 292.05, lineTotal: 292.05, isCatchweight: true, nominalWeight: null

  PRODUCT 13463  SHIPPED 6 CS  "Eggs Dark Yolk LW Loose 180/case / GOLDENVALL"
  WEIGHT 66.000 KG  PRICE 78.00  per CS  AMOUNT 468.00
    → per_case, signal: explicit_per_column
       qtyShipped: 6, qtyShippedUOM: "cs", packQty: null, packSize: 180, packUOM: "each"
       unitPrice: 78.00, lineTotal: 468.00

SKIP:
  • Brand-name rows (Row 2 of each item — no product ID)
  • Footer: Total Weight, Sub Total, Discount, Fuel Surcharge, Freight,
    GST, PST, Invoice Total, Total Pieces
  → capture footer fees/taxes into HEADER fields, not line items`,

  'intercity packers': `
SUPPLIER IDENTIFIED: INTERCITY PACKERS (meat & seafood)
Columns: PRODUCT | DESCRIPTION | PACK | QTY ORD | U/M | QTY SHIP | U/M | PRICE | AMOUNT | TAX

MULTI-ROW ITEMS — CRITICAL: Each product spans multiple rows:
  Row 1: PRODUCT code + first description line + financial data
  Rows 2+: Description continuation ONLY (fishing method, certifications,
    habitat, grade, weight class, brand). Merge into description; no
    financial data on these rows.

ANCHOR: Real product rows have an 8-digit PRODUCT code. Sub-description rows have none.

MODE DETECTION: ALWAYS per_weight (signal: explicit_per_column).
Intercity is meat/seafood — every line is priced by weight.

FIELD MAPPING:
  qtyOrdered  = QTY ORD value
  qtyOrderedUOM = U/M next to QTY ORD (lb or kg)
  qtyShipped  = QTY SHIP value
  qtyShippedUOM = U/M next to QTY SHIP (lb or kg)
  packQty, packSize, packUOM = parse PACK column
    "1/10 LB" → packQty:1, packSize:10, packUOM:"lb"
  rate        = PRICE ($/lb or $/kg)
  rateUOM     = same UOM as qtyShippedUOM
  totalQty    = QTY SHIP value (same as qtyShipped — qty IS the delivered weight)
  totalQtyUOM = qtyShippedUOM
  unitPrice   = AMOUNT ÷ QTY SHIP  (= rate, since qty is the weight)
  lineTotal   = AMOUNT = QTY SHIP × PRICE
  isCatchweight: true if qtyOrdered ≠ qtyShipped (catchweight scenario)
  nominalWeight: null (Intercity doesn't ship in nominal pack format)

EXAMPLES:
  PRODUCT 21402211  PACK "1/10 LB"  ORD 40 LB / SHIP 40 LB  PRICE 18.79  AMOUNT 751.60
    → per_weight, signal: explicit_per_column
       qtyOrdered: 40, qtyOrderedUOM: "lb", qtyShipped: 40, qtyShippedUOM: "lb"
       packQty: 1, packSize: 10, packUOM: "lb"
       rate: 18.79, rateUOM: "lb", totalQty: 40, totalQtyUOM: "lb"
       unitPrice: 18.79, lineTotal: 751.60, isCatchweight: false

  PRODUCT 11108103  PACK "1/10 lb ODD"  ORD 3.00 LB / SHIP 3.20 LB  PRICE 19.89  AMOUNT 63.65
    → per_weight, signal: explicit_per_column
       qtyOrdered: 3.00, qtyOrderedUOM: "lb", qtyShipped: 3.20, qtyShippedUOM: "lb"
       packQty: 1, packSize: 10, packUOM: "lb"
       rate: 19.89, rateUOM: "lb", totalQty: 3.20, totalQtyUOM: "lb"
       unitPrice: 19.89, lineTotal: 63.65, isCatchweight: true

SKIP:
  • All description continuation rows (no product code)
  • Boilerplate: "All raw product is to be cooked for consumption",
    "Please ensure payment...", INTEREST CHARGES, CLAIMS sections
  • Footer: TOTAL WEIGHT, TOTAL PIECES, TERMS, SUBTOTAL, FUEL SURCHARGE,
    FREIGHT, PST, HST/GST, INVOICE TOTAL
  → capture footer fees/taxes into HEADER fields, not line items`,
}

// Lookup supplier hints by normalizing the supplier name and checking substrings
function getSupplierHint(supplierName: string | null | undefined): string {
  if (!supplierName) return ''
  const n = supplierName.toLowerCase()
  if (n.includes('sysco'))                            return SUPPLIER_HINTS['sysco']
  if (n.includes('gordon') || n.includes('gfs'))      return SUPPLIER_HINTS['gordon']
  if (n.includes('snow cap'))                         return SUPPLIER_HINTS['snow cap']
  if (n.includes('legends') || n.includes('acecard')) return SUPPLIER_HINTS['legends haul']
  if (n.includes('intercity'))                        return SUPPLIER_HINTS['intercity packers']
  return ''
}

function buildSystemPrompt(supplierName?: string | null, learning = false): string {
  const hint = getSupplierHint(supplierName)
  const learningNote = learning
    ? '\n\n⚑ LEARNING MODE: This is one of the first invoices from this supplier. ' +
      'Before processing any rows, scan the full invoice and complete these steps:\n' +
      '  1. Read the column header row left-to-right and write out each column name.\n' +
      '  2. Identify the MODE signal: find the "per" or "U/M" column near the price; ' +
             'if absent, check whether the price column is labeled $/kg or $/lb.\n' +
      '  3. Identify the WEIGHT column (if present) — numeric kg/lb values between ' +
             'qty and price columns. This will be totalQty for per_weight rows.\n' +
      '  4. Confirm the ANCHOR column (product code) — every real product row has one; ' +
             'rows missing it are headers, subtotals, or brand-continuation lines.\n' +
      '  5. Note any multi-row item patterns (brand on row 2, certifications on row 3).\n' +
      'Then apply these column definitions consistently across every line item.'
    : ''
  if (!hint) return BASE_PROMPT + learningNote
  return BASE_PROMPT + learningNote + '\n\n' +
    '═══════════════════════════════════════════════════════\n' +
    'SUPPLIER-SPECIFIC RULES — these override general rules:\n' +
    '═══════════════════════════════════════════════════════' +
    hint
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type PricingMode = 'per_case' | 'per_weight' | 'unknown'
export type PricingModeSignal =
  | 'explicit_per_column'
  | 'price_uom_is_weight'
  | 'weight_column_present'
  | 'math_inference'
  | 'default_case'
  | 'indeterminate'

export interface OcrLineItem {
  // Identity
  description: string
  supplierItemCode: string | null
  lineCategory: string | null          // free-form: section header name OR column code (PR, DS, etc.)

  // Pricing classification (primary)
  pricingMode: PricingMode
  pricingModeSignal: PricingModeSignal

  // Quantities — UOM disambiguates case-count ("cs","pc","pk","ea") vs weight ("lb","kg","g","oz")
  qtyOrdered: number | null
  qtyOrderedUOM: string | null
  qtyShipped: number | null
  qtyShippedUOM: string | null

  // Nominal pack composition
  packQty: number | null
  packSize: number | null
  packUOM: string | null               // "L","ml","kg","g","lb","oz","each"

  // Pricing fields (per mode)
  // per_case: unitPrice = $/case; rate/totalQty null
  // per_weight: rate = $/uom; totalQty = actual delivered weight; unitPrice = lineTotal/qtyShipped
  unitPrice: number | null
  rate: number | null
  rateUOM: string | null
  totalQty: number | null
  totalQtyUOM: string | null

  // Catchweight
  isCatchweight: boolean               // never null — defaults to false
  nominalWeight: number | null

  // Universal
  lineTotal: number | null

  // Tax
  taxFlag: string | null
  lineTaxAmount: number | null

  // Bounding box — normalized coords (0–1 fractions of image dimensions)
  bbox: { page: number; x: number; y: number; w: number; h: number } | null

  // Confidence
  confidence: 'low' | 'medium' | 'high'
  confidenceNotes: string | null
}

export interface OcrResult {
  // Invoice identity
  supplierName: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  poNumber: string | null

  // Financial header
  subtotal: number | null
  discount: number | null
  fuelSurcharge: number | null
  freight: number | null
  minimumOrderFee: number | null
  gst: number | null
  hst: number | null
  pst: number | null
  otherCharges: Array<{ label: string; amount: number }>
  total: number | null

  // Lines
  lineItems: OcrLineItem[]
}

// ── JSON parsing & normalization ──────────────────────────────────────────────

function asNum(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

function asStr(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s.length ? s : null
}

function normalizeLineItem(raw: Record<string, unknown>): OcrLineItem {
  const description = asStr(raw.description) ?? ''
  const pricingMode = (raw.pricingMode === 'per_case' || raw.pricingMode === 'per_weight')
    ? raw.pricingMode as PricingMode
    : 'unknown'
  const sig = raw.pricingModeSignal
  const pricingModeSignal: PricingModeSignal =
    sig === 'explicit_per_column' || sig === 'price_uom_is_weight' ||
    sig === 'weight_column_present' || sig === 'math_inference' ||
    sig === 'default_case' ? sig as PricingModeSignal : 'indeterminate'
  const confRaw = raw.confidence
  const confidence: 'low' | 'medium' | 'high' =
    confRaw === 'high' ? 'high' : confRaw === 'medium' ? 'medium' : 'low'
  return {
    description,
    supplierItemCode: asStr(raw.supplierItemCode),
    lineCategory:     asStr(raw.lineCategory),
    pricingMode,
    pricingModeSignal,
    qtyOrdered:     asNum(raw.qtyOrdered),
    qtyOrderedUOM:  asStr(raw.qtyOrderedUOM),
    qtyShipped:     asNum(raw.qtyShipped),
    qtyShippedUOM:  asStr(raw.qtyShippedUOM),
    packQty:        asNum(raw.packQty),
    packSize:       asNum(raw.packSize),
    packUOM:        asStr(raw.packUOM),
    unitPrice:      asNum(raw.unitPrice),
    rate:           asNum(raw.rate),
    rateUOM:        asStr(raw.rateUOM),
    totalQty:       asNum(raw.totalQty),
    totalQtyUOM:    asStr(raw.totalQtyUOM),
    isCatchweight:  raw.isCatchweight === true,
    nominalWeight:  asNum(raw.nominalWeight),
    lineTotal:      asNum(raw.lineTotal),
    taxFlag:        asStr(raw.taxFlag),
    lineTaxAmount:  asNum(raw.lineTaxAmount),
    bbox: (() => {
      const b = raw.bbox as Record<string, unknown> | null | undefined
      if (!b || typeof b !== 'object') return null
      const page = typeof b.page === 'number' ? b.page : 0
      const x = typeof b.x === 'number' ? b.x : null
      const y = typeof b.y === 'number' ? b.y : null
      const w = typeof b.w === 'number' ? b.w : null
      const h = typeof b.h === 'number' ? b.h : null
      if (x === null || y === null || w === null || h === null) return null
      return {
        page,
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
        w: Math.max(0, Math.min(1, w)),
        h: Math.max(0, Math.min(1, h)),
      }
    })(),
    confidence,
    confidenceNotes: asStr(raw.confidenceNotes),
  }
}

function parseOcrResponse(rawText: string): OcrResult {
  const text = rawText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim()

  if (!text) {
    throw new Error('Claude returned an empty response — invoice may be unreadable or the image quality is too low')
  }

  const parsed = JSON.parse(text) as Record<string, unknown>
  const rawItems = Array.isArray(parsed.lineItems) ? parsed.lineItems as Record<string, unknown>[] : []
  const rawOther = Array.isArray(parsed.otherCharges) ? parsed.otherCharges as Record<string, unknown>[] : []

  return {
    supplierName:    asStr(parsed.supplierName),
    invoiceNumber:   asStr(parsed.invoiceNumber),
    invoiceDate:     asStr(parsed.invoiceDate),
    poNumber:        asStr(parsed.poNumber),
    subtotal:        asNum(parsed.subtotal),
    discount:        asNum(parsed.discount),
    fuelSurcharge:   asNum(parsed.fuelSurcharge),
    freight:         asNum(parsed.freight),
    minimumOrderFee: asNum(parsed.minimumOrderFee),
    gst:             asNum(parsed.gst),
    hst:             asNum(parsed.hst),
    pst:             asNum(parsed.pst),
    otherCharges:    rawOther
      .map(o => ({ label: asStr(o.label) ?? '', amount: asNum(o.amount) ?? 0 }))
      .filter(o => o.label.length > 0),
    total:           asNum(parsed.total),
    lineItems:       rawItems.map(normalizeLineItem),
  }
}

// ── JSON retry wrapper ────────────────────────────────────────────────────────
// Caps at one retry. The thunk is called with an optional `retrySuffix`; on
// retry the suffix is appended to the user message so Claude knows its
// previous output failed to parse.
function looksLikeTruncated(text: string): boolean {
  const t = text.trimEnd()
  // Truncated JSON ends without the closing braces / brackets of the root object
  if (!t.endsWith('}') && !t.endsWith(']')) return true
  // Also check if lineItems array is left unclosed (common truncation point)
  const opens  = (t.match(/\[/g)?.length ?? 0) + (t.match(/\{/g)?.length ?? 0)
  const closes = (t.match(/\]/g)?.length ?? 0) + (t.match(/\}/g)?.length ?? 0)
  return opens > closes
}

async function callWithJsonRetry(
  callApi: (retrySuffix?: string) => Promise<string>,
): Promise<OcrResult> {
  const first = await callApi()
  try {
    return parseOcrResponse(first)
  } catch (err) {
    const truncated = looksLikeTruncated(first.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim())
    console.warn(
      `[ocr] first response invalid JSON${truncated ? ' (appears truncated)' : ''}, retrying once:`,
      err instanceof Error ? err.message : err,
    )
    const suffix =
      '\n\nYour previous response was not valid JSON. Re-output the JSON object only — ' +
      'no prose, no markdown fences. Here was your previous output:\n\n' +
      first.slice(0, 4000)
    const second = await callApi(suffix)
    try {
      return parseOcrResponse(second)
    } catch (err2) {
      console.error('[ocr] retry also failed. First 500 chars:', second.slice(0, 500))
      const hint = truncated
        ? ' — the response was likely truncated (too many line items for the token budget)'
        : ''
      throw new Error(
        `Failed to parse OCR response as JSON${hint}: ${err2 instanceof Error ? err2.message : String(err2)}`
      )
    }
  }
}

// ── Multi-image (ALL pages in ONE API call — fastest approach for photo invoices) ──
export async function extractInvoiceFromImages(
  files: Array<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }>,
  supplierName?: string | null,
  learning = false
): Promise<OcrResult> {
  const apiKey = resolveAnthropicKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })
  const maxTokens      = learning ? LEARNING_MAX_TOKENS : NORMAL_MAX_TOKENS
  const thinkingBudget = learning ? LEARNING_THINKING   : NORMAL_THINKING

  const compressedImages = await Promise.all(
    files.map(async (f) => {
      const rawBytes = Buffer.byteLength(f.base64, 'base64')
      if (rawBytes > 4 * 1024 * 1024 || f.mediaType !== 'image/jpeg') {
        const compressed = await compressImageForClaude(f.base64, learning)
        console.log(`[ocr] Compressed${learning ? ' (learning)' : ''}: ${(rawBytes / 1024 / 1024).toFixed(1)}MB → ${(Buffer.byteLength(compressed.data, 'base64') / 1024 / 1024).toFixed(1)}MB`)
        return compressed
      }
      return { data: f.base64, mediaType: f.mediaType as 'image/jpeg' }
    })
  )

  const imageBlocks: Anthropic.ImageBlockParam[] = compressedImages.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }))

  const baseInstruction = files.length > 1
    ? `These are ${files.length} pages of the same invoice. Parse all pages together and return one combined JSON object.`
    : 'Parse this invoice and return JSON only.'

  return callWithJsonRetry(async (retrySuffix) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = await (client.messages.stream({
      model: OCR_MODEL,
      max_tokens: maxTokens,
      system: buildSystemPrompt(supplierName, learning),
      thinking: { type: 'enabled', budget_tokens: thinkingBudget },
      messages: [{
        role: 'user',
        content: [
          ...imageBlocks,
          { type: 'text', text: baseInstruction + (retrySuffix ?? '') },
        ],
      }],
    } as any) as any).finalMessage()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (message as any).content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text as string)
      .join('')
  })
}

// ── Single image (kept for backwards compat) ──
export async function extractInvoiceFromImage(
  base64Data: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
): Promise<OcrResult> {
  return extractInvoiceFromImages([{ base64: base64Data, mediaType }])
}

// ── PDF — send as document to Claude (handles multi-page natively) ──
export async function extractInvoiceFromPdf(
  pdfBuffer: Buffer,
  supplierName?: string | null,
  learning = false
): Promise<OcrResult> {
  const apiKey = resolveAnthropicKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })
  const base64 = pdfBuffer.toString('base64')
  const maxTokens      = learning ? LEARNING_MAX_TOKENS : NORMAL_MAX_TOKENS
  const thinkingBudget = learning ? LEARNING_THINKING   : NORMAL_THINKING

  return callWithJsonRetry(async (retrySuffix) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = await (client.messages.stream({
      model: OCR_MODEL,
      max_tokens: maxTokens,
      system: buildSystemPrompt(supplierName, learning),
      thinking: { type: 'enabled', budget_tokens: thinkingBudget },
      messages: [{
        role: 'user',
        content: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } } as any,
          { type: 'text', text: 'Parse this invoice and return JSON only.' + (retrySuffix ?? '') },
        ],
      }],
    } as any) as any).finalMessage()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (message as any).content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text as string)
      .join('')
  })
}

// ── Plain text (Claude-assisted) ──
export async function extractInvoiceFromText(
  text: string,
  supplierName?: string | null,
  learning = false
): Promise<OcrResult> {
  const apiKey = resolveAnthropicKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })
  const maxTokens      = learning ? LEARNING_MAX_TOKENS : NORMAL_MAX_TOKENS
  const thinkingBudget = learning ? LEARNING_THINKING   : NORMAL_THINKING

  return callWithJsonRetry(async (retrySuffix) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = await (client.messages.stream({
      model: OCR_MODEL,
      max_tokens: maxTokens,
      system: buildSystemPrompt(supplierName, learning),
      thinking: { type: 'enabled', budget_tokens: thinkingBudget },
      messages: [{
        role: 'user',
        content: `Parse this invoice text and return JSON only.\n\n${text}${retrySuffix ?? ''}`,
      }],
    } as any) as any).finalMessage()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (message as any).content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text as string)
      .join('')
  })
}

// ── Quick metadata peek ────────────────────────────────────────────────────────
// Reads only supplier name, date, and invoice number from the first page.
// Uses Haiku 4.5 (fast, cheap, no extended thinking) so the session list becomes
// identifiable within ~2 seconds while the full OCR is still running.

const QUICK_MODEL = 'claude-haiku-4-5-20251001'

export interface QuickMeta {
  supplierName:  string | null
  invoiceDate:   string | null
  invoiceNumber: string | null
}

export async function quickExtractMeta(
  buf:      Buffer,
  fileType: string,
  fileName: string,
): Promise<QuickMeta> {
  const apiKey = resolveAnthropicKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })
  const question =
    'Look at this invoice. Return ONLY valid JSON (no markdown, no explanation):\n' +
    '{"supplierName":"string or null","invoiceDate":"YYYY-MM-DD or null","invoiceNumber":"string or null"}'

  const ft = fileType.toLowerCase()
  let content: Anthropic.MessageParam['content']

  if (ft.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(fileName)) {
    const compressed = await compressImageForClaude(buf.toString('base64'), false)
    content = [
      { type: 'image', source: { type: 'base64', media_type: compressed.mediaType, data: compressed.data } },
      { type: 'text', text: question },
    ]
  } else if (ft === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } } as any,
      { type: 'text', text: question },
    ]
  } else {
    content = [{ type: 'text', text: `${buf.toString('utf-8').slice(0, 1500)}\n\n${question}` }]
  }

  const message = await client.messages.create({
    model:      QUICK_MODEL,
    max_tokens: 256,
    messages:   [{ role: 'user', content }],
  })

  const text = message.content
    .filter(b => b.type === 'text')
    .map(b => (b as Anthropic.TextBlock).text)
    .join('')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim()

  try {
    const j = JSON.parse(text) as Record<string, unknown>
    return {
      supplierName:  typeof j.supplierName  === 'string' ? j.supplierName  : null,
      invoiceDate:   typeof j.invoiceDate   === 'string' ? j.invoiceDate   : null,
      invoiceNumber: typeof j.invoiceNumber === 'string' ? j.invoiceNumber : null,
    }
  } catch {
    return { supplierName: null, invoiceDate: null, invoiceNumber: null }
  }
}

// ── CSV — local parse, no API call needed ──
// CSVs are mode-agnostic; we set pricingMode: 'unknown' and let the matcher
// treat it as per_case downstream (matcher only reads unitPrice/packQty/packSize
// which we populate normally).
export async function extractInvoiceFromCsv(csvText: string): Promise<OcrResult> {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) {
    return {
      supplierName: null, invoiceNumber: null, invoiceDate: null, poNumber: null,
      subtotal: null, discount: null, fuelSurcharge: null, freight: null,
      minimumOrderFee: null, gst: null, hst: null, pst: null,
      otherCharges: [], total: null, lineItems: [],
    }
  }

  const header = lines[0].toLowerCase().split(',').map(h => h.replace(/"/g, '').trim())
  const descIdx  = header.findIndex(h => h.includes('desc') || h.includes('item') || h.includes('product') || h.includes('name'))
  const qtyIdx   = header.findIndex(h => h.includes('qty') || h.includes('quant'))
  const unitIdx  = header.findIndex(h => h === 'unit' || h === 'uom')
  const priceIdx = header.findIndex(h => h.includes('price') || h.includes('cost'))
  const totalIdx = header.findIndex(h => h.includes('total') || h.includes('amount'))

  const lineItems: OcrLineItem[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.replace(/"/g, '').trim())
    const desc = descIdx >= 0 ? cols[descIdx] : cols[0]
    if (!desc) continue
    const qty       = qtyIdx   >= 0 ? parseFloat(cols[qtyIdx])   || null : null
    const unit      = unitIdx  >= 0 ? cols[unitIdx]  || null : null
    const unitPrice = priceIdx >= 0 ? parseFloat(cols[priceIdx]) || null : null
    const lineTotal = totalIdx >= 0 ? parseFloat(cols[totalIdx]) || null : null
    lineItems.push({
      description: desc,
      supplierItemCode: null,
      lineCategory: null,
      pricingMode: 'unknown',
      pricingModeSignal: 'indeterminate',
      qtyOrdered: qty,
      qtyOrderedUOM: unit,
      qtyShipped: qty,
      qtyShippedUOM: unit,
      packQty:  null,
      packSize: null,
      packUOM:  null,
      unitPrice,
      rate:     null,
      rateUOM:  null,
      totalQty: null,
      totalQtyUOM: null,
      isCatchweight: false,
      nominalWeight: null,
      lineTotal,
      taxFlag: null,
      lineTaxAmount: null,
      bbox: null,
      confidence: 'medium',
      confidenceNotes: null,
    })
  }

  return {
    supplierName: null, invoiceNumber: null, invoiceDate: null, poNumber: null,
    subtotal: null, discount: null, fuelSurcharge: null, freight: null,
    minimumOrderFee: null, gst: null, hst: null, pst: null,
    otherCharges: [], total: null, lineItems,
  }
}

```


---

## `src/lib/invoice/calculations.ts`

```ts
// Pure calculation functions for invoice line item math.
// All inputs are ScanItem fields (strings from API); parse with Number() before use.

import type { ScanItem } from '@/components/invoices/types'
import { comparePricesNormalized, toPricePerSIBase } from '@/lib/invoice-format'
import { derivePricingMode } from './predicates'

// ── Line math check ───────────────────────────────────────────────────────────
// Returns the computed vs. scanned line total so callers can show "check:" row.
export function computeLineMath(item: ScanItem): {
  computed: number
  entered: number
  matches: boolean
  delta: number
} | null {
  const mode = derivePricingMode(item)
  let computed: number

  if (mode === 'per_weight') {
    if (!item.rate || !item.totalQty) return null
    computed = Number(item.rate) * Number(item.totalQty)
  } else {
    if (!item.rawUnitPrice || !item.rawQty) return null
    const pq    = Number(item.invoicePackQty)  || 1
    const ps    = Number(item.invoicePackSize) || 1
    const pt    = item.rawPriceType ?? 'CASE'
    const price = Number(item.rawUnitPrice)
    const qty   = Number(item.rawQty)
    if (pt === 'PKG')      computed = qty * pq * price
    else if (pt === 'UOM') computed = qty * pq * ps * price
    else                   computed = qty * price
  }

  if (!item.rawLineTotal) return null
  const entered = Number(item.rawLineTotal)
  const delta   = computed - entered
  return { computed, entered, delta, matches: Math.abs(delta) <= 0.02 }
}

// ── Cost per UOM ──────────────────────────────────────────────────────────────
// Returns the normalised cost per base measurement unit (e.g. $/ml, $/g, $/ea).
export function computeCostPerUOM(item: ScanItem): { value: number; uom: string } | null {
  const mode = derivePricingMode(item)

  if (mode === 'per_weight') {
    if (!item.rate || !item.rateUOM) return null
    return { value: Number(item.rate), uom: item.rateUOM }
  }

  // per_case: price / (packQty × packSize) = $/packUOM
  if (!item.rawUnitPrice || !item.invoicePackQty || !item.invoicePackSize || !item.invoicePackUOM) return null
  const total = Number(item.invoicePackQty) * Number(item.invoicePackSize)
  if (total <= 0) return null
  return { value: Number(item.rawUnitPrice) / total, uom: item.invoicePackUOM }
}

// ── Variance vs. linked inventory item ───────────────────────────────────────
// Re-uses the existing comparePricesNormalized helper so the normalisation
// logic stays in one place.
export function computeVariance(item: ScanItem): {
  percent: number
  direction: 'up' | 'down'
} | null {
  if (!item.priceDiffPct) return null
  const pct = Number(item.priceDiffPct)
  if (Math.abs(pct) < 0.1) return null
  return { percent: Math.abs(pct), direction: pct > 0 ? 'up' : 'down' }
}

// ── Normalised price comparison (for "Inventory result" row) ─────────────────
// Uses pricePerBaseUnit (stored SI price, e.g. $/g or $/ml) from the matched
// inventory item — the canonical value written on every approve — so the
// comparison is accurate regardless of pack-format differences on either side.
export function computeNormalisedPrices(item: ScanItem): {
  pctDiff: number
  invoicePPB: number
  inventoryPPB: number
  baseUnit: string
} | null {
  const costPerUOM = computeCostPerUOM(item)
  if (!costPerUOM || !item.matchedItem) return null

  // Convert invoice per-unit cost to SI base (e.g. $/kg → $/g)
  const invoiceNorm = toPricePerSIBase(costPerUOM.value, costPerUOM.uom)
  if (!invoiceNorm) return null

  // Inventory's stored pricePerBaseUnit is already in SI base units
  const invPPB    = Number(item.matchedItem.pricePerBaseUnit)
  const baseUnit  = item.matchedItem.baseUnit  // e.g. "g", "ml", "each"

  if (!baseUnit || invPPB <= 0 || invoiceNorm.base !== baseUnit) return null

  return {
    pctDiff:      Math.round(((invoiceNorm.price - invPPB) / invPPB) * 10000) / 100,
    invoicePPB:   invoiceNorm.price,
    inventoryPPB: invPPB,
    baseUnit,
  }
}

// ── Invoice total reconciliation ──────────────────────────────────────────────
// Compares sum-of-lines against the OCR'd invoice subtotal.
// Returns a suggested fix when exactly one line can explain the gap (gap < $5,
// adjusting that line's total closes it within $0.01).
export function reconcileInvoiceTotals(
  items: ScanItem[],
  invoiceSubtotal: number | null,
): {
  sumOfLines: number
  invoiceSubtotal: number | null
  delta: number
  status: 'match' | 'mismatch' | 'unknown'
  suggestedFixItemId: string | null
  suggestedFixValue: number | null
} {
  const active    = items.filter(i => i.action !== 'SKIP')
  const sumOfLines = active.reduce((s, i) => s + (i.rawLineTotal ? Number(i.rawLineTotal) : 0), 0)

  if (invoiceSubtotal === null) {
    return { sumOfLines, invoiceSubtotal: null, delta: 0, status: 'unknown', suggestedFixItemId: null, suggestedFixValue: null }
  }

  const delta   = invoiceSubtotal - sumOfLines
  const matches = Math.abs(delta) < 0.02

  if (matches) {
    return { sumOfLines, invoiceSubtotal, delta: 0, status: 'match', suggestedFixItemId: null, suggestedFixValue: null }
  }

  // Look for exactly one line that could explain the gap via a digit-misread.
  // Conservative: only suggest when |gap| < $5 and the adjustment is < 10% of that line's total.
  let suggestedFixItemId: string | null = null
  let suggestedFixValue:  number | null = null

  if (Math.abs(delta) < 5) {
    const candidates = active.filter(i => {
      if (!i.rawLineTotal) return false
      const lt       = Number(i.rawLineTotal)
      const adjusted = lt + delta
      return adjusted > 0 && Math.abs(delta / lt) < 0.10
    })
    if (candidates.length === 1) {
      suggestedFixItemId = candidates[0].id
      suggestedFixValue  = Math.round((Number(candidates[0].rawLineTotal) + delta) * 100) / 100
    }
  }

  return { sumOfLines, invoiceSubtotal, delta, status: 'mismatch', suggestedFixItemId, suggestedFixValue }
}

```


---

## `src/lib/invoice/filters.ts`

```ts
// Filter and sort logic for the invoice line item list.

import type { ScanItem } from '@/components/invoices/types'
import {
  isCatchweight,
  hasModeMismatch,
  hasFormatMismatch,
  hasPriceChange,
  isUnlinked,
  hasMathCheck,
} from './predicates'

export type FilterKey =
  | 'priceDelta'
  | 'catchweight'
  | 'needsLink'
  | 'modeMismatch'
  | 'formatMismatch'
  | 'mathCheck'

export type SortMode = 'invoice' | 'priceDelta' | 'unlinked'

export function matchesFilter(item: ScanItem, filter: FilterKey): boolean {
  switch (filter) {
    case 'priceDelta':     return hasPriceChange(item)
    case 'catchweight':    return isCatchweight(item)
    case 'needsLink':      return isUnlinked(item)
    case 'modeMismatch':   return hasModeMismatch(item)
    case 'formatMismatch': return hasFormatMismatch(item)
    case 'mathCheck':      return hasMathCheck(item)
  }
}

export function sortComparator(mode: SortMode): (a: ScanItem, b: ScanItem) => number {
  switch (mode) {
    case 'invoice':
      return (a, b) => a.sortOrder - b.sortOrder
    case 'priceDelta':
      return (a, b) =>
        Math.abs(Number(b.priceDiffPct ?? 0)) - Math.abs(Number(a.priceDiffPct ?? 0))
    case 'unlinked':
      return (a, b) => {
        const aU = isUnlinked(a) ? 0 : 1
        const bU = isUnlinked(b) ? 0 : 1
        return aU - bU || a.sortOrder - b.sortOrder
      }
  }
}

// Returns counts for each filter key — drives chip badge numbers.
export function getFilterCounts(items: ScanItem[]): Record<FilterKey, number> {
  return {
    priceDelta:    items.filter(i => matchesFilter(i, 'priceDelta')).length,
    catchweight:   items.filter(i => matchesFilter(i, 'catchweight')).length,
    needsLink:     items.filter(i => matchesFilter(i, 'needsLink')).length,
    modeMismatch:  items.filter(i => matchesFilter(i, 'modeMismatch')).length,
    formatMismatch: items.filter(i => matchesFilter(i, 'formatMismatch')).length,
    mathCheck:     items.filter(i => matchesFilter(i, 'mathCheck')).length,
  }
}

// Returns the subset of filters that have at least one matching item,
// sorted by severity (danger first, then warn, then info).
export function getActiveFilters(items: ScanItem[]): FilterKey[] {
  const counts = getFilterCounts(items)
  const order: FilterKey[] = ['needsLink', 'mathCheck', 'formatMismatch', 'modeMismatch', 'priceDelta', 'catchweight']
  return order.filter(k => counts[k] > 0)
}

// Human-readable label for each filter chip.
export const FILTER_LABELS: Record<FilterKey, string> = {
  needsLink:     'Needs link',
  mathCheck:     'Math check',
  formatMismatch:'Format mismatch',
  modeMismatch:  'Mode mismatch',
  priceDelta:    'Price changed',
  catchweight:   'Catchweight',
}

```


---

## `src/lib/invoice/formatters.ts`

```ts
// Display formatters for invoice line items.
// All return plain strings — no JSX.

import type { ScanItem } from '@/components/invoices/types'
import { formatCurrency as baseFmt } from '@/lib/utils'
import { derivePricingMode, isWeightVolUOM } from './predicates'

// Re-export the existing currency formatter so callers import from one place.
export { formatCurrency } from '@/lib/utils'

// ── Quantity with unit ────────────────────────────────────────────────────────
export function formatQuantity(value: number, uom: string): string {
  const n = value === Math.floor(value) ? String(value) : value.toFixed(2)
  return `${n} ${uom}`
}

// ── Pack summary (subtitle line) ──────────────────────────────────────────────
// Examples:
//   per_case:   "4 × 3L per cs"  |  "1 cs · 8 ea per cs"
//   per_weight: "4 cs · 10 lb nominal"  |  "1 cs · 3 lb nominal · 3.20 lb received"
export function formatPackSummary(item: ScanItem): string {
  const mode  = derivePricingMode(item)
  const qty   = item.rawQty           ? Number(item.rawQty)           : null
  const pq    = item.invoicePackQty   ? Number(item.invoicePackQty)   : null
  const ps    = item.invoicePackSize  ? Number(item.invoicePackSize)  : null
  const pUOM  = item.invoicePackUOM   ?? null

  if (mode === 'per_weight') {
    const rateUOM    = item.rateUOM ?? item.qtyOrderedUOM ?? 'lb'
    const nominal    = item.nominalWeight ? Number(item.nominalWeight) : (pq && ps ? pq * ps : null)
    const measured   = item.qtyOrdered   ? Number(item.qtyOrdered)   : (item.totalQty ? Number(item.totalQty) : null)
    const parts: string[] = []
    if (qty)     parts.push(`${qty} cs`)
    if (nominal) parts.push(`${nominal} ${rateUOM} nominal`)
    if (measured && item.isCatchweight) parts.push(`${measured.toFixed(2)} ${rateUOM} received`)
    return parts.join(' · ') || '—'
  }

  // per_case
  const parts: string[] = []
  if (pq && ps && pUOM) parts.push(`${pq} × ${ps}${pUOM} per cs`)
  else if (pq && pUOM)  parts.push(`${pq} ${pUOM}/cs`)
  return parts.join(' · ') || '—'
}

// ── Rate label (below line total in collapsed row) ────────────────────────────
// Returns null when the rate would be redundant:
//   - per_case + qty === 1  → total already says it all
//   - per_weight with no rate data
// Examples:
//   "$18.79/lb · 40 lb"   (per_weight)
//   "$55.13/cs · 4 cs"    (per_case, qty > 1)
export function formatRateLabel(item: ScanItem): string | null {
  const mode = derivePricingMode(item)

  if (mode === 'per_weight') {
    if (!item.rate || !item.rateUOM) return null
    const qty    = item.qtyOrdered ?? item.totalQty
    const qtyUOM = item.qtyOrderedUOM ?? item.rateUOM
    const rate   = `${baseFmt(Number(item.rate))}/${item.rateUOM}`
    return qty ? `${rate} · ${Number(qty).toFixed(2)} ${qtyUOM}` : rate
  }

  // per_case: suppress when qty === 1 (rate = total, redundant)
  if (!item.rawQty || Number(item.rawQty) === 1) return null
  if (!item.rawUnitPrice) return null
  return `${baseFmt(Number(item.rawUnitPrice))}/cs · ${Number(item.rawQty)} cs`
}

// ── Check-row formula string ──────────────────────────────────────────────────
// "40 × $18.79 = $751.60"
export function formatCheckFormula(item: ScanItem): string | null {
  const mode = derivePricingMode(item)
  if (mode === 'per_weight') {
    if (!item.rate || !item.qtyOrdered) return null
    const total = Number(item.rate) * Number(item.qtyOrdered)
    return `${Number(item.qtyOrdered).toFixed(2)} × ${baseFmt(Number(item.rate))} = ${baseFmt(total)}`
  }
  if (!item.rawQty || !item.rawUnitPrice) return null
  const qty   = Number(item.rawQty)
  const price = Number(item.rawUnitPrice)
  const total = qty * price
  return `${qty} × ${baseFmt(price)} = ${baseFmt(total)}`
}

// ── Case structure label ──────────────────────────────────────────────────────
// "total per case: 12 L · cost per ml: $0.0046"
export function formatCaseSummary(item: ScanItem): string | null {
  const pq   = item.invoicePackQty  ? Number(item.invoicePackQty)  : null
  const ps   = item.invoicePackSize ? Number(item.invoicePackSize) : null
  const pUOM = item.invoicePackUOM  ?? null
  const price = item.rawUnitPrice   ? Number(item.rawUnitPrice)    : null
  if (!pq || !ps || !pUOM) return null
  const totalPerCase = pq * ps
  const parts = [`total per case: ${totalPerCase} ${pUOM}`]
  if (price && totalPerCase > 0 && !isWeightVolUOM(pUOM) === false) {
    // only show cost/unit for weight or volume UOMs where it's meaningful
  }
  if (price && totalPerCase > 0) {
    const costPerUnit = price / totalPerCase
    parts.push(`cost per ${pUOM}: ${baseFmt(costPerUnit)}`)
  }
  return parts.join(' · ')
}

```


---

## `src/lib/invoice/predicates.ts`

```ts
// Pure predicates for invoice line item state — no React imports.
// These are the single source of truth for card accent colours, filter chips,
// and footer task counts.

import type { ScanItem } from '@/components/invoices/types'

const WEIGHT_VOL = new Set(['kg', 'g', 'lb', 'oz', 'l', 'ml'])
export const isWeightVolUOM = (uom: string | null | undefined) =>
  !!uom && WEIGHT_VOL.has(uom.toLowerCase())

// ── Pricing mode ─────────────────────────────────────────────────────────────
// Priority:
//   1. line.pricingMode if explicitly set by OCR
//   2. line.rate + line.qtyOrdered present → per_weight
//   3. packUOM is a weight/vol unit → per_weight
//   4. fallback: per_case
export function derivePricingMode(item: ScanItem): 'per_case' | 'per_weight' {
  if (item.pricingMode === 'per_weight') return 'per_weight'
  if (item.pricingMode === 'per_case')   return 'per_case'
  if (item.rate && item.qtyOrdered)      return 'per_weight'
  if (isWeightVolUOM(item.invoicePackUOM)) return 'per_weight'
  return 'per_case'
}

// ── Catchweight ───────────────────────────────────────────────────────────────
// True when the item was priced by weight AND the actual received weight
// differs from the nominal pack weight (i.e. qtyOrdered ≠ nominalWeight).
export function isCatchweight(item: ScanItem): boolean {
  if (item.isCatchweight) return true
  if (derivePricingMode(item) !== 'per_weight') return false
  const actual  = item.qtyOrdered   ? Number(item.qtyOrdered)   : null
  const nominal = item.nominalWeight ? Number(item.nominalWeight) : null
  if (actual === null || nominal === null) return false
  return Math.abs(actual - nominal) > 0.01
}

// ── Format mismatch ───────────────────────────────────────────────────────────
// Kept as a distinct state from mode mismatch (per-brief decision).
export function hasFormatMismatch(item: ScanItem): boolean {
  return item.formatMismatch === true
}

// ── Mode mismatch ─────────────────────────────────────────────────────────────
// True when the line is linked AND the detected pricing mode disagrees with
// the linked inventory item's expected mode.
// InventoryItem.priceType: 'UOM' → per_weight, 'CASE'/'PKG' → per_case.
export function hasModeMismatch(item: ScanItem): boolean {
  if (!item.matchedItem) return false
  const detected      = derivePricingMode(item)
  const inventoryMode = item.matchedItem.priceType === 'UOM' ? 'per_weight' : 'per_case'
  return detected !== inventoryMode
}

// ── Price change ──────────────────────────────────────────────────────────────
export function hasPriceChange(item: ScanItem, thresholdPct = 3): boolean {
  if (!item.priceDiffPct) return false
  return Math.abs(Number(item.priceDiffPct)) > thresholdPct
}

// ── Unlinked ──────────────────────────────────────────────────────────────────
export function isUnlinked(item: ScanItem): boolean {
  return (
    !item.matchedItemId &&
    item.action !== 'CREATE_NEW' &&
    item.action !== 'SKIP'
  )
}

// ── Math check ────────────────────────────────────────────────────────────────
// True when the computed qty × price does not match the scanned line total
// within a $0.02 tolerance.
export function hasMathCheck(item: ScanItem): boolean {
  if (item.action === 'SKIP') return false
  const mode = derivePricingMode(item)

  let computed: number
  if (mode === 'per_weight') {
    // Use totalQty (actual delivered weight), not qtyOrdered (cases ordered).
    // These differ for catchweight items: rate × totalQty = lineTotal, not rate × qtyOrdered.
    if (!item.rate || !item.totalQty) return false
    computed = Number(item.rate) * Number(item.totalQty)
  } else {
    if (!item.rawUnitPrice || !item.rawQty) return false
    const pq = Number(item.invoicePackQty) || 1
    const ps = Number(item.invoicePackSize) || 1
    const pt = item.rawPriceType ?? 'CASE'
    const price = Number(item.rawUnitPrice)
    const qty   = Number(item.rawQty)
    if (pt === 'PKG')      computed = qty * pq * price
    else if (pt === 'UOM') computed = qty * pq * ps * price
    else                   computed = qty * price  // CASE
  }

  if (!item.rawLineTotal) return false
  return Math.abs(computed - Number(item.rawLineTotal)) > 0.02
}

// ── Accent colour ─────────────────────────────────────────────────────────────
// Single source of truth for card left-border accent and chip colour.
export type Accent = 'danger' | 'warn' | 'info' | 'success' | null

export function pickAccent(item: ScanItem): Accent {
  if (item.action === 'SKIP') return null
  if (isUnlinked(item))       return 'danger'
  if (hasFormatMismatch(item) || hasModeMismatch(item) || hasMathCheck(item)) return 'warn'
  if (hasPriceChange(item, 15)) return 'warn'
  if (hasPriceChange(item, 3))  return 'info'
  if (item.matchedItemId)       return 'success'
  return null
}

```


---

## `src/lib/invoice/resolution.ts`

```ts
// Issue-resolution model for the redesigned invoice drawer.
// The mock groups every problem on a line into `.issue` blocks, each ending in a
// decision. The progress bar ("X of N resolved"), the per-issue rendering, and
// the Approve-gate all read from these helpers so they never disagree.

import type { ScanItem } from '@/components/invoices/types'
import {
  isUnlinked, hasModeMismatch, hasFormatMismatch, hasMathCheck, hasPriceChange,
} from './predicates'
import type { IssueKind } from '@/components/invoices/v2/atoms'

// A line is treated as a "charge" (Other line items — no COGS impact) when the
// user has skipped it. Skipped lines never need a decision.
export function isCharge(item: ScanItem): boolean {
  return item.action === 'SKIP'
}

export interface ResolveOpts {
  /** line ids the user chose to write the detected mode back to the product */
  modeWriteback: boolean
  /** line ids where the user accepted/acknowledged the price change */
  priceAck: boolean
}

// Big price jumps (>15%) on a linked item are the only price deltas promoted to
// a decision-required `.issue` — smaller drifts surface only as a variance pill.
export function isBigPriceChange(item: ScanItem): boolean {
  return !!item.matchedItem && hasPriceChange(item, 15)
}

// Which issue badges a line currently shows, and whether each is resolved.
export function lineIssues(item: ScanItem, opts: ResolveOpts): Array<{ kind: IssueKind; resolved: boolean }> {
  if (isCharge(item)) return []
  const out: Array<{ kind: IssueKind; resolved: boolean }> = []

  // New SKU / needs link — only resolvable by linking, creating, or skipping
  // (all of which make isUnlinked() false), so while present it is unresolved.
  if (isUnlinked(item)) out.push({ kind: 'sku', resolved: false })

  // Mode mismatch — resolved by writing the mode back to the product. The
  // "treat as per-case once" path flips the line's pricingMode, which clears
  // hasModeMismatch() entirely, so it drops out of this list when chosen.
  if (hasModeMismatch(item)) out.push({ kind: 'mode', resolved: opts.modeWriteback })

  // Format mismatch — resolved by editing pack structure (clears the flag).
  if (hasFormatMismatch(item) && !hasModeMismatch(item)) out.push({ kind: 'mode', resolved: false })

  // Big price change — resolved once acknowledged.
  if (isBigPriceChange(item)) out.push({ kind: 'price', resolved: opts.priceAck })

  return out
}

// True when a line still has at least one issue awaiting a decision.
export function lineUnresolved(item: ScanItem, opts: ResolveOpts): boolean {
  // A math check is a hard blocker even though it has no badge of its own.
  if (!isCharge(item) && hasMathCheck(item)) return true
  return lineIssues(item, opts).some(i => !i.resolved)
}

```


---

## `src/lib/supplier-matcher.ts`

```ts
// src/lib/supplier-matcher.ts
// Supplier alias lookup: exact match first, fuzzy fallback, self-learning.

import { prisma } from '@/lib/prisma'

// ── Fuzzy helpers ──────────────────────────────────────────────────────────────

// Minimum fraction of the shorter name's tokens that must appear in the longer.
const FUZZY_THRESHOLD = 0.5

const BUSINESS_SUFFIXES =
  /\b(pty|ltd|limited|inc|incorporated|corp|corporation|co|llc|plc|group|trading|foods?|supply|supplies|wholesale|distribution|distributors?)\b/g

/**
 * Normalise a supplier name into a set of meaningful lowercase tokens.
 * Strips business suffixes, punctuation, and single-character noise.
 */
function tokenise(name: string): string[] {
  return name
    .toLowerCase()
    .replace(BUSINESS_SUFFIXES, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')   // punctuation → space
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t.length >= 2)      // drop single-char abbreviation artifacts
}

/**
 * Token-coverage score: what fraction of the *shorter* token set is found
 * in the *longer* token set? Range [0, 1].
 *
 * Examples:
 *   "Metro C&C"  vs "Metro Cash & Carry" → tokens ["metro"] ⊂ ["metro","cash","carry"] → 1.0
 *   "SYSCO"      vs "Sysco Foods Inc"    → tokens ["sysco"] ⊂ ["sysco"]                → 1.0
 *   "Fresh Direct" vs "Fresh Direct Ltd" → ["fresh","direct"] ⊂ ["fresh","direct"]     → 1.0
 *   "Premium Meats" vs "Quality Produce" → 0 overlap                                   → 0.0
 */
function coverageScore(a: string, b: string): number {
  const ta = tokenise(a)
  const tb = tokenise(b)
  if (ta.length === 0 || tb.length === 0) return 0

  const [shorter, longer] =
    ta.length <= tb.length ? [ta, tb] : [tb, ta]
  const longerSet = new Set(longer)
  const matched = shorter.filter(t => longerSet.has(t)).length
  return matched / shorter.length
}

/**
 * Look up a supplier by an OCR-extracted invoice name.
 *
 * Order of preference:
 *   1. Exact alias match        (case-insensitive)
 *   2. Exact supplier name      (case-insensitive)
 *   3. Fuzzy alias match        (token coverage ≥ 50 %)
 *   4. Fuzzy supplier name      (token coverage ≥ 50 %)
 *
 * When a fuzzy match is found the OCR name is saved as a new alias so the
 * next scan of the same invoice format gets a fast exact hit.
 */
export async function matchSupplierByName(invoiceName: string | null | undefined): Promise<string | null> {
  if (!invoiceName || !invoiceName.trim()) return null

  const normalized = invoiceName.trim()

  // 1. Exact alias match
  const alias = await prisma.supplierAlias.findFirst({
    where: { name: { equals: normalized, mode: 'insensitive' } },
    select: { supplierId: true },
  })
  if (alias) return alias.supplierId

  // 2. Exact supplier name match
  const supplier = await prisma.supplier.findFirst({
    where: { name: { equals: normalized, mode: 'insensitive' } },
    select: { id: true },
  })
  if (supplier) return supplier.id

  // 3. Fuzzy alias match — load all aliases (small table, fine in-memory)
  const allAliases = await prisma.supplierAlias.findMany({
    select: { supplierId: true, name: true },
  })
  let bestId: string | null = null
  let bestScore = 0

  for (const a of allAliases) {
    const score = coverageScore(normalized, a.name)
    if (score >= FUZZY_THRESHOLD && score > bestScore) {
      bestScore = score
      bestId = a.supplierId
    }
  }
  if (bestId) {
    // Auto-learn so future exact lookups skip this work
    await learnAlias(bestId, normalized).catch(() => {})
    console.log(`[supplier-matcher] Fuzzy alias match: "${normalized}" → supplierId ${bestId} (score ${bestScore.toFixed(2)})`)
    return bestId
  }

  // 4. Fuzzy supplier name match
  const allSuppliers = await prisma.supplier.findMany({
    select: { id: true, name: true },
  })
  bestScore = 0

  for (const s of allSuppliers) {
    const score = coverageScore(normalized, s.name)
    if (score >= FUZZY_THRESHOLD && score > bestScore) {
      bestScore = score
      bestId = s.id
    }
  }
  if (bestId) {
    await learnAlias(bestId, normalized).catch(() => {})
    console.log(`[supplier-matcher] Fuzzy name match: "${normalized}" → supplierId ${bestId} (score ${bestScore.toFixed(2)})`)
    return bestId
  }

  return null
}

/**
 * Upsert (supplierId, invoiceName) into SupplierAlias.
 * No-op on blank/null name. Duplicate rows are silently ignored.
 */
export async function learnAlias(supplierId: string, invoiceName: string | null | undefined): Promise<void> {
  if (!supplierId || !supplierId.trim()) return
  if (!invoiceName || !invoiceName.trim()) return

  const normalized = invoiceName.trim()

  await prisma.supplierAlias.upsert({
    where: { supplierId_name: { supplierId, name: normalized } },
    create: { supplierId, name: normalized },
    update: {}, // already exists, no-op
  })
}

```


---

## `src/lib/signals/rules.ts`

```ts
/**
 * Signals engine — 5 starter rules.
 *
 * Each rule produces zero or more `SignalCandidate` records. The /api/signals/refresh
 * endpoint runs all rules, upserts results into the Signal table (keyed by
 * fingerprint so re-running doesn't create duplicates), and prunes rows whose
 * underlying condition has resolved.
 *
 * Each signal ends with a verb (Principle 06). The verbHref points at the
 * page or modal where the action lives.
 */

import { prisma } from '@/lib/prisma'
import { fetchRecipeWithCost } from '@/lib/recipeCosts'

export interface SignalCandidate {
  fingerprint: string
  rule: string
  severity: 'critical' | 'warn' | 'info'
  title: string
  body: string
  verbLabel: string
  verbHref: string
  impactValue?: number
  itemId?: string | null
  recipeId?: string | null
}

// ── Rule 1: Price ↑ > 10% on item used in N recipes ────────────────────────
async function ruleIngredientPriceSpike(): Promise<SignalCandidate[]> {
  const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const alerts = await prisma.priceAlert.findMany({
    where: { acknowledged: false, createdAt: { gte: sevenDaysAgo } },
    include: {
      inventoryItem: {
        select: {
          id: true, itemName: true,
          recipeIngredients: { select: { recipeId: true } },
        },
      },
    },
  })

  const out: SignalCandidate[] = []
  for (const a of alerts) {
    const pct = Number(a.changePct)
    if (pct < 10) continue
    const recipeCount = new Set(a.inventoryItem.recipeIngredients.map(r => r.recipeId)).size
    if (recipeCount === 0) continue
    const impact = (Number(a.newPrice) - Number(a.previousPrice)) * recipeCount
    out.push({
      fingerprint: `price-spike:${a.inventoryItem.id}:${a.id}`,
      rule: 'PRICE_SPIKE',
      severity: pct > 25 ? 'critical' : 'warn',
      title: `${a.inventoryItem.itemName} up +${pct.toFixed(0)}%`,
      body: `Affects ${recipeCount} ${recipeCount === 1 ? 'recipe' : 'recipes'} — review prices or switch suppliers.`,
      verbLabel: 'Review',
      verbHref: '/invoices/price-alerts',
      impactValue: impact,
      itemId: a.inventoryItem.id,
    })
  }
  return out
}

// ── Rule 2: Recipe drift > target by > 3pp ─────────────────────────────────
async function ruleRecipeDrift(): Promise<SignalCandidate[]> {
  const defaultRc = await prisma.revenueCenter.findFirst({ where: { isDefault: true }, select: { targetFoodCostPct: true } })
  const targetPct = defaultRc?.targetFoodCostPct ? Number(defaultRc.targetFoodCostPct) : 27

  // Recipes with explicit menu prices (MENU type) where we can compute food-cost
  const recipes = await prisma.recipe.findMany({
    where: { type: 'MENU', isActive: true, menuPrice: { not: null } },
    select: { id: true, name: true, menuPrice: true },
    take: 60,
  })

  const out: SignalCandidate[] = []
  for (const r of recipes) {
    if (r.menuPrice === null) continue
    const detail = await fetchRecipeWithCost(r.id).catch(() => null)
    if (!detail || !detail.totalCost) continue
    const fcPct = (detail.totalCost / Number(r.menuPrice)) * 100
    if (fcPct - targetPct < 3) continue
    out.push({
      fingerprint: `recipe-drift:${r.id}`,
      rule: 'RECIPE_DRIFT',
      severity: fcPct - targetPct > 6 ? 'critical' : 'warn',
      title: `${r.name} drifted to ${fcPct.toFixed(1)}% food cost`,
      body: `Target is ${targetPct.toFixed(1)}%. Bump menu price or trim costly ingredients.`,
      verbLabel: 'Open recipe',
      verbHref: `/menu?highlight=${r.id}`,
      impactValue: (fcPct - targetPct) * Number(r.menuPrice) / 100,
      recipeId: r.id,
    })
  }
  return out
}

// ── Rule 3: Count overdue > 4d ─────────────────────────────────────────────
async function ruleCountOverdue(): Promise<SignalCandidate[]> {
  const latest = await prisma.countSession.findFirst({
    where: { status: 'FINALIZED', finalizedAt: { not: null } },
    orderBy: { finalizedAt: 'desc' },
    select: { finalizedAt: true, sessionDate: true },
  })
  if (!latest?.finalizedAt) return []
  const days = Math.floor((Date.now() - latest.finalizedAt.getTime()) / 86_400_000)
  if (days <= 4) return []
  return [{
    fingerprint: 'count-overdue:global',
    rule: 'COUNT_OVERDUE',
    severity: days > 7 ? 'critical' : 'warn',
    title: `Stock count overdue — ${days} days`,
    body: `Theoretical-vs-actual drift widens with every day uncounted. Schedule a partial.`,
    verbLabel: 'Schedule count',
    verbHref: '/count',
    impactValue: days * 20, // rough drift estimate per day
  }]
}

// ── Rule 4: Wastage reason spike ───────────────────────────────────────────
async function ruleWastageSpike(): Promise<SignalCandidate[]> {
  const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const fourteenDaysAgo = new Date(); fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14)

  const [thisWeek, lastWeek] = await Promise.all([
    prisma.wastageLog.groupBy({
      by: ['reason'],
      where: { date: { gte: sevenDaysAgo } },
      _sum: { costImpact: true },
    }),
    prisma.wastageLog.groupBy({
      by: ['reason'],
      where: { date: { gte: fourteenDaysAgo, lt: sevenDaysAgo } },
      _sum: { costImpact: true },
    }),
  ])

  const prevMap = new Map(lastWeek.map(r => [r.reason, Number(r._sum.costImpact ?? 0)]))
  const out: SignalCandidate[] = []
  for (const r of thisWeek) {
    const cur = Number(r._sum.costImpact ?? 0)
    const prev = prevMap.get(r.reason) ?? 0
    if (cur < 50 || cur <= prev * 1.5) continue
    out.push({
      fingerprint: `waste-spike:${r.reason}`,
      rule: 'WASTAGE_SPIKE',
      severity: cur > 200 ? 'critical' : 'warn',
      title: `Wastage spike: ${r.reason}`,
      body: `$${cur.toFixed(0)} this week vs $${prev.toFixed(0)} last week. Investigate before it compounds.`,
      verbLabel: 'Open log',
      verbHref: `/wastage?reason=${encodeURIComponent(r.reason)}`,
      impactValue: cur - prev,
    })
  }
  return out
}

// ── Rule 5: High-margin menu items not on a recent specials board ──────────
// Heuristic substitute for true menu engineering (no item-level sales).
// Surfaces top 3 highest-margin menu items as "promote" candidates.
async function ruleMenuPuzzle(): Promise<SignalCandidate[]> {
  const menuItems = await prisma.recipe.findMany({
    where: { type: 'MENU', isActive: true, menuPrice: { not: null } },
    select: { id: true, name: true, menuPrice: true },
    take: 40,
  })

  const enriched: Array<{ id: string; name: string; menuPrice: number; margin: number; pct: number }> = []
  for (const r of menuItems) {
    if (r.menuPrice === null) continue
    const detail = await fetchRecipeWithCost(r.id).catch(() => null)
    if (!detail || !detail.totalCost) continue
    const margin = Number(r.menuPrice) - detail.totalCost
    const pct = (margin / Number(r.menuPrice)) * 100
    if (margin > 0) enriched.push({ id: r.id, name: r.name, menuPrice: Number(r.menuPrice), margin, pct })
  }
  enriched.sort((a, b) => b.margin - a.margin)

  return enriched.slice(0, 3).map(r => ({
    fingerprint: `puzzle:${r.id}`,
    rule: 'MENU_PUZZLE',
    severity: 'info' as const,
    title: `Promote ${r.name}? Margin ${r.pct.toFixed(0)}%`,
    body: `Highest-margin dish on your menu — $${r.margin.toFixed(2)}/cover. Featuring it lifts blended food cost.`,
    verbLabel: 'Open dish',
    verbHref: `/menu?highlight=${r.id}`,
    impactValue: r.margin * 10,
    recipeId: r.id,
  }))
}

// ── Runner ─────────────────────────────────────────────────────────────────
export async function evaluateAllRules(): Promise<SignalCandidate[]> {
  const results = await Promise.allSettled([
    ruleIngredientPriceSpike(),
    ruleRecipeDrift(),
    ruleCountOverdue(),
    ruleWastageSpike(),
    ruleMenuPuzzle(),
  ])
  return results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
}

```


---

## `src/lib/auth.ts`

```ts
import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { prisma } from '@/lib/prisma'
import { Role, User } from '@prisma/client'

export class AuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

// Role strength: ADMIN > MANAGER > STAFF
const ROLE_RANK: Record<Role, number> = {
  STAFF: 0,
  MANAGER: 1,
  ADMIN: 2,
}

/**
 * Verifies the current request has a valid Supabase session and returns
 * the corresponding Prisma User.
 *
 * Throws AuthError(401) if no session.
 * Throws AuthError(403) if user is inactive or below minRole.
 *
 * Usage in a Route Handler:
 *   import { requireSession, AuthError } from '@/lib/auth'
 *
 *   export async function POST(req: NextRequest) {
 *     let user: User
 *     try { user = await requireSession('MANAGER') }
 *     catch (e) {
 *       if (e instanceof AuthError)
 *         return NextResponse.json({ error: e.message }, { status: e.status })
 *       throw e
 *     }
 *     // ... handler logic
 *   }
 */
export async function requireSession(minRole?: Role): Promise<User> {
  const supabase = createClient()

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()

  if (!authUser) {
    throw new AuthError(401, 'Unauthorized')
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.id } })

  if (!user || !user.isActive) {
    throw new AuthError(403, 'Account is inactive or not found')
  }

  if (minRole !== undefined && ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
    throw new AuthError(403, 'Insufficient permissions')
  }

  return user
}

```


---

## `src/lib/prisma.ts`

```ts
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error'] : [],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

```


---

## `src/lib/capacitor.ts`

```ts
// SSR safety: isNative() guards typeof window; scanDocument() uses dynamic
// import so @capacitor/core is never loaded during server-side rendering.

export function isNative(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as Window & { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor?.isNativePlatform?.()
}

// Returns base64-encoded JPEG strings, one per scanned page.
// Only call this when isNative() is true.
export async function scanDocument(): Promise<string[]> {
  const { registerPlugin } = await import('@capacitor/core')

  const DocumentScanner = registerPlugin<{
    scanDocument(opts: {
      responseType: string
      maxNumDocuments: number
    }): Promise<{ scannedImages?: string[]; status?: string }>
  }>('DocumentScanner')

  const result = await DocumentScanner.scanDocument({
    responseType: 'base64',
    maxNumDocuments: 10,
  })

  if (result.status === 'cancel') return []
  return result.scannedImages ?? []
}

```


---

## `src/lib/supabase/server.ts`

```ts
import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export function createClient() {
  const cookieStore = cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Ignored: called from a Server Component that cannot set cookies.
            // Middleware refreshes the session, so this is safe to ignore.
          }
        },
      },
    }
  )
}

```


---

## `src/lib/supabase/client.ts`

```ts
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

```


---

## `src/lib/supabase/admin.ts`

```ts
import 'server-only'
import { createClient } from '@supabase/supabase-js'

// Server-only. Uses the service role key which bypasses Row Level Security.
// Never import this in client components or expose to the browser.
// The `import 'server-only'` above causes the build to fail if this is
// accidentally imported in a client context.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
}

```


---

## `src/lib/uploadthing.ts`

```ts
import { createUploadthing, type FileRouter } from 'uploadthing/next'

const f = createUploadthing()

export const ourFileRouter = {
  invoiceUploader: f({
    image:              { maxFileSize: '16MB', maxFileCount: 10 },
    'application/pdf':  { maxFileSize: '16MB', maxFileCount: 10 },
    'text/csv':         { maxFileSize: '4MB',  maxFileCount: 10 },
  })
    .middleware(async () => ({}))
    .onUploadComplete(async ({ file }) => ({ url: file.ufsUrl })),
} satisfies FileRouter

export type OurFileRouter = typeof ourFileRouter

```


---

## `src/lib/uploadthing-client.ts`

```ts
import { generateReactHelpers } from '@uploadthing/react'
import type { OurFileRouter } from '@/lib/uploadthing'

export const { useUploadThing, uploadFiles } = generateReactHelpers<OurFileRouter>({
  url: '/api/uploadthing',
})

```
