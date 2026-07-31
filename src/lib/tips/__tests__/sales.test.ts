import { describe, it, expect } from 'vitest'
import { foldDailyTotals } from '@/lib/tips/sales'

const DAYS = ['2026-07-12', '2026-07-13', '2026-07-14']

function row(
  date: string, rc: string, total: number,
  opts: { tips?: number | null; grat?: number | null; source?: string; periodType?: string } = {},
) {
  return {
    date: new Date(date + 'T12:00:00.000Z'),
    revenueCenterId: rc,
    totalRevenue: total,
    tipsCollected: opts.tips === undefined ? null : opts.tips,
    autoGratuity: opts.grat === undefined ? null : opts.grat,
    source: opts.source ?? 'manual',
    periodType: opts.periodType ?? 'day',
  }
}

describe('foldDailyTotals', () => {
  it('sums every revenue center in scope onto its day', () => {
    const r = foldDailyTotals(
      [row('2026-07-12', 'kitchen', 100), row('2026-07-12', 'bar', 50), row('2026-07-13', 'kitchen', 80)],
      DAYS,
    )
    expect(r.net).toEqual([150, 80, 0])
  })

  it('reports days with no entry at all, not days that genuinely sold nothing', () => {
    const r = foldDailyTotals([row('2026-07-12', 'kitchen', 100), row('2026-07-13', 'kitchen', 0)], DAYS)
    expect(r.missingSalesDays).toEqual([2])
  })

  it('keeps the Toast row when a manual row shadows it', () => {
    const r = foldDailyTotals(
      [row('2026-07-12', 'kitchen', 100, { source: 'manual' }), row('2026-07-12', 'kitchen', 120, { source: 'toast' })],
      DAYS,
    )
    expect(r.net[0]).toBe(120)
  })

  it('ignores multi-day period rows so one week entry cannot inflate a single day', () => {
    const r = foldDailyTotals(
      [row('2026-07-12', 'kitchen', 100), row('2026-07-12', 'kitchen', 9000, { periodType: 'week' })],
      DAYS,
    )
    expect(r.net[0]).toBe(100)
  })

  it('rounds to the cent', () => {
    const r = foldDailyTotals([row('2026-07-12', 'a', 10.005), row('2026-07-12', 'b', 10.005)], DAYS)
    expect(r.net[0]).toBe(20.01)
  })

  it('sums tips across the scope and reports days with no tip data as null', () => {
    const r = foldDailyTotals(
      [row('2026-07-12', 'kitchen', 100, { tips: 18 }), row('2026-07-12', 'bar', 50, { tips: 7 }),
       row('2026-07-13', 'kitchen', 80)],
      DAYS,
    )
    expect(r.tips).toEqual([25, null, null])
    expect(r.missingTipDays).toEqual([1, 2])
  })

  it('distinguishes a day that took zero tips from a day with no tip data', () => {
    const r = foldDailyTotals(
      [row('2026-07-12', 'kitchen', 100, { tips: 0 }), row('2026-07-13', 'kitchen', 80)],
      DAYS,
    )
    expect(r.tips[0]).toBe(0)
    expect(r.tips[1]).toBeNull()
    expect(r.missingTipDays).toEqual([1, 2])
  })

  it('counts a day as having tip data when at least one revenue center reports it', () => {
    const r = foldDailyTotals(
      [row('2026-07-12', 'kitchen', 100, { tips: 18 }), row('2026-07-12', 'bar', 50)],
      DAYS,
    )
    expect(r.tips[0]).toBe(18)
    expect(r.missingTipDays).not.toContain(0)
  })

  it('adds auto-gratuity to the tip pot only when the house counts it', () => {
    const rows = [row('2026-07-12', 'kitchen', 100, { tips: 18, grat: 30 })]
    expect(foldDailyTotals(rows, DAYS, true).tips[0]).toBe(48)
    expect(foldDailyTotals(rows, DAYS, false).tips[0]).toBe(18)
  })

  it('still reports a day as having tip data when only auto-gratuity was charged', () => {
    const rows = [row('2026-07-12', 'kitchen', 100, { grat: 30 })]
    expect(foldDailyTotals(rows, DAYS, true).tips[0]).toBe(30)
    // With auto-grat excluded there is no payment-tip figure at all for that day.
    expect(foldDailyTotals(rows, DAYS, false).tips[0]).toBeNull()
  })
})
