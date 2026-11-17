import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const requireSession = vi.fn(async (_min?: string) => ({ id: 'u1', name: 'Mia', email: 'm@x.ca', role: 'MANAGER', isActive: true }))
const assertRcWritable = vi.fn(async (..._a: unknown[]) => {})

const itemFindFirst = vi.fn()
const itemFindMany = vi.fn()
const stationFindMany = vi.fn()
const t = {
  catFindMany: vi.fn(async (_a: unknown): Promise<unknown[]> => []),
  catAggregate: vi.fn(async (_a: unknown) => ({ _max: { sortOrder: 2 } })),
  catCreate: vi.fn(async (_a: unknown) => ({ id: 'newcat', name: 'Food safety' })),
  itemAggregate: vi.fn(async (_a: unknown) => ({ _max: { sortOrder: 4 } })),
  itemCreate: vi.fn(async (a: unknown) => a),
  itemUpdateMany: vi.fn(async (_a: unknown) => ({ count: 1 })),
  itemUpdate: vi.fn(async (a: unknown) => a),
}
const tx = {
  checklistCategory: { findMany: (a: unknown) => t.catFindMany(a), aggregate: (a: unknown) => t.catAggregate(a), create: (a: unknown) => t.catCreate(a) },
  checklistItem: {
    aggregate: (a: unknown) => t.itemAggregate(a), create: (a: unknown) => t.itemCreate(a),
    updateMany: (a: unknown) => t.itemUpdateMany(a), update: (a: unknown) => t.itemUpdate(a),
  },
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    checklistItem: { findFirst: (a: unknown) => itemFindFirst(a), findMany: (a: unknown) => itemFindMany(a) },
    checklistStation: { findMany: (a: unknown) => stationFindMany(a) },
    $transaction: async (fn: (x: typeof tx) => Promise<unknown>) => fn(tx),
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [string?])),
  AuthError: class extends Error { status = 403 },
}))
vi.mock('@/lib/rc-scope', () => ({ assertRcWritable: (...a: unknown[]) => assertRcWritable(...a) }))
vi.mock('crypto', async () => ({ ...(await vi.importActual<object>('crypto')), randomUUID: () => 'NEW' }))
vi.mock('node:crypto', async () => ({ ...(await vi.importActual<object>('node:crypto')), randomUUID: () => 'NEW' }))

const { PUT } = await import('@/app/api/checklists/items/[id]/lists/route')
const put = (body: unknown) => PUT({ json: async () => body } as unknown as NextRequest, { params: { id: 'g1' } })

const job = {
  id: 'g1', linkId: null as string | null, title: 'Sanitiser buckets', howTo: null, isBlocker: true, answer: 'TICK', unit: null,
  safeMin: null, safeMax: null, tempUnitId: null, days: 127, dueBy: '08:45',
  category: { name: 'Food safety', phase: 'OPEN', stationId: 'grill', station: { revenueCenterId: 'rc1' } },
}

beforeEach(() => {
  vi.clearAllMocks()
  itemFindFirst.mockResolvedValue(job)
  stationFindMany.mockImplementation(async (a: { where: { id: { in: string[] } } }) => a.where.id.in.map(id => ({ id })))
  itemFindMany.mockResolvedValue([])
  t.catFindMany.mockResolvedValue([])
})

describe('PUT /api/checklists/items/[id]/lists', () => {
  it('managers only', async () => {
    await put({ stationIds: ['grill'] })
    expect(requireSession).toHaveBeenCalledWith('MANAGER')
  })

  it('puts a copy on a new list, in its category of the same name, sharing one link', async () => {
    t.catFindMany.mockResolvedValue([{ id: 'bennyFS', name: 'FOOD SAFETY' }])
    const res = await put({ stationIds: ['grill', 'benny'] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, lists: 2 })
    expect(t.catCreate).not.toHaveBeenCalled()
    expect(t.itemCreate.mock.calls[0][0]).toMatchObject({
      data: { categoryId: 'bennyFS', linkId: 'NEW', sortOrder: 5, title: 'Sanitiser buckets', isBlocker: true, dueBy: '08:45' },
    })
    expect(t.itemUpdate).toHaveBeenCalledWith({ where: { id: 'g1' }, data: { linkId: 'NEW' } })
  })

  it('makes the category when the other list has none of that name', async () => {
    await put({ stationIds: ['grill', 'crew'] })
    expect(t.catCreate.mock.calls[0][0]).toMatchObject({ data: { stationId: 'crew', phase: 'OPEN', name: 'Food safety', sortOrder: 3 } })
    expect(t.itemCreate.mock.calls[0][0]).toMatchObject({ data: { categoryId: 'newcat' } })
  })

  it('takes a copy off an unticked list, and a job back to one list loses its link', async () => {
    itemFindFirst.mockResolvedValue({ ...job, linkId: 'L' })
    itemFindMany.mockResolvedValue([
      { id: 'g1', category: { stationId: 'grill' } },
      { id: 'b1', category: { stationId: 'benny' } },
    ])
    const res = await put({ stationIds: ['grill'] })
    expect(await res.json()).toEqual({ ok: true, lists: 1 })
    expect(t.itemUpdateMany).toHaveBeenCalledWith({ where: { id: { in: ['b1'] } }, data: { isActive: false } })
    expect(t.itemUpdateMany).toHaveBeenCalledWith({ where: { linkId: 'L', isActive: true }, data: { linkId: null } })
    expect(t.itemCreate).not.toHaveBeenCalled()
  })

  it('refuses lists from another kitchen', async () => {
    stationFindMany.mockResolvedValue([{ id: 'grill' }])
    const res = await put({ stationIds: ['grill', 'elsewhere'] })
    expect(res.status).toBe(400)
    expect(t.itemCreate).not.toHaveBeenCalled()
  })
})
