import { describe, it, expect } from 'vitest'
import { carryPricingMode } from '@/lib/pricing-mode'
import type { Pricing } from '@/lib/item-model'

// Flipping "Per pack" ⇄ "Per unit (rate)" used to zero the price, so a slip of
// the finger on the drawer saved a $0 item. The number now carries across.
describe('carryPricingMode', () => {
  it('PACK $50 → RATE 50 per the first unit of the dimension', () => {
    const p: Pricing = { mode: 'PACK', purchasePrice: 50 }
    expect(carryPricingMode(p, 'RATE', 'MASS')).toEqual({ mode: 'RATE', rate: 50, rateUnit: 'g' })
    expect(carryPricingMode(p, 'RATE', 'VOLUME')).toEqual({ mode: 'RATE', rate: 50, rateUnit: 'ml' })
    expect(carryPricingMode(p, 'RATE', 'COUNT')).toEqual({ mode: 'RATE', rate: 50, rateUnit: 'each' })
  })

  it('RATE $3.49/lb → PACK $3.49', () => {
    const p: Pricing = { mode: 'RATE', rate: 3.49, rateUnit: 'lb' }
    expect(carryPricingMode(p, 'PACK', 'MASS')).toEqual({ mode: 'PACK', purchasePrice: 3.49 })
  })

  it('same mode is a no-op (returns the pricing unchanged)', () => {
    const p: Pricing = { mode: 'RATE', rate: 3.49, rateUnit: 'lb' }
    expect(carryPricingMode(p, 'RATE', 'MASS')).toBe(p)
  })

  it('a missing / non-finite number carries as 0', () => {
    const p = { mode: 'PACK', purchasePrice: NaN } as Pricing
    expect(carryPricingMode(p, 'RATE', 'MASS')).toEqual({ mode: 'RATE', rate: 0, rateUnit: 'g' })
  })
})
