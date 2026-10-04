import { describe, it, expect, vi } from 'vitest'
// A mutable stand-in for the singleton: modules that reach for `prisma` directly
// (ensurePrimary's defaults) get whatever a test hangs on it; the rest see an empty object,
// exactly as before. vi.hoisted so the ref exists when vi.mock is hoisted.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prismaMock = vi.hoisted(() => ({}) as any)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
import { offerState, itemState, aliasState, canonEqual, UndoCollector, offerCaptureFor } from '@/lib/invoice/approve-undo'
import { Prisma } from '@prisma/client'

describe('state selectors', () => {
  it('offerState keeps only approve-written fields, numbers Decimals, nulls undefined, sorts keys', () => {
    const s = offerState({
      id: 'o1',
      lastPrice: new Prisma.Decimal('46.40'), // retired column: never part of the state
      packQty: undefined,
      packSize: new Prisma.Decimal('4.50'),
      packUOM: 'each',
      packChain: [{ unit: 'case', per: 24 }],
      pricing: { mode: 'PACK', purchasePrice: 46.4 },
      supplierId: 'sup',
      supplierItemCode: null,
      isPrimary: true,
      lastInvoiceSessionId: 's1',
      lastUpdated: new Date(),
      inventoryItemId: 'i1',
      supplierName: 'Sysco',
    } as any)
    expect(Object.keys(s)).toEqual(['isPrimary', 'lastInvoiceSessionId', 'packChain', 'packQty', 'packSize', 'packUOM', 'pricing', 'supplierId', 'supplierItemCode'])
    expect(s.packSize).toBe(4.5)
    expect(s.packQty).toBeNull()
  })

  it('itemState / aliasState field sets', () => {
    expect(Object.keys(itemState({ packChain: [], pricing: {}, purchasePrice: '1', densityGPerMl: null } as any))).toEqual(['densityGPerMl', 'packChain', 'pricing'])
    const a = aliasState({
      id: 'a1',
      inventoryItemId: 'i',
      supplierId: 's',
      text: 'grape red',
      rawText: 'GRAPE, RED',
      supplierItemCode: null,
      packQty: new Prisma.Decimal('2'),
      packSize: '500',
      packUOM: 'g',
      source: 'APPROVE',
      useCount: 9,
      lastUsed: new Date(),
      createdAt: new Date(),
    } as any)
    // useCount IS state (a later invoice using the wording again moves it);
    // source / lastUsed / createdAt are bookkeeping, never restored
    expect(Object.keys(a)).toEqual(['inventoryItemId', 'packQty', 'packSize', 'packUOM', 'rawText', 'supplierId', 'supplierItemCode', 'text', 'useCount'])
    expect(a.packQty).toBe(2)
    expect(a.packSize).toBe(500)
  })

  it('canonEqual ignores key order and Decimal-vs-number, distinguishes null from missing-as-null consistently', () => {
    const a = offerState({
      packQty: '5',
      packSize: null,
      packUOM: null,
      packChain: [{ per: 24, unit: 'case' }],
      pricing: { purchasePrice: 5, mode: 'PACK' },
      supplierId: null,
      supplierItemCode: null,
      isPrimary: false,
      lastInvoiceSessionId: null,
    } as any)
    const b = offerState({
      packQty: new Prisma.Decimal(5),
      packSize: undefined,
      packUOM: null,
      packChain: [{ unit: 'case', per: 24 }],
      pricing: { mode: 'PACK', purchasePrice: 5 },
      supplierId: null,
      supplierItemCode: null,
      isPrimary: false,
      lastInvoiceSessionId: null,
    } as any)
    expect(canonEqual(a, b)).toBe(true)
    expect(canonEqual(a, { ...b, packQty: 5.01 })).toBe(false)
    expect(canonEqual(null, null)).toBe(true)
    expect(canonEqual(a, null)).toBe(false)
  })
})

describe('UndoCollector', () => {
  const db = () => {
    const created: any[] = []
    const offers: Record<string, any> = {
      o1: {
        id: 'o1',
        packQty: '46.4',
        packSize: null,
        packUOM: null,
        packChain: [],
        pricing: {},
        supplierId: null,
        supplierItemCode: null,
        isPrimary: true,
        lastInvoiceSessionId: 's1',
      },
    }
    return {
      created,
      db: {
        inventorySupplierPrice: { findMany: async ({ where }: any) => where.id.in.map((id: string) => offers[id]).filter(Boolean) },
        inventoryItem: { findMany: async () => [] },
        itemSupplierAlias: { findMany: async () => [] },
        invoiceApproveUndo: {
          createMany: async ({ data }: any) => {
            created.push(...data)
            return { count: data.length }
          },
        },
      } as any,
    }
  }

  it('first touch wins; flush reads next and writes prev+next once; a second flush writes nothing new', async () => {
    const { created, db: d } = db()
    const c = new UndoCollector('s1', d)
    c.before('OFFER', 'o1', { packQty: 40 } as any)
    c.before('OFFER', 'o1', { packQty: 41 } as any) // ignored
    expect(await c.flush()).toBe(1)
    expect(created[0]).toMatchObject({ sessionId: 's1', kind: 'OFFER', targetId: 'o1', prev: { packQty: 40 } })
    expect(created[0].next.packQty).toBe(46.4)
    expect(await c.flush()).toBe(0)
  })

  it('created() records prev = null (written as Prisma.DbNull, the SQL-NULL sentinel a nullable Json column requires)', async () => {
    const { created, db: d } = db()
    const c = new UndoCollector('s1', d)
    c.created('OFFER', 'o1')
    await c.flush()
    // DbNull = SQL NULL, which reads back as JS `null` — what the planner tests
    // for ("this row did not exist before the approval; delete it"). JsonNull
    // would store the JSON scalar `null` instead: a present value, invisible to
    // `{ prev: null }`, and indistinguishable in the row from a real Canon.
    expect(created[0].prev).toBe(Prisma.DbNull)
    expect(created[0].prev).not.toBe(Prisma.JsonNull)
  })

  it('flush() refreshes next for an already-flushed entry whose row was rewritten by a later write: updateMany, no duplicate create; a third flush with no further change writes nothing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created: any[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated: any[] = []
    // A live row, mutated between flushes to simulate a second scan line
    // rewriting the same offer after the first line's flush already ran.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = {
      id: 'o1',
      packQty: '1',
      packSize: null,
      packUOM: null,
      packChain: [],
      pricing: {},
      supplierId: null,
      supplierItemCode: null,
      isPrimary: true,
      lastInvoiceSessionId: 's1',
    }
    const d = {
      inventorySupplierPrice: { findMany: async () => [row] },
      inventoryItem: { findMany: async () => [] },
      itemSupplierAlias: { findMany: async () => [] },
      invoiceApproveUndo: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createMany: async ({ data }: any) => {
          created.push(...data)
          return { count: data.length }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        updateMany: async (args: any) => {
          updated.push(args)
          return { count: 1 }
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const c = new UndoCollector('s1', d)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.before('OFFER', 'o1', { packQty: 0 } as any)

    expect(await c.flush()).toBe(1)
    expect(created).toHaveLength(1)
    expect(created[0].next.packQty).toBe(1)
    expect(updated).toHaveLength(0)

    // Line 2 rewrites the row after line 1's flush already ran.
    row.packQty = '2'
    expect(await c.flush()).toBe(1)
    expect(created).toHaveLength(1) // no duplicate create — the row already has one
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({
      where: { sessionId: 's1', kind: 'OFFER', targetId: 'o1' },
    })
    expect(updated[0].data.next.packQty).toBe(2)
    // prev is never part of the update payload.
    expect(updated[0].data.prev).toBeUndefined()

    // No further change → no writes of any kind.
    expect(await c.flush()).toBe(0)
    expect(created).toHaveLength(1)
    expect(updated).toHaveLength(1)
  })

  it('flush reads an ALIAS target through the alias table and records it', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created: any[] = []
    const d = {
      inventorySupplierPrice: { findMany: async () => [] },
      inventoryItem: { findMany: async () => [] },
      itemSupplierAlias: {
        findMany: async () => [{ id: 'a1', inventoryItemId: 'i1', supplierId: 's', text: 'x', rawText: 'X', supplierItemCode: null, packQty: null, packSize: null, packUOM: null, useCount: 1 }],
      },
      invoiceApproveUndo: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createMany: async ({ data }: any) => {
          created.push(...data)
          return { count: data.length }
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const c = new UndoCollector('s1', d)
    c.created('ALIAS', 'a1')
    expect(await c.flush()).toBe(1)
    expect(created[0]).toMatchObject({ kind: 'ALIAS', targetId: 'a1', prev: Prisma.DbNull })
    expect(created[0].next).toMatchObject({ inventoryItemId: 'i1', text: 'x', useCount: 1 })
  })
})

describe('offerCaptureFor', () => {
  const existing = { id: 'o1', ...{
    packQty: '10', packSize: null, packUOM: null, packChain: [],
    pricing: {}, supplierId: null, supplierItemCode: null, isPrimary: true, lastInvoiceSessionId: null,
  } }

  it('records "before" the existing row when the pre-upsert read succeeded and found one', () => {
    const action = offerCaptureFor(true, existing, { id: 'o1' })
    expect(action).toMatchObject({ kind: 'before', id: 'o1' })
    if (action.kind === 'before') expect(action.prev.packQty).toBe(10)
  })

  it('records "created" when the read succeeded and found nothing, but the upsert produced a row', () => {
    const action = offerCaptureFor(true, null, { id: 'o2' })
    expect(action).toEqual({ kind: 'created', id: 'o2' })
  })

  it('records nothing when the read failed — even though the upsert went on to update a pre-existing row', () => {
    // The exact hazard: a transient read failure must never be treated as
    // "row did not exist", because that would record prev: null for a row
    // that predates this invoice — a later rollback would then DELETE it.
    const action = offerCaptureFor(false, null, { id: 'o3' })
    expect(action).toEqual({ kind: 'none' })
  })

  it('records nothing when the read succeeded, found nothing, AND the upsert itself failed', () => {
    const action = offerCaptureFor(true, null, null)
    expect(action).toEqual({ kind: 'none' })
  })
})

describe('capture hooks', () => {
  // The non-key half of an offer row — enough for offerState() to be complete.
  const OFFER_ROW = {
    packQty: '10',
    packSize: null,
    packUOM: null,
    packChain: [],
    pricing: {},
    supplierId: null,
    supplierItemCode: null,
    lastInvoiceSessionId: null,
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recorder = () => {
    const touched: string[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prevs: any[] = []
    const createdIds: string[] = []
    const order: string[] = []
    const undo = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      before: (k: string, id: string, prev: any) => {
        touched.push(`${k}:${id}`)
        prevs.push(prev)
        order.push(`before:${k}:${id}`)
      },
      created: (k: string, id: string) => {
        createdIds.push(`${k}:${id}`)
        order.push(`created:${k}:${id}`)
      },
      flush: async () => 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    return { touched, prevs, createdIds, order, undo }
  }

  it('ensurePrimary touches every offer of the item BEFORE clearing/promoting', async () => {
    const { touched, prevs, order, undo } = recorder()
    const db = {
      inventorySupplierPrice: {
        findMany: async () => [
          { id: 'a', isPrimary: false, ...OFFER_ROW },
          { id: 'b', isPrimary: false, ...OFFER_ROW },
        ],
        updateMany: async () => {
          order.push('updateMany')
          return { count: 2 }
        },
        update: async () => {
          order.push('update')
          return {}
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const { ensurePrimary } = await import('@/lib/primary-offer')
    await ensurePrimary('item', db, undo)
    expect(touched.sort()).toEqual(['OFFER:a', 'OFFER:b'])
    // captured BEFORE the writes, and through the canonical selector
    expect(order).toEqual(['before:OFFER:a', 'before:OFFER:b', 'updateMany', 'update'])
    expect(prevs[0]).toMatchObject({ isPrimary: false, packQty: 10 })
  })

  it('ensurePrimary captures nothing when the invariant already holds (it writes nothing)', async () => {
    const { touched, undo } = recorder()
    const db = {
      inventorySupplierPrice: {
        findMany: async () => [
          { id: 'a', isPrimary: true, ...OFFER_ROW },
          { id: 'b', isPrimary: false, ...OFFER_ROW },
        ],
        updateMany: async () => {
          throw new Error('must not write')
        },
        update: async () => {
          throw new Error('must not write')
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const { ensurePrimary } = await import('@/lib/primary-offer')
    expect(await ensurePrimary('item', db, undo)).toBe('a')
    expect(touched).toEqual([])
  })
})
