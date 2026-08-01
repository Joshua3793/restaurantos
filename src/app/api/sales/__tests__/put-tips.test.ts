import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// The route talks to Prisma, the Toast overlap guard, auth and RC scope; all are
// stubbed so the test exercises ONLY the request→`data` mapping. No database is
// touched. `requireSession` is a vi.fn so individual tests can override it to
// simulate an unauthenticated caller.
// Typed with the ARG the route actually passes, not `() => …`: an argument-less
// mock types `mock.calls[n]` as the empty tuple, so `dataOf()` below cannot
// index it. Vitest 4 takes the whole function signature as vi.fn's one type
// argument (the Vitest 2 `<Args, Return>` pair is gone).
const update = vi.fn<(args: { where: unknown; data: Record<string, unknown> }) => Promise<{ id: string }>>(
  async () => ({ id: 's1' }),
)
const findUnique = vi.fn(async () => ({ source: 'manual' }))
const deleteMany = vi.fn(async () => ({ count: 0 }))
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'MANAGER', isActive: true }))
const assertRcWritable = vi.fn(async () => {})

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    salesEntry: {
      findUnique: (...a: unknown[]) => findUnique(...(a as [])),
      update: (...a: unknown[]) => update(...(a as [{ where: unknown; data: Record<string, unknown> }])),
    },
    saleLineItem: { deleteMany: (...a: unknown[]) => deleteMany(...(a as [])) },
  },
}))
vi.mock('@/lib/sales-guard', () => ({
  toastCoveredDays: async () => [],
  toastOverlapMessage: () => 'overlap',
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  isRcInScope: async () => true,
  assertRcWritable: (...a: unknown[]) => assertRcWritable(...(a as [])),
}))

const { PUT } = await import('@/app/api/sales/[id]/route')
const { AuthError } = await import('@/lib/auth')

const req = (body: Record<string, unknown>) => ({ json: async () => body }) as unknown as NextRequest
const base = { date: '2026-07-30', totalRevenue: '1000', foodSalesPct: '0.7', revenueCenterId: 'rc1' }
const dataOf = () => update.mock.calls[0][0].data

beforeEach(() => {
  update.mockClear(); findUnique.mockClear(); deleteMany.mockClear()
  requireSession.mockClear(); requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true })
  assertRcWritable.mockClear()
})

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

  it('rejects an unauthenticated caller with 401 and never reaches the update', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await PUT(req({ ...base, tipsCollected: '5' }), { params: { id: 's1' } })
    expect(res.status).toBe(401)
    expect(update).not.toHaveBeenCalled()
  })
})
