import { describe, it, expect } from 'vitest'
import { whyLabel, shortfallReason, type PlanFields } from '../prep-plan'

const base: PlanFields = {
  onHand: 4, parLevel: 4, minThreshold: 0, targetToday: null, manualPriorityOverride: null, unit: 'l',
}

describe('shortfallReason — the deficit a bare "stock out" used to hide', () => {
  it('is silent when the ledger balanced', () => {
    expect(shortfallReason(base)).toBeNull()
    expect(shortfallReason({ ...base, shortfall: 0 })).toBeNull()
    expect(shortfallReason({ ...base, shortfall: 0.001 })).toBeNull()
  })

  it('names the amount, the count it is measured from, and what to do', () => {
    expect(shortfallReason({ ...base, shortfall: 70.11, lastCountDate: '2026-08-01T00:00:00.000Z' }))
      .toBe('70.11 l more used than logged made since the Aug 1 count — count it to reset')
  })

  it('reads the count day as a UTC marker, not through a Pacific clock', () => {
    // 2026-08-01T00:00Z is 5pm on Jul 31 in Pacific; the count is dated Aug 1.
    expect(shortfallReason({ ...base, shortfall: 1, lastCountDate: '2026-08-01T00:00:00.000Z' })).toContain('Aug 1')
  })

  it('falls back to "on record" for a never-counted item', () => {
    expect(shortfallReason({ ...base, shortfall: 2, lastCountDate: null }))
      .toBe('2 l more used than logged made on record — count it to reset')
  })
})

describe('whyLabel carries the shortfall as evidence', () => {
  it('appends it after the stock reason', () => {
    expect(whyLabel({ ...base, shortfall: 66, lastCountDate: '2026-08-01T00:00:00.000Z' }))
      .toBe('at par · 66 l more used than logged made since the Aug 1 count — count it to reset')
    expect(whyLabel({ ...base, onHand: 0, shortfall: 66, lastCountDate: null }))
      .toBe('stock out · 66 l more used than logged made on record — count it to reset')
  })

  it('leaves the label alone when there is no shortfall', () => {
    expect(whyLabel(base)).toBe('at par')
  })

  it('yields to the pipeline and to a chef override, which are the stronger reasons', () => {
    expect(whyLabel({ ...base, shortfall: 66, manualPriorityOverride: 'PASS' })).toMatch(/^chef moved it/)
  })
})
