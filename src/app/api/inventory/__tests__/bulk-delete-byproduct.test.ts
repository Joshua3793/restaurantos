import { describe, it, expect, vi } from 'vitest'
import type { NextRequest } from 'next/server'

// A by-product row holds a Restrict link to its item: a bulk delete that
// includes one would throw and roll the whole batch back with a raw error.
// Refuse up front, naming the item, like the single-item delete does.

vi.mock('@/lib/auth', () => ({
  requireSession: async () => ({ id: 'u1', role: 'ADMIN', isActive: true }),
  AuthError: class extends Error { status = 403 },
}))
vi.mock('@/lib/recipeCosts', () => ({ syncPrepToInventory: vi.fn() }))
const transaction = vi.fn(async () => [])
vi.mock('@/lib/prisma', () => ({
  prisma: {
    inventoryItem: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        'mergedIntoId' in where ? [] : [{ id: 'fat', itemName: 'Beef Fat Trim' }]),
      deleteMany: vi.fn(),
    },
    recipeByproduct: { findMany: vi.fn(async () => [{ inventoryItemId: 'fat', inventoryItem: { itemName: 'Beef Fat Trim' } }]) },
    $transaction: (...a: unknown[]) => transaction(...(a as [])),
  },
}))

const bulk = await import('@/app/api/inventory/bulk/route')

describe('bulk delete', () => {
  it('refuses a selection that holds a by-product, naming it, and deletes nothing', async () => {
    const req = { json: async () => ({ ids: ['fat', 'other'], action: 'delete' }) } as unknown as NextRequest
    const res = await bulk.POST(req)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Beef Fat Trim comes off a prep recipe batch — take it off that recipe first, or deactivate it instead.')
    expect(transaction).not.toHaveBeenCalled()
  })
})
