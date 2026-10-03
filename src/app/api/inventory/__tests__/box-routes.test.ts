import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { ROLE_RANK } from '@/lib/roles'

// The supplier-box routes (Stage 2b, R4): add a box (POST /suppliers), edit one
// (PATCH /suppliers/[offerId]) and remove one (DELETE /suppliers/[offerId]).
// The item always follows its main (primary) box.

type Role = keyof typeof ROLE_RANK

const NOW = new Date('2026-10-03T10:00:00.000Z')
const BOX_TIME = new Date('2026-10-02T08:00:00.000Z')
const BASE_ITEM = {
  id: 'i1', mergedIntoId: null as string | null, lastUpdated: NOW, dimension: 'MASS', baseUnit: 'g',
  isStocked: true, eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  recipe: null as null | { id: string; name: string },
}
type Box = {
  id: string; inventoryItemId: string; supplierId: string; supplierItemCode: string | null
  packChain: unknown; pricing: unknown; isPrimary: boolean; lastUpdated: Date
}
const PRIMARY: Box = {
  id: 'o1', inventoryItemId: 'i1', supplierId: 's1', supplierItemCode: 'GC1',
  packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 18.2 },
  isPrimary: true, lastUpdated: BOX_TIME,
}
const OTHER: Box = { ...PRIMARY, id: 'o2', supplierId: 's2', supplierItemCode: null, isPrimary: false }

let ITEM: typeof BASE_ITEM | null = { ...BASE_ITEM }
let SUPPLIER: { id: string; name: string } | null = { id: 's1', name: 'Sysco' }
let BOXES: Box[] = []
let DUP: { id: string } | null = null
let boxWriteCount = 1
let itemWriteCount = 1

type Args = { where: Record<string, unknown>; data?: Record<string, unknown> }
const create = vi.fn(async (a: Args) => ({ id: 'new', ...a.data }))
const boxUpdateMany = vi.fn(async (a: Args) => (a.where.id ? { count: boxWriteCount } : { count: BOXES.length }))
const deleteMany = vi.fn(async (_a: Args) => ({ count: boxWriteCount }))
const itemUpdateMany = vi.fn(async (_a: Args) => ({ count: itemWriteCount }))
const findFirst = vi.fn(async (a: Args) =>
  typeof a.where.id === 'string' ? BOXES.find(b => b.id === a.where.id && b.inventoryItemId === a.where.inventoryItemId) ?? null : DUP)

const db = {
  inventoryItem: { findUnique: async () => ITEM, updateMany: (a: Args) => itemUpdateMany(a) },
  supplier: { findUnique: async () => SUPPLIER },
  inventorySupplierPrice: {
    findFirst: (a: Args) => findFirst(a),
    findMany: async () => BOXES,
    count: async () => BOXES.length,
    create: (a: Args) => create(a),
    update: async () => ({}),
    updateMany: (a: Args) => boxUpdateMany(a),
    delete: async () => ({}),
    deleteMany: (a: Args) => deleteMany(a),
  },
}
vi.mock('@/lib/prisma', () => ({
  prisma: { ...db, $transaction: async (fn: (tx: typeof db) => unknown) => fn(db) },
}))

const propagatePrepCostChanges = vi.fn(async (_ids: string[]) => [])
vi.mock('@/lib/recipeCosts', () => ({
  propagatePrepCostChanges: (ids: string[]) => propagatePrepCostChanges(ids),
}))
const syncPrimaryOfferToItem = vi.fn(async (_id: string, _db?: unknown) => ({ changed: true, oldPpb: 0.0182, newPpb: 0.0169 }))
let ensureResult: string | null = 'o2'
const ensurePrimary = vi.fn(async (_id: string, _db?: unknown) => ensureResult)
vi.mock('@/lib/primary-offer', () => ({
  syncPrimaryOfferToItem: (id: string, d?: unknown) => syncPrimaryOfferToItem(id, d),
  ensurePrimary: (id: string, d?: unknown) => ensurePrimary(id, d),
  setPrimaryOffer: async () => ({ changed: false, oldPpb: 0, newPpb: 0 }),
}))
const OFFERS = [{ id: 'o1', supplierName: 'Sysco' }]
const getSupplierOffers = vi.fn(async (_id: string) => OFFERS)
vi.mock('@/lib/supplier-offers', () => ({ getSupplierOffers: (id: string) => getSupplierOffers(id) }))

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

const list = await import('@/app/api/inventory/[id]/suppliers/route')
const one = await import('@/app/api/inventory/[id]/suppliers/[offerId]/route')

const req = (body: unknown) =>
  ({ url: 'http://x/api/inventory/i1/suppliers', json: async () => body }) as unknown as NextRequest
const itemCtx = { params: { id: 'i1' } }
const boxCtx = (offerId: string) => ({ params: { id: 'i1', offerId } })

const NEW_BOX = {
  supplierId: 's1', supplierItemCode: ' gc2 ',
  packChain: [{ unit: 'case', per: 2000 }], pricing: { mode: 'PACK', purchasePrice: 33.8 },
  expectedLastUpdated: NOW.toISOString(),
}

beforeEach(() => {
  for (const f of [create, boxUpdateMany, deleteMany, itemUpdateMany, findFirst, propagatePrepCostChanges,
    syncPrimaryOfferToItem, ensurePrimary, getSupplierOffers]) f.mockClear()
})
afterEach(() => {
  ITEM = { ...BASE_ITEM }; SUPPLIER = { id: 's1', name: 'Sysco' }; BOXES = []; DUP = null
  boxWriteCount = 1; itemWriteCount = 1; ensureResult = 'o2'; currentRole = 'MANAGER'
})

describe('POST /api/inventory/[id]/suppliers — add a box', () => {
  it('on a box-less item creates a PRIMARY box, the item follows it, and returns the offers', async () => {
    const res = await list.POST(req({ ...NEW_BOX, makePrimary: false }), itemCtx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(OFFERS)
    expect(create.mock.calls[0][0].data).toMatchObject({
      inventoryItemId: 'i1', supplierId: 's1', supplierName: 'Sysco', supplierItemCode: 'GC2',
      packChain: NEW_BOX.packChain, pricing: NEW_BOX.pricing, isPrimary: true, lastPrice: 33.8,
      lastInvoiceSessionId: null, packQty: null, packSize: null, packUOM: null,
    })
    expect(syncPrimaryOfferToItem).toHaveBeenCalledWith('i1', expect.anything())
    expect(propagatePrepCostChanges).toHaveBeenCalledWith(['i1'])
    // The add names the item version it was made from.
    expect(itemUpdateMany.mock.calls[0][0].where).toEqual({ id: 'i1', lastUpdated: NOW })
  })

  it('makePrimary: false on an item with a primary creates a non-primary and does NOT sync', async () => {
    BOXES = [PRIMARY]
    SUPPLIER = { id: 's2', name: 'Snow Cap' }
    const res = await list.POST(req({ ...NEW_BOX, supplierId: 's2', makePrimary: false }), itemCtx)
    expect(res.status).toBe(200)
    expect(create.mock.calls[0][0].data).toMatchObject({ isPrimary: false, supplierName: 'Snow Cap' })
    expect(boxUpdateMany).not.toHaveBeenCalled()
    expect(syncPrimaryOfferToItem).not.toHaveBeenCalled()
    expect(propagatePrepCostChanges).not.toHaveBeenCalled()
  })

  it('no makePrimary on an item with a primary → non-primary', async () => {
    BOXES = [PRIMARY]
    const res = await list.POST(req({ ...NEW_BOX }), itemCtx)
    expect(res.status).toBe(200)
    expect(create.mock.calls[0][0].data).toMatchObject({ isPrimary: false })
    expect(syncPrimaryOfferToItem).not.toHaveBeenCalled()
  })

  it('makePrimary: true clears the old main box first, then the item follows the new one', async () => {
    BOXES = [PRIMARY]
    const res = await list.POST(req({ ...NEW_BOX, makePrimary: true }), itemCtx)
    expect(res.status).toBe(200)
    expect(boxUpdateMany.mock.calls[0][0]).toEqual({ where: { inventoryItemId: 'i1' }, data: { isPrimary: false } })
    expect(create.mock.calls[0][0].data).toMatchObject({ isPrimary: true })
    expect(boxUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0])
    expect(syncPrimaryOfferToItem).toHaveBeenCalled()
    expect(propagatePrepCostChanges).toHaveBeenCalledWith(['i1'])
  })

  it('a duplicate box → 409 DUPLICATE_BOX', async () => {
    DUP = { id: 'o1' }
    const res = await list.POST(req(NEW_BOX), itemCtx)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'This supplier already has a box for this product. Edit that box instead.', code: 'DUPLICATE_BOX',
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('the duplicate check uses the normalised code', async () => {
    await list.POST(req(NEW_BOX), itemCtx)
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      inventoryItemId: 'i1', supplierId: 's1', supplierItemCode: { equals: 'GC2', mode: 'insensitive' },
    })
  })

  it('a recipe-made item → 409 PREP_OWNED', async () => {
    ITEM = { ...BASE_ITEM, recipe: { id: 'r1', name: 'Bacon Jam' } }
    const res = await list.POST(req(NEW_BOX), itemCtx)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'A recipe-made item has no supplier boxes.', code: 'PREP_OWNED' })
    expect(create).not.toHaveBeenCalled()
  })

  it('a merged-away item → 409 TOMBSTONE', async () => {
    ITEM = { ...BASE_ITEM, mergedIntoId: 'i9' }
    const res = await list.POST(req(NEW_BOX), itemCtx)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('TOMBSTONE')
    expect(create).not.toHaveBeenCalled()
  })

  it('a stale item version → 409 STALE', async () => {
    const res = await list.POST(req({ ...NEW_BOX, expectedLastUpdated: '2026-10-03T09:00:00.000Z' }), itemCtx)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('STALE')
    expect(create).not.toHaveBeenCalled()
  })

  it('a clash between the read and the write → 409 STALE, nothing created', async () => {
    itemWriteCount = 0
    const res = await list.POST(req(NEW_BOX), itemCtx)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('STALE')
    expect(create).not.toHaveBeenCalled()
  })

  it('an unknown supplier → 404 NOT_FOUND', async () => {
    SUPPLIER = null
    const res = await list.POST(req(NEW_BOX), itemCtx)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "That supplier doesn't exist.", code: 'NOT_FOUND' })
  })

  it('a $0 box on a stocked item → 400 ZERO_PRICE', async () => {
    const res = await list.POST(req({ ...NEW_BOX, pricing: { mode: 'PACK', purchasePrice: 0 } }), itemCtx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "A stocked item's box needs a price above $0.", code: 'ZERO_PRICE' })
    expect(create).not.toHaveBeenCalled()
  })

  it('a box that does not fit the item → 400 INVALID with details', async () => {
    const res = await list.POST(req({ ...NEW_BOX, pricing: { mode: 'RATE', rate: 4.5, rateUnit: 'each' } }), itemCtx)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('INVALID')
    expect(body.error).toBe("That box doesn't fit how this item is measured.")
    expect(body.details).toHaveLength(1)
    expect(create).not.toHaveBeenCalled()
  })

  it('a missing field → 400 BAD_FIELD', async () => {
    const res = await list.POST(req({ ...NEW_BOX, supplierId: undefined }), itemCtx)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('BAD_FIELD')
  })
})

describe('PATCH /api/inventory/[id]/suppliers/[offerId] — edit a box', () => {
  const EDIT = { pricing: { mode: 'PACK', purchasePrice: 16.9 }, expectedLastUpdated: BOX_TIME.toISOString() }

  it("the main box's price → box written, item follows, recipes re-cost", async () => {
    BOXES = [PRIMARY, OTHER]
    const res = await one.PATCH(req(EDIT), boxCtx('o1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(OFFERS)
    const call = boxUpdateMany.mock.calls[0][0]
    expect(call.where).toEqual({ id: 'o1', inventoryItemId: 'i1', lastUpdated: BOX_TIME })
    expect(call.data).toMatchObject({
      packChain: PRIMARY.packChain, pricing: EDIT.pricing, supplierItemCode: 'GC1', lastPrice: 16.9,
    })
    expect(call.data?.lastUpdated).toBeInstanceOf(Date)
    expect(syncPrimaryOfferToItem).toHaveBeenCalledWith('i1', expect.anything())
    expect(propagatePrepCostChanges).toHaveBeenCalledWith(['i1'])
  })

  it('a non-main box → written, item untouched', async () => {
    BOXES = [PRIMARY, OTHER]
    const res = await one.PATCH(req(EDIT), boxCtx('o2'))
    expect(res.status).toBe(200)
    expect(boxUpdateMany).toHaveBeenCalled()
    expect(syncPrimaryOfferToItem).not.toHaveBeenCalled()
    expect(propagatePrepCostChanges).not.toHaveBeenCalled()
  })

  it('a stale box version → 409 STALE', async () => {
    BOXES = [PRIMARY]
    const res = await one.PATCH(req({ ...EDIT, expectedLastUpdated: '2026-10-01T00:00:00.000Z' }), boxCtx('o1'))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('STALE')
    expect(boxUpdateMany).not.toHaveBeenCalled()
  })

  it('a clash between the read and the write → 409 STALE, no sync', async () => {
    BOXES = [PRIMARY]
    boxWriteCount = 0
    const res = await one.PATCH(req(EDIT), boxCtx('o1'))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('STALE')
    expect(syncPrimaryOfferToItem).not.toHaveBeenCalled()
  })

  it('a code clash with a sibling box → 409 DUPLICATE_BOX', async () => {
    BOXES = [PRIMARY]
    DUP = { id: 'o3' }
    const res = await one.PATCH(req({ ...EDIT, supplierItemCode: 'gc9' }), boxCtx('o1'))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('DUPLICATE_BOX')
    expect(findFirst.mock.calls.at(-1)?.[0].where).toMatchObject({ id: { not: 'o1' }, supplierId: 's1' })
    expect(boxUpdateMany).not.toHaveBeenCalled()
  })

  it('a $0 price on a stocked item → 400 ZERO_PRICE', async () => {
    BOXES = [PRIMARY]
    const res = await one.PATCH(req({ ...EDIT, pricing: { mode: 'PACK', purchasePrice: 0 } }), boxCtx('o1'))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('ZERO_PRICE')
  })

  it('a box of another item → 404 NOT_FOUND', async () => {
    BOXES = [{ ...PRIMARY, inventoryItemId: 'i2' }]
    const res = await one.PATCH(req(EDIT), boxCtx('o1'))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('NOT_FOUND')
  })

  it('a recipe-made item → 409 PREP_OWNED', async () => {
    BOXES = [PRIMARY]
    ITEM = { ...BASE_ITEM, recipe: { id: 'r1', name: 'Bacon Jam' } }
    const res = await one.PATCH(req(EDIT), boxCtx('o1'))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('PREP_OWNED')
  })
})

describe('DELETE /api/inventory/[id]/suppliers/[offerId] — remove a box', () => {
  const DEL = { expectedLastUpdated: BOX_TIME.toISOString() }

  it('a non-main box → deleted, no sync', async () => {
    BOXES = [PRIMARY, OTHER]
    const res = await one.DELETE(req(DEL), boxCtx('o2'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(OFFERS)
    expect(deleteMany.mock.calls[0][0].where).toEqual({ id: 'o2', inventoryItemId: 'i1', lastUpdated: BOX_TIME })
    expect(ensurePrimary).not.toHaveBeenCalled()
    expect(syncPrimaryOfferToItem).not.toHaveBeenCalled()
    expect(propagatePrepCostChanges).not.toHaveBeenCalled()
  })

  it('the main box with another left → the next becomes main and the item follows it', async () => {
    BOXES = [PRIMARY, OTHER]
    const res = await one.DELETE(req(DEL), boxCtx('o1'))
    expect(res.status).toBe(200)
    expect(ensurePrimary).toHaveBeenCalledWith('i1', expect.anything())
    expect(syncPrimaryOfferToItem).toHaveBeenCalledWith('i1', expect.anything())
    expect(propagatePrepCostChanges).toHaveBeenCalledWith(['i1'])
  })

  it('the last box → deleted, the item keeps its price', async () => {
    BOXES = [PRIMARY]
    ensureResult = null
    const res = await one.DELETE(req(DEL), boxCtx('o1'))
    expect(res.status).toBe(200)
    expect(deleteMany).toHaveBeenCalled()
    expect(syncPrimaryOfferToItem).not.toHaveBeenCalled()
    expect(propagatePrepCostChanges).not.toHaveBeenCalled()
  })

  it('a stale box version → 409 STALE, nothing deleted', async () => {
    BOXES = [PRIMARY]
    const res = await one.DELETE(req({ expectedLastUpdated: '2026-10-01T00:00:00.000Z' }), boxCtx('o1'))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('STALE')
    expect(deleteMany).not.toHaveBeenCalled()
  })

  it('a clash between the read and the delete → 409 STALE, no promotion', async () => {
    BOXES = [PRIMARY, OTHER]
    boxWriteCount = 0
    const res = await one.DELETE(req(DEL), boxCtx('o1'))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('STALE')
    expect(ensurePrimary).not.toHaveBeenCalled()
  })
})

describe('role gate', () => {
  it('LEAD → 403 on all three', async () => {
    currentRole = 'LEAD'
    BOXES = [PRIMARY]
    const r1 = await list.POST(req(NEW_BOX), itemCtx)
    const r2 = await one.PATCH(req({ pricing: { mode: 'PACK', purchasePrice: 1 }, expectedLastUpdated: BOX_TIME.toISOString() }), boxCtx('o1'))
    const r3 = await one.DELETE(req({ expectedLastUpdated: BOX_TIME.toISOString() }), boxCtx('o1'))
    expect([r1.status, r2.status, r3.status]).toEqual([403, 403, 403])
    expect(create).not.toHaveBeenCalled()
    expect(boxUpdateMany).not.toHaveBeenCalled()
    expect(deleteMany).not.toHaveBeenCalled()
  })
})
