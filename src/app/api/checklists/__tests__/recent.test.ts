import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const requireSession = vi.fn(async (_min?: string) => ({ id: 'c1', name: 'Sam', email: 's@x.ca', role: 'STAFF', isActive: true }))
const isRcInScope = vi.fn(async (..._a: unknown[]) => true)
const lineFindUnique = vi.fn()
const lineFindMany = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    checklistRunLine: {
      findUnique: (...a: unknown[]) => lineFindUnique(...a),
      findMany: (...a: unknown[]) => lineFindMany(...a),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [string?])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({ isRcInScope: (...a: unknown[]) => isRcInScope(...a) }))

const { GET } = await import('@/app/api/checklists/lines/[id]/recent/route')
const get = (id: string) => GET({} as NextRequest, { params: { id } })

const LINE = { itemId: 'i1', runId: 'r9', run: { businessDate: '2026-11-01', station: { revenueCenterId: 'rc1' } } }

beforeEach(() => {
  vi.clearAllMocks()
  isRcInScope.mockResolvedValue(true)
  lineFindUnique.mockResolvedValue(LINE)
  lineFindMany.mockResolvedValue([])
})

describe('GET /api/checklists/lines/[id]/recent', () => {
  it('401 when not signed in', async () => {
    requireSession.mockRejectedValueOnce(new MockAuthError(401, 'Not signed in'))
    expect((await get('l1')).status).toBe(401)
  })

  it('404 for an unknown line', async () => {
    lineFindUnique.mockResolvedValueOnce(null)
    expect((await get('nope')).status).toBe(404)
  })

  it('403 outside the cook’s kitchens, without reading history', async () => {
    isRcInScope.mockResolvedValueOnce(false)
    expect((await get('l1')).status).toBe(403)
    expect(lineFindMany).not.toHaveBeenCalled()
  })

  it('[] for a line with no list item', async () => {
    lineFindUnique.mockResolvedValueOnce({ ...LINE, itemId: null })
    expect(await (await get('l1')).json()).toEqual({ entries: [] })
    expect(lineFindMany).not.toHaveBeenCalled()
  })

  it('asks for the same item on 7 earlier runs, newest day first', async () => {
    await get('l1')
    const arg = lineFindMany.mock.calls[0][0]
    expect(arg.where).toEqual({ itemId: 'i1', runId: { not: 'r9' }, run: { businessDate: { lte: '2026-11-01' } } })
    expect(arg.orderBy).toEqual({ run: { businessDate: 'desc' } })
    expect(arg.take).toBe(7)
  })

  it('returns readings as numbers and undone days as TODO', async () => {
    lineFindMany.mockResolvedValueOnce([
      { status: 'DONE', value: '3.2', unit: '°C', doneByName: 'Leo', doneAt: new Date('2026-10-31T13:58:00Z'), flagReason: null, run: { businessDate: '2026-10-31' } },
      { status: 'FLAGGED', value: '4.4', unit: '°C', doneByName: 'Leo', doneAt: new Date('2026-10-30T14:04:00Z'), flagReason: 'OUT_OF_RANGE', run: { businessDate: '2026-10-30' } },
      { status: 'TODO', value: null, unit: '°C', doneByName: null, doneAt: null, flagReason: null, run: { businessDate: '2026-10-29' } },
    ])
    const body = await (await get('l1')).json()
    expect(body.entries).toEqual([
      { date: '2026-10-31', status: 'DONE', value: 3.2, unit: '°C', byName: 'Leo', at: '2026-10-31T13:58:00.000Z', flagReason: null },
      { date: '2026-10-30', status: 'FLAGGED', value: 4.4, unit: '°C', byName: 'Leo', at: '2026-10-30T14:04:00.000Z', flagReason: 'OUT_OF_RANGE' },
      { date: '2026-10-29', status: 'TODO', value: null, unit: '°C', byName: null, at: null, flagReason: null },
    ])
  })
})
