import { describe, it, expect, vi, beforeEach } from 'vitest'

const findMany = vi.fn()
vi.mock('@/lib/prisma', () => ({ prisma: { recipe: { findMany: (...a: unknown[]) => findMany(...a) } } }))
vi.mock('@/lib/recipeCosts', () => ({ fetchRecipeWithCost: vi.fn() }))

import { ruleRecipeConflict } from '@/lib/signals/rules'

const EGGS = { id: 'i-eggs', itemName: 'Eggs', baseUnit: 'each', dimension: 'COUNT', eachMeasureQty: null, eachMeasureUnit: null }
const FLOUR = { id: 'i-flour', itemName: 'Flour', baseUnit: 'g', dimension: 'MASS', eachMeasureQty: null, eachMeasureUnit: null }

beforeEach(() => findMany.mockReset())

describe('ruleRecipeConflict', () => {
  it('flags a weight line on a per-each item with no each-measure; skips costable recipes', async () => {
    findMany.mockResolvedValue([
      { id: 'r1', name: 'Pasta Dough', ingredients: [{ unit: 'g', inventoryItem: EGGS }, { unit: 'kg', inventoryItem: FLOUR }] },
      { id: 'r2', name: 'Bread', ingredients: [{ unit: 'g', inventoryItem: FLOUR }, { unit: 'ml', inventoryItem: FLOUR }, { unit: 'g', inventoryItem: null }] },
    ])
    expect(await ruleRecipeConflict()).toEqual([{
      fingerprint: 'recipe-conflict:r1:i-eggs',
      rule: 'RECIPE_CONFLICT',
      severity: 'warn',
      title: "Pasta Dough can't cost Eggs",
      body: 'It uses Eggs by weight, but the item has no "1 each = ? g". Set it on the item.',
      verbLabel: 'Fix item',
      verbHref: '/inventory?item=i-eggs',
      recipeId: 'r1',
      itemId: 'i-eggs',
    }])
  })

  it('is costable once the item has an each-measure, and says "count" for a count line on a measured item', async () => {
    const bridged = { ...EGGS, eachMeasureQty: '50', eachMeasureUnit: 'g' }
    findMany.mockResolvedValue([
      { id: 'r1', name: 'A', ingredients: [{ unit: 'g', inventoryItem: bridged }] },
      { id: 'r2', name: 'B', ingredients: [{ unit: 'each', inventoryItem: FLOUR }, { unit: 'each', inventoryItem: FLOUR }] },
    ])
    const out = await ruleRecipeConflict()
    expect(out).toHaveLength(1) // one per (recipe, item) pair
    expect(out[0].body).toContain('by count')
  })
})
