import { describe, it, expect } from 'vitest'
import { capAliasConfidence, pickBestFuzzy, buildOfferSkuIndex, groupAliases, MAX_ALIASES_PER_ITEM, isSupplierSpecificRule, offerSkuTierYieldsToRule, previousPriceFor } from '@/lib/invoice-matcher'

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

describe('buildOfferSkuIndex — (supplier, SKU) → item from one supplier\'s rows', () => {
  it('maps each SKU to its item and drops a SKU two items claim', () => {
    const idx = buildOfferSkuIndex([
      { supplierId: 's1', supplierItemCode: 'A1', inventoryItemId: 'i1' },
      { supplierId: 's1', supplierItemCode: 'B2', inventoryItemId: 'i2' },
      { supplierId: 's1', supplierItemCode: 'B2', inventoryItemId: 'i3' },
    ])
    expect(idx.get('A1')).toBe('i1')
    expect(idx.has('B2')).toBe(false)
  })

  it('the same item twice under one SKU is not ambiguous', () => {
    const idx = buildOfferSkuIndex([
      { supplierId: 's1', supplierItemCode: '123', inventoryItemId: 'item1' },
      { supplierId: 's1', supplierItemCode: '123', inventoryItemId: 'item1' },
    ])
    expect(idx).toEqual(new Map([['123', 'item1']]))
  })

  it('null and empty supplierItemCode values are ignored', () => {
    const idx = buildOfferSkuIndex([
      { supplierId: 's1', supplierItemCode: null, inventoryItemId: 'item1' },
      { supplierId: 's1', supplierItemCode: '', inventoryItemId: 'item2' },
    ])
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

describe('isSupplierSpecificRule', () => {
  it('a rule stored under the raw OCR supplier name is supplier-specific', () => {
    expect(isSupplierSpecificRule('SYSCO Canada, Inc.', 'SYSCO Canada, Inc.', 'Sysco')).toBe(true)
  })
  it('…and so is one stored under the canonical Supplier name', () => {
    expect(isSupplierSpecificRule('Sysco', 'SYSCO Canada, Inc.', 'Sysco')).toBe(true)
  })
  it('the generic ("") bucket is never supplier-specific', () => {
    expect(isSupplierSpecificRule('', 'Sysco', 'Sysco')).toBe(false)
    expect(isSupplierSpecificRule(null, 'Sysco', 'Sysco')).toBe(false)
  })
  it('another supplier’s rule is not this supplier’s', () => {
    expect(isSupplierSpecificRule('GFS', 'Sysco', 'Sysco')).toBe(false)
  })
})

describe('offerSkuTierYieldsToRule', () => {
  const taught = { supplierName: 'Sysco', inventoryItem: { id: 'i1' } }

  it('stands tier 0b down when a human taught this supplier this description', () => {
    expect(offerSkuTierYieldsToRule(taught, 'Sysco', 'Sysco')).toBe(true)
  })
  it('leaves tier 0b alone for a generic rule — a unique SKU is better evidence', () => {
    expect(offerSkuTierYieldsToRule({ supplierName: '', inventoryItem: { id: 'i1' } }, 'Sysco', 'Sysco')).toBe(false)
  })
  it('leaves tier 0b alone when there is no rule, or the rule points nowhere', () => {
    expect(offerSkuTierYieldsToRule(null, 'Sysco', 'Sysco')).toBe(false)
    expect(offerSkuTierYieldsToRule(undefined, 'Sysco', 'Sysco')).toBe(false)
    expect(offerSkuTierYieldsToRule({ supplierName: 'Sysco', inventoryItem: null }, 'Sysco', 'Sysco')).toBe(false)
  })
})

describe('previousPriceFor — the "was" price on a matched line', () => {
  const BUTTER = {
    dimension: 'MASS', baseUnit: 'g', countUnit: 'case',
    packChain: [{ unit: 'case', per: 11350 }], pricing: { mode: 'PACK', purchasePrice: 142.5 },
    eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  }
  it("is this supplier's own last offer price when the offer exists", () => {
    expect(previousPriceFor({ lastPrice: '139.9' }, BUTTER)).toBe(139.9)
  })
  it("falls back to the primary chain's listed price (box price), never a stored column", () => {
    expect(previousPriceFor(null, BUTTER)).toBeCloseTo(142.5, 9)
    expect(previousPriceFor({ lastPrice: null }, BUTTER)).toBeCloseTo(142.5, 9)
  })
  it('falls back to the RATE itself for a weight-priced item (what the line rate is compared with)', () => {
    const SALMON = { dimension: 'MASS', baseUnit: 'g', countUnit: 'lb', packChain: [{ unit: 'lb', per: 453.6 }], pricing: { mode: 'RATE', rate: 28.6, rateUnit: 'kg' }, eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
    expect(previousPriceFor(null, SALMON)).toBe(28.6)
  })
})
