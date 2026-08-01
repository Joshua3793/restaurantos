import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Same vi.mock-of-Prisma pattern as src/app/api/sales/__tests__/put-tips.test.ts:
// stub Prisma + auth so the route logic runs with no database. `requireSession`
// is a vi.fn so individual tests can override it to simulate an unauthenticated
// caller.
const tipRoleFindUnique = vi.fn(async () => ({ id: 'r1', name: 'Line Cook', multiplier: 1, sortOrder: 0, isActive: true }))
const tipRoleCount = vi.fn(async () => 1)
const tipRoleFindFirst = vi.fn(async () => ({ id: 'r2', name: 'Prep', multiplier: 1, sortOrder: 1, isActive: true }))
const tipRoleUpdate = vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, name: 'x', multiplier: 1, sortOrder: 0, isActive: false }))
const cookUpdateMany = vi.fn(async () => ({ count: 3 }))
const transaction = vi.fn(async (ops: unknown[]) => Promise.all(ops))
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'MANAGER', isActive: true }))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tipRole: {
      findUnique: (...a: unknown[]) => tipRoleFindUnique(...(a as [])),
      count: (...a: unknown[]) => tipRoleCount(...(a as [])),
      findFirst: (...a: unknown[]) => tipRoleFindFirst(...(a as [])),
      update: (...a: unknown[]) => tipRoleUpdate(...(a as [])),
    },
    cook: {
      updateMany: (...a: unknown[]) => cookUpdateMany(...(a as [])),
    },
    $transaction: (...a: unknown[]) => transaction(...(a as [Promise<unknown>[]])),
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))

const { PATCH, DELETE } = await import('@/app/api/tips/roles/[id]/route')
const { AuthError } = await import('@/lib/auth')

const req = (body?: Record<string, unknown>, search?: string) =>
  ({
    json: async () => body ?? {},
    nextUrl: { searchParams: new URLSearchParams(search ?? '') },
  }) as unknown as NextRequest

beforeEach(() => {
  tipRoleFindUnique.mockClear(); tipRoleFindUnique.mockResolvedValue({ id: 'r1', name: 'Line Cook', multiplier: 1, sortOrder: 0, isActive: true })
  tipRoleCount.mockClear(); tipRoleCount.mockResolvedValue(1)
  tipRoleFindFirst.mockClear(); tipRoleFindFirst.mockResolvedValue({ id: 'r2', name: 'Prep', multiplier: 1, sortOrder: 1, isActive: true })
  tipRoleUpdate.mockClear()
  cookUpdateMany.mockClear()
  transaction.mockClear()
  requireSession.mockClear(); requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true })
})

describe('DELETE /api/tips/roles/[id]', () => {
  it('rejects a self-referential fallbackRoleId with 400 and makes no write', async () => {
    // Explicit fallback resolves via findFirst — simulate the buggy pre-fix
    // behaviour NOT happening: since we exclude id: params.id, a self-referential
    // fallbackRoleId must resolve to nothing.
    tipRoleFindFirst.mockResolvedValueOnce(null)
    const res = await DELETE(req(undefined, 'fallbackRoleId=r1'), { params: { id: 'r1' } })
    expect(res.status).toBe(400)
    expect(tipRoleFindFirst).toHaveBeenCalledWith({ where: { id: 'r1', isActive: true, NOT: { id: 'r1' } } })
    expect(tipRoleUpdate).not.toHaveBeenCalled()
    expect(cookUpdateMany).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('reassigns cooks and deactivates the role inside one transaction, given a valid distinct fallback', async () => {
    const res = await DELETE(req(undefined, 'fallbackRoleId=r2'), { params: { id: 'r1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.movedTo).toBe('r2')
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(cookUpdateMany).toHaveBeenCalledWith({ where: { tipRoleId: 'r1' }, data: { tipRoleId: 'r2' } })
    expect(tipRoleUpdate).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { isActive: false } })
  })

  it('rejects deleting the last live role with 400', async () => {
    tipRoleCount.mockResolvedValueOnce(0)
    const res = await DELETE(req(undefined, ''), { params: { id: 'r1' } })
    expect(res.status).toBe(400)
    expect(tipRoleUpdate).not.toHaveBeenCalled()
    expect(cookUpdateMany).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated caller with 401 and never reaches a write', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await DELETE(req(undefined, 'fallbackRoleId=r2'), { params: { id: 'r1' } })
    expect(res.status).toBe(401)
    expect(tipRoleUpdate).not.toHaveBeenCalled()
    expect(cookUpdateMany).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/tips/roles/[id]', () => {
  it('rejects a non-numeric sortOrder with 400 rather than coercing to 0', async () => {
    const res = await PATCH(req({ sortOrder: 'abc' }), { params: { id: 'r1' } })
    expect(res.status).toBe(400)
    expect(tipRoleUpdate).not.toHaveBeenCalled()
  })

  it('accepts a valid integer sortOrder', async () => {
    const res = await PATCH(req({ sortOrder: 3 }), { params: { id: 'r1' } })
    expect(res.status).toBe(200)
    expect(tipRoleUpdate).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { sortOrder: 3 } })
  })

  it('rejects an unauthenticated caller with 401 and never reaches the update', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await PATCH(req({ sortOrder: 3 }), { params: { id: 'r1' } })
    expect(res.status).toBe(401)
    expect(tipRoleUpdate).not.toHaveBeenCalled()
  })
})
