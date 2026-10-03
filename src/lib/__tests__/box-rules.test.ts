import { describe, it, expect } from 'vitest'
import { validateBox, normalizeCode } from '@/lib/box-rules'

// A supplier box is judged against the ITEM it belongs to: the item supplies the
// measure, base unit and bridges; the box supplies only its pack and price.

const GRAMS_ITEM = {
  dimension: 'MASS', baseUnit: 'g', isStocked: true,
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
}
const EACH_ITEM = {
  dimension: 'COUNT', baseUnit: 'each', isStocked: true,
  eachMeasureQty: null as unknown, eachMeasureUnit: null as string | null, densityGPerMl: null,
}

describe('validateBox', () => {
  it('a $0 PACK box on a stocked g item → price must be above $0', () => {
    expect(validateBox(GRAMS_ITEM, {
      supplierId: 's1', packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 0 },
    })).toEqual(['price must be above $0'])
  })

  it('a $0 box on a non-stocked item is allowed', () => {
    expect(validateBox({ ...GRAMS_ITEM, isStocked: false }, {
      supplierId: 's1', packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 0 },
    })).toEqual([])
  })

  it('a $/lb RATE box on an each item with no each-measure → the rate is not costable', () => {
    const errs = validateBox(EACH_ITEM, {
      supplierId: 's1', packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'RATE', rate: 4.5, rateUnit: 'lb' },
    })
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatch(/^RATE\.rateUnit must share the item dimension/)
  })

  it('the same $/lb box with an each-measure of 453.6 g is valid', () => {
    expect(validateBox({ ...EACH_ITEM, eachMeasureQty: '453.6', eachMeasureUnit: 'g' }, {
      supplierId: 's1', packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'RATE', rate: 4.5, rateUnit: 'lb' },
    })).toEqual([])
  })

  it('a box with no pack is refused', () => {
    expect(validateBox(GRAMS_ITEM, {
      supplierId: 's1', packChain: [], pricing: { mode: 'PACK', purchasePrice: 10 },
    })).toContain('chain must have at least one link')
  })

  it('a box whose pricing is not PACK or RATE is refused', () => {
    expect(validateBox(GRAMS_ITEM, {
      supplierId: 's1', packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'FREE' } as never,
    })).toContain('pricing must be PACK or RATE')
  })
})

describe('normalizeCode', () => {
  it('trims and upper-cases', () => { expect(normalizeCode(' abc ')).toBe('ABC') })
  it("'' and null → null", () => {
    expect(normalizeCode('')).toBeNull()
    expect(normalizeCode('   ')).toBeNull()
    expect(normalizeCode(null)).toBeNull()
    expect(normalizeCode(undefined)).toBeNull()
  })
})
