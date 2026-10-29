import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// The scaled copy (save-scale) and the scale preview must carry a recipe's
// by-products, scaled like its ingredients; deleting an item that comes off a
// batch is blocked like deleting an ingredient.

vi.mock('@/lib/auth', () => ({
  requireSession: async () => ({ id: 'u1', role: 'ADMIN', isActive: true }),
  AuthError: class extends Error { status = 403 },
}))
vi.mock('@/lib/rc-scope', () => ({ assertRcWritable: async () => undefined }))
vi.mock('@/lib/prep-sync', () => ({ syncPrepItemFromRecipe: vi.fn(async () => undefined) }))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fetchRecipeWithCost = vi.fn(async (..._a: unknown[]): Promise<any> => null)
vi.mock('@/lib/recipeCosts', () => ({
  resyncPrepRecipe: vi.fn(async () => undefined),
  fetchRecipeWithCost: (...a: unknown[]) => fetchRecipeWithCost(...a),
}))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db: Record<string, any> = {}
vi.mock('@/lib/prisma', () => ({ prisma: new Proxy({}, { get: (_t, k: string) => db[k] }) }))

const saveScale = await import('@/app/api/recipes/[id]/save-scale/route')
const scale = await import('@/app/api/recipes/[id]/scale/route')
const inventory = await import('@/app/api/inventory/[id]/route')

beforeEach(() => { for (const k of Object.keys(db)) delete db[k]; fetchRecipeWithCost.mockReset() })

describe('save-scale', () => {
  it('copies by-products scaled by the factor', async () => {
    const source = {
      id: 'r1', name: 'Smoked Brisket', type: 'PREP', categoryId: 'c', baseYieldQty: 6, yieldUnit: 'kg', portionSize: null, portionUnit: null,
      menuPrice: null, notes: null, revenueCenterId: null, steps: [], method: null,
      ingredients: [{ inventoryItemId: 'brisket', linkedRecipeId: null, customName: null, qtyBase: 13, unit: 'kg', recipePercent: null, notes: null }],
      byproducts: [{ inventoryItemId: 'trim', qty: '2', unit: 'kg', notes: 'from the deckle', sortOrder: 0 }],
    }
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'r2', ...data }))
    db.recipe = { findUnique: vi.fn(async () => source), create, update: vi.fn(async () => ({})) }
    db.inventoryItem = { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'out2' })) }
    const req = { json: async () => ({ newName: 'Smoked Brisket ×2', factor: 2 }) } as unknown as NextRequest
    expect((await saveScale.POST(req, { params: { id: 'r1' } })).status).toBe(201)
    expect(db.recipe.findUnique.mock.calls[0][0].include.byproducts).toBeDefined()
    expect(create.mock.calls[0][0].data.byproducts).toEqual({
      create: [{ inventoryItemId: 'trim', qty: 4, unit: 'kg', notes: 'from the deckle', sortOrder: 0 }],
    })
  })
})

describe('scale preview', () => {
  it('scales by-product amounts and credits with the batch', async () => {
    fetchRecipeWithCost.mockResolvedValueOnce({
      baseYieldQty: 6, ingredients: [], totalCost: 236.1, grossCost: 256.1, byproductCredit: 20,
      byproducts: [{ id: 'b1', qty: 2, credit: 20 }],
    })
    const req = { url: 'http://x/api/recipes/r1/scale?factor=2' } as unknown as NextRequest
    const body = await (await scale.GET(req, { params: { id: 'r1' } })).json()
    expect(body.byproducts).toEqual([{ id: 'b1', qty: 4, credit: 40 }])
    expect(body.grossCost).toBeCloseTo(512.2)
    expect(body.byproductCredit).toBeCloseTo(40)
    expect(body.totalCost).toBeCloseTo(472.2)
  })
})

describe('inventory DELETE', () => {
  it('is blocked for an item that comes off a recipe batch', async () => {
    const zero = { count: async () => 0 }
    db.inventoryItem = { findUnique: async () => ({ id: 'trim', mergedIntoId: null }) }
    for (const k of ['recipeIngredient', 'recipe', 'invoiceLineItem', 'countLine', 'inventorySnapshot', 'wastageLog', 'stockTransfer', 'prepItem']) db[k] = zero
    db.recipeByproduct = { count: async () => 2 }
    const res = await inventory.DELETE({} as NextRequest, { params: { id: 'trim' } })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('this item is a by-product of 2 prep recipes')
  })
})
