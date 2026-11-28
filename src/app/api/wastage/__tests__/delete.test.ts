import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// A cuid v1 id whose time part is `ms` — what Prisma's @default(cuid()) writes.
const cuidAt = (ms: number) => `c${ms.toString(36).padStart(8, '0')}${'a1b2c3d4e5f6g7h8'}`
const NOW = new Date('2026-11-27T20:00:00.000Z')
const HOUR = 3_600_000

type Row = { id: string; date: Date; loggedBy: string; revenueCenterId: string; costImpact: string; inventoryItem: object }
let rows: Row[] = []
let role = 'STAFF'
let rcWritable = true
const deleteMany = vi.fn(async ({ where }: { where: { id: string } }) => {
  const before = rows.length
  rows = rows.filter(r => r.id !== where.id)
  return { count: before - rows.length }
})

vi.mock('@/lib/prisma', () => ({
  prisma: {
    wastageLog: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.find(r => r.id === where.id) ?? null,
      findMany: async () => rows,
      deleteMany,
    },
    cook: { findUnique: async () => null },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: async () => ({ id: 'u1', role, isActive: true, name: 'Sam Lee', email: 'sam@fergies.test' }),
  AuthError: class extends Error { constructor(public status: number, m: string) { super(m) } },
}))
vi.mock('@/lib/rc-scope', async () => {
  const { AuthError } = await import('@/lib/auth')
  return {
    scopeWhereFromParams: async () => ({}),
    assertRcWritable: async () => { if (!rcWritable) throw new (AuthError as unknown as new (s: number, m: string) => Error)(403, 'Revenue center is outside your access.') },
  }
})
const invalidate = vi.fn()
vi.mock('@/lib/theoretical-cache', () => ({
  invalidatesTheoretical: (h: (...a: unknown[]) => Promise<Response>) => async (...a: unknown[]) => {
    const res = await h(...a); if (res.ok) invalidate(); return res
  },
}))

const byId = await import('@/app/api/wastage/[id]/route')
const list = await import('@/app/api/wastage/route')
const { loggedAtOf } = await import('@/app/api/wastage/rules')

const del = (id: string) => byId.DELETE({} as NextRequest, { params: { id } })
const entry = (over: Partial<Row> & { ageHours: number }): Row => ({
  id: cuidAt(NOW.getTime() - over.ageHours * HOUR),
  date: new Date('2026-11-27T00:00:00.000Z'),
  loggedBy: 'Sam Lee',
  revenueCenterId: 'rc1',
  costImpact: '12.50',
  inventoryItem: { id: 'i1', itemName: 'Goats Cheese', category: 'DAIRY', baseUnit: 'g' },
  ...over,
})

describe('DELETE /api/wastage/:id', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW)
    rows = []; role = 'STAFF'; rcWritable = true
    deleteMany.mockClear(); invalidate.mockClear()
  })

  it('lets the cook who logged it undo it within 24 hours, and drops the stock cache', async () => {
    const w = entry({ ageHours: 0.01 }); rows = [w]
    const res = await del(w.id)
    expect(res.status).toBe(200)
    expect(rows).toHaveLength(0)
    expect(invalidate).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it("refuses the cook after 24 hours, and refuses someone else's entry", async () => {
    const old = entry({ ageHours: 25 })
    const theirs = entry({ ageHours: 1, loggedBy: 'Alex Kim' })
    rows = [old, theirs]
    expect((await del(old.id)).status).toBe(403)
    expect((await del(theirs.id)).status).toBe(403)
    expect(deleteMany).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("lets a manager delete anyone's entry, any age", async () => {
    role = 'MANAGER'
    const w = entry({ ageHours: 24 * 30, loggedBy: 'Alex Kim' }); rows = [w]
    expect((await del(w.id)).status).toBe(200)
    expect(rows).toHaveLength(0)
    vi.useRealTimers()
  })

  it('refuses an entry outside the caller\'s revenue centers, and 404s a missing one', async () => {
    const w = entry({ ageHours: 1 }); rows = [w]
    rcWritable = false
    expect((await del(w.id)).status).toBe(403)
    expect((await del('nope')).status).toBe(404)
    expect(deleteMany).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('GET /api/wastage money + delete flags', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); role = 'STAFF' })
  const get = () => list.GET({ url: 'http://x/api/wastage' } as unknown as NextRequest)

  it('nulls the cost for a cook and flags only their own fresh entries deletable', async () => {
    rows = [entry({ ageHours: 1 }), entry({ ageHours: 30 }), entry({ ageHours: 1, loggedBy: 'Alex Kim' })]
    const body = await (await get()).json()
    expect(body.map((r: { costImpact: unknown }) => r.costImpact)).toEqual([null, null, null])
    expect(body.map((r: { canDelete: boolean }) => r.canDelete)).toEqual([true, false, false])
    vi.useRealTimers()
  })

  it('keeps the cost for a manager, who may delete every row', async () => {
    role = 'MANAGER'
    rows = [entry({ ageHours: 30, loggedBy: 'Alex Kim' })]
    const body = await (await get()).json()
    expect(body[0].costImpact).toBe('12.50')
    expect(body[0].canDelete).toBe(true)
    vi.useRealTimers()
  })
})

describe('loggedAtOf', () => {
  it('reads the creation time out of a cuid id', () => {
    const at = NOW.getTime() - 5 * HOUR
    expect(loggedAtOf({ id: cuidAt(at), date: new Date(0) }, NOW).getTime()).toBe(at)
  })
  it('falls back to the day marker for an id that is not a cuid', () => {
    const date = new Date('2026-11-26T00:00:00.000Z')
    expect(loggedAtOf({ id: 'w1', date }, NOW)).toEqual(date)
  })
})
