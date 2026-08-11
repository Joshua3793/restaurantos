import { describe, it, expect } from 'vitest'
import {
  stockInHandQty, stockInHandValue, theoreticalQty, stockInHandKpis,
  type StockInHandItem,
} from '../stock-in-hand'

const item = (over: Partial<StockInHandItem> = {}): StockInHandItem => ({
  lastCountQty: 10,
  lastCountDate: '2026-08-01T00:00:00.000Z',
  pricePerBaseUnit: 2,
  theoreticalStock: 8,
  ...over,
})

describe('stockInHandQty', () => {
  it('returns the last counted quantity', () => {
    expect(stockInHandQty(item())).toBe(10)
  })

  it('parses Prisma Decimals that arrive as strings', () => {
    expect(stockInHandQty(item({ lastCountQty: '12.5' }))).toBe(12.5)
  })

  it('returns null when never counted', () => {
    expect(stockInHandQty(item({ lastCountQty: null }))).toBeNull()
    expect(stockInHandQty(item({ lastCountQty: undefined }))).toBeNull()
  })

  it('returns 0 for a genuine zero count, not null', () => {
    expect(stockInHandQty(item({ lastCountQty: 0 }))).toBe(0)
  })
})

describe('stockInHandValue', () => {
  it('values the counted quantity at the current price', () => {
    expect(stockInHandValue(item({ lastCountQty: 10, pricePerBaseUnit: 2 }))).toBe(20)
  })

  it('parses a string price', () => {
    expect(stockInHandValue(item({ lastCountQty: 4, pricePerBaseUnit: '1.25' }))).toBe(5)
  })

  it('is 0 when never counted, however large the theoretical stock', () => {
    expect(stockInHandValue(item({ lastCountQty: null, theoreticalStock: 999 }))).toBe(0)
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
      item({ lastCountQty: 10, pricePerBaseUnit: 2, theoreticalStock: 10 }),
      item({ lastCountQty: null, pricePerBaseUnit: 5, theoreticalStock: 4 }),
    ])
    expect(k.value).toBe(20)
    expect(k.counted).toBe(1)
    expect(k.total).toBe(2)
    expect(k.neverCounted).toBe(1)
  })

  it('computes unverified movement as theoretical value minus stock in hand value', () => {
    const k = stockInHandKpis([
      item({ lastCountQty: 10, theoreticalStock: 8, pricePerBaseUnit: 2 }),
    ])
    expect(k.theoreticalValue).toBe(16)
    expect(k.value).toBe(20)
    expect(k.unverifiedMovement).toBe(-4)
  })

  it('counts a never-counted item toward theoretical value but not stock in hand', () => {
    const k = stockInHandKpis([
      item({ lastCountQty: null, theoreticalStock: 4, pricePerBaseUnit: 5 }),
    ])
    expect(k.value).toBe(0)
    expect(k.theoreticalValue).toBe(20)
    expect(k.unverifiedMovement).toBe(20)
  })

  it('reports the earliest count date among counted items only', () => {
    const k = stockInHandKpis([
      item({ lastCountQty: 1, lastCountDate: '2026-08-05T00:00:00.000Z' }),
      item({ lastCountQty: 1, lastCountDate: '2026-07-02T00:00:00.000Z' }),
      item({ lastCountQty: null, lastCountDate: '2026-01-01T00:00:00.000Z' }),
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
