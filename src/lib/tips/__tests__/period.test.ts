import { describe, it, expect } from 'vitest'
import {
  periodDays, dayLabels, dayIndexOf, previousPeriodStart,
  nextPeriodStart, defaultPeriodStart, periodLabel,
} from '@/lib/tips/period'

describe('periodDays', () => {
  it('returns 14 consecutive ISO dates from the start', () => {
    const days = periodDays('2026-07-12', 14)
    expect(days).toHaveLength(14)
    expect(days[0]).toBe('2026-07-12')
    expect(days[13]).toBe('2026-07-25')
  })

  it('crosses a month boundary without drifting', () => {
    expect(periodDays('2026-07-26', 14)[13]).toBe('2026-08-08')
  })

  it('crosses the Pacific DST fall-back without losing a day', () => {
    const days = periodDays('2026-10-25', 14)
    expect(days[9]).toBe('2026-11-03')
    expect(days[13]).toBe('2026-11-07')
  })
})

describe('dayLabels', () => {
  it('labels each day "Ddd D" like the mock', () => {
    const labels = dayLabels('2026-07-12', 14)
    expect(labels[0]).toBe('Sun 12')
    expect(labels[6]).toBe('Sat 18')
    expect(labels[13]).toBe('Sat 25')
  })
})

describe('dayIndexOf', () => {
  it('maps an ISO date inside the window to its index', () => {
    expect(dayIndexOf('2026-07-12', '2026-07-12')).toBe(0)
    expect(dayIndexOf('2026-07-12', '2026-07-25')).toBe(13)
  })

  it('returns a negative or out-of-range index outside the window', () => {
    expect(dayIndexOf('2026-07-12', '2026-07-11')).toBe(-1)
    expect(dayIndexOf('2026-07-12', '2026-07-26')).toBe(14)
  })
})

describe('period navigation', () => {
  it('steps back and forward by a whole period', () => {
    expect(previousPeriodStart('2026-07-12', 14)).toBe('2026-06-28')
    expect(nextPeriodStart('2026-07-12', 14)).toBe('2026-07-26')
  })
})

describe('defaultPeriodStart', () => {
  it('snaps back to the most recent period boundary on the configured weekday', () => {
    // 2026-07-31 is a Friday; the containing Sun-start 14-day window opened 2026-07-26
    expect(defaultPeriodStart('2026-07-31', 0, 14)).toBe('2026-07-26')
  })

  it('returns the day itself when it is already the boundary weekday', () => {
    expect(defaultPeriodStart('2026-07-26', 0, 14)).toBe('2026-07-26')
  })
})

describe('periodLabel', () => {
  it('renders the mock header string', () => {
    expect(periodLabel('2026-07-12', 14)).toBe('Sun Jul 12 → Sat Jul 25 · 2026')
  })
})
