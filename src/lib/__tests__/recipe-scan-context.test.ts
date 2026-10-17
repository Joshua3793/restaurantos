import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DraftData, DraftLine } from '../recipe-scan/types'

const h = vi.hoisted(() => ({
  itemRows: [] as unknown[],
  recipeRows: [] as unknown[],
  itemCosts: vi.fn(),
  costContext: vi.fn(),
  prefetchRecipes: vi.fn(),
  resolveLinkedRecipes: vi.fn(),
}))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    inventoryItem: { findMany: async () => h.itemRows },
    recipe: { findMany: async () => h.recipeRows },
  },
}))
vi.mock('@/lib/cost-basis', () => ({ itemCosts: h.itemCosts }))
vi.mock('@/lib/recipeCosts', () => ({
  costContext: h.costContext, prefetchRecipes: h.prefetchRecipes, resolveLinkedRecipes: h.resolveLinkedRecipes,
}))

import { costOfLine, draftCosts, priceLines, searchCandidates } from '../recipe-scan/context'
import type { Candidate } from '../recipe-scan/match'

const kgItem = {
  dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'kg', per: 1000 }],
  pricing: { mode: 'PACK', purchasePrice: 12 }, countUnit: 'kg',
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
}

describe('costOfLine', () => {
  it('costs the amount in the item base unit at the given $/base', () => {
    expect(costOfLine(kgItem, 0.012, 250, 'g')).toBeCloseTo(3)
    expect(costOfLine(kgItem, 0.012, 0.5, 'kg')).toBeCloseTo(6)
  })
  it('unknown amount or a count against a weighed item is no cost, not $0', () => {
    expect(costOfLine(kgItem, 0.012, null, 'g')).toBeNull()
    expect(costOfLine(kgItem, 0.012, 3, 'each')).toBeNull()
  })
})

function line(over: Partial<DraftLine> = {}): DraftLine {
  return {
    key: 'l1', raw: '250 g almonds', name: 'almonds', qtyText: '250 g', qty: 250, unit: 'g',
    link: { kind: 'item', id: 'alm', name: 'Almonds' }, status: 'MATCHED', reason: null, allergens: null, ...over,
  }
}
function draft(lines: DraftLine[]): DraftData {
  return {
    name: 'Romesco', yieldQty: 1, yieldUnit: 'l', yieldGuessed: false, categoryId: 'c', revenueCenterId: null,
    lines, method: [], guessed: {}, siblingHints: {},
  }
}

describe('priceLines', () => {
  it('items, prep recipes, unpriced and unlinked lines', () => {
    const d = draft([
      line(),
      line({ key: 'l2', qty: 100, unit: 'g', link: { kind: 'item', id: 'new', name: 'Pimenton' } }),
      line({ key: 'l3', qty: 50, unit: 'ml', link: { kind: 'recipe', id: 'aioli', name: 'Aioli' } }),
      line({ key: 'l4', link: null, qty: null, unit: null, status: 'NO_MATCH' }),
    ])
    const costs = priceLines(
      d,
      new Map([['alm', { row: kgItem, pricePerBase: 0.02 }], ['new', { row: kgItem, pricePerBase: 0 }]]),
      new Map([['aioli', { costPerUnit: 0.01, yieldUnit: 'ml' }]]),
    )
    expect(costs.l1.lineCost).toBeCloseTo(5)
    expect(costs.l1.unpriced).toBe(false)
    expect(costs.l2).toEqual({ lineCost: 0, unpriced: true }) // "no price yet", never hidden
    expect(costs.l3.lineCost).toBeCloseTo(0.5)
    expect(costs.l4).toEqual({ lineCost: null, unpriced: false })
  })
})

describe('draftCosts', () => {
  beforeEach(() => {
    h.itemRows = [{ id: 'alm', ...kgItem }]
    h.recipeRows = [{ id: 'aioli', yieldUnit: 'l', inventoryItem: { ...kgItem, dimension: 'VOLUME', baseUnit: 'ml' } }]
    h.itemCosts.mockReset().mockResolvedValue(new Map([['alm', { basis: 'AVG_30D', pricePerBase: 0.02 }]]))
    h.costContext.mockReset().mockResolvedValue({ basis: 'AVG_30D' })
    h.prefetchRecipes.mockReset().mockResolvedValue(undefined)
    h.resolveLinkedRecipes.mockReset().mockImplementation(async (ings: { linkedRecipeId: string }[]) =>
      ings.map(i => ({ ...i, _linkedRecipeCostPerUnit: 0.004, _linkedRecipeYieldUnit: 'ml', _linkedRecipeCostBasis: 'AVG_30D' })))
  })

  it('prices on the recipe page basis: 30-day average items, recursed preps', async () => {
    const costs = await draftCosts(draft([
      line(),
      line({ key: 'l2', qty: 250, unit: 'ml', link: { kind: 'recipe', id: 'aioli', name: 'Aioli' } }),
    ]))
    expect(h.itemCosts).toHaveBeenCalledWith(['alm'], 'AVG_30D')
    expect(h.costContext).toHaveBeenCalledWith('AVG_30D', [])
    expect(h.prefetchRecipes).toHaveBeenCalledWith({ basis: 'AVG_30D' }, ['aioli'])
    expect(h.resolveLinkedRecipes.mock.calls[0][0][0]).toMatchObject({ linkedRecipeId: 'aioli', unit: 'ml' })
    expect(costs.l1.lineCost).toBeCloseTo(5)   // 250 g × $0.02/g (average, not the $0.012 list price)
    expect(costs.l2.lineCost).toBeCloseTo(1)   // 250 ml × $0.004/ml
  })
})

function cand(id: string, name: string, over: Partial<Candidate> = {}): Candidate {
  return { kind: 'item', id, name, active: true, mergedIntoId: null, usedInRecipes: 0, boughtAs: '', supplier: null, ...over }
}

describe('searchCandidates', () => {
  it('ranks names containing the words first and never offers inactive or merged', () => {
    const all = [
      cand('1', 'Garlic Peeled', { usedInRecipes: 9 }),
      cand('2', 'Garlic Whole'),
      cand('3', 'Old Garlic', { active: false }),
      cand('4', 'Garlic Dup', { active: false, mergedIntoId: '1' }),
      cand('5', 'Paprika'),
    ]
    expect(searchCandidates('garlic', all).map(c => c.id)).toEqual(['1', '2'])
    expect(searchCandidates('', all).map(c => c.id)).toEqual(['1', '2', '5'])
  })
})
