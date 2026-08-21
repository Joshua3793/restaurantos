import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same vi.mock-of-Prisma pattern as src/app/api/tips/roster/__tests__/route.test.ts.
const cookFindUnique = vi.fn()
const periodFindMany = vi.fn()
const requireSession = vi.fn()

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    cook: { findUnique: (...a: unknown[]) => cookFindUnique(...(a as [])) },
    tipPeriod: { findMany: (...a: unknown[]) => periodFindMany(...(a as [])) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@prisma/client', () => ({ Prisma: { JsonNull: null } }))

const { GET } = await import('@/app/api/tips/me/route')

const splitPerson = (cookId: string, tip: number, name: string) => ({
  cookId, name, lastName: 'X', clockId: '1', wage: 20, roleId: 'r1',
  onPool: true, dailyHourCap: 9, hours: [8], boosts: [1], edited: [false],
  multiplier: 1.25, roleName: 'Line Cook', hoursTotal: 8, weighted: 10,
  daily: [tip], tip, envelopeCents: Math.round(tip) * 100,
})

const snapshot = (people: ReturnType<typeof splitPerson>[]) => ({
  version: 1,
  current: {
    seq: 1, paidAt: '2026-08-18T17:00:00.000Z', paidByName: 'Alex',
    poolBasis: 'NET_SALES', poolRatePct: 5, roundingStepCents: 100,
    dayLabels: ['Mon 4'], basis: [4000], sales: [4000], tips: [700],
    tipTotal: 700, roles: [],
    split: {
      pools: [200], poolTotal: 200, distributedTotal: 200,
      weightedByDay: [10], crewByDay: [2], people,
      hoursTotal: 16, weightedTotal: 20, envelopeTotalCents: 20000,
    },
    audit: { findings: [] },
  },
  history: [], trimmed: 0,
})

beforeEach(() => {
  vi.clearAllMocks()
  requireSession.mockResolvedValue({ id: 'u1', name: 'Sam', role: 'STAFF', isActive: true })
  cookFindUnique.mockResolvedValue(null)
  periodFindMany.mockResolvedValue([])
})

describe('GET /api/tips/me', () => {
  it('is reachable by a STAFF user — no minRole is passed to requireSession', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(requireSession).toHaveBeenCalledWith()
  })

  it('reports linked: false for a user with no roster row, with status 200', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ linked: false })
  })

  it('reports an empty payout list for a linked cook who has never been paid', async () => {
    cookFindUnique.mockResolvedValue({ id: 'cook-1', name: 'Sam' })
    const res = await GET()
    expect(await res.json()).toEqual({ linked: true, name: 'Sam', payouts: [] })
  })

  it('returns only the caller’s own figures, never another cook’s', async () => {
    cookFindUnique.mockResolvedValue({ id: 'cook-1', name: 'Sam' })
    periodFindMany.mockResolvedValue([{
      id: 'p1', startDate: '2026-08-04', endDate: '2026-08-17',
      snapshot: snapshot([splitPerson('cook-1', 140.5, 'Sam'), splitPerson('cook-2', 999.99, 'Kim')]),
    }])
    const res = await GET()
    const body = await res.json()
    expect(body.payouts).toHaveLength(1)
    expect(body.payouts[0].tip).toBe(140.5)
    const json = JSON.stringify(body)
    expect(json).not.toContain('999.99')
    expect(json).not.toContain('Kim')
    expect(json).not.toContain('poolTotal')
  })

  it('drops periods the caller was not paid in rather than emitting a zero row', async () => {
    cookFindUnique.mockResolvedValue({ id: 'cook-1', name: 'Sam' })
    periodFindMany.mockResolvedValue([
      { id: 'p1', startDate: '2026-08-04', endDate: '2026-08-17', snapshot: snapshot([splitPerson('cook-2', 50, 'Kim')]) },
      { id: 'p2', startDate: '2026-07-21', endDate: '2026-08-03', snapshot: snapshot([splitPerson('cook-1', 120, 'Sam')]) },
    ])
    const body = await (await GET()).json()
    expect(body.payouts).toHaveLength(1)
    expect(body.payouts[0].periodId).toBe('p2')
  })

  it('sets no-store so a payout is never served from cache', async () => {
    const res = await GET()
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('returns 401 when there is no session', async () => {
    requireSession.mockRejectedValue(new MockAuthError(401, 'Unauthorized'))
    const res = await GET()
    expect(res.status).toBe(401)
  })
})
