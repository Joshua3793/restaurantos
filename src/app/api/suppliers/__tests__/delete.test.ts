import { describe, it, expect, vi } from 'vitest'
import type { NextRequest } from 'next/server'
const count = vi.fn(async () => 3)
const del = vi.fn(async () => ({}))
vi.mock('@/lib/prisma', () => ({ prisma: {
  supplier: { findUnique: async () => ({ id: 's1', name: 'Sysco' }), delete: del },
  inventorySupplierPrice: { count },
  inventoryItem: { updateMany: async () => ({ count: 0 }) },
} }))
vi.mock('@/lib/auth', () => ({ requireSession: async () => ({ id: 'u1', role: 'ADMIN', isActive: true }), AuthError: class extends Error { status = 403 } }))
const route = await import('@/app/api/suppliers/[id]/route')
describe('DELETE /api/suppliers/[id]', () => {
  it('refuses while the supplier still has price boxes', async () => {
    const res = await route.DELETE({} as NextRequest, { params: { id: 's1' } })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/3 supplier boxes/)
    expect(del).not.toHaveBeenCalled()
  })
  it('deletes once no box references it', async () => {
    count.mockResolvedValueOnce(0)
    const res = await route.DELETE({} as NextRequest, { params: { id: 's1' } })
    expect(res.status).toBe(200)
    expect(del).toHaveBeenCalled()
  })
})
