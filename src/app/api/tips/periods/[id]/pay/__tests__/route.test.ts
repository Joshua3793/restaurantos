import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const basePeriod = {
  id: 'p1', revenueCenterId: 'rc1', startDate: '2026-07-12', endDate: '2026-07-14', status: 'DRAFT',
}

const tipPeriodFindUnique = vi.fn(async () => basePeriod as typeof basePeriod | null)
const tipPeriodUpdate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...basePeriod, ...data }))
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'MANAGER', isActive: true, name: 'Jo Manager', email: 'jo@x.test' }))
const isRcInScope = vi.fn(async () => true)

type Built = {
  split: { people: unknown[]; poolTotal: number; distributedTotal: number }
  audit: { counts: { error: number }; findings: Array<{ severity: string; title: string }> }
  poolBasis: string; poolRatePct: number; roundingStepCents: number
  dayLabels: string[]; basis: number[]; sales: number[]; tips: Array<number | null>
  tipTotal: number; roles: unknown[]
}
const cleanBuild: Built = {
  split: { people: [{ cookId: 'c1', name: 'Ana', roleId: 'r1', roleName: 'Cook', multiplier: 1, dailyHourCap: 8 }], poolTotal: 100, distributedTotal: 100 },
  audit: { counts: { error: 0 }, findings: [] },
  poolBasis: 'NET_SALES', poolRatePct: 5, roundingStepCents: 100,
  dayLabels: ['Sun 12'], basis: [1000], sales: [1000], tips: [50], tipTotal: 50, roles: [],
}
const buildPeriodSplit = vi.fn(async (): Promise<Built | null> => cleanBuild)

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tipPeriod: {
      findUnique: (...a: unknown[]) => tipPeriodFindUnique(...(a as [])),
      update: (...a: unknown[]) => tipPeriodUpdate(...(a as [{ data: Record<string, unknown> }])),
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
vi.mock('@/lib/tips/build', () => ({
  buildPeriodSplit: (...a: unknown[]) => buildPeriodSplit(...(a as [])),
}))

const { POST } = await import('@/app/api/tips/periods/[id]/pay/route')
const { AuthError } = await import('@/lib/auth')

const req = (body: Record<string, unknown>) => ({ json: async () => body }) as unknown as NextRequest

beforeEach(() => {
  tipPeriodFindUnique.mockClear(); tipPeriodFindUnique.mockResolvedValue(basePeriod)
  tipPeriodUpdate.mockClear()
  requireSession.mockClear()
  requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true, name: 'Jo Manager', email: 'jo@x.test' })
  isRcInScope.mockClear(); isRcInScope.mockResolvedValue(true)
  buildPeriodSplit.mockClear(); buildPeriodSplit.mockResolvedValue(cleanBuild)
})

describe('POST /api/tips/periods/[id]/pay', () => {
  it('rejects an unauthenticated caller with 401 and never reaches the database', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await POST(req({}), { params: { id: 'p1' } })
    expect(res.status).toBe(401)
    expect(tipPeriodUpdate).not.toHaveBeenCalled()
    expect(buildPeriodSplit).not.toHaveBeenCalled()
  })

  it('rejects an out-of-scope period with 403', async () => {
    isRcInScope.mockResolvedValueOnce(false)
    const res = await POST(req({}), { params: { id: 'p1' } })
    expect(res.status).toBe(403)
    expect(tipPeriodUpdate).not.toHaveBeenCalled()
  })

  it('refuses to pay a period that has an unresolved error finding', async () => {
    buildPeriodSplit.mockResolvedValueOnce({
      ...cleanBuild,
      audit: { counts: { error: 2 }, findings: [{ severity: 'error', title: 'Two people are not on the roster' }, { severity: 'warn', title: 'noise' }] },
    })
    const res = await POST(req({}), { params: { id: 'p1' } })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.findings).toEqual(['Two people are not on the roster'])
    expect(tipPeriodUpdate).not.toHaveBeenCalled()
  })

  it('refuses to pay a period that is already PAID', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce({ ...basePeriod, status: 'PAID' })
    const res = await POST(req({}), { params: { id: 'p1' } })
    expect(res.status).toBe(409)
    expect(buildPeriodSplit).not.toHaveBeenCalled()
    expect(tipPeriodUpdate).not.toHaveBeenCalled()
  })

  it('freezes a clean period, writing status PAID and a snapshot with the resolved per-person split', async () => {
    const res = await POST(req({}), { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe('PAID')
    expect(tipPeriodUpdate).toHaveBeenCalledTimes(1)
    const data = tipPeriodUpdate.mock.calls[0][0].data as Record<string, unknown>
    expect(data.status).toBe('PAID')
    expect(data.paidByName).toBe('Jo Manager')
    const snapshot = data.snapshot as { split: Built['split']; audit: Built['audit'] }
    expect(snapshot.split.people).toEqual(cleanBuild.split.people)
    // Per-person resolved cap + role must be reconstructable from the frozen split.
    expect((snapshot.split.people[0] as Record<string, unknown>)).toMatchObject({ dailyHourCap: 8, roleName: 'Cook', multiplier: 1 })
    expect(snapshot.audit).toEqual(cleanBuild.audit)
  })

  it('refuses to reopen a period that is not PAID', async () => {
    const res = await POST(req({ reopen: true }), { params: { id: 'p1' } })
    expect(res.status).toBe(409)
    expect(tipPeriodUpdate).not.toHaveBeenCalled()
  })

  it('reopens a PAID period back to DRAFT', async () => {
    tipPeriodFindUnique.mockResolvedValueOnce({ ...basePeriod, status: 'PAID' })
    const res = await POST(req({ reopen: true }), { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe('DRAFT')
    const data = tipPeriodUpdate.mock.calls[0][0].data as Record<string, unknown>
    expect(data.status).toBe('DRAFT')
    expect(data.paidAt).toBeNull()
  })
})
