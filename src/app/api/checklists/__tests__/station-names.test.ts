import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const requireSession = vi.fn(async (..._a: unknown[]) => ({ id: 'u1', name: 'Sam Lee', email: 'sam@x.ca', role: 'STAFF', isActive: true }))
const isRcInScope = vi.fn(async (..._a: unknown[]) => true)
const stationFindMany = vi.fn()
const writes = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    cook: { findUnique: async () => null },
    checklistStation: {
      findMany: (...a: unknown[]) => stationFindMany(...a),
      createMany: (...a: unknown[]) => writes(...a),
      create: (...a: unknown[]) => writes(...a),
    },
    checklistRun: { create: (...a: unknown[]) => writes(...a), upsert: (...a: unknown[]) => writes(...a) },
    $transaction: (...a: unknown[]) => writes(...a),
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...a),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({ isRcInScope: (...a: unknown[]) => isRcInScope(...a) }))

const { GET } = await import('@/app/api/checklists/station-names/route')

const get = (rcId?: string) =>
  GET({ nextUrl: { searchParams: new URLSearchParams(rcId ? { rcId } : {}) } } as unknown as NextRequest)

beforeEach(() => {
  vi.clearAllMocks()
  isRcInScope.mockResolvedValue(true)
  stationFindMany.mockResolvedValue([{ name: 'Grill' }, { name: 'Pastry' }])
})

describe('GET /api/checklists/station-names', () => {
  it('returns the active, non-shared station names in order, for any signed-in person', async () => {
    const res = await get('rc1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ names: ['Grill', 'Pastry'] })
    expect(requireSession).toHaveBeenCalledWith()
    expect(stationFindMany).toHaveBeenCalledWith({
      where: { revenueCenterId: 'rc1', isActive: true, isShared: false },
      orderBy: { sortOrder: 'asc' },
      select: { name: true },
    })
  })

  it('never writes: no seeding, no runs', async () => {
    stationFindMany.mockResolvedValue([])
    const res = await get('rc1')
    expect(await res.json()).toEqual({ names: [] })
    expect(writes).not.toHaveBeenCalled()
  })

  it('400 without rcId; 403 outside the caller’s access (and nothing is read)', async () => {
    expect((await get()).status).toBe(400)
    isRcInScope.mockResolvedValue(false)
    expect((await get('rc9')).status).toBe(403)
    expect(stationFindMany).not.toHaveBeenCalled()
  })

  it('passes a sign-in failure through as its own status', async () => {
    requireSession.mockRejectedValueOnce(new MockAuthError(401, 'Not signed in'))
    expect((await get('rc1')).status).toBe(401)
  })
})
