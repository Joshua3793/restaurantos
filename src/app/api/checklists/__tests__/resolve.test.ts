import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const requireSession = vi.fn(async (_min?: string) => ({ id: 'u9', name: 'Lena Lead', email: 'lena@x.ca', role: 'LEAD', isActive: true }))
const assertRcWritable = vi.fn(async (..._a: unknown[]) => {})
const lineFindUnique = vi.fn()
const lineUpdateMany = vi.fn(async (_a: unknown) => ({ count: 1 }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    checklistRunLine: {
      findUnique: (...a: unknown[]) => lineFindUnique(...a),
      updateMany: (a: unknown) => lineUpdateMany(a),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [string?])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  assertRcWritable: (...a: unknown[]) => assertRcWritable(...a),
}))

const { POST } = await import('@/app/api/checklists/lines/[id]/resolve/route')

const call = () => POST({} as unknown as NextRequest, { params: { id: 'l1' } })

beforeEach(() => {
  vi.clearAllMocks()
  lineUpdateMany.mockResolvedValue({ count: 1 })
  lineFindUnique.mockResolvedValue({ id: 'l1', run: { station: { revenueCenterId: 'rc1' } } })
})

describe('POST /api/checklists/lines/[id]/resolve', () => {
  it('marks a flagged job fixed with who and when', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(requireSession).toHaveBeenCalledWith('LEAD')
    expect(assertRcWritable).toHaveBeenCalledWith(expect.objectContaining({ id: 'u9' }), 'rc1')
    const arg = lineUpdateMany.mock.calls[0][0] as { where: unknown; data: Record<string, unknown> }
    expect(arg.where).toEqual({ id: 'l1', status: 'FLAGGED', resolvedAt: null })
    expect(arg.data).toMatchObject({ resolvedById: 'u9', resolvedByName: 'Lena Lead' })
    expect(arg.data.resolvedAt).toBeInstanceOf(Date)
  })

  it('409 when it is already resolved (or no longer flagged)', async () => {
    lineUpdateMany.mockResolvedValue({ count: 0 })
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Already handled' })
  })

  it('404 when the job does not exist', async () => {
    lineFindUnique.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Job not found' })
    expect(lineUpdateMany).not.toHaveBeenCalled()
  })

  it('403 when the kitchen is outside the lead’s access, and nothing is written', async () => {
    assertRcWritable.mockRejectedValueOnce(new MockAuthError(403, 'Revenue center is outside your access.'))
    const res = await call()
    expect(res.status).toBe(403)
    expect(lineUpdateMany).not.toHaveBeenCalled()
  })

  it('403 when the caller is below LEAD', async () => {
    requireSession.mockRejectedValueOnce(new MockAuthError(403, 'Forbidden'))
    const res = await call()
    expect(res.status).toBe(403)
    expect(lineFindUnique).not.toHaveBeenCalled()
  })
})
