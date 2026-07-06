import { describe, it, expect, vi } from 'vitest'

// recipeCosts imports the Prisma singleton at module level; the pure functions
// under test never touch it, so stub it out.
vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { computeRecipeCost, linkedRecipeUnitCost } from '@/lib/recipeCosts'

/** $24/case of 12,000 ml → $0.002/ml */
const oilItem = {
  itemName: 'Canola Oil',
  dimension: 'VOLUME',
  baseUnit: 'ml',
  packChain: [{ unit: 'case', per: 12000 }],
  pricing: { mode: 'PACK', purchasePrice: 24 },
  allergens: [] as string[],
}

/** COUNT item with a count↔weight bridge: 1 each = 1100 g, $2/each */
const chickenItem = {
  itemName: 'Whole Chicken',
  dimension: 'MASS',
  baseUnit: 'g',
  packChain: [{ unit: 'case', per: 11000 }],
  pricing: { mode: 'PACK', purchasePrice: 20 }, // $20 / 11,000 g
  eachMeasureQty: '1100', // Prisma Decimal → string
  eachMeasureUnit: 'g',
  allergens: [] as string[],
}

function ing(overrides: Record<string, unknown>) {
  return {
    id: 'i1',
    sortOrder: 0,
    qtyBase: 1,
    unit: 'g',
    notes: null,
    recipePercent: null,
    inventoryItemId: null,
    linkedRecipeId: null,
    inventoryItem: null,
    linkedRecipe: null,
    ...overrides,
  }
}

function recipe(ingredients: ReturnType<typeof ing>[], overrides: Record<string, unknown> = {}) {
  return {
    baseYieldQty: 1000,
    portionSize: null,
    menuPrice: null,
    ingredients,
    ...overrides,
  } as Parameters<typeof computeRecipeCost>[0]
}

describe('computeRecipeCost — inventory ingredients', () => {
  it('costs a same-unit ingredient: qty × ppb', () => {
    const r = computeRecipeCost(recipe([
      ing({ qtyBase: 500, unit: 'ml', inventoryItemId: 'x', inventoryItem: oilItem }),
    ]))
    expect(r.totalCost).toBeCloseTo(1) // 500 ml × $0.002
    expect(r.ingredients[0].pricePerBaseUnit).toBeCloseTo(0.002)
    expect(r.ingredients[0].ingredientBaseUnit).toBe('ml')
    expect(r.dimensionConflicts).toBe(0)
  })

  it('converts the recipe unit to the item base unit before pricing', () => {
    const r = computeRecipeCost(recipe([
      ing({ qtyBase: 2, unit: 'l', inventoryItemId: 'x', inventoryItem: oilItem }),
    ]))
    expect(r.totalCost).toBeCloseTo(4) // 2000 ml × $0.002
  })

  it('accepts Prisma Decimal-as-string quantities', () => {
    const r = computeRecipeCost(recipe([
      ing({ qtyBase: '500' as unknown as number, unit: 'ml', inventoryItemId: 'x', inventoryItem: oilItem }),
    ]))
    expect(r.totalCost).toBeCloseTo(1)
  })

  it('bridges count → measured via eachMeasure (1 each = 1100 g)', () => {
    const r = computeRecipeCost(recipe([
      ing({ qtyBase: 2, unit: 'each', inventoryItemId: 'x', inventoryItem: chickenItem }),
    ]))
    // 2 each → 2200 g × ($20/11,000 g)
    expect(r.dimensionConflicts).toBe(0)
    expect(r.totalCost).toBeCloseTo(2200 * (20 / 11000))
  })

  it('flags count↔measured without a bridge as a conflict and contributes $0', () => {
    const eggItem = {
      itemName: 'Egg',
      dimension: 'COUNT',
      baseUnit: 'each',
      packChain: [{ unit: 'flat', per: 30 }],
      pricing: { mode: 'PACK', purchasePrice: 9 },
      allergens: ['Egg'],
    }
    const r = computeRecipeCost(recipe([
      ing({ qtyBase: 100, unit: 'g', inventoryItemId: 'x', inventoryItem: eggItem }),
    ]))
    expect(r.dimensionConflicts).toBe(1)
    expect(r.ingredients[0].dimensionConflict).toBe(true)
    expect(r.totalCost).toBe(0)
    expect(r.ingredients[0].allergens).toEqual(['Egg'])
  })
})

describe('computeRecipeCost — linked PREP ingredients', () => {
  it('prices a linked recipe via its resolved cost per yield unit, with conversion', () => {
    const r = computeRecipeCost(recipe([
      ing({
        qtyBase: 1,
        unit: 'kg',
        linkedRecipeId: 'r2',
        linkedRecipe: { name: 'Tomato Sauce', inventoryItem: { allergens: [] } },
        _linkedRecipeCostPerUnit: 0.005, // $/g from the synced item
        _linkedRecipeYieldUnit: 'g',
      }),
    ]))
    expect(r.ingredients[0].ingredientType).toBe('recipe')
    expect(r.totalCost).toBeCloseTo(5) // 1000 g × $0.005
  })
})

describe('computeRecipeCost — portions and food cost %', () => {
  it('derives costPerPortion and foodCostPct', () => {
    const r = computeRecipeCost(recipe(
      [ing({ qtyBase: 1000, unit: 'ml', inventoryItemId: 'x', inventoryItem: oilItem })],
      { baseYieldQty: 1000, portionSize: 250, menuPrice: 10 },
    ))
    expect(r.totalCost).toBeCloseTo(2)
    expect(r.costPerPortion).toBeCloseTo(0.5) // 4 portions
    expect(r.foodCostPct).toBeCloseTo(5) // 0.5 / 10
  })

  it('returns nulls when portion/menu data is missing or zero', () => {
    const r = computeRecipeCost(recipe(
      [ing({ qtyBase: 100, unit: 'ml', inventoryItemId: 'x', inventoryItem: oilItem })],
      { baseYieldQty: 0, portionSize: null, menuPrice: null },
    ))
    expect(r.costPerPortion).toBeNull()
    expect(r.foodCostPct).toBeNull()
  })
})

describe('linkedRecipeUnitCost', () => {
  it('reads the spine of the synced inventory item', () => {
    const out = linkedRecipeUnitCost({
      yieldUnit: 'batch',
      inventoryItem: {
        dimension: 'VOLUME',
        baseUnit: 'ml',
        packChain: [{ unit: 'batch', per: 2000 }],
        pricing: { mode: 'PACK', purchasePrice: 8 },
      },
    })
    expect(out.costPerUnit).toBeCloseTo(0.004) // $8 / 2000 ml
    expect(out.yieldUnit).toBe('ml') // denominated in the item base unit
  })

  it('falls back to $0 at the recipe yield unit when no item is linked', () => {
    expect(linkedRecipeUnitCost({ yieldUnit: 'batch', inventoryItem: null })).toEqual({
      costPerUnit: 0,
      yieldUnit: 'batch',
    })
  })
})
