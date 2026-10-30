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
const lineUpdate = vi.fn(async (a: unknown) => a)
const readingCreate = vi.fn(async (a: unknown) => a)
const loadRunView = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    checklistRunLine: {
      findUnique: (...a: unknown[]) => lineFindUnique(...a),
      update: (...a: unknown[]) => lineUpdate(...a),
    },
    tempReading: { create: (...a: unknown[]) => readingCreate(...a) },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
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
  id: 'l1', runId: 'r1', answer: 'TICK', safeMin: null, safeMax: null, tempUnitId: null,
  run: { status: runStatus, businessDate: '2026-10-29', station: { revenueCenterId: 'rc1', isShared: false } },
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
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
    expect(lineUpdate).toHaveBeenCalledTimes(1)
    expect(lineUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: 'l1' }, data: { status: 'DONE', doneById: 'u1', doneByName: 'Sam Lee' },
    })
    const json = await res.json()
    expect(json.line.id).toBe('l1')
    expect(json.progress).toMatchObject({ handled: 1, total: 2, blockersLeft: 1 })
    expect(readingCreate).not.toHaveBeenCalled()
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
    expect(lineUpdate).not.toHaveBeenCalled()
  })

  it('403 when the kitchen is out of scope and writes nothing', async () => {
    assertRcWritable.mockRejectedValueOnce(new MockAuthError(403, 'Revenue center is outside your access.'))
    const res = await call({ action: 'tick' })
    expect(res.status).toBe(403)
    expect(lineUpdate).not.toHaveBeenCalled()
  })

  it('a TEMP reading also writes a Temps log row', async () => {
    lineFindUnique.mockResolvedValue(baseLine({ answer: 'TEMP', safeMin: 0, safeMax: 4, tempUnitId: 'u1' }))
    const res = await call({ action: 'value', raw: '3.5' })
    expect(res.status).toBe(200)
    expect(lineUpdate.mock.calls[0][0].data).toMatchObject({ status: 'DONE', value: 3.5 })
    expect(readingCreate).toHaveBeenCalledTimes(1)
    const data = readingCreate.mock.calls[0][0].data
    expect(data).toMatchObject({ unitId: 'u1', logDate: '2026-10-29', temp: 3.5, recordedBy: 'Sam Lee' })
    expect(data.time).toMatch(/^\d{2}:\d{2}$/)
  })

  it('an out-of-range TEMP is flagged and still logged', async () => {
    lineFindUnique.mockResolvedValue(baseLine({ answer: 'TEMP', safeMin: 0, safeMax: 4, tempUnitId: 'u1' }))
    await call({ action: 'value', raw: '9' })
    expect(lineUpdate.mock.calls[0][0].data).toMatchObject({ status: 'FLAGGED', flagReason: 'OUT_OF_RANGE', value: 9 })
    expect(readingCreate.mock.calls[0][0].data).toMatchObject({ temp: 9 })
  })

  it('a NUMBER line writes no Temps row', async () => {
    lineFindUnique.mockResolvedValue(baseLine({ answer: 'NUMBER', safeMax: 4 }))
    await call({ action: 'value', raw: '3' })
    expect(readingCreate).not.toHaveBeenCalled()
  })

  it('400 "Enter a number" for text, nothing written', async () => {
    lineFindUnique.mockResolvedValue(baseLine({ answer: 'TEMP', tempUnitId: 'u1' }))
    const res = await call({ action: 'value', raw: 'abc' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Enter a number')
    expect(lineUpdate).not.toHaveBeenCalled()
    expect(readingCreate).not.toHaveBeenCalled()
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
