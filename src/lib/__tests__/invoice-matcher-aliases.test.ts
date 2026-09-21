import { describe, it, expect } from 'vitest'
import { capAliasConfidence, pickBestFuzzy, buildOfferSkuIndex, groupAliases, MAX_ALIASES_PER_ITEM } from '@/lib/invoice-matcher'

describe('capAliasConfidence', () => {
  it('caps a HIGH match won only through an alias down to MEDIUM', () => {
    expect(capAliasConfidence('HIGH', true)).toBe('MEDIUM')
  })
  it('leaves a HIGH match won on the item name itself alone', () => {
    expect(capAliasConfidence('HIGH', false)).toBe('HIGH')
  })
  it('leaves non-HIGH confidences untouched regardless of how they were won', () => {
    expect(capAliasConfidence('MEDIUM', true)).toBe('MEDIUM')
    expect(capAliasConfidence('LOW', true)).toBe('LOW')
    expect(capAliasConfidence('NONE', true)).toBe('NONE')
  })
})

describe('pickBestFuzzy', () => {
  // (i) A line naming item B outright must win over item A's alias tying B's
  // own-name score — regardless of which item the loop happens to visit first.
  it('an own-name match beats an equal-score alias match, in either order', () => {
    const ownB = { id: 'itemB', score: 100, viaAlias: false }   // named "Butter Unsalted"
    const aliasA = { id: 'itemA', score: 100, viaAlias: true }  // alias "Butter Unsalted"
    expect(pickBestFuzzy([aliasA, ownB])?.id).toBe('itemB')
    expect(pickBestFuzzy([ownB, aliasA])?.id).toBe('itemB')
  })

  // (ii) A strictly higher alias score still wins over a weaker own-name score,
  // and is correctly reported as viaAlias, in either order.
  it('a strictly higher alias score wins over a weaker own-name score', () => {
    const aliasA = { id: 'itemA', score: 90, viaAlias: true }
    const ownB = { id: 'itemB', score: 70, viaAlias: false }
    expect(pickBestFuzzy([aliasA, ownB])).toEqual(aliasA)
    expect(pickBestFuzzy([ownB, aliasA])).toEqual(aliasA)
  })

  // (iii) A full tie on own-name score breaks on id ascending, in either order —
  // so the winner never depends on iteration order over the inventory items.
  it('an own-name/own-name tie breaks on id ascending, in either order', () => {
    const itemB = { id: 'itemB', score: 80, viaAlias: false }
    const itemA = { id: 'itemA', score: 80, viaAlias: false }
    expect(pickBestFuzzy([itemB, itemA])?.id).toBe('itemA')
    expect(pickBestFuzzy([itemA, itemB])?.id).toBe('itemA')
  })

  it('returns null for an empty candidate list', () => {
    expect(pickBestFuzzy([])).toBeNull()
  })

  it('a single candidate wins trivially', () => {
    const only = { id: 'itemX', score: 42, viaAlias: true }
    expect(pickBestFuzzy([only])).toEqual(only)
  })
})

describe('buildOfferSkuIndex', () => {
  it('indexes a single item under its SKU', () => {
    const idx = buildOfferSkuIndex(
      [{ supplierName: 'Sysco', supplierItemCode: '123', inventoryItemId: 'item1' }],
      'Sysco'
    )
    expect(idx).toEqual(new Map([['123', 'item1']]))
  })

  it('the same item under both raw and canonical supplier names is not ambiguous — one entry', () => {
    const idx = buildOfferSkuIndex(
      [
        { supplierName: 'SYSCO Canada, Inc.', supplierItemCode: '123', inventoryItemId: 'item1' },
        { supplierName: 'Sysco', supplierItemCode: '123', inventoryItemId: 'item1' },
      ],
      'Sysco'
    )
    expect(idx.size).toBe(1)
    expect(idx.get('123')).toBe('item1')
  })

  it('a canonical-name code overrides a raw-name code for the SAME item (no ambiguity)', () => {
    const idx = buildOfferSkuIndex(
      [
        { supplierName: 'SYSCO Canada, Inc.', supplierItemCode: 'AAA', inventoryItemId: 'item1' },
        { supplierName: 'Sysco', supplierItemCode: 'BBB', inventoryItemId: 'item1' },
      ],
      'Sysco'
    )
    expect(idx).toEqual(new Map([['BBB', 'item1']]))
    expect(idx.has('AAA')).toBe(false)
  })

  it('two different items sharing a SKU are ambiguous and both omitted', () => {
    const idx = buildOfferSkuIndex(
      [
        { supplierName: 'Sysco', supplierItemCode: '999', inventoryItemId: 'itemA' },
        { supplierName: 'Sysco', supplierItemCode: '999', inventoryItemId: 'itemB' },
      ],
      'Sysco'
    )
    expect(idx.has('999')).toBe(false)
    expect(idx.size).toBe(0)
  })

  it('null and empty supplierItemCode values are ignored', () => {
    const idx = buildOfferSkuIndex(
      [
        { supplierName: 'Sysco', supplierItemCode: null, inventoryItemId: 'item1' },
        { supplierName: 'Sysco', supplierItemCode: '', inventoryItemId: 'item2' },
      ],
      'Sysco'
    )
    expect(idx.size).toBe(0)
  })
})

describe('groupAliases', () => {
  const itemNameById = new Map([['item1', 'Butter Unsalted']])

  it('caps the alias list at MAX_ALIASES_PER_ITEM, keeping the input (usefulness) order', () => {
    // Two-digit suffixes: normalize() drops single-character tokens, so a
    // single digit would collapse every row to the same normalized key.
    const rows = Array.from({ length: 7 }, (_, i) => ({
      inventoryItemId: 'item1',
      rawDescription: `Alias number ${String(i).padStart(2, '0')}`,
    }))
    const grouped = groupAliases(rows, itemNameById)
    expect(grouped.get('item1')).toHaveLength(MAX_ALIASES_PER_ITEM)
    expect(grouped.get('item1')).toEqual(rows.slice(0, MAX_ALIASES_PER_ITEM).map(r => r.rawDescription))
  })

  it('de-duplicates aliases case-insensitively', () => {
    const rows = [
      { inventoryItemId: 'item1', rawDescription: 'Zucchini Green Fancy' },
      { inventoryItemId: 'item1', rawDescription: 'ZUCCHINI GREEN FANCY' },
    ]
    const grouped = groupAliases(rows, itemNameById)
    expect(grouped.get('item1')).toEqual(['Zucchini Green Fancy'])
  })

  it('skips an alias whose normalized form equals the item\'s own name', () => {
    const rows = [
      { inventoryItemId: 'item1', rawDescription: 'BUTTER UNSALTED' },
      { inventoryItemId: 'item1', rawDescription: 'Butter Unsalted Block' },
    ]
    const grouped = groupAliases(rows, itemNameById)
    expect(grouped.get('item1')).toEqual(['Butter Unsalted Block'])
  })

  it('an item whose only alias equals its own name gets no entry', () => {
    const rows = [{ inventoryItemId: 'item1', rawDescription: 'butter unsalted' }]
    const grouped = groupAliases(rows, itemNameById)
    expect(grouped.has('item1')).toBe(false)
  })
})
