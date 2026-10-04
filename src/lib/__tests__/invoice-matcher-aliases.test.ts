import { describe, it, expect } from 'vitest'
import { capAliasConfidence, pickBestFuzzy, buildOfferSkuIndex, groupAliases, previousPriceFor, inventorySideFormat, inventorySidePrice } from '@/lib/invoice-matcher'

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

  it('a merged item with several SKUs indexes every one of them', () => {
    const idx = buildOfferSkuIndex([
      { supplierId: 's1', supplierItemCode: 'S-100', inventoryItemId: 'item1' },
      { supplierId: 's1', supplierItemCode: 'S-200', inventoryItemId: 'item1' },
    ])
    expect(idx).toEqual(new Map([['S-100', 'item1'], ['S-200', 'item1']]))
  })

  it('null and empty supplierItemCode values are ignored', () => {
    const idx = buildOfferSkuIndex([
      { supplierId: 's1', supplierItemCode: null, inventoryItemId: 'item1' },
      { supplierId: 's1', supplierItemCode: '', inventoryItemId: 'item2' },
    ])
    expect(idx.size).toBe(0)
  })
})

describe('groupAliases — this supplier\'s wordings for the tier-3 fuzzy pass', () => {
  const itemNameById = new Map([['item1', 'Butter Unsalted']])

  it('caps the alias list at 5 per item, keeping the input (usefulness) order', () => {
    // Two-digit suffixes: normalize() drops single-character tokens, so a
    // single digit would collapse every row to the same normalized key.
    const rows = Array.from({ length: 7 }, (_, i) => ({
      inventoryItemId: 'item1',
      rawText: `Alias number ${String(i).padStart(2, '0')}`,
    }))
    const grouped = groupAliases(rows, itemNameById)
    expect(grouped.get('item1')).toHaveLength(5)
    expect(grouped.get('item1')).toEqual(rows.slice(0, 5).map(r => r.rawText))
  })

  it('de-duplicates aliases case-insensitively', () => {
    const rows = [
      { inventoryItemId: 'item1', rawText: 'Zucchini Green Fancy' },
      { inventoryItemId: 'item1', rawText: 'ZUCCHINI GREEN FANCY' },
    ]
    const grouped = groupAliases(rows, itemNameById)
    expect(grouped.get('item1')).toEqual(['Zucchini Green Fancy'])
  })

  it('skips an alias whose normalized form equals the item\'s own name', () => {
    const rows = [
      { inventoryItemId: 'item1', rawText: 'BUTTER UNSALTED' },
      { inventoryItemId: 'item1', rawText: 'Butter Unsalted Block' },
    ]
    const grouped = groupAliases(rows, itemNameById)
    expect(grouped.get('item1')).toEqual(['Butter Unsalted Block'])
  })

  it('an item whose only alias equals its own name gets no entry', () => {
    const rows = [{ inventoryItemId: 'item1', rawText: 'butter unsalted' }]
    const grouped = groupAliases(rows, itemNameById)
    expect(grouped.has('item1')).toBe(false)
  })
})

describe('previousPriceFor — the "was" price on a matched line', () => {
  const BUTTER = {
    dimension: 'MASS', baseUnit: 'g', countUnit: 'case',
    packChain: [{ unit: 'case', per: 11350 }], pricing: { mode: 'PACK', purchasePrice: 142.5 },
    eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  }
  it("is this supplier's own last offer price when the offer exists", () => {
    expect(previousPriceFor({ pricing: { mode: 'PACK', purchasePrice: 139.9 } }, BUTTER)).toBe(139.9)
  })
  it("falls back to the primary chain's listed price (box price), never a stored column", () => {
    expect(previousPriceFor(null, BUTTER)).toBeCloseTo(142.5, 9)
    expect(previousPriceFor({ pricing: null }, BUTTER)).toBeCloseTo(142.5, 9)
  })
  it('falls back to the RATE itself for a weight-priced item (what the line rate is compared with)', () => {
    const SALMON = { dimension: 'MASS', baseUnit: 'g', countUnit: 'lb', packChain: [{ unit: 'lb', per: 453.6 }], pricing: { mode: 'RATE', rate: 28.6, rateUnit: 'kg' }, eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
    expect(previousPriceFor(null, SALMON)).toBe(28.6)
  })
})

// The inventory side of the price comparison divides the "was" price by the pack
// THAT price belongs to. A drawer-made or re-packed box has no (or stale) legacy
// pack fields; pairing its price with the item's pack read as a false big change.
describe('inventorySideFormat — the pack behind the "was" price', () => {
  const ITEM = { baseUnit: 'g', packChain: [{ unit: 'case', per: 1000 }] }
  const PRICED = { pricing: { mode: 'PACK', purchasePrice: 40 } }

  it("a priced box is read through its OWN chain, not the item's (main box) pack", () => {
    expect(inventorySideFormat({ ...PRICED, packChain: [{ unit: 'case', per: 4 }, { unit: 'bag', per: 2500 }] }, ITEM))
      .toEqual({ packQty: 4, packSize: 2500, packUOM: 'g' })
  })

  it('a re-packed box ignores the stale legacy pack fields it still carries', () => {
    expect(inventorySideFormat({
      ...PRICED, packChain: [{ unit: 'case', per: 2000 }], packQty: 6, packSize: 1, packUOM: 'kg',
    }, ITEM)).toEqual({ packQty: 1, packSize: 2000, packUOM: 'g' })
  })

  it('a priced box with no chain falls back to its legacy pack fields', () => {
    expect(inventorySideFormat({ ...PRICED, packChain: null, packQty: '6', packSize: '1', packUOM: 'kg' }, ITEM))
      .toEqual({ packQty: 6, packSize: 1, packUOM: 'kg' })
  })

  it("a box with no price (the \"was\" price is the item's) → the item's chain, whatever the box's pack", () => {
    expect(inventorySideFormat({ pricing: null, packChain: [{ unit: 'case', per: 4 }, { unit: 'bag', per: 2500 }], packQty: 4, packSize: 2.5, packUOM: 'kg' }, ITEM))
      .toEqual({ packQty: 1, packSize: 1000, packUOM: 'g' })
  })

  it("no box → the item's chain", () => {
    expect(inventorySideFormat(null, ITEM)).toEqual({ packQty: 1, packSize: 1000, packUOM: 'g' })
  })

  it('a three-level pack multiplies EVERY level above the leaf (4 × 6 × 1 = 24, not 4)', () => {
    expect(inventorySideFormat({ ...PRICED, packChain: [{ unit: 'case', per: 4 }, { unit: 'pack', per: 6 }, { unit: 'each', per: 1 }] }, { ...ITEM, baseUnit: 'each' }))
      .toEqual({ packQty: 24, packSize: 1, packUOM: 'each' })
  })
})

describe('inventorySidePrice — the "was" price per one unit, in its own unit', () => {
  const ITEM = { dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 10 } }

  it('a rate-priced box keeps its rate unit ($8 per kg stays per kg, never per gram)', () => {
    const box = { pricing: { mode: 'RATE', rate: 8, rateUnit: 'kg' }, packChain: [{ unit: 'kg', per: 1000 }] }
    expect(inventorySidePrice(box, ITEM)).toEqual({ pricePerUnit: 8, unit: 'kg' })
  })

  it('a pack-priced box is spread over its own pack ($40 per 4 × 2500 g → $0.004 per g)', () => {
    const box = { pricing: { mode: 'PACK', purchasePrice: 40 }, packChain: [{ unit: 'case', per: 4 }, { unit: 'bag', per: 2500 }] }
    expect(inventorySidePrice(box, ITEM)).toEqual({ pricePerUnit: 40 / 10000, unit: 'g' })
  })

  it("no priced box → the item's own price over the item's chain ($10 per 1000 g)", () => {
    expect(inventorySidePrice(null, ITEM)).toEqual({ pricePerUnit: 0.01, unit: 'g' })
    expect(inventorySidePrice({ pricing: null, packChain: [{ unit: 'case', per: 4 }] }, ITEM)).toEqual({ pricePerUnit: 0.01, unit: 'g' })
  })

  it("a rate-priced item with no box keeps the item's rate unit", () => {
    const item = { ...ITEM, pricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' } }
    expect(inventorySidePrice(null, item)).toEqual({ pricePerUnit: 3.49, unit: 'lb' })
  })
})
