import { describe, it, expect, vi } from 'vitest'

// recipeCosts imports the Prisma singleton at module level; the pure functions
// under test never touch it, so stub it out.
vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { computeRecipeCost, linkedRecipeUnitCost, prepCountUnitFor } from '@/lib/recipeCosts'
import type { ItemCostBasis } from '@/lib/cost-basis'

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
    yieldUnit: 'g',
    portionSize: null,
    portionUnit: null,
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

  it('converts the portion unit into the yield unit (40 g of a 3 kg batch = 75 portions)', () => {
    const r = computeRecipeCost(recipe(
      [ing({ qtyBase: 1000, unit: 'ml', inventoryItemId: 'x', inventoryItem: oilItem })],
      { baseYieldQty: 3, yieldUnit: 'kg', portionSize: 40, portionUnit: 'g' },
    ))
    expect(r.totalCost).toBeCloseTo(2)
    expect(r.costPerPortion).toBeCloseTo(2 / 75) // NOT 2 / 0.075
  })

  it('defaults a missing portionUnit to the yield unit', () => {
    const r = computeRecipeCost(recipe(
      [ing({ qtyBase: 1000, unit: 'ml', inventoryItemId: 'x', inventoryItem: oilItem })],
      { baseYieldQty: 1000, yieldUnit: 'g', portionSize: 250, portionUnit: null },
    ))
    expect(r.costPerPortion).toBeCloseTo(0.5) // 4 portions
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

describe('prepCountUnitFor', () => {
  it('keeps the recipe yield unit for mass/volume yields', () => {
    expect(prepCountUnitFor('kg')).toBe('kg')
    expect(prepCountUnitFor('lb')).toBe('lb')
    expect(prepCountUnitFor('g')).toBe('g')
    expect(prepCountUnitFor('l')).toBe('l')
    expect(prepCountUnitFor('ml')).toBe('ml')
  })

  it('canonicalises aliases', () => {
    expect(prepCountUnitFor('Kg')).toBe('kg')
    expect(prepCountUnitFor('litre')).toBe('l')
  })

  it('never returns "batch" — a pack level is not a display unit', () => {
    expect(prepCountUnitFor('batch')).not.toBe('batch')
    expect(prepCountUnitFor('batch')).toBe('each')
  })

  it('collapses COUNT yield words to the canonical base', () => {
    // 'portion'/'serve' are neither a chain level nor a measured unit, so the
    // count converters cannot resolve them — they must not become the countUnit.
    expect(prepCountUnitFor('portion')).toBe('each')
    expect(prepCountUnitFor('serve')).toBe('each')
    expect(prepCountUnitFor('each')).toBe('each')
  })

  it('rejects container units', () => {
    expect(prepCountUnitFor('case')).toBe('each')
  })
})

describe('computeRecipeCost — custom (uncosted) ingredients', () => {
  it('adds a custom line at $0 and leaves it uncosted', () => {
    const r = computeRecipeCost(recipe([
      ing({ qtyBase: 500, unit: 'ml', inventoryItemId: 'x', inventoryItem: oilItem }),
      ing({ id: 'i2', qtyBase: 2, unit: 'sprig', customName: 'Fresh basil garnish' }),
    ]))
    // total is unchanged from the single oil line (500 ml × $0.002 = $1)
    expect(r.totalCost).toBeCloseTo(1)
    const custom = r.ingredients.find(i => i.id === 'i2')!
    expect(custom.ingredientType).toBe('custom')
    expect(custom.ingredientName).toBe('Fresh basil garnish')
    expect(custom.lineCost).toBe(0)
    expect(custom.pricePerBaseUnit).toBe(0)
    expect(custom.ingredientBaseUnit).toBe('sprig')
    expect(custom.dimensionConflict).toBe(false)
    expect(custom.allergens).toEqual([])
  })

  it('a free-form unit on a custom line never triggers a dimension conflict', () => {
    const r = computeRecipeCost(recipe([
      ing({ qtyBase: 1, unit: 'to taste', customName: 'Sea salt' }),
    ]))
    expect(r.dimensionConflicts).toBe(0)
    expect(r.totalCost).toBe(0)
  })
})

describe('computeRecipeCost — cost basis', () => {
  const avg = (p: number): ItemCostBasis => ({ basis: 'AVG_30D', pricePerBase: p, avg: { pricePerBase: p, paid: 1, received: 1, lines: 1, excluded: 0 } })
  const last = (p: number): ItemCostBasis => ({ basis: 'LAST', pricePerBase: p, fallbackReason: 'no-purchases' })

  it('with no map every line is LAST and the output is byte-identical to today', () => {
    const r = recipe([ing({ id: 'a', inventoryItemId: 'oil', inventoryItem: oilItem, qtyBase: 500, unit: 'ml' })])
    const before = computeRecipeCost(r)
    const after = computeRecipeCost(r, {})
    expect(after).toEqual({ ...before, basisSummary: { basis: 'LAST', avgLines: 0, lastLines: 1 } })
    expect(after.ingredients[0].costBasis).toBe('LAST')
    expect(after.ingredients[0].lineCost).toBeCloseTo(500 * 0.002, 6)
  })
  it('a mapped AVG item prices at the map, is tagged, and the summary counts it', () => {
    const r = recipe([
      ing({ id: 'a', inventoryItemId: 'oil', inventoryItem: oilItem, qtyBase: 500, unit: 'ml' }),
      ing({ id: 'b', inventoryItemId: 'chk', inventoryItem: chickenItem, qtyBase: 1000, unit: 'g' }),
    ])
    const out = computeRecipeCost(r, { prices: new Map([['oil', avg(0.003)], ['chk', last(20 / 11000)]]) })
    expect(out.ingredients[0]).toMatchObject({ costBasis: 'AVG_30D', pricePerBaseUnit: 0.003, lineCost: 1.5 })
    expect(out.ingredients[1].costBasis).toBe('LAST')
    expect(out.basisSummary).toEqual({ basis: 'AVG_30D', avgLines: 1, lastLines: 1 })
  })
  it('a nested prep line takes the basis Task 3 resolved for it', () => {
    const r = recipe([ing({ id: 'p', linkedRecipeId: 'r2', linkedRecipe: { name: 'Stock', inventoryItem: null }, qtyBase: 100, unit: 'ml', _linkedRecipeCostPerUnit: 0.01, _linkedRecipeYieldUnit: 'ml', _linkedRecipeCostBasis: 'AVG_30D' })])
    const out = computeRecipeCost(r, { prices: new Map() })
    expect(out.ingredients[0]).toMatchObject({ costBasis: 'AVG_30D', lineCost: 1 })
    expect(out.basisSummary.basis).toBe('AVG_30D')
  })
  it('a custom ingredient is LAST and counts as a last line', () => {
    const out = computeRecipeCost(recipe([ing({ id: 'c', customName: 'pinch of love', qtyBase: 1, unit: 'g' })]), { prices: new Map() })
    expect(out.ingredients[0].costBasis).toBe('LAST')
    expect(out.basisSummary).toEqual({ basis: 'LAST', avgLines: 0, lastLines: 1 })
  })
})
