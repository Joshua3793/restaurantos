import { describe, it, expect } from 'vitest'
import { validateBox, normalizeCode, boxRefusal, statedDimension } from '@/lib/box-rules'

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

// A box in another measure than its item. `validateChainItem` never looks at the
// units inside a chain, so these all passed before — and a main box in the wrong
// measure would have made the item read "1 case = 9071.84 each".
describe('validateBox — a pack in another measure', () => {
  const LITRE_ITEM = { ...GRAMS_ITEM, dimension: 'VOLUME', baseUnit: 'ml' }

  it('a weight line [cs 4, lb 2267.96] PACK $40 on a counted item → refused', () => {
    expect(validateBox(EACH_ITEM, {
      supplierId: 's1', packChain: [{ unit: 'cs', per: 4 }, { unit: 'lb', per: 2267.96 }], pricing: { mode: 'PACK', purchasePrice: 40 },
    })).toEqual(['This box is measured by weight but the item is counted. Change how the item is measured first.'])
  })

  it('…even when the counted item carries an each-measure (the pack is still in pounds)', () => {
    expect(validateBox({ ...EACH_ITEM, eachMeasureQty: '453.6', eachMeasureUnit: 'g' }, {
      supplierId: 's1', packChain: [{ unit: 'cs', per: 4 }, { unit: 'lb', per: 2267.96 }], pricing: { mode: 'PACK', purchasePrice: 40 },
    })).toEqual(['This box is measured by weight but the item is counted. Change how the item is measured first.'])
  })

  it('a volume line [case 4, l 1000] on a weight item → refused', () => {
    expect(validateBox(GRAMS_ITEM, {
      supplierId: 's1', packChain: [{ unit: 'case', per: 4 }, { unit: 'l', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 30 },
    })).toEqual(['This box is measured by volume but the item is measured by weight. Change how the item is measured first.'])
  })

  it('a weight line on a volume item → refused', () => {
    expect(validateBox(LITRE_ITEM, {
      supplierId: 's1', packChain: [{ unit: 'case', per: 2 }, { unit: 'kg', per: 5000 }], pricing: { mode: 'PACK', purchasePrice: 30 },
    })).toEqual(['This box is measured by weight but the item is measured by volume. Change how the item is measured first.'])
  })

  // [cs 12, each 1] is structurally the same as a by-weight item's legitimate
  // "12 each of 500 g" pack — the units alone cannot tell them apart. A box
  // taken from an invoice line states the measure it was built in.
  it('a counted line [cs 12, each 1] on a weight item → refused when its measure is stated', () => {
    expect(validateBox(GRAMS_ITEM, {
      supplierId: 's1', packChain: [{ unit: 'cs', per: 12 }, { unit: 'each', per: 1 }], pricing: { mode: 'PACK', purchasePrice: 24 },
      dimension: 'COUNT',
    })).toEqual(['This box is counted but the item is measured by weight. Change how the item is measured first.'])
  })

  it("a by-weight item's own pack — [case 12, each 500], [case 4, lb 2267.96], [case 1000] — still fits", () => {
    for (const packChain of [
      [{ unit: 'case', per: 12 }, { unit: 'each', per: 500 }],
      [{ unit: 'case', per: 4 }, { unit: 'lb', per: 2267.96 }],
      [{ unit: 'case', per: 1000 }],
    ]) {
      expect(validateBox(GRAMS_ITEM, { supplierId: 's1', packChain, pricing: { mode: 'PACK', purchasePrice: 30 }, dimension: 'MASS' })).toEqual([])
    }
  })

  it("a counted item's own pack [case 24, each 1] still fits", () => {
    expect(validateBox(EACH_ITEM, {
      supplierId: 's1', packChain: [{ unit: 'case', per: 24 }, { unit: 'each', per: 1 }], pricing: { mode: 'PACK', purchasePrice: 24 },
    })).toEqual([])
  })

  it('boxRefusal answers with the plain sentence, every reason in details', () => {
    const errs = validateBox(EACH_ITEM, {
      supplierId: 's1', packChain: [{ unit: 'cs', per: 4 }, { unit: 'lb', per: 2267.96 }], pricing: { mode: 'PACK', purchasePrice: 0 },
    })
    expect(boxRefusal(errs)).toEqual({
      error: 'This box is measured by weight but the item is counted. Change how the item is measured first.',
      code: 'INVALID', details: errs,
    })
  })
})

describe('statedDimension', () => {
  it('absent → undefined; a measure → itself; anything else → null', () => {
    expect(statedDimension(undefined)).toBeUndefined()
    expect(statedDimension(null)).toBeUndefined()
    expect(statedDimension('COUNT')).toBe('COUNT')
    expect(statedDimension('weight')).toBeNull()
    expect(statedDimension(3)).toBeNull()
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
