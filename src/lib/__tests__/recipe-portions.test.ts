import { describe, it, expect } from 'vitest'
import { portionsPerBatch } from '@/lib/recipe-portions'

describe('portionsPerBatch', () => {
  it('divides directly when portion and yield share a unit', () => {
    expect(portionsPerBatch(1000, 'g', 250, 'g')).toBeCloseTo(4)
  })

  it('converts the portion into the yield unit first (kg yield, g portion)', () => {
    expect(portionsPerBatch(3, 'kg', 40, 'g')).toBeCloseTo(75) // NOT 0.075
  })

  it('converts the other way too (g yield, kg portion)', () => {
    expect(portionsPerBatch(9000, 'g', 1, 'kg')).toBeCloseTo(9)
  })

  it('handles volume units (l yield, ml portion)', () => {
    expect(portionsPerBatch(2, 'l', 250, 'ml')).toBeCloseTo(8)
  })

  it('falls back to the yield unit when portionUnit is null or empty', () => {
    expect(portionsPerBatch(1000, 'g', 250, null)).toBeCloseTo(4)
    expect(portionsPerBatch(1000, 'g', 250, '')).toBeCloseTo(4)
  })

  it('passes cross-dimension portion units through 1:1 (app convention)', () => {
    expect(portionsPerBatch(12, 'each', 2, 'each')).toBeCloseTo(6)
    expect(portionsPerBatch(10, 'portion', 1, 'portion')).toBeCloseTo(10)
  })

  it('returns null for missing or non-positive inputs', () => {
    expect(portionsPerBatch(1000, 'g', null, 'g')).toBeNull()
    expect(portionsPerBatch(1000, 'g', 0, 'g')).toBeNull()
    expect(portionsPerBatch(0, 'g', 250, 'g')).toBeNull()
    expect(portionsPerBatch(1000, 'g', undefined, undefined)).toBeNull()
  })

  it('accepts Prisma Decimal-ish string portion sizes', () => {
    expect(portionsPerBatch(3, 'kg', '40' as unknown as number, 'g')).toBeCloseTo(75)
  })
})
