import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { ROLE_RANK } from '@/lib/roles'

// The item edit route (PUT /api/inventory/[id]) under the Stage 2a edit rules:
// R1 an allow-list (no mass assignment), R6 recipe-owned fields, R7 a dry run
// that names the recipes a bridge removal would break, R8 optimistic concurrency.

type Role = keyof typeof ROLE_RANK

const NOW = new Date('2026-10-03T10:00:00.000Z')
const BASE_ITEM = {
  id: 'i1', itemName: 'Butter', category: 'DAIRY', baseUnit: 'g', dimension: 'MASS', countUnit: 'case',
  packChain: [{ unit: 'case', per: 11350 }], pricing: { mode: 'PACK', purchasePrice: 142.5 },
  eachMeasureQty: null as number | null, eachMeasureUnit: null as string | null, densityGPerMl: null,
  allergens: ['MLK'], mergedIntoId: null, lastUpdated: NOW, recipe: null as null | { id: string; name: string },
  isStocked: true, supplierPrices: [],
}
let ITEM = { ...BASE_ITEM }
let recipeLines: { unit: string; recipe: { id: string; name: string; type: string } }[] = []

const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...ITEM, ...data }))
let updateCount = 1
const updateMany = vi.fn(async (a: { data: Record<string, unknown> }) => { await update(a); return { count: updateCount } })
vi.mock('@/lib/prisma', () => ({
  prisma: {
    inventoryItem: { findUnique: async () => ITEM, updateMany: (a: { data: Record<string, unknown> }) => updateMany(a) },
    recipe: { findFirst: async () => null, findMany: async () => [] },
    inventorySupplierPrice: { count: async () => 0, findFirst: async () => null },
    countLine: { count: async () => 0 },
    inventorySnapshot: { count: async () => 0 },
    invoiceScanItem: { count: async () => 0 },
    recipeIngredient: { count: async () => 0, findMany: async () => recipeLines },
    wastageLog: { count: async () => 0 },
    stockTransfer: { count: async () => 0 },
  },
}))
vi.mock('@/lib/recipeCosts', () => ({ syncPrepToInventory: async () => {}, propagatePrepCostChanges: async () => [] }))
vi.mock('@/lib/cost-basis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cost-basis')>()),
  windowedAvgCost: async () => new Map(),
}))

const currentRole: Role = 'MANAGER'
class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError' }
}
const requireSession = vi.fn(async (min?: Role) => {
  if (min && ROLE_RANK[currentRole] < ROLE_RANK[min]) throw new MockAuthError(403, 'Forbidden')
  return { id: 'u1', role: currentRole, isActive: true }
})
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [Role?])),
  AuthError: MockAuthError,
}))

const item = await import('@/app/api/inventory/[id]/route')

const ctx = { params: { id: 'i1' } }
const putReq = (body: unknown, query = '') =>
  ({ url: `http://x/api/inventory/i1${query}`, json: async () => body }) as unknown as NextRequest
const getReq = (url = 'http://x/api/inventory/i1') =>
  ({ url, nextUrl: new URL(url) }) as unknown as NextRequest

beforeEach(() => { update.mockClear(); updateMany.mockClear(); updateCount = 1 })
afterEach(() => { ITEM = { ...BASE_ITEM }; recipeLines = [] })

describe('PUT /api/inventory/[id] — R1 allow-list', () => {
  it('refuses a key outside the allow-list', async () => {
    const res = await item.PUT(putReq({ itemName: 'Butter', stockOnHand: 5, expectedLastUpdated: NOW.toISOString() }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('BAD_FIELD')
    expect(update).not.toHaveBeenCalled()
  })

  it('ignores nothing silently: pricing/packChain/dimension are not accepted here', async () => {
    for (const body of [
      { pricing: { mode: 'PACK', purchasePrice: 1 } },
      { packChain: [{ unit: 'case', per: 1 }] },
      { dimension: 'COUNT' },
    ]) {
      const res = await item.PUT(putReq({ ...body, expectedLastUpdated: NOW.toISOString() }), ctx)
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('BAD_FIELD')
    }
    expect(update).not.toHaveBeenCalled()
  })

  it('writes only the allowed fields', async () => {
    const res = await item.PUT(putReq({ itemName: 'Butter Unsalted', barcode: '9', expectedLastUpdated: NOW.toISOString() }), ctx)
    expect(res.status).toBe(200)
    expect(Object.keys(update.mock.calls[0][0].data).sort()).toEqual(['barcode', 'itemName', 'lastUpdated'])
  })
})

describe('R8 — two people editing', () => {
  it('requires expectedLastUpdated', async () => {
    const res = await item.PUT(putReq({ itemName: 'x' }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('BAD_FIELD')
  })

  it('refuses a stale save with STALE', async () => {
    const res = await item.PUT(putReq({ itemName: 'x', expectedLastUpdated: '2026-10-03T09:00:00.000Z' }), ctx)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('STALE')
    expect(update).not.toHaveBeenCalled()
  })

  it('refuses with STALE when the write finds the item changed under it (read check passed)', async () => {
    updateCount = 0
    const res = await item.PUT(putReq({ itemName: 'x', expectedLastUpdated: NOW.toISOString() }), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('STALE')
  })

  it('an unparsable expectedLastUpdated is a 400', async () => {
    const res = await item.PUT(putReq({ itemName: 'x', expectedLastUpdated: 'not-a-date' }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('BAD_FIELD')
    expect(update).not.toHaveBeenCalled()
  })
})

describe('input hygiene and already-invalid items', () => {
  it("countUnit '' is a 400", async () => {
    const res = await item.PUT(putReq({ countUnit: '', expectedLastUpdated: NOW.toISOString() }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('BAD_FIELD')
    expect(update).not.toHaveBeenCalled()
  })

  it('an item with an already-invalid stored chain can still be renamed', async () => {
    ITEM = { ...BASE_ITEM, pricing: { mode: 'RATE', rate: 1, rateUnit: 'each' } as never }
    const res = await item.PUT(putReq({ itemName: 'Butter (block)', expectedLastUpdated: NOW.toISOString() }), ctx)
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalled()
  })

  it('a stored count-unit error is excused only while the count unit is left alone', async () => {
    ITEM = { ...BASE_ITEM, countUnit: 'bogus' }
    const keep = await item.PUT(putReq({ itemName: 'Butter (block)', expectedLastUpdated: NOW.toISOString() }), ctx)
    expect(keep.status).toBe(200)
    update.mockClear()
    const change = await item.PUT(putReq({ countUnit: 'tray', expectedLastUpdated: NOW.toISOString() }), ctx)
    expect(change.status).toBe(400)
    const body = await change.json()
    expect(body).toMatchObject({ error: "That change doesn't fit the item's pack format.", code: 'INVALID' })
    expect(body.details[0]).toMatch(/^countUnit/)
    expect(update).not.toHaveBeenCalled()
  })
})

describe('R6 — prep-owned fields', () => {
  it('refuses a name change on a recipe-made item', async () => {
    ITEM = { ...BASE_ITEM, recipe: { id: 'r1', name: 'Bacon Jam' } }
    const res = await item.PUT(putReq({ itemName: 'Other', expectedLastUpdated: NOW.toISOString() }), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('PREP_OWNED')
    expect(update).not.toHaveBeenCalled()
  })

  it('lets a recipe-made item save its other fields (same name sent back is not a change)', async () => {
    ITEM = { ...BASE_ITEM, recipe: { id: 'r1', name: 'Bacon Jam' } }
    const res = await item.PUT(putReq({ itemName: 'Butter', allergens: ['MLK'], barcode: '7', expectedLastUpdated: NOW.toISOString() }), ctx)
    expect(res.status).toBe(200)
  })
})

describe('R7 — bridge dry run', () => {
  it('reports the recipes that would lose their costing', async () => {
    // A COUNT item (each) bridged to 150 g per each; one MENU recipe uses it by
    // weight, one by the each — only the weight line costs through the bridge.
    ITEM = {
      ...BASE_ITEM, dimension: 'COUNT', baseUnit: 'each', countUnit: 'case',
      packChain: [{ unit: 'case', per: 24 }], eachMeasureQty: 150, eachMeasureUnit: 'g',
    }
    recipeLines = [
      { unit: 'g', recipe: { id: 'r1', name: 'Burger', type: 'MENU' } },
      { unit: 'each', recipe: { id: 'r2', name: 'Brunch Plate', type: 'MENU' } },
    ]
    const res = await item.PUT(putReq({ eachMeasureQty: null, expectedLastUpdated: NOW.toISOString() }, '?dryRun=1'), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.bridgeUsedBy).toEqual([{ id: 'r1', name: 'Burger', type: 'MENU' }])
    expect(update).not.toHaveBeenCalled()
  })

  it('a dry run that keeps the bridge names no recipes', async () => {
    ITEM = { ...BASE_ITEM, eachMeasureQty: 150, eachMeasureUnit: 'g' }
    recipeLines = [{ unit: 'each', recipe: { id: 'r1', name: 'Burger', type: 'MENU' } }]
    const res = await item.PUT(putReq({ barcode: '1', expectedLastUpdated: NOW.toISOString() }, '?dryRun=1'), ctx)
    expect(res.status).toBe(200)
    expect((await res.json()).bridgeUsedBy).toEqual([])
    expect(update).not.toHaveBeenCalled()
  })
})

describe('GET /api/inventory/[id] — the edit rules the drawer needs', () => {
  it('returns hasHistory, offerCount and bridgeUsedBy', async () => {
    const body = await (await item.GET(getReq(), ctx)).json()
    expect(body).toMatchObject({ hasHistory: false, offerCount: 0, bridgeUsedBy: [] })
  })
})
