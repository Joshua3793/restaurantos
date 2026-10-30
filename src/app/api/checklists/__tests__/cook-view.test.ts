import { describe, it, expect, vi, beforeEach } from 'vitest'

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const isRcInScope = vi.fn(async () => true)
const stationFindMany = vi.fn()
const runFindMany = vi.fn()
const itemFindMany = vi.fn()
const seed = vi.fn(async () => {})
const ensureRun = vi.fn()
const loadRunView = vi.fn()
const lastHandover = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    checklistStation: { findMany: (...a: unknown[]) => stationFindMany(...a) },
    checklistRun: { findMany: (...a: unknown[]) => runFindMany(...a) },
    checklistItem: { findMany: (...a: unknown[]) => itemFindMany(...a) },
  },
}))
vi.mock('@/lib/auth', () => ({ AuthError: MockAuthError }))
vi.mock('@/lib/rc-scope', () => ({ isRcInScope: (...a: unknown[]) => isRcInScope(...(a as [])) }))
vi.mock('@/lib/checklists/seed', () => ({ seedStationsIfEmpty: (...a: unknown[]) => seed(...(a as [])) }))
vi.mock('@/lib/checklists/runs', () => ({
  ensureRun: (...a: unknown[]) => ensureRun(...a),
  loadRunView: (...a: unknown[]) => loadRunView(...a),
  lastHandover: (...a: unknown[]) => lastHandover(...a),
}))

const { buildCookView } = await import('@/lib/checklists/cook-view')
const user = { id: 'u1', name: 'Sam Lee', email: 's@x.ca' } as never

const stations = [
  { id: 'grill', name: 'Grill', color: '#111', isShared: false },
  { id: 'fry', name: 'Fryer', color: '#222', isShared: false },
  { id: 'all', name: 'Whole kitchen', color: '#333', isShared: true },
]

beforeEach(() => {
  vi.clearAllMocks()
  isRcInScope.mockResolvedValue(true)
  stationFindMany.mockResolvedValue(stations)
  runFindMany.mockResolvedValue([])
  itemFindMany.mockResolvedValue([])
  lastHandover.mockResolvedValue(null)
})

describe('buildCookView', () => {
  it('403 before seeding when the kitchen is out of scope', async () => {
    isRcInScope.mockResolvedValue(false)
    await expect(buildCookView(user, 'rc1', 'OPEN')).rejects.toMatchObject({ status: 403 })
    expect(seed).not.toHaveBeenCalled()
  })

  it('nothing picked: no mine, no shared run, job counts from applicable items in one query', async () => {
    itemFindMany.mockResolvedValue([
      { days: 127, category: { stationId: 'grill' } },
      { days: 127, category: { stationId: 'grill' } },
      { days: 127, category: { stationId: 'fry' } },
    ])
    const v = await buildCookView(user, 'rc1', 'OPEN')
    expect(seed).toHaveBeenCalledWith('rc1')
    expect(v.mine).toEqual([])
    expect(v.shared).toBeNull()
    expect(ensureRun).not.toHaveBeenCalled()
    expect(itemFindMany).toHaveBeenCalledTimes(1)
    expect(v.stations.map(s => [s.id, s.jobCount, s.picked])).toEqual([
      ['grill', 2, false], ['fry', 1, false], ['all', 0, false],
    ])
  })

  it('picked: mine + the shared run, handover per picked station, crew names, run line counts', async () => {
    runFindMany.mockResolvedValue([
      { id: 'r-grill', stationId: 'grill', crew: [{ userId: 'u1', userName: 'Sam Lee' }, { userId: 'u2', userName: 'Ana' }], _count: { lines: 7 } },
    ])
    loadRunView.mockImplementation(async (id: string) => ({ id, stationId: id === 'r-grill' ? 'grill' : 'all', lines: new Array(id === 'r-all' ? 3 : 7).fill({}) }))
    ensureRun.mockResolvedValue({ id: 'r-all', created: true })
    lastHandover.mockResolvedValue({ note: 'oil low', byName: 'Ana', businessDate: '2026-10-28' })
    itemFindMany.mockResolvedValue([{ days: 127, category: { stationId: 'fry' } }])

    const v = await buildCookView(user, 'rc1', 'OPEN')
    expect(v.mine.map(r => r.id)).toEqual(['r-grill'])
    expect(v.shared?.id).toBe('r-all')
    expect(v.handover).toEqual({ grill: { note: 'oil low', byName: 'Ana', businessDate: '2026-10-28' } })
    const by = Object.fromEntries(v.stations.map(s => [s.id, s]))
    expect(by.grill).toMatchObject({ crew: ['Sam Lee', 'Ana'], jobCount: 7, picked: true })
    expect(by.fry).toMatchObject({ crew: [], jobCount: 1, picked: false })
    expect(by.all).toMatchObject({ jobCount: 3 })
    // the item query only asks about stations that have no run
    expect(itemFindMany.mock.calls[0][0].where.category.stationId.in).toEqual(['fry'])
  })

  it('CLOSE has no handover lookup', async () => {
    runFindMany.mockResolvedValue([{ id: 'r-grill', stationId: 'grill', crew: [{ userId: 'u1', userName: 'Sam Lee' }], _count: { lines: 1 } }])
    loadRunView.mockResolvedValue({ id: 'r-grill', stationId: 'grill', lines: [{}] })
    ensureRun.mockResolvedValue({ id: 'r-all', created: false })
    const v = await buildCookView(user, 'rc1', 'CLOSE')
    expect(lastHandover).not.toHaveBeenCalled()
    expect(v.handover).toEqual({})
  })
})
