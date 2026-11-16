import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// PUT /api/prep/logs/[id] — the cook-along cursor (src/lib/prep-steps.ts).
// Stubbed Prisma: asserts what the handler WRITES for a step / stage move, not
// real table state.

const METHOD = [
  { key: 's1', text: 'Mix', phase: 'Mix', minutes: 5, wait: { minutes: 30 } },
  { key: 's2', text: 'Shape', phase: 'Shape', minutes: 5 },
  { key: 's3', text: 'Bake', phase: 'Bake', minutes: 10 },
]

type Row = Record<string, unknown>
let existing: Row
const prepLogFindUnique = vi.fn(async () => existing)
const prepLogUpdate = vi.fn(async (a: { where: { id: string }; data: Row }) => ({ id: a.where.id, ...existing, ...a.data }))
const prepItemFindUnique = vi.fn(async () => ({ linkedRecipe: { stages: null, method: METHOD } }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    prepLog: {
      findUnique: (...a: unknown[]) => prepLogFindUnique(...(a as [])),
      update: (...a: unknown[]) => prepLogUpdate(...(a as [never])),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    prepItem: { findUnique: (...a: unknown[]) => prepItemFindUnique(...(a as [])), update: vi.fn(async () => ({})) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => ({ id: 'u1', role: 'STAFF', isActive: true })),
  AuthError: class extends Error { status = 401 },
}))
vi.mock('@/lib/theoretical-cache', () => ({ invalidateTheoreticalCache: vi.fn() }))
vi.mock('@/lib/prep-plan-server', () => ({
  markPlanDirty: vi.fn(async () => {}),
  prepDayStart: () => new Date('2026-11-16T08:00:00.000Z'),
  postedOpenWhere: {},
}))

const { PUT } = await import('@/app/api/prep/logs/[id]/route')
const put = (body: unknown) => PUT({ json: async () => body } as unknown as NextRequest, { params: { id: 'log-1' } })
const written = () => prepLogUpdate.mock.calls[0]?.[0].data as Row | undefined

beforeEach(() => {
  vi.clearAllMocks()
  existing = {
    id: 'log-1', prepItemId: 'item-1', status: 'IN_PROGRESS', logDate: new Date('2026-11-16T08:00:00.000Z'),
    startedAt: new Date('2026-11-16T17:00:00.000Z'), stageIndex: 0, stageEnteredAt: new Date('2026-11-16T17:00:00.000Z'),
    stageHistory: [], stepKey: 's1', stepEnteredAt: new Date('2026-11-16T17:00:00.000Z'), assignedTo: null, revenueCenterId: 'rc-1',
  }
})

describe('PUT step move — a stale screen cannot move a job backwards', () => {
  it('moves when it starts from where the job is', async () => {
    const res = await put({ stepKey: 's1:wait', fromStepKey: 's1' })
    expect(res.status).toBe(200)
    expect(written()).toMatchObject({ stepKey: 's1:wait', stageIndex: 1 })
  })
  it('409 and no write when another screen already moved it', async () => {
    existing.stepKey = 's2'
    const res = await put({ stepKey: 's1:wait', fromStepKey: 's1' })
    expect(res.status).toBe(409)
    expect(prepLogUpdate).not.toHaveBeenCalled()
  })
  it('a repeat of the same move is a harmless no-op', async () => {
    existing.stepKey = 's1:wait'
    const res = await put({ stepKey: 's1:wait', fromStepKey: 's1' })
    expect(res.status).toBe(200)
    expect(prepLogUpdate).not.toHaveBeenCalled()
  })
  it('409 on a job already finished', async () => {
    existing.status = 'DONE'
    const res = await put({ stepKey: 's2', fromStepKey: 's1' })
    expect(res.status).toBe(409)
  })
})

describe('PUT step move — an offline tap keeps its time', () => {
  it('stamps the tap time, not the reconnect time', async () => {
    const at = '2026-11-16T17:20:00.000Z'
    await put({ stepKey: 's1:wait', fromStepKey: 's1', at })
    expect((written()!.stepEnteredAt as Date).toISOString()).toBe(at)
    expect((written()!.stageEnteredAt as Date).toISOString()).toBe(at)
  })
})

describe('PUT stage move (old screens / queued moves) — the step cursor follows', () => {
  it('clears the saved step so the job reads from its new block', async () => {
    prepItemFindUnique.mockResolvedValueOnce({ linkedRecipe: { stages: null, method: METHOD } })
    await put({ stageIndex: 1 })
    expect(written()).toMatchObject({ stageIndex: 1, stepKey: null, stepEnteredAt: null })
  })
})
