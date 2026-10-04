import { describe, it, expect } from 'vitest'
import { planAliasBackfill, makeSupplierResolver, type BackfillRule } from '@/lib/alias-backfill'

const suppliers = [{ id: 'sysco', name: 'Sysco' }, { id: 'gfs', name: 'Gordon Food Service' }]
const supplierAliases = [{ supplierId: 'sysco', name: 'SYSCO FOOD SERVICES OF CANADA' }]

let n = 0
function rule(p: Partial<BackfillRule> = {}): BackfillRule {
  n += 1
  return {
    id: `r${n}`, rawDescription: 'GRAPE, RED FRSH/SEEDLS', supplierName: 'Sysco', inventoryItemId: 'grapes',
    useCount: 1, lastUsed: new Date('2026-09-01T00:00:00Z'),
    invoicePackQty: null, invoicePackSize: null, invoicePackUOM: null, supplierItemCode: null,
    item: { itemName: 'Red Grapes', isActive: true, mergedIntoId: null, hasRecipe: false },
    ...p,
  }
}

describe('makeSupplierResolver', () => {
  const resolve = makeSupplierResolver(suppliers, supplierAliases)
  it('matches a supplier name case-insensitively', () => {
    expect(resolve('SYSCO')).toEqual({ supplierId: 'sysco' })
  })
  it('falls back to a supplier alias spelling', () => {
    expect(resolve('Sysco Food Services of Canada')).toEqual({ supplierId: 'sysco' })
  })
  it('reports a blank or unknown supplier', () => {
    expect(resolve('')).toEqual({ reason: 'no supplier' })
    expect(resolve('Sysco Vancouver')).toEqual({ reason: 'unknown supplier' })
  })
  it('refuses to guess between two suppliers with the same name', () => {
    const r = makeSupplierResolver([...suppliers, { id: 'sysco2', name: 'sysco' }], [])
    expect(r('Sysco')).toEqual({ reason: 'ambiguous supplier' })
  })
})

describe('planAliasBackfill', () => {
  it('copies a rule into one alias row with normalised text, code and pack', () => {
    const plan = planAliasBackfill([rule({
      supplierItemCode: ' ab12 ', invoicePackQty: '4', invoicePackSize: 1.5, invoicePackUOM: 'kg', useCount: 3,
    })], suppliers, supplierAliases)
    expect(plan.rows).toEqual([{
      inventoryItemId: 'grapes', supplierId: 'sysco', text: 'grape red frsh seedls',
      rawText: 'GRAPE, RED FRSH/SEEDLS', supplierItemCode: 'AB12',
      packQty: '4', packSize: '1.5', packUOM: 'kg', source: 'BACKFILL',
      useCount: 3, lastUsed: new Date('2026-09-01T00:00:00Z'),
    }])
    expect(plan.collisions).toEqual([])
  })

  it('stores a blank code as null', () => {
    const plan = planAliasBackfill([rule({ supplierItemCode: '  ' })], suppliers, supplierAliases)
    expect(plan.rows[0].supplierItemCode).toBeNull()
  })

  it('folds spellings of one supplier that normalise alike: highest useCount kept, counts summed, latest lastUsed', () => {
    const a = rule({ rawDescription: 'GRAPE RED FRSH SEEDLS', supplierName: 'Sysco', useCount: 2, lastUsed: new Date('2026-09-20T00:00:00Z') })
    const b = rule({ rawDescription: 'Grape, Red Frsh/Seedls', supplierName: 'SYSCO FOOD SERVICES OF CANADA', useCount: 5, supplierItemCode: 'X9' })
    const plan = planAliasBackfill([a, b], suppliers, supplierAliases)
    expect(plan.rows).toHaveLength(1)
    expect(plan.rows[0]).toMatchObject({ rawText: 'Grape, Red Frsh/Seedls', supplierItemCode: 'X9', useCount: 7, lastUsed: new Date('2026-09-20T00:00:00Z') })
    expect(plan.collisions).toHaveLength(1)
    expect(plan.collisions[0].kept.id).toBe(b.id)
    expect(plan.collisions[0].differentItems).toBe(false)
  })

  it('flags a collision that joins two different items', () => {
    const plan = planAliasBackfill([
      rule({ inventoryItemId: 'grapes', useCount: 1 }),
      rule({ inventoryItemId: 'grapes-2', useCount: 4 }),
    ], suppliers, supplierAliases)
    expect(plan.rows[0].inventoryItemId).toBe('grapes-2')
    expect(plan.collisions[0].differentItems).toBe(true)
  })

  it('keeps the same wording under two suppliers apart', () => {
    const plan = planAliasBackfill([rule(), rule({ supplierName: 'Gordon Food Service' })], suppliers, supplierAliases)
    expect(plan.rows.map(r => r.supplierId).sort()).toEqual(['gfs', 'sysco'])
    expect(plan.collisions).toEqual([])
  })

  it('skips merged and recipe-made items, and reports unresolved suppliers and blank wordings', () => {
    const plan = planAliasBackfill([
      rule({ item: { itemName: 'Old', isActive: false, mergedIntoId: 'grapes', hasRecipe: false } }),
      rule({ item: { itemName: 'Aioli', isActive: true, mergedIntoId: null, hasRecipe: true } }),
      rule({ supplierName: '' }),
      rule({ supplierName: 'Nobody Ltd' }),
      rule({ rawDescription: ' -- ' }),
    ], suppliers, supplierAliases)
    expect(plan.rows).toEqual([])
    expect(plan.skipped.map(s => s.reason)).toEqual(['merged item', 'recipe-made item'])
    expect(plan.unresolved.map(u => u.reason)).toEqual(['no supplier', 'unknown supplier', 'blank wording'])
  })

  it('lists a supplier code that lands on two items', () => {
    const plan = planAliasBackfill([
      rule({ rawDescription: 'GRAPES A', supplierItemCode: 'C1', inventoryItemId: 'a' }),
      rule({ rawDescription: 'GRAPES B', supplierItemCode: 'c1', inventoryItemId: 'b' }),
    ], suppliers, supplierAliases)
    expect(plan.sharedCodes).toEqual([{ supplierId: 'sysco', code: 'C1', itemIds: ['a', 'b'] }])
  })
})
