import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SHOUTY_HINT } from '@/lib/alias-text'

// W1: POST /api/inventory refuses an invoice wording typed in as an item name,
// unless the person explicitly keeps it (`allowShouty: true`).

const create = vi.hoisted(() => vi.fn(async (a: { data: Record<string, unknown> }) => ({
  id: 'new', ...a.data, supplierPrices: [], storageArea: null,
})))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    inventoryItem: { create },
    supplier: { findUnique: async () => null },
    revenueCenter: { findFirst: async () => null },
    itemRevenueCenter: { create: async () => ({}) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: async () => ({ id: 'u1', role: 'MANAGER', isActive: true }),
  AuthError: class extends Error { status = 401 },
}))
vi.mock('@/lib/theoretical-cache', () => ({ invalidatesTheoretical: (h: unknown) => h }))

const route = await import('@/app/api/inventory/route')

const body = (over: Record<string, unknown>) => ({
  itemName: 'Red Grapes', category: 'PRODUCE',
  dimension: 'MASS', packChain: [{ unit: 'case', per: 8000 }], pricing: { mode: 'PACK', purchasePrice: 40 }, countUnit: 'case',
  ...over,
})
const post = (b: unknown) => route.POST({ url: 'http://x/api/inventory', json: async () => b } as unknown as NextRequest)

// Braces matter: a function returned from beforeEach is run as a cleanup hook.
beforeEach(() => { create.mockClear() })

describe('POST /api/inventory — plain names', () => {
  it('creates an item with a plain name', async () => {
    const res = await post(body({}))
    expect(res.status).toBe(201)
    expect(create).toHaveBeenCalledOnce()
  })

  it('refuses an invoice wording with the hint and code SHOUTY_NAME, creating nothing', async () => {
    const res = await post(body({ itemName: 'GRAPE RED FRSH SEEDLS CLAM' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: SHOUTY_HINT, code: 'SHOUTY_NAME' })
    expect(create).not.toHaveBeenCalled()
  })

  it('creates it anyway with allowShouty: true — and never writes allowShouty as a column', async () => {
    const res = await post(body({ itemName: 'GRAPE RED FRSH SEEDLS CLAM', allowShouty: true }))
    expect(res.status).toBe(201)
    const data = create.mock.calls[0][0].data
    expect(data.itemName).toBe('GRAPE RED FRSH SEEDLS CLAM')
    expect('allowShouty' in data).toBe(false)
  })

  it('a plain body never carries allowShouty through either', async () => {
    await post(body({ allowShouty: false }))
    expect('allowShouty' in create.mock.calls[0][0].data).toBe(false)
  })
})
