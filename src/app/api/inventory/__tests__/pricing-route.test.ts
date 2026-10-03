import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { ROLE_RANK } from '@/lib/roles'

// PATCH /api/inventory/[id]/pricing — the item's own measure, pack and price,
// under the Stage 2a edit rules: R3 a box-less item only (with a box the price
// lives on the box), R4 the measure is locked by history, R5 a stocked item is
// never $0, plus R6 recipe-owned and R8 two-people-editing.

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
let offerCount = 0
let countLineCount = 0

const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...ITEM, ...data }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    inventoryItem: { findUnique: async () => ITEM, update: (a: { data: Record<string, unknown> }) => update(a) },
    recipe: { findFirst: async () => null, findMany: async () => [] },
    inventorySupplierPrice: { count: async () => offerCount, findFirst: async () => null },
    countLine: { count: async () => countLineCount },
    inventorySnapshot: { count: async () => 0 },
    invoiceScanItem: { count: async () => 0 },
    recipeIngredient: { count: async () => 0, findMany: async () => [] },
    wastageLog: { count: async () => 0 },
    stockTransfer: { count: async () => 0 },
  },
}))
const propagatePrepCostChanges = vi.fn(async () => [])
vi.mock('@/lib/recipeCosts', () => ({
  syncPrepToInventory: async () => {},
  propagatePrepCostChanges: (...a: unknown[]) => propagatePrepCostChanges(...(a as [])),
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

const pricing = await import('@/app/api/inventory/[id]/pricing/route')

const ctx = { params: { id: 'i1' } }
const patchReq = (body: unknown) =>
  ({ url: 'http://x/api/inventory/i1/pricing', json: async () => body }) as unknown as NextRequest
const VALID = {
  packChain: [{ unit: 'case', per: 10000 }],
  pricing: { mode: 'PACK', purchasePrice: 130 },
  expectedLastUpdated: NOW.toISOString(),
}

beforeEach(() => { update.mockClear(); propagatePrepCostChanges.mockClear() })
afterEach(() => { ITEM = { ...BASE_ITEM }; offerCount = 0; countLineCount = 0 })

describe('PATCH /api/inventory/[id]/pricing', () => {
  it('writes the chain and pricing of a box-less item', async () => {
    const res = await pricing.PATCH(patchReq(VALID), ctx)
    expect(res.status).toBe(200)
    const data = update.mock.calls[0][0].data
    expect(data).toMatchObject({
      dimension: 'MASS', baseUnit: 'g', packChain: VALID.packChain, pricing: VALID.pricing, countUnit: 'case',
    })
    expect(data.lastUpdated).toBeInstanceOf(Date)
    expect(propagatePrepCostChanges).toHaveBeenCalledWith(['i1'])
  })

  it('R3 — refuses an item with a supplier box (HAS_OFFERS)', async () => {
    offerCount = 1
    const res = await pricing.PATCH(patchReq(VALID), ctx)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('HAS_OFFERS')
    expect(body.error).toBe("This item's price lives on its supplier box. Edit the box instead.")
    expect(update).not.toHaveBeenCalled()
  })

  it('R4 — refuses a measure change once the item has a count (DIMENSION_LOCKED)', async () => {
    countLineCount = 1
    const res = await pricing.PATCH(patchReq({
      ...VALID, dimension: 'COUNT', packChain: [{ unit: 'case', per: 24 }], countUnit: 'case',
    }), ctx)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('DIMENSION_LOCKED')
    expect(body.error).toBe("This item already has counts, deliveries or recipes in its current measure. Use 'Change how it's measured' to convert them together.")
    expect(update).not.toHaveBeenCalled()
  })

  it('R4 — allows a measure change with no history and no boxes', async () => {
    const res = await pricing.PATCH(patchReq({
      ...VALID, dimension: 'COUNT', packChain: [{ unit: 'case', per: 24 }], countUnit: 'case',
    }), ctx)
    expect(res.status).toBe(200)
    expect(update.mock.calls[0][0].data).toMatchObject({ dimension: 'COUNT', baseUnit: 'each' })
  })

  it('R5 — refuses $0 on a stocked item (ZERO_PRICE)', async () => {
    const res = await pricing.PATCH(patchReq({ ...VALID, pricing: { mode: 'PACK', purchasePrice: 0 } }), ctx)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('ZERO_PRICE')
    expect(body.error).toBe('A stocked item needs a price above $0.')
    expect(update).not.toHaveBeenCalled()
  })

  it('R5 — allows $0 on a non-stocked item', async () => {
    ITEM = { ...BASE_ITEM, isStocked: false }
    const res = await pricing.PATCH(patchReq({ ...VALID, pricing: { mode: 'PACK', purchasePrice: 0 } }), ctx)
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalled()
  })

  it('R6 — refuses a recipe-made item (PREP_OWNED)', async () => {
    ITEM = { ...BASE_ITEM, recipe: { id: 'r1', name: 'Bacon Jam' } }
    const res = await pricing.PATCH(patchReq(VALID), ctx)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('PREP_OWNED')
    expect(body.error).toBe('This item\'s price comes from its recipe "Bacon Jam".')
    expect(update).not.toHaveBeenCalled()
  })

  it('R8 — refuses a stale save (STALE)', async () => {
    const res = await pricing.PATCH(patchReq({ ...VALID, expectedLastUpdated: '2026-10-03T09:00:00.000Z' }), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('STALE')
    expect(update).not.toHaveBeenCalled()
  })
})
