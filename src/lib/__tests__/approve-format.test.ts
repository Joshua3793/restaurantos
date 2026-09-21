import { describe, it, expect } from 'vitest'
import { packReference, casePricePerBase } from '@/lib/invoice/approve-format'
import { resolveLineFormat } from '@/lib/invoice/line-format'
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
