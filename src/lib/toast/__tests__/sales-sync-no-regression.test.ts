/**
 * No-regression harness for the nightly sync's WRITE path, over a mocked Toast
 * client and a mocked Prisma that records every operation. No database is
 * touched.
 *
 * This is the evidence for the constraint the whole tip-attribution task was
 * gated on: "existing revenue, covers and food-percentage behaviour must be
 * completely unchanged." A single, entirely tip-free business day exercises
 * every revenue-routing path in `syncBusinessDay` at once — leaf-RC vs
 * location-targeted orders, per-line `menu:` routing splitting one order
 * across RCs, ignore/food/non-food classification, voided/deleted/excessFood
 * orders and a voided selection, an unmapped RC guid, covers attribution, and
 * both flavours of manual-entry handling (same-day supersede vs multi-day
 * conflict) — and asserts the full `DaySyncResult` plus the exact Prisma
 * calls made. Any future change to the revenue path should fail this loudly.
 *
 * A second test pins the `hasActivity` gate added to the write loop: a bucket
 * with nothing but zero-priced, zero-quantity selections must be skipped
 * entirely — no $0 Toast row, and (unlike before the gate existed) no delete
 * of that RC's manual entry either.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ToastOrder } from '@/lib/toast/client'

interface ManualEntry { id: string; date: Date; endDate: Date | null }

let recorded: [string, unknown][] = []
const orders: ToastOrder[] = []

// RC id → same-day / multi-day manual `SalesEntry` rows the write-loop's
// overlap query should see for that RC. Populated per-test.
let manualEntriesByRc: Record<string, ManualEntry[]> = {}

function recFn<A, T>(name: string, impl: (args: A) => Promise<T>) {
  return async (args: A) => {
    recorded.push([name, args])
    return impl(args)
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    toastRevenueCenterMap: {
      findMany: async () => [
        { toastGuid: 'tg-cafe', revenueCenterId: 'cafe', locationId: null },   // leaf RC, direct
        { toastGuid: 'tg-loc1', revenueCenterId: null, locationId: 'loc1' },   // whole-location target
        { toastGuid: 'menu:BAR', revenueCenterId: 'bar', locationId: null },  // per-line menu sentinel
      ],
    },
    toastItemMap: {
      findMany: async () => [
        { toastItemGuid: 'i-food-cafe', recipeId: 'r-food', toastGroup: 'Food', toastMenu: 'CAFE' },
        { toastItemGuid: 'i-drink-cafe', recipeId: 'r-drink', toastGroup: 'Hot Drinks', toastMenu: 'CAFE' },
        { toastItemGuid: 'i-ignore', recipeId: 'r-ignore', toastGroup: 'Toast Tables', toastMenu: 'CAFE' },
        { toastItemGuid: 'i-bar', recipeId: 'r-bar', toastGroup: 'Cocktails', toastMenu: 'BAR' },
        { toastItemGuid: 'i-lunch', recipeId: 'r-lunch', toastGroup: 'Lunch', toastMenu: 'LUNCH' },
      ],
    },
    revenueCenter: {
      findMany: async () => [
        { id: 'cafe', name: 'Cafe' },
        { id: 'lunch', name: 'Lunch' },
        { id: 'bar', name: 'Bar' },
      ],
    },
    location: { findMany: async () => [{ id: 'loc1', defaultRevenueCenterId: 'lunch' }] },
    tipSettings: { findUnique: async () => ({ includeAutoGratuity: false }) },
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn({
      salesEntry: {
        findMany: recFn('salesEntry.findMany', async (args: { where: { revenueCenterId: string } }) =>
          manualEntriesByRc[args.where.revenueCenterId] ?? []),
        findUnique: recFn('salesEntry.findUnique', async () => null),
        deleteMany: recFn('salesEntry.deleteMany', async () => ({ count: 1 })),
        create: recFn('salesEntry.create', async (args: { data: { revenueCenterId: string } }) =>
          ({ id: `created-${args.data.revenueCenterId}` })),
        update: recFn('salesEntry.update', async (args: { data: { revenueCenterId?: string } }) =>
          ({ id: `updated-${args.data.revenueCenterId ?? 'x'}` })),
      },
      saleLineItem: { deleteMany: recFn('saleLineItem.deleteMany', async () => ({ count: 0 })) },
    }),
  },
}))

vi.mock('@/lib/toast/client', async (orig) => ({
  ...(await orig() as object),
  fetchOrdersForBusinessDateInt: async () => orders,
}))

const { syncBusinessDay } = await import('@/lib/toast/sales-sync')

beforeEach(() => { recorded = []; orders.length = 0; manualEntriesByRc = {} })

describe('syncBusinessDay — no-regression (tip-free day)', () => {
  it('routes revenue, covers and food% unchanged across every path in one sync', async () => {
    manualEntriesByRc = {
      // Same-day, single-day manual entry on 'cafe' — must be superseded (deleted).
      cafe: [{ id: 'manual-cafe-1', date: new Date(Date.UTC(2026, 6, 30)), endDate: null }],
      // Multi-day manual entry overlapping the synced day on 'lunch' — must be LEFT
      // in place and reported as a conflict, not deleted.
      lunch: [{ id: 'manual-lunch-1', date: new Date(Date.UTC(2026, 6, 15)), endDate: new Date(Date.UTC(2026, 7, 15)) }],
    }

    // A: leaf-RC-targeted order. Food + non-food mix (→ foodSalesPct), a
    // classifyGroup-ignored line, and a voided selection — none of the last
    // two should reach the bucket at all.
    orders.push({
      guid: 'oA',
      revenueCenter: { guid: 'tg-cafe' },
      checks: [{
        guid: 'cA',
        selections: [
          { guid: 'sA1', quantity: 2, price: 40, item: { guid: 'i-food-cafe' } },
          { guid: 'sA2', quantity: 1, price: 10, item: { guid: 'i-drink-cafe' } },
          { guid: 'sA3', quantity: 1, price: 5, item: { guid: 'i-ignore' } },
          { guid: 'sA4', quantity: 1, price: 999, item: { guid: 'i-food-cafe' }, voided: true },
        ],
      }],
    } as unknown as ToastOrder)

    // B/C/D: voided, deleted, excessFood orders — none should route anything,
    // even though each carries a big-ticket selection that would otherwise
    // dominate the totals.
    orders.push({
      guid: 'oB', voided: true, revenueCenter: { guid: 'tg-cafe' },
      checks: [{ guid: 'cB', selections: [{ guid: 'sB1', quantity: 1, price: 1000, item: { guid: 'i-food-cafe' } }] }],
    } as unknown as ToastOrder)
    orders.push({
      guid: 'oC', deleted: true, revenueCenter: { guid: 'tg-cafe' },
      checks: [{ guid: 'cC', selections: [{ guid: 'sC1', quantity: 1, price: 1000, item: { guid: 'i-food-cafe' } }] }],
    } as unknown as ToastOrder)
    orders.push({
      guid: 'oD', excessFood: true, revenueCenter: { guid: 'tg-cafe' },
      checks: [{ guid: 'cD', selections: [{ guid: 'sD1', quantity: 1, price: 1000, item: { guid: 'i-food-cafe' } }] }],
    } as unknown as ToastOrder)

    // E: location-targeted order (relies on defaultRevenueCenterId → 'lunch')
    // that ALSO splits across RCs via per-line menu routing (the BAR item
    // takes precedence over the order's own target). Covers attribute to the
    // dominant (higher-revenue) RC — lunch.
    orders.push({
      guid: 'oE',
      revenueCenter: { guid: 'tg-loc1' },
      guestCount: 4,
      checks: [{
        guid: 'cE',
        selections: [
          { guid: 'sE1', quantity: 3, price: 90, item: { guid: 'i-lunch' } },
          { guid: 'sE2', quantity: 1, price: 10, item: { guid: 'i-bar' } },
        ],
      }],
    } as unknown as ToastOrder)

    // F: unmapped RC guid — routes nothing, counted in skippedUnmappedRcOrders.
    orders.push({
      guid: 'oF',
      revenueCenter: { guid: 'tg-unknown' },
      checks: [{ guid: 'cF', selections: [{ guid: 'sF1', quantity: 1, price: 20, item: { guid: 'i-unmapped' } }] }],
    } as unknown as ToastOrder)

    const result = await syncBusinessDay(20260730)

    expect(result.status).toBe('ok')
    expect(result.ordersPulled).toBe(6)
    expect(result.skippedUnmappedRcOrders).toBe(1)
    expect(result.unattributedTips).toBe(0)

    // Three buckets formed: cafe (leaf-targeted), lunch (location default),
    // bar (per-line menu route) — in first-touched order.
    expect(result.perRc.map(r => r.revenueCenterId)).toEqual(['cafe', 'lunch', 'bar'])

    const cafe = result.perRc.find(r => r.revenueCenterId === 'cafe')!
    expect(cafe.totalRevenue).toBe(50)           // 40 + 10; ignore + voided lines excluded
    expect(cafe.foodSalesPct).toBeCloseTo(0.8)    // 40 food / 50 total
    expect(cafe.covers).toBe(0)
    expect(cafe.tipsCollected).toBe(0)
    expect(cafe.lineItemsWritten).toBe(2)
    expect(cafe.unmatchedItems).toBe(0)
    expect(cafe.supersededManual).toBe(1)         // the same-day manual entry

    const lunch = result.perRc.find(r => r.revenueCenterId === 'lunch')!
    expect(lunch.totalRevenue).toBe(90)
    expect(lunch.foodSalesPct).toBeCloseTo(1)
    expect(lunch.covers).toBe(4)                  // dominant RC (90 > 10) takes the covers
    expect(lunch.lineItemsWritten).toBe(1)
    expect(lunch.supersededManual).toBe(0)        // multi-day conflict left in place

    const bar = result.perRc.find(r => r.revenueCenterId === 'bar')!
    expect(bar.totalRevenue).toBe(10)
    expect(bar.foodSalesPct).toBe(0)
    expect(bar.covers).toBe(0)
    expect(bar.lineItemsWritten).toBe(1)
    expect(bar.supersededManual).toBe(0)

    expect(result.manualConflicts).toEqual([
      'Lunch: manual 2026-07-15…2026-08-15 overlaps Toast day 2026-07-30 (left in place — resolve manually)',
    ])

    // Exact Prisma calls: the same-day manual entry on 'cafe' is deleted with
    // the right where-clause; the multi-day one on 'lunch' is never touched;
    // each of the three buckets is freshly created (no pre-existing Toast row).
    const byName = (n: string) => recorded.filter(([name]) => name === n)
    expect(byName('salesEntry.deleteMany')).toEqual([
      ['salesEntry.deleteMany', { where: { id: { in: ['manual-cafe-1'] } } }],
    ])
    expect(byName('salesEntry.findMany').map(([, args]) => (args as { where: { revenueCenterId: string } }).where.revenueCenterId))
      .toEqual(['cafe', 'lunch', 'bar'])

    const creates = byName('salesEntry.create').map(([, args]) => args as { data: Record<string, unknown> })
    expect(creates).toHaveLength(3)

    const cafeCreate = creates.find(c => c.data.revenueCenterId === 'cafe')!.data
    expect(cafeCreate).toMatchObject({
      source: 'toast', periodType: 'day',
      totalRevenue: 50, foodSalesPct: 0.8,
      tipsCollected: 0, autoGratuity: 0, covers: null,
    })
    expect(cafeCreate.lineItems).toEqual({
      create: [{ recipeId: 'r-food', qtySold: 2 }, { recipeId: 'r-drink', qtySold: 1 }],
    })

    const lunchCreate = creates.find(c => c.data.revenueCenterId === 'lunch')!.data
    expect(lunchCreate).toMatchObject({
      totalRevenue: 90, foodSalesPct: 1, tipsCollected: 0, autoGratuity: 0, covers: 4,
    })
    expect(lunchCreate.lineItems).toEqual({ create: [{ recipeId: 'r-lunch', qtySold: 3 }] })

    const barCreate = creates.find(c => c.data.revenueCenterId === 'bar')!.data
    expect(barCreate).toMatchObject({
      totalRevenue: 10, foodSalesPct: 0, tipsCollected: 0, autoGratuity: 0, covers: null,
    })
    expect(barCreate.lineItems).toEqual({ create: [{ recipeId: 'r-bar', qtySold: 1 }] })

    // No pre-existing Toast row was found for any bucket → salesEntry.update and
    // saleLineItem.deleteMany (the update-path's clear) are never called.
    expect(byName('salesEntry.update')).toEqual([])
    expect(byName('saleLineItem.deleteMany')).toEqual([])
  })

  it('the hasActivity gate skips a bucket with only zero-priced, zero-quantity selections — no $0 row, no manual-entry delete', async () => {
    // Even though a manual entry exists for 'cafe', the gate must stop the
    // bucket before the write-loop's $transaction, so the query that would
    // find/delete it is never run at all.
    manualEntriesByRc = { cafe: [{ id: 'manual-cafe-1', date: new Date(Date.UTC(2026, 6, 30)), endDate: null }] }

    orders.push({
      guid: 'oG',
      revenueCenter: { guid: 'tg-cafe' },
      checks: [{
        guid: 'cG',
        selections: [{ guid: 'sG1', quantity: 0, price: 0, item: { guid: 'i-food-cafe' } }],
      }],
    } as unknown as ToastOrder)

    const result = await syncBusinessDay(20260730)

    expect(result.status).toBe('skipped')
    expect(result.perRc).toEqual([])
    expect(result.unattributedTips).toBe(0)
    // No Prisma call at all reached the transaction — no $0 Toast row written,
    // and (the point of the gate) the cafe manual entry was never queried or
    // deleted.
    expect(recorded).toEqual([])
  })
})
