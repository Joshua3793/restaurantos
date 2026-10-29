import { describe, it, expect, vi, beforeEach } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db: Record<string, any> = {}
vi.mock('@/lib/prisma', () => ({ prisma: new Proxy({}, { get: (_t, k: string) => db[k] }) }))

import { recalculateRecipeCosts } from '@/lib/recipe-costs'

const perGram = (id: string, ppg: number) => ({
  id, dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'kg', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: ppg * 1000 }, countUnit: 'g',
})

beforeEach(() => { for (const k of Object.keys(db)) delete db[k] })

describe('recalculateRecipeCosts — by-products', () => {
  const recipe = {
    id: 'R', baseYieldQty: '1000', yieldUnit: 'g', portionSize: null, portionUnit: null, menuPrice: '0',
    ingredients: [{ qtyBase: '1000', inventoryItem: perGram('brisket', 0.1), linkedRecipe: null }],   // $100
    byproducts: [{ qty: '1000', inventoryItem: perGram('trim', 0.02) }],                              // −$20
  }

  it('subtracts credits and finds recipes through a by-product', async () => {
    db.recipeIngredient = { findMany: vi.fn(async () => []) }
    db.recipeByproduct = { findMany: vi.fn(async () => [{ recipeId: 'R' }]) }
    db.recipe = { findMany: vi.fn(async () => [recipe]) }
    // trim was $0.01/g before: credit $10 → old total $90; now credit $20 → $80
    const out = await recalculateRecipeCosts(['trim'], undefined, new Map([['trim', 0.01]]))
    expect(out).toEqual([{ recipeId: 'R', changePct: expect.closeTo(((80 - 90) / 90) * 100) }])
    expect(db.recipe.findMany.mock.calls[0][0].where.id.in).toEqual(['R'])
  })

  it('floors the total at zero', async () => {
    db.recipeIngredient = { findMany: vi.fn(async () => [{ recipeId: 'R' }]) }
    db.recipeByproduct = { findMany: vi.fn(async () => []) }
    db.recipe = { findMany: vi.fn(async () => [{ ...recipe, byproducts: [{ qty: '10000', inventoryItem: perGram('trim', 0.02) }] }]) }
    // old: credit $100 vs $50 gross → $0 ; new: same → $0 → no change, no NaN
    const out = await recalculateRecipeCosts(['brisket'], undefined, new Map([['brisket', 0.05]]))
    expect(out[0].changePct).toBe(0)
  })
})
