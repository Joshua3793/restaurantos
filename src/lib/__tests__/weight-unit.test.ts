import { describe, it, expect } from 'vitest'
import type { ChainItem, Pricing } from '@/lib/item-model'
import { weightUnitFor, assumedUnitNote } from '@/lib/invoice/weight-unit'
import { freezeFormat } from '@/lib/invoice/approve-format'
import { lineReceivedBaseUnits } from '@/lib/invoice/line-qty'

const KG_BOX: Pricing = { mode: 'RATE', rate: 25, rateUnit: 'kg' }
const PACK_BOX: Pricing = { mode: 'PACK', purchasePrice: 120 }

// Cleveland Meats' bison: "15.775 @ $25" — no unit anywhere on the line.
const bison = {
  rateUOM: null, totalQtyUOM: null, rawUnit: null,
  pricedByWeight: false,
  boxPricing: KG_BOX,
  item: { countUnit: 'kg', baseUnit: 'g' },
}

describe('weightUnitFor', () => {
  it('bison: a unit-less weight is read in the unit the box is priced in (was g)', () => {
    expect(weightUnitFor(bison)).toEqual({ unit: 'kg', source: 'box', assumed: true })
  })

  it('a PACK box falls through to a weight count unit', () => {
    expect(weightUnitFor({ ...bison, boxPricing: PACK_BOX }))
      .toEqual({ unit: 'kg', source: 'count-unit', assumed: true })
  })

  it('no box and a non-weight count unit falls through to a weight base unit', () => {
    expect(weightUnitFor({ ...bison, boxPricing: PACK_BOX, item: { countUnit: 'case', baseUnit: 'g' } }))
      .toEqual({ unit: 'g', source: 'base-unit', assumed: true })
  })

  it('nothing measured anywhere → kg, flagged as a fallback', () => {
    expect(weightUnitFor({ ...bison, boxPricing: PACK_BOX, item: { countUnit: 'each', baseUnit: 'each' } }))
      .toEqual({ unit: 'kg', source: 'fallback', assumed: true })
    expect(weightUnitFor({ ...bison, boxPricing: null, item: { countUnit: null, baseUnit: null } }))
      .toEqual({ unit: 'kg', source: 'fallback', assumed: true })
  })

  it('a printed rate unit wins over a kg box, canonicalised', () => {
    expect(weightUnitFor({ ...bison, rateUOM: 'LBS' }))
      .toEqual({ unit: 'lb', source: 'line-rate', assumed: false })
  })

  it('a line received by weight uses its own weight unit', () => {
    expect(weightUnitFor({ ...bison, pricedByWeight: true, totalQtyUOM: 'KG', boxPricing: { mode: 'RATE', rate: 9, rateUnit: 'lb' } }))
      .toEqual({ unit: 'kg', source: 'line-weight', assumed: false })
    expect(weightUnitFor({ ...bison, pricedByWeight: true, rawUnit: 'lb' }))
      .toEqual({ unit: 'lb', source: 'line-weight', assumed: false })
  })

  it('a weight column on a line NOT received by weight is not proof — the box decides', () => {
    expect(weightUnitFor({ ...bison, totalQtyUOM: 'kg', rawUnit: 'lb' }))
      .toEqual({ unit: 'kg', source: 'box', assumed: true })
  })

  it('a $/lb box on an each item (bridged) → lb', () => {
    expect(weightUnitFor({
      ...bison,
      boxPricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' },
      item: { countUnit: 'each', baseUnit: 'each' },
    })).toEqual({ unit: 'lb', source: 'box', assumed: true })
  })

  it('a box priced per each is not a measure — skipped', () => {
    expect(weightUnitFor({
      ...bison,
      boxPricing: { mode: 'RATE', rate: 1.2, rateUnit: 'each' },
      item: { countUnit: 'case', baseUnit: 'g' },
    })).toEqual({ unit: 'g', source: 'base-unit', assumed: true })
  })

  it('a non-measure printed rate unit (CS) does not count as a line rate', () => {
    expect(weightUnitFor({ ...bison, rateUOM: 'CS' }))
      .toEqual({ unit: 'kg', source: 'box', assumed: true })
  })
})

describe('the receipt agrees with the price (approve freezes through the written RATE)', () => {
  it('bison 15.775 @ $25 with no unit → $25/kg and 15,775 g received (was 15.775 g)', () => {
    const speaks: ChainItem = {
      dimension: 'MASS', baseUnit: 'g', countUnit: 'kg',
      packChain: [{ unit: 'kg', per: 1000 }],
      pricing: KG_BOX,
    }
    const line = { rawQty: 15.775, rawUnit: null, totalQty: 15.775, totalQtyUOM: null, rateUOM: null, rate: 25, rawUnitPrice: 25, rawLineTotal: 394.38 }
    const w = weightUnitFor({ ...bison, boxPricing: speaks.pricing })
    const written: Pricing = { mode: 'RATE', rate: 25, rateUnit: w.unit }
    expect(lineReceivedBaseUnits(line, freezeFormat(speaks, written))).toBeCloseTo(15775, 6)
  })
})

describe('assumedUnitNote', () => {
  const ctx = { supplierName: 'Cleveland Meats', itemName: 'bison burger' }

  it('box', () => {
    expect(assumedUnitNote(weightUnitFor(bison), ctx))
      .toBe("assumed kg — the invoice shows no unit; Cleveland Meats' box is priced per kg")
  })

  it('box with no supplier name still reads', () => {
    expect(assumedUnitNote(weightUnitFor(bison), { ...ctx, supplierName: null }))
      .toBe("assumed kg — the invoice shows no unit; the supplier's box is priced per kg")
  })

  it("box from the MAIN supplier (this supplier has no box) says so — never this supplier's name", () => {
    expect(assumedUnitNote(weightUnitFor(bison), { ...ctx, boxIsSuppliers: false }))
      .toBe("assumed kg — the invoice shows no unit; the main supplier's box is priced per kg")
  })

  it("box: a name not ending in s takes 's", () => {
    expect(assumedUnitNote(weightUnitFor(bison), { ...ctx, supplierName: 'Gordon' }))
      .toBe("assumed kg — the invoice shows no unit; Gordon's box is priced per kg")
  })

  it('count-unit', () => {
    expect(assumedUnitNote(weightUnitFor({ ...bison, boxPricing: PACK_BOX }), ctx))
      .toBe('assumed kg — the invoice shows no unit; bison burger is counted in kg')
  })

  it('base-unit', () => {
    expect(assumedUnitNote(weightUnitFor({ ...bison, boxPricing: PACK_BOX, item: { countUnit: 'case', baseUnit: 'g' } }), ctx))
      .toBe('assumed g — the invoice shows no unit')
  })

  it('fallback', () => {
    expect(assumedUnitNote(weightUnitFor({ ...bison, boxPricing: null, item: { countUnit: 'each', baseUnit: 'each' } }), ctx))
      .toBe('assumed kg — the invoice shows no unit. Check it.')
  })

  it('null when the line states its own unit', () => {
    expect(assumedUnitNote(weightUnitFor({ ...bison, rateUOM: 'lb' }), ctx)).toBeNull()
    expect(assumedUnitNote(weightUnitFor({ ...bison, pricedByWeight: true, totalQtyUOM: 'kg' }), ctx)).toBeNull()
    expect(assumedUnitNote(weightUnitFor({ ...bison, pricedByWeight: true, rawUnit: 'kg' }), ctx)).toBeNull()
  })
})
