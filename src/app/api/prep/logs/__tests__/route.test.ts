import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Light vi.mock harness (same shape as src/app/api/prep/cooks/__tests__/route.test.ts),
// not the in-memory store of prep/plan/remove-item — the assertions here are about
// AUTHORIZATION and one side effect (markPlanDirty), not about table state.
//
// The gap under test: `PUT /api/prep/logs/[id]` gates the three planner draft
// fields (requiredQty, listOrder, note) at LEAD, then flags the kitchen's posted
// list dirty. `POST /api/prep/logs` writes the SAME three fields — on both its
// create and its upsert-the-live-log path — behind a bare requireSession(), so
// any authenticated STAFF session could set the planned quantity, the chef's note
// and the run-sheet ordering that the PUT reserves for LEAD, and a queued draft
// edit replayed through the offline queue's `ensureLogId` (which sends the patch
// inline in the POST body) left the post un-dirtied.
//
// What this harness does NOT cover: it stubs Prisma, so it says nothing about the
// real upsert-on-(prepItem, day) semantics, the live-log lookup, or the actual
// dirty flag reaching a PrepPost row. It asserts which role the handler demands,
// that a refused request writes nothing, and whether markPlanDirty is invoked.

type LogRow = Record<string, unknown>

const LIVE_LOG: LogRow = {
  id: 'log-1',
  prepItemId: 'item-1',
  logDate: new Date('2026-09-02T00:00:00.000Z'),
  status: 'NOT_STARTED',
  postedAt: new Date('2026-09-02T00:00:00.000Z'),
  startedAt: null,
}

const prepLogFindFirst = vi.fn(async () => null as LogRow | null)
const prepLogFindUnique = vi.fn(async () => null as LogRow | null)
const prepLogCreate = vi.fn(async (args: { data: LogRow }) => ({ id: 'log-new', ...args.data }))
const prepLogUpdate = vi.fn(async (args: { where: { id: string }; data: LogRow }) => ({
  id: args.where.id,
  ...args.data,
}))
const prepItemFindUnique = vi.fn(async () => ({
  revenueCenterId: 'rc-1',
  unit: 'kg',
  linkedRecipe: null,
}))
const prepItemUpdate = vi.fn(async () => ({}))
const markPlanDirty = vi.fn(async () => {})

const requireSession = vi.fn(async (_role?: string) => ({ id: 'u1', role: 'STAFF', isActive: true }))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    prepLog: {
      findFirst: (...a: unknown[]) => prepLogFindFirst(...(a as [])),
      findUnique: (...a: unknown[]) => prepLogFindUnique(...(a as [])),
      create: (...a: unknown[]) => prepLogCreate(...(a as [never])),
      update: (...a: unknown[]) => prepLogUpdate(...(a as [never])),
    },
    prepItem: {
      findUnique: (...a: unknown[]) => prepItemFindUnique(...(a as [])),
      update: (...a: unknown[]) => prepItemUpdate(...(a as [])),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/prep-plan-server', () => ({
  LIVE_LOG_SELECT: { id: true, prepItemId: true, logDate: true, status: true, postedAt: true },
  markPlanDirty: (...a: unknown[]) => markPlanDirty(...(a as [])),
}))

const { POST } = await import('@/app/api/prep/logs/route')

const req = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest

/** Did the handler ever ask for LEAD? */
const demandedLead = () => requireSession.mock.calls.some(c => c[0] === 'LEAD')

/** Every write this route can make to the database. */
const wrote = () =>
  prepLogCreate.mock.calls.length + prepLogUpdate.mock.calls.length + prepItemUpdate.mock.calls.length

/** Make `requireSession('LEAD')` fail the way a STAFF session does. */
function staffSession() {
  requireSession.mockImplementation(async (role?: string) => {
    if (role === 'LEAD') throw new MockAuthError(403, 'Insufficient permissions')
    return { id: 'u1', role: 'STAFF', isActive: true }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireSession.mockImplementation(async () => ({ id: 'u1', role: 'LEAD', isActive: true }))
  prepLogFindFirst.mockResolvedValue(null)
  prepLogFindUnique.mockResolvedValue(null)
  prepItemFindUnique.mockResolvedValue({ revenueCenterId: 'rc-1', unit: 'kg', linkedRecipe: null })
})

describe('POST /api/prep/logs — planner draft fields are LEAD-only', () => {
  for (const [field, body] of [
    ['requiredQty', { prepItemId: 'item-1', revenueCenterId: 'rc-1', requiredQty: 4 }],
    ['note', { prepItemId: 'item-1', revenueCenterId: 'rc-1', note: 'double batch' }],
    ['listOrder', { prepItemId: 'item-1', revenueCenterId: 'rc-1', listOrder: 3 }],
  ] as const) {
    it(`demands LEAD for a body carrying \`${field}\``, async () => {
      const res = await POST(req(body))
      expect(res.status).toBe(201)
      expect(demandedLead()).toBe(true)
    })

    it(`returns 403 and writes NOTHING when \`${field}\` comes from a STAFF session`, async () => {
      staffSession()
      const res = await POST(req(body))
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Insufficient permissions' })
      expect(wrote()).toBe(0)
      expect(markPlanDirty).not.toHaveBeenCalled()
    })
  }

  it('gates a plan field on the UPDATE path too (the item already has a live log)', async () => {
    prepLogFindFirst.mockResolvedValue(LIVE_LOG)
    staffSession()
    const res = await POST(req({ prepItemId: 'item-1', revenueCenterId: 'rc-1', requiredQty: 9 }))
    expect(res.status).toBe(403)
    expect(prepLogUpdate).not.toHaveBeenCalled()
    expect(wrote()).toBe(0)
  })
})

describe('POST /api/prep/logs — the cook keeps working at STAFF', () => {
  it('a status-only body (Start/Stop on the run sheet) does not demand LEAD', async () => {
    staffSession()
    const res = await POST(req({ prepItemId: 'item-1', revenueCenterId: 'rc-1', status: 'IN_PROGRESS' }))
    expect(res.status).toBe(201)
    expect(demandedLead()).toBe(false)
    expect(prepLogCreate).toHaveBeenCalledTimes(1)
  })

  it('an assignedTo-only body (a cook claiming the job) does not demand LEAD', async () => {
    staffSession()
    const res = await POST(req({ prepItemId: 'item-1', revenueCenterId: 'rc-1', assignedTo: 'cook-3' }))
    expect(res.status).toBe(201)
    expect(demandedLead()).toBe(false)
    expect(prepLogCreate).toHaveBeenCalledTimes(1)
  })

  it('a statusless ensure-a-log create (the offline queue) does not demand LEAD', async () => {
    staffSession()
    const res = await POST(req({ prepItemId: 'item-1', revenueCenterId: 'rc-1' }))
    expect(res.status).toBe(201)
    expect(demandedLead()).toBe(false)
    expect(prepLogCreate).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/prep/logs — the posted list is flagged dirty for a plan edit', () => {
  it('fires markPlanDirty with the log’s revenue center for a plan edit', async () => {
    const res = await POST(req({ prepItemId: 'item-1', revenueCenterId: 'rc-1', requiredQty: 4 }))
    expect(res.status).toBe(201)
    expect(markPlanDirty).toHaveBeenCalledTimes(1)
    expect(markPlanDirty).toHaveBeenCalledWith('rc-1')
  })

  it('fires markPlanDirty on the update path as well', async () => {
    prepLogFindFirst.mockResolvedValue(LIVE_LOG)
    const res = await POST(req({ prepItemId: 'item-1', revenueCenterId: 'rc-1', note: 'hold the salt' }))
    expect(res.status).toBe(201)
    expect(prepLogUpdate).toHaveBeenCalledTimes(1)
    expect(markPlanDirty).toHaveBeenCalledWith('rc-1')
  })

  it('does NOT fire markPlanDirty for a status-only call', async () => {
    await POST(req({ prepItemId: 'item-1', revenueCenterId: 'rc-1', status: 'IN_PROGRESS' }))
    expect(markPlanDirty).not.toHaveBeenCalled()
  })

  it('does NOT fire markPlanDirty for a statusless ensure-a-log call', async () => {
    await POST(req({ prepItemId: 'item-1', revenueCenterId: 'rc-1' }))
    expect(markPlanDirty).not.toHaveBeenCalled()
  })

  it('does NOT fire markPlanDirty for an assignedTo-only claim', async () => {
    await POST(req({ prepItemId: 'item-1', revenueCenterId: 'rc-1', assignedTo: 'cook-3' }))
    expect(markPlanDirty).not.toHaveBeenCalled()
  })
})
