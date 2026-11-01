import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { matchWhere } from '@/test/match-where'

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

type U = { id: string; name: string; email: string; role: string; isActive: boolean }
const LEAD: U = { id: 'u-lead', name: 'Lena Lead', email: 'lena@x.ca', role: 'LEAD', isActive: true }
const MANAGER: U = { ...LEAD, id: 'u-mgr', name: 'Max Manager', role: 'MANAGER' }
const STAFF: U = { ...LEAD, id: 'u-cook', name: 'Sam Cook', role: 'STAFF' }

const requireSession = vi.fn(async (_min?: string): Promise<U> => LEAD)
const isRcInScope = vi.fn(async (..._a: unknown[]) => true)
const syncSystemItems = vi.fn(async (_rc: string | null) => {})
const itemFindMany = vi.fn()
const itemGroupBy = vi.fn()
const itemCount = vi.fn()
const tagCount = vi.fn(async () => 9)
const tagFindMany = vi.fn()
/** Real kitchens: rc1 (on) and rc-off (switched off). */
const rcFindFirst = vi.fn(async (a: unknown) => {
  const w = (a as { where: { id: string; isActive?: boolean } }).where
  return w.id === 'rc1' ? { id: 'rc1' } : null
})

vi.mock('@/lib/prisma', () => ({
  prisma: {
    cook: { findUnique: async () => null },
    inboxTag: {
      count: () => tagCount(),
      createMany: async () => ({ count: 0 }),
      findMany: (...a: unknown[]) => tagFindMany(...a),
    },
    inboxFlagRoute: { createMany: async () => ({ count: 0 }) },
    revenueCenter: { findFirst: (...a: unknown[]) => rcFindFirst(...a) },
    inboxItem: {
      findMany: (...a: unknown[]) => itemFindMany(...a),
      groupBy: (...a: unknown[]) => itemGroupBy(...a),
      count: (...a: unknown[]) => itemCount(...a),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [string?])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  isRcInScope: (...a: unknown[]) => isRcInScope(...a),
  assertRcWritable: async () => {},
}))
vi.mock('@/lib/inbox/system', () => ({
  syncSystemItems: (rc: string | null) => syncSystemItems(rc),
}))

const listRoute = await import('@/app/api/inbox/route')
const countRoute = await import('@/app/api/inbox/count/route')
const mineRoute = await import('@/app/api/inbox/mine/route')

const tag = (id: string, o: Record<string, unknown> = {}) => ({
  id, builtIn: null, name: id, color: '#16a34a',
  cookCanPick: false, managerOnly: false, isActive: true, ...o,
})
const TAGS = [
  tag('tag-food_safety', { builtIn: 'FOOD_SAFETY', name: 'Food safety' }),
  tag('tag-money', { builtIn: 'MONEY', name: 'Money', managerOnly: true }),
  tag('tag-team', { builtIn: 'TEAM', name: 'Team' }),
  tag('tag-old', { name: 'Old', isActive: false }),
]
const tagOf = (id: string) => TAGS.find(t => t.id === id)!

const NOW = Date.now()
const ago = (min: number) => new Date(NOW - min * 60_000)
const row = (id: string, o: Record<string, unknown> = {}) => {
  const tagId = (o.tagId as string) ?? 'tag-food_safety'
  return {
    id, tagId, severity: 'TODAY', status: 'OPEN', managerOnly: false,
    snoozeUntil: null, clearedAt: null, doneById: null, createdAt: ago(10),
    title: `Item ${id}`, body: null, place: null, href: null, source: 'REPORT', sourceKey: null,
    raisedById: 'u-cook', raisedByName: 'Sam Cook', doneByName: null, doneAt: null,
    revenueCenterId: 'rc1', tag: tagOf(tagId), events: [],
    ...o,
  }
}

const req = (qs: string) =>
  ({ nextUrl: new URL(`http://x/api/inbox${qs}`) }) as unknown as NextRequest
const asUser = (u: U) => requireSession.mockImplementation(async () => u)

beforeEach(() => {
  vi.clearAllMocks()
  asUser(LEAD)
  isRcInScope.mockResolvedValue(true)
  tagFindMany.mockResolvedValue(TAGS)
  itemFindMany.mockResolvedValue([])
  itemGroupBy.mockResolvedValue([])
  itemCount.mockResolvedValue(0)
})

describe('GET /api/inbox', () => {
  it('needs a kitchen: 400 rcId required', async () => {
    const res = await listRoute.GET(req(''))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'rcId required' })
    expect(itemFindMany).not.toHaveBeenCalled()
  })

  it('is LEAD+ only', async () => {
    requireSession.mockRejectedValueOnce(new MockAuthError(403, 'Insufficient permissions'))
    const res = await listRoute.GET(req('?rcId=rc1'))
    expect(res.status).toBe(403)
    expect(requireSession).toHaveBeenCalledWith('LEAD')
  })

  it('403 for a kitchen outside the caller’s scope', async () => {
    isRcInScope.mockResolvedValueOnce(false)
    const res = await listRoute.GET(req('?rcId=rc9'))
    expect(res.status).toBe(403)
    expect(itemFindMany).not.toHaveBeenCalled()
  })

  it('404 for a kitchen that does not exist (or is switched off): no sync, no list', async () => {
    for (const rc of ['rc-made-up', 'rc-off']) {
      const res = await listRoute.GET(req(`?rcId=${rc}`))
      expect(res.status).toBe(404)
    }
    expect(rcFindFirst).toHaveBeenCalledWith({ where: { id: 'rc-made-up', isActive: true }, select: { id: true } })
    expect(syncSystemItems).not.toHaveBeenCalled()
    expect(itemFindMany).not.toHaveBeenCalled()
  })

  it('syncs the app’s alerts, then lists this kitchen + whole-house items, open only', async () => {
    await listRoute.GET(req('?rcId=rc1'))
    expect(syncSystemItems).toHaveBeenCalledWith('rc1')
    const where = (itemFindMany.mock.calls[0][0] as { where: { AND: unknown[] } }).where
    expect(where.AND).toEqual(expect.arrayContaining([
      { OR: [{ revenueCenterId: 'rc1' }, { revenueCenterId: null }] },
      { OR: [{ status: { in: ['OPEN', 'WAITING'] } }, { status: 'SNOOZED', snoozeUntil: { lte: expect.any(Date) } }] },
    ]))
  })

  it('a LEAD never receives a manager-only item: filtered in SQL and again in JS', async () => {
    itemFindMany.mockResolvedValue([
      row('a'),
      row('b', { managerOnly: true }),
      row('c', { tagId: 'tag-money' }),
    ])
    itemGroupBy.mockResolvedValue([
      { tagId: 'tag-food_safety', _count: { _all: 1 } },
      { tagId: 'tag-money', _count: { _all: 4 } },
    ])
    const body = await (await listRoute.GET(req('?rcId=rc1'))).json()

    const where = (itemFindMany.mock.calls[0][0] as { where: { AND: unknown[] } }).where
    expect(where.AND).toContainEqual({ managerOnly: false, tag: { managerOnly: false } })
    const gWhere = (itemGroupBy.mock.calls[0][0] as { where: { AND: unknown[] } }).where
    expect(gWhere.AND).toContainEqual({ managerOnly: false, tag: { managerOnly: false } })

    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['a'])
    expect(body.counts.byTag).toEqual({ 'tag-food_safety': 1 })
    expect(body.counts.open).toBe(1)
    expect(body.tags.map((t: { id: string }) => t.id)).toEqual(['tag-food_safety', 'tag-team'])
  })

  it('a MANAGER gets manager-only items and every active tag', async () => {
    asUser(MANAGER)
    itemFindMany.mockResolvedValue([row('a'), row('c', { tagId: 'tag-money' })])
    const body = await (await listRoute.GET(req('?rcId=rc1'))).json()
    const where = (itemFindMany.mock.calls[0][0] as { where: { AND: unknown[] } }).where
    expect(where.AND).not.toContainEqual({ managerOnly: false, tag: { managerOnly: false } })
    expect(body.items).toHaveLength(2)
    expect(body.tags.map((t: { id: string }) => t.id)).toEqual(['tag-food_safety', 'tag-money', 'tag-team'])
  })

  it('orders NOW before TODAY before FYI, newest first inside each, and marks unread', async () => {
    itemFindMany.mockResolvedValue([
      row('fyi', { severity: 'FYI', createdAt: ago(1) }),
      row('today-old', { createdAt: ago(60) }),
      row('now', { severity: 'NOW', createdAt: ago(30), events: [{ at: ago(5) }] }),
      row('today-new', { createdAt: ago(2) }),
    ])
    const body = await (await listRoute.GET(req('?rcId=rc1'))).json()
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['now', 'today-new', 'today-old', 'fyi'])
    expect(body.items[0].unread).toBe(false)
    expect(body.items[1].unread).toBe(true)
    expect(body.items[0].createdAt).toBe(ago(30).toISOString())
    expect(body.items[0].tag).toMatchObject({ id: 'tag-food_safety', name: 'Food safety' })
  })

  it('status=done looks back 14 days; tag + from + place narrow the list', async () => {
    await listRoute.GET(req('?rcId=rc1&status=done&tagId=tag-team&from=u-cook&place=Walk-in'))
    const where = (itemFindMany.mock.calls[0][0] as { where: { AND: Record<string, unknown>[] } }).where
    const done = where.AND.find(w => w.status === 'DONE') as { OR: { doneAt?: { gte: Date }; clearedAt?: { gte: Date } }[] }
    expect(done).toBeTruthy()
    const since = done.OR[0].doneAt!.gte.getTime()
    expect(Math.round((Date.now() - since) / 86_400_000)).toBe(14)
    expect(where.AND).toEqual(expect.arrayContaining([
      { tagId: 'tag-team' }, { raisedById: 'u-cook' }, { place: 'Walk-in' },
    ]))
  })

  it('done ages a person-closed item by when they closed it, not by a later re-arm stamp', async () => {
    await listRoute.GET(req('?rcId=rc1&status=done'))
    const where = (itemFindMany.mock.calls[0][0] as { where: { AND: Record<string, unknown>[] } }).where
    const done = where.AND.find(w => w.status === 'DONE')!
    const day = 86_400_000
    // "Count is 5 days old" marked done 25 days ago; re-armed by the sync yesterday.
    const rearmed = { status: 'DONE', doneAt: new Date(NOW - 25 * day), clearedAt: new Date(NOW - day) }
    // Closed by a person 3 days ago (and re-armed since): still in Done.
    const recent = { status: 'DONE', doneAt: new Date(NOW - 3 * day), clearedAt: new Date(NOW - day) }
    // Cleared itself 2 days ago (no person): in Done.
    const cleared = { status: 'DONE', doneAt: null, clearedAt: new Date(NOW - 2 * day) }
    expect(matchWhere(rearmed, done)).toBe(false)
    expect(matchWhere(recent, done)).toBe(true)
    expect(matchWhere(cleared, done)).toBe(true)
  })

  it('returns open + snoozed + done totals', async () => {
    itemGroupBy.mockResolvedValue([
      { tagId: 'tag-food_safety', _count: { _all: 2 } },
      { tagId: 'tag-team', _count: { _all: 3 } },
    ])
    const statusOf = (a: unknown) =>
      ((a as { where: { AND: Record<string, unknown>[] } }).where.AND.find(w => 'status' in w) ?? {}).status
    itemCount.mockImplementation(async (a: unknown) => (statusOf(a) === 'SNOOZED' ? 2 : 7))
    const body = await (await listRoute.GET(req('?rcId=rc1'))).json()
    expect(body.counts).toEqual({ byTag: { 'tag-food_safety': 2, 'tag-team': 3 }, open: 5, done: 7, snoozed: 2 })
  })

  it('counts snoozed items only while they are still asleep, inside the viewer’s visibility', async () => {
    await listRoute.GET(req('?rcId=rc1'))
    const snoozedCall = itemCount.mock.calls
      .map(c => (c[0] as { where: { AND: Record<string, unknown>[] } }).where)
      .find(w => w.AND.some(x => x.status === 'SNOOZED'))!
    expect(snoozedCall.AND).toEqual(expect.arrayContaining([
      { OR: [{ revenueCenterId: 'rc1' }, { revenueCenterId: null }] },
      { managerOnly: false, tag: { managerOnly: false } },
      { status: 'SNOOZED', snoozeUntil: { gt: expect.any(Date) } },
    ]))
  })

  it('status=snoozed lists items still asleep (snoozeUntil in the future), not the open list', async () => {
    itemFindMany.mockResolvedValue([
      row('s', { status: 'SNOOZED', snoozeUntil: new Date(NOW + 3_600_000) }),
    ])
    const body = await (await listRoute.GET(req('?rcId=rc1&status=snoozed'))).json()
    const where = (itemFindMany.mock.calls[0][0] as { where: { AND: Record<string, unknown>[] } }).where
    const snoozed = where.AND.find(w => w.status === 'SNOOZED') as { snoozeUntil: { gt: Date } }
    expect(snoozed).toBeTruthy()
    expect(Math.abs(snoozed.snoozeUntil.gt.getTime() - Date.now())).toBeLessThan(5_000)
    // Not the open filter, not the done filter.
    expect(where.AND.some(w => 'OR' in w && JSON.stringify(w).includes('WAITING'))).toBe(false)
    expect(where.AND.some(w => w.status === 'DONE')).toBe(false)
    expect(body.items.map((i: { id: string; status: string }) => [i.id, i.status])).toEqual([['s', 'SNOOZED']])
  })

  it('an unknown status falls back to the open list', async () => {
    await listRoute.GET(req('?rcId=rc1&status=bogus'))
    const where = (itemFindMany.mock.calls[0][0] as { where: { AND: unknown[] } }).where
    expect(where.AND).toContainEqual(
      { OR: [{ status: { in: ['OPEN', 'WAITING'] } }, { status: 'SNOOZED', snoozeUntil: { lte: expect.any(Date) } }] },
    )
  })
})

describe('GET /api/inbox/count', () => {
  const creq = (qs: string) =>
    ({ nextUrl: new URL(`http://x/api/inbox/count${qs}`) }) as unknown as NextRequest

  it('400 without a kitchen', async () => {
    const res = await countRoute.GET(creq(''))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'rcId required' })
  })

  it('a made-up kitchen id never gets past the throttle: 404 before any sync', async () => {
    // isRcInScope says yes to any id for an unscoped user — so check the kitchen itself.
    for (let n = 0; n < 3; n++) {
      const res = await countRoute.GET(creq(`?rcId=junk-${n}`))
      expect(res.status).toBe(404)
    }
    expect(syncSystemItems).not.toHaveBeenCalled()
    expect(itemFindMany).not.toHaveBeenCalled()
  })

  it('LEAD: open NOW + TODAY items they can see — never a manager-only one', async () => {
    itemFindMany.mockResolvedValue([
      row('a', { severity: 'NOW' }),
      row('b'),
      row('m', { managerOnly: true }),
      row('t', { tagId: 'tag-money' }),
      row('s', { status: 'SNOOZED', snoozeUntil: new Date(NOW + 3_600_000) }),
    ])
    const res = await countRoute.GET(creq('?rcId=rc1'))
    expect(await res.json()).toEqual({ count: 2 })
    const where = (itemFindMany.mock.calls[0][0] as { where: { AND: unknown[] } }).where
    expect(where.AND).toContainEqual({ managerOnly: false, tag: { managerOnly: false } })
    expect(where.AND).toContainEqual({ severity: { in: ['NOW', 'TODAY'] } })
  })

  it('STAFF: their own reports fixed since they last looked (never opened counts)', async () => {
    asUser(STAFF)
    itemFindMany.mockResolvedValue([
      { status: 'DONE', doneAt: ago(10), events: [] },               // never opened → counts
      { status: 'DONE', doneAt: ago(10), events: [{ at: ago(30) }] }, // seen before the fix → counts
      { status: 'DONE', doneAt: ago(30), events: [{ at: ago(5) }] },  // seen after the fix → no
    ])
    const res = await countRoute.GET(creq('?rcId=rc1'))
    expect(await res.json()).toEqual({ count: 2 })
    const where = (itemFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(where).toMatchObject({ raisedById: 'u-cook', source: 'REPORT', status: 'DONE' })
  })
})

describe('GET /api/inbox/mine', () => {
  it('lists the caller’s own reports from the last 14 days, newest first, and marks nothing seen', async () => {
    asUser(STAFF)
    itemFindMany.mockResolvedValue([
      row('r2', { status: 'DONE', doneAt: ago(3), doneByName: 'Lena Lead', doneById: 'u-lead' }),
      row('r1', { createdAt: ago(100) }),
    ])
    const res = await mineRoute.GET()
    const body = await res.json()
    expect(requireSession).toHaveBeenCalledWith()
    const arg = itemFindMany.mock.calls[0][0] as { where: Record<string, unknown>; orderBy: unknown }
    expect(arg.where).toMatchObject({ raisedById: 'u-cook', source: 'REPORT' })
    expect(arg.orderBy).toEqual({ createdAt: 'desc' })
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['r2', 'r1'])
    expect(body.items[0]).toMatchObject({ status: 'DONE', doneByName: 'Lena Lead', fixedSinceSeen: true })
    expect(body.items[1].fixedSinceSeen).toBe(false)
  })
})
