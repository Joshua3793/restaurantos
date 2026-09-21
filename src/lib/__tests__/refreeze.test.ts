import { describe, it, expect } from 'vitest'
import { cloneShare, isMaterialChange } from '@/lib/invoice/refreeze'

describe('cloneShare', () => {
  it('is the clone/parent ratio when both totals are finite and positive', () => {
    expect(cloneShare(100, 25)).toBe(0.25)
    expect(cloneShare('100', '25')).toBe(0.25)
    expect(cloneShare(10, 10)).toBe(1)
  })

  it('is null when either total is missing, zero, negative, or non-finite', () => {
    expect(cloneShare(0, 25)).toBeNull()
    expect(cloneShare(100, 0)).toBeNull()
    expect(cloneShare(-5, 25)).toBeNull()
    expect(cloneShare(100, -1)).toBeNull()
    expect(cloneShare(null, 25)).toBeNull()
    expect(cloneShare(100, null)).toBeNull()
    expect(cloneShare(undefined, undefined)).toBeNull()
    expect(cloneShare(NaN, 25)).toBeNull()
    expect(cloneShare(100, Infinity)).toBeNull()
    expect(cloneShare('abc', 25)).toBeNull()
  })
})

describe('isMaterialChange', () => {
  it('flags a change bigger than the 0.5% / 0.001 floor', () => {
    expect(isMaterialChange(100, 100.6)).toBe(true)   // 0.6% of 100
    expect(isMaterialChange(100, 99.4)).toBe(true)
    expect(isMaterialChange(1, 1.006)).toBe(true)     // 0.5% of 1 = 0.005; diff .006 > .005
  })

  it('is not material within the tolerance', () => {
    expect(isMaterialChange(100, 100.4)).toBe(false)  // 0.4% of 100 = 0.4 < 0.5
    expect(isMaterialChange(1, 1.0005)).toBe(false)   // below the 0.001 floor
    expect(isMaterialChange(0, 0)).toBe(false)
  })

  it('prev 0 and next > 0 is always a change, however small', () => {
    expect(isMaterialChange(0, 0.0000001)).toBe(true)
    expect(isMaterialChange(0, 5)).toBe(true)
  })

  it('prev 0 and next 0 (or negative) is not a change', () => {
    expect(isMaterialChange(0, 0)).toBe(false)
    expect(isMaterialChange(0, -1)).toBe(false)
  })

  it('uses the floor of 0.001 for small prev values', () => {
    expect(isMaterialChange(0.01, 0.0115)).toBe(true)  // diff .0015 > max(.001, .00005) = .001
    expect(isMaterialChange(0.01, 0.0105)).toBe(false) // diff .0005 < .001 floor
  })
})
