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
const runFindMany = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: { checklistRun: { findMany: (...a: unknown[]) => runFindMany(...a) } },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [string?])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({ isRcInScope: (...a: unknown[]) => isRcInScope(...a) }))
vi.mock('@/lib/checklists/rules', async orig => ({
  ...(await orig<typeof import('@/lib/checklists/rules')>()),
  shiftBusinessDate: () => '2026-10-30',
}))

const { GET } = await import('@/app/api/checklists/handovers/route')

const get = (qs: string) => GET({ nextUrl: new URL('http://x/api/checklists/handovers?' + qs) } as unknown as NextRequest)

const run = (date: string, name: string, note: string | null, o: { isShared?: boolean; sortOrder?: number; by?: string } = {}) => ({
  businessDate: date,
  signedOffByName: o.by ?? 'Leo',
  signedOffAt: new Date(`${date}T05:48:00Z`),
  handoverNote: note,
  station: { name, color: '#123456', isShared: o.isShared ?? false, sortOrder: o.sortOrder ?? 0 },
})

beforeEach(() => {
  vi.clearAllMocks()
  isRcInScope.mockResolvedValue(true)
  runFindMany.mockResolvedValue([])
})

describe('GET /api/checklists/handovers', () => {
  it('needs a LEAD session and an rcId', async () => {
    expect((await get('')).status).toBe(400)
    await get('rcId=rc1')
    expect(requireSession).toHaveBeenCalledWith('LEAD')
  })

  it('403 when the kitchen is outside scope, before reading anything', async () => {
    isRcInScope.mockResolvedValue(false)
    expect((await get('rcId=rc1')).status).toBe(403)
    expect(runFindMany).not.toHaveBeenCalled()
  })

  it('asks only for SIGNED CLOSE runs with a note, in this kitchen, for the close date and the day before', async () => {
    await get('rcId=rc1')
    expect(runFindMany).toHaveBeenCalledTimes(1)
    const where = runFindMany.mock.calls[0][0].where
    expect(where).toMatchObject({
      phase: 'CLOSE',
      status: 'SIGNED',
      handoverNote: { not: null },
      station: { revenueCenterId: 'rc1' },
      businessDate: { in: ['2026-10-30', '2026-10-29'] },
    })
  })

  it('in the morning (no notes for the current close yet) it shows the day before', async () => {
    runFindMany.mockResolvedValue([
      run('2026-10-29', 'Grill', 'Drain under the flat-top is slow.', { sortOrder: 1 }),
      run('2026-10-29', 'Pastry', 'Croissant dough is top shelf.', { sortOrder: 2, by: 'Ana' }),
    ])
    const body = await (await get('rcId=rc1')).json()
    expect(body.businessDate).toBe('2026-10-29')
    expect(body.notes).toEqual([
      { stationName: 'Grill', color: '#123456', isShared: false, byName: 'Leo', at: '2026-10-29T05:48:00.000Z', note: 'Drain under the flat-top is slow.' },
      { stationName: 'Pastry', color: '#123456', isShared: false, byName: 'Ana', at: '2026-10-29T05:48:00.000Z', note: 'Croissant dough is top shelf.' },
    ])
  })

  it('once tonight has a note, tonight wins and last night drops out', async () => {
    runFindMany.mockResolvedValue([
      run('2026-10-29', 'Grill', 'Old note'),
      run('2026-10-30', 'Sauté', 'Fresh note'),
    ])
    const body = await (await get('rcId=rc1')).json()
    expect(body.businessDate).toBe('2026-10-30')
    expect(body.notes.map((n: { note: string }) => n.note)).toEqual(['Fresh note'])
  })

  it('blank or whitespace notes do not count, and do not make a date current', async () => {
    runFindMany.mockResolvedValue([
      run('2026-10-30', 'Grill', '   '),
      run('2026-10-29', 'Pastry', '  Low on brioche.  '),
    ])
    const body = await (await get('rcId=rc1')).json()
    expect(body.businessDate).toBe('2026-10-29')
    expect(body.notes).toHaveLength(1)
    expect(body.notes[0].note).toBe('Low on brioche.')
  })

  it('orders the shared station first, then the stations’ own order', async () => {
    runFindMany.mockResolvedValue([
      run('2026-10-29', 'Pastry', 'p', { sortOrder: 2 }),
      run('2026-10-29', 'Whole kitchen', 'k', { isShared: true, sortOrder: 9 }),
      run('2026-10-29', 'Grill', 'g', { sortOrder: 1 }),
    ])
    const body = await (await get('rcId=rc1')).json()
    expect(body.notes.map((n: { stationName: string }) => n.stationName)).toEqual(['Whole kitchen', 'Grill', 'Pastry'])
  })

  it('no notes at all: an empty list for the day before', async () => {
    const body = await (await get('rcId=rc1')).json()
    expect(body).toEqual({ businessDate: '2026-10-29', notes: [] })
  })
})
