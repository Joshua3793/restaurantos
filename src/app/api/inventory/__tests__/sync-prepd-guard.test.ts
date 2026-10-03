import { describe, it, expect, vi } from 'vitest'
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
const findMany = vi.fn(async (..._a: unknown[]) => [])
vi.mock('@/lib/prisma', () => ({ prisma: { recipe: { findMany: (...a: unknown[]) => findMany(...a) } } }))
vi.mock('@/lib/recipeCosts', () => ({ syncPrepToInventory: vi.fn() }))

import * as syncPrepd from '../sync-prepd/route'

describe('POST /api/inventory/sync-prepd', () => {
  it.each(['STAFF', 'LEAD'] as const)('refuses %s before touching the database', async role => {
    h.role = role
    findMany.mockClear()
    expect((await syncPrepd.POST()).status).toBe(403)
    expect(findMany).not.toHaveBeenCalled()
  })

  it('lets a MANAGER past the gate', async () => {
    h.role = 'MANAGER'
    findMany.mockClear()
    await syncPrepd.POST().catch(() => undefined)
    expect(findMany).toHaveBeenCalled()
  })
})
