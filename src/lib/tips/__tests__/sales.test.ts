import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TipSettings, User } from '@prisma/client'

// resolveSalesScopeRcIds reads Location/RevenueCenter and the caller's own
// UserScope. Both are stubbed; `foldDailyTotals` and `applyOverride` below are
// pure and unaffected by the mocks.
const locationFindUnique = vi.fn(
  async () => null as { name: string; revenueCenters: Array<{ id: string }> } | null,
)
const revenueCenterFindMany = vi.fn(async () => [] as Array<{ id: string; name: string }>)
const resolveScopedRcIds = vi.fn(async () => null as Set<string> | null)

vi.mock('@/lib/prisma', () => ({
  prisma: {
    location: { findUnique: (...a: unknown[]) => locationFindUnique(...(a as [])) },
    revenueCenter: { findMany: (...a: unknown[]) => revenueCenterFindMany(...(a as [])) },
  },
}))
vi.mock('@/lib/rc-scope', () => ({
  resolveScopedRcIds: (...a: unknown[]) => resolveScopedRcIds(...(a as [])),
}))

const { applyOverride, foldDailyTotals, resolveSalesScopeRcIds } = await import('@/lib/tips/sales')

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

/**
 * THE CONFIGURED SCOPE MUST NOT DEPEND ON WHO IS LOOKING.
 *
 * This resolver used to intersect the house's configured sales scope with the
 * caller's own UserScope. The basis a payment FREEZES then depended on which
 * manager clicked Pay: a manager scoped to the kitchen RC alone froze a pool
 * summed over that RC, while an unscoped admin froze the whole location — same
 * period, same button, two different sets of envelopes, and no error anywhere
 * because the narrower RCs do have sales rows.
 */
describe('resolveSalesScopeRcIds', () => {
  const settings = (over: Partial<TipSettings>) => ({
    salesSourceMode: 'LOCATION', salesLocationId: null, salesRcIds: [],
    ...over,
  } as Pick<TipSettings, 'salesSourceMode' | 'salesLocationId' | 'salesRcIds'>)
  const user = { id: 'u1', role: 'MANAGER' } as unknown as User

  beforeEach(() => {
    locationFindUnique.mockClear(); locationFindUnique.mockResolvedValue(null)
    revenueCenterFindMany.mockClear(); revenueCenterFindMany.mockResolvedValue([])
    resolveScopedRcIds.mockClear(); resolveScopedRcIds.mockResolvedValue(null)
  })

  it('LOCATION mode resolves to every ACTIVE child revenue center', async () => {
    locationFindUnique.mockResolvedValueOnce({
      name: 'Cafe', revenueCenters: [{ id: 'rc-kitchen' }, { id: 'rc-bar' }, { id: 'rc-patio' }],
    })
    const r = await resolveSalesScopeRcIds(user, settings({ salesSourceMode: 'LOCATION', salesLocationId: 'loc1' }))
    expect(r.rcIds).toEqual(['rc-kitchen', 'rc-bar', 'rc-patio'])
    expect(r.label).toBe('Cafe · all revenue centers')
    expect(r.outOfScopeRcIds).toEqual([])
    // The isActive filter is the resolver's, not the caller's, so pin it.
    expect(locationFindUnique.mock.calls.length).toBe(1)
  })

  it('RC mode resolves to exactly the configured ids', async () => {
    revenueCenterFindMany.mockResolvedValueOnce([
      { id: 'rc-kitchen', name: 'Kitchen' }, { id: 'rc-bar', name: 'Bar' },
    ])
    const r = await resolveSalesScopeRcIds(user, settings({
      salesSourceMode: 'RC', salesRcIds: ['rc-kitchen', 'rc-bar'],
    }))
    expect(r.rcIds).toEqual(['rc-kitchen', 'rc-bar'])
    expect(r.label).toBe('Kitchen + Bar')
    expect(r.outOfScopeRcIds).toEqual([])
  })

  it('reports an unconfigured scope as empty rather than guessing one', async () => {
    // No location picked…
    const noLocation = await resolveSalesScopeRcIds(user, settings({ salesSourceMode: 'LOCATION', salesLocationId: null }))
    expect(noLocation).toEqual({ rcIds: [], label: 'No sales source configured', outOfScopeRcIds: [] })
    // …a location id that no longer resolves…
    locationFindUnique.mockResolvedValueOnce(null)
    const deadLocation = await resolveSalesScopeRcIds(user, settings({ salesSourceMode: 'LOCATION', salesLocationId: 'gone' }))
    expect(deadLocation.rcIds).toEqual([])
    expect(deadLocation.label).toBe('No sales source configured')
    // …an empty RC list…
    const noRcs = await resolveSalesScopeRcIds(user, settings({ salesSourceMode: 'RC', salesRcIds: [] }))
    expect(noRcs.rcIds).toEqual([])
    expect(noRcs.label).toBe('No sales source configured')
    // …and RC ids that no longer exist.
    revenueCenterFindMany.mockResolvedValueOnce([])
    const deadRcs = await resolveSalesScopeRcIds(user, settings({ salesSourceMode: 'RC', salesRcIds: ['gone'] }))
    expect(deadRcs.rcIds).toEqual([])
    expect(deadRcs.label).toBe('No sales source configured')
  })

  it('leaves the basis WHOLE for a caller scoped narrower than the configured scope, and reports the gap', async () => {
    // The house funds the kitchen pool from all three revenue centers under
    // Cafe. This manager can only read the kitchen one.
    locationFindUnique.mockResolvedValueOnce({
      name: 'Cafe', revenueCenters: [{ id: 'rc-kitchen' }, { id: 'rc-bar' }, { id: 'rc-patio' }],
    })
    resolveScopedRcIds.mockResolvedValueOnce(new Set(['rc-kitchen']))

    const r = await resolveSalesScopeRcIds(user, settings({ salesSourceMode: 'LOCATION', salesLocationId: 'loc1' }))
    // UNCHANGED by the caller's own scope — this is the whole fix.
    expect(r.rcIds).toEqual(['rc-kitchen', 'rc-bar', 'rc-patio'])
    expect(r.label).toBe('Cafe · all revenue centers')
    // …but the narrowing is reported, so the audit can warn about it.
    expect(r.outOfScopeRcIds).toEqual(['rc-bar', 'rc-patio'])
  })

  it('reports the gap in RC mode too', async () => {
    revenueCenterFindMany.mockResolvedValueOnce([
      { id: 'rc-kitchen', name: 'Kitchen' }, { id: 'rc-bar', name: 'Bar' },
    ])
    resolveScopedRcIds.mockResolvedValueOnce(new Set(['rc-kitchen']))
    const r = await resolveSalesScopeRcIds(user, settings({
      salesSourceMode: 'RC', salesRcIds: ['rc-kitchen', 'rc-bar'],
    }))
    expect(r.rcIds).toEqual(['rc-kitchen', 'rc-bar'])
    expect(r.outOfScopeRcIds).toEqual(['rc-bar'])
  })

  it('reports no gap for an unrestricted caller (null scope = no restriction)', async () => {
    locationFindUnique.mockResolvedValueOnce({ name: 'Cafe', revenueCenters: [{ id: 'rc-bar' }] })
    resolveScopedRcIds.mockResolvedValueOnce(null)
    const r = await resolveSalesScopeRcIds(user, settings({ salesSourceMode: 'LOCATION', salesLocationId: 'loc1' }))
    expect(r.outOfScopeRcIds).toEqual([])
  })
})

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

/**
 * applyOverride used to be duplicated verbatim in build.ts and the page
 * payload route (one accumulating into a Set, one into an array). It now lives
 * once, next to selectBasis. These are the semantics both callers depend on.
 */
describe('applyOverride', () => {
  it('honours an override of 0 rather than falling back to the live figure (?? not ||)', () => {
    // Day 1 genuinely took nothing. `||` would silently restore the app's 200.
    const r = applyOverride([100, 200, 300], [null, 0, null], [])
    expect(r.series).toEqual([100, 0, 300])
    expect(r.overridden).toEqual([1])
  })

  it('turns a missing day non-missing once it is overridden', () => {
    // Supplying the figure is exactly how a manager clears a missing-basis error.
    const r = applyOverride([0, null, 300], [null, 42, null], [0, 1])
    expect(r.series).toEqual([0, 42, 300])
    expect(r.missing).toEqual([0]) // day 1 no longer missing; day 0 still is
    expect(r.overridden).toEqual([1])
  })

  it("keeps the app's own figure on a day with no override", () => {
    const r = applyOverride([100, 200, 300], [null, null, null], [2])
    expect(r.series).toEqual([100, 200, 300])
    expect(r.overridden).toEqual([])
    expect(r.missing).toEqual([2])
  })

  it('leaves the whole series untouched when there is no override array at all', () => {
    for (const raw of [null, undefined, 'nonsense', 42]) {
      const r = applyOverride([100, null, 300], raw, [1])
      expect(r.series).toEqual([100, null, 300])
      expect(r.overridden).toEqual([])
      expect(r.missing).toEqual([1])
    }
  })

  it('ignores non-finite override entries instead of poisoning the series with NaN', () => {
    const r = applyOverride([100, 200], [NaN, 'oops' as unknown as number], [])
    expect(r.series).toEqual([100, 200])
    expect(r.overridden).toEqual([])
  })

  it('tolerates an override array shorter than the series', () => {
    const r = applyOverride([100, 200, 300], [7], [])
    expect(r.series).toEqual([7, 200, 300])
  })
})
