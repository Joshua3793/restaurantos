import { describe, it, expect, vi, beforeEach } from 'vitest'

class MockPrismaClientKnownRequestError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'PrismaClientKnownRequestError'
    Object.setPrototypeOf(this, MockPrismaClientKnownRequestError.prototype)
  }
}

const runFindUnique = vi.fn()
const runFindFirst = vi.fn()
const runUpsert = vi.fn()
const categoryFindMany = vi.fn()
const lineCreateMany = vi.fn()
const outerUpsert = vi.fn()
const outerCreateMany = vi.fn()
const transaction = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    checklistRun: {
      findUnique: (...a: unknown[]) => runFindUnique(...a),
      findFirst: (...a: unknown[]) => runFindFirst(...a),
      upsert: (...a: unknown[]) => outerUpsert(...a),
    },
    checklistCategory: { findMany: (...a: unknown[]) => categoryFindMany(...a) },
    checklistRunLine: { createMany: (...a: unknown[]) => outerCreateMany(...a) },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}))
vi.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: MockPrismaClientKnownRequestError },
}))

const { ensureRun, loadRunView, lastHandover } = await import('../checklists/runs')

const KEY = { stationId: 's1', phase: 'OPEN', businessDate: '2026-10-28' }
const cats = [{
  name: 'Line', sortOrder: 0, isActive: true,
  items: [{
    id: 'i1', title: 'Fridge', howTo: null, isBlocker: false, answer: 'TICK', unit: null,
    safeMin: null, safeMax: null, tempUnitId: null, days: 127, sortOrder: 0, isActive: true,
  }],
}]

beforeEach(() => {
  for (const m of [runFindUnique, runFindFirst, runUpsert, categoryFindMany, lineCreateMany, outerUpsert, outerCreateMany, transaction]) m.mockReset()
  // Interactive transaction: run the callback against a tx client.
  transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      checklistRun: { upsert: (...a: unknown[]) => runUpsert(...a) },
      checklistRunLine: { createMany: (...a: unknown[]) => lineCreateMany(...a) },
    }))
})

describe('ensureRun', () => {
  it('creates the run and snapshots lines when none exists', async () => {
    runFindUnique.mockResolvedValue(null)
    runUpsert.mockResolvedValue({ id: 'r1' })
    categoryFindMany.mockResolvedValue(cats)
    lineCreateMany.mockResolvedValue({ count: 1 })

    const out = await ensureRun('s1', 'OPEN', '2026-10-28')

    expect(out).toEqual({ id: 'r1', created: true })
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(outerUpsert).not.toHaveBeenCalled()
    expect(outerCreateMany).not.toHaveBeenCalled()
    expect(runUpsert.mock.calls[0][0].where).toEqual({ stationId_phase_businessDate: KEY })
    expect(runUpsert.mock.calls[0][0].update).toEqual({})
    const arg = lineCreateMany.mock.calls[0][0]
    expect(arg.skipDuplicates).toBe(true)
    expect(arg.data).toHaveLength(1)
    expect(arg.data[0]).toMatchObject({ runId: 'r1', itemId: 'i1', categoryName: 'Line', sortOrder: 0 })
  })

  it('loads each item\'s Temps unit range so a TEMP line can flag out of range', async () => {
    runFindUnique.mockResolvedValue(null)
    runUpsert.mockResolvedValue({ id: 'r1' })
    categoryFindMany.mockResolvedValue([{
      name: 'Fridges', sortOrder: 0, isActive: true,
      items: [{
        id: 'i2', title: 'Walk-in', howTo: null, isBlocker: true, answer: 'TEMP', unit: null,
        safeMin: null, safeMax: null, tempUnitId: 't1', tempUnit: { safeMin: '0', safeMax: '4' },
        days: 127, sortOrder: 0, isActive: true,
      }],
    }])
    lineCreateMany.mockResolvedValue({ count: 1 })

    await ensureRun('s1', 'OPEN', '2026-10-28')

    expect(categoryFindMany.mock.calls[0][0].include.items.include)
      .toEqual({ tempUnit: { select: { safeMin: true, safeMax: true } } })
    expect(lineCreateMany.mock.calls[0][0].data[0])
      .toMatchObject({ answer: 'TEMP', unit: '°C', safeMin: '0', safeMax: '4', tempUnitId: 't1' })
  })

  it('leaves a run that already exists alone (edits do not change a started run)', async () => {
    runFindUnique.mockResolvedValue({ id: 'r1' })

    const out = await ensureRun('s1', 'OPEN', '2026-10-28')

    expect(out).toEqual({ id: 'r1', created: false })
    expect(runFindUnique.mock.calls[0][0].where).toEqual({ stationId_phase_businessDate: KEY })
    expect(transaction).not.toHaveBeenCalled()
    expect(runUpsert).not.toHaveBeenCalled()
    expect(categoryFindMany).not.toHaveBeenCalled()
    expect(lineCreateMany).not.toHaveBeenCalled()
  })

  it('lost create race (P2002): returns the winner\'s run without writing lines', async () => {
    runFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'r1' })
    categoryFindMany.mockResolvedValue(cats)
    runUpsert.mockRejectedValue(new MockPrismaClientKnownRequestError('unique', 'P2002'))

    const out = await ensureRun('s1', 'OPEN', '2026-10-28')

    expect(out).toEqual({ id: 'r1', created: false })
    expect(runFindUnique).toHaveBeenCalledTimes(2)
    expect(lineCreateMany).not.toHaveBeenCalled()
  })

  it('reads the template before the transaction, and writes only inside it', async () => {
    const order: string[] = []
    runFindUnique.mockResolvedValue(null)
    categoryFindMany.mockImplementation(async () => { order.push('read'); return cats })
    transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      order.push('tx')
      return fn({
        checklistRun: { upsert: async () => { order.push('upsert'); return { id: 'r1' } } },
        checklistRunLine: { createMany: async () => { order.push('lines'); return { count: 1 } } },
      })
    })
    await ensureRun('s1', 'OPEN', '2026-10-28')
    expect(order).toEqual(['read', 'tx', 'upsert', 'lines'])
  })

  it('a failed line insert fails the open (nothing is left half-made)', async () => {
    runFindUnique.mockResolvedValue(null)
    categoryFindMany.mockResolvedValue(cats)
    runUpsert.mockResolvedValue({ id: 'r1' })
    lineCreateMany.mockRejectedValue(new Error('db down'))
    await expect(ensureRun('s1', 'OPEN', '2026-10-28')).rejects.toThrow('db down')
  })

  it('rethrows other upsert errors', async () => {
    runFindUnique.mockResolvedValue(null)
    runUpsert.mockRejectedValue(new Error('boom'))
    await expect(ensureRun('s1', 'OPEN', '2026-10-28')).rejects.toThrow('boom')
  })
})

describe('loadRunView', () => {
  it('turns Decimals into numbers and dates into ISO strings', async () => {
    runFindUnique.mockResolvedValue({
      id: 'r1', stationId: 's1', phase: 'CLOSE', businessDate: '2026-10-28', status: 'SIGNED',
      signedOffByName: 'Sam', signedOffAt: new Date('2026-10-29T06:00:00Z'), handoverNote: 'ok',
      lines: [{
        id: 'l1', runId: 'r1', itemId: 'i1', categoryName: 'Line', title: 'Fridge', howTo: null,
        isBlocker: true, answer: 'TEMP', unit: '°C', safeMin: '0', safeMax: { toString: () => '4' },
        tempUnitId: null, sortOrder: 0, status: 'DONE', value: '3.5', doneById: 'u1', doneByName: 'Sam',
        doneAt: new Date('2026-10-29T05:00:00Z'), flagReason: null, flagNote: null,
        resolvedById: null, resolvedByName: null, resolvedAt: null,
      }],
      crew: [{ userId: 'u1', userName: 'Sam' }],
    })

    const v = await loadRunView('r1')

    expect(v.signedOffAt).toBe('2026-10-29T06:00:00.000Z')
    expect(v.lines[0].value).toBe(3.5)
    expect(v.lines[0].safeMin).toBe(0)
    expect(v.lines[0].safeMax).toBe(4)
    expect(v.lines[0].doneAt).toBe('2026-10-29T05:00:00.000Z')
    expect(v.lines[0].resolvedAt).toBeNull()
    expect(v.crew).toEqual([{ userId: 'u1', userName: 'Sam' }])
    const q = runFindUnique.mock.calls[0][0]
    expect(q.include.lines.orderBy).toEqual({ sortOrder: 'asc' })
    expect(q.include.crew.orderBy).toEqual({ joinedAt: 'asc' })
  })

  it('keeps null readings null (not 0)', async () => {
    runFindUnique.mockResolvedValue({
      id: 'r1', stationId: 's1', phase: 'OPEN', businessDate: '2026-10-28', status: 'OPEN',
      signedOffByName: null, signedOffAt: null, handoverNote: null,
      lines: [{ id: 'l1', safeMin: null, safeMax: null, value: null, doneAt: null, resolvedAt: null }],
      crew: [],
    })
    const v = await loadRunView('r1')
    expect(v.lines[0].value).toBeNull()
    expect(v.lines[0].safeMin).toBeNull()
    expect(v.signedOffAt).toBeNull()
  })

  it('throws when the run is gone', async () => {
    runFindUnique.mockResolvedValue(null)
    await expect(loadRunView('nope')).rejects.toThrow()
  })
})

describe('lastHandover', () => {
  it('asks for the latest signed close with a note before the date', async () => {
    runFindFirst.mockResolvedValue({ handoverNote: 'Walk-in door sticks', signedOffByName: 'Sam', businessDate: '2026-10-27' })
    const out = await lastHandover('s1', '2026-10-28')
    expect(out).toEqual({ note: 'Walk-in door sticks', byName: 'Sam', businessDate: '2026-10-27' })
    expect(runFindFirst.mock.calls[0][0]).toMatchObject({
      where: {
        stationId: 's1', phase: 'CLOSE', status: 'SIGNED',
        businessDate: { lt: '2026-10-28' }, handoverNote: { not: null }, NOT: { handoverNote: '' },
      },
      orderBy: { businessDate: 'desc' },
    })
  })

  it('returns null when there is none, or the note is only whitespace', async () => {
    runFindFirst.mockResolvedValue(null)
    expect(await lastHandover('s1', '2026-10-28')).toBeNull()
    runFindFirst.mockResolvedValue({ handoverNote: '   ', signedOffByName: 'Sam', businessDate: '2026-10-27' })
    expect(await lastHandover('s1', '2026-10-28')).toBeNull()
  })
})
