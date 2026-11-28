import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Bulk "move to storage area": only items actually changing area are written,
// and those lose their shelf position (it belongs to the old area's walk order).

vi.mock('@/lib/auth', () => ({
  requireSession: async () => ({ id: 'u1', role: 'ADMIN', isActive: true }),
  AuthError: class extends Error { status = 403 },
}))
vi.mock('@/lib/recipeCosts', () => ({ syncPrepToInventory: vi.fn() }))
const updateMany = vi.fn(async (_a: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({ count: 1 }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    inventoryItem: {
      findMany: vi.fn(async () => []),
      updateMany: (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => updateMany(a),
    },
  },
}))

const bulk = await import('@/app/api/inventory/bulk/route')
const req = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest

beforeEach(() => updateMany.mockClear())

describe('bulk setStorageArea', () => {
  it('writes only items in another (or no) area, clearing their shelf position', async () => {
    const res = await bulk.POST(req({ ids: ['a', 'b'], action: 'setStorageArea', value: 'dry' }))
    expect(res.status).toBe(200)
    expect(updateMany).toHaveBeenCalledTimes(1)
    const { where, data } = updateMany.mock.calls[0][0]
    expect(data).toEqual({ storageAreaId: 'dry', shelfOrder: null })
    expect(where).toEqual({ id: { in: ['a', 'b'] }, OR: [{ storageAreaId: null }, { storageAreaId: { not: 'dry' } }] })
  })

  it('clearing the area touches only items that had one', async () => {
    await bulk.POST(req({ ids: ['a'], action: 'setStorageArea', value: null }))
    const { where, data } = updateMany.mock.calls[0][0]
    expect(data).toEqual({ storageAreaId: null, shelfOrder: null })
    expect(where).toEqual({ id: { in: ['a'] }, storageAreaId: { not: null } })
  })
})
