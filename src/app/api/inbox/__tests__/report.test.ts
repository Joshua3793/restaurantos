import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

type U = { id: string; name: string; email: string; role: string; isActive: boolean }
const STAFF: U = { id: 'u-cook', name: 'Sam Cook', email: 'sam@x.ca', role: 'STAFF', isActive: true }
const LEAD: U = { ...STAFF, id: 'u-lead', name: 'Lena Lead', role: 'LEAD' }
const MANAGER: U = { ...STAFF, id: 'u-mgr', name: 'Max Manager', role: 'MANAGER' }

const requireSession = vi.fn(async (_min?: string): Promise<U> => STAFF)
const assertRcWritable = vi.fn(async (..._a: unknown[]) => {})
const tagFindUnique = vi.fn()
const itemCreate = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    cook: { findUnique: async () => null },
    inboxTag: { findUnique: (...a: unknown[]) => tagFindUnique(...a) },
    inboxItem: { create: (a: unknown) => itemCreate(a) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [string?])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  isRcInScope: async () => true,
  assertRcWritable: (...a: unknown[]) => assertRcWritable(...a),
}))

const { POST } = await import('@/app/api/inbox/report/route')

const tag = (id: string, o: Record<string, unknown> = {}) => ({
  id, builtIn: null, name: id, color: '#16a34a',
  cookCanPick: false, managerOnly: false, isActive: true, ...o,
})
const TAGS: Record<string, ReturnType<typeof tag>> = {
  'tag-maintenance': tag('tag-maintenance', { name: 'Maintenance', cookCanPick: true }),
  'tag-checklists': tag('tag-checklists', { builtIn: 'CHECKLISTS', name: 'Checklists' }),
  'tag-money': tag('tag-money', { builtIn: 'MONEY', name: 'Money', managerOnly: true, cookCanPick: true }),
  'tag-events': tag('tag-events', { name: 'Events', cookCanPick: true, isActive: false }),
}

const post = (body: unknown) => POST({ json: async () => body } as unknown as NextRequest)
const asUser = (u: U) => requireSession.mockImplementation(async () => u)
const good = { rcId: 'rc1', tagId: 'tag-maintenance', text: 'Dish machine leaking\nWater all over the floor by the pit' }

beforeEach(() => {
  vi.clearAllMocks()
  asUser(STAFF)
  assertRcWritable.mockResolvedValue(undefined)
  tagFindUnique.mockImplementation(async (a: { where: { id: string } }) => TAGS[a.where.id] ?? null)
  itemCreate.mockImplementation(async (a: { data: Record<string, unknown> }) => ({
    id: 'new1', status: 'OPEN', snoozeUntil: null, clearedAt: null, doneById: null,
    createdAt: new Date('2026-10-30T15:00:00Z'), href: null, doneByName: null, doneAt: null,
    sourceKey: null, managerOnly: false,
    ...a.data,
    tag: TAGS[a.data.tagId as string],
    events: [],
  }))
})

describe('POST /api/inbox/report', () => {
  it('any signed-in cook can report; it lands OPEN, TODAY, with who raised it and a RAISED event', async () => {
    const res = await post({ ...good, place: '  Dish pit  ' })
    expect(res.status).toBe(201)
    expect(requireSession).toHaveBeenCalledWith()
    expect(assertRcWritable).toHaveBeenCalledWith(expect.objectContaining({ id: 'u-cook' }), 'rc1')
    const data = (itemCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data
    expect(data).toMatchObject({
      revenueCenterId: 'rc1', tagId: 'tag-maintenance', severity: 'TODAY', source: 'REPORT',
      status: 'OPEN', managerOnly: false,
      title: 'Dish machine leaking', body: good.text, place: 'Dish pit',
      raisedById: 'u-cook', raisedByName: 'Sam Cook',
      events: { create: { kind: 'RAISED', byId: 'u-cook', byName: 'Sam Cook', note: good.text } },
    })
    const body = await res.json()
    expect(body.item).toMatchObject({ id: 'new1', title: 'Dish machine leaking', tag: { id: 'tag-maintenance' } })
  })

  it('urgent → NOW; title capped at 80; place capped at 40; blank place → null', async () => {
    await post({ ...good, urgent: true, text: 'y'.repeat(120), place: 'p'.repeat(60) })
    let data = (itemCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data
    expect(data.severity).toBe('NOW')
    expect((data.title as string).length).toBe(80)
    expect((data.place as string).length).toBe(40)
    await post({ ...good, place: '   ' })
    data = (itemCreate.mock.calls[1][0] as { data: Record<string, unknown> }).data
    expect(data.place).toBeNull()
  })

  it('text of 2 characters → 400 Say what’s going on', async () => {
    const res = await post({ ...good, text: ' ok ' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Say what’s going on' })
    expect(itemCreate).not.toHaveBeenCalled()
  })

  it('text over 500 characters → 400', async () => {
    const res = await post({ ...good, text: 'z'.repeat(501) })
    expect(res.status).toBe(400)
    expect(itemCreate).not.toHaveBeenCalled()
  })

  it('a STAFF report with a tag cooks cannot pick → 400 Pick a tag', async () => {
    for (const tagId of ['tag-checklists', 'tag-money', 'tag-events', 'tag-nope', undefined]) {
      const res = await post({ ...good, tagId })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Pick a tag' })
    }
    expect(itemCreate).not.toHaveBeenCalled()
  })

  it('a LEAD may use any active non-manager-only tag; a MANAGER any active tag', async () => {
    asUser(LEAD)
    expect((await post({ ...good, tagId: 'tag-checklists' })).status).toBe(201)
    expect((await post({ ...good, tagId: 'tag-money' })).status).toBe(400)
    asUser(MANAGER)
    expect((await post({ ...good, tagId: 'tag-money' })).status).toBe(201)
    expect((await post({ ...good, tagId: 'tag-events' })).status).toBe(400)
  })

  it('a report into an out-of-scope kitchen → 403 and nothing is written', async () => {
    assertRcWritable.mockRejectedValueOnce(new MockAuthError(403, 'Revenue center is outside your access.'))
    const res = await post(good)
    expect(res.status).toBe(403)
    expect(itemCreate).not.toHaveBeenCalled()
    expect(tagFindUnique).not.toHaveBeenCalled()
  })

  it('a kitchen id that does not exist (foreign key) → 400 Pick a kitchen', async () => {
    itemCreate.mockRejectedValueOnce(Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' }))
    const res = await post({ ...good, rcId: 'rc-bogus' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Pick a kitchen' })
  })

  it('401 without a session', async () => {
    requireSession.mockRejectedValueOnce(new MockAuthError(401, 'Unauthorized'))
    const res = await post(good)
    expect(res.status).toBe(401)
  })
})
