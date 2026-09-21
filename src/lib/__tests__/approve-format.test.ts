import { describe, it, expect } from 'vitest'
import { packReference, casePricePerBase, freezeFormat, pricingBasisFor, packIsTheQuantity, nonEmptyOfferChain, weightBasisRate } from '@/lib/invoice/approve-format'
import { resolveLineFormat } from '@/lib/invoice/line-format'
import { lineReceivedBaseUnits, lineReceived } from '@/lib/invoice/line-qty'
import { asChainItem, ratePerBase, type ChainItem } from '@/lib/item-model'

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
  // An offer row that EXISTS but carries no usable chain is not "a supplier we
  // have never seen" — it is a supplier we know nothing about the pack of. Going
  // silent there re-opens the Baking-Powder corruption (a case price written over
  // a stale item chain after the pack changed), so fall back to the item's chain:
  // exactly the pre-branch behaviour.
  it('an offer that exists but has an unusable chain falls back to the item chain', () => {
    expect(packReference(itemChain, { packChain: [] }, true)).toEqual({ baseTotal: 48, against: 'item' })
  })
  it('the PRIMARY supplier with an unusable offer chain is still checked against the item', () => {
    // The item's chain IS this supplier's pack (primary-offer.ts keeps them in
    // sync), so the guard must stay armed for them above all.
    expect(packReference(itemChain, { supplierName: 'Primary Co', packChain: undefined }, true))
      .toEqual({ baseTotal: 48, against: 'item' })
  })
  it('a supplier never seen on an item that has offers is still silent', () => {
    expect(packReference(itemChain, null, true)).toBeNull()
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

  it('a per-weight line whose shipped unit says KG needs no help any more (line-first receiving)', () => {
    // Was the bug this helper was written for: 18.4 × 9072 g/case = 166,924.8.
    // lineReceived now reads the line's own unit, with or without the mode swap.
    expect(lineReceivedBaseUnits(perWeightLine, beef)).toBeCloseTo(18400)
    expect(lineReceivedBaseUnits(perWeightLine, freezeFormat(beef, { mode: 'RATE', rate: 22, rateUnit: 'kg' })))
      .toBeCloseTo(18400)
  })

  it('still earns its keep for a UNIT-LESS weight: only the resolved RATE mode says it is kg', () => {
    const unitless = { rawQty: 18.4, rawUnit: null, totalQty: null, totalQtyUOM: null, rateUOM: null }
    // No unit anywhere on the line → a PACK item can only read it as cases.
    expect(lineReceivedBaseUnits(unitless, beef)).toBeCloseTo(166924.8)
    // Frozen through the mode the line resolved to → the priced unit (kg) applies.
    expect(lineReceivedBaseUnits(unitless, freezeFormat(beef, { mode: 'RATE', rate: 22, rateUnit: 'kg' })))
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

describe('pricingBasisFor — the price basis follows the receiving basis', () => {
  it('received by weight → WEIGHT, even on a bridged COUNT item (eggplant)', () => {
    expect(pricingBasisFor({ via: 'billed-weight', ocrPerWeight: true, itemHasEachMeasure: true })).toBe('WEIGHT')
    expect(pricingBasisFor({ via: 'shipped-unit', ocrPerWeight: false, itemHasEachMeasure: true })).toBe('WEIGHT')
  })
  it('Brioche: a per-case line whose pack prints a weight, on a bridged COUNT item → CASE', () => {
    expect(pricingBasisFor({ via: 'printed-pack', ocrPerWeight: true, itemHasEachMeasure: true })).toBe('CASE')
  })
  it('an UNBRIDGED per-weight line keeps today’s UOM path', () => {
    expect(pricingBasisFor({ via: 'rate', ocrPerWeight: true, itemHasEachMeasure: false })).toBe('WEIGHT')
    expect(pricingBasisFor({ via: 'item-pack', ocrPerWeight: true, itemHasEachMeasure: false })).toBe('WEIGHT')
  })
  it('a plain case line → CASE', () => {
    expect(pricingBasisFor({ via: 'printed-pack', ocrPerWeight: false, itemHasEachMeasure: false })).toBe('CASE')
    expect(pricingBasisFor({ via: 'item-pack', ocrPerWeight: false, itemHasEachMeasure: true })).toBe('CASE')
  })
})

describe('money invariant: received quantity × $/base = line total (real North Arm Farms lines)', () => {
  const cases = [
    { name: 'eggplant 12 lb @ 3.49', em: { q: 0.4, u: 'lb' }, qty: 12, rate: 3.49, total: 41.88 },
    { name: 'kale 5 lb @ 5.99',      em: { q: 0.5, u: 'lb' }, qty: 5,  rate: 5.99, total: 29.95 },
    { name: 'lettuce 7.5 lb @ 5.25', em: { q: 250, u: 'g' },  qty: 7.5, rate: 5.25, total: 39.38 },
  ]
  for (const c of cases) it(c.name, () => {
    const item = asChainItem({ dimension: 'COUNT', baseUnit: 'each', packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 50 }, eachMeasureQty: c.em.q, eachMeasureUnit: c.em.u })
    const got = lineReceived({ rawQty: c.qty, rawUnit: 'lb', totalQty: c.qty, totalQtyUOM: 'lb', rate: c.rate, rateUOM: 'lb', rawUnitPrice: c.rate, rawLineTotal: c.total }, item)
    expect(['billed-weight', 'shipped-unit']).toContain(got.via)
    const ppb = ratePerBase(c.rate, 'lb', item)
    expect(Math.abs(got.base * ppb - c.total)).toBeLessThanOrEqual(Math.max(0.02, c.total * 0.02))
  })
})

describe('packIsTheQuantity — whose pack is the offer chain built from?', () => {
  // The printed "pack" of a weight-priced line is the QUANTITY SOLD only when the
  // rate is denominated in another dimension than the item: `1 × 12 lb` on an
  // item counted in `each` is 12 pounds delivered, not a case of 5,443 each.
  const eggplant = { dimension: 'COUNT', baseUnit: 'each' }   // bridged COUNT item
  const sausage  = { dimension: 'MASS',  baseUnit: 'g' }      // measured item that also carries an each-measure

  it('eggplant: a $/lb rate on a COUNT item → keep the chain we already hold', () => {
    expect(packIsTheQuantity({ isUomMode: true, rateUnit: 'lb', item: eggplant })).toBe(true)
  })
  it('sausage: a $/kg rate on a MASS item → refresh the offer chain from the line, as before this branch', () => {
    expect(packIsTheQuantity({ isUomMode: true, rateUnit: 'kg', item: sausage })).toBe(false)
    // …including the $/lb spelling of the same dimension.
    expect(packIsTheQuantity({ isUomMode: true, rateUnit: 'LB', item: sausage })).toBe(false)
  })
  it('brioche: a CASE-priced line is never "the pack is the quantity"', () => {
    expect(packIsTheQuantity({ isUomMode: false, rateUnit: 'lb', item: eggplant })).toBe(false)
    expect(packIsTheQuantity({ isUomMode: false, rateUnit: 'kg', item: sausage })).toBe(false)
  })
  it('an item with no stored dimension falls back to its baseUnit', () => {
    expect(packIsTheQuantity({ isUomMode: true, rateUnit: 'lb', item: { baseUnit: 'each' } })).toBe(true)
    expect(packIsTheQuantity({ isUomMode: true, rateUnit: 'lb', item: { baseUnit: 'g' } })).toBe(false)
    // Nothing to derive a dimension from → not cross-dimension (the old behaviour).
    expect(packIsTheQuantity({ isUomMode: true, rateUnit: 'lb', item: {} })).toBe(false)
  })
})

describe('nonEmptyOfferChain — an offer must never be stored unpriceable', () => {
  it('keeps a usable chain untouched', () => {
    expect(nonEmptyOfferChain([{ unit: 'case', per: 24 }], 'case')).toEqual([{ unit: 'case', per: 24 }])
  })
  it('an EMPTY chain would read as $0 (offerPricePerBase) — fall back to one container', () => {
    expect(nonEmptyOfferChain([], 'case')).toEqual([{ unit: 'case', per: 1 }])
    expect(nonEmptyOfferChain(null, 'tray')).toEqual([{ unit: 'tray', per: 1 }])
    expect(nonEmptyOfferChain(undefined, '')).toEqual([{ unit: 'case', per: 1 }])
  })
  it('a BROKEN link (per 0) is left alone — a RATE prices without the chain', () => {
    // Replacing it would hand packReference an invented "1 container" to compare
    // the next invoice's pack against, and that line would be skipped.
    expect(nonEmptyOfferChain([{ unit: 'case', per: 0 }], 'case')).toEqual([{ unit: 'case', per: 0 }])
  })
})

describe('weightBasisRate — what a WEIGHT-basis line’s rate really is', () => {
  // Eggplant: 1 each = 0.4 lb, so 30 each received == 12 lb.
  const eggplant = { dimension: 'COUNT' as const, baseUnit: 'each', eachMeasure: { qty: 0.4, unit: 'lb' }, densityGPerMl: null }
  const base = { receivedBase: 30, rateUnit: 'lb', item: eggplant, rawLineTotal: 41.88 }

  it('a printed rate whose rateUOM is a measure unit is trusted', () => {
    expect(weightBasisRate({ ...base, rate: 3.49, rateUOM: 'lb', fallback: 3.49 }))
      .toEqual({ rate: 3.49, source: 'printed' })
  })
  it('a per-CASE rate is NOT a $/lb rate — derive it from the line total', () => {
    // `1 CS @ 41.88` shipped as "12 LB": rate 41.88 with rateUOM 'CS' would have
    // been written as $41.88/lb = $16.75/each.
    const got = weightBasisRate({ ...base, rate: 41.88, rateUOM: 'CS', fallback: 41.88 })
    expect(got.source).toBe('derived')
    expect(got.rate).toBeCloseTo(3.49, 6)
  })
  it('a unit-less printed rate that reconciles with the line total is trusted', () => {
    expect(weightBasisRate({ ...base, rate: 3.49, rateUOM: null, fallback: 3.49 }))
      .toEqual({ rate: 3.49, source: 'reconciled' })
  })
  it('a unit-less printed rate that does NOT reconcile is derived instead', () => {
    const got = weightBasisRate({ ...base, rate: 41.88, rateUOM: '', fallback: 41.88 })
    expect(got.source).toBe('derived')
    expect(got.rate).toBeCloseTo(3.49, 6)
  })
  it('nothing to derive from → the caller’s own value, unchanged', () => {
    expect(weightBasisRate({ ...base, rawLineTotal: null, rate: null, rateUOM: null, fallback: 3.49 }))
      .toEqual({ rate: 3.49, source: 'fallback' })
    // An item the rate cannot be bridged to: no quantity in the rate's unit.
    expect(weightBasisRate({
      ...base, item: { dimension: 'COUNT' as const, baseUnit: 'each', eachMeasure: null, densityGPerMl: null },
      rate: null, rateUOM: null, fallback: 2,
    })).toEqual({ rate: 2, source: 'fallback' })
  })
  it('bison-shaped input (a same-dimension $/kg rate) comes back untouched', () => {
    // The route only calls this for `billed-weight` / `shipped-unit` lines, so a
    // via:'rate' line never reaches it — and it would be a no-op if it did.
    const beef = { dimension: 'MASS' as const, baseUnit: 'g', eachMeasure: null, densityGPerMl: null }
    expect(weightBasisRate({ rate: 15.95, rateUOM: 'kg', rawLineTotal: 232.87, receivedBase: 14600, rateUnit: 'kg', item: beef, fallback: 15.95 }))
      .toEqual({ rate: 15.95, source: 'printed' })
  })

  it('invariant: received × $/base == the line total for every WEIGHT-basis shape', () => {
    const shapes = [
      { rate: 3.49,  rateUOM: 'lb' },
      { rate: 41.88, rateUOM: 'CS' },
      { rate: 3.49,  rateUOM: null },
      { rate: null,  rateUOM: null },
    ]
    for (const s of shapes) {
      const chosen = weightBasisRate({ ...base, rate: s.rate, rateUOM: s.rateUOM, fallback: 3.49 })
      const ppb = ratePerBase(chosen.rate, 'lb', eggplant)
      expect(Math.abs(30 * ppb - 41.88)).toBeLessThanOrEqual(41.88 * 0.02)
    }
  })
})
