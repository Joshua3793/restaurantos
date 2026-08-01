import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const basePeriod = {
  id: 'p1', revenueCenterId: 'rc1', startDate: '2026-07-12', endDate: '2026-07-14', status: 'DRAFT',
}

/**
 * Prisma-shaped mock args. Typed rather than left to inference because an
 * argument-less `vi.fn(async () => …)` types `mock.calls[n]` as the empty
 * tuple, and the assertions below read `mock.calls[0][0]`. Vitest 4 takes one
 * type argument — the whole function signature.
 */
type WhereArgs = { where: Record<string, unknown> }

const tipPeriodFindUnique = vi.fn(async () => basePeriod as typeof basePeriod | null)
const cookFindFirst = vi.fn<(args: WhereArgs) => Promise<{ id: string } | null>>(async () => ({ id: 'c1' }))
const adjustmentFindUnique = vi.fn(async () => null as { id: string; hours: number | null; boost: number } | null)
const adjustmentUpsert = vi.fn(async () => ({ id: 'a1' }))
const adjustmentDelete = vi.fn(async () => ({ id: 'a1' }))
const adjustmentDeleteMany = vi.fn<(args: WhereArgs) => Promise<{ count: number }>>(async () => ({ count: 0 }))
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'MANAGER', isActive: true }))
const isRcInScope = vi.fn(async () => true)
const loadSettings = vi.fn(async () => ({ periodDays: 3 }))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tipPeriod: { findUnique: (...a: unknown[]) => tipPeriodFindUnique(...(a as [])) },
    cook: { findFirst: (...a: unknown[]) => cookFindFirst(...(a as [WhereArgs])) },
    tipDayAdjustment: {
      findUnique: (...a: unknown[]) => adjustmentFindUnique(...(a as [])),
      upsert: (...a: unknown[]) => adjustmentUpsert(...(a as [])),
      delete: (...a: unknown[]) => adjustmentDelete(...(a as [])),
      deleteMany: (...a: unknown[]) => adjustmentDeleteMany(...(a as [WhereArgs])),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  isRcInScope: (...a: unknown[]) => isRcInScope(...(a as [])),
}))
vi.mock('@/lib/tips/settings', () => ({
  loadSettings: (...a: unknown[]) => loadSettings(...(a as [])),
}))

const { PUT, DELETE } = await import('@/app/api/tips/periods/[id]/adjustments/route')
const { AuthError } = await import('@/lib/auth')

const putReq = (body: Record<string, unknown>) => ({ json: async () => body }) as unknown as NextRequest
const delReq = (qs: string) => ({
  nextUrl: new URL(`http://x/api${qs}`),
}) as unknown as NextRequest

beforeEach(() => {
  tipPeriodFindUnique.mockClear(); tipPeriodFindUnique.mockResolvedValue(basePeriod)
  cookFindFirst.mockClear(); cookFindFirst.mockResolvedValue({ id: 'c1' })
  adjustmentFindUnique.mockClear(); adjustmentFindUnique.mockResolvedValue(null)
  adjustmentUpsert.mockClear()
  adjustmentDelete.mockClear()
  adjustmentDeleteMany.mockClear()
  requireSession.mockClear(); requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true })
  isRcInScope.mockClear(); isRcInScope.mockResolvedValue(true)
  loadSettings.mockClear(); loadSettings.mockResolvedValue({ periodDays: 3 })
})

describe('PUT /api/tips/periods/[id]/adjustments', () => {
  it('rejects an unauthenticated caller with 401 and never reaches the database', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await PUT(putReq({ cookId: 'c1', dayIndex: 0, hours: 6 }), { params: { id: 'p1' } })
    expect(res.status).toBe(401)
    expect(adjustmentUpsert).not.toHaveBeenCalled()
  })

  it('rejects an out-of-scope period with 403', async () => {
    isRcInScope.mockResolvedValueOnce(false)
    const res = await PUT(putReq({ cookId: 'c1', dayIndex: 0, hours: 6 }), { params: { id: 'p1' } })
    expect(res.status).toBe(403)
    expect(adjustmentUpsert).not.toHaveBeenCalled()
  })

  it('refuses to edit a PAID period', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce({ ...basePeriod, status: 'PAID' })
    const res = await PUT(putReq({ cookId: 'c1', dayIndex: 0, hours: 6 }), { params: { id: 'p1' } })
    expect(res.status).toBe(409)
    expect(adjustmentUpsert).not.toHaveBeenCalled()
  })

  it('rejects a missing cookId with 400', async () => {
    const res = await PUT(putReq({ dayIndex: 0, hours: 6 }), { params: { id: 'p1' } })
    expect(res.status).toBe(400)
  })

  it('rejects a dayIndex outside the period with 400', async () => {
    const res = await PUT(putReq({ cookId: 'c1', dayIndex: 9, hours: 6 }), { params: { id: 'p1' } })
    expect(res.status).toBe(400)
  })

  it(
    'bounds dayIndex by the PERIOD\'s own window, not the live TipSettings.periodDays — ' +
    'too small blocks a legitimate tail-of-period edit, too large stores an inert adjustment',
    async () => {
      // Stored window: 2026-07-01 → 07-14 (14 days). Live setting: 3.
      tipPeriodFindUnique.mockResolvedValue({ ...basePeriod, startDate: '2026-07-01', endDate: '2026-07-14' })
      loadSettings.mockResolvedValue({ periodDays: 3 })

      const ok = await PUT(putReq({ cookId: 'c1', dayIndex: 10, hours: 6 }), { params: { id: 'p1' } })
      expect(ok.status).toBe(200) // day 10 is real — a 3-day bound would 400 it
      const tooFar = await PUT(putReq({ cookId: 'c1', dayIndex: 14, hours: 6 }), { params: { id: 'p1' } })
      expect(tooFar.status).toBe(400) // day 14 is past the end; resolveRoster never loops there
      expect(loadSettings).not.toHaveBeenCalled()
    },
  )

  it('refuses an adjustment against a deactivated cook, which would store cleanly and then never apply', async () => {
    // build.ts and the payload route both resolve the roster from isActive
    // cooks only, so the isActive filter belongs in the WHERE, not nowhere.
    cookFindFirst.mockResolvedValueOnce(null)
    const res = await PUT(putReq({ cookId: 'c1', dayIndex: 0, hours: 6 }), { params: { id: 'p1' } })
    expect(res.status).toBe(400)
    expect(cookFindFirst.mock.calls[0][0]).toMatchObject({ where: { id: 'c1', isActive: true } })
    expect(adjustmentUpsert).not.toHaveBeenCalled()
  })

  it('rejects a cookId not on the roster with 400', async () => {
    cookFindFirst.mockResolvedValueOnce(null)
    const res = await PUT(putReq({ cookId: 'nope', dayIndex: 0, hours: 6 }), { params: { id: 'p1' } })
    expect(res.status).toBe(400)
    expect(adjustmentUpsert).not.toHaveBeenCalled()
  })

  it('rejects hours out of the 0–24 range', async () => {
    const res = await PUT(putReq({ cookId: 'c1', dayIndex: 0, hours: 30 }), { params: { id: 'p1' } })
    expect(res.status).toBe(400)
  })

  it('rejects a boost below 1 or above 5', async () => {
    const res = await PUT(putReq({ cookId: 'c1', dayIndex: 0, boost: 0.5 }), { params: { id: 'p1' } })
    expect(res.status).toBe(400)
  })

  it('deletes rather than stores a row that carries no information (hours null, boost 1)', async () => {
    adjustmentFindUnique.mockResolvedValueOnce({ id: 'a1', hours: 6, boost: 1 })
    const res = await PUT(putReq({ cookId: 'c1', dayIndex: 0, hours: null }), { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.cleared).toBe(true)
    expect(adjustmentDelete).toHaveBeenCalledTimes(1)
    expect(adjustmentUpsert).not.toHaveBeenCalled()
  })

  it('upserts a valid hours override', async () => {
    const res = await PUT(putReq({ cookId: 'c1', dayIndex: 1, hours: 7.5 }), { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    expect(adjustmentUpsert).toHaveBeenCalledTimes(1)
  })
})

describe('DELETE /api/tips/periods/[id]/adjustments', () => {
  it('rejects an unauthenticated caller with 401 and never reaches the database', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await DELETE(delReq('/adjustments'), { params: { id: 'p1' } })
    expect(res.status).toBe(401)
    expect(adjustmentDeleteMany).not.toHaveBeenCalled()
  })

  it('refuses to edit a PAID period', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce({ ...basePeriod, status: 'PAID' })
    const res = await DELETE(delReq('/adjustments'), { params: { id: 'p1' } })
    expect(res.status).toBe(409)
    expect(adjustmentDeleteMany).not.toHaveBeenCalled()
  })

  it('scopes the clear to one person when cookId is given', async () => {
    const res = await DELETE(delReq('/adjustments?cookId=c1'), { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    const where = adjustmentDeleteMany.mock.calls[0][0]
    expect(where.where).toMatchObject({ periodId: 'p1', cookId: 'c1' })
  })

  it('refuses a bare DELETE — clearing the whole period needs an explicit opt-in', async () => {
    // Every override and boost in the period is work somebody typed in; a
    // dropped query param must not silently wipe the lot.
    const res = await DELETE(delReq('/adjustments'), { params: { id: 'p1' } })
    expect(res.status).toBe(400)
    expect(adjustmentDeleteMany).not.toHaveBeenCalled()
  })

  it('clears every adjustment for the period when all=true is passed', async () => {
    const res = await DELETE(delReq('/adjustments?all=true'), { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    const where = adjustmentDeleteMany.mock.calls[0][0]
    expect(where.where).not.toHaveProperty('cookId')
  })
})
