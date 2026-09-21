import { describe, it, expect } from 'vitest'
import { offerPriceLabel, offerDerivation } from '@/lib/invoice/offer-copy'

const lettuce = { baseUnit: 'each', eachMeasureQty: '250', eachMeasureUnit: 'g' }

describe('offerPriceLabel', () => {
  it('labels a RATE offer with its real unit and a PACK offer per case', () => {
    expect(offerPriceLabel({ lastPrice: 5.25, pricing: { mode: 'RATE', rate: 5.25, rateUnit: 'lb' } })).toBe('$5.25/lb')
    expect(offerPriceLabel({ lastPrice: 46.4, pricing: { mode: 'PACK', purchasePrice: 46.4 } })).toBe('$46.40/case')
  })
})

describe('offerDerivation', () => {
  it('explains a bridged price, and says why an unbridged one is unpriced', () => {
    expect(offerDerivation({ pricing: { mode: 'RATE', rate: 5.25, rateUnit: 'lb' } }, lettuce, 2.894)).toBe('$5.25/lb × 250 g each = $2.89/each')
    expect(offerDerivation({ pricing: { mode: 'RATE', rate: 5.25, rateUnit: 'lb' } }, { baseUnit: 'each', eachMeasureQty: null, eachMeasureUnit: null }, 0))
      .toBe('Unpriced — add a weight per each to this item')
    expect(offerDerivation({ pricing: { mode: 'PACK', purchasePrice: 46.4 } }, lettuce, 1.93)).toBe(null)
    expect(offerDerivation({ pricing: { mode: 'RATE', rate: 25, rateUnit: 'kg' } }, { baseUnit: 'g' }, 0.025)).toBe(null) // same dimension: nothing to explain
  })
})

it('shows a raw scanner unit token canonically', () => {
  expect(offerPriceLabel({ lastPrice: 5.25, pricing: { mode: 'RATE', rate: 5.25, rateUnit: 'LB' } })).toBe('$5.25/lb')
})
