import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import {
  toPlain, toPlainRow, REPOINT_FK, TABLE_DELEGATE, NULLABLE_JSON_COLUMNS,
  writeData, mergeOpOrder, undoOpOrder, parseManifest, recipeIngredientRepointIds, asCountEntries,
  repointTableChecks, batchUpdateOps, type BatchedOp,
  parseCombinedOnHand, isSafeRowId, lockItemsSql,
} from '../item-merge-rows'
import type { MergeManifest, MergeOp, UpdateTable } from '../item-merge'

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

describe('parseCombinedOnHand', () => {
  const ok = (v: unknown) => parseCombinedOnHand({ combinedOnHand: v })

  it('reads a valid figure', () => {
    expect(ok({ countedQty: 12.5, selectedUom: 'each', rcId: 'rc1' }))
      .toEqual({ ok: true, value: { countedQty: 12.5, selectedUom: 'each', rcId: 'rc1' } })
  })

  it('accepts a real zero', () => {
    expect(ok({ countedQty: 0, selectedUom: 'g', rcId: 'rc1' }))
      .toEqual({ ok: true, value: { countedQty: 0, selectedUom: 'g', rcId: 'rc1' } })
  })

  it('reads an absent field as "no figure given"', () => {
    expect(parseCombinedOnHand({})).toEqual({ ok: true, value: null })
    expect(parseCombinedOnHand({ combinedOnHand: undefined })).toEqual({ ok: true, value: null })
    expect(parseCombinedOnHand(null)).toEqual({ ok: true, value: null })
    expect(parseCombinedOnHand({ combinedOnHand: null })).toEqual({ ok: true, value: null })
  })

  // Number(null) === 0, Number('') === 0, Number([]) === 0, Number(false) === 0.
  // Coercing any of those would record an un-undoable count that ZEROES the
  // item's stock from a malformed body — each must be a loud 400 instead.
  it.each([null, '', [], false, '5', '0', {}, true])('refuses a non-number countedQty: %o', v => {
    const r = ok({ countedQty: v, selectedUom: 'each', rcId: 'rc1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/countedQty/)
  })

  it.each([-1, NaN, Infinity, -Infinity])('refuses a negative or non-finite countedQty: %o', v => {
    expect(ok({ countedQty: v, selectedUom: 'each', rcId: 'rc1' }).ok).toBe(false)
  })

  it('refuses a missing or empty unit', () => {
    expect(ok({ countedQty: 1, selectedUom: '', rcId: 'rc1' }).ok).toBe(false)
    expect(ok({ countedQty: 1, rcId: 'rc1' }).ok).toBe(false)
    expect(ok({ countedQty: 1, selectedUom: 2, rcId: 'rc1' }).ok).toBe(false)
  })

  it('refuses a missing or empty revenue center', () => {
    expect(ok({ countedQty: 1, selectedUom: 'each', rcId: '' }).ok).toBe(false)
    expect(ok({ countedQty: 1, selectedUom: 'each' }).ok).toBe(false)
  })

  it('refuses a combinedOnHand that is present but not an object', () => {
    expect(ok('12').ok).toBe(false)
    expect(ok(12).ok).toBe(false)
    expect(ok([]).ok).toBe(false)
  })
})

describe('isSafeRowId / lockItemsSql', () => {
  it('accepts the id shapes this schema generates (cuid, uuid)', () => {
    expect(isSafeRowId('cmq8qulra0001we99ipbjw2bl')).toBe(true)
    expect(isSafeRowId('ce4f1a1e-364e-54ac-3ad3-3acc00000001')).toBe(true)
    expect(isSafeRowId('a_b-C9')).toBe(true)
  })

  it('rejects anything that could leave the identifier', () => {
    for (const bad of ["a'b", 'a b', 'a;DROP', 'a)', '', 'a'.repeat(65), 'é', 'a\nb', 'a/b', 'a\\b', 'a--b '])
      expect(isSafeRowId(bad), bad).toBe(false)
    expect(isSafeRowId(undefined)).toBe(false)
    expect(isSafeRowId(123)).toBe(false)
    // A bare `--` IS allowed by the charset, and harmlessly so: it can only ever
    // appear INSIDE a single-quoted literal, where a comment marker is inert,
    // and the charset excludes the quote and backslash needed to escape one.
    expect(isSafeRowId('--')).toBe(true)
  })

  it('builds a literal FOR UPDATE with the ids sorted', () => {
    expect(lockItemsSql(['b2', 'a1']))
      .toBe(`SELECT id FROM "InventoryItem" WHERE id IN ('a1','b2') ORDER BY id FOR UPDATE`)
  })

  it('sorts identically whichever way round the pair is given (no deadlock)', () => {
    expect(lockItemsSql(['b2', 'a1'])).toBe(lockItemsSql(['a1', 'b2']))
  })

  it('de-duplicates', () => {
    expect(lockItemsSql(['a1', 'a1'])).toBe(`SELECT id FROM "InventoryItem" WHERE id IN ('a1') ORDER BY id FOR UPDATE`)
  })

  it('throws rather than interpolate an id it cannot vouch for', () => {
    expect(() => lockItemsSql(['ok1', "bad'id"])).toThrow(/unsafe row id/i)
    expect(() => lockItemsSql([])).toThrow(/no ids/i)
  })
})

describe('repointTableChecks', () => {
  it('covers every re-pointable table, exactly once, with its own FK column', () => {
    const checks = repointTableChecks()
    expect(checks).toHaveLength(Object.keys(REPOINT_FK).length)
    expect(new Set(checks.map(c => c.table)).size).toBe(checks.length)
    for (const c of checks) expect(c.fk).toBe(REPOINT_FK[c.table])
    // The point of deriving it from the Record: a table added to the planner's
    // union cannot be forgotten by the post-apply "nothing left behind" sweep.
    expect(checks.map(c => c.table).sort()).toEqual(Object.keys(REPOINT_FK).sort())
  })

  it('carries the InvoiceScanItem exception', () => {
    expect(repointTableChecks().find(c => c.table === 'InvoiceScanItem')!.fk).toBe('matchedItemId')
  })
})

const upd = (table: UpdateTable, id: string, after: Record<string, unknown>): MergeOp =>
  ({ t: 'update', table, id, before: { was: id }, after })

const shape = (ops: BatchedOp[]) => ops.map(o =>
  o.t === 'updateMany' ? `updateMany:${o.table}:${o.ids.join('+')}`
  : o.t === 'update' ? `update:${o.table}:${o.id}`
  : o.t === 'repoint' ? `repoint:${o.table}`
  : `${o.t}:${o.row.id as string}`)

describe('batchUpdateOps', () => {
  it('merges an adjacent run of identical payloads on one table into one updateMany', () => {
    const clear = { parLevel: null, reorderQty: null }
    expect(shape(batchUpdateOps([
      upd('StockAllocation', 'a1', clear),
      upd('StockAllocation', 'a2', clear),
      upd('StockAllocation', 'a3', clear),
    ]))).toEqual(['updateMany:StockAllocation:a1+a2+a3'])
  })

  it('leaves a lone update exactly as it was, `before` intact', () => {
    const ops = [upd('CountLine', 'c1', { countedQtyBase: 27 })]
    const out = batchUpdateOps(ops)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(ops[0])
  })

  it('never merges different payloads — a demote and a promote stay apart', () => {
    expect(shape(batchUpdateOps([
      upd('InventorySupplierPrice', 'o1', { isPrimary: false }),
      upd('InventorySupplierPrice', 'o2', { isPrimary: true }),
    ]))).toEqual(['update:InventorySupplierPrice:o1', 'update:InventorySupplierPrice:o2'])
  })

  it('never merges across a different table', () => {
    expect(shape(batchUpdateOps([
      upd('CountLine', 'c1', { x: 1 }),
      upd('InventorySnapshot', 's1', { x: 1 }),
      upd('CountLine', 'c2', { x: 1 }),
    ]))).toEqual(['update:CountLine:c1', 'update:InventorySnapshot:s1', 'update:CountLine:c2'])
  })

  it('never merges ACROSS a repoint — the isPrimary promote-after-repoint rule depends on it', () => {
    const demote = { isPrimary: false }
    expect(shape(batchUpdateOps([
      upd('InventorySupplierPrice', 'o1', demote),
      { t: 'repoint', table: 'InventorySupplierPrice', ids: ['o1', 'o2'] },
      upd('InventorySupplierPrice', 'o2', demote),
    ]))).toEqual([
      'update:InventorySupplierPrice:o1',
      'repoint:InventorySupplierPrice',
      'update:InventorySupplierPrice:o2',
    ])
  })

  it('never merges across a delete or a create either', () => {
    const same = { q: 1 }
    expect(shape(batchUpdateOps([
      upd('InventorySnapshot', 's1', same),
      { t: 'delete', table: 'InventorySnapshot', row: { id: 'd1' } },
      upd('InventorySnapshot', 's2', same),
      { t: 'create', table: 'InventorySupplierPrice', row: { id: 'n1' } },
      upd('InventorySnapshot', 's3', same),
    ]))).toEqual([
      'update:InventorySnapshot:s1', 'delete:d1',
      'update:InventorySnapshot:s2', 'create:n1',
      'update:InventorySnapshot:s3',
    ])
  })

  it('preserves relative order and loses no row', () => {
    const clear = { parLevel: null, reorderQty: null }
    const ops: MergeOp[] = [
      { t: 'repoint', table: 'CountLine', ids: ['c1'] },
      upd('StockAllocation', 'a1', clear),
      upd('StockAllocation', 'a2', clear),
      upd('InventoryItem', 'i1', { mergedIntoId: 's' }),
      upd('InventoryItem', 'i2', { mergedIntoId: 's' }),
      upd('InventoryItem', 'i3', { isActive: false }),
    ]
    expect(shape(batchUpdateOps(ops))).toEqual([
      'repoint:CountLine',
      'updateMany:StockAllocation:a1+a2',
      'updateMany:InventoryItem:i1+i2',
      'update:InventoryItem:i3',
    ])
    const covered = batchUpdateOps(ops).flatMap(o =>
      o.t === 'updateMany' ? o.ids : o.t === 'update' ? [o.id] : [])
    expect(covered).toEqual(['a1', 'a2', 'i1', 'i2', 'i3'])
  })

  it('is a no-op on a manifest with nothing batchable', () => {
    const ops: MergeOp[] = [
      upd('CountLine', 'c1', { countedQtyBase: 1 }),
      upd('CountLine', 'c2', { countedQtyBase: 2 }),
    ]
    expect(batchUpdateOps(ops)).toEqual(ops)
  })

  it('treats a payload key-order difference as a different payload (never guesses)', () => {
    expect(shape(batchUpdateOps([
      upd('CountLine', 'c1', { a: 1, b: 2 }),
      upd('CountLine', 'c2', { b: 2, a: 1 }),
    ]))).toEqual(['update:CountLine:c1', 'update:CountLine:c2'])
  })
})

describe('parseManifest', () => {
  const good: MergeManifest = { survivorId: 's', absorbedId: 'a', ops: [op('repoint', 'CountLine', 'x')] }

  it('accepts a manifest read back out of the Json column', () => {
    expect(parseManifest(JSON.parse(JSON.stringify(good)))).toEqual(good)
  })

  it('rejects anything that is not a manifest', () => {
    expect(parseManifest(null)).toBeNull()
    expect(parseManifest('{}')).toBeNull()
    expect(parseManifest({ survivorId: 's', absorbedId: 'a' })).toBeNull()
    expect(parseManifest({ survivorId: 's', absorbedId: 1, ops: [] })).toBeNull()
    expect(parseManifest({ survivorId: 's', absorbedId: 'a', ops: [{ t: 'nope' }] })).toBeNull()
    // replaces the deleted `factor: 'x'` case (v1 dropped `factor`): the shape
    // rules that remain are ops-must-be-an-array and every op must name a kind
    // AND a table.
    expect(parseManifest({ survivorId: 's', absorbedId: 'a', ops: {} })).toBeNull()
    expect(parseManifest({ survivorId: 's', absorbedId: 'a', ops: [{ t: 'repoint' }] })).toBeNull()
    expect(parseManifest({ survivorId: 's', absorbedId: 'a', ops: [null] })).toBeNull()
  })

  it('still accepts a pre-v1-cut manifest that carries the removed `factor` key', () => {
    // Nothing reads `factor` any more; an old stored manifest must stay undoable.
    const legacy = { survivorId: 's', absorbedId: 'a', factor: 1, ops: [op('repoint', 'CountLine', 'x')] }
    expect(parseManifest(legacy)).toEqual(legacy)
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
      survivorId: 's', absorbedId: 'a',
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
    expect(recipeIngredientRepointIds({ survivorId: 's', absorbedId: 'a', ops: [] })).toEqual([])
  })
})
