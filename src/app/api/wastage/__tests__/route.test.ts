import { describe, it, expect, vi } from 'vitest'
import type { NextRequest } from 'next/server'

// Butter: 1 case = 11,350 g at $142.50 (LAST = $0.012555/g). One approved receipt in
// the window: $100 for 10,000 g (AVG = $0.01/g). Wasting 500 g must cost $5.00 on the
// average, not $6.28 on the last price.
const ITEM = {
  id: 'i1', itemName: 'Butter', dimension: 'MASS', baseUnit: 'g', countUnit: 'case',
  packChain: [{ unit: 'case', per: 11350 }], pricing: { mode: 'PACK', purchasePrice: 142.5 },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null, recipe: null,
}
const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'w1', ...data, inventoryItem: ITEM }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    inventoryItem: { findUnique: async () => ITEM, findMany: async () => [ITEM] },
    invoiceScanItem: { findMany: async () => [{ matchedItemId: 'i1', rawLineTotal: '100', receivedQtyBase: '10000' }] },
    wastageLog: { create },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: async () => ({ id: 'u1', role: 'STAFF', isActive: true }),
  AuthError: class extends Error { status = 401 },
}))
vi.mock('@/lib/rc-scope', () => ({ scopeWhereFromParams: async () => ({}), assertRcWritable: async () => {} }))
vi.mock('@/lib/theoretical-cache', () => ({ invalidatesTheoretical: (h: unknown) => h }))

const route = await import('@/app/api/wastage/route')

describe('POST /api/wastage', () => {
  it('freezes costImpact on the 30-day average, not the last price', async () => {
    const req = { url: 'http://x/api/wastage', json: async () => ({
      inventoryItemId: 'i1', qtyWasted: '500', unit: 'g', reason: 'SPOILED', revenueCenterId: 'rc1',
    }) } as unknown as NextRequest
    const res = await route.POST(req)
    expect(res.status).toBe(201)
    const data = create.mock.calls[0][0].data
    expect(Number(data.costImpact)).toBeCloseTo(5.0, 6)
  })
})
