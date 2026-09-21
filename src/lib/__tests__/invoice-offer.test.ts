import { describe, it, expect } from 'vitest'
import { buildOffer, reconcileOffer, type OfferInput } from '@/lib/invoice/offer'
import type { ChainItem } from '@/lib/item-model'

// North Arm Farms eggplant: 12 lb @ $3.49/lb, $41.88. The item is counted in
// `each` and carries the bridge 1 each = 0.4 lb.
const eggplantLine: OfferInput = {
  pricingMode: 'per_weight', qtyShipped: 1, qtyShippedUOM: 'case',
  packQty: 1, packSize: 12, packUOM: 'lb',
  unitPrice: 41.88, rate: 3.49, rateUOM: 'lb',
  totalQty: 12, totalQtyUOM: 'lb', isCatchweight: false,
}
const eggplant: ChainItem = {
  dimension: 'COUNT', baseUnit: 'each', packChain: [{ unit: 'case', per: 24 }],
  pricing: { mode: 'PACK', purchasePrice: 33.5 }, countUnit: 'case',
  eachMeasure: { qty: 0.4, unit: 'lb' },
}

describe('reconcileOffer prices the draft WITH the matched item', () => {
  it('a bridged $/lb draft on a COUNT item is priced through the item’s each-measure', () => {
    // `opts.bridge` forces the draft's dimension to COUNT while its RATE stays
    // $/lb. Priced without the item's bridge that rate reads 0 → a bogus −100%
    // PRICE_DELTA on a line whose price barely moved.
    const draft = buildOffer(eggplantLine, { bridge: { qty: 0.4, unit: 'lb' } })
    expect(draft.dimension).toBe('COUNT')
    expect(draft.pricing).toEqual({ mode: 'RATE', rate: 3.49, rateUnit: 'lb' })

    const r = reconcileOffer(draft, eggplant)
    expect(r.newPpb).toBeCloseTo(1.396, 3)           // $3.49/lb × 0.4 lb per each
    expect(r.oldPpb).toBeCloseTo(33.5 / 24, 6)
    expect(r.deltaPct!).toBeLessThan(1)              // was −100
    expect(r.status).toBe('MATCH')
    expect(r.dimensionConflict).toBe(false)
  })

  it('…and is still UNPRICED when the item carries no bridge for that rate', () => {
    const draft = buildOffer(eggplantLine, { bridge: { qty: 0.4, unit: 'lb' } })
    const r = reconcileOffer(draft, { ...eggplant, eachMeasure: null })
    expect(r.newPpb).toBe(0)
  })

  it('a same-dimension PACK draft is untouched by the item’s bridges', () => {
    const caseLine: OfferInput = {
      pricingMode: 'per_case', qtyShipped: 2, qtyShippedUOM: 'case',
      packQty: 24, packSize: 1, packUOM: 'each',
      unitPrice: 33.5, rate: null, rateUOM: null,
      totalQty: null, totalQtyUOM: null, isCatchweight: false,
    }
    const r = reconcileOffer(buildOffer(caseLine), eggplant)
    expect(r.newPpb).toBeCloseTo(33.5 / 24, 6)
    expect(r.status).toBe('MATCH')
  })

  it('an unmatched draft still reports NEW, priced on its own', () => {
    const r = reconcileOffer(buildOffer(eggplantLine), null)
    expect(r.status).toBe('NEW')
    expect(r.oldPpb).toBeNull()
  })
})
