import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Who's on today — one row per kitchen per prep day (PrepCrewDay).
const findUnique = vi.fn()
const upsert = vi.fn()
const cookFindMany = vi.fn()
vi.mock('@/lib/prisma', () => ({
  prisma: {
    prepCrewDay: { findUnique: (...a: unknown[]) => findUnique(...a), upsert: (...a: unknown[]) => upsert(...a) },
    cook: { findMany: (...a: unknown[]) => cookFindMany(...a) },
  },
}))
class AuthError extends Error { constructor(msg: string, public status: number) { super(msg) } }
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'STAFF' }))
vi.mock('@/lib/auth', () => ({ requireSession: () => requireSession(), AuthError }))
const assertRcWritable = vi.fn(async () => {})
vi.mock('@/lib/rc-scope', () => ({ assertRcWritable: (...a: unknown[]) => assertRcWritable(...(a as [])) }))

const get = (rc?: string) => ({ nextUrl: new URL(`http://x/api/prep/plan/crew${rc ? `?rc=${rc}` : ''}`) }) as unknown as NextRequest
const put = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest

beforeEach(() => {
  vi.clearAllMocks()
  cookFindMany.mockResolvedValue([{ id: 'liam' }, { id: 'anju' }])
  upsert.mockImplementation(async (args: { create: { cookIds: string[] } }) => ({ cookIds: args.create.cookIds }))
})

describe('GET /api/prep/plan/crew', () => {
  it('no row yet → nobody ticked', async () => {
    findUnique.mockResolvedValue(null)
    const { GET } = await import('../route')
    const res = await GET(get('rc1'))
    expect(await res.json()).toEqual({ cookIds: [] })
    expect(findUnique.mock.calls[0][0].where.revenueCenterId_listDate.revenueCenterId).toBe('rc1')
  })
  it('returns the stored crew', async () => {
    findUnique.mockResolvedValue({ cookIds: ['liam', 'anju'] })
    const { GET } = await import('../route')
    expect(await (await GET(get('rc1'))).json()).toEqual({ cookIds: ['liam', 'anju'] })
  })
  it('needs a kitchen', async () => {
    const { GET } = await import('../route')
    expect((await GET(get())).status).toBe(400)
  })
})

describe('PUT /api/prep/plan/crew', () => {
  it('stores the deduped, known, active cooks', async () => {
    const { PUT } = await import('../route')
    const res = await PUT(put({ revenueCenterId: 'rc1', cookIds: ['liam', 'anju', 'liam', 'ghost'] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ cookIds: ['liam', 'anju'] })
    expect(upsert.mock.calls[0][0].update).toEqual({ cookIds: ['liam', 'anju'] })
  })
  it('a non-array is a bad request', async () => {
    const { PUT } = await import('../route')
    expect((await PUT(put({ revenueCenterId: 'rc1', cookIds: 'liam' }))).status).toBe(400)
    expect(upsert).not.toHaveBeenCalled()
  })
  it('a kitchen you cannot edit is refused', async () => {
    assertRcWritable.mockRejectedValueOnce(new AuthError('read only', 403))
    const { PUT } = await import('../route')
    expect((await PUT(put({ revenueCenterId: 'rc1', cookIds: ['liam'] }))).status).toBe(403)
  })
  it('signed out → 401', async () => {
    requireSession.mockRejectedValueOnce(new AuthError('no', 401))
    const { PUT } = await import('../route')
    expect((await PUT(put({ revenueCenterId: 'rc1', cookIds: [] }))).status).toBe(401)
  })
})
