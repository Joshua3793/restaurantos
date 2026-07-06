import { describe, it, expect } from 'vitest'
import {
  UNIT_FACTORS,
  canonicalUom,
  convertQty,
  convertQtyBridged,
  unitKind,
  isKnownUnit,
  assertKnownUnit,
  UnitError,
} from '@/lib/uom'

describe('canonicalUom', () => {
  it('collapses spelling variants onto canonical tokens', () => {
    expect(canonicalUom('GRAMS')).toBe('g')
    expect(canonicalUom('KGS')).toBe('kg')
    expect(canonicalUom('#')).toBe('lb')
    expect(canonicalUom('LT')).toBe('l')
    expect(canonicalUom('Litre')).toBe('l')
  })

  it('keeps distinct units within a dimension distinct', () => {
    expect(canonicalUom('g')).not.toBe(canonicalUom('kg'))
    expect(canonicalUom('ml')).not.toBe(canonicalUom('l'))
  })
})

describe('convertQty', () => {
  it('converts within weight', () => {
    expect(convertQty(1, 'kg', 'g')).toBe(1000)
    expect(convertQty(500, 'g', 'kg')).toBe(0.5)
    expect(convertQty(1, 'lb', 'g')).toBeCloseTo(453.592)
  })

  it('converts within volume', () => {
    expect(convertQty(2, 'l', 'ml')).toBe(2000)
    expect(convertQty(1, 'gal', 'ml')).toBeCloseTo(3785.41)
    expect(convertQty(1, 'cup', 'ml')).toBeCloseTo(236.588)
  })

  // Regression: the old divergent table silently passed mg/lt/gal through
  // unconverted — a latent 1000× cost error.
  it('handles the historically-dropped units (mg, lt, gal)', () => {
    expect(convertQty(1000, 'mg', 'g')).toBe(1)
    expect(convertQty(1, 'LT', 'ml')).toBe(1000)
    expect(convertQty(1, 'GAL', 'l')).toBeCloseTo(3.78541)
  })

  it('canonicalizes unit spellings before converting', () => {
    expect(convertQty(1, 'KILOGRAM', 'GRAMS')).toBe(1000)
  })

  it('converts count units (dozen = 12 fixed)', () => {
    expect(convertQty(1, 'dozen', 'each')).toBe(12)
    expect(convertQty(3, 'pcs', 'each')).toBe(3)
  })

  it('passes through unchanged across dimensions or unknown units', () => {
    expect(convertQty(5, 'kg', 'ml')).toBe(5)
    expect(convertQty(5, 'zzz', 'g')).toBe(5)
    expect(convertQty(5, '', 'g')).toBe(5)
  })
})

describe('convertQtyBridged', () => {
  const bridge = { qty: 1100, unit: 'g' } // 1 each = 1100 g

  it('delegates to convertQty within a dimension', () => {
    expect(convertQtyBridged(1, 'kg', 'g', bridge)).toBe(1000)
  })

  it('bridges count → measured', () => {
    expect(convertQtyBridged(2, 'each', 'g', bridge)).toBe(2200)
    expect(convertQtyBridged(2, 'each', 'kg', bridge)).toBeCloseTo(2.2)
  })

  it('bridges measured → count', () => {
    expect(convertQtyBridged(2200, 'g', 'each', bridge)).toBe(2)
    expect(convertQtyBridged(2.2, 'kg', 'each', bridge)).toBeCloseTo(2)
  })

  it('bridges weight ↔ volume through density (g/ml)', () => {
    expect(convertQtyBridged(500, 'g', 'ml', null, 0.92)).toBeCloseTo(500 / 0.92)
    expect(convertQtyBridged(1, 'l', 'kg', null, 0.92)).toBeCloseTo(0.92)
  })

  it('falls back to 1:1 passthrough cross-dimension without bridge or density', () => {
    expect(convertQtyBridged(500, 'g', 'ml')).toBe(500)
    expect(convertQtyBridged(3, 'each', 'g')).toBe(3)
  })
})

describe('unit knowledge', () => {
  it('classifies measurement, container, and unknown units', () => {
    expect(unitKind('kg')).toBe('measurement')
    expect(unitKind('case')).toBe('container')
    expect(unitKind('zzz')).toBe('unknown')
  })

  it('isKnownUnit / assertKnownUnit', () => {
    expect(isKnownUnit('ml')).toBe(true)
    expect(isKnownUnit('carton')).toBe(true)
    expect(isKnownUnit('florb')).toBe(false)
    expect(() => assertKnownUnit('florb', 'testField')).toThrow(UnitError)
    expect(assertKnownUnit('GRAMS')).toBe('g')
  })
})

describe('UNIT_FACTORS invariants', () => {
  it('every dimension has a factor-1 base unit', () => {
    expect(UNIT_FACTORS.g).toEqual({ dim: 'weight', toBase: 1 })
    expect(UNIT_FACTORS.ml).toEqual({ dim: 'volume', toBase: 1 })
    expect(UNIT_FACTORS.each).toEqual({ dim: 'count', toBase: 1 })
  })

  it('all factors are positive and finite', () => {
    for (const [unit, def] of Object.entries(UNIT_FACTORS)) {
      expect(def.toBase, unit).toBeGreaterThan(0)
      expect(Number.isFinite(def.toBase), unit).toBe(true)
    }
  })
})
