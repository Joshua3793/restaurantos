import { describe, it, expect } from 'vitest'
import { lineMeasureUnit, isByWeightLine, seedFromScanLine, validateCreateNew, CREATE_NEW_COUNT_NEEDS_EACH } from '@/lib/invoice/create-new-seed'
import { formToChain } from '@/lib/item-model-form'

// The four real lines (read-only dump 2026-09-22)
const kennebec = { pricingMode: 'per_weight', rawUnit: 'lb', totalQtyUOM: 'lb', rateUOM: 'lb', rate: '1.99', rawUnitPrice: '1.99', invoicePackQty: null, invoicePackSize: null, invoicePackUOM: null }
const salami   = { ...kennebec, rate: '22.08', rawUnitPrice: '22.08' }
const fennel   = { ...kennebec, rate: '5.49', rawUnitPrice: '5.49' }
const kohlrabi = { ...kennebec, rate: '3.99', rawUnitPrice: '3.99' }
const sysco    = { pricingMode: 'per_case', rawUnit: 'CS', totalQtyUOM: null, rateUOM: null, rate: null, rawUnitPrice: '70.30', invoicePackQty: '1', invoicePackSize: '24', invoicePackUOM: 'each' }

describe('lineMeasureUnit', () => {
  it('takes rateUOM, then totalQtyUOM, then rawUnit; canonicalises; ignores containers', () => {
    expect(lineMeasureUnit({ rateUOM: 'LB', totalQtyUOM: 'kg', rawUnit: 'CS' })).toBe('lb')
    expect(lineMeasureUnit({ rateUOM: null, totalQtyUOM: 'KG', rawUnit: 'lb' })).toBe('kg')
    expect(lineMeasureUnit({ rateUOM: 'CS', totalQtyUOM: null, rawUnit: 'LBS' })).toBe('lb')
    expect(lineMeasureUnit({ rateUOM: 'each', totalQtyUOM: 'PC', rawUnit: 'case' })).toBeNull()
    expect(lineMeasureUnit({})).toBeNull()
  })
})

describe('isByWeightLine', () => {
  it('per_weight or any measure unit', () => {
    expect(isByWeightLine(kennebec)).toBe(true)
    expect(isByWeightLine({ pricingMode: 'per_case', rawUnit: 'kg' })).toBe(true)
    expect(isByWeightLine(sysco)).toBe(false)
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
})
