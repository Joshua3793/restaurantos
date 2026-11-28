import { describe, it, expect } from 'vitest'
import { wasteUnits, wasteCost } from '@/components/wastage/units'
import { reasonLabel, isWasteReason } from '@/components/wastage/reasons'

const GOATS = { id: 'g', itemName: 'Goats Cheese', baseUnit: 'g', dimension: 'MASS', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null, pricePerBaseUnit: 0.0325 }
const LOAF = { id: 'l', itemName: 'Sourdough', baseUnit: 'each', dimension: 'COUNT', eachMeasureQty: '1100', eachMeasureUnit: 'g', densityGPerMl: null, pricePerBaseUnit: 6 }
const BUN = { ...LOAF, id: 'b', itemName: 'Bun', eachMeasureQty: null, eachMeasureUnit: null }

describe('waste form units + cost preview', () => {
  it('prices 2 kg as 2,000 g (the old preview read it as 2 g — 1000× low)', () => {
    expect(wasteCost(GOATS, 2, 'kg')).toBeCloseTo(65.0, 6)
    expect(wasteCost(GOATS, 500, 'g')).toBeCloseTo(16.25, 6)
  })
  it('prices a weight of a per-each item through its each-measure, and refuses one with none', () => {
    expect(wasteCost(LOAF, 550, 'g')).toBeCloseTo(3.0, 6)
    expect(wasteCost(BUN, 200, 'g')).toBeNull()
  })
  it('has no preview when the viewer has no price', () => {
    expect(wasteCost({ ...GOATS, pricePerBaseUnit: null }, 2, 'kg')).toBeNull()
  })
  it('offers only units the save can book — no batch on a raw item, no case on buns', () => {
    expect(wasteUnits(GOATS)).toEqual(['g', 'kg', 'lb', 'oz'])
    expect(wasteUnits(BUN)).toEqual(['each'])
    expect(wasteUnits(LOAF)).toEqual(['each', 'g', 'kg', 'lb', 'oz'])
  })
})

describe('waste reasons', () => {
  it('shows codes in plain words and accepts only known codes', () => {
    expect(reasonLabel('PREP_TRIM')).toBe('Trim')
    expect(reasonLabel('UNKNOWN')).toBe('Other')
    expect(reasonLabel('STAFF_MEAL')).toBe('Staff meal')
    expect(isWasteReason('COMP')).toBe(true)
    expect(isWasteReason('')).toBe(false)
  })
})
