import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { ROLE_RANK } from '@/lib/roles'

// The "change how it's measured" routes (Stage 2c): preview / apply on
// POST /api/inventory/[id]/remeasure, the undoable list on GET, and
// POST /api/inventory/remeasures/[id]/undo. The exec module is mocked — these
// tests pin the HTTP contract: role gate, body validation, refusal mapping.

type Role = keyof typeof ROLE_RANK

class MockRefusal extends Error {
  constructor(public code: string, message: string, public details?: string[]) { super(message); this.name = 'RemeasureRefusal' }
}

const SUMMARY = {
  from: { dimension: 'COUNT', unit: 'each', packLabel: 'case (12 each)', priceLabel: '$40.00 per case', countUnit: 'case' },
  to: { dimension: 'MASS', unit: 'g', packLabel: 'case (12 × 150g)', priceLabel: '$40.00 per case', countUnit: 'case' },
  boxes: [], counts: { n: 1, converted: 1, reread: 0, scaled: 0 }, receipts: { n: 1, converted: 1, reread: 0, scaled: 0 }, transfers: 0, recipes: 0, wastage: 0, warnings: [],
}
const PLAN = { k: 150, summary: SUMMARY, receipts: [{ id: 'r1' }], counts: [{ id: 'c1' }], boxes: [{ id: 'b1' }], transfers: [], sessions: [] }

const previewRemeasure = vi.fn(async (..._a: unknown[]) => PLAN)
const applyRemeasure = vi.fn(async (..._a: unknown[]) => ({ remeasureId: 'rm1', plan: PLAN }))
const listRemeasures = vi.fn(async (_id: string) => [
  { id: 'rm1', changedAt: new Date('2026-10-04T12:00:00Z'), from: { dimension: 'COUNT', unit: 'each' }, to: { dimension: 'MASS', unit: 'g' }, canUndo: true, reason: null },
])
const undoRemeasure = vi.fn(async (_id: string) => {})
vi.mock('@/lib/remeasure-exec', () => ({
  previewRemeasure: (...a: unknown[]) => previewRemeasure(...a),
  applyRemeasure: (...a: unknown[]) => applyRemeasure(...a),
  listRemeasures: (id: string) => listRemeasures(id),
  undoRemeasure: (id: string) => undoRemeasure(id),
  RemeasureRefusal: MockRefusal,
}))

let currentRole: Role = 'MANAGER'
class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError' }
}
const requireSession = vi.fn(async (min?: Role) => {
  if (min && ROLE_RANK[currentRole] < ROLE_RANK[min]) throw new MockAuthError(403, 'Forbidden')
  return { id: 'u1', name: 'Josh', email: 'j@x', role: currentRole, isActive: true }
})
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [Role?])),
  AuthError: MockAuthError,
}))

const route = await import('@/app/api/inventory/[id]/remeasure/route')
const undo = await import('@/app/api/inventory/remeasures/[id]/undo/route')

const req = (body: unknown) =>
  ({ url: 'http://x/api/inventory/i1/remeasure', json: async () => body }) as unknown as NextRequest
const ctx = { params: { id: 'i1' } }
const undoCtx = { params: { id: 'rm1' } }
const TO_WEIGHT = { to: { dimension: 'MASS', unit: 'g' }, bridge: { eachQty: 150, eachUnit: 'g' } }

beforeEach(() => {
  for (const f of [previewRemeasure, applyRemeasure, listRemeasures, undoRemeasure, requireSession]) f.mockClear()
})
afterEach(() => { currentRole = 'MANAGER' })

describe('role gate', () => {
  it('LEAD gets 403 on all three, and nothing runs', async () => {
    currentRole = 'LEAD'
    expect((await route.GET(req(null), ctx)).status).toBe(403)
    expect((await route.POST(req(TO_WEIGHT), ctx)).status).toBe(403)
    expect((await undo.POST(req(null), undoCtx)).status).toBe(403)
    expect(previewRemeasure).not.toHaveBeenCalled()
    expect(listRemeasures).not.toHaveBeenCalled()
    expect(undoRemeasure).not.toHaveBeenCalled()
  })
})

describe('GET /api/inventory/[id]/remeasure', () => {
  it('returns the undoable changes', async () => {
    const res = await route.GET(req(null), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(listRemeasures).toHaveBeenCalledWith('i1')
    expect(body.changes).toHaveLength(1)
    expect(body.changes[0]).toMatchObject({ id: 'rm1', canUndo: true, reason: null, from: { dimension: 'COUNT' }, to: { dimension: 'MASS' } })
  })

  it('a failed load is a 500 that says so', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    listRemeasures.mockRejectedValueOnce(new Error('db down'))
    const res = await route.GET(req(null), ctx)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Could not load the measure history.' })
    spy.mockRestore()
  })
})

describe('POST /api/inventory/[id]/remeasure — preview', () => {
  it('returns the summary and k, never the row lists', async () => {
    const res = await route.POST(req(TO_WEIGHT), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, plan: { k: 150, summary: SUMMARY } })
    expect(JSON.stringify(body)).not.toContain('"receipts":[')
    expect(previewRemeasure).toHaveBeenCalledWith('i1', { dimension: 'MASS', unit: 'g' }, { eachQty: 150, eachUnit: 'g', densityGPerMl: null })
    expect(applyRemeasure).not.toHaveBeenCalled()
  })

  it('a unit of the wrong measure is 400 BAD_FIELD (lb as pieces)', async () => {
    const res = await route.POST(req({ to: { dimension: 'COUNT', unit: 'lb' }, bridge: { eachQty: 150, eachUnit: 'g' } }), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Reload the item and try again.', code: 'BAD_FIELD' })
    expect(previewRemeasure).not.toHaveBeenCalled()
  })

  it('pieces means each only; an unknown dimension or a non-finite bridge is BAD_FIELD', async () => {
    for (const body of [
      { to: { dimension: 'COUNT', unit: 'case' } },
      { to: { dimension: 'WEIGHT', unit: 'g' } },
      { to: { dimension: 'MASS', unit: 'ml' } },
      { to: { dimension: 'MASS', unit: 'zz' } },
      { to: { dimension: 'MASS', unit: 'g' }, bridge: { eachQty: 'lots', eachUnit: 'g' } },
      { to: { dimension: 'VOLUME', unit: 'l' }, bridge: { densityGPerMl: Infinity } },
      null,
    ]) {
      const res = await route.POST(req(body), ctx)
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('BAD_FIELD')
    }
    expect(previewRemeasure).not.toHaveBeenCalled()
  })

  it('a refusal comes back with its own code and status', async () => {
    previewRemeasure.mockRejectedValueOnce(new MockRefusal('NEEDS_BRIDGE', 'Tell the app how much one piece weighs first — for example 1 each = 150 g.'))
    const res = await route.POST(req(TO_WEIGHT), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Tell the app how much one piece weighs first — for example 1 each = 150 g.', code: 'NEEDS_BRIDGE' })
  })

  it('INVALID carries the first error as its sentence and the full list in details', async () => {
    previewRemeasure.mockRejectedValueOnce(new MockRefusal('INVALID', "This change can't be applied: Bad chain.", ['bad chain.', 'Sysco: worse chain']))
    const res = await route.POST(req(TO_WEIGHT), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "This change can't be applied: Bad chain.", code: 'INVALID', details: ['bad chain.', 'Sysco: worse chain'],
    })
  })

  it('an unknown error is a 500 that says nothing changed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    previewRemeasure.mockRejectedValueOnce(new Error('boom'))
    const res = await route.POST(req(TO_WEIGHT), ctx)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('The measure change could not be completed. Nothing was changed.')
    spy.mockRestore()
  })
})

describe('POST /api/inventory/[id]/remeasure — apply', () => {
  it('apply without expectedLastUpdated is 400 BAD_FIELD', async () => {
    const res = await route.POST(req({ ...TO_WEIGHT, apply: true }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('BAD_FIELD')
    expect(applyRemeasure).not.toHaveBeenCalled()
  })

  it('applies with the version and the person, and returns the id + summary', async () => {
    const stamp = '2026-10-04T11:00:00.000Z'
    const res = await route.POST(req({ ...TO_WEIGHT, apply: true, expectedLastUpdated: stamp }), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, remeasureId: 'rm1', summary: SUMMARY })
    expect(applyRemeasure).toHaveBeenCalledWith({
      itemId: 'i1', to: { dimension: 'MASS', unit: 'g' }, bridge: { eachQty: 150, eachUnit: 'g', densityGPerMl: null },
      expectedLastUpdated: stamp, userId: 'u1',
    })
    expect(previewRemeasure).not.toHaveBeenCalled()
  })

  it('STALE from the exec is a 409 with its code', async () => {
    applyRemeasure.mockRejectedValueOnce(new MockRefusal('STALE', 'Someone changed this item a moment ago. Reload to see their change before changing its measure.'))
    const res = await route.POST(req({ ...TO_WEIGHT, apply: true, expectedLastUpdated: '2026-10-04T11:00:00.000Z' }), ctx)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'Someone changed this item a moment ago. Reload to see their change before changing its measure.', code: 'STALE',
    })
  })

  it('maps the other refusals to their statuses', async () => {
    const cases: [string, number][] = [
      ['NOT_FOUND', 404], ['PREP_OWNED', 409], ['TOMBSTONE', 409], ['OPEN_COUNT', 409],
      ['SAME_MEASURE', 400], ['NEEDS_BRIDGE', 400], ['INVALID', 400],
    ]
    for (const [code, status] of cases) {
      previewRemeasure.mockRejectedValueOnce(new MockRefusal(code, 'x'))
      const res = await route.POST(req(TO_WEIGHT), ctx)
      expect(res.status, code).toBe(status)
      expect((await res.json()).code).toBe(code)
    }
  })
})

describe('POST /api/inventory/remeasures/[id]/undo', () => {
  it('undoes and returns ok', async () => {
    const res = await undo.POST(req(null), undoCtx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(undoRemeasure).toHaveBeenCalledWith('rm1')
  })

  it('UNDO_UNSAFE is a 409 with the sentence', async () => {
    undoRemeasure.mockRejectedValueOnce(new MockRefusal('UNDO_UNSAFE', 'A count was recorded since — undo is no longer safe.'))
    const res = await undo.POST(req(null), undoCtx)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'A count was recorded since — undo is no longer safe.', code: 'UNDO_UNSAFE' })
  })

  it('an already-undone change is a 404', async () => {
    undoRemeasure.mockRejectedValueOnce(new MockRefusal('NOT_FOUND', 'That change was already undone.'))
    const res = await undo.POST(req(null), undoCtx)
    expect(res.status).toBe(404)
  })
})
