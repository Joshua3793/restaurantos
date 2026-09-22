import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
import { offerState, itemState, ruleState, canonEqual, UndoCollector } from '@/lib/invoice/approve-undo'
import { Prisma } from '@prisma/client'

describe('state selectors', () => {
  it('offerState keeps only approve-written fields, numbers Decimals, nulls undefined, sorts keys', () => {
    const s = offerState({
      id: 'o1',
      lastPrice: new Prisma.Decimal('46.40'),
      packQty: undefined,
      packSize: null,
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
    expect(Object.keys(s)).toEqual(['isPrimary', 'lastInvoiceSessionId', 'lastPrice', 'packChain', 'packQty', 'packSize', 'packUOM', 'pricing', 'supplierId', 'supplierItemCode'])
    expect(s.lastPrice).toBe(46.4)
    expect(s.packQty).toBeNull()
  })

  it('itemState / ruleState field sets', () => {
    expect(Object.keys(itemState({ packChain: [], pricing: {}, purchasePrice: '1', densityGPerMl: null } as any))).toEqual(['densityGPerMl', 'packChain', 'pricing', 'purchasePrice'])
    expect(
      Object.keys(
        ruleState({
          rawDescription: 'x',
          supplierName: 'S',
          inventoryItemId: 'i',
          invoicePackQty: '1',
          invoicePackSize: '2',
          invoicePackUOM: 'kg',
          supplierItemCode: null,
          useCount: 9,
          lastUsed: new Date(),
        } as any)
      )
    ).toEqual(['inventoryItemId', 'invoicePackQty', 'invoicePackSize', 'invoicePackUOM', 'rawDescription', 'supplierItemCode', 'supplierName'])
  })

  it('canonEqual ignores key order and Decimal-vs-number, distinguishes null from missing-as-null consistently', () => {
    const a = offerState({
      lastPrice: '5',
      packQty: null,
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
      lastPrice: new Prisma.Decimal(5),
      packQty: undefined,
      packSize: null,
      packUOM: null,
      packChain: [{ unit: 'case', per: 24 }],
      pricing: { mode: 'PACK', purchasePrice: 5 },
      supplierId: null,
      supplierItemCode: null,
      isPrimary: false,
      lastInvoiceSessionId: null,
    } as any)
    expect(canonEqual(a, b)).toBe(true)
    expect(canonEqual(a, { ...b, lastPrice: 5.01 })).toBe(false)
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
        lastPrice: '46.4',
        packQty: null,
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
        invoiceMatchRule: { findMany: async () => [] },
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
    c.before('OFFER', 'o1', { lastPrice: 40 } as any)
    c.before('OFFER', 'o1', { lastPrice: 41 } as any) // ignored
    expect(await c.flush()).toBe(1)
    expect(created[0]).toMatchObject({ sessionId: 's1', kind: 'OFFER', targetId: 'o1', prev: { lastPrice: 40 } })
    expect(created[0].next.lastPrice).toBe(46.4)
    expect(await c.flush()).toBe(0)
  })

  it('created() records prev = null (written as Prisma.JsonNull, the SQL-NULL sentinel a nullable Json column requires)', async () => {
    const { created, db: d } = db()
    const c = new UndoCollector('s1', d)
    c.created('OFFER', 'o1')
    await c.flush()
    expect(created[0].prev).toBe(Prisma.JsonNull)
  })
})
