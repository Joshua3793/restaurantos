import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const findUnique = vi.fn()
const upsert = vi.fn(async () => ({}))
const deleteMany = vi.fn(async () => ({ count: 1 }))
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'STAFF', name: 'Ana Ruiz', email: 'ana@x.test', isActive: true }))
const assertRcWritable = vi.fn(async () => {})

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError' }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    openCheckItem: { findUnique: (...a: unknown[]) => findUnique(...a) },
    openCheckTick: { upsert: (...a: unknown[]) => upsert(...(a as [])), deleteMany: (...a: unknown[]) => deleteMany(...(a as [])) },
  },
}))
vi.mock('@/lib/auth', () => ({ requireSession: (...a: unknown[]) => requireSession(...(a as [])), AuthError: MockAuthError }))
vi.mock('@/lib/rc-scope', () => ({ assertRcWritable: (...a: unknown[]) => assertRcWritable(...(a as [])) }))
vi.mock('@/lib/eod-close', () => ({ businessDateLocal: () => '2026-10-05' }))

const { PUT } = await import('@/app/api/open-checklist/[id]/tick/route')

const req = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest
const ctx = { params: { id: 'item1' } }

beforeEach(() => {
  vi.clearAllMocks()
  findUnique.mockResolvedValue({ revenueCenterId: 'rc1', isActive: true })
})

describe('PUT /api/open-checklist/[id]/tick', () => {
  it("ticks for today's business day, keeping the first ticker", async () => {
    const res = await PUT(req({ done: true }), ctx)
    expect(res.status).toBe(200)
    expect(upsert).toHaveBeenCalledWith({
      where: { itemId_businessDate: { itemId: 'item1', businessDate: '2026-10-05' } },
      create: { itemId: 'item1', businessDate: '2026-10-05', doneByName: 'Ana Ruiz' },
      update: {},
    })
    expect(assertRcWritable).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'rc1')
  })

  it("unticks only today's row", async () => {
    await PUT(req({ done: false }), ctx)
    expect(deleteMany).toHaveBeenCalledWith({ where: { itemId: 'item1', businessDate: '2026-10-05' } })
    expect(upsert).not.toHaveBeenCalled()
  })

  it('404s a switched-off item without writing', async () => {
    findUnique.mockResolvedValue({ revenueCenterId: 'rc1', isActive: false })
    expect((await PUT(req({ done: true }), ctx)).status).toBe(404)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('refuses a kitchen the cook cannot write to', async () => {
    assertRcWritable.mockRejectedValueOnce(new MockAuthError(403, 'Revenue center is outside your access.'))
    expect((await PUT(req({ done: true }), ctx)).status).toBe(403)
    expect(upsert).not.toHaveBeenCalled()
  })
})
