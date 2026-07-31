import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// The route talks to Prisma and the Toast overlap guard; both are stubbed so the
// test exercises ONLY the request→`data` mapping. No database is touched.
const update = vi.fn(async () => ({ id: 's1' }))
const findUnique = vi.fn(async () => ({ source: 'manual' }))
const deleteMany = vi.fn(async () => ({ count: 0 }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    salesEntry: { findUnique: (...a: unknown[]) => findUnique(...(a as [])), update: (...a: unknown[]) => update(...(a as [])) },
    saleLineItem: { deleteMany: (...a: unknown[]) => deleteMany(...(a as [])) },
  },
}))
vi.mock('@/lib/sales-guard', () => ({
  toastCoveredDays: async () => [],
  toastOverlapMessage: () => 'overlap',
}))

const { PUT } = await import('@/app/api/sales/[id]/route')

const req = (body: Record<string, unknown>) => ({ json: async () => body }) as unknown as NextRequest
const base = { date: '2026-07-30', totalRevenue: '1000', foodSalesPct: '0.7', revenueCenterId: 'rc1' }
const dataOf = () => update.mock.calls[0][0].data as Record<string, unknown>

beforeEach(() => { update.mockClear(); findUnique.mockClear(); deleteMany.mockClear() })

describe('PUT /api/sales/[id] — tipsCollected tri-state', () => {
  it('persists a typed tips figure', async () => {
    const res = await PUT(req({ ...base, tipsCollected: '412.55' }), { params: { id: 's1' } })
    expect(res.status).toBe(200)
    expect(dataOf().tipsCollected).toBe(412.55)
  })

  it('stores zero as zero, not as null', async () => {
    await PUT(req({ ...base, tipsCollected: 0 }), { params: { id: 's1' } })
    expect(dataOf().tipsCollected).toBe(0)
  })

  it('leaves the column untouched when the key is absent', async () => {
    await PUT(req({ ...base }), { params: { id: 's1' } })
    expect('tipsCollected' in dataOf()).toBe(false)
  })

  it('clears the column when sent empty', async () => {
    await PUT(req({ ...base, tipsCollected: '' }), { params: { id: 's1' } })
    expect(dataOf().tipsCollected).toBeNull()
  })

  it('clears the column when sent null', async () => {
    await PUT(req({ ...base, tipsCollected: null }), { params: { id: 's1' } })
    expect(dataOf().tipsCollected).toBeNull()
  })

  it('rejects a negative tip without writing', async () => {
    const res = await PUT(req({ ...base, tipsCollected: '-5' }), { params: { id: 's1' } })
    expect(res.status).toBe(400)
    expect(update).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric tip without writing', async () => {
    const res = await PUT(req({ ...base, tipsCollected: 'abc' }), { params: { id: 's1' } })
    expect(res.status).toBe(400)
    expect(update).not.toHaveBeenCalled()
  })

  it('rounds to the cent', async () => {
    await PUT(req({ ...base, tipsCollected: '10.007' }), { params: { id: 's1' } })
    expect(dataOf().tipsCollected).toBe(10.01)
  })
})
