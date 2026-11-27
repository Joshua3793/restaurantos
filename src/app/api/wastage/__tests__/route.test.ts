import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Butter: 1 case = 11,350 g at $142.50 (LAST = $0.012555/g). One approved receipt in
// the window: $100 for 10,000 g (AVG = $0.01/g). Wasting 500 g must cost $5.00 on the
// average, not $6.28 on the last price.
const ITEM = {
  id: 'i1', itemName: 'Butter', dimension: 'MASS', baseUnit: 'g', countUnit: 'case',
  packChain: [{ unit: 'case', per: 11350 }], pricing: { mode: 'PACK', purchasePrice: 142.5 },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null, recipe: null,
}
// Bun: counted per each, no each-measure — a weight cannot be converted to buns.
const BUN = {
  id: 'bun', itemName: 'Bun', dimension: 'COUNT', baseUnit: 'each', countUnit: 'case',
  packChain: [{ unit: 'case', per: 48 }], pricing: { mode: 'PACK', purchasePrice: 36 },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null, recipe: null,
}
let current: typeof ITEM = ITEM
const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'w1', ...data, inventoryItem: ITEM }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    inventoryItem: { findUnique: async () => current, findMany: async () => [current] },
    invoiceScanItem: { findMany: async () => [{ matchedItemId: 'i1', rawLineTotal: '100', receivedQtyBase: '10000' }] },
    wastageLog: { create },
    cook: { findUnique: async () => null },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: async () => ({ id: 'u1', role: 'STAFF', isActive: true, name: 'Sam Lee', email: 'sam@fergies.test' }),
  AuthError: class extends Error { status = 401 },
}))
vi.mock('@/lib/rc-scope', () => ({ scopeWhereFromParams: async () => ({}), assertRcWritable: async () => {} }))
vi.mock('@/lib/theoretical-cache', () => ({ invalidatesTheoretical: (h: unknown) => h }))

const route = await import('@/app/api/wastage/route')

describe('POST /api/wastage', () => {
  beforeEach(() => { create.mockClear(); current = ITEM })

  it('freezes costImpact on the 30-day average, not the last price', async () => {
    const req = { url: 'http://x/api/wastage', json: async () => ({
      inventoryItemId: 'i1', qtyWasted: '500', unit: 'g', reason: 'SPOILED', revenueCenterId: 'rc1',
    }) } as unknown as NextRequest
    const res = await route.POST(req)
    expect(res.status).toBe(201)
    const data = create.mock.calls[0][0].data
    expect(Number(data.costImpact)).toBeCloseTo(5.0, 6)
  })

  it('refuses a weight wastage of a per-each item with no bridge instead of costing it $0', async () => {
    current = BUN as unknown as typeof ITEM
    const req = { url: 'http://x/api/wastage', json: async () => ({
      inventoryItemId: 'bun', qtyWasted: '200', unit: 'g', reason: 'SPOILED', revenueCenterId: 'rc1',
    }) } as unknown as NextRequest
    const res = await route.POST(req)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/log it in each/)
    expect(create).not.toHaveBeenCalled()
  })

  it('records the signed-in person, never a typed name or "System"', async () => {
    const req = { url: 'http://x/api/wastage', json: async () => ({
      inventoryItemId: 'i1', qtyWasted: '500', unit: 'g', reason: 'SPOILED', revenueCenterId: 'rc1', loggedBy: 'Someone Else',
    }) } as unknown as NextRequest
    await route.POST(req)
    expect(create.mock.calls[0][0].data.loggedBy).toBe('Sam Lee')
  })

  it('keeps a picked day as that day, and dates a missing day by Pacific (not UTC)', async () => {
    const mk = (date?: string) => ({ url: 'http://x/api/wastage', json: async () => ({
      inventoryItemId: 'i1', qtyWasted: '500', unit: 'g', reason: 'SPOILED', revenueCenterId: 'rc1', ...(date ? { date } : {}),
    }) } as unknown as NextRequest)
    await route.POST(mk('2026-11-26'))
    expect((create.mock.calls[0][0].data.date as Date).toISOString()).toBe('2026-11-26T00:00:00.000Z')
    vi.useFakeTimers()
    // 9pm Pacific on Nov 26 = 05:00 UTC Nov 27 — still the 26th in the kitchen.
    vi.setSystemTime(new Date('2026-11-27T05:00:00.000Z'))
    try {
      await route.POST(mk())
      expect((create.mock.calls[1][0].data.date as Date).toISOString()).toBe('2026-11-26T00:00:00.000Z')
    } finally { vi.useRealTimers() }
  })
})
