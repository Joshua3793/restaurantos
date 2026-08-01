import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Same vi.mock-of-Prisma pattern as src/app/api/sales/__tests__/put-tips.test.ts.
const tipSettingsFindUnique = vi.fn(async () => ({ id: 'singleton', posMap: {} }))
const tipSettingsCreate = vi.fn(async () => ({ id: 'singleton', posMap: {} }))
const tipSettingsUpdate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'singleton', ...data }))
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'MANAGER', isActive: true }))
const resolveSalesScopeRcIds = vi.fn(async () => ({ label: 'All', rcIds: [] }))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tipSettings: {
      findUnique: (...a: unknown[]) => tipSettingsFindUnique(...(a as [])),
      create: (...a: unknown[]) => tipSettingsCreate(...(a as [])),
      update: (...a: unknown[]) => tipSettingsUpdate(...(a as [{ data: Record<string, unknown> }])),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/tips/sales', () => ({
  resolveSalesScopeRcIds: (...a: unknown[]) => resolveSalesScopeRcIds(...(a as [])),
}))

const { PUT } = await import('@/app/api/tips/settings/route')
const { AuthError } = await import('@/lib/auth')

const req = (body: Record<string, unknown>) => ({ json: async () => body }) as unknown as NextRequest

beforeEach(() => {
  tipSettingsFindUnique.mockClear(); tipSettingsFindUnique.mockResolvedValue({ id: 'singleton', posMap: {} })
  tipSettingsUpdate.mockClear()
  requireSession.mockClear(); requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true })
  resolveSalesScopeRcIds.mockClear()
})

describe('PUT /api/tips/settings', () => {
  it('rejects a non-string salesLocationId with 400', async () => {
    const res = await PUT(req({ salesLocationId: 42 }))
    expect(res.status).toBe(400)
    expect(tipSettingsUpdate).not.toHaveBeenCalled()
  })

  it('rejects a non-string poolRevenueCenterId with 400', async () => {
    const res = await PUT(req({ poolRevenueCenterId: 42 }))
    expect(res.status).toBe(400)
    expect(tipSettingsUpdate).not.toHaveBeenCalled()
  })

  it('rejects a posMap with a non-string value with 400', async () => {
    const res = await PUT(req({ posMap: { Server: 1 } }))
    expect(res.status).toBe(400)
    expect(tipSettingsUpdate).not.toHaveBeenCalled()
  })

  it('rejects a posMap that is an array with 400', async () => {
    const res = await PUT(req({ posMap: ['a', 'b'] }))
    expect(res.status).toBe(400)
    expect(tipSettingsUpdate).not.toHaveBeenCalled()
  })

  it('accepts valid string ids and a string-valued posMap', async () => {
    const res = await PUT(req({ salesLocationId: 'loc1', poolRevenueCenterId: 'rc1', posMap: { Server: 'r1' } }))
    expect(res.status).toBe(200)
    expect(tipSettingsUpdate).toHaveBeenCalledTimes(1)
    const data = tipSettingsUpdate.mock.calls[0][0].data as Record<string, unknown>
    expect(data.salesLocationId).toBe('loc1')
    expect(data.poolRevenueCenterId).toBe('rc1')
    expect(data.posMap).toEqual({ Server: 'r1' })
  })

  it('accepts null for salesLocationId and poolRevenueCenterId', async () => {
    const res = await PUT(req({ salesLocationId: null, poolRevenueCenterId: null }))
    expect(res.status).toBe(200)
    const data = tipSettingsUpdate.mock.calls[0][0].data as Record<string, unknown>
    expect(data.salesLocationId).toBeNull()
    expect(data.poolRevenueCenterId).toBeNull()
  })

  it('rejects an unauthenticated caller with 401 and never reaches the update', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await PUT(req({ poolRatePct: 6 }))
    expect(res.status).toBe(401)
    expect(tipSettingsUpdate).not.toHaveBeenCalled()
  })
})
