import { describe, it, expect } from 'vitest'
import { splitLedger, type LedgerEvent } from '@/lib/stock-ledger'

const ev = (type: LedgerEvent['type'], qtyBase: number) => ({ type, qtyBase })

describe('splitLedger', () => {
  it('splits signed events into additions and positive-magnitude consumptions', () => {
    const s = splitLedger([
      ev('PURCHASE', 20238.6),   // 44.61 lb of salmon, in grams
      ev('PREP_OUT', 1000),
      ev('SALE', -500),
      ev('WASTAGE', -250),
      ev('PREP_IN', -9071.84),
    ])
    expect(s.additions).toBeCloseTo(21238.6, 6)
    expect(s.consumptions).toBeCloseTo(9821.84, 6)
    expect(s.transferNet).toBe(0)
  })

  it('holds transfer legs out of BOTH columns — they cancel across revenue centres', () => {
    // The same 5 kg leaving one RC and arriving in another. Counting the legs would
    // report "+5000 added, −5000 used" for stock that never moved in or out.
    const s = splitLedger([ev('TRANSFER', 5000), ev('TRANSFER', -5000), ev('PURCHASE', 100)])
    expect(s.additions).toBe(100)
    expect(s.consumptions).toBe(0)
    expect(s.transferNet).toBe(0)
  })

  it('keeps an unbalanced transfer visible in transferNet rather than dropping it', () => {
    const s = splitLedger([ev('TRANSFER', 5000)])
    expect(s.additions).toBe(0)
    expect(s.consumptions).toBe(0)
    expect(s.transferNet).toBe(5000)
  })

  it('reconciles: opening + additions − consumptions + transferNet === closing', () => {
    const events = [ev('PURCHASE', 20238.6), ev('PREP_IN', -9071.84), ev('TRANSFER', 250)]
    const { additions, consumptions, transferNet } = splitLedger(events)
    const opening = 29483.48
    const closing = events.reduce((a, e) => a + e.qtyBase, opening)
    expect(opening + additions - consumptions + transferNet).toBeCloseTo(closing, 6)
  })

  it('counts a zero-quantity event as neither an addition nor a consumption', () => {
    const s = splitLedger([ev('SALE', 0)])
    expect(s.additions).toBe(0)
    expect(s.consumptions).toBe(0)
  })
})
