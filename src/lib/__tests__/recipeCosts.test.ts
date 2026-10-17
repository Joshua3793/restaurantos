import { describe, it, expect, vi } from 'vitest'

// recipeCosts imports the Prisma singleton at module level; the pure functions
// under test never touch it, so stub it out.
vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { prisma } from '@/lib/prisma'
import { computeRecipeCost, linkedRecipeUnitCost, prepCountUnitFor, unionAllergens, fetchRecipeWithCost, syncPrepToInventory, propagatePrepCostChanges } from '@/lib/recipeCosts'
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

describe('computeRecipeCost — custom line allergens', () => {
  it('a custom line carries the allergens hand-tagged on it', () => {
    const out = computeRecipeCost(recipe([
      ing({ id: 'c', customName: 'Pimentón', qtyBase: 5, unit: 'g', allergens: ['Sulphites'] }),
    ]))
    expect(out.ingredients[0].allergens).toEqual(['Sulphites'])
    expect(out.ingredients[0].lineCost).toBe(0)
  })

  it('a custom line with no tags (or a pre-feature row) stays []', () => {
    const out = computeRecipeCost(recipe([ing({ id: 'c', customName: 'Salt', qtyBase: 1, unit: 'g' })]))
    expect(out.ingredients[0].allergens).toEqual([])
  })

  it('unionAllergens merges item, linked-prep and custom allergens without duplicates', () => {
    const milkItem = { ...oilItem, itemName: 'Cream', allergens: ['Milk'] }
    const out = computeRecipeCost(recipe([
      ing({ id: 'a', inventoryItemId: 'x', inventoryItem: milkItem, qtyBase: 10, unit: 'ml' }),
      ing({ id: 'b', linkedRecipeId: 'r2', linkedRecipe: { name: 'Stock', inventoryItem: { allergens: ['Eggs', 'Milk'] } }, qtyBase: 1, unit: 'ml', _linkedRecipeCostPerUnit: 0.01, _linkedRecipeYieldUnit: 'ml' }),
      ing({ id: 'c', customName: 'Pimentón', qtyBase: 5, unit: 'g', allergens: ['Sulphites', 'Milk'] }),
    ]))
    expect(unionAllergens(out.ingredients).sort()).toEqual(['Eggs', 'Milk', 'Sulphites'])
  })
})

describe('custom line allergens reach the recipe', () => {
  const row = {
    id: 'r1', name: 'Rub', type: 'PREP', categoryId: 'c1', category: { name: 'Sauces', color: null },
    inventoryItemId: 'item-r1', baseYieldQty: 1000, yieldUnit: 'g', portionSize: null, portionUnit: null,
    menuPrice: null, isActive: true, notes: null, steps: [], activeMinutes: null, passiveMinutes: null,
    passiveNote: null, stages: null, method: null, createdAt: new Date(), updatedAt: new Date(),
    baseIngredientId: null, prepItems: [],
    ingredients: [
      ing({ id: 'a', inventoryItemId: 'x', inventoryItem: oilItem, qtyBase: 100, unit: 'ml' }),
      ing({ id: 'c', customName: 'Pimentón', qtyBase: 5, unit: 'g', allergens: ['Sulphites'] }),
    ],
  }

  it('fetchRecipeWithCost lists it, and syncPrepToInventory writes it onto the prep item', async () => {
    const update = vi.fn().mockResolvedValue({})
    Object.assign(prisma, {
      recipe: { findUnique: vi.fn().mockResolvedValue(row) },
      inventoryItem: { update },
    })
    const r = await fetchRecipeWithCost('r1')
    expect(r!.allergens).toContain('Sulphites')

    await syncPrepToInventory('r1')
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0][0].data.allergens).toContain('Sulphites')
  })
})

describe('fetchRecipeWithCost — scanned recipes', () => {
  // The recipe panel loads from GET /api/recipes/[id], which returns this
  // hand-built object; the "See original" button reads sourceScanId off it.
  const base = {
    id: 'r1', name: 'Romesco', type: 'PREP', categoryId: 'c1', category: { name: 'Sauces', color: null },
    inventoryItemId: null, baseYieldQty: 1000, yieldUnit: 'g', portionSize: null, portionUnit: null,
    menuPrice: null, isActive: true, notes: null, steps: [], activeMinutes: null, passiveMinutes: null,
    passiveNote: null, stages: null, method: null, createdAt: new Date(), updatedAt: new Date(),
    baseIngredientId: null, prepItems: [], ingredients: [],
  }

  it('carries sourceScanId so the See original button can show', async () => {
    Object.assign(prisma, { recipe: { findUnique: vi.fn().mockResolvedValue({ ...base, sourceScanId: 'scan1' }) } })
    const r = await fetchRecipeWithCost('r1')
    expect(r!.sourceScanId).toBe('scan1')
  })

  it('a recipe that was not scanned has sourceScanId null', async () => {
    Object.assign(prisma, { recipe: { findUnique: vi.fn().mockResolvedValue({ ...base, sourceScanId: null }) } })
    const r = await fetchRecipeWithCost('r1')
    expect(r!.sourceScanId).toBeNull()
  })
})

describe('propagatePrepCostChanges — allergen cascade', () => {
  // Mustard Seed (raw) → Mustard Base (sub-prep) → Honey Mustard (parent)
  // → Club Sauce (grandparent). Tagging Mustard on the seed changes no price,
  // but every prep above it must pick the allergen up.
  type Item = Record<string, unknown> & { allergens: string[] }
  const items = new Map<string, Item>()
  const prepItem = (): Item => ({
    itemName: '', dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'batch', per: 1000 }],
    pricing: { mode: 'PACK', purchasePrice: 0 }, allergens: [],
  })
  const recipes = {
    S: { id: 'S', name: 'Mustard Base', out: 'iS', line: { inventoryItemId: 'X', linkedRecipeId: null, qtyBase: 100 } },
    P: { id: 'P', name: 'Honey Mustard', out: 'iP', line: { inventoryItemId: null, linkedRecipeId: 'S', qtyBase: 200 } },
    G: { id: 'G', name: 'Club Sauce', out: 'iG', line: { inventoryItemId: null, linkedRecipeId: 'P', qtyBase: 500 } },
  } as const
  type Key = keyof typeof recipes
  const row = (id: Key) => {
    const r = recipes[id]
    const linked = r.line.linkedRecipeId as Key | null
    return {
      id: r.id, name: r.name, type: 'PREP', categoryId: 'c1', category: { name: 'Sauces', color: null },
      inventoryItemId: r.out, baseYieldQty: 1000, yieldUnit: 'g', portionSize: null, portionUnit: null,
      menuPrice: null, isActive: true, notes: null, steps: [], activeMinutes: null, passiveMinutes: null,
      passiveNote: null, stages: null, method: null, createdAt: new Date(), updatedAt: new Date(),
      baseIngredientId: null, prepItems: [], sourceScanId: null,
      ingredients: [ing({
        id: `${id}-1`, qtyBase: r.line.qtyBase, unit: 'g',
        inventoryItemId: r.line.inventoryItemId,
        inventoryItem: r.line.inventoryItemId ? items.get(r.line.inventoryItemId) : null,
        linkedRecipeId: linked,
        linkedRecipe: linked ? { name: recipes[linked].name, yieldUnit: 'g', inventoryItem: items.get(recipes[linked].out) } : null,
      })],
    }
  }
  const update = vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    items.set(where.id, { ...items.get(where.id)!, ...data } as Item)
    return {}
  })

  it('an allergen-only change on a sub-prep re-syncs the parent and grandparent, with no cost alerts', async () => {
    items.clear()
    items.set('X', { ...oilItem, itemName: 'Mustard Seed', dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'kg', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 10 }, allergens: [] })
    for (const k of ['iS', 'iP', 'iG']) items.set(k, prepItem())
    Object.assign(prisma, {
      recipe: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id in recipes ? row(where.id as Key) : null)),
        findMany: vi.fn(async () => (Object.keys(recipes) as Key[]).map(k => ({
          id: k, inventoryItemId: recipes[k].out,
          ingredients: [{ inventoryItemId: recipes[k].line.inventoryItemId, linkedRecipeId: recipes[k].line.linkedRecipeId }],
        }))),
      },
      inventoryItem: {
        update,
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => items.get(where.id) ?? null),
      },
    })
    // Settle every prep on today's prices first (leaf first).
    for (const k of ['S', 'P', 'G'] as const) await syncPrepToInventory(k)
    const costsBefore = ['iS', 'iP', 'iG'].map(k => JSON.stringify(items.get(k)!.pricing))
    update.mockClear()

    // The chef tags Mustard on the seed: same price, new allergen.
    items.set('X', { ...items.get('X')!, allergens: ['Mustard'] })
    const moved = await propagatePrepCostChanges(['X'])

    expect(moved).toEqual([])
    expect(update.mock.calls.map(c => c[0].where.id)).toEqual(['iS', 'iP', 'iG'])
    for (const k of ['iS', 'iP', 'iG']) expect(items.get(k)!.allergens).toEqual(['Mustard'])
    expect(['iS', 'iP', 'iG'].map(k => JSON.stringify(items.get(k)!.pricing))).toEqual(costsBefore)
  })
})

describe('computeRecipeCost — unpriced lines', () => {
  const freeItem = { ...oilItem, itemName: 'Smoked Paprika', pricing: { mode: 'PACK', purchasePrice: 0 } }

  it('unpriced item line is flagged', () => {
    const out = computeRecipeCost(recipe([
      ing({ id: 'a', inventoryItemId: 'x', inventoryItem: freeItem, qtyBase: 5, unit: 'ml' }),
      ing({ id: 'b', inventoryItemId: 'y', inventoryItem: oilItem, qtyBase: 5, unit: 'ml' }),
    ]))
    expect(out.ingredients[0].unpriced).toBe(true)
    expect(out.ingredients[0].lineCost).toBe(0)
    expect(out.ingredients[1].unpriced).toBe(false)
  })

  it('a priced item with no amount (qty 0) is NOT unpriced', () => {
    const out = computeRecipeCost(recipe([
      ing({ id: 'a', inventoryItemId: 'y', inventoryItem: oilItem, qtyBase: 0, unit: 'ml' }),
    ]))
    expect(out.ingredients[0].unpriced).toBe(false)
  })

  it('an item line is unpriced regardless of quantity', () => {
    const out = computeRecipeCost(recipe([
      ing({ id: 'a', inventoryItemId: 'x', inventoryItem: freeItem, qtyBase: 0, unit: 'ml' }),
    ]))
    expect(out.ingredients[0].unpriced).toBe(true)
  })

  it('judges the price actually used: an average-basis price rescues a zero spine', () => {
    const p = new Map([['x', { basis: 'AVG_30D', pricePerBase: 0.5, avg: { pricePerBase: 0.5, paid: 1, received: 1, lines: 1, excluded: 0 } } as ItemCostBasis]])
    const out = computeRecipeCost(recipe([
      ing({ id: 'a', inventoryItemId: 'x', inventoryItem: freeItem, qtyBase: 2, unit: 'ml' }),
    ]), { prices: p })
    expect(out.ingredients[0].unpriced).toBe(false)
  })

  it('a linked prep with no cost is unpriced; a priced one is not', () => {
    const mk = (cost: number) => computeRecipeCost(recipe([
      ing({ id: 'p', linkedRecipeId: 'r2', linkedRecipe: { name: 'Stock', inventoryItem: null }, qtyBase: 100, unit: 'ml', _linkedRecipeCostPerUnit: cost, _linkedRecipeYieldUnit: 'ml' }),
    ])).ingredients[0].unpriced
    expect(mk(0)).toBe(true)
    expect(mk(0.01)).toBe(false)
  })

  it('a custom line is never "unpriced" — it is deliberately uncosted', () => {
    const out = computeRecipeCost(recipe([ing({ id: 'c', customName: 'Salt', qtyBase: 1, unit: 'g' })]))
    expect(out.ingredients[0].unpriced).toBe(false)
  })
})
