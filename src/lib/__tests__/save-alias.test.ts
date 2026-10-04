import { describe, it, expect, vi, beforeEach } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prismaMock = vi.hoisted(() => ({}) as any)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
import { saveAlias } from '@/lib/invoice-matcher'

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

const ROW = {
  inventoryItemId: 'other-item', supplierId: 'sup', text: 'old desc', rawText: 'OLD DESC',
  supplierItemCode: 'CODE1', packQty: null, packSize: null, packUOM: null, useCount: 3,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let calls: Record<string, any[]>
beforeEach(() => {
  calls = { findMany: [], updateMany: [], findUnique: [], upsert: [] }
})
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mock = (o: Record<string, (args: any) => any>, order?: string[]) => {
  prismaMock.itemSupplierAlias = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: async (a: any) => { calls.findMany.push(a); return o.findMany ? o.findMany(a) : [] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany: async (a: any) => { calls.updateMany.push(a); order?.push('updateMany'); return o.updateMany ? o.updateMany(a) : { count: 0 } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique: async (a: any) => { calls.findUnique.push(a); return o.findUnique ? o.findUnique(a) : null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert: async (a: any) => { calls.upsert.push(a); order?.push('upsert'); return o.upsert ? o.upsert(a) : { id: 'a-new' } },
  }
}

describe('saveAlias — what it learns', () => {
  it('creates a new alias keyed by (supplierId, normalised text), keeping the raw wording, the code and the pack', async () => {
    mock({})
    await saveAlias({
      rawDescription: 'Grape, Red Seedless (2-LB)', inventoryItemId: 'grapes', supplierId: 'sup',
      supplierItemCode: ' ab12 ', format: { packQty: 2, packSize: 1, packUOM: 'lb' }, source: 'APPROVE',
    })
    const u = calls.upsert[0]
    expect(u.where).toEqual({ supplierId_text: { supplierId: 'sup', text: 'grape red seedless 2 lb' } })
    expect(u.create).toMatchObject({
      inventoryItemId: 'grapes', supplierId: 'sup', text: 'grape red seedless 2 lb', rawText: 'Grape, Red Seedless (2-LB)',
      supplierItemCode: 'AB12', packQty: 2, packSize: 1, packUOM: 'lb', source: 'APPROVE', useCount: 1,
    })
  })

  it('an existing alias is re-pointed, its raw wording refreshed, its use counted; code and pack only when given', async () => {
    mock({})
    await saveAlias({ rawDescription: 'GRAPE RED', inventoryItemId: 'grapes', supplierId: 'sup', source: 'APPROVE' })
    const u = calls.upsert[0]
    expect(u.update.inventoryItemId).toBe('grapes')
    expect(u.update.rawText).toBe('GRAPE RED')
    expect(u.update.useCount).toEqual({ increment: 1 })
    expect(u.update.lastUsed).toBeInstanceOf(Date)
    expect(u.update).not.toHaveProperty('supplierItemCode')
    expect(u.update).not.toHaveProperty('packQty')
    // no code ⇒ no sibling strip
    expect(calls.updateMany).toHaveLength(0)
  })

  it('a wording moved to ANOTHER item restarts its count at 1 (it never earned the old count for the new item)', async () => {
    mock({ findUnique: () => ({ id: 'a1', ...ROW, text: 'grape red' }) })
    await saveAlias({ rawDescription: 'GRAPE RED', inventoryItemId: 'grapes', supplierId: 'sup', source: 'APPROVE' })
    expect(calls.upsert[0].update.inventoryItemId).toBe('grapes')
    expect(calls.upsert[0].update.useCount).toBe(1)
  })

  it('a wording confirmed again for the SAME item keeps counting', async () => {
    mock({ findUnique: () => ({ id: 'a1', ...ROW, inventoryItemId: 'grapes', text: 'grape red' }) })
    await saveAlias({ rawDescription: 'GRAPE RED', inventoryItemId: 'grapes', supplierId: 'sup', source: 'APPROVE' })
    expect(calls.upsert[0].update.useCount).toEqual({ increment: 1 })
  })

  it('a re-point restarts the count with an undo collector too, and the prev still carries the old count', async () => {
    const { prevs, undo } = recorder()
    mock({ findUnique: () => ({ id: 'a1', ...ROW, text: 'grape red' }), upsert: () => ({ id: 'a1' }) })
    await saveAlias({ rawDescription: 'GRAPE RED', inventoryItemId: 'grapes', supplierId: 'sup', source: 'APPROVE', undo })
    expect(calls.upsert[0].update.useCount).toBe(1)
    expect(prevs[0]).toMatchObject({ inventoryItemId: 'other-item', useCount: 3 })
  })

  it('an unreadable existing row keeps the increment (unknown is not "moved")', async () => {
    mock({ findUnique: () => { throw new Error('transient read failure') } })
    await saveAlias({ rawDescription: 'GRAPE RED', inventoryItemId: 'grapes', supplierId: 'sup', source: 'APPROVE' })
    expect(calls.upsert[0].update.useCount).toEqual({ increment: 1 })
  })

  it('records the source it was given (CREATE_NEW)', async () => {
    mock({})
    await saveAlias({ rawDescription: 'NEW THING', inventoryItemId: 'n1', supplierId: 'sup', source: 'CREATE_NEW' })
    expect(calls.upsert[0].create.source).toBe('CREATE_NEW')
  })

  it.each([
    ['no supplier', { supplierId: null, rawDescription: 'GRAPE' }],
    ['an undefined supplier', { supplierId: undefined, rawDescription: 'GRAPE' }],
    ['a blank wording', { supplierId: 'sup', rawDescription: ' ,. ' }],
  ])('learns nothing with %s', async (_l, o) => {
    mock({})
    await saveAlias({ inventoryItemId: 'grapes', source: 'APPROVE', ...o })
    expect(calls.upsert).toHaveLength(0)
    expect(calls.updateMany).toHaveLength(0)
  })

  it("a code belongs to one item per supplier: siblings under this supplier on another item lose it", async () => {
    mock({})
    await saveAlias({ rawDescription: 'GRAPE', inventoryItemId: 'grapes', supplierId: 'sup', supplierItemCode: 'c1', source: 'APPROVE' })
    expect(calls.updateMany[0]).toEqual({
      where: { supplierId: 'sup', supplierItemCode: 'C1', inventoryItemId: { not: 'grapes' } },
      data: { supplierItemCode: null },
    })
  })
})

describe('saveAlias — undo capture', () => {
  it('touches the siblings it strips a code from and the alias it upserts; a new alias is created()', async () => {
    const { touched, prevs, createdIds, order, undo } = recorder()
    mock({ findMany: () => [{ id: 'a9', ...ROW }] }, order)
    await saveAlias({ rawDescription: 'NEW DESC', inventoryItemId: 'item1', supplierId: 'sup', supplierItemCode: 'CODE1', source: 'APPROVE', undo })
    expect(touched).toEqual(['ALIAS:a9'])
    expect(prevs[0]).toMatchObject({ supplierItemCode: 'CODE1', inventoryItemId: 'other-item', useCount: 3 })
    expect(createdIds).toEqual(['ALIAS:a-new'])
    expect(order).toEqual(['before:ALIAS:a9', 'updateMany', 'upsert', 'created:ALIAS:a-new'])
  })

  it('captures an EXISTING alias as prev and does not mark it created', async () => {
    const { touched, prevs, createdIds, undo } = recorder()
    mock({ findUnique: () => ({ id: 'a1', ...ROW, text: 'new desc' }), upsert: () => ({ id: 'a1' }) })
    await saveAlias({ rawDescription: 'NEW DESC', inventoryItemId: 'item1', supplierId: 'sup', source: 'APPROVE', undo })
    expect(calls.findUnique[0].where).toEqual({ supplierId_text: { supplierId: 'sup', text: 'new desc' } })
    expect(touched).toEqual(['ALIAS:a1'])
    expect(prevs[0]).toMatchObject({ inventoryItemId: 'other-item', text: 'new desc' })
    expect(createdIds).toEqual([])
  })

  it('without an undo collector it reads no siblings, only the target row (to know whether the wording moved)', async () => {
    mock({})
    await saveAlias({ rawDescription: 'NEW DESC', inventoryItemId: 'item1', supplierId: 'sup', supplierItemCode: 'C', source: 'APPROVE' })
    expect(calls.findMany).toHaveLength(0)
    expect(calls.findUnique).toHaveLength(1)
  })

  it('a failed siblings read does not abort the code-strip write, and records nothing for the siblings it could not see', async () => {
    const { touched, createdIds, order, undo } = recorder()
    mock({ findMany: () => { throw new Error('transient read failure') } }, order)
    await saveAlias({ rawDescription: 'NEW DESC', inventoryItemId: 'item1', supplierId: 'sup', supplierItemCode: 'CODE1', source: 'APPROVE', undo })
    expect(touched).toEqual([])
    expect(order).toEqual(['updateMany', 'upsert', 'created:ALIAS:a-new'])
    expect(createdIds).toEqual(['ALIAS:a-new'])
  })

  it('a failed existing-row read does not abort the upsert, and must NOT created() an alias that may have existed', async () => {
    const { touched, createdIds, order, undo } = recorder()
    mock({ findUnique: () => { throw new Error('transient read failure') }, upsert: () => ({ id: 'a1' }) }, order)
    await saveAlias({ rawDescription: 'NEW DESC', inventoryItemId: 'item1', supplierId: 'sup', source: 'APPROVE', undo })
    expect(order).toEqual(['upsert'])
    expect(touched).toEqual([])
    expect(createdIds).toEqual([])
  })
})
