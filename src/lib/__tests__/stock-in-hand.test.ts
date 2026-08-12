import { describe, it, expect } from 'vitest'
import {
  stockInHandQty, stockInHandDate, stockInHandValue, theoreticalQty, stockInHandKpis,
  selectStockInHandRows, type StockInHandItem,
} from '../stock-in-hand'
import { resolveCountUom } from '../count-uom'
import type { PillItem } from '../inventory-pills'

const item = (over: Partial<StockInHandItem> = {}): StockInHandItem => ({
  countedQtyScoped: 10,
  countedDateScoped: '2026-08-01T00:00:00.000Z',
  pricePerBaseUnit: 2,
  theoreticalStock: 8,
  ...over,
})

describe('stockInHandQty', () => {
  it('returns the last counted quantity for the scope', () => {
    expect(stockInHandQty(item())).toBe(10)
  })

  it('parses Prisma Decimals that arrive as strings', () => {
    expect(stockInHandQty(item({ countedQtyScoped: '12.5' }))).toBe(12.5)
  })

  it('returns null when never counted', () => {
    expect(stockInHandQty(item({ countedQtyScoped: null }))).toBeNull()
    expect(stockInHandQty(item({ countedQtyScoped: undefined }))).toBeNull()
  })

  it('returns 0 for a genuine zero count, not null', () => {
    expect(stockInHandQty(item({ countedQtyScoped: 0 }))).toBe(0)
  })

  // The bug this field exists to fix: a CATERING view read the item's global
  // lastCountQty and reported the KITCHEN count. Nothing here may fall back to it.
  it('never falls back to the item-global lastCountQty', () => {
    const crossRc = { ...item({ countedQtyScoped: null }), lastCountQty: 999 } as StockInHandItem
    expect(stockInHandQty(crossRc)).toBeNull()
    expect(stockInHandValue(crossRc)).toBe(0)
  })
})

describe('stockInHandDate', () => {
  it('reports the scoped count date as an ISO string', () => {
    expect(stockInHandDate(item())).toBe('2026-08-01T00:00:00.000Z')
    expect(stockInHandDate(item({ countedDateScoped: new Date('2026-07-02T00:00:00.000Z') })))
      .toBe('2026-07-02T00:00:00.000Z')
  })

  it('is null when never counted in scope, and never falls back to lastCountDate', () => {
    const crossRc = { ...item({ countedDateScoped: null }), lastCountDate: '2026-08-01' } as StockInHandItem
    expect(stockInHandDate(crossRc)).toBeNull()
  })

  it('is null for an unparseable date rather than throwing', () => {
    expect(stockInHandDate(item({ countedDateScoped: 'not a date' }))).toBeNull()
  })
})

describe('stockInHandValue', () => {
  it('values the counted quantity at the current price', () => {
    expect(stockInHandValue(item({ countedQtyScoped: 10, pricePerBaseUnit: 2 }))).toBe(20)
  })

  it('parses a string price', () => {
    expect(stockInHandValue(item({ countedQtyScoped: 4, pricePerBaseUnit: '1.25' }))).toBe(5)
  })

  it('is 0 when never counted, however large the theoretical stock', () => {
    expect(stockInHandValue(item({ countedQtyScoped: null, theoreticalStock: 999 }))).toBe(0)
  })
})

describe('theoreticalQty', () => {
  it('prefers theoreticalStock', () => {
    expect(theoreticalQty(item({ theoreticalStock: 8, stockOnHand: 3 }))).toBe(8)
  })

  it('falls back to stockOnHand when theoretical is absent', () => {
    expect(theoreticalQty(item({ theoreticalStock: null, stockOnHand: 3 }))).toBe(3)
  })

  it('is 0 when neither is present', () => {
    expect(theoreticalQty(item({ theoreticalStock: null, stockOnHand: null }))).toBe(0)
  })
})

describe('stockInHandKpis', () => {
  it('sums value, counts coverage and reports never-counted', () => {
    const k = stockInHandKpis([
      item({ countedQtyScoped: 10, pricePerBaseUnit: 2, theoreticalStock: 10 }),
      item({ countedQtyScoped: null, pricePerBaseUnit: 5, theoreticalStock: 4 }),
    ])
    expect(k.value).toBe(20)
    expect(k.counted).toBe(1)
    expect(k.total).toBe(2)
    expect(k.neverCounted).toBe(1)
  })

  it('computes unverified movement as theoretical value minus stock in hand value', () => {
    const k = stockInHandKpis([
      item({ countedQtyScoped: 10, theoreticalStock: 8, pricePerBaseUnit: 2 }),
    ])
    expect(k.theoreticalValue).toBe(16)
    expect(k.value).toBe(20)
    expect(k.unverifiedMovement).toBe(-4)
  })

  it('counts a never-counted item toward theoretical value but not stock in hand', () => {
    const k = stockInHandKpis([
      item({ countedQtyScoped: null, theoreticalStock: 4, pricePerBaseUnit: 5 }),
    ])
    expect(k.value).toBe(0)
    expect(k.theoreticalValue).toBe(20)
    expect(k.unverifiedMovement).toBe(20)
  })

  it('reports the earliest count date among counted items only', () => {
    const k = stockInHandKpis([
      item({ countedQtyScoped: 1, countedDateScoped: '2026-08-05T00:00:00.000Z' }),
      item({ countedQtyScoped: 1, countedDateScoped: '2026-07-02T00:00:00.000Z' }),
      item({ countedQtyScoped: null, countedDateScoped: '2026-01-01T00:00:00.000Z' }),
    ])
    expect(k.oldestCountDate).toBe('2026-07-02T00:00:00.000Z')
  })

  it('handles an empty set without crashing', () => {
    const k = stockInHandKpis([])
    expect(k).toEqual({
      value: 0, counted: 0, total: 0, neverCounted: 0,
      oldestCountDate: null, theoreticalValue: 0, unverifiedMovement: 0,
    })
  })
})

/**
 * Call-site coverage for the export bug fixed in c62f9f2: the export's
 * stockInHandWorkbook must normalize each row's countUnit (resolveCountUom)
 * BEFORE applying the status-pill filter, or a Low-stock-filtered export can
 * contain a different row set than the screen that produced it. The two
 * tests originally added for that fix (inventory-pills.test.ts) only exercise
 * matchesPill + resolveCountUom directly — reverting the normalization line
 * in the route left both green, because neither test goes through the route's
 * call site. selectStockInHandRows is the extracted, testable version of that
 * call site; these tests fail if its normalize-then-filter ordering regresses.
 */
describe('selectStockInHandRows', () => {
  // Mirrors the flour fixture in inventory-pills.test.ts: MASS, base g, a real
  // multi-link chain, 12,500 g on hand, par 20 (count units). The STORED
  // countUnit is deliberately one the chain cannot resolve — an empty string,
  // or a cross-dimension leftover like 'ml' on a MASS item (the known
  // purchaseUnit corruption class documented in project_countuom_purchaseunit_repair) —
  // so the RAW value measures in BASE units (12,500 > par 20 → not low) while
  // the RESOLVED value is 'kg' (12.5 < 20 → low). The lowStock verdict, and
  // therefore the row's membership in the returned set, flips between them.
  const packChain = [{ unit: 'case', per: 12 }, { unit: 'kg', per: 1000 }]
  const flour = (countUnit: string): PillItem & { itemName: string } => ({
    itemName: 'Flour',
    lastCountDate: null,
    pricePerBaseUnit: 0.004,
    theoreticalStock: 12500,
    stockOnHand: 12500,
    parLevel: 20,
    baseUnit: 'g',
    dimension: 'MASS',
    packChain,
    countUnit,
  })

  it('resolves an unresolvable stored countUnit before filtering, so a low-stock row is not dropped', () => {
    for (const stored of ['', 'ml']) {
      const resolved = resolveCountUom({ dimension: 'MASS', baseUnit: 'g', packChain, countUnit: stored })
      expect(resolved).toBe('kg')

      const result = selectStockInHandRows([flour(stored)], 'lowStock')
      // Filtering the RAW '' / 'ml' countUnit against par (without resolving first) would
      // compare 12,500 base units to par 20 and exclude this row — the row only survives
      // into the Low-stock export because selectStockInHandRows resolves countUnit first.
      expect(result).toHaveLength(1)
      expect(result[0].itemName).toBe('Flour')
      expect(result[0].countUnit).toBe('kg')
    }
  })

  it('excludes a well-stocked row, proving the function actually filters', () => {
    const wellStocked = { ...flour('kg'), theoreticalStock: 50000, stockOnHand: 50000 } // 50 kg > par 20
    expect(selectStockInHandRows([wellStocked], 'lowStock')).toHaveLength(0)
  })
})
