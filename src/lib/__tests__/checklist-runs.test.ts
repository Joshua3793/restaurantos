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

vi.mock('@/lib/prisma', () => ({
  prisma: {
    checklistRun: {
      findUnique: (...a: unknown[]) => runFindUnique(...a),
      findFirst: (...a: unknown[]) => runFindFirst(...a),
      upsert: (...a: unknown[]) => runUpsert(...a),
    },
    checklistCategory: { findMany: (...a: unknown[]) => categoryFindMany(...a) },
    checklistRunLine: { createMany: (...a: unknown[]) => lineCreateMany(...a) },
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
  for (const m of [runFindUnique, runFindFirst, runUpsert, categoryFindMany, lineCreateMany]) m.mockReset()
})

describe('ensureRun', () => {
  it('creates the run and snapshots lines when none exists', async () => {
    runFindUnique.mockResolvedValue(null)
    runUpsert.mockResolvedValue({ id: 'r1' })
    categoryFindMany.mockResolvedValue(cats)
    lineCreateMany.mockResolvedValue({ count: 1 })

    const out = await ensureRun('s1', 'OPEN', '2026-10-28')

    expect(out).toEqual({ id: 'r1', created: true })
    expect(runUpsert.mock.calls[0][0].where).toEqual({ stationId_phase_businessDate: KEY })
    expect(runUpsert.mock.calls[0][0].update).toEqual({})
    const arg = lineCreateMany.mock.calls[0][0]
    expect(arg.skipDuplicates).toBe(true)
    expect(arg.data).toHaveLength(1)
    expect(arg.data[0]).toMatchObject({ runId: 'r1', itemId: 'i1', categoryName: 'Line', sortOrder: 0 })
  })

  it('leaves a run that already exists alone (edits do not change a started run)', async () => {
    runFindUnique.mockResolvedValue({ id: 'r1' })

    const out = await ensureRun('s1', 'OPEN', '2026-10-28')

    expect(out).toEqual({ id: 'r1', created: false })
    expect(runFindUnique.mock.calls[0][0].where).toEqual({ stationId_phase_businessDate: KEY })
    expect(runUpsert).not.toHaveBeenCalled()
    expect(categoryFindMany).not.toHaveBeenCalled()
    expect(lineCreateMany).not.toHaveBeenCalled()
  })

  it('survives a concurrent first open (upsert P2002): re-reads the run and still snapshots', async () => {
    runFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'r1' })
    runUpsert.mockRejectedValue(new MockPrismaClientKnownRequestError('unique', 'P2002'))
    categoryFindMany.mockResolvedValue(cats)
    lineCreateMany.mockResolvedValue({ count: 0 })

    const out = await ensureRun('s1', 'OPEN', '2026-10-28')

    expect(out).toEqual({ id: 'r1', created: true })
    expect(runFindUnique).toHaveBeenCalledTimes(2)
    expect(lineCreateMany.mock.calls[0][0].skipDuplicates).toBe(true)
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
        businessDate: { lt: '2026-10-28' }, handoverNote: { not: null },
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
