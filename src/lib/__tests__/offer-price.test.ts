import { describe, it, expect } from 'vitest'
import { offerPricePerBase } from '@/lib/offer-price'

// COUNT item ('each') with a count↔weight bridge: 1 each ⟷ 0.4 lb.
const eggplant = { dimension: 'COUNT', baseUnit: 'each', eachMeasureQty: '0.4', eachMeasureUnit: 'lb', densityGPerMl: null }

describe('offerPricePerBase', () => {
  it('a PACK offer prices over its own chain, item irrelevant', () => {
    expect(offerPricePerBase({ packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 } }, eggplant)).toBeCloseTo(70.3 / 24)
  })

  it('a $/lb offer on a COUNT item prices through the item each-measure', () => {
    expect(offerPricePerBase({ packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' } }, eggplant)).toBeCloseTo(1.396, 3)
  })

  it('…and is UNPRICED when the item has no bridge', () => {
    expect(offerPricePerBase({ packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' } }, { ...eggplant, eachMeasureQty: null, eachMeasureUnit: null })).toBe(0)
  })

  it('no chain → 0, as before', () => {
    expect(offerPricePerBase({ packChain: null, pricing: { mode: 'PACK', purchasePrice: 5 } }, eggplant)).toBe(0)
  })

  it('a same-dimension RATE offer prices unchanged when dimension is omitted (derived from baseUnit)', () => {
    // A caller (e.g. InventoryMatch, which types `dimension` optional) that omits
    // dimension must not silently reintroduce the $0 bug: it is derived from
    // baseUnit. 'kg' on a MASS-baseUnit ('g') item is the same-dimension branch.
    const beef = { baseUnit: 'g', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
    const withDimension = offerPricePerBase({ packChain: [{ unit: 'kg', per: 1000 }], pricing: { mode: 'RATE', rate: 22, rateUnit: 'kg' } }, { ...beef, dimension: 'MASS' })
    const withoutDimension = offerPricePerBase({ packChain: [{ unit: 'kg', per: 1000 }], pricing: { mode: 'RATE', rate: 22, rateUnit: 'kg' } }, beef)
    expect(withoutDimension).toBeCloseTo(withDimension)
    expect(withoutDimension).toBeCloseTo(0.022)
  })
})
