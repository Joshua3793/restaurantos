import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import {
  toPlain, toPlainRow, REPOINT_FK, TABLE_DELEGATE, NULLABLE_JSON_COLUMNS,
  writeData, mergeOpOrder, undoOpOrder, parseManifest, recipeIngredientRepointIds, asCountEntries,
} from '../item-merge-rows'
import type { MergeManifest, MergeOp } from '../item-merge'

/** Stands in for a Prisma Decimal: an object carrying both toNumber and toString. */
class FakeDecimal {
  constructor(private readonly v: string) {}
  toNumber() { return Number(this.v) }
  toString() { return this.v }
}

describe('toPlain', () => {
  it('turns a Decimal-like into a number', () => {
    expect(toPlain(new FakeDecimal('12.5'))).toBe(12.5)
    expect(toPlain(new FakeDecimal('0'))).toBe(0)
  })

  it('turns a Date into an ISO string', () => {
    expect(toPlain(new Date('2026-09-20T17:03:04.000Z'))).toBe('2026-09-20T17:03:04.000Z')
  })

  it('leaves primitives and null alone', () => {
    expect(toPlain('a')).toBe('a')
    expect(toPlain(3)).toBe(3)
    expect(toPlain(true)).toBe(true)
    expect(toPlain(null)).toBeNull()
  })

  it('drops undefined (a row never carries one into JSON)', () => {
    expect(toPlain(undefined)).toBeUndefined()
    expect(toPlainRow({ a: 1, b: undefined })).toEqual({ a: 1 })
    expect('b' in toPlainRow({ a: 1, b: undefined })).toBe(false)
  })

  it('recurses through an already-plain Json column', () => {
    const chain = [{ unit: 'case', per: 4 }, { unit: 'each', per: 300 }]
    expect(toPlain(chain)).toEqual(chain)
    expect(toPlain({ mode: 'PACK', purchasePrice: 12 })).toEqual({ mode: 'PACK', purchasePrice: 12 })
  })

  it('recurses into nested Decimals and Dates', () => {
    const out = toPlainRow({
      id: 'x',
      nested: { when: new Date('2026-01-02T03:04:05.000Z'), amount: new FakeDecimal('7.25'), deep: [new FakeDecimal('1')] },
    })
    expect(out).toEqual({ id: 'x', nested: { when: '2026-01-02T03:04:05.000Z', amount: 7.25, deep: [1] } })
  })

  it('maps an undefined array element to null, as JSON.stringify would', () => {
    expect(toPlain([1, undefined, 2])).toEqual([1, null, 2])
  })

  it('converts a bigint to a number (JSON.stringify would throw)', () => {
    expect(toPlain(BigInt(42))).toBe(42)
  })

  it('produces a row that survives a JSON round trip unchanged', () => {
    const row = {
      id: 'o1', lastPrice: new FakeDecimal('19.99'), lastUpdated: new Date('2026-05-01T00:00:00.000Z'),
      packChain: [{ unit: 'case', per: 12 }], pricing: null, packQty: null, isPrimary: true,
    }
    const plain = toPlainRow(row)
    expect(JSON.parse(JSON.stringify(plain))).toEqual(plain)
  })
})

describe('table lookups', () => {
  it('re-points InvoiceScanItem through matchedItemId and everything else through inventoryItemId', () => {
    expect(REPOINT_FK.InvoiceScanItem).toBe('matchedItemId')
    for (const [table, col] of Object.entries(REPOINT_FK))
      if (table !== 'InvoiceScanItem') expect(col).toBe('inventoryItemId')
  })

  it('covers every re-pointable table', () => {
    expect(Object.keys(REPOINT_FK).sort()).toEqual([
      'CountLine', 'InventorySnapshot', 'InventorySupplierPrice', 'InvoiceLineItem', 'InvoiceMatchRule',
      'InvoiceScanItem', 'ItemRevenueCenter', 'PriceAlert', 'RecipeIngredient', 'StockAllocation',
      'StockTransfer', 'WastageLog',
    ])
  })

  it('names a real Prisma model, and its delegate is that model lower-camelled', () => {
    // Catches a typo'd delegate ("inventoryitem") without needing a database:
    // Prisma.ModelName is the generated client's own list of models.
    const models = Object.keys(Prisma.ModelName)
    for (const [table, delegate] of Object.entries(TABLE_DELEGATE)) {
      expect(models, `${table} is not a Prisma model`).toContain(table)
      expect(delegate).toBe(table.charAt(0).toLowerCase() + table.slice(1))
    }
  })

  it('maps every op table to its Prisma delegate, InventoryItem included', () => {
    expect(TABLE_DELEGATE.InventoryItem).toBe('inventoryItem')
    expect(TABLE_DELEGATE.InvoiceScanItem).toBe('invoiceScanItem')
    expect(TABLE_DELEGATE.ItemRevenueCenter).toBe('itemRevenueCenter')
    for (const table of Object.keys(REPOINT_FK)) expect(TABLE_DELEGATE[table as keyof typeof TABLE_DELEGATE]).toBeTruthy()
  })
})

describe('writeData', () => {
  it('passes plain values straight through', () => {
    expect(writeData('CountLine', { countedQtyBase: 27, selectedUom: 'g' }))
      .toEqual({ countedQtyBase: 27, selectedUom: 'g' })
  })

  it('translates a null on a nullable Json column to DbNull', () => {
    expect(writeData('CountLine', { entries: null, countedQty: null }))
      .toEqual({ entries: Prisma.DbNull, countedQty: null })
  })

  it('leaves a Json column alone when it carries a real value', () => {
    const entries = [{ unit: 'case', qty: 2 }]
    expect(writeData('CountLine', { entries })).toEqual({ entries })
  })

  it('translates both nullable Json columns on an offer row', () => {
    expect(writeData('InventorySupplierPrice', { packChain: null, pricing: null, supplierName: 'A' }))
      .toEqual({ packChain: Prisma.DbNull, pricing: Prisma.DbNull, supplierName: 'A' })
  })

  it('does not translate a null on a non-Json column of another table', () => {
    expect(writeData('StockAllocation', { parLevel: null, reorderQty: null }))
      .toEqual({ parLevel: null, reorderQty: null })
  })

  it('knows the nullable Json columns of the tables a merge writes', () => {
    expect(NULLABLE_JSON_COLUMNS.CountLine).toEqual(['entries'])
    expect(NULLABLE_JSON_COLUMNS.InventorySupplierPrice).toEqual(['packChain', 'pricing'])
    expect(NULLABLE_JSON_COLUMNS.InvoiceScanItem).toEqual(['rcSplit', 'bbox'])
    expect(NULLABLE_JSON_COLUMNS.InventoryItem).toEqual([])
  })
})

const op = (t: MergeOp['t'], table: string, tag: string): MergeOp =>
  t === 'repoint' ? { t, table: table as 'CountLine', ids: [tag] }
  : t === 'update' ? { t, table: table as 'CountLine', id: tag, before: {}, after: {} }
  : t === 'delete' ? { t, table: table as 'InventorySnapshot', row: { id: tag } }
  : { t: 'create', table: table as 'InventorySupplierPrice', row: { id: tag } }

const tags = (ops: MergeOp[]) => ops.map(o =>
  o.t === 'repoint' ? `${o.t}:${o.ids[0]}` : o.t === 'update' ? `${o.t}:${o.id}` : `${o.t}:${o.row.id as string}`)

describe('op ordering', () => {
  const ops: MergeOp[] = [
    op('repoint', 'CountLine', 'a'),
    op('delete', 'InventorySnapshot', 'b'),
    op('update', 'CountLine', 'c'),
    op('delete', 'InventorySnapshot', 'd'),
    op('create', 'InventorySupplierPrice', 'e'),
  ]

  it('runs every delete first on merge, then the rest in manifest order', () => {
    expect(tags(mergeOpOrder(ops))).toEqual(['delete:b', 'delete:d', 'repoint:a', 'update:c', 'create:e'])
  })

  it('runs every create last on undo, the rest in the given order', () => {
    expect(tags(undoOpOrder(ops))).toEqual(['repoint:a', 'delete:b', 'update:c', 'delete:d', 'create:e'])
  })

  it('keeps every op exactly once', () => {
    expect(mergeOpOrder(ops)).toHaveLength(ops.length)
    expect(undoOpOrder(ops)).toHaveLength(ops.length)
    expect(mergeOpOrder(ops)).not.toBe(ops)
  })
})

describe('parseManifest', () => {
  const good: MergeManifest = { survivorId: 's', absorbedId: 'a', factor: 1, ops: [op('repoint', 'CountLine', 'x')] }

  it('accepts a manifest read back out of the Json column', () => {
    expect(parseManifest(JSON.parse(JSON.stringify(good)))).toEqual(good)
  })

  it('rejects anything that is not a manifest', () => {
    expect(parseManifest(null)).toBeNull()
    expect(parseManifest('{}')).toBeNull()
    expect(parseManifest({ survivorId: 's', absorbedId: 'a', factor: 1 })).toBeNull()
    expect(parseManifest({ survivorId: 's', absorbedId: 1, factor: 1, ops: [] })).toBeNull()
    expect(parseManifest({ survivorId: 's', absorbedId: 'a', factor: 'x', ops: [] })).toBeNull()
    expect(parseManifest({ survivorId: 's', absorbedId: 'a', factor: 1, ops: [{ t: 'nope' }] })).toBeNull()
  })
})

describe('asCountEntries', () => {
  it('passes a stored entries array through by identity — never reshaped', () => {
    const entries = [{ unit: 'case', qty: 2 }, { unit: 'each', qty: 3 }]
    expect(asCountEntries(entries)).toBe(entries)
  })

  it('reads a missing breakdown as null', () => {
    expect(asCountEntries(null)).toBeNull()
    expect(asCountEntries(undefined)).toBeNull()
  })

  it('reads a non-array Json as null (the planner then falls back to countedQty)', () => {
    expect(asCountEntries({ unit: 'case', qty: 2 })).toBeNull()
    expect(asCountEntries('[]')).toBeNull()
  })

  it('reads an empty array as an empty array — the planner decides what that means', () => {
    expect(asCountEntries([])).toEqual([])
  })
})

describe('recipeIngredientRepointIds', () => {
  it('collects the ids of every RecipeIngredient re-point', () => {
    const m: MergeManifest = {
      survivorId: 's', absorbedId: 'a', factor: 1,
      ops: [
        { t: 'repoint', table: 'RecipeIngredient', ids: ['r1', 'r2'] },
        { t: 'repoint', table: 'CountLine', ids: ['c1'] },
        { t: 'repoint', table: 'RecipeIngredient', ids: ['r3'] },
        { t: 'update', table: 'RecipeIngredient', id: 'r9', before: {}, after: {} },
      ],
    }
    expect(recipeIngredientRepointIds(m)).toEqual(['r1', 'r2', 'r3'])
  })

  it('is empty when no recipe line moved', () => {
    expect(recipeIngredientRepointIds({ survivorId: 's', absorbedId: 'a', factor: 1, ops: [] })).toEqual([])
  })
})
