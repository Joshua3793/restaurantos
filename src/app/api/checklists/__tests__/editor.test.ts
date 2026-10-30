import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const requireSession = vi.fn(async (_min?: string) => ({ id: 'u1', name: 'Mia', email: 'm@x.ca', role: 'MANAGER', isActive: true }))
const assertRcWritable = vi.fn(async (..._a: unknown[]) => {})
const isRcInScope = vi.fn(async (..._a: unknown[]) => true)
const seedStationsIfEmpty = vi.fn(async (_rc: string) => {})

const m = {
  stationFindFirst: vi.fn(),
  stationFindMany: vi.fn(),
  stationAggregate: vi.fn(),
  stationCreate: vi.fn(),
  stationUpdate: vi.fn(),
  categoryFindFirst: vi.fn(),
  categoryFindMany: vi.fn(),
  categoryAggregate: vi.fn(),
  categoryCreate: vi.fn(),
  categoryCreateMany: vi.fn(),
  categoryUpdate: vi.fn(),
  itemFindFirst: vi.fn(),
  itemFindMany: vi.fn(),
  itemAggregate: vi.fn(),
  itemCreate: vi.fn(),
  itemCreateMany: vi.fn(),
  itemUpdate: vi.fn(),
  tempFindFirst: vi.fn(),
  tempFindMany: vi.fn(),
  transaction: vi.fn(async (ops: unknown[]) => ops),
}
const pass = (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a)

vi.mock('@/lib/prisma', () => ({
  prisma: {
    checklistStation: {
      findFirst: pass(m.stationFindFirst), findMany: pass(m.stationFindMany), aggregate: pass(m.stationAggregate),
      create: pass(m.stationCreate), update: pass(m.stationUpdate),
    },
    checklistCategory: {
      findFirst: pass(m.categoryFindFirst), findMany: pass(m.categoryFindMany), aggregate: pass(m.categoryAggregate),
      create: pass(m.categoryCreate), createMany: pass(m.categoryCreateMany), update: pass(m.categoryUpdate),
    },
    checklistItem: {
      findFirst: pass(m.itemFindFirst), findMany: pass(m.itemFindMany), aggregate: pass(m.itemAggregate),
      create: pass(m.itemCreate), createMany: pass(m.itemCreateMany), update: pass(m.itemUpdate),
    },
    tempUnit: { findFirst: pass(m.tempFindFirst), findMany: pass(m.tempFindMany) },
    $transaction: pass(m.transaction as (...a: unknown[]) => unknown),
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [string?])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  assertRcWritable: (...a: unknown[]) => assertRcWritable(...a),
  isRcInScope: (...a: unknown[]) => isRcInScope(...a),
}))
vi.mock('@/lib/checklists/seed', () => ({ seedStationsIfEmpty: (rc: string) => seedStationsIfEmpty(rc) }))

const stations = await import('@/app/api/checklists/stations/route')
const station = await import('@/app/api/checklists/stations/[id]/route')
const categories = await import('@/app/api/checklists/categories/route')
const items = await import('@/app/api/checklists/items/route')
const item = await import('@/app/api/checklists/items/[id]/route')
const reorder = await import('@/app/api/checklists/reorder/route')
const copy = await import('@/app/api/checklists/copy/route')

const req = (body?: unknown, qs = '') => ({
  json: async () => body,
  nextUrl: new URL('http://x/api' + qs),
}) as unknown as NextRequest
const ctx = (id: string) => ({ params: { id } })

const itemBody = {
  title: 'Walk-in temp', howTo: null, isBlocker: true, answer: 'TEMP', unit: null,
  safeMin: null, safeMax: null, tempUnitId: 't-other', days: 127, categoryId: 'c1',
}

beforeEach(() => {
  vi.clearAllMocks()
  isRcInScope.mockResolvedValue(true)
  m.stationAggregate.mockResolvedValue({ _max: { sortOrder: 7 } })
  m.categoryAggregate.mockResolvedValue({ _max: { sortOrder: null } })
  m.itemAggregate.mockResolvedValue({ _max: { sortOrder: 2 } })
})

describe('stations', () => {
  it('GET is MANAGER, 403 out of scope, seeds, and turns Decimals into numbers', async () => {
    isRcInScope.mockResolvedValueOnce(false)
    expect((await stations.GET(req(undefined, '?rcId=rc1'))).status).toBe(403)
    expect(seedStationsIfEmpty).not.toHaveBeenCalled()

    m.stationFindMany.mockResolvedValue([{
      id: 's1', name: 'Grill', color: '#dc2626', isShared: false, isActive: true,
      categories: [
        { id: 'c1', name: 'Before doors', phase: 'OPEN', items: [{
          id: 'i1', title: 'Lowboy', howTo: null, isBlocker: true, answer: 'NUMBER', unit: '°C',
          safeMin: '0', safeMax: '4', tempUnitId: null, days: 127,
        }] },
        { id: 'c2', name: 'Shut down', phase: 'CLOSE', items: [] },
      ],
    }])
    m.tempFindMany.mockResolvedValue([{ id: 't1', name: 'Walk-in', safeMin: '0', safeMax: null }])
    const res = await stations.GET(req(undefined, '?rcId=rc1'))
    expect(requireSession).toHaveBeenLastCalledWith('MANAGER')
    expect(seedStationsIfEmpty).toHaveBeenCalledWith('rc1')
    const body = await res.json()
    expect(body.tempUnits).toEqual([{ id: 't1', name: 'Walk-in', safeMin: 0, safeMax: null }])
    expect(body.stations[0].phases.OPEN[0].items[0]).toMatchObject({ safeMin: 0, safeMax: 4 })
    expect(body.stations[0].phases.CLOSE).toEqual([{ id: 'c2', name: 'Shut down', items: [] }])
    expect(m.tempFindMany.mock.calls[0][0].where).toEqual({
      isActive: true, OR: [{ revenueCenterId: 'rc1' }, { revenueCenterId: null }],
    })
  })

  it('POST a duplicate name (any case) → 409, nothing created', async () => {
    m.stationFindFirst.mockResolvedValue({ id: 's1' })
    const res = await stations.POST(req({ rcId: 'rc1', name: '  grill ' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "There's already a station called grill" })
    expect(m.stationFindFirst.mock.calls[0][0].where).toMatchObject({
      revenueCenterId: 'rc1', isActive: true, name: { equals: 'grill', mode: 'insensitive' },
    })
    expect(m.stationCreate).not.toHaveBeenCalled()
  })

  it('POST checks the name and colour, then appends a non-shared station', async () => {
    expect(await (await stations.POST(req({ rcId: 'rc1', name: ' ' }))).json()).toEqual({ error: 'Give the station a name' })
    expect((await stations.POST(req({ rcId: 'rc1', name: 'Bar', color: '#123456' }))).status).toBe(400)
    m.stationFindFirst.mockResolvedValue(null)
    m.stationCreate.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ id: 's9', isActive: true, ...a.data }))
    const res = await stations.POST(req({ rcId: 'rc1', name: 'Bar', isShared: true }))
    expect(res.status).toBe(201)
    expect(assertRcWritable).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'rc1')
    expect(m.stationCreate.mock.calls[0][0].data).toEqual({
      revenueCenterId: 'rc1', name: 'Bar', color: '#71717a', isShared: false, sortOrder: 8,
    })
  })

  it('DELETE the shared station → 409', async () => {
    m.stationFindFirst.mockResolvedValue({ id: 'sk', revenueCenterId: 'rc1', isShared: true })
    const res = await station.DELETE(req(), ctx('sk'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "The whole-kitchen list can't be removed" })
    expect(m.stationUpdate).not.toHaveBeenCalled()
  })

  it('DELETE soft-deletes; an already-removed station is 404', async () => {
    m.stationFindFirst.mockResolvedValueOnce({ id: 's1', revenueCenterId: 'rc1', isShared: false })
    expect((await station.DELETE(req(), ctx('s1'))).status).toBe(200)
    expect(m.stationUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: { isActive: false } })
    m.stationFindFirst.mockResolvedValueOnce(null)
    expect((await station.DELETE(req(), ctx('s1'))).status).toBe(404)
  })

  it('PATCH ignores isShared', async () => {
    m.stationFindFirst.mockResolvedValueOnce({ id: 's1', revenueCenterId: 'rc1', isShared: false })
    m.stationUpdate.mockResolvedValue({ id: 's1' })
    await station.PATCH(req({ color: '#2563eb', isShared: true }), ctx('s1'))
    expect(m.stationUpdate.mock.calls[0][0].data).toEqual({ color: '#2563eb' })
  })
})

describe('categories', () => {
  it('POST resolves the station first: missing → 404', async () => {
    m.stationFindFirst.mockResolvedValue(null)
    const res = await categories.POST(req({ stationId: 's1', phase: 'OPEN', name: 'Prep' }))
    expect(res.status).toBe(404)
    expect(m.categoryCreate).not.toHaveBeenCalled()
  })
})

describe('items', () => {
  it('POST with another kitchen’s Temps unit → 400', async () => {
    m.categoryFindFirst.mockResolvedValue({ id: 'c1', station: { revenueCenterId: 'rc1' } })
    m.tempFindFirst.mockResolvedValue(null)
    const res = await items.POST(req(itemBody))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Pick a fridge or unit' })
    expect(m.tempFindFirst.mock.calls[0][0].where).toEqual({
      id: 't-other', isActive: true, OR: [{ revenueCenterId: 'rc1' }, { revenueCenterId: null }],
    })
    expect(m.itemCreate).not.toHaveBeenCalled()
  })

  it('POST a valid job appends it with numbers stored', async () => {
    m.categoryFindFirst.mockResolvedValue({ id: 'c1', station: { revenueCenterId: 'rc1' } })
    m.itemCreate.mockResolvedValue({ id: 'i9', ...itemBody, answer: 'NUMBER', unit: '°C', safeMin: 0, safeMax: 4, tempUnitId: null })
    const res = await items.POST(req({ ...itemBody, answer: 'NUMBER', unit: '°C', safeMin: '0', safeMax: '4' }))
    expect(res.status).toBe(201)
    expect(m.itemCreate.mock.calls[0][0].data).toMatchObject({ safeMin: 0, safeMax: 4, tempUnitId: null, sortOrder: 3 })
  })

  it('PATCH may not move a job to another station', async () => {
    m.itemFindFirst.mockResolvedValue({ id: 'i1', categoryId: 'c1', category: { stationId: 's1', station: { revenueCenterId: 'rc1' } } })
    m.categoryFindFirst.mockResolvedValue({ id: 'c7', stationId: 's2' })
    const res = await item.PATCH(req({ ...itemBody, answer: 'TICK', categoryId: 'c7' }), ctx('i1'))
    expect(res.status).toBe(400)
    expect(m.itemUpdate).not.toHaveBeenCalled()
  })
})

describe('reorder', () => {
  it('mixed parents → 400, nothing written', async () => {
    m.itemFindMany.mockResolvedValue([
      { categoryId: 'c1', category: { station: { revenueCenterId: 'rc1' } } },
      { categoryId: 'c2', category: { station: { revenueCenterId: 'rc1' } } },
    ])
    const res = await reorder.POST(req({ kind: 'item', ids: ['a', 'b'] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Can't reorder those together" })
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it('a missing or inactive id → 400', async () => {
    m.categoryFindMany.mockResolvedValue([{ stationId: 's1', phase: 'OPEN', station: { revenueCenterId: 'rc1' } }])
    expect((await reorder.POST(req({ kind: 'category', ids: ['a', 'b'] }))).status).toBe(400)
  })

  it('categories in one station and phase get their index as sortOrder, in one transaction', async () => {
    m.categoryFindMany.mockResolvedValue([
      { stationId: 's1', phase: 'OPEN', station: { revenueCenterId: 'rc1' } },
      { stationId: 's1', phase: 'OPEN', station: { revenueCenterId: 'rc1' } },
    ])
    const res = await reorder.POST(req({ kind: 'category', ids: ['b', 'a'] }))
    expect(res.status).toBe(200)
    expect(m.transaction).toHaveBeenCalledTimes(1)
    expect(m.categoryUpdate.mock.calls.map(c => c[0])).toEqual([
      { where: { id: 'b' }, data: { sortOrder: 0 } },
      { where: { id: 'a' }, data: { sortOrder: 1 } },
    ])
  })
})

describe('copy', () => {
  it('into the shared station → 400', async () => {
    m.stationFindMany.mockResolvedValue([
      { id: 's1', revenueCenterId: 'rc1', isShared: false },
      { id: 'sk', revenueCenterId: 'rc1', isShared: true },
    ])
    const res = await copy.POST(req({ fromStationId: 's1', toStationId: 'sk', phase: 'OPEN' }))
    expect(res.status).toBe(400)
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it('across kitchens → 400', async () => {
    m.stationFindMany.mockResolvedValue([
      { id: 's1', revenueCenterId: 'rc1', isShared: false },
      { id: 's2', revenueCenterId: 'rc2', isShared: false },
    ])
    expect((await copy.POST(req({ fromStationId: 's1', toStationId: 's2', phase: 'OPEN' }))).status).toBe(400)
  })

  it('appends copies after the target’s categories and marks clashing names', async () => {
    m.stationFindMany.mockResolvedValue([
      { id: 'sk', revenueCenterId: 'rc1', isShared: true },
      { id: 's2', revenueCenterId: 'rc1', isShared: false },
    ])
    const it1 = { title: 'Fridge', howTo: null, isBlocker: true, answer: 'TEMP', unit: null, safeMin: null, safeMax: null, tempUnitId: 't1', days: 31 }
    m.categoryFindMany
      .mockResolvedValueOnce([{ name: 'Before doors', items: [it1] }, { name: 'Equipment', items: [] }])
      .mockResolvedValueOnce([{ name: 'before doors', sortOrder: 4, isActive: true }])
    const res = await copy.POST(req({ fromStationId: 'sk', toStationId: 's2', phase: 'OPEN' }))
    expect(await res.json()).toEqual({ categories: 2, items: 1 })
    const cats = m.categoryCreateMany.mock.calls[0][0].data
    expect(cats.map((c: { name: string; sortOrder: number; stationId: string }) => [c.name, c.sortOrder, c.stationId])).toEqual([
      ['Before doors (copy)', 5, 's2'], ['Equipment', 6, 's2'],
    ])
    const its = m.itemCreateMany.mock.calls[0][0].data
    expect(its[0]).toMatchObject({ ...it1, categoryId: cats[0].id, sortOrder: 0 })
    expect(its[0].id).not.toBe(undefined)
  })
})
