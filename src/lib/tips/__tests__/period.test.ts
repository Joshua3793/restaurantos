import { describe, it, expect } from 'vitest'
import {
  periodDays, dayLabels, dayIndexOf, previousPeriodStart,
  nextPeriodStart, defaultPeriodStart, periodLabel, addDays,
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

/**
 * These two are what the /tips ‹ › stepper steps by. They were exported and
 * imported by nothing while the page could only ever open one period.
 */
describe('period navigation', () => {
  it('steps back and forward by a whole period', () => {
    expect(previousPeriodStart('2026-07-12', 14)).toBe('2026-06-28')
    expect(nextPeriodStart('2026-07-12', 14)).toBe('2026-07-26')
  })

  it('lands on a CONTIGUOUS window — no gap, no overlap with the one it left', () => {
    // The next window must start the day after this one's last day, or the
    // stepper would skip or double-count a day's sales.
    for (const count of [7, 14, 28]) {
      const start = '2026-07-12'
      const lastDay = periodDays(start, count)[count - 1]
      expect(nextPeriodStart(start, count)).toBe(addDays(lastDay, 1))
      expect(addDays(previousPeriodStart(start, count), count)).toBe(start)
    }
  })

  it('round-trips: forward then back returns to where it started', () => {
    for (const count of [7, 14, 28]) {
      expect(previousPeriodStart(nextPeriodStart('2026-07-12', count), count)).toBe('2026-07-12')
      expect(nextPeriodStart(previousPeriodStart('2026-07-12', count), count)).toBe('2026-07-12')
    }
  })

  it('steps by the window it is given, over a month and a year boundary', () => {
    expect(previousPeriodStart('2026-01-04', 14)).toBe('2025-12-21')
    expect(nextPeriodStart('2025-12-21', 14)).toBe('2026-01-04')
    // A 7-day house rule steps 7, whatever a 14-day period once used.
    expect(nextPeriodStart('2026-07-12', 7)).toBe('2026-07-19')
  })

  it('crosses a DST transition without slipping a day', () => {
    // 2026-11-01 is the North American fall-back Sunday.
    expect(nextPeriodStart('2026-10-25', 14)).toBe('2026-11-08')
    expect(previousPeriodStart('2026-11-08', 14)).toBe('2026-10-25')
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

describe('defaultPeriodStart — non-Sunday anchors', () => {
  // 2026-07-31 is a Friday (getUTCDay() === 5).
  const today = '2026-07-31'
  const count = 14
  const nonZeroDows = [1, 6] // Monday, Saturday

  for (const startDow of nonZeroDows) {
    it(`lands on the configured weekday (startDow=${startDow})`, () => {
      const result = defaultPeriodStart(today, startDow, count)
      expect(new Date(result + 'T12:00:00Z').getUTCDay()).toBe(startDow)
    })

    it(`never returns a date after today, and today falls inside the window (startDow=${startDow})`, () => {
      const result = defaultPeriodStart(today, startDow, count)
      expect(result <= today).toBe(true)
      expect(today <= addDays(result, count - 1)).toBe(true)
    })

    it(`tiles the next period exactly \`count\` days later, with no gap or overlap (startDow=${startDow})`, () => {
      const shiftedToday = addDays(today, count)
      const a = defaultPeriodStart(today, startDow, count)
      const b = defaultPeriodStart(shiftedToday, startDow, count)
      expect(addDays(a, count)).toBe(b)
    })

    it(`stays constant across a period and jumps by \`count\` at the boundary (startDow=${startDow})`, () => {
      const boundary = defaultPeriodStart(today, startDow, count)
      // Every day within [boundary, boundary + count - 1] must resolve back to boundary.
      for (let i = 0; i < count; i++) {
        expect(defaultPeriodStart(addDays(boundary, i), startDow, count)).toBe(boundary)
      }
      // The day right before the boundary belongs to the previous period.
      const prevDay = addDays(boundary, -1)
      expect(defaultPeriodStart(prevDay, startDow, count)).toBe(addDays(boundary, -count))
      // The day right after the window belongs to the next period.
      const nextDay = addDays(boundary, count)
      expect(defaultPeriodStart(nextDay, startDow, count)).toBe(nextDay)
    })
  }

  // Concrete anchored values, hand-derived (not read off the implementation):
  // 2026-07-31 is a Friday (day 5). For startDow=1 (Monday), back = (5-1+7)%7 = 4,
  // so the window opens on 2026-07-27 (Mon). The epoch-week tiling lands offset=0
  // there, so the result is exactly that Monday: 2026-07-27.
  it('anchors to a literal date for a Monday start', () => {
    expect(defaultPeriodStart(today, 1, count)).toBe('2026-07-27')
  })

  // For startDow=6 (Saturday), back = (5-6+7)%7 = 6, so the naive "most recent
  // Saturday" is 2026-07-25. The epoch-week tiling for a 14-day span lands
  // offset=1 there, pulling it back one more 7-day span to 2026-07-18.
  it('anchors to a literal date for a Saturday start', () => {
    expect(defaultPeriodStart(today, 6, count)).toBe('2026-07-18')
  })
})

describe('periodLabel', () => {
  it('renders the mock header string', () => {
    expect(periodLabel('2026-07-12', 14)).toBe('Sun Jul 12 → Sat Jul 25 · 2026')
  })
})
