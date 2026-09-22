import { describe, it, expect } from 'vitest'
import { lineMeasureUnit, isByWeightLine, seedFromScanLine, validateCreateNew, CREATE_NEW_COUNT_NEEDS_EACH } from '@/lib/invoice/create-new-seed'
import { formToChain } from '@/lib/item-model-form'

// The four real lines (read-only dump 2026-09-22)
const kennebec = { pricingMode: 'per_weight', rawUnit: 'lb', totalQtyUOM: 'lb', rateUOM: 'lb', rate: '1.99', rawUnitPrice: '1.99', invoicePackQty: null, invoicePackSize: null, invoicePackUOM: null }
const salami   = { ...kennebec, rate: '22.08', rawUnitPrice: '22.08' }
const fennel   = { ...kennebec, rate: '5.49', rawUnitPrice: '5.49' }
const kohlrabi = { ...kennebec, rate: '3.99', rawUnitPrice: '3.99' }
const sysco    = { pricingMode: 'per_case', rawUnit: 'CS', totalQtyUOM: null, rateUOM: null, rate: null, rawUnitPrice: '70.30', invoicePackQty: '1', invoicePackSize: '24', invoicePackUOM: 'each' }

// CLAUDE.md's Butter: a per-CASE line (2 × 25 × 454 g) that merely CARRIES a
// billed-weight column. No rate is printed, and the case price does not
// reconcile against the weight ($70 × 2.86 kg ≠ $140.60) — the weight is a
// shipping column, not the priced quantity. It must NOT become a MASS item, or
// the CASE price would be stored as $/kg.
const butter = {
  pricingMode: 'per_case', rawUnit: 'CS', rateUOM: null, rate: null,
  totalQtyUOM: 'kg', totalQty: '2.86', rawQty: '2', rawUnitPrice: '70', rawLineTotal: '140',
  invoicePackQty: '2', invoicePackSize: '25', invoicePackUOM: 'each',
}
// A per-CASE line whose PRINTED rate reconciles against the billed weight
// ($3.49/lb × 12 lb = $41.88) IS a catch-weight purchase, whatever the header
// says — the money proves the weight was what was priced.
const catchWeight = {
  pricingMode: 'per_case', rawUnit: 'CS', rateUOM: null, rate: '3.49',
  totalQtyUOM: 'lb', totalQty: '12', rawQty: '1', rawUnitPrice: '41.88', rawLineTotal: '41.88',
  invoicePackQty: null, invoicePackSize: null, invoicePackUOM: null,
}

describe('lineMeasureUnit', () => {
  it('takes rateUOM, then totalQtyUOM, then rawUnit; canonicalises; ignores containers', () => {
    expect(lineMeasureUnit({ rateUOM: 'LB', totalQtyUOM: 'kg', rawUnit: 'CS' })).toBe('lb')
    expect(lineMeasureUnit({ pricingMode: 'per_weight', rateUOM: null, totalQtyUOM: 'KG', rawUnit: 'lb' })).toBe('kg')
    expect(lineMeasureUnit({ pricingMode: 'per_weight', rateUOM: 'CS', totalQtyUOM: null, rawUnit: 'LBS' })).toBe('lb')
    expect(lineMeasureUnit({ pricingMode: 'per_weight', rateUOM: 'each', totalQtyUOM: 'PC', rawUnit: 'case' })).toBeNull()
    expect(lineMeasureUnit({})).toBeNull()
  })

  it('a printed rate unit is always accepted — the supplier said what the price is per', () => {
    // No money at all on the line: rateUOM alone still names the measure.
    expect(lineMeasureUnit({ pricingMode: 'per_case', rateUOM: 'kg' })).toBe('kg')
  })

  it('an UNPROVEN billed-weight column is not a measure unit', () => {
    expect(lineMeasureUnit(butter)).toBeNull()
    // Same shape, money stripped: nothing can prove the weight, so nothing does.
    expect(lineMeasureUnit({ ...butter, rawLineTotal: null, rawUnitPrice: null })).toBeNull()
  })

  it('a billed weight the printed rate reconciles IS the measure unit', () => {
    expect(lineMeasureUnit(catchWeight)).toBe('lb')
  })
})

describe('isByWeightLine', () => {
  it('per_weight or a measure unit the line earns', () => {
    expect(isByWeightLine(kennebec)).toBe(true)
    expect(isByWeightLine({ pricingMode: 'per_weight', rawUnit: 'kg' })).toBe(true)
    expect(isByWeightLine(catchWeight)).toBe(true)
    expect(isByWeightLine(sysco)).toBe(false)
    expect(isByWeightLine(butter)).toBe(false)
  })
})

describe('seedFromScanLine', () => {
  it.each([['kennebec', kennebec, 1.99], ['salami', salami, 22.08], ['fennel', fennel, 5.49], ['kohlrabi', kohlrabi, 3.99]])(
    '%s → a weight item priced per lb, chain 1 lb = 453.592 g, counted in lb', (_n, line, rate) => {
      const seed = seedFromScanLine(line)
      expect(seed).toEqual({ priceType: 'UOM', purchaseUnit: 'lb', qtyUOM: 'lb', packUOM: 'lb', qtyPerPurchaseUnit: 1, packSize: 1, innerQty: null, purchasePrice: rate, countUOM: 'lb' })
      const chain = formToChain(seed)
      expect(chain.dimension).toBe('MASS'); expect(chain.baseUnit).toBe('g')
      expect(chain.pricing).toEqual({ mode: 'RATE', rate, rateUnit: 'lb' })
      expect(chain.packChain).toEqual([{ unit: 'lb', per: 453.592 }])
      expect(chain.countUnit).toBe('lb')
    })
  it('a per-case line seeds exactly as today', () => {
    expect(seedFromScanLine(sysco)).toEqual({ purchaseUnit: 'case', purchasePrice: 70.3, qtyPerPurchaseUnit: 1, qtyUOM: 'each', innerQty: null, packSize: 24, packUOM: 'each', priceType: 'CASE', countUOM: 'each' })
  })
  it('a per-case line carrying an unpriced weight column seeds per case, not per kg', () => {
    const seed = seedFromScanLine(butter)
    expect(seed).toEqual({ purchaseUnit: 'case', purchasePrice: 70, qtyPerPurchaseUnit: 2, qtyUOM: 'each', innerQty: null, packSize: 25, packUOM: 'each', priceType: 'CASE', countUOM: 'each' })
    // The CASE price never becomes a $/kg rate.
    expect(formToChain(seed).dimension).toBe('COUNT')
  })
  it('a per-case line whose printed rate reconciles seeds by weight', () => {
    expect(seedFromScanLine(catchWeight)).toEqual({ priceType: 'UOM', purchaseUnit: 'lb', qtyUOM: 'lb', packUOM: 'lb', qtyPerPurchaseUnit: 1, packSize: 1, innerQty: null, purchasePrice: 3.49, countUOM: 'lb' })
  })
})

describe('validateCreateNew', () => {
  it('COUNT from a by-weight line without an each-measure is refused with the exact sentence', () => {
    expect(validateCreateNew({ line: kennebec, dimension: 'COUNT', eachMeasureQty: null })).toEqual({ ok: false, error: CREATE_NEW_COUNT_NEEDS_EACH })
    expect(validateCreateNew({ line: kennebec, dimension: 'COUNT', eachMeasureQty: 0 }).ok).toBe(false)
  })
  it('COUNT with an each-measure, MASS from a by-weight line, and COUNT from a per-case line all pass', () => {
    expect(validateCreateNew({ line: kennebec, dimension: 'COUNT', eachMeasureQty: '200' })).toEqual({ ok: true })
    expect(validateCreateNew({ line: kennebec, dimension: 'MASS', eachMeasureQty: null })).toEqual({ ok: true })
    expect(validateCreateNew({ line: sysco, dimension: 'COUNT', eachMeasureQty: null })).toEqual({ ok: true })
  })
  it('the correctly-COUNT product on a per-case line with a stray weight column is not refused', () => {
    expect(validateCreateNew({ line: butter, dimension: 'COUNT', eachMeasureQty: null })).toEqual({ ok: true })
  })
  it('a proven catch-weight line still needs an each-measure to be COUNT', () => {
    expect(validateCreateNew({ line: catchWeight, dimension: 'COUNT', eachMeasureQty: null })).toEqual({ ok: false, error: CREATE_NEW_COUNT_NEEDS_EACH })
  })
})
