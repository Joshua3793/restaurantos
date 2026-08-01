import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Same vi.mock-of-Prisma pattern as src/app/api/sales/__tests__/put-tips.test.ts.
const cookFindUnique = vi.fn(async () => null as { id: string; name: string; clockId: string | null } | null)
const cookCreate = vi.fn(async () => ({ id: 'c1' }))
const cookCount = vi.fn(async () => 0)
const tipRoleFindMany = vi.fn(async () => [{ id: 'r1', name: 'Line Cook', sortOrder: 0 }])
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'MANAGER', isActive: true }))
const loadSettings = vi.fn(async () => ({ posMap: {}, defaultDailyHourCap: null }))

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
      findUnique: (...a: unknown[]) => cookFindUnique(...(a as [])),
      create: (...a: unknown[]) => cookCreate(...(a as [])),
      count: (...a: unknown[]) => cookCount(...(a as [])),
    },
    tipRole: {
      findMany: (...a: unknown[]) => tipRoleFindMany(...(a as [])),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/tips/settings', () => ({
  loadSettings: (...a: unknown[]) => loadSettings(...(a as [])),
}))
vi.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: MockPrismaClientKnownRequestError },
}))

const { POST } = await import('@/app/api/tips/roster/route')
const { AuthError } = await import('@/lib/auth')

const req = (body: Record<string, unknown>) => ({ json: async () => body }) as unknown as NextRequest
const base = { firstName: 'Sam', lastName: 'Lee', clockId: '4521', position: 'Line Cook' }

beforeEach(() => {
  cookFindUnique.mockClear(); cookFindUnique.mockResolvedValue(null)
  cookCreate.mockClear(); cookCreate.mockResolvedValue({ id: 'c1' })
  cookCount.mockClear(); cookCount.mockResolvedValue(0)
  tipRoleFindMany.mockClear()
  loadSettings.mockClear(); loadSettings.mockResolvedValue({ posMap: {}, defaultDailyHourCap: null })
  requireSession.mockClear(); requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true })
})

describe('POST /api/tips/roster', () => {
  it('creates a roster row when clockId is free', async () => {
    const res = await POST(req(base))
    expect(res.status).toBe(201)
    expect(cookCreate).toHaveBeenCalledTimes(1)
  })

  it('returns a readable 409 naming the holder when the pre-check finds a collision', async () => {
    cookFindUnique.mockResolvedValueOnce({ id: 'other', name: 'Alex Kim', clockId: '4521' })
    const res = await POST(req(base))
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toContain('Alex Kim')
    expect(cookCreate).not.toHaveBeenCalled()
  })

  it('maps a P2002 raised by a concurrent create to the same readable 409', async () => {
    // Pre-check passes (no collision seen yet), but the create loses a race to
    // another request for the same clockId.
    cookFindUnique
      .mockResolvedValueOnce(null) // pre-check
      .mockResolvedValueOnce({ id: 'other', name: 'Alex Kim', clockId: '4521' }) // post-P2002 lookup
    cookCreate.mockRejectedValueOnce(new MockPrismaClientKnownRequestError('Unique constraint failed', 'P2002'))
    const res = await POST(req(base))
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toContain('Alex Kim')
  })

  it('rejects an unauthenticated caller with 401 and never reaches the create', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await POST(req(base))
    expect(res.status).toBe(401)
    expect(cookCreate).not.toHaveBeenCalled()
  })
})
