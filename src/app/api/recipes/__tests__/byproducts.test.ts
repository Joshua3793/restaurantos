import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { ROLE_RANK } from '@/lib/roles'

type Role = keyof typeof ROLE_RANK
const h = vi.hoisted(() => {
  class MockAuthError extends Error {
    constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError' }
  }
  return { MockAuthError, role: 'MANAGER' as string }
})
vi.mock('@/lib/auth', () => ({
  requireSession: async (min?: Role) => {
    if (min && ROLE_RANK[h.role as Role] < ROLE_RANK[min]) throw new h.MockAuthError(403, 'Forbidden')
    return { id: 'u1', role: h.role, isActive: true }
  },
  AuthError: h.MockAuthError,
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db: Record<string, any> = {}
vi.mock('@/lib/prisma', () => ({ prisma: new Proxy({}, { get: (_t, k: string) => db[k] }) }))

const preview = { creditExceedsCost: false, byproductCredit: 20, grossCost: 256.1 }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fetchRecipeWithCost = vi.fn(async (_id: string, opts: any = {}) => {
  if (opts.editByproducts) {
    // Run the what-if so the test can see what rows it was asked to cost.
    opts.editByproducts([{ id: 'b1', qty: 2, unit: 'kg', inventoryItemId: 'trim' }])
    return preview
  }
  return { id: 'r1', totalCost: 236.1 }
})
const resyncPrepRecipe = vi.fn(async () => undefined)
vi.mock('@/lib/recipeCosts', () => ({
  fetchRecipeWithCost: (id: string, opts: unknown) => fetchRecipeWithCost(id, opts),
  resyncPrepRecipe: (id: string) => resyncPrepRecipe(id),
  BYPRODUCT_COST_INCLUDE: { include: { inventoryItem: { select: { itemName: true } } }, orderBy: { sortOrder: 'asc' } },
}))

import * as list from '../[id]/byproducts/route'
import * as one from '../[id]/byproducts/[bpId]/route'

const body = (b: unknown) => ({ json: async () => b }) as unknown as NextRequest
const ctx = { params: { id: 'r1' } }
const oneCtx = { params: { id: 'r1', bpId: 'b1' } }

const trim = { id: 'trim', itemName: 'Brisket Trim', isActive: true, mergedIntoId: null, recipe: null, lastUpdated: new Date() }

beforeEach(() => {
  h.role = 'MANAGER'
  preview.creditExceedsCost = false; preview.byproductCredit = 20; preview.grossCost = 256.1
  fetchRecipeWithCost.mockClear(); resyncPrepRecipe.mockClear()
  for (const k of Object.keys(db)) delete db[k]
  db.recipe = { findUnique: vi.fn(async () => ({ id: 'r1', type: 'PREP', inventoryItemId: 'out', revenueCenterId: 'rc1' })) }
  db.inventoryItem = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === 'trim' ? trim : null)),
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new-item', ...data })),
  }
  db.recipeByproduct = {
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => ({ id: 'b1', recipeId: 'r1', qty: 2, unit: 'kg', inventoryItemId: 'trim' })),
    aggregate: vi.fn(async () => ({ _max: { sortOrder: null } })),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'b-new', ...data })),
    update: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  }
  db.itemRevenueCenter = { create: vi.fn(async () => ({})) }
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(new Proxy({}, { get: (_t, k: string) => db[k] })))
})

const add = { inventoryItemId: 'trim', qty: 2, unit: 'kg' }
const errOf = async (res: Response) => ({ status: res.status, ...(await res.json()) })

describe('POST /api/recipes/[id]/byproducts', () => {
  it.each(['STAFF', 'LEAD'] as const)('rejects %s before touching the database', async role => {
    h.role = role
    expect((await list.POST(body(add), ctx)).status).toBe(403)
    expect(db.recipe.findUnique).not.toHaveBeenCalled()
  })

  it('rejects a MENU recipe', async () => {
    db.recipe.findUnique.mockResolvedValueOnce({ id: 'r1', type: 'MENU', inventoryItemId: null, revenueCenterId: null })
    expect(await errOf(await list.POST(body(add), ctx))).toMatchObject({ status: 400, code: 'NOT_PREP' })
  })

  it('rejects a prep output item', async () => {
    db.inventoryItem.findUnique.mockResolvedValueOnce({ ...trim, id: 'aioli', itemName: 'Beef Tallow Aioli', recipe: { id: 'r9' } })
    expect(await errOf(await list.POST(body({ ...add, inventoryItemId: 'aioli' }), ctx))).toMatchObject({
      status: 400, code: 'PREP_OUTPUT', error: 'Beef Tallow Aioli is made by a recipe — only plain items can come off a batch.',
    })
  })

  it("rejects the recipe's own output", async () => {
    db.inventoryItem.findUnique.mockResolvedValueOnce({ ...trim, id: 'out', recipe: { id: 'r1' } })
    expect(await errOf(await list.POST(body({ ...add, inventoryItemId: 'out' }), ctx))).toMatchObject({ status: 400, code: 'OWN_OUTPUT' })
  })

  it('rejects an inactive item', async () => {
    db.inventoryItem.findUnique.mockResolvedValueOnce({ ...trim, isActive: false })
    expect(await errOf(await list.POST(body(add), ctx))).toMatchObject({ status: 400, code: 'INACTIVE_ITEM' })
  })

  it('rejects a duplicate item', async () => {
    db.recipeByproduct.findFirst.mockResolvedValueOnce({ id: 'b1' })
    expect(await errOf(await list.POST(body(add), ctx))).toMatchObject({ status: 400, code: 'DUPLICATE' })
  })

  it('rejects a zero quantity and an unknown unit', async () => {
    expect(await errOf(await list.POST(body({ ...add, qty: 0 }), ctx))).toMatchObject({ code: 'BAD_QTY' })
    expect(await errOf(await list.POST(body({ ...add, unit: 'blob' }), ctx))).toMatchObject({ code: 'BAD_UNIT' })
  })

  it('rejects credits above the batch cost, writing nothing', async () => {
    preview.creditExceedsCost = true; preview.byproductCredit = 30; preview.grossCost = 25
    expect(await errOf(await list.POST(body(add), ctx))).toMatchObject({
      status: 400, code: 'CREDIT_EXCEEDS', error: 'Credits $30.00 are more than the batch costs $25.00 — check the weights',
    })
    expect(db.recipeByproduct.create).not.toHaveBeenCalled()
    // the guard costs on the stored (last-price) basis
    expect(fetchRecipeWithCost.mock.calls[0][1].basis).toBeUndefined()
  })

  it('creates the row, resyncs and returns the recipe', async () => {
    const res = await list.POST(body(add), ctx)
    expect(res.status).toBe(201)
    expect(db.recipeByproduct.create.mock.calls[0][0].data).toMatchObject({ recipeId: 'r1', inventoryItemId: 'trim', qty: 2, unit: 'kg', sortOrder: 0 })
    expect(resyncPrepRecipe).toHaveBeenCalledWith('r1')
    expect(await res.json()).toEqual({ id: 'r1', totalCost: 236.1 })
    expect(fetchRecipeWithCost.mock.calls.at(-1)![1]).toEqual({ basis: 'AVG_30D' })
  })

  it("createItem makes a not-counted plain item in the recipe's kitchen", async () => {
    const res = await list.POST(body({ createItem: { itemName: 'Beef Bones', rate: 2.5 }, qty: 3, unit: 'kg' }), ctx)
    expect(res.status).toBe(201)
    expect(db.inventoryItem.create.mock.calls[0][0].data).toMatchObject({
      itemName: 'Beef Bones', isStocked: false, dimension: 'MASS', baseUnit: 'g', countUnit: 'kg',
      packChain: [{ unit: 'kg', per: 1000 }], pricing: { mode: 'RATE', rate: 2.5, rateUnit: 'kg' },
    })
    expect(db.itemRevenueCenter.create.mock.calls[0][0].data).toEqual({ inventoryItemId: 'new-item', revenueCenterId: 'rc1' })
    expect(db.recipeByproduct.create.mock.calls[0][0].data.inventoryItemId).toBe('new-item')
  })

  it('createItem refuses a name that already exists', async () => {
    db.inventoryItem.findFirst.mockResolvedValueOnce({ id: 'trim', itemName: 'Brisket Trim' })
    expect(await errOf(await list.POST(body({ createItem: { itemName: 'brisket trim', rate: 10 }, qty: 1, unit: 'kg' }), ctx)))
      .toMatchObject({ status: 400, code: 'ITEM_EXISTS' })
    expect(db.inventoryItem.create).not.toHaveBeenCalled()
  })

  it('createItem needs a price above $0', async () => {
    expect(await errOf(await list.POST(body({ createItem: { itemName: 'Beef Bones', rate: 0 }, qty: 1, unit: 'kg' }), ctx)))
      .toMatchObject({ status: 400, code: 'BAD_PRICE' })
  })
})

describe('PATCH / DELETE /api/recipes/[id]/byproducts/[bpId]', () => {
  it('PATCH re-checks the guard with the edited qty', async () => {
    let seen: unknown
    fetchRecipeWithCost.mockImplementationOnce(async (_id: string, opts: { editByproducts: (r: unknown[]) => unknown[] }) => {
      seen = opts.editByproducts([{ id: 'b1', qty: 2, unit: 'kg' }, { id: 'b2', qty: 1, unit: 'kg' }])
      return { creditExceedsCost: true, byproductCredit: 90, grossCost: 50 } as never
    })
    expect(await errOf(await one.PATCH(body({ qty: 9 }), oneCtx))).toMatchObject({ status: 400, code: 'CREDIT_EXCEEDS' })
    expect((seen as Array<{ id: string; qty: unknown; unit: string }>).map(r => ({ ...r, qty: Number(r.qty) })))
      .toEqual([{ id: 'b1', qty: 9, unit: 'kg' }, { id: 'b2', qty: 1, unit: 'kg' }])
    expect(db.recipeByproduct.update).not.toHaveBeenCalled()
  })

  it('PATCH saves and resyncs', async () => {
    const res = await one.PATCH(body({ qty: 3, unit: 'lb' }), oneCtx)
    expect(res.status).toBe(200)
    expect(db.recipeByproduct.update.mock.calls[0][0]).toMatchObject({ where: { id: 'b1' }, data: { qty: 3, unit: 'lb' } })
    expect(resyncPrepRecipe).toHaveBeenCalledWith('r1')
  })

  it('PATCH and DELETE 404 on a row from another recipe', async () => {
    db.recipeByproduct.findUnique.mockResolvedValue({ id: 'b1', recipeId: 'other', qty: 2, unit: 'kg', inventoryItemId: 'trim' })
    expect((await one.PATCH(body({ qty: 3 }), oneCtx)).status).toBe(404)
    expect((await one.DELETE(body({}), oneCtx)).status).toBe(404)
  })

  it('DELETE never trips the guard', async () => {
    const res = await one.DELETE(body({}), oneCtx)
    expect(res.status).toBe(200)
    expect(db.recipeByproduct.delete).toHaveBeenCalledWith({ where: { id: 'b1' } })
    expect(fetchRecipeWithCost.mock.calls.every(c => !c[1]?.editByproducts)).toBe(true)
    expect(resyncPrepRecipe).toHaveBeenCalledWith('r1')
  })

  it.each(['STAFF', 'LEAD'] as const)('PATCH and DELETE refuse %s', async role => {
    h.role = role
    expect((await one.PATCH(body({ qty: 3 }), oneCtx)).status).toBe(403)
    expect((await one.DELETE(body({}), oneCtx)).status).toBe(403)
  })
})
