import { describe, it, expect } from 'vitest'
import { cadenceStats, cadenceNudge, shelfLifeCap, keepableQty, CADENCE_MIN_MAKES } from '../prep-cadence'

const now = new Date('2026-09-06T14:00:00.000Z')
const day = (d: number) => new Date(Date.parse('2026-09-06T00:00:00.000Z') - d * 86_400_000).toISOString()
const log = (daysAgo: number, qty: number | null) => ({ logDate: day(daysAgo), actualPrepQty: qty })

describe('cadenceStats — the make history, summarised', () => {
  it('needs at least three makes for a median; fewer keeps only lastMadeAt', () => {
    expect(cadenceStats([], now)).toMatchObject({ makes: 0, medianIntervalDays: null, lastMadeAt: null })
    const two = cadenceStats([log(7, 4), log(4, 4)], now)
    expect(two).toMatchObject({ makes: 2, medianIntervalDays: null, medianQty: null, dueByCadenceAt: null, usagePerDayEst: null })
    expect(two.lastMadeAt).toBe(day(4))
    expect(CADENCE_MIN_MAKES).toBe(3)
  })
  it('made every 3 days, last 4 days ago → due yesterday, usage = qty / interval', () => {
    const s = cadenceStats([log(13, 6), log(10, 5), log(7, 6), log(4, 6)], now)
    expect(s.makes).toBe(4)
    expect(s.medianIntervalDays).toBe(3)
    expect(s.medianQty).toBe(6)
    expect(s.lastMadeAt).toBe(day(4))
    expect(s.dueByCadenceAt).toBe(day(1))
    expect(s.usagePerDayEst).toBe(2)
  })
  it('ignores rows with no yield and takes Decimal-as-string', () => {
    const s = cadenceStats([log(9, null), log(6, '3' as unknown as number), log(3, 0), log(3, 3), log(0, 3)], now)
    expect(s.makes).toBe(3)
    expect(s.medianIntervalDays).toBe(3)
  })
  it('median, not mean — one long gap does not stretch the rhythm', () => {
    const s = cadenceStats([log(30, 5), log(6, 5), log(3, 5), log(0, 5)], now)
    expect(s.medianIntervalDays).toBe(3)
  })
})

describe('cadenceNudge — only ever raises TMRW → CLOSE', () => {
  const due = cadenceStats([log(13, 6), log(10, 5), log(7, 6), log(4, 6)], now)        // due yesterday
  const fresh = cadenceStats([log(9, 6), log(6, 5), log(3, 6), log(0, 6)], now)         // made today, due in 3d

  it('raises an at-par item that is due by its rhythm, with the reason', () => {
    expect(cadenceNudge('TMRW', due, now)).toEqual({ urgency: 'CLOSE', reason: 'usually every 3d · last made 4d ago' })
  })
  it('leaves an item not yet due alone', () => {
    expect(cadenceNudge('TMRW', fresh, now)).toEqual({ urgency: 'TMRW', reason: null })
  })
  it('never touches PASS / MID / CLOSE, and never lowers', () => {
    for (const u of ['PASS', 'MID', 'CLOSE'] as const) {
      expect(cadenceNudge(u, due, now)).toEqual({ urgency: u, reason: null })
    }
  })
  it('does nothing without stats', () => {
    expect(cadenceNudge('TMRW', null, now)).toEqual({ urgency: 'TMRW', reason: null })
    expect(cadenceNudge('TMRW', cadenceStats([log(4, 6)], now), now)).toEqual({ urgency: 'TMRW', reason: null })
  })
  it('formats a fractional rhythm', () => {
    const s = cadenceStats([log(14, 6), log(11, 6), log(9, 6), log(6, 6)], now)  // 3, 2, 3 → median 3; make it 2.5
    const s25 = { ...s, medianIntervalDays: 2.5, dueByCadenceAt: day(1) }
    expect(cadenceNudge('TMRW', s25, now).reason).toBe('usually every 2.5d · last made 6d ago')
  })
})

describe('shelfLifeCap — never suggest more than will keep', () => {
  it('caps at usage × shelf life, floored at one step', () => {
    expect(shelfLifeCap(10, 2, 2)).toBe(4)
    expect(shelfLifeCap(10, 2, 2, 0.5)).toBe(4)
    expect(shelfLifeCap(10, 1, 0.1, 0.5)).toBe(0.5)     // cap 0.1 < one step
  })
  it('no-op when either input is missing, or the suggestion is already inside', () => {
    expect(shelfLifeCap(10, null, 2)).toBe(10)
    expect(shelfLifeCap(10, 2, null)).toBe(10)
    expect(shelfLifeCap(3, 2, 2)).toBe(3)
    expect(shelfLifeCap(0, 2, 2)).toBe(0)
  })
  it('keepableQty is the same product, null when unknown', () => {
    expect(keepableQty(2, 2)).toBe(4)
    expect(keepableQty(null, 2)).toBeNull()
    expect(keepableQty(2, 0)).toBeNull()
  })
})
