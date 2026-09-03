import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { isLiveLog } from '@/lib/prep-plan'

// Same vi.mock-of-Prisma pattern as src/app/api/prep/cooks/__tests__/route.test.ts,
// but with an in-memory store instead of canned rows: this route's whole job is a
// sequence of conditional writes, so the assertions are about what the tables look
// like afterwards, not about a response body.
//
// `livePostIds` and `ensureLiveLogs` are stubbed; everything else in
// @/lib/prep-plan-server (notably `postedOpenWhere`) is the real module.
//
// KNOWN LIMITS of this harness, stated rather than papered over:
//  1. `$transaction` runs the callback straight through and never rolls back, so
//     NO test here proves atomicity. A failure part-way through a removal would
//     leave the store half-written and every assertion below would still pass.
//  2. `ensureLiveLogs` is a stub. It reproduces the real helper's *decision*
//     (`isLiveLog` on the newest row, mint only when there is none or it is not
//     live) but not its queries — the real one does a groupBy + createMany with
//     skipDuplicates against Postgres.

// A row (or a Prisma call-arg object) in this harness. Deliberately loose — the
// fake tables are built and read by column name — but not `any`: the recursive
// value union still forces a cast wherever the harness does arithmetic or date
// math on a column, which is exactly where a wrong assumption would hide.
type RowValue = string | number | boolean | Date | null | undefined | RowValue[] | Row
type Row = { [key: string]: RowValue }
/** The subset of Prisma call args this harness understands. */
type Args = { where?: Row; data?: Row; select?: Row; orderBy?: Row }

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
      if ('gte' in cond && !((rv as number) >= (cond.gte as number))) return false
    } else if (rv !== v) return false
  }
  return true
}

// Prisma `data` semantics — plain sets plus the atomic number operations the
// header write uses.
function applyData(row: Row, data: Row | undefined) {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const op = v as Row
      if ('increment' in op) { row[k] = ((row[k] as number) ?? 0) + (op.increment as number); continue }
      if ('decrement' in op) { row[k] = ((row[k] as number) ?? 0) - (op.decrement as number); continue }
    }
    row[k] = v
  }
}

function applySelect(row: Row, select?: Row): Row {
  if (!select) return row
  const out: Row = {}
  for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k]
  return out
}

const itemFindUnique = vi.fn(async (args: Args) => {
  const row = db.items.find(i => i.id === args.where?.id)
  return row ? applySelect(row, args.select) : null
})
const itemFindMany = vi.fn(async (args: Args) =>
  db.items.filter(i => matchWhere(i, args?.where)).map(i => applySelect(i, args?.select)),
)
const itemUpdate = vi.fn(async (args: Args) => {
  const row = db.items.find(i => i.id === args.where?.id)
  if (!row) throw new Error('P2025')
  applyData(row, args.data)
  return row
})
const itemUpdateMany = vi.fn(async (args: Args) => {
  const rows = db.items.filter(i => matchWhere(i, args?.where))
  for (const r of rows) applyData(r, args.data)
  return { count: rows.length }
})
const logFindFirst = vi.fn(async (args: Args) => {
  const rows = db.logs.filter(l => matchWhere(l, args?.where))
  if (args?.orderBy?.logDate === 'desc') {
    rows.sort((a, b) => new Date(b.logDate as Date).getTime() - new Date(a.logDate as Date).getTime())
  }
  return rows[0] ? applySelect(rows[0], args.select) : null
})
const logUpdate = vi.fn(async (args: Args) => {
  const row = db.logs.find(l => l.id === args.where?.id)
  if (!row) throw new Error('P2025')
  applyData(row, args.data)
  return row
})
const logUpdateMany = vi.fn(async (args: Args) => {
  const rows = db.logs.filter(l => matchWhere(l, args?.where))
  for (const r of rows) applyData(r, args.data)
  return { count: rows.length }
})
const postUpdate = vi.fn(async (args: Args) => {
  const row = db.posts.find(p => p.id === args.where?.id)
  if (!row) throw new Error('P2025 — no PrepPost')
  applyData(row, args.data)
  return row
})
const postUpdateMany = vi.fn(async (args: Args) => {
  const rows = db.posts.filter(p => matchWhere(p, args?.where))
  for (const r of rows) applyData(r, args.data)
  return { count: rows.length }
})

const prismaMock = {
  prepItem: { findUnique: itemFindUnique, findMany: itemFindMany, update: itemUpdate, updateMany: itemUpdateMany },
  prepLog: { findFirst: logFindFirst, update: logUpdate, updateMany: logUpdateMany },
  prepPost: { update: postUpdate, updateMany: postUpdateMany },
  // NOTE: no rollback. See KNOWN LIMITS at the top of this file.
  $transaction: async (arg: unknown) => {
    if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prismaMock)
    return Promise.all(arg as Promise<unknown>[])
  },
}

const requireSession = vi.fn(async () => ({ id: 'u1', role: 'LEAD', isActive: true }))
const assertRcWritable = vi.fn(async () => {})
// One RC → its own live post. null (a Shared item) → every RC's, which is the
// fan-out `markPlanDirty` already relies on.
const livePostIds = vi.fn(async (rcId: string | null) => {
  if (rcId) {
    const p = db.posts.find(x => x.revenueCenterId === rcId)
    return p ? [p.id] : []
  }
  return db.posts.map(p => p.id)
})
// Reproduces the real primitive's DECISION: the newest row if `isLiveLog` says
// it is live (which is true for ANY of today's rows, resolved or not), else a
// freshly minted NOT_STARTED row for today.
const ensureLiveLogs = vi.fn(async (ids: string[], revenueCenterId: string) => {
  const map = new Map<string, string>()
  for (const prepItemId of ids) {
    const newest = db.logs
      .filter(l => l.prepItemId === prepItemId)
      .sort((a, b) => new Date(b.logDate as Date).getTime() - new Date(a.logDate as Date).getTime())[0]
    if (newest && isLiveLog(newest as never, TODAY.getTime())) {
      map.set(prepItemId, newest.id as string)
      continue
    }
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
    livePostIds: (...a: unknown[]) => livePostIds(...(a as [string | null])),
    ensureLiveLogs: (...a: unknown[]) => ensureLiveLogs(...(a as [string[], string])),
  }
})

const { POST } = await import('@/app/api/prep/plan/remove-item/route')

const req = (body: Row) => ({ json: async () => body }) as unknown as NextRequest

const CAFE = 'rc-cafe'
const CATERING = 'rc-catering'

const item = (over: Row): Row => ({
  revenueCenterId: CAFE, isActive: true, isOnList: true, estimatedPrepTime: 0,
  activeMinutesOverride: null, passiveMinutesOverride: null, passiveNoteOverride: null,
  linkedRecipe: null,
  ...over,
})

// A Cafe list of three items: two Cafe-owned, one Shared. `i-catering` belongs
// to another center and `i-inactive` is archived — neither is on the Cafe list.
// The header was written by a post of those three: 20 + 30 + 15 (the Shared
// item resolves its minutes from its linked recipe) = 65 hands-on minutes.
function seedDraft() {
  db.items = [
    item({ id: 'i-brisket', estimatedPrepTime: 20 }),
    item({ id: 'i-stock', estimatedPrepTime: 30 }),
    item({ id: 'i-shared', revenueCenterId: null, estimatedPrepTime: 10, linkedRecipe: { activeMinutes: 15, passiveMinutes: 0, passiveNote: null } }),
    item({ id: 'i-catering', revenueCenterId: CATERING, estimatedPrepTime: 99 }),
    item({ id: 'i-inactive', isActive: false, estimatedPrepTime: 99 }),
  ]
  db.posts = [{ id: 'p1', revenueCenterId: CAFE, listDate: TODAY, itemCount: 3, activeMinutes: 65, dirty: false, postedByName: 'Chef' }]
  db.logs = []
}

/** Catering has its own posted list — 4 items, 120 minutes. */
function seedCateringPost() {
  db.posts.push({ id: 'p2', revenueCenterId: CATERING, listDate: TODAY, itemCount: 4, activeMinutes: 120, dirty: false, postedByName: 'Chef' })
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
  it('un-posts the item, takes it off the draft, and moves the header by that one item', async () => {
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

  it('describes the POSTED list, not the draft — an unposted next-day addition is not absorbed', async () => {
    // The regression this route must not have: the chef posted 3 items, then
    // added tomorrow's confit to the DRAFT (PrepPost.dirty is exactly this
    // state). Re-deriving the header from the draft would make PostedBand claim
    // 3 items · 85m over a To Do that holds 2 — and silently bill the kitchen
    // for 40 minutes of work nobody posted.
    db.items.push(item({ id: 'i-tomorrow', estimatedPrepTime: 40 }))
    db.posts[0].dirty = true
    db.logs = [log({})]

    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(res.status).toBe(200)
    expect(db.posts[0]).toMatchObject({ itemCount: 2, activeMinutes: 45 })
    // The draft query belongs to the post route. This one must never run it.
    expect(itemFindMany).not.toHaveBeenCalled()
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

  it('moves EVERY live post\'s counters when the item is Shared', async () => {
    // The single log row leaves every center's To Do at once, so leaving
    // Catering's header at 4 items · 120m would describe a list that no longer
    // exists.
    seedCateringPost()
    db.logs = [log({ id: 'l-shared', prepItemId: 'i-shared', revenueCenterId: CATERING })]

    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-shared' }))
    expect(res.status).toBe(200)
    expect(livePostIds).toHaveBeenCalledWith(null)
    expect(db.posts.find(p => p.id === 'p1')).toMatchObject({ itemCount: 2, activeMinutes: 50 })
    expect(db.posts.find(p => p.id === 'p2')).toMatchObject({ itemCount: 3, activeMinutes: 105 })
  })

  it('moves only the owning center\'s header for an RC-owned item', async () => {
    seedCateringPost()
    db.logs = [log({})]
    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(livePostIds).toHaveBeenCalledWith(CAFE)
    expect(db.posts.find(p => p.id === 'p2')).toMatchObject({ itemCount: 4, activeMinutes: 120 })
  })

  it('still scopes an RC-owned item\'s log by revenue center', async () => {
    db.logs = [log({})]
    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(logUpdateMany.mock.calls[0][0].where).toMatchObject({ revenueCenterId: CAFE, prepItemId: 'i-brisket' })
  })

  it('writes the log and the item with updateMany, never update', async () => {
    // A row deleted mid-flight must not P2025 into a 500 on a removal that
    // otherwise succeeded — the same defence recall/route.ts uses.
    db.logs = [log({})]
    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(logUpdate).not.toHaveBeenCalled()
    expect(itemUpdate).not.toHaveBeenCalled()
    expect(itemUpdateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'i-brisket' }, data: { isOnList: false } })
  })

  it('leaves a resolved (DONE) log posted, and leaves the header alone with it', async () => {
    // postedOpenWhere gates the un-post, so nothing was cleared — and a header
    // adjustment gated on that write must not fire either.
    const posted = new Date('2026-09-01T23:00:00.000Z')
    db.logs = [log({ status: 'DONE', postedAt: posted })]
    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(db.logs[0].postedAt).toEqual(posted)
    expect(db.posts[0]).toMatchObject({ itemCount: 3, activeMinutes: 65 })
    expect(postUpdateMany).not.toHaveBeenCalled()
  })

  it('succeeds when the RC has no posted header at all', async () => {
    db.posts = []
    db.logs = [log({})]
    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(res.status).toBe(200)
    expect(db.logs[0].postedAt).toBeNull()
    expect(db.items.find(i => i.id === 'i-brisket')!.isOnList).toBe(false)
    expect(postUpdateMany).not.toHaveBeenCalled()
  })

  it('404s an unknown item without writing anything', async () => {
    db.logs = [log({})]
    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'nope' }))
    expect(res.status).toBe(404)
    expect(logUpdateMany).not.toHaveBeenCalled()
    expect(itemUpdateMany).not.toHaveBeenCalled()
    expect(postUpdateMany).not.toHaveBeenCalled()
  })

  it('404s an item owned by ANOTHER revenue center, and writes nothing', async () => {
    // assertRcWritable guards the REQUEST's center, not the item's. Without the
    // visibility check a Cafe LEAD's × matched no Catering logs (Catering's To
    // Do kept the job) yet still flipped isOnList on Catering's draft.
    db.logs = [log({ id: 'l-catering', prepItemId: 'i-catering', revenueCenterId: CATERING })]
    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-catering' }))
    expect(res.status).toBe(404)

    expect(db.items.find(i => i.id === 'i-catering')!.isOnList).toBe(true)
    expect(db.logs[0].postedAt).not.toBeNull()
    expect(logUpdateMany).not.toHaveBeenCalled()
    expect(itemUpdateMany).not.toHaveBeenCalled()
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
    expect(db.posts[0]).toMatchObject({ itemCount: 4, activeMinutes: 85 })
    expect(logUpdate).not.toHaveBeenCalled()
    expect(itemUpdate).not.toHaveBeenCalled()
  })

  it('falls back to ensureLiveLogs when the newest row is resolved, and never reaches past it', async () => {
    // Made last night; a still-open posted row from the night before sits
    // underneath. Stamping either would be wrong — the DONE row could then
    // never be un-posted (postedOpenWhere needs an OPEN status), and the older
    // one resurrects a job that was already made.
    db.items.find(i => i.id === 'i-brisket')!.isOnList = false
    db.logs = [
      log({ id: 'l-older-open', logDate: new Date(TODAY.getTime() - 2 * DAY), status: 'NOT_STARTED', postedAt: null }),
      log({ id: 'l-done', logDate: YESTERDAY, status: 'DONE', postedAt: null }),
    ]

    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket', restore: true }))
    expect(res.status).toBe(200)

    expect(ensureLiveLogs).toHaveBeenCalledTimes(1)
    expect(ensureLiveLogs).toHaveBeenCalledWith(['i-brisket'], CAFE)
    expect(logUpdateMany.mock.calls[0][0].where).toMatchObject({ id: 'minted-i-brisket' })
    expect(db.logs.find(l => l.id === 'l-older-open')!.postedAt).toBeNull()
    expect(db.logs.find(l => l.id === 'l-done')!.postedAt).toBeNull()
  })

  it('remove → restore is a round trip on the header', async () => {
    db.logs = [log({})]
    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(db.posts[0]).toMatchObject({ itemCount: 2, activeMinutes: 45 })

    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket', restore: true }))
    expect(db.posts[0]).toMatchObject({ itemCount: 3, activeMinutes: 65 })
    expect(postUpdate).not.toHaveBeenCalled()
  })

  it('a restore of an already-restored item does not increment twice', async () => {
    // Double tap, timeout retry, or the prep page's offline queue replaying the
    // same Undo. The log stamp is gated on `postedAt: null`, so the second call
    // changes nothing and the counters must not walk up.
    db.logs = [log({})]
    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket', restore: true }))
    expect(db.posts[0]).toMatchObject({ itemCount: 3, activeMinutes: 65 })

    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket', restore: true }))
    expect(res.status).toBe(200)
    expect(db.posts[0]).toMatchObject({ itemCount: 3, activeMinutes: 65 })
  })

  it('a restore of an item that was never removed is a no-op on the header', async () => {
    db.logs = [log({})]
    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket', restore: true }))
    expect(res.status).toBe(200)
    expect(db.posts[0]).toMatchObject({ itemCount: 3, activeMinutes: 65 })
    expect(postUpdateMany).not.toHaveBeenCalled()
  })

  it('looks the newest log up without an RC filter for a Shared item, and moves every header', async () => {
    seedCateringPost()
    db.items.find(i => i.id === 'i-shared')!.isOnList = false
    db.logs = [log({ id: 'l-shared', prepItemId: 'i-shared', revenueCenterId: CATERING, status: 'IN_PROGRESS', postedAt: null })]

    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-shared', restore: true }))
    expect(res.status).toBe(200)
    expect(logFindFirst.mock.calls[0][0].where).not.toHaveProperty('revenueCenterId')
    expect(ensureLiveLogs).not.toHaveBeenCalled()
    expect(db.logs[0].postedAt).not.toBeNull()
    expect(db.posts.find(p => p.id === 'p1')).toMatchObject({ itemCount: 4, activeMinutes: 80 })
    expect(db.posts.find(p => p.id === 'p2')).toMatchObject({ itemCount: 5, activeMinutes: 135 })
  })

  it('round-trips an item whose newest row is TODAY\'s DONE row without touching anything', async () => {
    // isLiveLog short-circuits true on the DATE, so ensureLiveLogs hands back
    // today's DONE row rather than minting. Both halves are gated on a real
    // write, and neither fires: postedOpenWhere refuses to un-post a DONE row,
    // and the restore stamp only fires on `postedAt: null`. The pair is a
    // no-op on the log and on the header — only isOnList moves.
    const posted = new Date('2026-09-01T23:00:00.000Z')
    db.logs = [log({ id: 'l-done-today', logDate: TODAY, status: 'DONE', postedAt: posted })]

    await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket' }))
    expect(db.items.find(i => i.id === 'i-brisket')!.isOnList).toBe(false)

    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket', restore: true }))
    expect(res.status).toBe(200)
    expect(db.logs).toHaveLength(1)
    expect(db.logs[0].postedAt).toEqual(posted)
    expect(db.items.find(i => i.id === 'i-brisket')!.isOnList).toBe(true)
    expect(db.posts[0]).toMatchObject({ itemCount: 3, activeMinutes: 65 })
    expect(postUpdateMany).not.toHaveBeenCalled()
  })

  it('stamps TODAY\'s unposted DONE row rather than minting a second row for the day', async () => {
    // The honest description of the fallback: it is not guaranteed to mint. A
    // DONE row that is not posted gets postedAt written onto it — which is what
    // keeps the (prepItemId, logDate) unique key intact, and what the post
    // route does through the same primitive.
    db.items.find(i => i.id === 'i-brisket')!.isOnList = false
    db.logs = [log({ id: 'l-done-today', logDate: TODAY, status: 'DONE', postedAt: null })]

    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-brisket', restore: true }))
    expect(res.status).toBe(200)
    expect(ensureLiveLogs).toHaveBeenCalledTimes(1)
    expect(db.logs).toHaveLength(1)
    expect(db.logs[0].id).toBe('l-done-today')
    expect(db.logs[0].postedAt).not.toBeNull()
    expect(db.posts[0]).toMatchObject({ itemCount: 4, activeMinutes: 85 })
  })

  it('404s an item owned by another revenue center on the restore path too', async () => {
    db.items.find(i => i.id === 'i-catering')!.isOnList = false
    const res = await POST(req({ revenueCenterId: CAFE, prepItemId: 'i-catering', restore: true }))
    expect(res.status).toBe(404)
    expect(db.items.find(i => i.id === 'i-catering')!.isOnList).toBe(false)
    expect(logFindFirst).not.toHaveBeenCalled()
    expect(ensureLiveLogs).not.toHaveBeenCalled()
    expect(postUpdateMany).not.toHaveBeenCalled()
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
