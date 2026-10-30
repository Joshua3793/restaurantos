import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

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
const assertRcWritable = vi.fn(async (..._a: unknown[]) => {})

const itemFindUnique = vi.fn()
const eventCreate = vi.fn(async (a: unknown) => a)
const eventFindMany = vi.fn(async (_a?: unknown) => [] as unknown[])
const tagFindUnique = vi.fn()
// Writes inside an action are only reachable through the transaction's `tx`.
const txItemUpdateMany = vi.fn(async (_a: unknown) => ({ count: 1 }))
const txEventCreate = vi.fn(async (a: unknown) => a)
const txItemFindUnique = vi.fn()
const txItemFindFirst = vi.fn(async (_a: unknown): Promise<unknown> => ({ id: 'i1' }))
const tx = {
  inboxItem: {
    updateMany: (a: unknown) => txItemUpdateMany(a),
    findUnique: (a: unknown) => txItemFindUnique(a),
    findFirst: (a: unknown) => txItemFindFirst(a),
  },
  inboxEvent: { create: (a: unknown) => txEventCreate(a) },
}
const transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    cook: { findUnique: async () => null },
    inboxItem: { findUnique: (...a: unknown[]) => itemFindUnique(...a) },
    inboxEvent: {
      create: (a: unknown) => eventCreate(a),
      findMany: (a: unknown) => eventFindMany(a),
    },
    inboxTag: { findUnique: (...a: unknown[]) => tagFindUnique(...a) },
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => transaction(fn),
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [string?])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  isRcInScope: (...a: unknown[]) => isRcInScope(...a),
  assertRcWritable: (...a: unknown[]) => assertRcWritable(...a),
}))

const route = await import('@/app/api/inbox/[id]/route')

const tag = (id: string, o: Record<string, unknown> = {}) => ({
  id, builtIn: null, name: id, color: '#16a34a',
  cookCanPick: false, managerOnly: false, isActive: true, ...o,
})
const TAGS: Record<string, ReturnType<typeof tag>> = {
  'tag-food_safety': tag('tag-food_safety', { builtIn: 'FOOD_SAFETY', name: 'Food safety' }),
  'tag-money': tag('tag-money', { builtIn: 'MONEY', name: 'Money', managerOnly: true }),
  'tag-maintenance': tag('tag-maintenance', { name: 'Maintenance' }),
  'tag-old': tag('tag-old', { name: 'Old', isActive: false }),
}
const row = (o: Record<string, unknown> = {}) => {
  const tagId = (o.tagId as string) ?? 'tag-food_safety'
  return {
    id: 'i1', tagId, severity: 'NOW', status: 'OPEN', managerOnly: false,
    snoozeUntil: null, clearedAt: null, doneById: null, createdAt: new Date('2026-10-30T15:00:00Z'),
    title: 'Walk-in reading 9°C', body: 'Door left open', place: 'Walk-in', href: null,
    source: 'REPORT', sourceKey: null,
    raisedById: 'u-cook', raisedByName: 'Sam Cook', doneByName: null, doneAt: null,
    revenueCenterId: 'rc1', tag: TAGS[tagId], events: [] as { at: Date }[],
    ...o,
  }
}

const params = { params: { id: 'i1' } }
const getReq = {} as unknown as NextRequest
const patch = (body: unknown) => route.PATCH({ json: async () => body } as unknown as NextRequest, params)
const asUser = (u: U) => requireSession.mockImplementation(async () => u)

beforeEach(() => {
  vi.clearAllMocks()
  asUser(LEAD)
  isRcInScope.mockResolvedValue(true)
  assertRcWritable.mockResolvedValue(undefined)
  txItemUpdateMany.mockResolvedValue({ count: 1 })
  itemFindUnique.mockResolvedValue(row())
  txItemFindUnique.mockResolvedValue(row())
  txItemFindFirst.mockResolvedValue({ id: 'i1' })
  eventFindMany.mockResolvedValue([])
  tagFindUnique.mockImplementation(async (a: { where: { id: string } }) => TAGS[a.where.id] ?? null)
})

describe('GET /api/inbox/[id]', () => {
  it('the first open writes SEEN, with the viewer’s name', async () => {
    eventFindMany.mockResolvedValue([
      { kind: 'RAISED', byName: 'Sam Cook', note: 'Door left open', at: new Date('2026-10-30T15:00:00Z') },
    ])
    const res = await route.GET(getReq, params)
    expect(res.status).toBe(200)
    expect(eventCreate).toHaveBeenCalledTimes(1)
    expect(eventCreate.mock.calls[0][0]).toEqual({
      data: { itemId: 'i1', kind: 'SEEN', byId: 'u-lead', byName: 'Lena Lead' },
    })
    const body = await res.json()
    expect(body.item).toMatchObject({ id: 'i1', title: 'Walk-in reading 9°C', unread: false, place: 'Walk-in' })
    expect(body.events).toEqual([
      { kind: 'RAISED', byName: 'Sam Cook', note: 'Door left open', at: '2026-10-30T15:00:00.000Z' },
    ])
  })

  it('the second open writes nothing', async () => {
    itemFindUnique.mockResolvedValue(row({ events: [{ at: new Date() }] }))
    const res = await route.GET(getReq, params)
    expect(res.status).toBe(200)
    expect(eventCreate).not.toHaveBeenCalled()
  })

  it('404 (never 403) when a LEAD asks for a manager-only item or one in a manager-only tag', async () => {
    itemFindUnique.mockResolvedValueOnce(row({ managerOnly: true, raisedById: null }))
    let res = await route.GET(getReq, params)
    expect(res.status).toBe(404)
    itemFindUnique.mockResolvedValueOnce(row({ tagId: 'tag-money', raisedById: null }))
    res = await route.GET(getReq, params)
    expect(res.status).toBe(404)
    expect(eventCreate).not.toHaveBeenCalled()
  })

  it('a MANAGER can open a manager-only item', async () => {
    asUser(MANAGER)
    itemFindUnique.mockResolvedValue(row({ tagId: 'tag-money', managerOnly: true }))
    const res = await route.GET(getReq, params)
    expect(res.status).toBe(200)
  })

  it('404 for an item in a kitchen outside the caller’s scope', async () => {
    itemFindUnique.mockResolvedValue(row({ raisedById: null }))
    isRcInScope.mockResolvedValueOnce(false)
    const res = await route.GET(getReq, params)
    expect(res.status).toBe(404)
    expect(eventCreate).not.toHaveBeenCalled()
  })

  it('404 when it does not exist', async () => {
    itemFindUnique.mockResolvedValue(null)
    const res = await route.GET(getReq, params)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('a STAFF cook can open their own report, and that writes SEEN', async () => {
    asUser(STAFF)
    const res = await route.GET(getReq, params)
    expect(res.status).toBe(200)
    expect(requireSession).toHaveBeenCalledWith()
    expect(eventCreate.mock.calls[0][0]).toMatchObject({ data: { kind: 'SEEN', byId: 'u-cook' } })
  })

  it('a STAFF cook re-opening their own report after it was fixed writes a fresh SEEN', async () => {
    asUser(STAFF)
    itemFindUnique.mockResolvedValue(row({
      status: 'DONE', doneAt: new Date('2026-10-30T18:00:00Z'),
      events: [{ at: new Date('2026-10-30T16:00:00Z') }],
    }))
    await route.GET(getReq, params)
    expect(eventCreate).toHaveBeenCalledTimes(1)
  })

  it('a STAFF cook gets 404 for anyone else’s item', async () => {
    asUser(STAFF)
    itemFindUnique.mockResolvedValue(row({ raisedById: 'someone-else' }))
    const res = await route.GET(getReq, params)
    expect(res.status).toBe(404)
    expect(eventCreate).not.toHaveBeenCalled()
  })
})

describe('GET /api/inbox/[id] — owners and duplicates', () => {
  it('a LEAD who raised a report later retagged into Money gets the title and fixed state, no history', async () => {
    itemFindUnique.mockResolvedValue(row({
      tagId: 'tag-money', raisedById: 'u-lead', status: 'DONE',
      doneByName: 'Max Manager', doneAt: new Date('2026-10-30T18:00:00Z'),
    }))
    const res = await route.GET(getReq, params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.limited).toBe(true)
    expect(body.events).toEqual([])
    expect(body.item).toMatchObject({
      title: 'Walk-in reading 9°C', status: 'DONE', doneByName: 'Max Manager',
      doneAt: '2026-10-30T18:00:00.000Z', body: null, place: null, href: null,
    })
    expect(eventFindMany).not.toHaveBeenCalled()
  })

  it('a cook who raised a FLAG item routed into Money gets 404', async () => {
    asUser(STAFF)
    itemFindUnique.mockResolvedValue(row({ source: 'FLAG', sourceKey: 'flag:l1', tagId: 'tag-money' }))
    const res = await route.GET(getReq, params)
    expect(res.status).toBe(404)
    expect(eventCreate).not.toHaveBeenCalled()
  })

  it('the owner shortcut is REPORT-only: a cook gets 404 on their own ordinary FLAG item', async () => {
    asUser(STAFF)
    itemFindUnique.mockResolvedValue(row({ source: 'FLAG', sourceKey: 'flag:l1' }))
    const res = await route.GET(getReq, params)
    expect(res.status).toBe(404)
  })

  it('a cook opening their own ordinary report gets the full history', async () => {
    asUser(STAFF)
    eventFindMany.mockResolvedValue([
      { kind: 'RAISED', byId: 'u-cook', byName: 'Sam Cook', note: 'Door left open', at: new Date('2026-10-30T15:00:00Z') },
      { kind: 'NOTE', byId: 'u-lead', byName: 'Lena Lead', note: 'On it', at: new Date('2026-10-30T15:05:00Z') },
    ])
    const body = await (await route.GET(getReq, params)).json()
    expect(body.limited).toBeUndefined()
    expect(body.item.body).toBe('Door left open')
    expect(body.events.map((e: { kind: string }) => e.kind)).toEqual(['RAISED', 'NOTE'])
  })

  it('collapses duplicate SEEN rows to one per person, keeping the earliest', async () => {
    eventFindMany.mockResolvedValue([
      { kind: 'RAISED', byId: 'u-cook', byName: 'Sam Cook', note: null, at: new Date('2026-10-30T15:00:00Z') },
      { kind: 'SEEN', byId: 'u-lead', byName: 'Lena Lead', note: null, at: new Date('2026-10-30T15:01:00Z') },
      { kind: 'SEEN', byId: 'u-lead', byName: 'Lena Lead', note: null, at: new Date('2026-10-30T15:01:01Z') },
      { kind: 'SEEN', byId: 'u-mgr', byName: 'Max Manager', note: null, at: new Date('2026-10-30T15:02:00Z') },
    ])
    const body = await (await route.GET(getReq, params)).json()
    expect(body.events.map((e: { kind: string; at: string }) => `${e.kind}@${e.at.slice(11, 19)}`)).toEqual([
      'RAISED@15:00:00', 'SEEN@15:01:00', 'SEEN@15:02:00',
    ])
  })
})

describe('PATCH /api/inbox/[id]', () => {
  const lastUpdate = () => txItemUpdateMany.mock.calls[0][0] as { where: Record<string, unknown>; data: Record<string, unknown> }
  const lastEvent = () => (txEventCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data

  it('is LEAD+ only', async () => {
    requireSession.mockRejectedValueOnce(new MockAuthError(403, 'Insufficient permissions'))
    const res = await patch({ kind: 'done' })
    expect(res.status).toBe(403)
    expect(requireSession).toHaveBeenCalledWith('LEAD')
  })

  it('400 Unknown action', async () => {
    const res = await patch({ kind: 'explode' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Unknown action' })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('note: writes a NOTE event, trimmed and capped at 500, and leaves the item alone', async () => {
    const res = await patch({ kind: 'note', note: `  ${'x'.repeat(600)}  ` })
    expect(res.status).toBe(200)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(txItemUpdateMany).not.toHaveBeenCalled()
    expect(lastEvent()).toMatchObject({ itemId: 'i1', kind: 'NOTE', byId: 'u-lead', byName: 'Lena Lead' })
    expect((lastEvent().note as string).length).toBe(500)
  })

  it('note: an empty note is refused', async () => {
    const res = await patch({ kind: 'note', note: '   ' })
    expect(res.status).toBe(400)
    expect(txEventCreate).not.toHaveBeenCalled()
  })

  it('snooze: SNOOZED until 05:00 Pacific tomorrow + a SNOOZED event', async () => {
    const res = await patch({ kind: 'snooze' })
    expect(res.status).toBe(200)
    expect(lastUpdate().where).toEqual({ id: 'i1', managerOnly: false, tag: { managerOnly: false }, status: { not: 'DONE' } })
    expect(lastUpdate().data.status).toBe('SNOOZED')
    const until = lastUpdate().data.snoozeUntil as Date
    expect(until).toBeInstanceOf(Date)
    expect(until.getTime()).toBeGreaterThan(Date.now())
    expect([12, 13]).toContain(until.getUTCHours())
    expect(lastEvent()).toMatchObject({ kind: 'SNOOZED', byId: 'u-lead' })
  })

  it('wait: WAITING + a WAITING event carrying the note', async () => {
    await patch({ kind: 'wait', note: ' Calling the fridge guy ' })
    expect(lastUpdate().data).toEqual({ status: 'WAITING', snoozeUntil: null })
    expect(lastEvent()).toMatchObject({ kind: 'WAITING', note: 'Calling the fridge guy' })
  })

  it('done: sets who + when, clears clearedAt, writes DONE inside the transaction', async () => {
    const res = await patch({ kind: 'done', note: 'Fixed the seal' })
    expect(res.status).toBe(200)
    expect(lastUpdate().where).toEqual({ id: 'i1', managerOnly: false, tag: { managerOnly: false }, status: { not: 'DONE' } })
    expect(lastUpdate().data).toMatchObject({
      status: 'DONE', doneById: 'u-lead', doneByName: 'Lena Lead', clearedAt: null, snoozeUntil: null,
    })
    expect(lastUpdate().data.doneAt).toBeInstanceOf(Date)
    expect(lastEvent()).toMatchObject({ kind: 'DONE', note: 'Fixed the seal' })
    expect(assertRcWritable).toHaveBeenCalledWith(expect.objectContaining({ id: 'u-lead' }), 'rc1')
    const body = await res.json()
    expect(body.item.id).toBe('i1')
  })

  it('done twice → 409 Already fixed, and no event is written', async () => {
    txItemUpdateMany.mockResolvedValue({ count: 0 })
    const res = await patch({ kind: 'done' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Already fixed' })
    expect(txEventCreate).not.toHaveBeenCalled()
  })

  it('reopen: OPEN again, done fields cleared, REOPENED event', async () => {
    await patch({ kind: 'reopen' })
    expect(lastUpdate().where).toEqual({ id: 'i1', managerOnly: false, tag: { managerOnly: false }, status: 'DONE' })
    expect(lastUpdate().data).toMatchObject({
      status: 'OPEN', doneById: null, doneByName: null, doneAt: null, clearedAt: null,
    })
    expect(lastEvent()).toMatchObject({ kind: 'REOPENED' })
  })

  it('reopen on an item that is not done → 409 Already open', async () => {
    txItemUpdateMany.mockResolvedValue({ count: 0 })
    const res = await patch({ kind: 'reopen' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Already open' })
  })

  it('retag: moves the item and writes RETAGGED old → new', async () => {
    await patch({ kind: 'retag', tagId: 'tag-maintenance' })
    expect(lastUpdate().data).toEqual({ tagId: 'tag-maintenance' })
    expect(lastEvent()).toMatchObject({ kind: 'RETAGGED', note: 'Food safety → Maintenance' })
  })

  it('retag to a missing or archived tag → 400 Pick a tag', async () => {
    let res = await patch({ kind: 'retag', tagId: 'tag-nope' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Pick a tag' })
    res = await patch({ kind: 'retag', tagId: 'tag-old' })
    expect(res.status).toBe(400)
    expect(transaction).not.toHaveBeenCalled()
  })

  it('a LEAD retagging into a manager-only tag → 403; a MANAGER may', async () => {
    let res = await patch({ kind: 'retag', tagId: 'tag-money' })
    expect(res.status).toBe(403)
    expect(transaction).not.toHaveBeenCalled()
    asUser(MANAGER)
    res = await patch({ kind: 'retag', tagId: 'tag-money' })
    expect(res.status).toBe(200)
    expect(lastUpdate().data).toEqual({ tagId: 'tag-money' })
  })

  it('a LEAD acting on a manager-only item gets 404', async () => {
    itemFindUnique.mockResolvedValue(row({ managerOnly: true }))
    const res = await patch({ kind: 'done' })
    expect(res.status).toBe(404)
    expect(transaction).not.toHaveBeenCalled()
  })

  it('403 when the item’s kitchen is outside the caller’s access, and nothing is written', async () => {
    assertRcWritable.mockRejectedValueOnce(new MockAuthError(403, 'Revenue center is outside your access.'))
    const res = await patch({ kind: 'done' })
    expect(res.status).toBe(403)
    expect(transaction).not.toHaveBeenCalled()
  })

  it('404 for an item in a kitchen outside the caller’s scope, before the write check', async () => {
    isRcInScope.mockResolvedValueOnce(false)
    const res = await patch({ kind: 'done' })
    expect(res.status).toBe(404)
    expect(assertRcWritable).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('a retag into Money that races ahead of a LEAD’s write → 404, nothing else written', async () => {
    txItemUpdateMany.mockResolvedValue({ count: 0 })
    txItemFindFirst.mockResolvedValue(null)
    const res = await patch({ kind: 'done' })
    expect(res.status).toBe(404)
    expect(txItemFindFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 'i1', managerOnly: false, tag: { managerOnly: false } },
    })
    expect(txEventCreate).not.toHaveBeenCalled()
  })

  it('a note on an item that just became manager-only → 404', async () => {
    txItemFindFirst.mockResolvedValue(null)
    const res = await patch({ kind: 'note', note: 'Checked it' })
    expect(res.status).toBe(404)
    expect(txEventCreate).not.toHaveBeenCalled()
  })

  it('a MANAGER’s write carries no visibility guard', async () => {
    asUser(MANAGER)
    await patch({ kind: 'done' })
    expect(lastUpdate().where).toEqual({ id: 'i1', status: { not: 'DONE' } })
  })

  it('a whole-house item (no kitchen) skips the kitchen check', async () => {
    itemFindUnique.mockResolvedValue(row({ revenueCenterId: null }))
    const res = await patch({ kind: 'snooze' })
    expect(res.status).toBe(200)
    expect(assertRcWritable).not.toHaveBeenCalled()
    expect(isRcInScope).not.toHaveBeenCalled()
  })
})
