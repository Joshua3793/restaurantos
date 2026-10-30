import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const requireSession = vi.fn(async () => ({ id: 'u1', name: 'Sam Lee', email: 'sam@x.ca', role: 'STAFF', isActive: true }))
const assertRcWritable = vi.fn(async () => {})
const stationFindMany = vi.fn()
const crewUpsert = vi.fn(async (a: unknown) => a)
const crewDeleteMany = vi.fn(async (a: unknown) => a)
const ensureRun = vi.fn(async (stationId: string) => ({ id: `run-${stationId}`, created: false }))
const buildCookView = vi.fn(async () => ({ phase: 'OPEN', stations: [] }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    checklistStation: { findMany: (...a: unknown[]) => stationFindMany(...a) },
    checklistRunCrew: {
      upsert: (...a: unknown[]) => crewUpsert(...a),
      deleteMany: (...a: unknown[]) => crewDeleteMany(...a),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  assertRcWritable: (...a: unknown[]) => assertRcWritable(...(a as [])),
}))
vi.mock('@/lib/checklists/runs', () => ({
  ensureRun: (...a: unknown[]) => ensureRun(...(a as [string])),
}))
vi.mock('@/lib/checklists/cook-view', () => ({
  buildCookView: (...a: unknown[]) => buildCookView(...(a as [])),
  whoOf: (u: { id: string; name: string | null; email: string }) => ({ id: u.id, name: u.name ?? u.email }),
}))

const { shiftBusinessDate } = await import('@/lib/checklists/rules')
const { POST } = await import('@/app/api/checklists/pick/route')

const call = (body: unknown) => POST({ json: async () => body } as unknown as NextRequest)

beforeEach(() => {
  vi.clearAllMocks()
  stationFindMany.mockImplementation(async (a: { where: { id: { in: string[] } } }) => a.where.id.in.map(id => ({ id })))
})

describe('POST /api/checklists/pick', () => {
  it('400 "Pick one or two stations" for three, none, or a missing list', async () => {
    for (const ids of [['a', 'b', 'c'], [], undefined]) {
      const res = await call({ rcId: 'rc1', phase: 'OPEN', stationIds: ids })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('Pick one or two stations')
    }
    expect(crewUpsert).not.toHaveBeenCalled()
  })

  it('400 "Pick opening or closing" for a bad or missing phase', async () => {
    for (const phase of ['LUNCH', undefined]) {
      const res = await call({ rcId: 'rc1', phase, stationIds: ['a'] })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('Pick opening or closing')
    }
    expect(crewUpsert).not.toHaveBeenCalled()
  })

  it('400 "rcId required"', async () => {
    const res = await call({ phase: 'OPEN', stationIds: ['a'] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('rcId required')
  })

  it('400 "Unknown station" when an id is not an active non-shared station of the kitchen', async () => {
    stationFindMany.mockResolvedValue([{ id: 'a' }])
    const res = await call({ rcId: 'rc1', phase: 'OPEN', stationIds: ['a', 'zzz'] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Unknown station')
    expect(crewUpsert).not.toHaveBeenCalled()
  })

  it('403 when the kitchen is out of scope', async () => {
    assertRcWritable.mockRejectedValueOnce(new MockAuthError(403, 'no'))
    const res = await call({ rcId: 'rc1', phase: 'OPEN', stationIds: ['a'] })
    expect(res.status).toBe(403)
    expect(crewUpsert).not.toHaveBeenCalled()
  })

  it('joins the crew of each pick and leaves the rest', async () => {
    const res = await call({ rcId: 'rc1', phase: 'CLOSE', stationIds: ['a', 'b', 'a'] })
    expect(res.status).toBe(200)
    expect(crewUpsert).toHaveBeenCalledTimes(2)
    expect(ensureRun).toHaveBeenCalledWith('a', 'CLOSE', shiftBusinessDate('CLOSE'))
    expect(crewUpsert.mock.calls[0][0]).toMatchObject({
      where: { runId_userId: { runId: 'run-a', userId: 'u1' } },
      create: { runId: 'run-a', userId: 'u1', userName: 'Sam Lee' },
    })
    expect(crewDeleteMany.mock.calls[0][0].where).toMatchObject({
      userId: 'u1',
      run: { phase: 'CLOSE', businessDate: shiftBusinessDate('CLOSE'), station: { revenueCenterId: 'rc1', id: { notIn: ['a', 'b'] } } },
    })
    expect(buildCookView).toHaveBeenCalled()
  })
})
