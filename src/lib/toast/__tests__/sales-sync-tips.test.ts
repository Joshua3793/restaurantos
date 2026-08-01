/**
 * Tip behaviour of the nightly sync's WRITE path, over a mocked Toast client and
 * a mocked Prisma that records operations. No database is touched.
 *
 * Guards two incidents:
 *  - a tip on a check that routed no revenue used to CREATE a bucket, whose
 *    supersede transaction then deleted that RC's manual entry and wrote $0;
 *  - `TipSettings.includeAutoGratuity` used to be applied at sync time, storing
 *    a policy-filtered `autoGratuity: 0` that no later setting flip could undo.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ToastOrder } from '@/lib/toast/client'

let recorded: [string, { data?: Record<string, unknown> }][] = []
const orders: ToastOrder[] = []

const rec = (name: string) => async (a: { data?: Record<string, unknown> }) => {
  recorded.push([name, a])
  return name === 'salesEntry.findUnique' ? null : { id: 'x', count: 1 }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    toastRevenueCenterMap: {
      findMany: async () => [
        { toastGuid: 'tg-cafe', revenueCenterId: 'cafe', locationId: null },
        // Sentinel row: items on the BAR menu route to the 'bar' RC regardless of
        // the order's own revenue center — this is what actually forces a single
        // order/check to split across two RC buckets.
        { toastGuid: 'menu:BAR', revenueCenterId: 'bar', locationId: null },
      ],
    },
    toastItemMap: {
      findMany: async () => [
        { toastItemGuid: 'i-food', recipeId: 'r-food', toastGroup: 'Food', toastMenu: 'CAFE' },
        { toastItemGuid: 'i-bar', recipeId: 'r-bar', toastGroup: 'Cocktails', toastMenu: 'BAR' },
      ],
    },
    revenueCenter: { findMany: async () => [{ id: 'cafe', name: 'Cafe' }, { id: 'bar', name: 'Bar' }] },
    location: { findMany: async () => [] },
    // Present so a stray read would still resolve — the sync must not make one.
    tipSettings: { findUnique: async () => ({ includeAutoGratuity: false }) },
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn({
      salesEntry: {
        findMany: async () => [{ id: 'manual-1', date: new Date(Date.UTC(2026, 6, 30)), endDate: null }],
        findUnique: rec('salesEntry.findUnique'),
        deleteMany: rec('salesEntry.deleteMany'),
        create: rec('salesEntry.create'),
        update: rec('salesEntry.update'),
      },
      saleLineItem: { deleteMany: rec('saleLineItem.deleteMany') },
    }),
  },
}))

vi.mock('@/lib/toast/client', async (orig) => ({
  ...(await orig() as object),
  fetchOrdersForBusinessDateInt: async () => orders,
}))

const { syncBusinessDay } = await import('@/lib/toast/sales-sync')

const order = (over: Record<string, unknown>) =>
  ({ guid: 'o1', revenueCenter: { guid: 'tg-cafe' }, ...over }) as unknown as ToastOrder

beforeEach(() => { recorded = []; orders.length = 0 })

describe('syncBusinessDay — tips', () => {
  it('never lets a tip on a revenue-less check delete a manual sales entry', async () => {
    orders.push(order({
      checks: [{
        guid: 'c1',
        // Deferred (gift-card) selection: routes no revenue anywhere.
        selections: [{ guid: 's1', quantity: 1, price: 40, item: { guid: 'i-food' }, deferred: true }],
        payments: [{ guid: 'p1', amount: 40, tipAmount: 8, type: 'CREDIT', paymentStatus: 'CAPTURED' }],
      }],
    }))

    const result = await syncBusinessDay(20260730)

    expect(recorded).toEqual([])              // no delete, no $0 Toast row
    expect(result.perRc).toEqual([])
    expect(result.status).toBe('skipped')
    expect(result.unattributedTips).toBe(8)   // reported, not dropped
  })

  it('stores auto-gratuity raw, ignoring the read-time house policy', async () => {
    orders.push(order({
      guestCount: 2,
      checks: [{
        guid: 'c1',
        selections: [{ guid: 's1', quantity: 1, price: 100, item: { guid: 'i-food' } }],
        payments: [{ guid: 'p1', amount: 100, tipAmount: 5, type: 'CREDIT', paymentStatus: 'CAPTURED' }],
        appliedServiceCharges: [{ guid: 'sc1', name: 'Auto grat 20%', chargeAmount: 20, gratuity: true }],
      }],
    }))

    await syncBusinessDay(20260730)

    const create = recorded.find(([name]) => name === 'salesEntry.create')
    // TipSettings.includeAutoGratuity is mocked FALSE above; the stored value
    // must still be the full $20 (the policy is applied by foldDailyTotals).
    expect(create?.[1].data?.autoGratuity).toBe(20)
    expect(create?.[1].data?.tipsCollected).toBe(5)
  })

  it('splits a tip across the revenue centers the check sold into', async () => {
    orders.push(order({
      checks: [{
        guid: 'c1',
        selections: [
          // CAFE-menu item: no `menu:CAFE` sentinel exists, so it falls back to
          // the order's own RC (cafe).
          { guid: 's1', quantity: 1, price: 75, item: { guid: 'i-food' } },
          // BAR-menu item: routed to a DIFFERENT RC by the `menu:BAR` sentinel,
          // regardless of the order's own RC — this is what actually forces the
          // check to sell into two revenue centers.
          { guid: 's2', quantity: 1, price: 25, item: { guid: 'i-bar' } },
          // A negative adjustment line (still cafe) must not earn a negative slice.
          { guid: 's3', quantity: 1, price: -25, item: { guid: 'i-food' } },
        ],
        payments: [{ guid: 'p1', amount: 75, tipAmount: 10, type: 'CREDIT', paymentStatus: 'CAPTURED' }],
      }],
    }))

    const result = await syncBusinessDay(20260730)

    expect(result.perRc).toHaveLength(2)               // genuinely two RC buckets
    const cafe = result.perRc.find(r => r.revenueCenterId === 'cafe')!
    const bar = result.perRc.find(r => r.revenueCenterId === 'bar')!
    expect(cafe.totalRevenue).toBe(50)                  // revenue keeps the −25
    expect(bar.totalRevenue).toBe(25)
    // Tip splits proportionally by each RC's positive revenue share (50:25 → 2:1),
    // rounded to the cent, and conserves the full $10 between the two RCs.
    expect(cafe.tipsCollected).toBe(6.67)
    expect(bar.tipsCollected).toBe(3.33)
    expect(result.unattributedTips).toBe(0)
  })
})
