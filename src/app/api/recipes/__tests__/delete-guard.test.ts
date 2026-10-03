import { describe, it, expect, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { ROLE_RANK } from '@/lib/roles'

type Role = keyof typeof ROLE_RANK
const h = vi.hoisted(() => {
  class MockAuthError extends Error {
    constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError' }
  }
  return { MockAuthError, role: 'LEAD' as string }
})
vi.mock('@/lib/auth', () => ({
  requireSession: async (min?: Role) => {
    if (min && ROLE_RANK[h.role as Role] < ROLE_RANK[min]) throw new h.MockAuthError(403, 'Forbidden')
    return { id: 'u1', role: h.role, isActive: true }
  },
  AuthError: h.MockAuthError,
}))
const transaction = vi.fn(async (..._a: unknown[]) => undefined)
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: (...a: unknown[]) => transaction(...a) } }))
vi.mock('@/lib/recipeCosts', () => ({
  fetchRecipeWithCost: vi.fn(), resyncPrepRecipe: vi.fn(), propagatePrepCostChanges: vi.fn(async () => undefined),
}))
vi.mock('@/lib/prep-sync', () => ({ syncPrepItemFromRecipe: vi.fn() }))

import * as recipe from '../[id]/route'

const req = {} as NextRequest
const ctx = { params: { id: 'r1' } }

describe('DELETE /api/recipes/[id]', () => {
  it.each(['STAFF', 'LEAD'] as const)('refuses %s before touching the database', async role => {
    h.role = role
    transaction.mockClear()
    expect((await recipe.DELETE(req, ctx)).status).toBe(403)
    expect(transaction).not.toHaveBeenCalled()
  })

  it('lets a MANAGER delete', async () => {
    h.role = 'MANAGER'
    expect((await recipe.DELETE(req, ctx)).status).toBe(200)
    expect(transaction).toHaveBeenCalled()
  })
})
