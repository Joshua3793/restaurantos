import { describe, it, expect } from 'vitest'
import { resolveItemBound, type BoundSession } from '../cogs-bounds'
import { snapshotSourceOf } from '../count-snapshot-source'

const d = (s: string) => new Date(`${s}T00:00:00.000Z`)
const snap = (inventoryItemId: string, totalValue: number, source: string, category = 'DRY') =>
  ({ inventoryItemId, totalValue, category, source })

const jun30: BoundSession = {
  id: 'jun30', type: 'FULL', sessionDate: d('2026-06-30'), finalizedAt: d('2026-06-30'),
  snapshots: [snap('a', 100, 'COUNTED'), snap('b', 50, 'COUNTED', 'MEAT'), snap('c', 10, 'COUNTED')],
}
// A prep-only count typed FULL: only `a` counted, the rest carried the theoretical qty.
const jul31: BoundSession = {
  id: 'jul31', type: 'FULL', sessionDate: d('2026-07-31'), finalizedAt: d('2026-08-01'),
  snapshots: [snap('a', 120, 'COUNTED'), snap('b', 999, 'THEORETICAL', 'MEAT'), snap('c', 999, 'THEORETICAL'), snap('d', 999, 'THEORETICAL')],
}
const quickAug2: BoundSession = {
  id: 'q', type: 'QUICK', sessionDate: d('2026-08-02'), finalizedAt: d('2026-08-02'),
  snapshots: [snap('b', 75, 'COUNTED', 'MEAT')],
}

describe('resolveItemBound — per-item latest observation inside the latest FULL universe', () => {
  it('returns null when no FULL count precedes the bound', () => {
    expect(resolveItemBound([quickAug2], d('2026-08-31').getTime())).toBeNull()
    expect(resolveItemBound([jun30], d('2026-06-01').getTime())).toBeNull()
  })

  it('a fully counted session values itself', () => {
    const b = resolveItemBound([jun30], d('2026-07-01').getTime())!
    expect(b.sessionId).toBe('jun30')
    expect(b.value).toBe(160)
    expect(b.byCategory).toEqual({ DRY: 110, MEAT: 50 })
    expect(b.itemsTotal).toBe(3)
    expect(b.itemsFromBound).toBe(3)
    expect(b.itemsFromOtherCounts).toBe(0)
    expect(b.itemsUnobserved).toBe(0)
  })

  it('theoretical rows never enter the value; earlier observations fill the gaps', () => {
    const b = resolveItemBound([jun30, jul31], d('2026-07-31').getTime())!
    expect(b.sessionId).toBe('jul31')
    expect(b.sessionDate).toEqual(d('2026-07-31'))
    // a from Jul 31 (120), b + c from Jun 30 (50 + 10); d never observed.
    expect(b.value).toBe(180)
    expect(b.byCategory).toEqual({ DRY: 130, MEAT: 50 })
    expect(b.itemsTotal).toBe(4)
    expect(b.itemsFromBound).toBe(1)
    expect(b.itemsFromOtherCounts).toBe(2)
    expect(b.itemsUnobserved).toBe(1)
    expect(b.earliestObservation).toEqual(d('2026-06-30'))
  })

  it('a later quick count (still ≤ bound) supersedes the full count for its item', () => {
    const b = resolveItemBound([jun30, jul31, quickAug2], d('2026-08-31').getTime())!
    expect(b.sessionId).toBe('jul31')       // the universe/date still come from the FULL count
    expect(b.value).toBe(120 + 75 + 10)
  })

  it('a quick count after the bound date is ignored', () => {
    const b = resolveItemBound([jun30, jul31, quickAug2], d('2026-08-01').getTime())!
    expect(b.value).toBe(180)
  })

  it('CARRIED reads as an observation; SKIPPED does not', () => {
    const s: BoundSession = {
      id: 's', type: 'FULL', sessionDate: d('2026-08-01'), finalizedAt: null,
      snapshots: [snap('a', 5, 'CARRIED'), snap('b', 7, 'SKIPPED')],
    }
    const b = resolveItemBound([jun30, s], d('2026-08-01').getTime())!
    expect(b.value).toBe(5 + 50)             // b falls back to Jun 30's count, not the skipped row
    expect(b.itemsFromOtherCounts).toBe(1)
  })

  it('same-day sessions: the later finalize wins', () => {
    const early = { ...jul31, id: 'early', finalizedAt: d('2026-07-31'), snapshots: [snap('a', 1, 'COUNTED')] }
    const late  = { ...jul31, id: 'late',  finalizedAt: d('2026-08-01'), snapshots: [snap('a', 2, 'COUNTED')] }
    expect(resolveItemBound([early, late], d('2026-07-31').getTime())!.value).toBe(2)
  })
})

describe('snapshotSourceOf — the one classification rule', () => {
  it('maps the four line states', () => {
    expect(snapshotSourceOf({ skipped: true,  countedQty: 3,    carriedForward: false })).toBe('SKIPPED')
    expect(snapshotSourceOf({ skipped: false, countedQty: null, carriedForward: false })).toBe('THEORETICAL')
    expect(snapshotSourceOf({ skipped: false, countedQty: 3,    carriedForward: true  })).toBe('CARRIED')
    expect(snapshotSourceOf({ skipped: false, countedQty: 3,    carriedForward: false })).toBe('COUNTED')
  })
})
