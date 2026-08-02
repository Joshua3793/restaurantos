import { describe, it, expect } from 'vitest'
import {
  resolveLineRc,
  businessDatesTouched,
  resyncWindowStart,
  staleToastRcIds,
  NO_RC_ROUTE_GUID,
} from '@/lib/toast/sync-routing'

// Routing inputs mirror the maps `syncBusinessDay` builds from the DB.
const menuRoutes = new Map([
  ['CATERING', 'rc-catering'],
  ['BAR', 'rc-bar'],
])

describe('resolveLineRc', () => {
  it('sends a line to its menu RC when the item is mapped to a routed menu', () => {
    expect(
      resolveLineRc({ itemMenu: 'BAR', orderRc: 'rc-kitchen', noRcFallback: undefined, menuRoutes }),
    ).toBe('rc-bar')
  })

  it("falls back to the order's RC when the item's menu is not routed", () => {
    expect(
      resolveLineRc({ itemMenu: 'BRUNCH', orderRc: 'rc-kitchen', noRcFallback: undefined, menuRoutes }),
    ).toBe('rc-kitchen')
  })

  it("falls back to the order's RC when the item is not in ToastItemMap at all", () => {
    expect(
      resolveLineRc({ itemMenu: undefined, orderRc: 'rc-kitchen', noRcFallback: undefined, menuRoutes }),
    ).toBe('rc-kitchen')
  })

  // Bug 2: catering orders carry `revenueCenter: null`, so orderRc is undefined.
  // An OPEN_ITEM line is never in ToastItemMap, so it has no menu either — before
  // the fallback existed the line was silently dropped and its revenue vanished.
  it('routes an unmapped line on an RC-less order to the no-RC fallback', () => {
    expect(
      resolveLineRc({ itemMenu: undefined, orderRc: undefined, noRcFallback: 'rc-catering', menuRoutes }),
    ).toBe('rc-catering')
  })

  it('still prefers the menu route over the no-RC fallback on an RC-less order', () => {
    expect(
      resolveLineRc({ itemMenu: 'BAR', orderRc: undefined, noRcFallback: 'rc-catering', menuRoutes }),
    ).toBe('rc-bar')
  })

  it('drops the line only when nothing can route it', () => {
    expect(
      resolveLineRc({ itemMenu: undefined, orderRc: undefined, noRcFallback: undefined, menuRoutes }),
    ).toBeUndefined()
  })

  it('exposes a sentinel GUID so the fallback is configurable like a menu route', () => {
    expect(NO_RC_ROUTE_GUID).toBe('no-revenue-center')
  })
})

describe('businessDatesTouched', () => {
  it('collects the distinct business dates a modified-window pull touched', () => {
    const days = businessDatesTouched([
      { businessDate: 20260714 },
      { businessDate: 20260610 },
      { businessDate: 20260714 },
    ])
    expect(days).toEqual([20260610, 20260714])
  })

  // The whole point of the trailing re-sync: an order created weeks after its
  // business date drags that old day back into scope.
  it('includes a business date far older than the modified window', () => {
    expect(businessDatesTouched([{ businessDate: 20260319 }])).toEqual([20260319])
  })

  it('ignores orders with no business date', () => {
    expect(businessDatesTouched([{ businessDate: undefined }, { businessDate: 20260714 }])).toEqual([
      20260714,
    ])
  })

  it('returns days oldest-first so a re-sync replays them in order', () => {
    const days = businessDatesTouched([{ businessDate: 20260801 }, { businessDate: 20260714 }])
    expect(days).toEqual([20260714, 20260801])
  })
})

describe('resyncWindowStart', () => {
  const now = new Date('2026-08-01T13:00:00Z')

  it('resumes from the last successful sync, with overlap so nothing slips the seam', () => {
    const start = resyncWindowStart(new Date('2026-07-31T13:00:00Z'), now)
    expect(start.toISOString()).toBe('2026-07-31T07:00:00.000Z') // 6h overlap
  })

  it('defaults to a week back when the connection has never synced', () => {
    expect(resyncWindowStart(null, now).toISOString()).toBe('2026-07-25T13:00:00.000Z')
  })

  it('caps a long outage at 30 days so one run cannot pull the whole history', () => {
    const start = resyncWindowStart(new Date('2026-01-01T00:00:00Z'), now)
    expect(start.toISOString()).toBe('2026-07-02T13:00:00.000Z')
  })

  it('never returns a start in the future when lastSyncedAt is ahead of now', () => {
    const start = resyncWindowStart(new Date('2026-08-02T00:00:00Z'), now)
    expect(start.getTime()).toBeLessThanOrEqual(now.getTime())
  })
})

describe('staleToastRcIds', () => {
  // Bug 3: the sync is overwrite-on-present. An RC whose orders were all voided
  // after the fact produces no bucket, so its old row survives with stale revenue.
  it('flags a stored RC that produced no revenue on a re-sync', () => {
    expect(staleToastRcIds({ storedRcIds: ['rc-bar', 'rc-kitchen'], activeRcIds: ['rc-kitchen'], ordersPulled: 40 }))
      .toEqual(['rc-bar'])
  })

  it('leaves RCs that still have revenue alone', () => {
    expect(staleToastRcIds({ storedRcIds: ['rc-kitchen'], activeRcIds: ['rc-kitchen'], ordersPulled: 40 }))
      .toEqual([])
  })

  // A zero-order pull is ambiguous — a genuinely closed day looks exactly like a
  // failed/empty API response. Never delete on that evidence.
  it('refuses to clear anything when the pull returned no orders', () => {
    expect(staleToastRcIds({ storedRcIds: ['rc-bar'], activeRcIds: [], ordersPulled: 0 })).toEqual([])
  })
})
