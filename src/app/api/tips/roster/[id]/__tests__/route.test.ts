import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Same vi.mock-of-Prisma pattern as src/app/api/sales/__tests__/put-tips.test.ts.
const cookFindUnique = vi.fn(async (args: { where: { id?: string; clockId?: string } }) => {
  if (args.where.id) return { id: 'c1', name: 'Sam Lee', clockId: '4521' }
  return null as { id: string; name: string; clockId: string | null } | null
})
const cookUpdate = vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
  id: where.id, name: 'Sam Lee', lastName: null, clockId: (data.clockId as string) ?? '4521',
  wage: null, dailyHourCap: null, tipRoleId: null, onTipPool: true,
}))
const tipRoleFindFirst = vi.fn(async () => ({ id: 'r1', name: 'Line Cook', isActive: true }))
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'MANAGER', isActive: true }))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

class MockPrismaClientKnownRequestError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'PrismaClientKnownRequestError'
    Object.setPrototypeOf(this, MockPrismaClientKnownRequestError.prototype)
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    cook: {
      findUnique: (...a: unknown[]) => cookFindUnique(...(a as [{ where: { id?: string; clockId?: string } }])),
      update: (...a: unknown[]) => cookUpdate(...(a as [{ where: { id: string }; data: Record<string, unknown> }])),
    },
    tipRole: {
      findFirst: (...a: unknown[]) => tipRoleFindFirst(...(a as [])),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: MockPrismaClientKnownRequestError },
}))

const { PATCH } = await import('@/app/api/tips/roster/[id]/route')
const { AuthError } = await import('@/lib/auth')

const req = (body: Record<string, unknown>) => ({ json: async () => body }) as unknown as NextRequest
const dataOf = () => cookUpdate.mock.calls[0][0].data as Record<string, unknown>

beforeEach(() => {
  cookFindUnique.mockClear()
  cookFindUnique.mockImplementation(async (args: { where: { id?: string; clockId?: string } }) => {
    if (args.where.id) return { id: 'c1', name: 'Sam Lee', clockId: '4521' }
    return null
  })
  cookUpdate.mockClear()
  tipRoleFindFirst.mockClear(); tipRoleFindFirst.mockResolvedValue({ id: 'r1', name: 'Line Cook', isActive: true })
  requireSession.mockClear(); requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true })
})

describe('PATCH /api/tips/roster/[id]', () => {
  it('only writes payroll-allowlisted fields, dropping anything outside it', async () => {
    const res = await PATCH(
      req({ wage: '18.5', name: 'Someone Else', isActive: false, homeStation: 'Grill' }),
      { params: { id: 'c1' } },
    )
    expect(res.status).toBe(200)
    const data = dataOf()
    expect(data.wage).toBe(18.5)
    expect('name' in data).toBe(false)
    expect('isActive' in data).toBe(false)
    expect('homeStation' in data).toBe(false)
  })

  it('returns a readable 409 naming the holder when the pre-check finds a collision', async () => {
    cookFindUnique.mockImplementation(async (args: { where: { id?: string; clockId?: string } }) => {
      if (args.where.id) return { id: 'c1', name: 'Sam Lee', clockId: '4521' }
      if (args.where.clockId) return { id: 'c2', name: 'Alex Kim', clockId: '9001' }
      return null
    })
    const res = await PATCH(req({ clockId: '9001' }), { params: { id: 'c1' } })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toContain('Alex Kim')
    expect(cookUpdate).not.toHaveBeenCalled()
  })

  it('maps a P2002 raised by a concurrent update to the same readable 409', async () => {
    // Calls happen in a fixed order: (1) existing-row lookup by id, (2) the
    // pre-check by clockId (sees no collision — another request wins the race
    // right after), (3) the post-P2002 lookup that names the holder.
    cookFindUnique.mockReset()
    cookFindUnique
      .mockResolvedValueOnce({ id: 'c1', name: 'Sam Lee', clockId: '4521' }) // existing
      .mockResolvedValueOnce(null) // pre-check: no collision yet
      .mockResolvedValueOnce({ id: 'c2', name: 'Alex Kim', clockId: '9001' }) // post-P2002
    cookUpdate.mockRejectedValueOnce(new MockPrismaClientKnownRequestError('Unique constraint failed', 'P2002'))
    const res = await PATCH(req({ clockId: '9001' }), { params: { id: 'c1' } })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toContain('Alex Kim')
  })

  it('rejects an unauthenticated caller with 401 and never reaches the update', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await PATCH(req({ wage: '18.5' }), { params: { id: 'c1' } })
    expect(res.status).toBe(401)
    expect(cookUpdate).not.toHaveBeenCalled()
  })
})
