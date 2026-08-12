import { describe, it, expect } from 'vitest'
import {
  convertCountQtyToBase, countUomFactor, assertCountableUom, CountUomError,
  getCountableUoms, countEntriesToBase, lineCountedBase, lineConversionUnits,
} from '../count-uom'

/**
 * The peaches fixture, from the live row that produced a $1,575 phantom valuation:
 * MASS, base g, a SINGLE-link chain whose only level is the 20 lb case, and an
 * eachMeasure saying one peach is 150 g.
 *
 * The single link is what made this catastrophic: with one link, top === leaf, so
 * the old `each → leaf` fallback resolved "each" to the CASE. A count of "25 each"
 * stored 25 × 9,071.84 g = 226,796 g instead of 25 × 150 g = 3,750 g — 60.5× out,
 * and the item was carrying the correct 150 g figure the whole time.
 */
const peaches = {
  dimension: 'MASS',
  baseUnit: 'g',
  packChain: [{ unit: 'case', per: 9071.84 }],
  countUnit: 'kg',
  eachMeasureQty: 150,
  eachMeasureUnit: 'g',
}

/** Same item with no bridge declared — "each" then has no meaning at all. */
const peachesNoBridge = { ...peaches, eachMeasureQty: null, eachMeasureUnit: null }

/** A COUNT item whose only chain level is a 57-unit batch, base "each". */
const brioche = { dimension: 'COUNT', baseUnit: 'each', packChain: [{ unit: 'batch', per: 57 }], countUnit: 'each' }

describe('each on a measured item resolves through eachMeasure, never the pack', () => {
  it('uses the item\'s own "1 each = 150 g"', () => {
    expect(countUomFactor('each', peaches)).toBe(150)
    expect(convertCountQtyToBase(25, 'each', peaches)).toBe(3750)
  })

  it('does NOT resolve to the case, even though the chain has a single link', () => {
    // The regression guard: 25 × 9071.84 = 226796 was the stored value.
    expect(convertCountQtyToBase(25, 'each', peaches)).not.toBe(226796)
  })

  it('is unresolvable when the item declares no bridge', () => {
    expect(countUomFactor('each', peachesNoBridge)).toBeNull()
  })

  it('ignores a bridge whose unit is the wrong dimension', () => {
    expect(countUomFactor('each', { ...peaches, eachMeasureUnit: 'ml' })).toBeNull()
  })

  it('offers each in the count dropdown once the bridge exists, and not before', () => {
    const withBridge = getCountableUoms(peaches)
    const each = withBridge.find(o => o.label === 'each')
    expect(each).toBeDefined()
    expect(each!.toBase).toBe(150)
    expect(each!.display).toContain('150')
    expect(getCountableUoms(peachesNoBridge).map(o => o.label)).not.toContain('each')
  })

  it('still counts a COUNT item in its base each as single units', () => {
    // Step 0 must keep winning: "each" is brioche's BASE unit, so 1, not the batch.
    expect(countUomFactor('each', brioche)).toBe(1)
    expect(convertCountQtyToBase(30, 'each', brioche)).toBe(30)
  })
})

describe('a unit the item never defined is unresolvable, not a pack level', () => {
  // Every one of these was observed on a finalized count line in production.
  const cases: [string, Record<string, unknown>, number][] = [
    ['portion', brioche,          30],   // stored 30 × 57 = 1710 each ($2,560 of phantom stock)
    ['carton',  peaches,          8],
    ['tin',     peaches,          6],
  ]
  for (const [unit, item, qty] of cases) {
    it(`"${unit}" has no factor`, () => {
      expect(countUomFactor(unit, item as never)).toBeNull()
      // Readers degrade to a 1:1 passthrough — an under-read, never a pack-sized over-read.
      expect(convertCountQtyToBase(qty, unit, item as never)).toBe(qty)
    })
  }

  // "case" and "pack" name a pack LEVEL, so read paths keep mapping them onto one —
  // historical count lines have always been read that way and this change does not
  // restate them. Write paths still refuse both: the count sheet never offers them.
  it('keeps reading the legacy purchase words "case" and "pack" as pack levels', () => {
    expect(convertCountQtyToBase(1, 'pack', peaches)).toBe(9071.84)
    expect(convertCountQtyToBase(1, 'case', peaches)).toBe(9071.84)
    const twoLevel = { dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 12 }, { unit: 'kg', per: 1000 }], countUnit: 'kg' }
    expect(convertCountQtyToBase(1, 'case', twoLevel)).toBe(12000)   // outer
    expect(convertCountQtyToBase(1, 'pack', twoLevel)).toBe(1000)    // inner
  })

  it('refuses the legacy words at write time even though reads accept them', () => {
    expect(countUomFactor('pack', peaches)).toBeNull()
    expect(countUomFactor('case', peaches)).toBe(9071.84)  // 'case' IS this chain's level name
    const jugOnly = { dimension: 'VOLUME', baseUnit: 'ml', packChain: [{ unit: 'jug', per: 4000 }], countUnit: 'l' }
    expect(countUomFactor('pack', jugOnly)).toBeNull()
  })

  it('keeps "case" pointing at the outermost pack on read even under another name', () => {
    const jug = { dimension: 'VOLUME', baseUnit: 'ml', packChain: [{ unit: 'jug', per: 4000 }], countUnit: 'l' }
    expect(convertCountQtyToBase(1, 'case', jug)).toBe(4000)
  })

  it('resolves real chain levels and same-dimension measured units unchanged', () => {
    expect(countUomFactor('case', peaches)).toBe(9071.84)
    expect(countUomFactor('kg', peaches)).toBe(1000)
    expect(countUomFactor('g', peaches)).toBe(1)
    expect(countUomFactor('batch', brioche)).toBe(57)
  })
})

describe('assertCountableUom', () => {
  it('returns the factor for a unit the item can be counted in', () => {
    expect(assertCountableUom('kg', peaches)).toBe(1000)
    expect(assertCountableUom('each', peaches)).toBe(150)
  })

  it('throws CountUomError naming the valid units for one it cannot', () => {
    expect(() => assertCountableUom('portion', peaches)).toThrow(CountUomError)
    try {
      assertCountableUom('each', peachesNoBridge)
    } catch (e) {
      expect((e as Error).message).toContain('not a valid count unit')
      expect((e as Error).message).toMatch(/case|kg|lb|g/)
    }
  })
})

describe('mixed-unit and line-level conversion follow the same rule', () => {
  it('sums entries through the bridge', () => {
    expect(countEntriesToBase([{ unit: 'each', qty: 2 }, { unit: 'kg', qty: 1 }], peaches)).toBe(1300)
  })

  it('converts a stored line through the bridge', () => {
    expect(lineCountedBase({ countedQty: 25, selectedUom: 'each' }, peaches)).toBe(3750)
  })

  it('prefers entries over the single qty when present', () => {
    expect(lineCountedBase({ entries: [{ unit: 'each', qty: 4 }], countedQty: 25, selectedUom: 'each' }, peaches)).toBe(600)
  })
})

describe('countedQtyBase — the conversion frozen at entry time', () => {
  it('wins over re-deriving qty/uom through the chain', () => {
    // The chain says 25 each = 3,750 g today; the frozen base says 3,600 (the chain
    // was different when the count was entered). History must not restate.
    expect(lineCountedBase({ countedQty: 25, selectedUom: 'each', countedQtyBase: 3600 }, peaches)).toBe(3600)
  })

  it('wins over entries too', () => {
    expect(lineCountedBase({
      entries: [{ unit: 'each', qty: 4 }], countedQty: 600, selectedUom: 'g', countedQtyBase: 555,
    }, peaches)).toBe(555)
  })

  it('accepts a Prisma-Decimal-style stringifiable value', () => {
    expect(lineCountedBase({ countedQty: 25, selectedUom: 'each', countedQtyBase: '3600' as never }, peaches)).toBe(3600)
  })

  it('falls back to re-derivation when absent or null', () => {
    expect(lineCountedBase({ countedQty: 25, selectedUom: 'each', countedQtyBase: null }, peaches)).toBe(3750)
    expect(lineCountedBase({ countedQty: 25, selectedUom: 'each' }, peaches)).toBe(3750)
  })
})

describe('lineConversionUnits — what a finalize guard must validate', () => {
  it('is null for skipped, uncounted, and frozen-base lines (nothing converts)', () => {
    expect(lineConversionUnits({ skipped: true, countedQty: 5, selectedUom: 'portion' })).toBeNull()
    expect(lineConversionUnits({ countedQty: null, selectedUom: 'portion' })).toBeNull()
    // Frozen base: the stale unit label is inert — finalize must not block on it.
    expect(lineConversionUnits({ countedQty: 5, selectedUom: 'portion', countedQtyBase: 285 })).toBeNull()
  })

  it('returns the single selectedUom for a plain counted line', () => {
    expect(lineConversionUnits({ countedQty: 25, selectedUom: 'each' })).toEqual(['each'])
  })

  it('returns every entry unit when entries are present — NOT selectedUom', () => {
    // Entries lines store selectedUom = baseUnit (always valid); the real conversion
    // inputs are the entries' own units. Checking only selectedUom is the gap this
    // closes: a stale entry unit used to slip through the finalize guard and convert
    // 1:1 silently.
    const units = lineConversionUnits({
      countedQty: 1300, selectedUom: 'g',
      entries: [{ unit: 'each', qty: 2 }, { unit: 'kg', qty: 1 }],
    })
    expect(units).toEqual(['each', 'kg'])
    // And on the peaches-without-bridge item, that "each" entry is exactly what the
    // finalize guard must now catch:
    expect(units!.some(u => countUomFactor(u, peachesNoBridge) === null)).toBe(true)
  })
})
