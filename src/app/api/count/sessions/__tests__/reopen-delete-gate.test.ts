import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Reopening an approved count and deleting a count are MANAGER+. Every other
// PATCH on the session stays open to any counter — Approve itself marks the
// session UPDATING (and reverts to PENDING_REVIEW on failure) through this route.

const RANK: Record<string, number> = { STAFF: 0, LEAD: 1, MANAGER: 2, ADMIN: 3, OWNER: 4 }

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError' }
}

let role = 'STAFF'
let status = 'FINALIZED'
const update = vi.fn(async (a: { data: Record<string, unknown> }) => ({ id: 's1', ...a.data }))
const del = vi.fn(async () => ({ id: 's1' }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    countSession: {
      findUnique: async () => ({ revenueCenterId: null, status }),
      update: (a: { data: Record<string, unknown> }) => update(a),
      delete: () => del(),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: async (min?: string) => {
    if (min && RANK[role] < RANK[min]) throw new MockAuthError(403, 'Insufficient permissions')
    return { id: 'u1', role, isActive: true }
  },
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  isRcInScope: async () => true,
  assertRcWritable: async () => undefined,
}))

const detail = await import('@/app/api/count/sessions/[id]/route')
const ctx = { params: { id: 's1' } }
const patch = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest

beforeEach(() => { update.mockClear(); del.mockClear(); role = 'STAFF'; status = 'FINALIZED' })

describe('count session reopen / delete gate', () => {
  it.each(['STAFF', 'LEAD'])('%s cannot reopen an approved count', async r => {
    role = r
    const res = await detail.PATCH(patch({ status: 'IN_PROGRESS' }), ctx)
    expect(res.status).toBe(403)
    expect(update).not.toHaveBeenCalled()
  })

  it('a manager can reopen an approved count', async () => {
    role = 'MANAGER'
    const res = await detail.PATCH(patch({ status: 'IN_PROGRESS' }), ctx)
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledOnce()
  })

  it.each([
    ['IN_PROGRESS', 'UPDATING'],      // Approve marks the session
    ['UPDATING', 'PENDING_REVIEW'],   // Approve failed — revert
  ])('a cook can still move %s → %s (normal approve flow)', async (from, to) => {
    status = from
    const res = await detail.PATCH(patch({ status: to }), ctx)
    expect(res.status).toBe(200)
    expect(update).toHaveBeenCalledOnce()
  })

  it('a cook can still edit the label of an approved count', async () => {
    const res = await detail.PATCH(patch({ label: 'Tuesday count' }), ctx)
    expect(res.status).toBe(200)
  })

  it.each(['STAFF', 'LEAD'])('%s cannot delete a count', async r => {
    role = r
    status = 'IN_PROGRESS'
    const res = await detail.DELETE(patch({}), ctx)
    expect(res.status).toBe(403)
    expect(del).not.toHaveBeenCalled()
  })

  it('a manager can delete a count', async () => {
    role = 'MANAGER'
    const res = await detail.DELETE(patch({}), ctx)
    expect(res.status).toBe(200)
    expect(del).toHaveBeenCalledOnce()
  })
})
