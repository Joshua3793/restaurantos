import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const requireSession = vi.fn(async (_min?: string) => ({ id: 'u9', name: 'Lena', email: 'l@x.ca', role: 'LEAD', isActive: true }))
const isRcInScope = vi.fn(async (..._a: unknown[]) => true)
const stationFindMany = vi.fn()
const runFindMany = vi.fn()
const lineFindMany = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    checklistStation: { findMany: (...a: unknown[]) => stationFindMany(...a) },
    checklistRun: { findMany: (...a: unknown[]) => runFindMany(...a) },
    checklistRunLine: { findMany: (...a: unknown[]) => lineFindMany(...a) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [string?])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({ isRcInScope: (...a: unknown[]) => isRcInScope(...a) }))
vi.mock('@/lib/checklists/rules', async orig => ({
  ...(await orig<typeof import('@/lib/checklists/rules')>()),
  shiftBusinessDate: () => '2026-10-29',
}))

const { GET } = await import('@/app/api/checklists/today/route')

const get = (qs: string) => GET({ nextUrl: new URL('http://x/api/checklists/today?' + qs) } as unknown as NextRequest)

const st = (id: string, name: string, isShared = false) => ({ id, name, color: '#111', isShared })

beforeEach(() => {
  vi.clearAllMocks()
  isRcInScope.mockResolvedValue(true)
  stationFindMany.mockResolvedValue([st('s1', 'Grill'), st('s2', 'Pastry'), st('s3', 'Whole kitchen', true)])
  runFindMany.mockResolvedValue([])
  lineFindMany.mockResolvedValue([])
})

describe('GET /api/checklists/today', () => {
  it('needs a LEAD session and an rcId', async () => {
    expect((await get('phase=OPEN')).status).toBe(400)
    await get('rcId=rc1&phase=OPEN')
    expect(requireSession).toHaveBeenCalledWith('LEAD')
  })

  it('403 when the kitchen is outside scope, before reading anything', async () => {
    isRcInScope.mockResolvedValue(false)
    const res = await get('rcId=rc1&phase=OPEN')
    expect(res.status).toBe(403)
    expect(stationFindMany).not.toHaveBeenCalled()
  })

  it('a station with no run is NOT STARTED, with no writes (read-only mocks only)', async () => {
    const body = await (await get('rcId=rc1&phase=OPEN')).json()
    expect(body.businessDate).toBe('2026-10-29')
    expect(body.stations.map((s: { name: string }) => s.name)).toEqual(['Grill', 'Pastry', 'Whole kitchen'])
    expect(body.stations[0]).toMatchObject({ crew: [], handled: 0, total: 0, status: { label: 'NOT STARTED', tone: 'red' } })
  })

  it('reads flags for the last 7 business dates, both phases, open only', async () => {
    await get('rcId=rc1&phase=CLOSE')
    const arg = lineFindMany.mock.calls[0][0]
    expect(arg.where).toEqual({
      status: 'FLAGGED',
      resolvedAt: null,
      run: { businessDate: { gte: '2026-10-23' }, station: { revenueCenterId: 'rc1' } },
    })
    expect(arg.where.run).not.toHaveProperty('phase')
  })

  it('reads the run for the requested phase and day', async () => {
    await get('rcId=rc1&phase=CLOSE')
    expect(runFindMany.mock.calls[0][0].where).toMatchObject({ phase: 'CLOSE', businessDate: '2026-10-29' })
  })

  it('sorts needs-attention first, and a fixed flag no longer shows as a problem', async () => {
    runFindMany.mockResolvedValue([
      {
        stationId: 's1', status: 'SIGNED', signedOffByName: 'Sam', signedOffAt: new Date('2026-10-29T14:48:00Z'),
        crew: [{ userName: 'Sam' }],
        lines: [{ id: 'a', title: 'x', status: 'DONE', isBlocker: true, doneByName: 'Sam', resolvedAt: null }],
      },
      {
        stationId: 's2', status: 'OPEN', signedOffByName: null, signedOffAt: null,
        crew: [{ userName: 'Ana' }],
        lines: [
          { id: 'b', title: 'Mixer guard', status: 'FLAGGED', isBlocker: false, doneByName: 'Ana', resolvedAt: new Date() },
          { id: 'c', title: 'Wipe', status: 'TODO', isBlocker: false, doneByName: null, resolvedAt: null },
        ],
      },
    ])
    lineFindMany.mockResolvedValue([{
      id: 'f1', title: 'Fridge 2', flagReason: 'OUT_OF_RANGE', flagNote: null, value: '9.5', unit: '°C',
      doneByName: 'Ana', doneAt: new Date('2026-10-29T14:31:00Z'), run: { station: { name: 'Pastry' } },
    }])
    const body = await (await get('rcId=rc1&phase=OPEN')).json()
    expect(body.stations.map((s: { name: string; status: { label: string } }) => [s.name, s.status.label])).toEqual([
      ['Whole kitchen', 'NOT STARTED'],
      ['Grill', 'DONE'],
      ['Pastry', 'IN PROGRESS'],
    ])
    expect(body.flags).toEqual([expect.objectContaining({
      lineId: 'f1', stationName: 'Pastry', title: 'Fridge 2', reason: 'OUT_OF_RANGE', value: 9.5, unit: '°C', byName: 'Ana',
    })])
    const pastry = body.stations.find((s: { name: string }) => s.name === 'Pastry')
    expect(pastry.handled).toBe(1)
    expect(pastry.lines[0]).toMatchObject({ id: 'b', fixed: true })
  })
})
