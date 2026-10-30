import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const requireSession = vi.fn(async (_min?: string) => ({ id: 'm1', name: 'Mo', email: 'm@x.ca', role: 'MANAGER', isActive: true }))
const isRcInScope = vi.fn(async (..._a: unknown[]) => true)
const runFindMany = vi.fn()
const stationFindMany = vi.fn()
const crewFindMany = vi.fn()
const lineFindUnique = vi.fn()
const lineFindFirst = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    checklistStation: { findMany: (...a: unknown[]) => stationFindMany(...a) },
    checklistRun: { findMany: (...a: unknown[]) => runFindMany(...a) },
    checklistRunCrew: { findMany: (...a: unknown[]) => crewFindMany(...a) },
    checklistRunLine: {
      findUnique: (...a: unknown[]) => lineFindUnique(...a),
      findFirst: (...a: unknown[]) => lineFindFirst(...a),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [string?])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({ isRcInScope: (...a: unknown[]) => isRcInScope(...a) }))
vi.mock('@/lib/checklists/rules', async orig => ({
  ...(await orig<typeof import('@/lib/checklists/rules')>()),
  shiftBusinessDate: () => '2026-10-28',
}))

const { GET: history } = await import('@/app/api/checklists/history/route')
const { GET: people } = await import('@/app/api/checklists/history/people/route')
const { GET: last } = await import('@/app/api/checklists/lines/[id]/last/route')

const req = (path: string, qs: string) => ({ nextUrl: new URL(`http://x${path}?${qs}`) } as unknown as NextRequest)
const getHistory = (qs: string) => history(req('/api/checklists/history', qs))
const getPeople = (qs: string) => people(req('/api/checklists/history/people', qs))
const getLast = (id: string) => last(req('/x', ''), { params: { id } })

const station = (name: string, sortOrder: number, isShared = false) => ({ name, color: '#111', isShared, sortOrder })

const line = (over: Record<string, unknown> = {}) => ({
  id: 'l1', runId: 'r1', itemId: 'i1', categoryName: 'Close', title: 'Grill off', howTo: null, isBlocker: false,
  answer: 'TICK', unit: null, safeMin: null, safeMax: null, tempUnitId: null, sortOrder: 1,
  status: 'DONE', value: null, doneById: 'u1', doneByName: 'Leo', doneAt: new Date('2026-10-29T05:14:00Z'),
  flagReason: null, flagNote: null, resolvedById: null, resolvedByName: null, resolvedAt: null,
  ...over,
})

const fullRun = (id: string, st: ReturnType<typeof station>, over: Record<string, unknown> = {}) => ({
  id, stationId: 's-' + id, phase: 'CLOSE', businessDate: '2026-10-28', status: 'SIGNED',
  signedOffById: null, signedOffByName: null, signedOffAt: null, handoverNote: null,
  lines: [line({ runId: id })], crew: [], station: st,
  ...over,
})

const weekRun = (businessDate: string, status: 'OPEN' | 'SIGNED', isShared = false) => ({
  businessDate, status, station: { isShared },
})

beforeEach(() => {
  vi.clearAllMocks()
  requireSession.mockResolvedValue({ id: 'm1', name: 'Mo', email: 'm@x.ca', role: 'MANAGER', isActive: true })
  isRcInScope.mockResolvedValue(true)
  runFindMany.mockResolvedValue([])
  stationFindMany.mockResolvedValue([{ id: 's1', name: 'Grill' }])
  crewFindMany.mockResolvedValue([])
})

describe('GET /api/checklists/history', () => {
  it('asks for a MANAGER session: 403 below it, before reading anything', async () => {
    requireSession.mockRejectedValue(new MockAuthError(403, 'Forbidden'))
    const res = await getHistory('rcId=rc1')
    expect(requireSession).toHaveBeenCalledWith('MANAGER')
    expect(res.status).toBe(403)
    expect(runFindMany).not.toHaveBeenCalled()
  })

  it('400 without rcId, 403 for a kitchen outside scope', async () => {
    expect((await getHistory('date=2026-10-28')).status).toBe(400)
    isRcInScope.mockResolvedValue(false)
    expect((await getHistory('rcId=rc1')).status).toBe(403)
    expect(runFindMany).not.toHaveBeenCalled()
  })

  it('defaults to the last finished night, and ignores a malformed date', async () => {
    expect((await (await getHistory('rcId=rc1')).json()).date).toBe('2026-10-28')
    expect((await (await getHistory('rcId=rc1&date=yesterday')).json()).date).toBe('2026-10-28')
    expect((await (await getHistory('rcId=rc1&date=2026-10-20')).json()).date).toBe('2026-10-20')
  })

  it('a calendar-invalid date falls back to the default instead of failing', async () => {
    for (const bad of ['2026-13-45', '2026-02-30', '2026-00-10']) {
      const res = await getHistory(`rcId=rc1&date=${bad}`)
      expect(res.status).toBe(200)
      expect((await res.json()).date).toBe('2026-10-28')
    }
  })

  it('strip: ok when every non-shared run is signed, miss when one is not, none with no runs; shared runs never count', async () => {
    runFindMany.mockImplementation(async (arg: { select?: unknown }) => arg.select
      ? [
        weekRun('2026-10-22', 'SIGNED'), weekRun('2026-10-22', 'SIGNED'),
        weekRun('2026-10-23', 'SIGNED'), weekRun('2026-10-23', 'OPEN'),
        weekRun('2026-10-24', 'OPEN', true), // only a shared run: nothing to sign
        weekRun('2026-10-25', 'SIGNED'), weekRun('2026-10-25', 'OPEN', true),
        weekRun('2026-10-28', 'OPEN'),
      ]
      : [])
    const body = await (await getHistory('rcId=rc1')).json()
    expect(body.days.map((d: { date: string }) => d.date)).toEqual([
      '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28',
    ])
    expect(body.days.map((d: { state: string }) => d.state)).toEqual(['ok', 'miss', 'none', 'ok', 'none', 'none', 'miss'])
    const strip = runFindMany.mock.calls.find(c => c[0].select)![0]
    expect(strip.where).toEqual({
      station: { revenueCenterId: 'rc1' },
      businessDate: { gte: '2026-10-22', lte: '2026-10-28' },
    })
  })

  it('orders closing before opening, then by station order; each run carries its station', async () => {
    runFindMany.mockImplementation(async (arg: { select?: unknown }) => arg.select ? [] : [
      fullRun('o1', station('Grill', 1), { phase: 'OPEN' }),
      fullRun('c2', station('Pastry', 2)),
      fullRun('c1', station('Grill', 1)),
    ])
    const body = await (await getHistory('rcId=rc1')).json()
    expect(body.runs.map((r: { id: string }) => r.id)).toEqual(['c1', 'c2', 'o1'])
    expect(body.runs[0]).toMatchObject({ stationName: 'Grill', color: '#111', isShared: false })
    expect(body.runs[0].lines[0].doneAt).toBe('2026-10-29T05:14:00.000Z')
  })

  it('lists the kitchen\'s active stations for the filter', async () => {
    const body = await (await getHistory('rcId=rc1')).json()
    expect(body.stations).toEqual([{ id: 's1', name: 'Grill' }])
    expect(stationFindMany.mock.calls[0][0].where).toEqual({ revenueCenterId: 'rc1', isActive: true })
  })

  it('stationId narrows the runs; the day is read for the chosen date', async () => {
    await getHistory('rcId=rc1&date=2026-10-27&stationId=s9')
    const dayQuery = runFindMany.mock.calls.find(c => !c[0].select)![0]
    expect(dayQuery.where).toEqual({ businessDate: '2026-10-27', station: { revenueCenterId: 'rc1' }, stationId: 's9' })
  })

  it('userId keeps a run the person only fixed a flag in, whole, and drops runs they never touched', async () => {
    runFindMany.mockImplementation(async (arg: { select?: unknown }) => arg.select ? [] : [
      fullRun('crew', station('Grill', 1), { crew: [{ userId: 'u7', userName: 'Raj' }], lines: [line({ id: 'a', doneById: 'u1' })] }),
      fullRun('fixed', station('Sauté', 2), {
        lines: [
          line({ id: 'b', doneById: 'u1', status: 'FLAGGED', resolvedById: 'u7', resolvedByName: 'Raj' }),
          line({ id: 'c', doneById: 'u1' }),
        ],
      }),
      fullRun('did', station('Dish', 3), { lines: [line({ id: 'd', doneById: 'u7' })] }),
      fullRun('signed', station('Pastry', 4), { signedOffById: 'u7', lines: [line({ id: 'e', doneById: 'u1' })] }),
      fullRun('other', station('Bar', 5), { lines: [line({ id: 'f', doneById: 'u1' })], crew: [{ userId: 'u1', userName: 'Leo' }] }),
    ])
    const body = await (await getHistory('rcId=rc1&userId=u7')).json()
    expect(body.runs.map((r: { id: string }) => r.id)).toEqual(['crew', 'fixed', 'did', 'signed'])
    // Every line of a kept run stays, including the ones this person did not touch.
    expect(body.runs[1].lines.map((l: { id: string }) => l.id)).toEqual(['b', 'c'])
  })
})

describe('GET /api/checklists/history/people', () => {
  it('needs a MANAGER session, an rcId and a kitchen in scope', async () => {
    expect((await getPeople('x=1')).status).toBe(400)
    await getPeople('rcId=rc1')
    expect(requireSession).toHaveBeenCalledWith('MANAGER')
    isRcInScope.mockResolvedValue(false)
    expect((await getPeople('rcId=rc1')).status).toBe(403)
  })

  it('lists each person once, A-Z, from the last 60 days of this kitchen', async () => {
    crewFindMany.mockResolvedValue([
      { userId: 'u2', userName: 'Sam' }, { userId: 'u1', userName: 'Leo' }, { userId: 'u2', userName: 'Sam' },
    ])
    const body = await (await getPeople('rcId=rc1')).json()
    expect(body.people).toEqual([{ userId: 'u1', name: 'Leo' }, { userId: 'u2', name: 'Sam' }])
    expect(crewFindMany.mock.calls[0][0].where).toEqual({
      run: { businessDate: { gte: '2026-08-29' }, station: { revenueCenterId: 'rc1' } },
    })
  })
})

describe('GET /api/checklists/lines/[id]/last', () => {
  const found = { itemId: 'i1', runId: 'r5', run: { businessDate: '2026-10-28', station: { revenueCenterId: 'rc1' } } }

  it('404 when the job does not exist', async () => {
    lineFindUnique.mockResolvedValue(null)
    const res = await getLast('nope')
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Job not found')
  })

  it('is open to a cook (no minimum role) but 403 for a kitchen outside scope', async () => {
    lineFindUnique.mockResolvedValue(found)
    isRcInScope.mockResolvedValue(false)
    expect((await getLast('l1')).status).toBe(403)
    expect(requireSession).toHaveBeenCalledWith()
    expect(isRcInScope).toHaveBeenCalledWith(expect.anything(), 'rc1')
    expect(lineFindFirst).not.toHaveBeenCalled()
  })

  it('returns the newest earlier reading of the same item from a different run', async () => {
    lineFindUnique.mockResolvedValue(found)
    lineFindFirst.mockResolvedValue({ value: '3', unit: '°C', doneByName: 'Leo', doneAt: new Date('2026-10-28T05:31:00Z') })
    const body = await (await getLast('l1')).json()
    expect(body).toEqual({ value: 3, unit: '°C', byName: 'Leo', at: '2026-10-28T05:31:00.000Z' })
    const arg = lineFindFirst.mock.calls[0][0]
    expect(arg.where).toMatchObject({
      itemId: 'i1', runId: { not: 'r5' }, value: { not: null }, run: { businessDate: { lte: '2026-10-28' } },
    })
    expect(arg.orderBy).toEqual({ doneAt: 'desc' })
  })

  it('null when there is no earlier reading, or the line has no list item', async () => {
    lineFindUnique.mockResolvedValue(found)
    lineFindFirst.mockResolvedValue(null)
    expect(await (await getLast('l1')).json()).toBeNull()
    lineFindUnique.mockResolvedValue({ ...found, itemId: null })
    lineFindFirst.mockClear()
    expect(await (await getLast('l1')).json()).toBeNull()
    expect(lineFindFirst).not.toHaveBeenCalled()
  })
})
