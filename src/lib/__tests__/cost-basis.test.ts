import { describe, it, expect, vi, beforeEach } from 'vitest'

const { db } = vi.hoisted(() => ({
  db: { inventoryItem: { findMany: vi.fn() }, invoiceScanItem: { findMany: vi.fn() } }
}))

vi.mock('@/lib/prisma', () => ({ prisma: db }))
import { foldCostBasis, costWindow, COST_WINDOW_DAYS, listedPrice } from '@/lib/cost-basis'

const L = (rawLineTotal: unknown, receivedQtyBase: unknown) => ({ rawLineTotal, receivedQtyBase })

describe('foldCostBasis', () => {
  it('eggplant: NAF 12 lb → 30 each for $41.88 + Sysco 24 each for $70.30 ⇒ $2.077/each', () => {
    const r = foldCostBasis({ lines: [L('41.88', '30'), L('70.30', '24')], lastPricePerBase: 2.929 })
    expect(r.basis).toBe('AVG_30D')
    expect(r.pricePerBase).toBeCloseTo(112.18 / 54, 4)
    expect(r.avg).toMatchObject({ paid: 112.18, received: 54, lines: 2, excluded: 0 })
  })
  it('no qualifying line → LAST, no-purchases, no avg evidence', () => {
    expect(foldCostBasis({ lines: [], lastPricePerBase: 2.93 })).toEqual({ basis: 'LAST', pricePerBase: 2.93, fallbackReason: 'no-purchases' })
  })
  it.each([
    ['credit (negative total)', L('-10', '5')],
    ['negative received', L('10', '-5')],
    ['unpriced line', L(null, '5')],
    ['never frozen', L('10', null)],
    ['zero total', L('0', '5')],
    ['zero received', L('10', '0')],
  ])('%s is excluded from BOTH sums and counted', (_n, bad) => {
    const r = foldCostBasis({ lines: [bad, L('20', '10')], lastPricePerBase: 2 })
    expect(r.avg).toMatchObject({ paid: 20, received: 10, lines: 1, excluded: 1 })
    expect(r.pricePerBase).toBe(2)
  })
  it('only excluded lines → LAST with the evidence counted', () => {
    const r = foldCostBasis({ lines: [L(null, '5')], lastPricePerBase: 3 })
    expect(r).toMatchObject({ basis: 'LAST', pricePerBase: 3, fallbackReason: 'no-purchases', avg: { lines: 0, excluded: 1 } })
  })
  it('average more than 20× ABOVE the last price → LAST, implausible, evidence kept', () => {
    const r = foldCostBasis({ lines: [L('1000', '1')], lastPricePerBase: 2 })
    expect(r).toMatchObject({ basis: 'LAST', pricePerBase: 2, fallbackReason: 'implausible', avg: { pricePerBase: 1000 } })
  })
  it('average more than 20× BELOW the last price → LAST, implausible', () => {
    const r = foldCostBasis({ lines: [L('1', '1000')], lastPricePerBase: 2 })
    expect(r.fallbackReason).toBe('implausible')
  })
  it('exactly 20× is still plausible', () => {
    expect(foldCostBasis({ lines: [L('40', '1')], lastPricePerBase: 2 }).basis).toBe('AVG_30D')
  })
  it('an unpriced item (last = 0) with a plausible average uses the average', () => {
    const r = foldCostBasis({ lines: [L('41.88', '30')], lastPricePerBase: 0 })
    // 41.88 / 30 === 1.3960000000000001 in IEEE-754 double, not the 1.396 literal —
    // toBeCloseTo instead of toMatchObject's exact-equality check on pricePerBase.
    expect(r.basis).toBe('AVG_30D')
    expect(r.pricePerBase).toBeCloseTo(1.396, 4)
  })
})

describe('costWindow', () => {
  it('is the 30 calendar days ending at asOf, start truncated to UTC midnight (purchaseDate is a UTC-midnight date)', () => {
    const w = costWindow(new Date('2026-09-21T18:30:00Z'))
    expect(w.lte.toISOString()).toBe('2026-09-21T18:30:00.000Z')
    expect(w.gte.toISOString()).toBe('2026-08-22T00:00:00.000Z')
    expect(COST_WINDOW_DAYS).toBe(30)
  })
})

import { lastCost, withLastCost, purchaseUnitCost, itemCosts, itemCost } from '@/lib/cost-basis'

// Butter: 1 case = 11,350 g at $142.50 → $0.012555…/g
const BUTTER = {
  id: 'i1', dimension: 'MASS', baseUnit: 'g', countUnit: 'case',
  packChain: [{ unit: 'case', per: 11350 }], pricing: { mode: 'PACK', purchasePrice: 142.5 },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null, recipe: null,
}
// Salmon: priced $28.60/kg, chain 1 lb = 453.6 g (purchase unit is a pound)
const SALMON = {
  id: 'i2', dimension: 'MASS', baseUnit: 'g', countUnit: 'lb',
  packChain: [{ unit: 'lb', per: 453.6 }], pricing: { mode: 'RATE', rate: 28.6, rateUnit: 'kg' },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null, recipe: null,
}

describe('lastCost / withLastCost', () => {
  it('lastCost is the primary chain price per base unit', () => {
    expect(lastCost(BUTTER)).toBeCloseTo(142.5 / 11350, 9)
    expect(lastCost(SALMON)).toBeCloseTo(28.6 / 1000, 9)
  })
  it('withLastCost attaches pricePerBaseUnit and keeps every other field', () => {
    const out = withLastCost(BUTTER)
    expect(out.pricePerBaseUnit).toBeCloseTo(142.5 / 11350, 9)
    expect(out.packChain).toBe(BUTTER.packChain)
  })
})

describe('purchaseUnitCost — the price of ONE top-of-chain unit', () => {
  it('PACK: the box price', () => {
    expect(purchaseUnitCost(BUTTER)).toBeCloseTo(142.5, 9)
  })
  it('RATE: rate × base units in one purchase unit (a pound of $28.60/kg salmon is $12.97, not $28.60)', () => {
    expect(purchaseUnitCost(SALMON)).toBeCloseTo(28.6 * 0.4536, 6)
  })
})

describe('itemCosts / itemCost', () => {
  beforeEach(() => { db.inventoryItem.findMany.mockReset(); db.invoiceScanItem.findMany.mockReset() })

  it('LAST: one findMany, every id priced from its chain', async () => {
    db.inventoryItem.findMany.mockResolvedValueOnce([BUTTER, SALMON])
    const m = await itemCosts(['i1', 'i2'], 'LAST')
    expect(m.get('i1')).toEqual({ basis: 'LAST', pricePerBase: lastCost(BUTTER) })
    expect(m.get('i2')).toEqual({ basis: 'LAST', pricePerBase: lastCost(SALMON) })
    expect(db.invoiceScanItem.findMany).not.toHaveBeenCalled()
  })

  it('AVG_30D: averages receipts in the window and falls back to LAST with reason prep-linked for a prep output', async () => {
    const PREP = { ...SALMON, id: 'p1', recipe: { id: 'r1' } }
    // windowedAvgCost: items (recipe: null) then lines; the fill-in query for prep-linked ids
    db.inventoryItem.findMany
      .mockResolvedValueOnce([BUTTER])                 // windowedAvgCost items (recipe: null)
      .mockResolvedValueOnce([PREP])                   // fill-in for ids it did not return
    db.invoiceScanItem.findMany.mockResolvedValueOnce([
      { matchedItemId: 'i1', rawLineTotal: '100', receivedQtyBase: '10000' },  // $0.01/g
    ])
    const m = await itemCosts(['i1', 'p1'], 'AVG_30D')
    expect(m.get('i1')).toMatchObject({ basis: 'AVG_30D', pricePerBase: 0.01 })
    expect(m.get('p1')).toEqual({ basis: 'LAST', pricePerBase: lastCost(PREP), fallbackReason: 'prep-linked' })
  })

  it('itemCost returns null for an unknown id', async () => {
    db.inventoryItem.findMany.mockResolvedValueOnce([])
    expect(await itemCost('nope', 'LAST')).toBeNull()
  })
})

describe('listedPrice — the number the legacy purchasePrice column held', () => {
  it('PACK: the box price', () => { expect(listedPrice(BUTTER)).toBe(142.5) })
  it('RATE: the rate itself, not the purchase-unit cost', () => { expect(listedPrice(SALMON)).toBe(28.6) })
})
