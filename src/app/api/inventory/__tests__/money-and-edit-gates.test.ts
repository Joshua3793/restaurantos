import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { ROLE_RANK } from '@/lib/roles'

// Same vi.mock-of-Prisma pattern as src/app/api/count/sessions/__tests__/money-redaction.test.ts.
// Inventory routes are callable by every signed-in user (STAFF opens the item
// drawer from the count page): STAFF must get no prices, and below MANAGER the
// item is read-only — a save carrying a nulled price would overwrite the real one.

type Role = keyof typeof ROLE_RANK

const ITEM = {
  id: 'i1', itemName: 'Butter', category: 'DAIRY', baseUnit: 'g', dimension: 'MASS', countUnit: 'case',
  packChain: [{ unit: 'case', per: 11350 }], pricing: { mode: 'PACK', purchasePrice: 142.5 }, purchasePrice: '142.5',
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null, stockOnHand: '20000', barcode: '0123',
  supplier: { id: 's1', name: 'Gordon' }, storageArea: null, recipe: null,
  invoiceLineItems: [{ id: 'x', unitPrice: '142.5', lineTotal: '285', invoice: { totalAmount: '1903.22' } }],
  recipeIngredients: [],
}
const OFFER = {
  id: 'o1', supplierName: 'Gordon', supplierId: 's1', isPrimary: true, lastPrice: 142.5, pricePerBaseUnit: 0.01256,
  pricing: { mode: 'PACK', purchasePrice: 142.5 }, packChain: ITEM.packChain, supplierItemCode: 'B-1',
  volatility: 0.04, stability: 'stable', history: [{ date: '2026-09-01', ppb: 0.0125 }],
}
const MONEY = ['142.5', '0.01256', '0.0131', '285', '1903.22']

let currentRole: Role = 'STAFF'
const requireSession = vi.fn(async (min?: Role) => {
  if (min && ROLE_RANK[currentRole] < ROLE_RANK[min]) throw new MockAuthError(403, 'Forbidden')
  return { id: 'u1', role: currentRole, isActive: true }
})
class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError' }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    inventoryItem: {
      findUnique: async () => ITEM,
      findFirst: async () => ITEM,
      findMany: async () => [ITEM],
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [Role?])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/cost-basis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cost-basis')>()),
  windowedAvgCost: async () => new Map([['i1', { basis: 'AVG_30D', avg: { pricePerBase: 0.0131 } }]]),
}))
vi.mock('@/lib/supplier-offers', () => ({ getSupplierOffers: async () => [OFFER] }))

const item = await import('@/app/api/inventory/[id]/route')
const suppliers = await import('@/app/api/inventory/[id]/suppliers/route')
const search = await import('@/app/api/inventory/search/route')
const priceHistory = await import('@/app/api/inventory/[id]/price-history/route')
const create = await import('@/app/api/inventory/route')

const ctx = { params: { id: 'i1' } }
const getReq = (url = 'http://x/api/inventory/i1') =>
  ({ url, nextUrl: new URL(url) }) as unknown as NextRequest
const putReq = (body: unknown) =>
  ({ url: 'http://x/api/inventory/i1', json: async () => body }) as unknown as NextRequest

beforeEach(() => { currentRole = 'STAFF'; requireSession.mockClear() })

describe('inventory API — money', () => {
  it('GET /inventory/[id] sends STAFF no price, average cost or invoice line', async () => {
    const body = await (await item.GET(getReq(), ctx)).json()
    for (const v of MONEY) expect(JSON.stringify(body)).not.toContain(v)
    expect(body).toMatchObject({ pricing: null, purchasePrice: null, pricePerBaseUnit: null, costBasis: null, invoiceLineItems: [] })
    expect(body.packChain).toEqual(ITEM.packChain)
  })

  it.each(['LEAD', 'MANAGER'] as const)('GET /inventory/[id] still prices the item for %s', async role => {
    currentRole = role
    const body = await (await item.GET(getReq(), ctx)).json()
    expect(body.pricePerBaseUnit).toBeGreaterThan(0)
    expect(body.costBasis).not.toBeNull()
  })

  it('GET /inventory/[id]/suppliers sends STAFF the suppliers but not what they charge', async () => {
    const [o] = await (await suppliers.GET(getReq(), ctx)).json()
    expect(o).toMatchObject({ supplierName: 'Gordon', lastPrice: null, pricePerBaseUnit: null, history: [] })
  })

  it('GET /inventory/search (barcode scan on the count page) sends STAFF no price', async () => {
    const rows = await (await search.GET(getReq('http://x/api/inventory/search?barcode=0123'))).json()
    expect(rows[0]).toMatchObject({ id: 'i1', pricePerBaseUnit: null, purchasePrice: null, pricing: null })
  })

  it('price history is LEAD+', async () => {
    expect((await priceHistory.GET(getReq(), ctx)).status).toBe(403)
  })
})

describe('inventory API — edits are MANAGER+', () => {
  it.each(['STAFF', 'LEAD'] as const)('PUT and DELETE /inventory/[id] refuse %s', async role => {
    currentRole = role
    expect((await item.PUT(putReq({ packChain: ITEM.packChain, pricing: null }), ctx)).status).toBe(403)
    expect((await item.DELETE(getReq(), ctx)).status).toBe(403)
  })

  it('PUT /inventory/[id] lets a MANAGER through to validation', async () => {
    currentRole = 'MANAGER'
    // No packChain → the route's own 400, which proves the role gate passed.
    expect((await item.PUT(putReq({}), ctx)).status).toBe(400)
  })

  it('creating an item and switching the primary supplier refuse LEAD', async () => {
    currentRole = 'LEAD'
    expect((await create.POST(putReq({}))).status).toBe(403)
    expect((await suppliers.PATCH(putReq({ offerId: 'o1' }), ctx)).status).toBe(403)
  })
})
