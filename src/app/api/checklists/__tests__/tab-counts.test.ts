import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const requireSession = vi.fn(async (..._a: unknown[]) => ({ id: 'u1', role: 'MANAGER', isActive: true }))
const isRcInScope = vi.fn(async (..._a: unknown[]) => true)
const itemCount = vi.fn(async (..._a: unknown[]) => 2)
const deviceFindMany = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => [])

vi.mock('@/lib/prisma', () => ({
  prisma: {
    inboxItem: { count: (...a: unknown[]) => itemCount(...a) },
    pinDevice: { findMany: (...a: unknown[]) => deviceFindMany(...a) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...a),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({ isRcInScope: (...a: unknown[]) => isRcInScope(...a) }))
vi.mock('@/lib/pin/crew-status', () => ({
  pinBlocked: (_id: string, user: { role: string } | null) => (user?.role === 'MANAGER' ? 'MANAGER' : null),
}))

const { GET } = await import('@/app/api/checklists/tab-counts/route')

const get = (rcId?: string) =>
  GET({ nextUrl: { searchParams: new URLSearchParams(rcId ? { rcId } : {}) } } as unknown as NextRequest)

beforeEach(() => {
  vi.clearAllMocks()
  requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true })
  isRcInScope.mockResolvedValue(true)
  itemCount.mockResolvedValue(2)
  deviceFindMany.mockResolvedValue([])
})

describe('GET /api/checklists/tab-counts', () => {
  it('is for leads and up', async () => {
    await get('rc1')
    expect(requireSession).toHaveBeenCalledWith('LEAD')
  })

  it('needs a kitchen in scope', async () => {
    expect((await get()).status).toBe(400)
    isRcInScope.mockResolvedValue(false)
    expect((await get('rc1')).status).toBe(403)
    expect(itemCount).not.toHaveBeenCalled()
  })

  it('counts the open "station behind" alerts for this kitchen only', async () => {
    const res = await get('rc1')
    expect((await res.json()).behind).toBe(2)
    expect(itemCount).toHaveBeenCalledWith({
      where: {
        revenueCenterId: 'rc1',
        status: 'OPEN',
        OR: [{ sourceKey: { startsWith: 'station-open:' } }, { sourceKey: { startsWith: 'close-unsigned:' } }],
      },
    })
  })

  it('counts waiting phones for a manager, leaving out phones that wait on no one', async () => {
    deviceFindMany.mockResolvedValue([
      { cookId: 'c1', cook: { user: { role: 'STAFF', isActive: true, email: 'pin+c1@x' } } },
      { cookId: 'c2', cook: { user: null } },
      { cookId: 'c3', cook: { user: { role: 'MANAGER', isActive: true, email: 'm@x' } } },
    ])
    const body = await (await get('rc1')).json()
    expect(body.phones).toBe(2)
    expect(deviceFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'PENDING', cook: { isActive: true } } }))
  })

  it('a lead gets no phone count and the phones are never read', async () => {
    requireSession.mockResolvedValue({ id: 'u2', role: 'LEAD', isActive: true })
    const body = await (await get('rc1')).json()
    expect(body).toEqual({ behind: 2, phones: null })
    expect(deviceFindMany).not.toHaveBeenCalled()
  })

  it('passes a refused session through', async () => {
    requireSession.mockRejectedValue(new MockAuthError(403, 'Forbidden'))
    expect((await get('rc1')).status).toBe(403)
  })
})
