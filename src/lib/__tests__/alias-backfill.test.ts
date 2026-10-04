import { describe, it, expect } from 'vitest'
import { planAliasBackfill, planAliasUpdates, makeSupplierResolver, type BackfillRule, type ExistingAlias } from '@/lib/alias-backfill'

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

  it('takes the code and pack from a folded rule (first by useCount) when the kept rule has none', () => {
    const kept = rule({ rawDescription: 'VEAL BONES', useCount: 9 })
    const f1 = rule({ rawDescription: 'Veal Bones', useCount: 4, supplierItemCode: '12351', invoicePackQty: '1', invoicePackSize: '10', invoicePackUOM: 'kg' })
    const f2 = rule({ rawDescription: 'veal bones.', useCount: 2, supplierItemCode: '99999', invoicePackQty: '2', invoicePackSize: '5', invoicePackUOM: 'kg' })
    const plan = planAliasBackfill([f2, kept, f1], suppliers, supplierAliases)
    expect(plan.rows).toHaveLength(1)
    expect(plan.rows[0]).toMatchObject({
      rawText: 'VEAL BONES', supplierItemCode: '12351', packQty: '1', packSize: '10', packUOM: 'kg', useCount: 15,
    })
  })

  it('keeps the kept rule\'s own code and pack over a folded one', () => {
    const kept = rule({ rawDescription: 'SALMON', useCount: 9, supplierItemCode: '11108103', invoicePackUOM: 'lb', invoicePackQty: '1', invoicePackSize: '10' })
    const f1 = rule({ rawDescription: 'Salmon', useCount: 4, supplierItemCode: 'OTHER', invoicePackQty: '2', invoicePackSize: '5', invoicePackUOM: 'kg' })
    const plan = planAliasBackfill([kept, f1], suppliers, supplierAliases)
    expect(plan.rows[0]).toMatchObject({ supplierItemCode: '11108103', packQty: '1', packSize: '10', packUOM: 'lb' })
  })

  it('never borrows a code or pack from a folded rule on a different item', () => {
    const kept = rule({ rawDescription: 'TUNA', useCount: 9, inventoryItemId: 'tuna' })
    const other = rule({ rawDescription: 'Tuna', useCount: 4, inventoryItemId: 'tuna-loin', supplierItemCode: '21402211', invoicePackUOM: 'kg', invoicePackQty: '1', invoicePackSize: '5' })
    const plan = planAliasBackfill([kept, other], suppliers, supplierAliases)
    expect(plan.rows[0]).toMatchObject({ inventoryItemId: 'tuna', supplierItemCode: null, packQty: null, packSize: null, packUOM: null })
  })

  it('exposes each key\'s rules (kept first) for the update planner', () => {
    const a = rule({ rawDescription: 'GRAPE RED', useCount: 1 })
    const b = rule({ rawDescription: 'Grape, Red', useCount: 3 })
    const plan = planAliasBackfill([a, b], suppliers, supplierAliases)
    expect(plan.groups).toHaveLength(1)
    expect(plan.groups[0].rules.map(r => r.id)).toEqual([b.id, a.id])
    expect(plan.groups[0].row).toBe(plan.rows[0])
  })

  it('lists a supplier code that lands on two items', () => {
    const plan = planAliasBackfill([
      rule({ rawDescription: 'GRAPES A', supplierItemCode: 'C1', inventoryItemId: 'a' }),
      rule({ rawDescription: 'GRAPES B', supplierItemCode: 'c1', inventoryItemId: 'b' }),
    ], suppliers, supplierAliases)
    expect(plan.sharedCodes).toEqual([{ supplierId: 'sysco', code: 'C1', itemIds: ['a', 'b'] }])
  })
})

describe('planAliasUpdates (catch-up for rules learned after the backfill)', () => {
  const T0 = new Date('2026-10-04T01:28:00Z')
  function alias(p: Partial<ExistingAlias> = {}): ExistingAlias {
    return {
      id: 'al1', supplierId: 'sysco', text: 'grape red frsh seedls', inventoryItemId: 'grapes',
      rawText: 'GRAPE, RED FRSH/SEEDLS', supplierItemCode: null, packQty: null, packSize: null, packUOM: null,
      useCount: 1, lastUsed: T0, ...p,
    }
  }
  const groupsOf = (rules: BackfillRule[]) => planAliasBackfill(rules, suppliers, supplierAliases).groups

  it('creates the aliases whose key does not exist yet, exactly as the backfill rows', () => {
    const groups = groupsOf([rule({ lastUsed: T0 }), rule({ rawDescription: 'NEW WORDING' })])
    const r = planAliasUpdates(groups, [alias()])
    expect(r.creates.map(c => c.text)).toEqual(['new wording'])
    expect(r.creates[0]).toBe(groups[1].row)
    expect(r.updates).toEqual([])
  })

  it('leaves an alias alone when no rule is newer and nothing is missing', () => {
    const r = planAliasUpdates(groupsOf([rule({ useCount: 1, lastUsed: T0 })]), [alias()])
    expect(r).toEqual({ creates: [], updates: [] })
  })

  it('re-points an alias to the item a newer rule learned, with its wording, code, pack, count and date', () => {
    const later = new Date('2026-10-05T10:00:00Z')
    const r = planAliasUpdates(groupsOf([rule({
      rawDescription: 'Grape Red Frsh Seedls', inventoryItemId: 'green-grapes', useCount: 3, lastUsed: later,
      supplierItemCode: ' g7 ', invoicePackQty: '1', invoicePackSize: '8', invoicePackUOM: 'lb',
    })]), [alias()])
    expect(r.creates).toEqual([])
    expect(r.updates).toEqual([{
      id: 'al1', supplierId: 'sysco', text: 'grape red frsh seedls', reason: 'newer rule', itemChanged: true,
      data: {
        inventoryItemId: 'green-grapes', rawText: 'Grape Red Frsh Seedls', supplierItemCode: 'G7',
        packQty: '1', packSize: '8', packUOM: 'lb', useCount: 3, lastUsed: later,
      },
    }])
  })

  it('takes the NEWEST of several newer rules on one key, and the summed count only when larger', () => {
    const r = planAliasUpdates(groupsOf([
      rule({ rawDescription: 'GRAPE RED FRSH SEEDLS', inventoryItemId: 'a', useCount: 5, lastUsed: new Date('2026-10-05T00:00:00Z') }),
      rule({ rawDescription: 'grape red frsh/seedls', inventoryItemId: 'b', useCount: 1, lastUsed: new Date('2026-10-06T00:00:00Z') }),
    ]), [alias({ inventoryItemId: 'a', useCount: 40 })])
    expect(r.updates).toHaveLength(1)
    expect(r.updates[0].data).toEqual({
      inventoryItemId: 'b', rawText: 'grape red frsh/seedls', lastUsed: new Date('2026-10-06T00:00:00Z'),
    })
    expect(r.updates[0].itemChanged).toBe(true)
  })

  it('keeps the alias\'s code and pack when the newer rule has none', () => {
    const later = new Date('2026-10-05T00:00:00Z')
    const r = planAliasUpdates(groupsOf([rule({ useCount: 1, lastUsed: later })]),
      [alias({ supplierItemCode: 'KEEP', packQty: '2', packSize: '5', packUOM: 'kg' })])
    expect(r.updates[0].data).toEqual({ lastUsed: later })
    expect(r.updates[0].itemChanged).toBe(false)
  })

  it('fills a NULL code (and empty pack) from a rule that has one, even when no rule is newer', () => {
    const older = new Date('2026-09-01T00:00:00Z')
    const r = planAliasUpdates(groupsOf([
      rule({ rawDescription: 'VEAL BONES', useCount: 9, lastUsed: older }),
      rule({ rawDescription: 'Veal Bones', useCount: 4, lastUsed: older, supplierItemCode: '12351', invoicePackQty: '1', invoicePackSize: '10', invoicePackUOM: 'kg' }),
    ]), [alias({ text: 'veal bones', rawText: 'VEAL BONES', useCount: 13 })])
    expect(r.updates).toEqual([{
      id: 'al1', supplierId: 'sysco', text: 'veal bones', reason: 'fill', itemChanged: false,
      data: { supplierItemCode: '12351', packQty: '1', packSize: '10', packUOM: 'kg' },
    }])
  })

  it('never fills a code from a rule on a different item than the alias', () => {
    const older = new Date('2026-09-01T00:00:00Z')
    const r = planAliasUpdates(groupsOf([
      rule({ rawDescription: 'TUNA', inventoryItemId: 'tuna', useCount: 9, lastUsed: older }),
      rule({ rawDescription: 'Tuna', inventoryItemId: 'tuna-loin', useCount: 4, lastUsed: older, supplierItemCode: '21402211' }),
    ]), [alias({ text: 'tuna', inventoryItemId: 'tuna', useCount: 13 })])
    expect(r.updates).toEqual([])
  })

  it('compares Decimal-like pack values by their string form (no spurious update)', () => {
    const later = new Date('2026-10-05T00:00:00Z')
    const D = (s: string) => ({ toString: () => s })
    const r = planAliasUpdates(groupsOf([rule({ lastUsed: later, invoicePackQty: D('2'), invoicePackSize: D('5'), invoicePackUOM: 'kg' })]),
      [alias({ packQty: D('2'), packSize: D('5'), packUOM: 'kg' })])
    expect(r.updates[0].data).toEqual({ lastUsed: later })
  })
})
