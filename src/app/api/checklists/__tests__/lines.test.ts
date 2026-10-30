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
const lineFindUnique = vi.fn()
// Writes are only reachable through the transaction callback's `tx`, never stand-alone.
const lineUpdate = vi.fn(async (_a: unknown) => ({ count: 1 }))
const readingUpsert = vi.fn(async (a: unknown) => a)
const readingDelete = vi.fn(async (a: unknown) => a)
const tx = {
  checklistRunLine: { updateMany: (a: unknown) => lineUpdate(a) },
  tempReading: { upsert: (a: unknown) => readingUpsert(a), deleteMany: (a: unknown) => readingDelete(a) },
}
const transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx))
const loadRunView = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    checklistRunLine: { findUnique: (...a: unknown[]) => lineFindUnique(...a) },
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => transaction(fn),
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
  loadRunView: (...a: unknown[]) => loadRunView(...a),
}))

const { PUT } = await import('@/app/api/checklists/lines/[id]/route')

const req = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest
const call = (body: unknown) => PUT(req(body), { params: { id: 'l1' } })

const baseLine = (over: Record<string, unknown> = {}, runStatus = 'OPEN') => ({
  id: 'l1', runId: 'r1', answer: 'TICK', safeMin: null, safeMax: null, tempUnitId: null, tempReadingId: null,
  run: { status: runStatus, businessDate: '2026-10-29', station: { revenueCenterId: 'rc1', isShared: false } },
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  lineUpdate.mockResolvedValue({ count: 1 })
  lineFindUnique.mockResolvedValue(baseLine())
  loadRunView.mockResolvedValue({
    id: 'r1',
    lines: [{ id: 'l1', status: 'DONE', isBlocker: true }, { id: 'l2', status: 'TODO', isBlocker: true }],
  })
})

describe('PUT /api/checklists/lines/[id]', () => {
  it('ticks a line and returns it with progress', async () => {
    const res = await call({ action: 'tick' })
    expect(res.status).toBe(200)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(lineUpdate).toHaveBeenCalledTimes(1)
    expect(lineUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: 'l1', run: { status: 'OPEN' } }, data: { status: 'DONE', doneById: 'u1', doneByName: 'Sam Lee' },
    })
    const json = await res.json()
    expect(json.line.id).toBe('l1')
    expect(json.progress).toMatchObject({ handled: 1, total: 2, blockersLeft: 1 })
    expect(readingUpsert).not.toHaveBeenCalled()
    expect(readingDelete).not.toHaveBeenCalled()
    expect(lineUpdate.mock.calls[0][0].data).not.toHaveProperty('tempReadingId')
  })

  it('404 when the line is gone', async () => {
    lineFindUnique.mockResolvedValue(null)
    const res = await call({ action: 'tick' })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Job not found')
  })

  it('409 on a signed run and writes nothing', async () => {
    lineFindUnique.mockResolvedValue(baseLine({}, 'SIGNED'))
    const res = await call({ action: 'tick' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Signed off — ask a lead to reopen')
    expect(transaction).not.toHaveBeenCalled()
    expect(lineUpdate).not.toHaveBeenCalled()
  })

  it('403 when the kitchen is out of scope and writes nothing', async () => {
    assertRcWritable.mockRejectedValueOnce(new MockAuthError(403, 'Revenue center is outside your access.'))
    const res = await call({ action: 'tick' })
    expect(res.status).toBe(403)
    expect(transaction).not.toHaveBeenCalled()
    expect(lineUpdate).not.toHaveBeenCalled()
  })

  const tempLine = (over: Record<string, unknown> = {}) =>
    baseLine({ answer: 'TEMP', safeMin: 0, safeMax: 4, tempUnitId: 'u1', ...over })

  it('a first TEMP answer writes a Temps row and stores its id on the line, in one transaction', async () => {
    lineFindUnique.mockResolvedValue(tempLine())
    const res = await call({ action: 'value', raw: '3.5' })
    expect(res.status).toBe(200)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(readingUpsert).toHaveBeenCalledTimes(1)
    const { where, create, update } = readingUpsert.mock.calls[0][0] as {
      where: { id: string }; create: Record<string, unknown>; update: Record<string, unknown>
    }
    expect(create).toMatchObject({ id: where.id, unitId: 'u1', logDate: '2026-10-29', temp: 3.5, recordedBy: 'Sam Lee' })
    expect(create.time).toMatch(/^\d{2}:\d{2}$/)
    expect(update).toMatchObject({ unitId: 'u1', temp: 3.5 })
    expect(lineUpdate.mock.calls[0][0].data).toMatchObject({ status: 'DONE', value: 3.5, tempReadingId: where.id })
    expect(readingDelete).not.toHaveBeenCalled()
  })

  it('correcting a TEMP reading updates the same Temps row (no second one)', async () => {
    lineFindUnique.mockResolvedValue(tempLine({ tempReadingId: 'tr1', status: 'FLAGGED', value: 35 }))
    await call({ action: 'value', raw: '3.5' })
    const arg = readingUpsert.mock.calls[0][0] as { where: { id: string }; create: { id: string }; update: Record<string, unknown> }
    expect(arg.where.id).toBe('tr1')
    expect(arg.create.id).toBe('tr1')
    expect(arg.update).toMatchObject({ temp: 3.5, recordedBy: 'Sam Lee', logDate: '2026-10-29' })
    expect(lineUpdate.mock.calls[0][0].data).toMatchObject({ value: 3.5, tempReadingId: 'tr1' })
    expect(readingDelete).not.toHaveBeenCalled()
  })

  it('an out-of-range TEMP is flagged and still logged', async () => {
    lineFindUnique.mockResolvedValue(tempLine())
    await call({ action: 'value', raw: '9' })
    expect(lineUpdate.mock.calls[0][0].data).toMatchObject({ status: 'FLAGGED', flagReason: 'OUT_OF_RANGE', value: 9 })
    expect(readingUpsert.mock.calls[0][0]).toMatchObject({ create: { temp: 9 } })
  })

  it('untick deletes the Temps row and clears the id', async () => {
    lineFindUnique.mockResolvedValue(tempLine({ tempReadingId: 'tr1', status: 'DONE', value: 3.5 }))
    const res = await call({ action: 'untick' })
    expect(res.status).toBe(200)
    expect(lineUpdate.mock.calls[0][0].data).toMatchObject({ status: 'TODO', value: null, tempReadingId: null })
    expect(readingDelete).toHaveBeenCalledWith({ where: { id: 'tr1' } })
    expect(readingUpsert).not.toHaveBeenCalled()
  })

  it('flagging a TEMP line without a reading deletes the Temps row too', async () => {
    lineFindUnique.mockResolvedValue(tempLine({ tempReadingId: 'tr1', status: 'DONE', value: 3.5 }))
    await call({ action: 'flag', reason: 'BROKEN', note: 'probe dead' })
    expect(lineUpdate.mock.calls[0][0].data).toMatchObject({ status: 'FLAGGED', flagReason: 'BROKEN', value: null, tempReadingId: null })
    expect(readingDelete).toHaveBeenCalledWith({ where: { id: 'tr1' } })
  })

  it('untick with no Temps row to remove deletes nothing', async () => {
    lineFindUnique.mockResolvedValue(tempLine())
    await call({ action: 'untick' })
    expect(readingDelete).not.toHaveBeenCalled()
  })

  it('409 and no Temps write when the run is signed off after the first check', async () => {
    lineFindUnique.mockResolvedValue(tempLine())
    lineUpdate.mockResolvedValueOnce({ count: 0 })
    const res = await call({ action: 'value', raw: '3' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Signed off — ask a lead to reopen')
    expect(readingUpsert).not.toHaveBeenCalled()
    expect(loadRunView).not.toHaveBeenCalled()
  })

  it('a NUMBER line writes no Temps row', async () => {
    lineFindUnique.mockResolvedValue(baseLine({ answer: 'NUMBER', safeMax: 4 }))
    await call({ action: 'value', raw: '3' })
    expect(readingUpsert).not.toHaveBeenCalled()
  })

  it('400 "Enter a number" for text, nothing written', async () => {
    lineFindUnique.mockResolvedValue(baseLine({ answer: 'TEMP', tempUnitId: 'u1' }))
    const res = await call({ action: 'value', raw: 'abc' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Enter a number')
    expect(transaction).not.toHaveBeenCalled()
    expect(readingUpsert).not.toHaveBeenCalled()
  })

  it('400 "Pick a reason" for a flag without one', async () => {
    const res = await call({ action: 'flag', reason: 'OUT_OF_RANGE' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Pick a reason')
  })

  it('400 for an unreadable body', async () => {
    const res = await PUT({ json: async () => { throw new Error('bad') } } as unknown as NextRequest, { params: { id: 'l1' } })
    expect(res.status).toBe(400)
  })
})
