import { describe, it, expect } from 'vitest'
import { prepDayKey, prepDayStart, prepDayFrom, prepDayRange, prepDaysAgo } from '../prep-day'

// Every expectation below is independent of the machine's timezone: the inputs
// are absolute instants and the outputs are UTC-midnight markers.
describe('prepDayKey — restaurant (Pacific) calendar day', () => {
  it('does not roll over at UTC midnight during evening service (PDT)', () => {
    // 5:00pm PDT on Aug 14 — the exact instant the old server-local (UTC) rule
    // flipped the prep day to the 15th mid-service.
    expect(prepDayKey(new Date('2026-08-15T00:00:00Z'))).toBe('2026-08-14')
    expect(prepDayKey(new Date('2026-08-15T06:59:00Z'))).toBe('2026-08-14') // 23:59 PDT
  })

  it('rolls over at Pacific midnight', () => {
    expect(prepDayKey(new Date('2026-08-15T07:00:00Z'))).toBe('2026-08-15') // 00:00 PDT
  })

  it('tracks the DST offset in winter (PST, UTC−8)', () => {
    expect(prepDayKey(new Date('2026-01-15T07:59:00Z'))).toBe('2026-01-14') // 23:59 PST
    expect(prepDayKey(new Date('2026-01-15T08:00:00Z'))).toBe('2026-01-15') // 00:00 PST
  })
})

describe('prepDayStart — the stored marker', () => {
  it('is UTC midnight of the restaurant day, not the local instant', () => {
    expect(prepDayStart(new Date('2026-08-15T06:59:00Z')).toISOString()).toBe('2026-08-14T00:00:00.000Z')
    expect(prepDayStart(new Date('2026-08-15T07:00:00Z')).toISOString()).toBe('2026-08-15T00:00:00.000Z')
  })
})

describe('prepDayFrom — normalizing caller input', () => {
  it('takes a bare YYYY-MM-DD as the day itself', () => {
    // new Date('2026-08-14') is 5pm Pacific on the 13th — re-deriving a Pacific
    // day from it would silently shift a history query back one day.
    expect(prepDayFrom('2026-08-14').toISOString()).toBe('2026-08-14T00:00:00.000Z')
  })

  it('resolves a full ISO instant through the restaurant clock', () => {
    expect(prepDayFrom('2026-08-15T07:00:00.000Z').toISOString()).toBe('2026-08-15T00:00:00.000Z')
    expect(prepDayFrom('2026-08-15T06:00:00.000Z').toISOString()).toBe('2026-08-14T00:00:00.000Z')
  })

  it('accepts a Date', () => {
    expect(prepDayFrom(new Date('2026-08-15T07:00:00Z')).toISOString()).toBe('2026-08-15T00:00:00.000Z')
  })

  it('falls back to today for null / empty / garbage', () => {
    const today = prepDayStart().toISOString()
    expect(prepDayFrom(null).toISOString()).toBe(today)
    expect(prepDayFrom('').toISOString()).toBe(today)
    expect(prepDayFrom('not-a-date').toISOString()).toBe(today)
  })
})

describe('prepDayRange', () => {
  it('is half-open and exactly 24h wide', () => {
    const { gte, lt } = prepDayRange('2026-08-14')
    expect(gte.toISOString()).toBe('2026-08-14T00:00:00.000Z')
    expect(lt.toISOString()).toBe('2026-08-15T00:00:00.000Z')
  })

  it('stays 24h wide across a DST boundary — markers are UTC, not local', () => {
    // 8 Mar 2026 is the PST→PDT spring-forward; the local day is 23h long, the
    // marker range must not be.
    const { gte, lt } = prepDayRange('2026-03-08')
    expect(lt.getTime() - gte.getTime()).toBe(86_400_000)
  })
})

describe('prepDaysAgo', () => {
  it('counts back whole prep days from the day containing `from`', () => {
    expect(prepDaysAgo(7, new Date('2026-08-15T06:59:00Z')).toISOString()).toBe('2026-08-07T00:00:00.000Z')
    expect(prepDaysAgo(0, new Date('2026-08-15T07:00:00Z')).toISOString()).toBe('2026-08-15T00:00:00.000Z')
  })
})
