import { describe, it, expect } from 'vitest'
import { offerPricePerBase, primaryOfferPpb } from '@/lib/offer-price'

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

// The number syncPrimaryOfferToItem writes onto the item. It hand-built a
// ChainItem from the OFFER with no bridges, so a bridged $/lb primary priced as
// 0 — and the function's own "never write a zero ppb" guard then made the sync a
// PERMANENT SILENT NO-OP (the item would keep its stale price for ever).
describe('primaryOfferPpb — the spine a primary offer would write', () => {
  it('a bridged $/lb primary on a COUNT item prices through the item each-measure, not 0', () => {
    expect(primaryOfferPpb({ packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' } }, eggplant))
      .toBeCloseTo(1.396, 3)
  })

  it('a PACK primary is untouched — the chain is the only denominator', () => {
    expect(primaryOfferPpb({ packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 } }, eggplant))
      .toBeCloseTo(70.3 / 24)
  })

  it('still 0 (→ no write) when the item carries no bridge for the rate', () => {
    expect(primaryOfferPpb({ packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' } }, { ...eggplant, eachMeasureQty: null, eachMeasureUnit: null }))
      .toBe(0)
  })

  it('an offer row with a present-but-empty chain keeps today’s behaviour (PACK → 0, RATE → priced)', () => {
    // Deliberately NOT offerPricePerBase's "no chain ⇒ unpriced": this function
    // stands in for the pre-existing spine formula, which only ever refuses a
    // non-positive ppb. Changing it here would change a stored number.
    expect(primaryOfferPpb({ packChain: [], pricing: { mode: 'PACK', purchasePrice: 70.3 } }, eggplant)).toBeCloseTo(70.3)
    expect(primaryOfferPpb({ packChain: [], pricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' } }, eggplant)).toBeCloseTo(1.396, 3)
  })
})
