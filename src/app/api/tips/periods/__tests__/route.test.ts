import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Same vi.mock-of-Prisma pattern as src/app/api/tips/roster/__tests__/route.test.ts.
const tipPeriodFindMany = vi.fn(async () => [] as Array<{
  id: string; revenueCenterId: string; startDate: string; endDate: string
  status: string; paidAt: Date | null; paidByName: string | null
  revenueCenter: { name: string }
}>)
const tipPeriodFindUnique = vi.fn(async () => null as { id: string } | null)
const tipPeriodCreate = vi.fn(async () => ({ id: 'p-new' }))
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'MANAGER', isActive: true }))
const resolveScopedRcIds = vi.fn(async () => null as Set<string> | null)
const assertRcWritable = vi.fn(async () => {})
const loadSettings = vi.fn(async () => ({
  periodStartDow: 0, periodDays: 14, poolRevenueCenterId: 'rc1',
  poolBasis: 'NET_SALES', poolRatePct: 5, roundingStepCents: 100,
}))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tipPeriod: {
      findMany: (...a: unknown[]) => tipPeriodFindMany(...(a as [])),
      findUnique: (...a: unknown[]) => tipPeriodFindUnique(...(a as [])),
      create: (...a: unknown[]) => tipPeriodCreate(...(a as [])),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  resolveScopedRcIds: (...a: unknown[]) => resolveScopedRcIds(...(a as [])),
  assertRcWritable: (...a: unknown[]) => assertRcWritable(...(a as [])),
}))
vi.mock('@/lib/tips/settings', () => ({
  loadSettings: (...a: unknown[]) => loadSettings(...(a as [])),
}))

const { GET, POST } = await import('@/app/api/tips/periods/route')
const { AuthError } = await import('@/lib/auth')

const req = (body: Record<string, unknown>) => ({ json: async () => body }) as unknown as NextRequest

beforeEach(() => {
  tipPeriodFindMany.mockClear(); tipPeriodFindMany.mockResolvedValue([])
  tipPeriodFindUnique.mockClear(); tipPeriodFindUnique.mockResolvedValue(null)
  tipPeriodCreate.mockClear(); tipPeriodCreate.mockResolvedValue({ id: 'p-new' })
  requireSession.mockClear(); requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true })
  resolveScopedRcIds.mockClear(); resolveScopedRcIds.mockResolvedValue(null)
  assertRcWritable.mockClear()
  loadSettings.mockClear()
  loadSettings.mockResolvedValue({
    periodStartDow: 0, periodDays: 14, poolRevenueCenterId: 'rc1',
    poolBasis: 'NET_SALES', poolRatePct: 5, roundingStepCents: 100,
  })
})

describe('GET /api/tips/periods', () => {
  it('returns the period list and a computed defaultStartDate', async () => {
    tipPeriodFindMany.mockResolvedValueOnce([{
      id: 'p1', revenueCenterId: 'rc1', startDate: '2026-07-12', endDate: '2026-07-25',
      status: 'DRAFT', paidAt: null, paidByName: null, revenueCenter: { name: 'Kitchen' },
    }])
    const res = await GET()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.periods).toHaveLength(1)
    expect(json.periods[0]).toMatchObject({ id: 'p1', revenueCenterName: 'Kitchen', status: 'DRAFT' })
    expect(typeof json.defaultStartDate).toBe('string')
  })

  it('rejects an unauthenticated caller with 401 and never reaches the database', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await GET()
    expect(res.status).toBe(401)
    expect(tipPeriodFindMany).not.toHaveBeenCalled()
  })
})

describe('POST /api/tips/periods', () => {
  it('is idempotent — a period already open for (revenueCenterId, startDate) is returned as-is, not recreated', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce({ id: 'p-existing' })
    const res = await POST(req({ startDate: '2026-07-12', revenueCenterId: 'rc1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe('p-existing')
    expect(tipPeriodCreate).not.toHaveBeenCalled()
  })

  it('opens a new period with settings frozen onto it when none exists yet', async () => {
    const res = await POST(req({ startDate: '2026-07-12', revenueCenterId: 'rc1' }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.id).toBe('p-new')
    expect(tipPeriodCreate).toHaveBeenCalledTimes(1)
    const data = tipPeriodCreate.mock.calls[0][0].data as Record<string, unknown>
    expect(data.revenueCenterId).toBe('rc1')
    expect(data.startDate).toBe('2026-07-12')
    expect(data.endDate).toBe('2026-07-25')
    expect(data.poolBasis).toBe('NET_SALES')
  })

  it('rejects a malformed startDate with 400', async () => {
    const res = await POST(req({ startDate: 'not-a-date', revenueCenterId: 'rc1' }))
    expect(res.status).toBe(400)
    expect(tipPeriodCreate).not.toHaveBeenCalled()
  })

  it('rejects an out-of-scope revenue center via assertRcWritable', async () => {
    assertRcWritable.mockRejectedValueOnce(new AuthError(403, 'Revenue center is outside your access.'))
    const res = await POST(req({ startDate: '2026-07-12', revenueCenterId: 'rc-outside' }))
    expect(res.status).toBe(403)
    expect(tipPeriodCreate).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated caller with 401 and never reaches the database', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await POST(req({ startDate: '2026-07-12', revenueCenterId: 'rc1' }))
    expect(res.status).toBe(401)
    expect(tipPeriodCreate).not.toHaveBeenCalled()
  })
})
