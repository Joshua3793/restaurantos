import { describe, it, expect } from 'vitest'
import { isMeasureUnit, weightBasisRate } from '@/lib/invoice/approve-format'

const eggplant = { dimension: 'COUNT', baseUnit: 'each', eachMeasure: { qty: 0.4, unit: 'lb' }, densityGPerMl: null } as const

describe('isMeasureUnit', () => {
  it('keeps every token the old raw list accepted, and the plurals it missed', () => {
    for (const u of ['g', 'mg', 'kg', 'lb', 'oz', 'ml', 'cl', 'dl', 'l', 'lt', 'fl oz', 'tsp', 'tbsp', 'cup', 'gal', 'LB', 'LBS', 'KG'])
      expect(isMeasureUnit(u), u).toBe(true)
    for (const u of ['each', 'CS', 'case', '', null, undefined]) expect(isMeasureUnit(u), String(u)).toBe(false)
  })
})

describe('weightBasisRate', () => {
  it('refuses a per-case rate when there is no total to derive a per-weight one from', () => {
    const r = weightBasisRate({ rate: 41.88, rateUOM: 'CS', rawLineTotal: null, receivedBase: 30, rateUnit: 'lb', item: eggplant, fallback: 41.88 })
    expect(r).toEqual({ rate: 0, source: 'refused' })
  })
  it('does not trust a rate printed per a unit other than the one it is stored per', () => {
    const r = weightBasisRate({ rate: 3.49, rateUOM: 'kg', rawLineTotal: 41.88, receivedBase: 30, rateUnit: 'lb', item: eggplant, fallback: 3.49 })
    expect(r.source).toBe('derived')
    expect(r.rate).toBeCloseTo(3.49, 2)
  })
  it("trusts 'LBS' stored per lb", () => {
    expect(weightBasisRate({ rate: 3.49, rateUOM: 'LBS', rawLineTotal: 41.88, receivedBase: 30, rateUnit: 'lb', item: eggplant, fallback: 0 }))
      .toEqual({ rate: 3.49, source: 'printed' })
  })
})
