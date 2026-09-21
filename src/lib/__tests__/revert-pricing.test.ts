import { describe, it, expect } from 'vitest'
import { revertedPricing } from '@/lib/invoice/revert-pricing'
import { asChainItem, pricePerBaseUnit } from '@/lib/item-model'

// Cilantro FARM: counted in `each`, 1 each = 0.3 lb, one "case" holds 1 each.
// Before the weight-basis approve it was PACK $4.99; approve wrote RATE $15.98/lb
// (= $4.794/each). previousPrice on the scan line is the PRE-approve $4.99.
const cilantroAfterWeightApprove = {
  dimension: 'COUNT',
  baseUnit: 'each',
  packChain: [{ unit: 'case', per: 1 }],
  pricing: { mode: 'RATE', rate: 15.98, rateUnit: 'lb' },
  eachMeasureQty: 0.3,
  eachMeasureUnit: 'lb',
}
const ppbOf = (row: Record<string, unknown>, pricing: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pricePerBaseUnit({ ...asChainItem(row as any), pricing: pricing as any })

describe('revertedPricing — a rollback must restore the price the item actually had', () => {
  it('a PACK-priced item rolls back to its pack price (unchanged)', () => {
    const got = revertedPricing({
      previousPrice: 112.83,
      item: { dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 20000 }], pricing: { mode: 'PACK', purchasePrice: 120 } },
    })
    expect(got.pricing).toEqual({ mode: 'PACK', purchasePrice: 112.83 })
    expect(got.purchasePrice).toBe(112.83)
    expect(got.basis).toBe('pack')
  })

  it('bison: a rate in the item’s OWN dimension keeps the rate shape (unchanged)', () => {
    const got = revertedPricing({
      previousPrice: 41.0,
      item: { dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'RATE', rate: 42.5, rateUnit: 'kg' } },
    })
    expect(got.pricing).toEqual({ mode: 'RATE', rate: 41.0, rateUnit: 'kg' })
    expect(got.basis).toBe('rate-same-dimension')
  })

  it('an item whose dimension is unknown is NOT treated as cross-dimension', () => {
    const got = revertedPricing({
      previousPrice: 7,
      // no dimension, no baseUnit to derive one from → the old same-dimension behaviour
      item: { dimension: null, baseUnit: null, packChain: [{ unit: 'case', per: 6 }], pricing: { mode: 'RATE', rate: 9, rateUnit: 'kg' } },
    })
    expect(got.pricing).toEqual({ mode: 'RATE', rate: 7, rateUnit: 'kg' })
  })

  it('Cilantro: a $/lb rate on an `each` item rolls back to the PACK price previousPrice holds', () => {
    // No PriceAlert (the move was −3.9 %), so the item's CURRENT $/each ($4.794)
    // bounds where the old one sat: the pack reading ($4.99) lands there, the
    // rate reading ($1.497) is out by the bridge factor.
    const got = revertedPricing({ previousPrice: 4.99, item: cilantroAfterWeightApprove })
    expect(got.pricing).toEqual({ mode: 'PACK', purchasePrice: 4.99 })
    expect(ppbOf(cilantroAfterWeightApprove, got.pricing)).toBeCloseTo(4.99, 6)
    expect(ppbOf(cilantroAfterWeightApprove, { mode: 'RATE', rate: 4.99, rateUnit: 'lb' })).toBeCloseTo(1.497, 6)
    expect(got.basis).toBe('cross-rate-nearest-pack')
  })

  it('a SECOND weight invoice with no alert: only the RATE reading is a plausible price', () => {
    // The item already carried RATE $15.50/lb ($4.65/each) and the invoice moved
    // it to $15.98/lb ($4.794/each) — under 15 %, so no alert was written. The
    // pack reading would be $15.50/each, 3.2× the price the item has now.
    const got = revertedPricing({ previousPrice: 15.5, item: cilantroAfterWeightApprove })
    expect(got.pricing).toEqual({ mode: 'RATE', rate: 15.5, rateUnit: 'lb' })
    expect(ppbOf(cilantroAfterWeightApprove, got.pricing)).toBeCloseTo(4.65, 6)
    expect(got.basis).toBe('cross-rate-nearest-rate')
  })

  it('neither reading is a plausible price → the pack price, and say so', () => {
    // previousPrice came off a supplier offer on a third basis ($40/case of 8).
    const got = revertedPricing({ previousPrice: 40, item: cilantroAfterWeightApprove })
    expect(got.pricing).toEqual({ mode: 'PACK', purchasePrice: 40 })
    expect(got.basis).toBe('cross-rate-assumed-pack')
  })

  it('the session’s PriceAlert proves a PACK pre-state', () => {
    const got = revertedPricing({ previousPrice: 4.99, item: cilantroAfterWeightApprove, priorPpb: 4.99 })
    expect(got.pricing).toEqual({ mode: 'PACK', purchasePrice: 4.99 })
    expect(got.basis).toBe('cross-rate-proven-pack')
  })

  it('a SECOND weight invoice, alert present: the PriceAlert proves the same rate shape', () => {
    // The previous approve had already written RATE $15.50/lb = $4.65/each.
    const got = revertedPricing({ previousPrice: 15.5, item: cilantroAfterWeightApprove, priorPpb: 15.5 * 0.3 })
    expect(got.pricing).toEqual({ mode: 'RATE', rate: 15.5, rateUnit: 'lb' })
    expect(ppbOf(cilantroAfterWeightApprove, got.pricing)).toBeCloseTo(4.65, 6)
    expect(got.basis).toBe('cross-rate-proven-rate')
  })

  it('previousPrice came from an OFFER on a third basis → restore the proven $/base exactly', () => {
    // previousPrice is this supplier's last offer price ($6.20/case of 4), which
    // reproduces neither candidate — but the alert froze the item's real $/each.
    const got = revertedPricing({ previousPrice: 6.2, item: cilantroAfterWeightApprove, priorPpb: 4.99 })
    expect(got.basis).toBe('cross-rate-restored-ppb')
    expect(ppbOf(cilantroAfterWeightApprove, got.pricing)).toBeCloseTo(4.99, 6)
  })

  it('a cross-dimension rate with no chain to divide and no proof still writes the pack price', () => {
    const got = revertedPricing({
      previousPrice: 4.99,
      item: { ...cilantroAfterWeightApprove, packChain: [] },
    })
    expect(got.pricing).toEqual({ mode: 'PACK', purchasePrice: 4.99 })
  })
})
