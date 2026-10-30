import { describe, it, expect, vi, beforeEach } from 'vitest'

const stationCount = vi.fn(async () => 0)
const rcFind = vi.fn(async () => ({ type: 'FOOD' as string | null }))
const openFind = vi.fn(async () => [] as unknown[])
const eodFind = vi.fn(async () => [] as unknown[])
const stationCreate = vi.fn(async (a: unknown) => a)
const categoryCreate = vi.fn(async (a: unknown) => a)
const itemCreate = vi.fn(async (a: unknown) => a)
const transaction = vi.fn(async (ops: unknown[]) => Promise.all(ops))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    checklistStation: { count: () => stationCount(), createMany: (a: unknown) => stationCreate(a) },
    checklistCategory: { createMany: (a: unknown) => categoryCreate(a) },
    checklistItem: { createMany: (a: unknown) => itemCreate(a) },
    revenueCenter: { findUnique: () => rcFind() },
    openCheckItem: { findMany: () => openFind() },
    eodCheckItem: { findMany: () => eodFind() },
    $transaction: (ops: unknown[]) => transaction(ops),
  },
}))

const { buildSeed, STARTER_STATIONS } = await import('@/lib/checklists/starter')
const { seedStationsIfEmpty } = await import('@/lib/checklists/seed')

const catNames = (rows: ReturnType<typeof buildSeed>, stationKey: string, phase: 'OPEN' | 'CLOSE') =>
  rows.categories
    .filter(c => c.stationId === `chk-rc1-${stationKey}` && c.phase === phase)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(c => c.name)

describe('buildSeed', () => {
  it('seeds 8 stations, one shared, with deterministic ids', () => {
    const a = buildSeed('rc1', [], [])
    const b = buildSeed('rc1', [], [])
    expect(a.stations).toHaveLength(8)
    expect(STARTER_STATIONS).toHaveLength(8)
    expect(a.stations.filter(s => s.isShared)).toHaveLength(1)
    expect(a).toEqual(b)
    expect(a.stations[0].id).toBe('chk-rc1-kitchen')
    const ids = [...a.stations, ...a.categories, ...a.items].map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(a.categories[0].id).toBe('chk-rc1-kitchen-OPEN-0')
    expect(a.items[0].id).toBe('chk-rc1-kitchen-OPEN-0-0')
  })

  it('uses the old opening items for the shared station OPEN list', () => {
    const rows = buildSeed('rc1', [
      { section: 'Line set-up', title: 'Fryer oil checked', meta: null, isBlocker: false, sortOrder: 4 },
      { section: 'Food safety', title: 'Hand sinks stocked', meta: 'Soap, paper towel', isBlocker: true, sortOrder: 1 },
    ], [])
    expect(catNames(rows, 'kitchen', 'OPEN')).toEqual(['Food safety', 'Line set-up'])
    const first = rows.items.find(i => i.id === 'chk-rc1-kitchen-OPEN-0-0')!
    expect(first.title).toBe('Hand sinks stocked')
    expect(first.howTo).toBe('Soap, paper towel')
    expect(first.isBlocker).toBe(true)
    expect(rows.items.some(i => i.title === 'Hood fans on')).toBe(false)
    // CLOSE has no old items, so it keeps the starter list
    expect(catNames(rows, 'kitchen', 'CLOSE')).toEqual(['Before you leave', 'Clean down'])
  })

  it('uses the old end-of-day items for the shared CLOSE list only', () => {
    const rows = buildSeed('rc1', [], [
      { section: 'Shut down', title: 'Lights off', meta: null, isBlocker: false, sortOrder: 0 },
    ])
    expect(catNames(rows, 'kitchen', 'CLOSE')).toEqual(['Shut down'])
    expect(catNames(rows, 'kitchen', 'OPEN')).toEqual(['Before doors', 'Set-up'])
  })

  it('gives the shared station the starter lists when the old lists are empty', () => {
    const rows = buildSeed('rc1', [], [])
    expect(catNames(rows, 'kitchen', 'OPEN')).toEqual(['Before doors', 'Set-up'])
    expect(rows.items.some(i => i.title === 'Hood fans on' && i.isBlocker)).toBe(true)
  })

  it('does not touch other stations when old lists exist', () => {
    const rows = buildSeed('rc1', [
      { section: 'X', title: 'Y', meta: null, isBlocker: false, sortOrder: 0 },
    ], [])
    expect(catNames(rows, 'grill', 'OPEN')).toEqual(['Before doors', 'Set-up'])
  })

  it('makes Grill "Lowboy temp" a 0–4 °C number item on every day', () => {
    const rows = buildSeed('rc1', [], [])
    const grillCats = rows.categories.filter(c => c.stationId === 'chk-rc1-grill' && c.phase === 'OPEN').map(c => c.id)
    const item = rows.items.find(i => grillCats.includes(i.categoryId) && i.title === 'Lowboy temp')!
    expect(item).toMatchObject({
      answer: 'NUMBER', unit: '°C', safeMin: 0, safeMax: 4, days: 127,
      isBlocker: true, howTo: 'Probe the middle shelf, not the door',
    })
  })

  it('leaves tick items without unit or range, and splits dish temps', () => {
    const rows = buildSeed('rc1', [], [])
    const hood = rows.items.find(i => i.title === 'Hood fans on')!
    expect(hood).toMatchObject({ answer: 'TICK', unit: null, safeMin: null, safeMax: null })
    expect(rows.items.find(i => i.title === 'Dish machine wash temp')).toMatchObject({ answer: 'NUMBER', safeMin: 60, safeMax: null })
    expect(rows.items.find(i => i.title === 'Dish machine rinse temp')).toMatchObject({ answer: 'NUMBER', safeMin: 82 })
    expect(rows.items.find(i => i.title === 'Freezer temp')).toMatchObject({ safeMax: -18 })
  })
})

describe('seedStationsIfEmpty', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stationCount.mockResolvedValue(0)
    rcFind.mockResolvedValue({ type: 'FOOD' })
  })

  it('does nothing when the RC already has stations', async () => {
    stationCount.mockResolvedValue(3)
    await seedStationsIfEmpty('rc1')
    expect(stationCreate).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('does nothing for a non-FOOD RC', async () => {
    rcFind.mockResolvedValue({ type: 'BAR' })
    await seedStationsIfEmpty('rc1')
    expect(stationCreate).not.toHaveBeenCalled()
  })

  it('seeds a FOOD RC with no stations in one transaction', async () => {
    await seedStationsIfEmpty('rc1')
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(stationCreate).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }))
    expect(categoryCreate).toHaveBeenCalledTimes(1)
    expect(itemCreate).toHaveBeenCalledTimes(1)
  })
})
