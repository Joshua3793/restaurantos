import { describe, it, expect } from 'vitest'
import { matchesPill, isCountedThisWeek, type PillItem } from '../inventory-pills'
import { resolveCountUom } from '../count-uom'

const NOW = new Date('2026-08-11T12:00:00.000Z')

const item = (over: Partial<PillItem> = {}): PillItem => ({
  lastCountDate: '2026-08-09T00:00:00.000Z',
  pricePerBaseUnit: 5,
  theoreticalStock: 10,
  stockOnHand: 10,
  parLevel: null,
  baseUnit: 'g',
  countUnit: 'g',
  dimension: 'MASS',
  packChain: [],
  ...over,
})

describe('isCountedThisWeek', () => {
  it('is true within 7 days', () => {
    expect(isCountedThisWeek(item({ lastCountDate: '2026-08-09T00:00:00.000Z' }), NOW)).toBe(true)
  })

  it('is false beyond 7 days', () => {
    expect(isCountedThisWeek(item({ lastCountDate: '2026-07-01T00:00:00.000Z' }), NOW)).toBe(false)
  })

  it('is false when never counted', () => {
    expect(isCountedThisWeek(item({ lastCountDate: null }), NOW)).toBe(false)
  })
})

describe('matchesPill', () => {
  it('all matches everything', () => {
    expect(matchesPill('all', item({ lastCountDate: null }), NOW)).toBe(true)
  })

  it('counted / notCounted are complements', () => {
    const fresh = item({ lastCountDate: '2026-08-10T00:00:00.000Z' })
    const stale = item({ lastCountDate: '2026-06-01T00:00:00.000Z' })
    expect(matchesPill('counted', fresh, NOW)).toBe(true)
    expect(matchesPill('notCounted', fresh, NOW)).toBe(false)
    expect(matchesPill('counted', stale, NOW)).toBe(false)
    expect(matchesPill('notCounted', stale, NOW)).toBe(true)
  })

  it('highValue needs a price above a cent per base unit', () => {
    expect(matchesPill('highValue', item({ pricePerBaseUnit: 0.5 }), NOW)).toBe(true)
    expect(matchesPill('highValue', item({ pricePerBaseUnit: 0.001 }), NOW)).toBe(false)
  })

  it('outOfStock reads theoretical stock, not the counted quantity', () => {
    expect(matchesPill('outOfStock', item({ theoreticalStock: 0 }), NOW)).toBe(true)
    expect(matchesPill('outOfStock', item({ theoreticalStock: -2 }), NOW)).toBe(true)
    expect(matchesPill('outOfStock', item({ theoreticalStock: 3 }), NOW)).toBe(false)
  })

  it('effStock uses rcStock when theoreticalStock is null', () => {
    // When theoreticalStock is null, rcStock should be used
    expect(matchesPill('outOfStock', item({ theoreticalStock: null, rcStock: 7 }), NOW)).toBe(false)
    expect(matchesPill('outOfStock', item({ theoreticalStock: null, rcStock: 0 }), NOW)).toBe(true)
  })

  it('effStock uses theoreticalStock over rcStock', () => {
    // When both are present, theoreticalStock wins
    expect(matchesPill('outOfStock', item({ theoreticalStock: 5, rcStock: 0 }), NOW)).toBe(false)
  })

  it('effStock falls back to stockOnHand when both theoretical and rcStock are null', () => {
    // The full fallback chain: theoretical -> rcStock -> stockOnHand
    expect(matchesPill('outOfStock', item({ theoreticalStock: null, rcStock: null, stockOnHand: 0 }), NOW)).toBe(true)
    expect(matchesPill('outOfStock', item({ theoreticalStock: null, rcStock: null, stockOnHand: 5 }), NOW)).toBe(false)
  })

  it('lowStock compares against par in COUNT units', () => {
    // 500 g theoretical, par 1 kg → count unit kg → 0.5 < 1 → low
    const low = item({
      theoreticalStock: 500, baseUnit: 'g', countUnit: 'kg',
      dimension: 'MASS', packChain: [], parLevel: 1,
    })
    expect(matchesPill('lowStock', low, NOW)).toBe(true)
  })

  it('lowStock excludes items at or below zero (those are outOfStock)', () => {
    expect(matchesPill('lowStock', item({ theoreticalStock: 0, parLevel: 5 }), NOW)).toBe(false)
  })

  it('lowStock is false with no par set', () => {
    expect(matchesPill('lowStock', item({ theoreticalStock: 1, parLevel: null }), NOW)).toBe(false)
  })

  it('lowStock works when parLevel arrives as a numeric string', () => {
    // 500 g theoretical, par '1' (as string) kg → count unit kg → 0.5 < 1 → low.
    // Note: JS `<` already coerces a numeric string numerically, so this case alone
    // does not distinguish num(item.parLevel) from a bare item.parLevel comparison —
    // see the non-finite-string test below for that.
    const low = item({
      theoreticalStock: 500, baseUnit: 'g', countUnit: 'kg',
      dimension: 'MASS', packChain: [], parLevel: '1' as any,
    })
    expect(matchesPill('lowStock', low, NOW)).toBe(true)
  })

  it('lowStock treats a non-finite parLevel string as unset, unlike bare `<` coercion', () => {
    // num() maps a non-finite numeric string like 'Infinity' to 0 (isFinite guard), so a
    // well-stocked item is never "low". A bare `item.parLevel` comparison would instead
    // let `<` coerce 'Infinity' to the numeric Infinity, making ANY in-stock quantity
    // compare as "low" (qty < Infinity is always true) — the divergent case that proves
    // num(item.parLevel) is load-bearing, not merely defensive.
    const wellStocked = item({
      theoreticalStock: 500, baseUnit: 'g', countUnit: 'g',
      dimension: 'MASS', packChain: [], parLevel: 'Infinity' as any,
    })
    expect(matchesPill('lowStock', wellStocked, NOW)).toBe(false)
  })
})

/**
 * The STORED countUnit is not what the app filters on: /inventory rewrites every row's
 * countUnit through resolveCountUom the moment the list lands (normalizeItem), so the
 * xlsx export has to do the same before it applies matchesPill. The lowStock predicate
 * converts theoretical stock into count units to compare it against par, which makes the
 * unit load-bearing on the ROW SET, not only on the displayed label.
 */
describe('lowStock over a raw vs resolved countUnit', () => {
  // A 12 × 1 kg case of flour: MASS, base g, real multi-link chain, par 20 (count units).
  const flour = (countUnit: string): PillItem => ({
    lastCountDate: null,
    pricePerBaseUnit: 0.004,
    theoreticalStock: 12500,
    stockOnHand: 12500,
    parLevel: 20,
    baseUnit: 'g',
    dimension: 'MASS',
    packChain: [{ unit: 'case', per: 12 }, { unit: 'kg', per: 1000 }],
    countUnit,
  })

  const dims = (i: PillItem) => ({
    dimension: i.dimension, baseUnit: i.baseUnit,
    packChain: i.packChain, countUnit: i.countUnit ?? undefined,
  })

  it('resolves the schema default "each" on a MASS item to the chain leaf', () => {
    // InventoryItem.countUnit is String @default("each"), so a MASS item that never had
    // one set stores "each" — the screen shows kg. The verdict happens to survive here
    // because the generic "each" label falls through to the chain leaf inside
    // resolveUnitBase, so this pair pins the label fix without claiming a row-set change.
    const raw = flour('each')
    const resolved = resolveCountUom(dims(raw))
    expect(resolved).toBe('kg')
    expect(matchesPill('lowStock', raw, NOW)).toBe(true)                          // 12.5 < 20
    expect(matchesPill('lowStock', { ...raw, countUnit: resolved }, NOW)).toBe(true)
  })

  it('selects a different row set when an unresolvable stored unit is not resolved first', () => {
    // A stored unit the chain cannot resolve — an empty string, or a cross-dimension
    // leftover like 'ml' on a MASS item — measures in BASE units on the raw path:
    // 12,500 > par 20 → not low, while the screen measures 12.5 kg < 20 → low.
    for (const stored of ['', 'ml']) {
      const raw = flour(stored)
      const resolved = resolveCountUom(dims(raw))
      expect(resolved).toBe('kg')
      expect(matchesPill('lowStock', raw, NOW)).toBe(false)
      expect(matchesPill('lowStock', { ...raw, countUnit: resolved }, NOW)).toBe(true)
    }
  })
})
