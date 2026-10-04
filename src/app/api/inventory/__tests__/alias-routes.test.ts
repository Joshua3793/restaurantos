import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { ROLE_RANK } from '@/lib/roles'

// The supplier-wording routes (Stage 3, W7): the drawer lists each supplier's
// learned wordings for an item (GET /aliases) and a manager can forget one
// (DELETE /aliases/[aliasId]). Both are MANAGER+.

type Role = keyof typeof ROLE_RANK

const BASE_ITEM = { id: 'i1', mergedIntoId: null as string | null, recipe: null as null | { id: string } }
type AliasRow = {
  id: string; inventoryItemId: string; supplierId: string; rawText: string; supplierItemCode: string | null
  packQty: unknown; packSize: unknown; packUOM: string | null; useCount: number; lastUsed: Date
  supplier: { name: string }
}
const SYSCO: AliasRow = {
  id: 'a1', inventoryItemId: 'i1', supplierId: 's1', rawText: 'GRAPE RED FRSH SEEDLS CLAM',
  supplierItemCode: '123456', packQty: '4', packSize: '2.5', packUOM: 'kg', useCount: 14,
  lastUsed: new Date('2026-09-28T18:00:00.000Z'), supplier: { name: 'Sysco' },
}
const GFS: AliasRow = {
  id: 'a2', inventoryItemId: 'i1', supplierId: 's2', rawText: 'Grapes red seedless', supplierItemCode: null,
  packQty: null, packSize: '2.5', packUOM: 'kg', useCount: 1,
  lastUsed: new Date('2026-09-20T18:00:00.000Z'), supplier: { name: 'GFS' },
}

let ITEM: typeof BASE_ITEM | null = { ...BASE_ITEM }
let ALIASES: AliasRow[] = []
let deleteCount = 1

type Args = { where: Record<string, unknown> }
const findMany = vi.fn(async (_a: Args) => ALIASES)
const findFirst = vi.fn(async (a: Args) =>
  ALIASES.find(x => x.id === a.where.id && x.inventoryItemId === a.where.inventoryItemId) ?? null)
const deleteMany = vi.fn(async (_a: Args) => ({ count: deleteCount }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    inventoryItem: { findUnique: async () => ITEM },
    itemSupplierAlias: {
      findMany: (a: Args) => findMany(a),
      findFirst: (a: Args) => findFirst(a),
      deleteMany: (a: Args) => deleteMany(a),
    },
  },
}))

let currentRole: Role = 'MANAGER'
class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError' }
}
const requireSession = vi.fn(async (min?: Role) => {
  if (min && ROLE_RANK[currentRole] < ROLE_RANK[min]) throw new MockAuthError(403, 'Forbidden')
  return { id: 'u1', role: currentRole, isActive: true }
})
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [Role?])),
  AuthError: MockAuthError,
}))

const list = await import('@/app/api/inventory/[id]/aliases/route')
const one = await import('@/app/api/inventory/[id]/aliases/[aliasId]/route')

const req = () => ({ url: 'http://x/api/inventory/i1/aliases', json: async () => ({}) }) as unknown as NextRequest
const itemCtx = { params: { id: 'i1' } }
const aliasCtx = (aliasId: string, id = 'i1') => ({ params: { id, aliasId } })

beforeEach(() => {
  for (const f of [findMany, findFirst, deleteMany, requireSession]) f.mockClear()
  ALIASES = [SYSCO, GFS]
})
afterEach(() => {
  ITEM = { ...BASE_ITEM }; ALIASES = []; deleteCount = 1; currentRole = 'MANAGER'
})

describe('GET /api/inventory/[id]/aliases — the wordings each supplier uses', () => {
  it('refuses a LEAD (403) without reading anything', async () => {
    currentRole = 'LEAD'
    const res = await list.GET(req(), itemCtx)
    expect(res.status).toBe(403)
    expect(findMany).not.toHaveBeenCalled()
  })

  it('asks for MANAGER', async () => {
    await list.GET(req(), itemCtx)
    expect(requireSession).toHaveBeenCalledWith('MANAGER')
  })

  it('returns each wording with its supplier name, code, pack label, times seen and last seen', async () => {
    const res = await list.GET(req(), itemCtx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      aliases: [
        {
          id: 'a1', supplierId: 's1', supplierName: 'Sysco', rawText: 'GRAPE RED FRSH SEEDLS CLAM',
          supplierItemCode: '123456', packLabel: '4 × 2.5 kg', useCount: 14, lastUsed: '2026-09-28T18:00:00.000Z',
        },
        {
          id: 'a2', supplierId: 's2', supplierName: 'GFS', rawText: 'Grapes red seedless',
          supplierItemCode: null, packLabel: '—', useCount: 1, lastUsed: '2026-09-20T18:00:00.000Z',
        },
      ],
    })
    expect(findMany.mock.calls[0][0].where).toEqual({ inventoryItemId: 'i1' })
  })

  it('404s an item that does not exist', async () => {
    ITEM = null
    const res = await list.GET(req(), itemCtx)
    expect(res.status).toBe(404)
    expect(findMany).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/inventory/[id]/aliases/[aliasId] — forget a wording', () => {
  it('refuses a LEAD (403) without deleting', async () => {
    currentRole = 'LEAD'
    const res = await one.DELETE(req(), aliasCtx('a1'))
    expect(res.status).toBe(403)
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('forgets a wording of this item and answers { ok: true }', async () => {
    const res = await one.DELETE(req(), aliasCtx('a1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(deleteMany.mock.calls[0][0].where).toEqual({ id: 'a1', inventoryItemId: 'i1' })
  })

  it('404s a wording that belongs to another item, and deletes nothing', async () => {
    ALIASES = [{ ...SYSCO, inventoryItemId: 'other' }]
    const res = await one.DELETE(req(), aliasCtx('a1'))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('NOT_FOUND')
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('404s when the wording was forgotten meanwhile (nothing deleted)', async () => {
    deleteCount = 0
    const res = await one.DELETE(req(), aliasCtx('a1'))
    expect(res.status).toBe(404)
  })

  it('404s an item that does not exist', async () => {
    ITEM = null
    const res = await one.DELETE(req(), aliasCtx('a1'))
    expect(res.status).toBe(404)
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('refuses a merged-away item (409 TOMBSTONE)', async () => {
    ITEM = { ...BASE_ITEM, mergedIntoId: 'i2' }
    const res = await one.DELETE(req(), aliasCtx('a1'))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('TOMBSTONE')
    expect(deleteMany).not.toHaveBeenCalled()
  })
})
