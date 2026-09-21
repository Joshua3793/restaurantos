import { describe, it, expect } from 'vitest'
import { planOfferRepair, type RepairLine } from '@/lib/invoice/offer-repair'
import { asChainItem, type ChainItem } from '@/lib/item-model'

// Real North Arm Farms shape: a by-weight rate ($3.49/lb) saved as a PACK case
// price over a case chain, on a bridged COUNT item. eachMeasure lets the item's
// each be expressed in the rate's unit.
function weightItem(em: { q: number; u: string }, dimension: ChainItem['dimension'] = 'COUNT', baseUnit = 'each'): ChainItem {
  return asChainItem({
    dimension,
    baseUnit,
    packChain: [{ unit: 'case', per: 24 }],
    pricing: { mode: 'PACK', purchasePrice: 50 }, // the item's own price — irrelevant to the offer repair
    eachMeasureQty: em.q,
    eachMeasureUnit: em.u,
  })
}

function weightLine(qty: number, rate: number, total: number, unit = 'lb'): RepairLine {
  return {
    rawQty: qty, rawUnit: unit,
    totalQty: qty, totalQtyUOM: unit,
    rate, rateUOM: unit,
    rawUnitPrice: rate, rawLineTotal: total,
  }
}

describe('planOfferRepair — the three real by-weight-as-PACK offers', () => {
  const cases = [
    { name: 'eggplant 12 lb @ 3.49', em: { q: 0.4, u: 'lb' }, qty: 12, rate: 3.49, total: 41.88 },
    { name: 'kale 5 lb @ 5.99', em: { q: 0.5, u: 'lb' }, qty: 5, rate: 5.99, total: 29.95 },
    { name: 'lettuce burger 7.5 lb @ 5.25', em: { q: 250, u: 'g' }, qty: 7.5, rate: 5.25, total: 39.38 },
  ]
  for (const c of cases) {
    it(`${c.name} → rewrite to RATE ${c.rate}/lb`, () => {
      const item = weightItem(c.em)
      const offer = { pricing: { mode: 'PACK' as const, purchasePrice: c.rate }, lastPrice: c.rate, isPrimary: false }
      const plan = planOfferRepair({ offer, item, lastLine: weightLine(c.qty, c.rate, c.total) })
      expect(plan).toEqual({
        action: 'rewrite',
        pricing: { mode: 'RATE', rate: c.rate, rateUnit: 'lb' },
        lastPrice: c.rate,
      })
    })
  }
})

describe('planOfferRepair — the PRIMARY offer goes to a human (Cilantro FARM)', () => {
  it('a primary offer with a costable weight line → human, never rewritten automatically', () => {
    const item = weightItem({ q: 0.05, u: 'lb' })
    const offer = { pricing: { mode: 'PACK' as const, purchasePrice: 2.5 }, lastPrice: 2.5, isPrimary: true }
    const plan = planOfferRepair({ offer, item, lastLine: weightLine(10, 2.5, 25) })
    expect(plan.action).toBe('human')
    if (plan.action === 'human') {
      expect(plan.reason).toMatch(/primary/i)
    }
  })
})

describe('planOfferRepair — a Sysco case offer is not received by weight → skip', () => {
  it('a plain case line (no billed weight, no shipped weight unit) is left alone', () => {
    const item = weightItem({ q: 0.4, u: 'lb' })
    const offer = { pricing: { mode: 'PACK' as const, purchasePrice: 48 }, lastPrice: 48, isPrimary: false }
    const line: RepairLine = { rawQty: 2, rawUnit: 'CS', invoicePackQty: 24, invoicePackSize: 1, invoicePackUOM: 'each' }
    const plan = planOfferRepair({ offer, item, lastLine: line })
    expect(plan.action).toBe('skip')
    if (plan.action === 'skip') expect(plan.reason).toMatch(/not received by weight/)
  })
})

describe('planOfferRepair — an item with no bridge for the rate unit → skip', () => {
  it('a MASS item with no each-measure cannot cost a case-labelled rate unit', () => {
    // The line itself is received fine (a plain weight shipment on a MASS item
    // needs no bridge at all — "12 lb" converts straight to grams). But its
    // `rateUOM` disagrees with the shipped unit ('CS', a container/count token)
    // and this item, being a plain MASS item, has no each-measure to bridge a
    // COUNT-denominated rate to its base unit — so the rate this offer would be
    // rewritten to can never be costed and must not be silently priced as 0.
    const item = asChainItem({
      dimension: 'MASS', baseUnit: 'g',
      packChain: [{ unit: 'case', per: 9072 }],
      pricing: { mode: 'PACK', purchasePrice: 200 },
      eachMeasureQty: null, eachMeasureUnit: null,
    })
    const offer = { pricing: { mode: 'PACK' as const, purchasePrice: 22 }, lastPrice: 22, isPrimary: false }
    const line: RepairLine = { rawQty: 18.4, rawUnit: 'lb', rate: 41.88, rateUOM: 'CS', rawLineTotal: 41.88 }
    const plan = planOfferRepair({ offer, item, lastLine: line })
    expect(plan.action).toBe('skip')
    if (plan.action === 'skip') expect(plan.reason).toMatch(/no bridge/)
  })
})

describe('planOfferRepair — no purchase line on record → skip', () => {
  it('nothing to repair from', () => {
    const item = weightItem({ q: 0.4, u: 'lb' })
    const offer = { pricing: { mode: 'PACK' as const, purchasePrice: 48 }, lastPrice: 48, isPrimary: false }
    const plan = planOfferRepair({ offer, item, lastLine: null })
    expect(plan).toEqual({ action: 'skip', reason: expect.stringMatching(/no purchase line/) })
  })
})

describe('planOfferRepair — an offer already a weight RATE needs no repair', () => {
  it('skips a per-lb RATE offer, whatever the line looks like', () => {
    const item = weightItem({ q: 0.4, u: 'lb' })
    const offer = { pricing: { mode: 'RATE' as const, rate: 3.49, rateUnit: 'lb' }, lastPrice: 3.49, isPrimary: false }
    const plan = planOfferRepair({ offer, item, lastLine: weightLine(12, 3.49, 41.88) })
    expect(plan.action).toBe('skip')
    if (plan.action === 'skip') expect(plan.reason).toMatch(/already a weight rate/i)
  })
})

describe('planOfferRepair — packChain and the provenance triple are never touched', () => {
  it('the rewrite plan carries only pricing + lastPrice, no packChain field', () => {
    const item = weightItem({ q: 0.4, u: 'lb' })
    const offer = { pricing: { mode: 'PACK' as const, purchasePrice: 3.49 }, lastPrice: 3.49, isPrimary: false }
    const plan = planOfferRepair({ offer, item, lastLine: weightLine(12, 3.49, 41.88) })
    expect(plan.action).toBe('rewrite')
    expect(Object.keys(plan)).toEqual(['action', 'pricing', 'lastPrice'])
  })
})
