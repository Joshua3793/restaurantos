import { describe, it, expect } from 'vitest'
import { pickOffer, resolveLineFormat } from '@/lib/invoice/line-format'
import { lineReceivedBaseUnits } from '@/lib/invoice/line-qty'
import { asChainItem } from '@/lib/item-model'

// Romaine hearts: the item (primary supplier) is 4 case › 12 pack = 48 each.
const romaine = asChainItem({
  dimension: 'COUNT', baseUnit: 'each',
  packChain: [{ unit: 'case', per: 4 }, { unit: 'pack', per: 12 }],
  pricing: { mode: 'PACK', purchasePrice: 60 },
})
const otherSupplier = {
  supplierId: 'sup-b', supplierName: 'North Arm Farms',
  packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 30 },
}

describe('resolveLineFormat', () => {
  it('no offer → the item chain, unchanged (regression lock for items without offers)', () => {
    expect(resolveLineFormat(romaine, null)).toBe(romaine)
  })

  it('uses the supplier offer chain, keeps the item base unit and bridges', () => {
    const r = resolveLineFormat({ ...romaine, eachMeasure: { qty: 300, unit: 'g' } }, otherSupplier)
    expect(r.packChain).toEqual([{ unit: 'case', per: 12 }])
    expect(r.baseUnit).toBe('each')
    expect(r.eachMeasure).toEqual({ qty: 300, unit: 'g' })
  })

  it('"2 cases" with no printed pack credits the SUPPLIER case, not the item case', () => {
    const line = { rawQty: 2, rawUnit: 'case' }
    expect(lineReceivedBaseUnits(line, romaine)).toBe(96)                                   // today: wrong for supplier B
    expect(lineReceivedBaseUnits(line, resolveLineFormat(romaine, otherSupplier))).toBe(24) // fixed
  })

  it('an empty or zero offer chain falls back to the item', () => {
    expect(resolveLineFormat(romaine, { packChain: [] })).toBe(romaine)
    expect(resolveLineFormat(romaine, { packChain: [{ unit: 'case', per: 0 }] })).toBe(romaine)
    expect(resolveLineFormat(romaine, { packChain: null })).toBe(romaine)
  })

  it('a RATE offer on a PACK item makes the line read as billed weight', () => {
    const beef = asChainItem({
      dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 10000 }],
      pricing: { mode: 'PACK', purchasePrice: 200 },
    })
    const catchWeight = { packChain: [{ unit: 'kg', per: 1000 }], pricing: { mode: 'RATE', rate: 22, rateUnit: 'kg' } }
    const line = { rawQty: 1, rawUnit: 'case', totalQty: 9.4, totalQtyUOM: 'kg' }
    expect(lineReceivedBaseUnits(line, beef)).toBe(10000)
    expect(lineReceivedBaseUnits(line, resolveLineFormat(beef, catchWeight))).toBeCloseTo(9400)
  })

  it('ignores a RATE offer whose unit is another dimension', () => {
    const r = resolveLineFormat(romaine, { packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'RATE', rate: 5, rateUnit: 'kg' } })
    expect(r.pricing).toEqual(romaine.pricing)
    expect(r.packChain).toEqual([{ unit: 'case', per: 12 }])
  })

  it('an offer with a zero or missing PACK price keeps the item pricing but still adopts the chain', () => {
    for (const pricing of [{ mode: 'PACK', purchasePrice: 0 }, { mode: 'PACK' }, { mode: 'PACK', purchasePrice: 'abc' }]) {
      const r = resolveLineFormat(romaine, { packChain: [{ unit: 'case', per: 12 }], pricing })
      expect(r.pricing).toEqual(romaine.pricing)
      expect(r.packChain).toEqual([{ unit: 'case', per: 12 }])
    }
  })

  it('a RATE offer with a zero rate keeps the item pricing', () => {
    const beef = asChainItem({
      dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 10000 }],
      pricing: { mode: 'PACK', purchasePrice: 200 },
    })
    const r = resolveLineFormat(beef, { packChain: [{ unit: 'kg', per: 1000 }], pricing: { mode: 'RATE', rate: 0, rateUnit: 'kg' } })
    expect(r.pricing).toEqual(beef.pricing)
  })

  it('a chain link with a non-numeric per falls back to the item', () => {
    expect(resolveLineFormat(romaine, { packChain: [{ unit: 'case', per: 'abc' }] })).toBe(romaine)
  })
})

describe('pickOffer', () => {
  const offers = [
    { supplierId: 'sup-a', supplierName: 'Sysco', packChain: [] },
    { supplierId: null, supplierName: 'North Arm Farms', packChain: [] },
  ]
  it('joins on supplierId first', () => {
    expect(pickOffer(offers, { supplierId: 'sup-a', supplierName: 'SYSCO CANADA' })?.supplierName).toBe('Sysco')
  })
  it('falls back to the canonical then the raw name', () => {
    expect(pickOffer(offers, { supplierName: 'NAF', canonicalName: 'North Arm Farms' })?.supplierName).toBe('North Arm Farms')
    expect(pickOffer(offers, { supplierName: 'North Arm Farms' })?.supplierName).toBe('North Arm Farms')
  })
  it('null when nothing matches or there is no supplier', () => {
    expect(pickOffer(offers, { supplierName: 'GFS' })).toBeNull()
    expect(pickOffer(offers, {})).toBeNull()
    expect(pickOffer(null, { supplierName: 'Sysco' })).toBeNull()
  })
})
