import { describe, it, expect } from 'vitest'
import {
  basePerPurchase,
  levelBaseUnits,
  basePerUnit,
  pricePerBaseUnit,
  conversionFactor,
  stockValue,
  countQty,
  lineCost,
  validateChainItem,
  asChainItem,
  withPpb,
  dimensionOf,
  invoicePackBaseTotal,
  packFormatsDisagree,
  type ChainItem,
} from '@/lib/item-model'
import { formToChain, type ItemFormInput } from '@/lib/item-model-form'
import { calcPricePerBaseUnit } from '@/lib/utils'

/** 1 case = 4 × 3 L jugs = 12,000 ml, priced $24/case → $0.002/ml */
const oil: ChainItem = {
  dimension: 'VOLUME',
  baseUnit: 'ml',
  packChain: [
    { unit: 'case', per: 4 },
    { unit: 'jug', per: 3000 },
  ],
  pricing: { mode: 'PACK', purchasePrice: 24 },
  countUnit: 'jug',
}

/** Catch-weight salmon: priced $8.50/kg, nominal 5 kg case → $0.0085/g */
const salmon: ChainItem = {
  dimension: 'MASS',
  baseUnit: 'g',
  packChain: [{ unit: 'case', per: 5000 }],
  pricing: { mode: 'RATE', rate: 8.5, rateUnit: 'kg' },
}

describe('chain arithmetic', () => {
  it('basePerPurchase is the product of every per', () => {
    expect(basePerPurchase(oil.packChain)).toBe(12000)
    expect(basePerPurchase([])).toBe(1)
  })

  it('levelBaseUnits gives the running product per level', () => {
    expect(levelBaseUnits(oil.packChain)).toEqual({ jug: 3000, case: 12000 })
  })

  it('basePerUnit resolves chain levels, same-dimension units, and falls back to 1', () => {
    expect(basePerUnit(oil, 'jug')).toBe(3000)
    expect(basePerUnit(oil, 'case')).toBe(12000)
    expect(basePerUnit(oil, 'l')).toBe(1000) // same-dimension measured unit
    expect(basePerUnit(oil, 'each')).toBe(1) // cross-dimension fallback
  })
})

describe('pricePerBaseUnit', () => {
  it('PACK mode: purchase price / base units per purchase', () => {
    expect(pricePerBaseUnit(oil)).toBeCloseTo(0.002)
  })

  it('RATE mode: rate / conv(rateUnit) — the catch-weight 1000× regression', () => {
    // $8.50/kg must become $0.0085/g, NOT $8.50/g.
    expect(pricePerBaseUnit(salmon)).toBeCloseTo(0.0085)
  })

  it('returns 0 on degenerate inputs instead of Infinity/NaN', () => {
    expect(pricePerBaseUnit({ ...oil, packChain: [] })).toBe(0.002 * 12000) // empty chain → denom 1
    expect(pricePerBaseUnit({ ...oil, packChain: [{ unit: 'case', per: 0 }] })).toBe(0)
    expect(pricePerBaseUnit({ ...oil, pricing: { mode: 'PACK', purchasePrice: 0 } })).toBe(0)
  })
})

describe('derived helpers', () => {
  it('conversionFactor = base units per count unit', () => {
    expect(conversionFactor(oil)).toBe(3000) // default countUnit 'jug'
    expect(conversionFactor(oil, 'case')).toBe(12000)
  })

  it('stockValue and countQty work off stockOnHand in base units', () => {
    const stocked = { ...oil, stockOnHand: 6000 }
    expect(stockValue(stocked)).toBeCloseTo(12) // 6000 ml × $0.002
    expect(countQty(stocked)).toBe(2) // 6000 ml / 3000 ml per jug
  })

  it('lineCost converts the recipe unit then multiplies by price', () => {
    expect(lineCost(oil, 2, 'l')).toBeCloseTo(4) // 2000 ml × $0.002
    expect(lineCost(salmon, 1.5, 'kg')).toBeCloseTo(12.75) // 1500 g × $0.0085
  })
})

describe('validateChainItem', () => {
  it('accepts a well-formed item', () => {
    expect(validateChainItem(oil)).toEqual([])
    expect(validateChainItem(salmon)).toEqual([])
  })

  it('rejects empty chains, non-positive pers, and dimension mismatches', () => {
    expect(validateChainItem({ ...oil, packChain: [] })).toContain('chain must have at least one link')
    expect(validateChainItem({ ...oil, packChain: [{ unit: 'case', per: 0 }] })).toContain('every per must be > 0')
    expect(validateChainItem({ ...oil, baseUnit: 'g' })).toContain('baseUnit dimension must equal item dimension')
    expect(validateChainItem({ ...oil, countUnit: 'kg' })).toContain('countUnit must be a chain level or a same-dimension unit')
    expect(
      validateChainItem({ ...salmon, pricing: { mode: 'RATE', rate: 8.5, rateUnit: 'l' } }),
    ).toContain('RATE.rateUnit must share the item dimension')
  })
})

describe('asChainItem / withPpb (Prisma row coercion)', () => {
  const row = {
    dimension: 'VOLUME',
    baseUnit: 'ml',
    packChain: [{ unit: 'case', per: 12000 }] as unknown,
    pricing: { mode: 'PACK', purchasePrice: 24 } as unknown,
    stockOnHand: '6000', // Prisma Decimal serializes as string
    eachMeasureQty: null,
    eachMeasureUnit: null,
  }

  it('coerces Json/Decimal fields and defaults null pricing to $0 PACK', () => {
    const item = asChainItem(row)
    expect(item.stockOnHand).toBe(6000)
    expect(pricePerBaseUnit(item)).toBeCloseTo(0.002)
    const bare = asChainItem({ ...row, packChain: null, pricing: null })
    expect(bare.packChain).toEqual([])
    expect(pricePerBaseUnit(bare)).toBe(0)
  })

  it('withPpb attaches the computed value as pricePerBaseUnit', () => {
    expect(withPpb(row).pricePerBaseUnit).toBeCloseTo(0.002)
  })
})

describe('formToChain ↔ calcPricePerBaseUnit parity contract', () => {
  // formToChain documents that pricePerBaseUnit(formToChain(f)) reproduces the
  // legacy calcPricePerBaseUnit EXACTLY for the same inputs, branch by branch.
  const cases: Array<[string, ItemFormInput]> = [
    ['measured qtyUOM', { purchaseUnit: 'case', purchasePrice: 100, qtyPerPurchaseUnit: 10, qtyUOM: 'kg', innerQty: null, packSize: 1, packUOM: 'each', priceType: 'CASE', countUOM: 'each' }],
    ['pack + innerQty', { purchaseUnit: 'case', purchasePrice: 42, qtyPerPurchaseUnit: 4, qtyUOM: 'pack', innerQty: 6, packSize: 350, packUOM: 'ml', priceType: 'CASE', countUOM: 'each' }],
    ['count qtyUOM (else branch)', { purchaseUnit: 'case', purchasePrice: 60, qtyPerPurchaseUnit: 12, qtyUOM: 'each', innerQty: null, packSize: 2, packUOM: 'kg', priceType: 'CASE', countUOM: 'each' }],
    ['UOM rate, measured packUOM', { purchaseUnit: 'case', purchasePrice: 8.5, qtyPerPurchaseUnit: 1, qtyUOM: 'each', innerQty: null, packSize: 5, packUOM: 'kg', priceType: 'UOM', countUOM: 'each' }],
    ['UOM rate, count packUOM falls back to kg', { purchaseUnit: 'case', purchasePrice: 8.5, qtyPerPurchaseUnit: 5, qtyUOM: 'kg', innerQty: null, packSize: 1, packUOM: 'each', priceType: 'UOM', countUOM: 'each' }],
  ]

  it.each(cases)('%s', (_label, f) => {
    const chainPpb = pricePerBaseUnit(formToChain(f))
    const legacyPpb = calcPricePerBaseUnit(
      f.purchasePrice, f.qtyPerPurchaseUnit, f.qtyUOM, f.innerQty, f.packSize, f.packUOM, f.priceType,
    )
    expect(chainPpb).toBeCloseTo(legacyPpb, 12)
    expect(legacyPpb).toBeGreaterThan(0)
  })

  it('weight-priced case: $100 for 10 kg → $0.01/g (the 1000× guard)', () => {
    const f = cases[0][1]
    expect(pricePerBaseUnit(formToChain(f))).toBeCloseTo(0.01)
  })
})

describe('dimensionOf', () => {
  it('maps units onto Dimension', () => {
    expect(dimensionOf('kg')).toBe('MASS')
    expect(dimensionOf('l')).toBe('VOLUME')
    expect(dimensionOf('each')).toBe('COUNT')
    expect(dimensionOf('case')).toBe('COUNT') // containers fall through to COUNT
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Supplier pack-size changes. An invoice updates an item's PRICE over the
// item's own stored chain; it never rewrites the format. That is only sound
// while the invoice's case and the item's case hold the same amount — when a
// supplier changes pack size, the raw case price over a stale chain is wrong by
// exactly the ratio of the two packs. These are the real cases that shipped.
// ─────────────────────────────────────────────────────────────────────────────
describe('invoicePackBaseTotal', () => {
  it('resolves a line pack into the item base unit', () => {
    expect(invoicePackBaseTotal({ packQty: 1, packSize: 20, packUOM: 'kg' }, 'g')).toBe(20000)
    expect(invoicePackBaseTotal({ packQty: 6, packSize: 2.841, packUOM: 'l' }, 'ml')).toBeCloseTo(17046)
    expect(invoicePackBaseTotal({ packQty: 1, packSize: 12, packUOM: 'lb' }, 'g')).toBeCloseTo(5443.104)
    expect(invoicePackBaseTotal({ packQty: 1, packSize: 24, packUOM: 'each' }, 'each')).toBe(24)
  })

  it('returns 0 when the pack is unusable or crosses dimensions', () => {
    expect(invoicePackBaseTotal({ packQty: null, packSize: 20, packUOM: 'kg' }, 'g')).toBe(0)
    expect(invoicePackBaseTotal({ packQty: 1, packSize: 0, packUOM: 'kg' }, 'g')).toBe(0)
    expect(invoicePackBaseTotal({ packQty: 1, packSize: 20, packUOM: '' }, 'g')).toBe(0)
    // count line against a weight-based item — needs the eachMeasure bridge
    expect(invoicePackBaseTotal({ packQty: 1, packSize: 24, packUOM: 'each' }, 'g')).toBe(0)
  })
})

describe('packFormatsDisagree', () => {
  it('is quiet when the packs agree', () => {
    expect(packFormatsDisagree(20000, 20000).disagree).toBe(false)
    expect(packFormatsDisagree(20000, 20100).disagree).toBe(false) // within tolerance
    // OCR rounding (a 15.14 L case read as 16 L) must not block an invoice
    expect(packFormatsDisagree(15136, 16000).disagree).toBe(false)
    expect(packFormatsDisagree(64, 72).disagree).toBe(false)
  })

  it('flags a supplier pack change — Baking Powder 3 kg chain vs a 20 kg case', () => {
    const r = packFormatsDisagree(20000, 3000)
    expect(r.disagree).toBe(true)
    expect(r.ratio).toBeCloseTo(0.15)
    // the cost that WOULD have been written against the stale chain
    expect((112.83 / 3000) * 1000).toBeCloseTo(37.61, 2)
    expect((112.83 / 20000) * 1000).toBeCloseTo(5.64, 2)
  })

  it('also flags the opposite case, where the ITEM holds the true case count', () => {
    // Tamari: OCR read "1 x 1.89 l" off the container; the case is really 6.
    const r = packFormatsDisagree(1890, 11340)
    expect(r.disagree).toBe(true)
    expect(r.ratio).toBeCloseTo(6)
  })

  it('stays silent on unusable input rather than reporting a false conflict', () => {
    expect(packFormatsDisagree(0, 3000).disagree).toBe(false)
    expect(packFormatsDisagree(3000, 0).disagree).toBe(false)
  })
})
