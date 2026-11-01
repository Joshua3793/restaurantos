import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const requireSession = vi.fn(async (_min?: string) => ({ id: 'u1', role: 'MANAGER' }))
const tagCount = vi.fn()
const tagCreateMany = vi.fn(async (_a: unknown) => ({ count: 9 }))
const tagFindMany = vi.fn()
const tagFindUnique = vi.fn()
const tagCreate = vi.fn()
const tagUpdate = vi.fn()
const routeCreateMany = vi.fn(async (_a: unknown) => ({ count: 3 }))
const routeFindMany = vi.fn()
const routeFindFirst = vi.fn()
const routeUpsert = vi.fn(async (_a: unknown) => ({}))
const itemGroupBy = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    inboxTag: {
      count: () => tagCount(),
      createMany: (a: unknown) => tagCreateMany(a),
      findMany: (...a: unknown[]) => tagFindMany(...a),
      findUnique: (...a: unknown[]) => tagFindUnique(...a),
      create: (a: unknown) => tagCreate(a),
      update: (a: unknown) => tagUpdate(a),
    },
    inboxFlagRoute: {
      createMany: (a: unknown) => routeCreateMany(a),
      findMany: (...a: unknown[]) => routeFindMany(...a),
      findFirst: (...a: unknown[]) => routeFindFirst(...a),
      upsert: (a: unknown) => routeUpsert(a),
    },
    inboxItem: { groupBy: (a: unknown) => itemGroupBy(a) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [string?])),
  AuthError: MockAuthError,
}))

const tagsRoute = await import('@/app/api/inbox/tags/route')
const tagRoute = await import('@/app/api/inbox/tags/[id]/route')
const flagRoute = await import('@/app/api/inbox/flag-routes/route')

const t = (id: string, o: Record<string, unknown> = {}) => ({
  id, builtIn: null, name: id, color: '#16a34a',
  cookCanPick: false, managerOnly: false, isActive: true, ...o,
})
const TAGS = [
  t('tag-food_safety', { builtIn: 'FOOD_SAFETY', name: 'Food safety', cookCanPick: true }),
  t('tag-checklists', { builtIn: 'CHECKLISTS', name: 'Checklists' }),
  t('tag-money', { builtIn: 'MONEY', name: 'Money', color: '#7c3aed', managerOnly: true, cookCanPick: true }),
  t('tag-maintenance', { name: 'Maintenance', cookCanPick: true }),
  t('tag-events', { name: 'Events', cookCanPick: true, isActive: false }),
  t('tag-team', { builtIn: 'TEAM', name: 'Team' }),
]

const json = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest
const asRole = (role: string) => requireSession.mockResolvedValueOnce({ id: 'u1', role })

beforeEach(() => {
  vi.clearAllMocks()
  requireSession.mockImplementation(async () => ({ id: 'u1', role: 'MANAGER' }))
  tagCount.mockResolvedValue(9)
  tagFindMany.mockResolvedValue(TAGS)
  itemGroupBy.mockResolvedValue([])
  routeFindFirst.mockResolvedValue(null)
})

describe('seeding', () => {
  it('seeds tags then routes when there are no tags at all', async () => {
    tagCount.mockResolvedValue(0)
    await tagsRoute.GET()
    const tagArg = tagCreateMany.mock.calls[0][0] as { data: { id: string }[]; skipDuplicates: boolean }
    expect(tagArg.skipDuplicates).toBe(true)
    expect(tagArg.data.map(d => d.id)).toContain('tag-money')
    const routeArg = routeCreateMany.mock.calls[0][0] as { data: { reason: string; tagId: string }[]; skipDuplicates: boolean }
    expect(routeArg.skipDuplicates).toBe(true)
    expect(routeArg.data).toEqual(expect.arrayContaining([{ reason: 'BROKEN', tagId: 'tag-maintenance' }]))
  })

  it('never seeds when any tag exists (a removed starter tag stays gone)', async () => {
    await tagsRoute.GET()
    expect(tagCreateMany).not.toHaveBeenCalled()
    expect(routeCreateMany).not.toHaveBeenCalled()
  })
})

describe('GET /api/inbox/tags', () => {
  it('STAFF sees only active, cook-pickable, non-manager-only tags', async () => {
    asRole('STAFF')
    const body = await (await tagsRoute.GET()).json()
    expect(body.tags.map((x: { id: string }) => x.id)).toEqual(['tag-food_safety', 'tag-maintenance'])
  })

  it('LEAD sees active tags minus manager-only', async () => {
    asRole('LEAD')
    const body = await (await tagsRoute.GET()).json()
    expect(body.tags.map((x: { id: string }) => x.id)).toEqual(
      ['tag-food_safety', 'tag-checklists', 'tag-maintenance', 'tag-team'],
    )
    expect(itemGroupBy).not.toHaveBeenCalled()
  })

  it('MANAGER sees everything, inactive included, with open counts from one grouped query', async () => {
    itemGroupBy.mockResolvedValue([{ tagId: 'tag-money', _count: { _all: 3 } }])
    const body = await (await tagsRoute.GET()).json()
    expect(body.tags).toHaveLength(6)
    expect(body.tags.find((x: { id: string }) => x.id === 'tag-money').openCount).toBe(3)
    expect(body.tags.find((x: { id: string }) => x.id === 'tag-team').openCount).toBe(0)
    expect(itemGroupBy).toHaveBeenCalledTimes(1)
    expect(itemGroupBy.mock.calls[0][0]).toMatchObject({
      by: ['tagId'],
      where: { status: { in: ['OPEN', 'WAITING', 'SNOOZED'] } },
    })
  })
})

describe('POST /api/inbox/tags', () => {
  const create = (b: unknown) => tagsRoute.POST(json(b))

  it('403 for a LEAD', async () => {
    requireSession.mockRejectedValueOnce(new MockAuthError(403, 'Forbidden'))
    const res = await create({ name: 'Deliveries', color: '#2563eb', cookCanPick: true })
    expect(res.status).toBe(403)
    expect(requireSession).toHaveBeenCalledWith('MANAGER')
    expect(tagCreate).not.toHaveBeenCalled()
  })

  it('409 on a duplicate name, any case, among active tags', async () => {
    const res = await create({ name: '  maintenance ', color: '#2563eb', cookCanPick: true })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('There’s already a tag called maintenance')
    expect(tagCreate).not.toHaveBeenCalled()
  })

  it('allows reusing the name of an inactive tag', async () => {
    tagCreate.mockResolvedValue(t('new'))
    const res = await create({ name: 'events', color: '#2563eb', cookCanPick: false })
    expect(res.status).toBe(201)
  })

  it('400 on a missing or over-long name, and on an off-palette colour', async () => {
    const a = await create({ name: '   ', color: '#2563eb' })
    expect([a.status, (await a.json()).error]).toEqual([400, 'Give the tag a name'])
    const b = await create({ name: 'x'.repeat(25), color: '#2563eb' })
    expect(b.status).toBe(400)
    const c = await create({ name: 'Deliveries', color: '#7c3aed' })
    expect([c.status, (await c.json()).error]).toEqual([400, 'Pick a colour'])
  })

  it('creates a never-built-in, never-manager-only tag', async () => {
    tagCreate.mockResolvedValue(t('new', { name: 'Deliveries' }))
    const res = await create({ name: ' Deliveries ', color: '#2563eb', cookCanPick: true })
    expect(res.status).toBe(201)
    expect((tagCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({
      name: 'Deliveries', color: '#2563eb', cookCanPick: true, managerOnly: false,
    })
    expect((tagCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data).not.toHaveProperty('builtIn')
  })
})

describe('PATCH /api/inbox/tags/[id]', () => {
  const patch = (id: string, b: unknown) => tagRoute.PATCH(json(b), { params: { id } })

  it('400 when cookCanPick is sent for a built-in', async () => {
    const res = await patch('tag-checklists', { cookCanPick: true })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Built-in tags keep their settings')
    expect(tagUpdate).not.toHaveBeenCalled()
  })

  it('a built-in can be renamed and recoloured from the palette', async () => {
    tagUpdate.mockResolvedValue(t('tag-checklists'))
    const res = await patch('tag-checklists', { name: 'Lists', color: '#ca8a04' })
    expect(res.status).toBe(200)
    expect((tagUpdate.mock.calls[0][0] as { data: unknown }).data).toEqual({ name: 'Lists', color: '#ca8a04' })
  })

  it('Money keeps its purple, but cannot be changed to it or to a non-palette colour', async () => {
    tagUpdate.mockResolvedValue(t('tag-money'))
    expect((await patch('tag-money', { color: '#7c3aed' })).status).toBe(200)
    expect((await patch('tag-team', { color: '#7c3aed' })).status).toBe(400)
    expect((await patch('tag-money', { color: '#123456' })).status).toBe(400)
  })

  it('409 renaming onto another active tag, but not onto itself or an inactive one', async () => {
    expect((await patch('tag-team', { name: 'MONEY' })).status).toBe(409)
    tagUpdate.mockResolvedValue(t('tag-team'))
    expect((await patch('tag-team', { name: 'team' })).status).toBe(200)
    expect((await patch('tag-team', { name: 'Events' })).status).toBe(200)
  })

  it('a custom tag can change who may pick it', async () => {
    tagUpdate.mockResolvedValue(t('tag-maintenance'))
    const res = await patch('tag-maintenance', { cookCanPick: false })
    expect(res.status).toBe(200)
    expect((tagUpdate.mock.calls[0][0] as { data: unknown }).data).toEqual({ cookCanPick: false })
  })

  it('403 for a LEAD, 404 for an unknown tag', async () => {
    requireSession.mockRejectedValueOnce(new MockAuthError(403, 'Forbidden'))
    expect((await patch('tag-team', { name: 'X' })).status).toBe(403)
    expect((await patch('nope', { name: 'X' })).status).toBe(404)
  })
})

describe('DELETE /api/inbox/tags/[id]', () => {
  const del = (id: string) => tagRoute.DELETE({} as NextRequest, { params: { id } })

  it('409 for a built-in', async () => {
    tagFindUnique.mockResolvedValue({ id: 'tag-team', builtIn: 'TEAM' })
    const res = await del('tag-team')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Built-in tags can’t be removed')
    expect(tagUpdate).not.toHaveBeenCalled()
  })

  it('409 while a flag route points at it', async () => {
    tagFindUnique.mockResolvedValue({ id: 'tag-maintenance', builtIn: null })
    routeFindFirst.mockResolvedValue({ reason: 'BROKEN' })
    const res = await del('tag-maintenance')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Move the flag route off this tag first')
    expect(tagUpdate).not.toHaveBeenCalled()
  })

  it('switches a custom tag off instead of deleting it', async () => {
    tagFindUnique.mockResolvedValue({ id: 'tag-x', builtIn: null })
    const res = await del('tag-x')
    expect(res.status).toBe(200)
    expect(tagUpdate).toHaveBeenCalledWith({ where: { id: 'tag-x' }, data: { isActive: false } })
  })

  it('404 for an unknown tag', async () => {
    tagFindUnique.mockResolvedValue(null)
    expect((await del('nope')).status).toBe(404)
  })
})

describe('flag routes', () => {
  it('GET returns the tag id for each reason, MANAGER only', async () => {
    routeFindMany.mockResolvedValue([
      { reason: 'BROKEN', tagId: 'tag-maintenance' },
      { reason: 'RAN_OUT', tagId: 'tag-stock' },
      { reason: 'OTHER', tagId: 'tag-other' },
      { reason: 'OUT_OF_RANGE', tagId: 'tag-food_safety' },
    ])
    const res = await flagRoute.GET()
    expect(requireSession).toHaveBeenCalledWith('MANAGER')
    expect(await res.json()).toEqual({
      routes: { BROKEN: 'tag-maintenance', RAN_OUT: 'tag-stock', OTHER: 'tag-other' },
    })
  })

  it('PUT 400 for an inactive (or missing) tag, nothing written', async () => {
    tagFindUnique.mockResolvedValue({ id: 'tag-events', isActive: false })
    const res = await flagRoute.PUT(json({ reason: 'BROKEN', tagId: 'tag-events' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Pick an active tag')
    tagFindUnique.mockResolvedValue(null)
    expect((await flagRoute.PUT(json({ reason: 'BROKEN', tagId: 'zzz' }))).status).toBe(400)
    expect(routeUpsert).not.toHaveBeenCalled()
  })

  it('PUT points the reason at an active tag', async () => {
    tagFindUnique.mockResolvedValue({ id: 'tag-maintenance', isActive: true })
    const res = await flagRoute.PUT(json({ reason: 'RAN_OUT', tagId: 'tag-maintenance' }))
    expect(res.status).toBe(200)
    expect(routeUpsert).toHaveBeenCalledWith({
      where: { reason: 'RAN_OUT' },
      create: { reason: 'RAN_OUT', tagId: 'tag-maintenance' },
      update: { tagId: 'tag-maintenance' },
    })
  })

  it('PUT 400 for OUT_OF_RANGE (always Food safety) and 403 for a LEAD', async () => {
    expect((await flagRoute.PUT(json({ reason: 'OUT_OF_RANGE', tagId: 'tag-team' }))).status).toBe(400)
    requireSession.mockRejectedValueOnce(new MockAuthError(403, 'Forbidden'))
    expect((await flagRoute.PUT(json({ reason: 'BROKEN', tagId: 'tag-team' }))).status).toBe(403)
  })
})
