import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// STAFF logs waste (it's on their home screen) but "never sees cost or money"
// (ROLE_DESCRIPTIONS). Same vi.mock-of-Prisma pattern as the inventory/count tests.

const ITEM = {
  id: 'i1', itemName: 'Butter', category: 'DAIRY', baseUnit: 'g', dimension: 'MASS', countUnit: 'case',
  packChain: [{ unit: 'case', per: 11350 }], pricing: { mode: 'PACK', purchasePrice: 142.5 }, purchasePrice: '142.5',
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
}
const LOG = { id: 'w1', inventoryItemId: 'i1', qtyWasted: '500', unit: 'g', reason: 'SPOILED', costImpact: '6.28', inventoryItem: ITEM }
const MONEY = ['6.28', '142.5']

let role = 'STAFF'
const requireSession = vi.fn(async () => ({ id: 'u1', role, isActive: true }))
class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError' }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    wastageLog: { findMany: async () => [LOG], create: async () => LOG },
    inventoryItem: { findUnique: async () => ITEM },
  },
}))
vi.mock('@/lib/auth', () => ({ requireSession: () => requireSession(), AuthError: MockAuthError }))
vi.mock('@/lib/rc-scope', () => ({ scopeWhereFromParams: async () => ({}), assertRcWritable: async () => undefined }))

const wastage = await import('@/app/api/wastage/route')
const getReq = { url: 'http://x/api/wastage' } as unknown as NextRequest
const postReq = {
  url: 'http://x/api/wastage',
  json: async () => ({ inventoryItemId: 'i1', qtyWasted: '500', unit: 'g', reason: 'SPOILED', revenueCenterId: 'rc1' }),
} as unknown as NextRequest

beforeEach(() => { role = 'STAFF' })

describe('wastage API money by role', () => {
  it('GET sends STAFF what was wasted, not what it cost', async () => {
    const [log] = await (await wastage.GET(getReq)).json()
    for (const v of MONEY) expect(JSON.stringify(log)).not.toContain(v)
    expect(log).toMatchObject({ costImpact: null, qtyWasted: '500', reason: 'SPOILED' })
    expect(log.inventoryItem).toMatchObject({ itemName: 'Butter', pricing: null, purchasePrice: null })
  })

  it('POST still lets STAFF log waste, and answers without the cost', async () => {
    const res = await wastage.POST(postReq)
    expect(res.status).toBe(201)
    expect((await res.json()).costImpact).toBeNull()
  })

  it('a LEAD still sees the cost', async () => {
    role = 'LEAD'
    const [log] = await (await wastage.GET(getReq)).json()
    expect(log.costImpact).toBe('6.28')
  })
})
