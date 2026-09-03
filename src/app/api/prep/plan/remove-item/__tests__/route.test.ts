import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Same vi.mock-of-Prisma pattern as src/app/api/prep/cooks/__tests__/route.test.ts,
// but with an in-memory store instead of canned rows: this route's whole job is a
// sequence of conditional writes, so the assertions are about what the tables look
// like afterwards, not about a response body.
//
// `livePost` and `ensureLiveLogs` are stubbed; everything else in
// @/lib/prep-plan-server (notably `postedOpenWhere`) is the real module.

type Row = Record<string, any>

const DAY = 86_400_000
const TODAY = new Date('2026-09-02T00:00:00.000Z')
const YESTERDAY = new Date(TODAY.getTime() - DAY)

interface Store { items: Row[]; logs: Row[]; posts: Row[] }
const db: Store = { items: [], logs: [], posts: [] }

// Prisma `where` semantics, only the operators this route actually uses.
function matchWhere(row: Row, where: Row | undefined): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === 'OR') {
      if (!(v as Row[]).some(w => matchWhere(row, w))) return false
      continue
    }
    const rv = row[k]
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const cond = v as Row
      if ('not' in cond) {
        if (cond.not === null ? rv === null || rv === undefined : rv === cond.not) return false
      }
      if ('in' in cond && !(cond.in as unknown[]).includes(rv)) return false
    } else if (rv !== v) return false
  }
  return true
}

function applySelect(row: Row, select?: Row): Row {
  if (!select) return row
  const out: Row = {}
  for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k]
  return out
}

const itemFindUnique = vi.fn(async (args: Row) => {
  const row = db.items.find(i => i.id === args.where.id)
  return row ? applySelect(row, args.select) : null
})
const itemFindMany = vi.fn(async (args: Row) =>
  db.items.filter(i => matchWhere(i, args?.where)).map(i => applySelect(i, args?.select)),
)
const itemUpdate = vi.fn(async (args: Row) => {
  const row = db.items.find(i => i.id === args.where.id)
  if (!row) throw new Error('P2025')
  Object.assign(row, args.data)
  return row
})
const logFindFirst = vi.fn(async (args: Row) => {
  const rows = db.logs.filter(l => matchWhere(l, args?.where))
  if (args?.orderBy?.logDate === 'desc') {
    rows.sort((a, b) => new Date(b.logDate).getTime() - new Date(a.logDate).getTime())
  }
  return rows[0] ? applySelect(rows[0], args.select) : null
})
const logUpdate = vi.fn(async (args: Row) => {
  const row = db.logs.find(l => l.id === args.where.id)
  if (!row) throw new Error('P2025')
  Object.assign(row, args.data)
  return row
})
const logUpdateMany = vi.fn(async (args: Row) => {
  const rows = db.logs.filter(l => matchWhere(l, args?.where))
  for (const r of rows) Object.assign(r, args.data)
  return { count: rows.length }
})
const postUpdate = vi.fn(async (args: Row) => {
  const row = db.posts.find(p => p.id === args.where.id)
  if (!row) throw new Error('P2025 — no PrepPost')
  Object.assign(row, args.data)
  return row
})
const postUpdateMany = vi.fn(async (args: Row) => {
  const rows = db.posts.filter(p => matchWhere(p, args?.where))
  for (const r of rows) Object.assign(r, args.data)
  return { count: rows.length }
})

const prismaMock = {
  prepItem: { findUnique: itemFindUnique, findMany: itemFindMany, update: itemUpdate },
  prepLog: { findFirst: logFindFirst, update: logUpdate, updateMany: logUpdateMany },
  prepPost: { update: postUpdate, updateMany: postUpdateMany },
  $transaction: async (arg: unknown) => {
    if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prismaMock)
    return Promise.all(arg as Promise<unknown>[])
  },
}

const requireSession = vi.fn(async () => ({ id: 'u1', role: 'LEAD', isActive: true }))
const assertRcWritable = vi.fn(async () => {})
const livePost = vi.fn(async (rcId: string) => db.posts.find(p => p.revenueCenterId === rcId) ?? null)
// Stands in for the real primitive: it mints today's NOT_STARTED row, which is
// exactly the behaviour the restore path must AVOID for a carried open job.
const ensureLiveLogs = vi.fn(async (ids: string[], revenueCenterId: string) => {
  const map = new Map<string, string>()
  for (const prepItemId of ids) {
    const id = `minted-${prepItemId}`
    db.logs.push({ id, prepItemId, revenueCenterId, logDate: TODAY, status: 'NOT_STARTED', postedAt: null })
    map.set(prepItemId, id)
  }
  return map
})

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({ assertRcWritable: (...a: unknown[]) => assertRcWritable(...(a as [])) }))
vi.mock('@/lib/prep-plan-server', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/prep-plan-server')>()
  return {
    ...actual,
    livePost: (...a: unknown[]) => livePost(...(a as [string])),
    ensureLiveLogs: (...a: unknown[]) => ensureLiveLogs(...(a as [string[], string])),
  }
})

const { POST } = await import('@/app/api/prep/plan/remove-item/route')

const req = (body: Row) => ({ json: async () => body }) as unknown as NextRequest

const CAFE = 'rc-cafe'
const CATERING = 'rc-catering'

// A Cafe draft of three visible items: two Cafe-owned, one Shared. `i-catering`
// belongs to another center and `i-inactive` is archived — neither counts.
// Hands-on total = 20 + 30 + 15 (the Shared item resolves its minutes from its
// linked recipe, not estimatedPrepTime) = 65.
function seedDraft() {
  db.items = [
    { id: 'i-brisket', revenueCenterId: CAFE, isActive: true, isOnList: true, estimatedPrepTime: 20, activeMinutesOverride: null, passiveMinutesOverride: null, passiveNoteOverride: null, linkedRecipe: null },
    { id: 'i-stock', revenueCenterId: CAFE, isActive: true, isOnList: true, estimatedPrepTime: 30, activeMinutesOverride: null, passiveMinutesOverride: null, passiveNoteOverride: null, linkedRecipe: null },
    { id: 'i-shared', revenueCenterId: null, isActive: true, isOnList: true, estimatedPrepTime: 10, activeMinutesOverride: null, passiveMinutesOverride: null, passiveNoteOverride: null, linkedRecipe: { activeMinutes: 15, passiveMinutes: 0, passiveNote: null } },
    { id: 'i-catering', revenueCenterId: CATERING, isActive: true, isOnList: true, estimatedPrepTime: 99, activeMinutesOverride: null, passiveMinutesOverride: null, passiveNoteOverride: null, linkedRecipe: null },
    { id: 'i-inactive', revenueCenterId: CAFE, isActive: false, isOnList: true, estimatedPrepTime: 99, activeMinutesOverride: null, passiveMinutesOverride: null, passiveNoteOverride: null, linkedRecipe: null },
  ]
  db.posts = [{ id: 'p1', revenueCenterId: CAFE, listDate: TODAY, itemCount: 3, activeMinutes: 65, dirty: false, postedByName: 'Chef' }]
  db.logs = []
}

const log = (over: Row): Row => ({
  id: 'l1', prepItemId: 'i-brisket', revenueCenterId: CAFE,
  logDate: TODAY, status: 'NOT_STARTED', postedAt: new Date('2026-09-01T23:00:00.000Z'),
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  seedDraft()
})

describe('POST /api/prep/plan/remove-item — removal', () => {
  it('un-posts the item, takes it off the draft, and rewrites the header from what is left', async () => {
    db.logs = [log({})]
    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(res.status).toBe(200)

    expect(db.logs[0].postedAt).toBeNull()
    expect(db.items.find(i => i.id === 'i-brisket')!.isOnList).toBe(false)
    // 3 → 2 items, 65 → 45 minutes (the removed item was worth 20).
    expect(db.posts[0]).toMatchObject({ itemCount: 2, activeMinutes: 45 })
    // The header must never be written with `update`: a concurrent Recall
    // deletes the row, and P2025 would 500 a removal that already succeeded.
    expect(postUpdate).not.toHaveBeenCalled()
    expect(postUpdateMany).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — a second removal (a retry, or an offline-queue replay) does not move the counters again', async () => {
    db.logs = [log({})]
    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(db.posts[0]).toMatchObject({ itemCount: 2, activeMinutes: 45 })

    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(res.status).toBe(200)
    expect(db.posts[0]).toMatchObject({ itemCount: 2, activeMinutes: 45 })
  })

  it('clears a Shared item\'s log even when another center last wrote its revenueCenterId', async () => {
    // PrepLog is keyed (prepItemId, logDate): a Shared item has ONE row, and a
    // Catering cook starting the job flips that row's RC to Catering. The Cafe
    // chef's × still has to take it off the list.
    db.logs = [log({ id: 'l-shared', prepItemId: 'i-shared', revenueCenterId: CATERING })]
    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-shared' }))
    expect(res.status).toBe(200)

    expect(db.logs[0].postedAt).toBeNull()
    // The where must not carry an RC filter for a Shared item.
    expect(logUpdateMany.mock.calls[0][0].where).not.toHaveProperty('revenueCenterId')
    expect(logUpdateMany.mock.calls[0][0].where).toMatchObject({ prepItemId: 'i-shared' })
    expect(db.posts[0]).toMatchObject({ itemCount: 2, activeMinutes: 50 })
  })

  it('still scopes an RC-owned item\'s log by revenue center', async () => {
    db.logs = [log({})]
    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(logUpdateMany.mock.calls[0][0].where).toMatchObject({ revenueCenterId: CAFE, prepItemId: 'i-brisket' })
  })

  it('leaves a resolved (DONE) log posted — postedOpenWhere still gates the un-post', async () => {
    const posted = new Date('2026-09-01T23:00:00.000Z')
    db.logs = [log({ status: 'DONE', postedAt: posted })]
    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(db.logs[0].postedAt).toEqual(posted)
  })

  it('succeeds when the RC has no posted header at all', async () => {
    db.posts = []
    db.logs = [log({})]
    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(res.status).toBe(200)
    expect(db.logs[0].postedAt).toBeNull()
    expect(db.items.find(i => i.id === 'i-brisket')!.isOnList).toBe(false)
    expect(postUpdateMany).not.toHaveBeenCalled()
    expect(itemFindMany).not.toHaveBeenCalled()
  })

  it('404s an unknown item without writing anything', async () => {
    db.logs = [log({})]
    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'nope' }))
    expect(res.status).toBe(404)
    expect(logUpdateMany).not.toHaveBeenCalled()
    expect(postUpdateMany).not.toHaveBeenCalled()
  })
})

describe('POST /api/prep/plan/remove-item — restore', () => {
  it('re-stamps a carried, still-open row rather than minting a fresh one', async () => {
    // The cook is part-way through a brisket carried from last night. The ×
    // cleared postedAt, so isLiveLog no longer recognises the row — Undo must
    // not hand the job back unstarted with the timer, claim and qty orphaned.
    db.items.find(i => i.id === 'i-brisket')!.isOnList = false
    db.logs = [log({
      id: 'l-carried', logDate: YESTERDAY, status: 'IN_PROGRESS', postedAt: null,
      startedAt: new Date('2026-09-01T22:00:00.000Z'), assignedTo: 'c1', requiredQty: 4,
    })]

    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket', restore: true }))
    expect(res.status).toBe(200)

    expect(ensureLiveLogs).not.toHaveBeenCalled()
    expect(db.logs).toHaveLength(1)
    expect(db.logs[0]).toMatchObject({
      id: 'l-carried', status: 'IN_PROGRESS', assignedTo: 'c1', requiredQty: 4,
    })
    expect(db.logs[0].postedAt).not.toBeNull()
    expect(db.items.find(i => i.id === 'i-brisket')!.isOnList).toBe(true)
    expect(db.posts[0]).toMatchObject({ itemCount: 3, activeMinutes: 65 })
  })

  it('falls back to ensureLiveLogs when the newest row is resolved, and never reaches past it', async () => {
    // Made this morning; last night's open posted row still sits underneath.
    // Stamping either would be wrong — the DONE row could then never be
    // un-posted (postedOpenWhere needs an OPEN status), and the older one
    // resurrects a job that was already made.
    db.items.find(i => i.id === 'i-brisket')!.isOnList = false
    db.logs = [
      log({ id: 'l-older-open', logDate: new Date(TODAY.getTime() - 2 * DAY), status: 'NOT_STARTED', postedAt: null }),
      log({ id: 'l-done', logDate: YESTERDAY, status: 'DONE', postedAt: null }),
    ]

    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket', restore: true }))
    expect(res.status).toBe(200)

    expect(ensureLiveLogs).toHaveBeenCalledTimes(1)
    expect(ensureLiveLogs).toHaveBeenCalledWith(['i-brisket'], CAFE)
    expect(logUpdate.mock.calls[0][0].where).toEqual({ id: 'minted-i-brisket' })
    expect(db.logs.find(l => l.id === 'l-older-open')!.postedAt).toBeNull()
    expect(db.logs.find(l => l.id === 'l-done')!.postedAt).toBeNull()
  })

  it('rebuilds the header from the draft instead of incrementing, so remove → restore is a round trip', async () => {
    db.logs = [log({})]
    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(db.posts[0]).toMatchObject({ itemCount: 2, activeMinutes: 45 })

    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket', restore: true }))
    expect(db.posts[0]).toMatchObject({ itemCount: 3, activeMinutes: 65 })

    // And a replayed restore does not walk the counters up.
    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket', restore: true }))
    expect(db.posts[0]).toMatchObject({ itemCount: 3, activeMinutes: 65 })
    expect(postUpdate).not.toHaveBeenCalled()
  })

  it('looks the newest log up without an RC filter for a Shared item', async () => {
    db.items.find(i => i.id === 'i-shared')!.isOnList = false
    db.logs = [log({ id: 'l-shared', prepItemId: 'i-shared', revenueCenterId: CATERING, status: 'IN_PROGRESS', postedAt: null })]

    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-shared', restore: true }))
    expect(res.status).toBe(200)
    expect(logFindFirst.mock.calls[0][0].where).not.toHaveProperty('revenueCenterId')
    expect(ensureLiveLogs).not.toHaveBeenCalled()
    expect(db.logs[0].postedAt).not.toBeNull()
  })
})

describe('POST /api/prep/plan/remove-item — guards', () => {
  it('propagates a 403 from the LEAD guard without touching the tables', async () => {
    requireSession.mockRejectedValueOnce(new MockAuthError(403, 'Forbidden'))
    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(res.status).toBe(403)
    expect(itemFindUnique).not.toHaveBeenCalled()
  })

  it('propagates a 403 from assertRcWritable', async () => {
    assertRcWritable.mockRejectedValueOnce(new MockAuthError(403, 'No access to this revenue center'))
    const res = await POST(req({ revenueCenterId: CATERING, prepItemId: 'i-brisket' }))
    expect(res.status).toBe(403)
    expect(itemFindUnique).not.toHaveBeenCalled()
  })

  it('400s without a revenueCenterId or a prepItemId', async () => {
    expect((await POST(req({ prepItemId: 'i-brisket' }))).status).toBe(400)
    expect((await POST(req({ revenueCenterId: CAFE }))).status).toBe(400)
  })
})
