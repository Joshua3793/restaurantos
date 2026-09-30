import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Same vi.mock-of-Prisma pattern as src/app/api/prep/cooks/__tests__/route.test.ts.
// The count routes are callable by every signed-in user; STAFF/LEAD "never see
// cost or money" (ROLE_DESCRIPTIONS), so what they RETURN is gated on role.

const ITEM = {
  id: 'i1', itemName: 'Butter', category: 'DAIRY', baseUnit: 'g', dimension: 'MASS',
  packChain: [{ unit: 'case', per: 11350 }], countUnit: 'case',
  pricing: { mode: 'PACK', purchasePrice: 142.5 }, purchasePrice: '142.5',
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  stockOnHand: '20000', lastCountQty: '18000', location: null, storageArea: { id: 'a1', name: 'Walk-in' },
}
const LINE = {
  id: 'l1', sessionId: 's1', inventoryItemId: 'i1', inventoryItem: ITEM,
  expectedQty: '20000', countedQty: '2', countedQtyBase: '22700', selectedUom: 'case', entries: null,
  skipped: false, carriedForward: false, noMovement: false,
  variancePct: '13.5', varianceCost: '33.91', priceAtCount: '0.01256', sortOrder: 0, notes: null,
}
const SESSION = {
  id: 's1', label: 'Full count', status: 'FINALIZED', type: 'FULL', revenueCenterId: null,
  totalCountedValue: '24945.95', lines: [LINE],
}

const findUnique = vi.fn(async () => SESSION)
const findMany = vi.fn(async () => [SESSION])
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'STAFF', isActive: true }))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError' }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    countSession: { findUnique: () => findUnique(), findMany: () => findMany() },
    stockAllocation: { findMany: async () => [] },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  isRcInScope: async () => true,
  assertRcWritable: async () => undefined,
  resolveScopedRcIds: async () => null,
  scopeWhereFromParams: async () => ({}),
}))

const detail = await import('@/app/api/count/sessions/[id]/route')
const list = await import('@/app/api/count/sessions/route')
const report = await import('@/app/api/count/sessions/[id]/report/route')

const req = { url: 'http://x/api/count/sessions' } as unknown as NextRequest
const ctx = { params: { id: 's1' } }
const MONEY = ['24945.95', '142.5', '0.01256', '33.91']

beforeEach(() => {
  requireSession.mockReset()
  requireSession.mockResolvedValue({ id: 'u1', role: 'STAFF', isActive: true })
})

describe('count API money by role', () => {
  it.each(['STAFF', 'LEAD'])('GET /sessions/[id] returns no price, value or $ variance to %s', async role => {
    requireSession.mockResolvedValue({ id: 'u1', role, isActive: true })
    const body = await (await detail.GET(req, ctx)).json()
    const json = JSON.stringify(body)
    for (const v of MONEY) expect(json).not.toContain(v)
    expect(body.totalCountedValue).toBeNull()
    const line = body.lines[0]
    expect(line).toMatchObject({ priceAtCount: null, varianceCost: null, countedQty: '2', selectedUom: 'case', variancePct: '13.5' })
    expect(line.inventoryItem).toMatchObject({ pricing: null, purchasePrice: null, pricePerBaseUnit: null })
    // What the count page converts through is untouched.
    expect(line.inventoryItem.packChain).toEqual(ITEM.packChain)
    expect(line.inventoryItem.baseUnit).toBe('g')
  })

  it('GET /sessions/[id] still gives a MANAGER the money', async () => {
    requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true })
    const body = await (await detail.GET(req, ctx)).json()
    expect(body.totalCountedValue).toBe('24945.95')
    expect(body.lines[0].priceAtCount).toBe('0.01256')
    expect(body.lines[0].inventoryItem.pricePerBaseUnit).toBeGreaterThan(0)
  })

  it('GET /sessions (list) hides totalCountedValue from STAFF', async () => {
    const [row] = await (await list.GET(req)).json()
    expect(row.totalCountedValue).toBeNull()
    expect(row.counts).toMatchObject({ total: 1, counted: 1 })
  })

  it('GET /sessions/[id]/report hides $ from STAFF and refuses an anonymous caller', async () => {
    const body = await (await report.GET(req, ctx)).json()
    for (const v of MONEY) expect(JSON.stringify(body)).not.toContain(v)
    expect(body.summary).toMatchObject({ totalValue: null, totalVarianceCost: null, itemsCounted: 1 })

    requireSession.mockRejectedValue(new MockAuthError(401, 'Unauthorized'))
    expect((await report.GET(req, ctx)).status).toBe(401)
  })
})
