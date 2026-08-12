import { describe, it, expect } from 'vitest'
import { reduceCountedLines, type CountedLine } from '../counted-stock'

const line = (over: Partial<CountedLine> = {}): CountedLine => ({
  revenueCenterId: 'kitchen',
  inventoryItemId: 'flour',
  qtyBase: 10,
  countedAt: new Date('2026-08-01T10:00:00.000Z'),
  sessionDate: new Date('2026-08-01T00:00:00.000Z'),
  ...over,
})

describe('reduceCountedLines', () => {
  it('keeps only the newest count per item per revenue centre', () => {
    const out = reduceCountedLines([
      line({ qtyBase: 4, countedAt: new Date('2026-07-01T10:00:00Z'), sessionDate: new Date('2026-07-01') }),
      line({ qtyBase: 9, countedAt: new Date('2026-08-01T10:00:00Z'), sessionDate: new Date('2026-08-01') }),
    ])
    expect(out.get('flour')!.qtyBase).toBe(9)
  })

  it('is order-independent — an older line arriving last does not win', () => {
    const out = reduceCountedLines([
      line({ qtyBase: 9, countedAt: new Date('2026-08-01T10:00:00Z'), sessionDate: new Date('2026-08-01') }),
      line({ qtyBase: 4, countedAt: new Date('2026-07-01T10:00:00Z'), sessionDate: new Date('2026-07-01') }),
    ])
    expect(out.get('flour')!.qtyBase).toBe(9)
  })

  // The whole point of the module: a CATERING count and a KITCHEN count of the same
  // item are two different piles of stock, not two readings of one pile.
  it('sums across revenue centres instead of letting the newest RC overwrite the rest', () => {
    const out = reduceCountedLines([
      line({ revenueCenterId: 'kitchen',  qtyBase: 100, countedAt: new Date('2026-08-01T10:00:00Z'), sessionDate: new Date('2026-08-01') }),
      line({ revenueCenterId: 'catering', qtyBase: 7,   countedAt: new Date('2026-07-01T10:00:00Z'), sessionDate: new Date('2026-07-01') }),
    ])
    expect(out.get('flour')!.qtyBase).toBe(107)
  })

  it('dates a multi-RC sum by its OLDEST contributing count, not its newest', () => {
    const out = reduceCountedLines([
      line({ revenueCenterId: 'kitchen',  countedAt: new Date('2026-08-01T10:00:00Z'), sessionDate: new Date('2026-08-01T00:00:00Z') }),
      line({ revenueCenterId: 'catering', countedAt: new Date('2026-07-01T10:00:00Z'), sessionDate: new Date('2026-07-01T00:00:00Z') }),
    ])
    // A sum is only as fresh as its stalest part — "Oldest Count" must say 1 July.
    expect(out.get('flour')!.date).toBe('2026-07-01T00:00:00.000Z')
  })

  it('keeps items separate', () => {
    const out = reduceCountedLines([
      line({ inventoryItemId: 'flour', qtyBase: 10 }),
      line({ inventoryItemId: 'sugar', qtyBase: 3 }),
    ])
    expect(out.get('flour')!.qtyBase).toBe(10)
    expect(out.get('sugar')!.qtyBase).toBe(3)
  })

  it('records a counted zero, and omits an item with no counted line at all', () => {
    const out = reduceCountedLines([line({ inventoryItemId: 'flour', qtyBase: 0 })])
    // Absent from the map = never counted here; present with 0 = counted and empty.
    expect(out.get('flour')!.qtyBase).toBe(0)
    expect(out.has('sugar')).toBe(false)
  })

  it('returns an empty map for no lines', () => {
    expect(reduceCountedLines([]).size).toBe(0)
  })
})
