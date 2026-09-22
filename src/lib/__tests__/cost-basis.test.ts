import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
import { foldCostBasis, costWindow, COST_WINDOW_DAYS } from '@/lib/cost-basis'

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
