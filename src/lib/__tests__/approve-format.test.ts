import { describe, it, expect } from 'vitest'
import { packReference, casePricePerBase, freezeFormat } from '@/lib/invoice/approve-format'
import { resolveLineFormat } from '@/lib/invoice/line-format'
import { lineReceivedBaseUnits } from '@/lib/invoice/line-qty'
import type { ChainItem } from '@/lib/item-model'

const itemChain = [{ unit: 'case', per: 4 }, { unit: 'pack', per: 12 }] // 48

describe('packReference', () => {
  it('this supplier has an offer → compare against ITS pack', () => {
    expect(packReference(itemChain, { packChain: [{ unit: 'case', per: 12 }] }, true)).toEqual({ baseTotal: 12, against: 'offer' })
  })
  it('new supplier on an item that already has offers → no reference (guard silent)', () => {
    expect(packReference(itemChain, null, true)).toBeNull()
  })
  it('item with no offers at all → today’s behaviour, compare against the item', () => {
    expect(packReference(itemChain, null, false)).toEqual({ baseTotal: 48, against: 'item' })
  })
  it('an offer with an unusable chain behaves like no offer', () => {
    expect(packReference(itemChain, { packChain: [] }, true)).toBeNull()
  })
})

// Romaine: 1 case = 48 each (4 packs of 12).
const romaine: ChainItem = {
  dimension: 'COUNT', baseUnit: 'each', packChain: itemChain,
  pricing: { mode: 'PACK', purchasePrice: 96 }, countUnit: 'case',
}

describe('casePricePerBase', () => {
  it('no offer → the item chain, i.e. exactly the pre-offer behaviour', () => {
    expect(casePricePerBase(resolveLineFormat(romaine, null), 48)).toBe(1)
  })
  it('the primary offer mirrors the item chain → unchanged', () => {
    expect(casePricePerBase(resolveLineFormat(romaine, { packChain: itemChain }), 48)).toBe(1)
  })
  it('a non-primary supplier selling a 12-pack → $/each over ITS pack, not the item’s', () => {
    // Previously 48/48 = $1.00/each — off by the 4× pack ratio.
    expect(casePricePerBase(resolveLineFormat(romaine, { packChain: [{ unit: 'case', per: 12 }] }), 48)).toBe(4)
  })
  it('a stale RATE on the offer never becomes the denominator', () => {
    const offer = { packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'RATE', rate: 9, rateUnit: 'each' } }
    expect(casePricePerBase(resolveLineFormat(romaine, offer), 48)).toBe(4)
  })
  it('an empty chain divides by one rather than returning 0 (the skip guard stays untriggered)', () => {
    expect(casePricePerBase({ ...romaine, packChain: [] }, 48)).toBe(48)
  })
})

describe('freezeFormat', () => {
  // A MASS item bought by the case, whose supplier's FIRST invoice bills per
  // weight. lineOffer is null (no offer yet) so `speaks` still carries the item's
  // PACK pricing — but this same approval writes RATE. Freezing through the
  // pre-write mode read "18.4" as 18.4 CASES.
  const beef: ChainItem = {
    dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 9072 }],
    pricing: { mode: 'PACK', purchasePrice: 200 }, countUnit: 'case',
  }
  const perWeightLine = { rawQty: 18.4, rawUnit: 'KG', totalQty: null, totalQtyUOM: null, rateUOM: 'kg' }

  it('a per-weight line on a PACK-priced item freezes the billed weight, not the case count', () => {
    // The bug: 18.4 × 9072 g/case.
    expect(lineReceivedBaseUnits(perWeightLine, beef)).toBeCloseTo(166924.8)
    // Fixed: 18.4 kg.
    expect(lineReceivedBaseUnits(perWeightLine, freezeFormat(beef, { mode: 'RATE', rate: 22, rateUnit: 'kg' })))
      .toBeCloseTo(18400)
  })

  it('keeps the chain and only swaps the pricing', () => {
    const r = freezeFormat(beef, { mode: 'RATE', rate: 22, rateUnit: 'kg' })
    expect(r.packChain).toEqual(beef.packChain)
    expect(r.baseUnit).toBe('g')
    expect(r.pricing).toEqual({ mode: 'RATE', rate: 22, rateUnit: 'kg' })
  })

  it('a no-op when the modes already agree', () => {
    const line = { rawQty: 2, rawUnit: 'CS' }
    const same = freezeFormat(beef, { mode: 'PACK', purchasePrice: 210 })
    expect(lineReceivedBaseUnits(line, same)).toBe(lineReceivedBaseUnits(line, beef))
    expect(lineReceivedBaseUnits(line, same)).toBeCloseTo(18144)
  })

  it('a bridged COUNT item still freezes through its count chain', () => {
    // Brioche: 1 each = 1100 g. The line prints 2 × "8 × 1100 g" — a COUNT
    // purchase wearing weight units, so the approval writes PACK, not RATE.
    const brioche: ChainItem = {
      dimension: 'COUNT', baseUnit: 'each', packChain: [{ unit: 'case', per: 8 }],
      pricing: { mode: 'PACK', purchasePrice: 40 }, countUnit: 'case',
      eachMeasure: { qty: 1100, unit: 'g' },
    }
    const line = { rawQty: 2, invoicePackQty: 8, invoicePackSize: 1100, invoicePackUOM: 'g' }
    expect(lineReceivedBaseUnits(line, freezeFormat(brioche, { mode: 'PACK', purchasePrice: 40 }))).toBe(16)
  })
})
