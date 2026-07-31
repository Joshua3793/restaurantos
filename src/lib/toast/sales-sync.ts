/**
 * Toast nightly sales sync — pulls a business day's orders and writes a
 * reporting-only `SalesEntry` (+ `SaleLineItem`s) per mapped revenue center.
 *
 * This NEVER touches the spine (`pricePerBaseUnit`) or stock — it only records
 * what sold, feeding variance / COGS / menu-engineering. Counts stay the source
 * of truth for stock.
 *
 * Net-sales basis: we sum **selection prices** (net, post-discount, pre-tax),
 * skipping voided/deferred lines. This naturally excludes tax and gift cards and
 * keeps the food/non-food ratio consistent with the absolute total (both come
 * from the same line items). Service charges (rare for the café; catering is
 * excluded) are not included.
 *
 * Revenue-center routing is driven entirely by `ToastRevenueCenterMap`: each row
 * targets EITHER a leaf RC (`revenueCenterId`) OR a whole location (`locationId`).
 * A leaf-targeted order's lines all aggregate into that RC. A location-targeted
 * order splits by menu — `menu:<NAME>` sentinel rows route individual lines to
 * leaf RCs (taking precedence), and any line without a menu route falls back to
 * the location's `defaultRevenueCenterId`. Unmapped GUIDs (or location targets
 * with no default RC) are skipped for un-menu-routed lines, and orders that route
 * nothing are counted.
 */

import { prisma } from '@/lib/prisma'
import { fetchOrdersForBusinessDateInt, checkTipTotals, type ToastOrder } from '@/lib/toast/client'
import { classifyGroup } from '@/lib/toast/food-classify'

const TZ = 'America/Los_Angeles'
const SOURCE = 'toast'

// `ToastRevenueCenterMap` rows whose toastGuid is `menu:<MENU NAME>` are not real
// Toast revenue centers — they map a Toast MENU → app RC and route each line item
// by the menu it's on (taking precedence over the order's revenue center). Lets
// food/bar/catering split into different RCs even within one order. e.g.
// `menu:BAR` → BAR, `menu:CATERING` → CATERING.
export const MENU_ROUTE_PREFIX = 'menu:'

// ── Date helpers (restaurant-local) ──────────────────────────────────────────

/** Format a yyyymmdd int from a Date as seen in the restaurant's timezone. */
export function laBusinessDateInt(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return Number(`${get('year')}${get('month')}${get('day')}`)
}

/** The most recently completed business day (yesterday, LA-local). */
export function priorBusinessDateInt(now: Date = new Date()): number {
  return laBusinessDateInt(new Date(now.getTime() - 24 * 60 * 60 * 1000))
}

/** Midnight-UTC Date for a yyyymmdd int — matches how manual entries store `date`. */
function dateFromInt(yyyymmdd: number): Date {
  const y = Math.floor(yyyymmdd / 10000)
  const m = Math.floor((yyyymmdd % 10000) / 100)
  const d = yyyymmdd % 100
  return new Date(Date.UTC(y, m - 1, d))
}

// ── Aggregation ──────────────────────────────────────────────────────────────

interface RcBucket {
  revenueCenterId: string
  totalRevenue: number
  foodRevenue: number
  /** Customer payment tips, split across RCs by each check's routed revenue. */
  tips: number
  /** Gratuity service charges, split the same way. */
  gratuity: number
  covers: number
  qtyByRecipe: Map<string, number>
  unmatched: Map<string, number> // toastItemGuid → qty (sold but no recipe mapping)
}

// ── Tip attribution ──────────────────────────────────────────────────────────

export interface TipSplitInput {
  /** Revenue this check routed, per RC — the weights the tip is split by. */
  checkRcRevenue: Map<string, number>
  /** The order's revenue center, if it resolved to one. */
  orderRc: string | undefined
  /** Whether a bucket for that RC ALREADY exists (i.e. it took revenue today). */
  bucketExists: (rcId: string) => boolean
  tips: number
  gratuity: number
}

export interface TipSplit {
  /** rcId → the slice of `tips`/`gratuity` that RC earned. Never negative. */
  perRc: Map<string, { tips: number; gratuity: number }>
  /** Whatever could not be attributed to any RC. Reported, never dropped. */
  unattributed: number
}

/**
 * Split one check's tip across the revenue centers it sold into.
 *
 * Weighted by each RC's share of the check's revenue, with three deliberate
 * guards (each one is a bug we shipped and fixed):
 *
 *  1. NEGATIVE weights are skipped. A check routing +$100 to one RC and −$20 to
 *     another (an adjustment line) must not hand the second RC a negative tip.
 *  2. ZERO total weight still attributes when the RC is knowable — a fully
 *     comped check that was still tipped has a known RC, so prefer the single
 *     RC it routed to, then the order's RC.
 *  3. The order-RC fallback only fires when that RC ALREADY has a bucket. A tip
 *     must never CONJURE a revenue center into the day: an empty bucket goes on
 *     to delete that RC's manual sales entry and replace it with $0.
 *
 * Shares are returned unrounded — callers accumulate across checks and round
 * once at write time. `sum(perRc) + unattributed === tips + gratuity`.
 */
export function splitTipAcrossRcs({
  checkRcRevenue, orderRc, bucketExists, tips, gratuity,
}: TipSplitInput): TipSplit {
  const perRc = new Map<string, { tips: number; gratuity: number }>()
  const total = tips + gratuity
  if (total === 0) return { perRc, unattributed: 0 }

  // (1) Only positive revenue earns a share of the tip.
  const weights = new Map<string, number>()
  let totalWeight = 0
  for (const [rcId, revenue] of checkRcRevenue) {
    if (revenue <= 0) continue
    weights.set(rcId, revenue)
    totalWeight += revenue
  }

  if (totalWeight > 0) {
    for (const [rcId, weight] of weights) {
      const share = weight / totalWeight
      perRc.set(rcId, { tips: tips * share, gratuity: gratuity * share })
    }
    return { perRc, unattributed: 0 }
  }

  // (2) No positive revenue, but exactly one RC was routed to (a comped check) —
  // that RC's bucket necessarily exists today, since routing a line created it.
  // Still checked via bucketExists (belt-and-braces, matches branch 3): a future
  // refactor that populates checkRcRevenue before allocating the bucket must not
  // silently reintroduce the phantom-bucket bug (a tip conjuring an RC that then
  // has its manual entry deleted and replaced with $0).
  if (checkRcRevenue.size === 1) {
    const [rcId] = [...checkRcRevenue.keys()]
    if (bucketExists(rcId)) {
      perRc.set(rcId, { tips, gratuity })
      return { perRc, unattributed: 0 }
    }
  }

  // (3) Fall back to the order's RC — but only if it already took revenue today.
  if (orderRc && bucketExists(orderRc)) {
    perRc.set(orderRc, { tips, gratuity })
    return { perRc, unattributed: 0 }
  }

  return { perRc, unattributed: total }
}

export interface DaySyncResult {
  businessDate: number
  ordersPulled: number
  status: 'ok' | 'skipped' | 'error'
  perRc: {
    revenueCenterId: string
    revenueCenterName: string
    totalRevenue: number
    foodSalesPct: number
    covers: number
    tipsCollected: number
    lineItemsWritten: number
    unmatchedItems: number
    unmatchedQty: number
    supersededManual: number   // same-day manual entries removed (Toast is authoritative)
  }[]
  skippedUnmappedRcOrders: number
  /** Tips on checks that routed to no revenue center — reported, never dropped. */
  unattributedTips: number
  // Multi-day manual entries that overlap a synced day but were LEFT in place (deleting
  // them would drop revenue for their other days) — surfaced for manual resolution.
  manualConflicts?: string[]
  error?: string
}

/** Sync a single business day. Idempotent — re-running upserts the same rows. */
export async function syncBusinessDay(yyyymmdd: number): Promise<DaySyncResult> {
  // Load mappings up front. A mapped row targets a leaf RC (revenueCenterId) OR a
  // whole location (locationId), so load any row that has either.
  const [rcMaps, itemMaps, rcNames, locations] = await Promise.all([
    prisma.toastRevenueCenterMap.findMany({
      where: { OR: [{ revenueCenterId: { not: null } }, { locationId: { not: null } }] },
    }),
    prisma.toastItemMap.findMany({ select: { toastItemGuid: true, recipeId: true, toastGroup: true, toastMenu: true } }),
    prisma.revenueCenter.findMany({ select: { id: true, name: true } }),
    prisma.location.findMany({ select: { id: true, defaultRevenueCenterId: true } }),
  ])

  // Sentinel rows (`menu:<NAME>`) route a Toast MENU → leaf RC and take precedence
  // per line item (e.g. BAR → BAR, CATERING → CATERING). See MENU_ROUTE_PREFIX.
  const menuRoutes = new Map(
    rcMaps
      .filter((m) => m.toastGuid.startsWith(MENU_ROUTE_PREFIX) && m.revenueCenterId)
      .map((m) => [m.toastGuid.slice(MENU_ROUTE_PREFIX.length), m.revenueCenterId!]),
  )

  // Non-menu rows are real Toast RC GUIDs and supply the per-order target, which is
  // either a leaf RC or a whole location (resolved to its default RC per order).
  type OrderTarget = { kind: 'rc'; rcId: string } | { kind: 'location'; locationId: string }
  const orderTargetByGuid = new Map<string, OrderTarget>()
  for (const m of rcMaps) {
    if (m.toastGuid.startsWith(MENU_ROUTE_PREFIX)) continue
    if (m.revenueCenterId) orderTargetByGuid.set(m.toastGuid, { kind: 'rc', rcId: m.revenueCenterId })
    else if (m.locationId) orderTargetByGuid.set(m.toastGuid, { kind: 'location', locationId: m.locationId })
  }

  // Location → its default leaf RC (the fallback for un-menu-routed lines).
  const locationDefaultRc = new Map(locations.map((l) => [l.id, l.defaultRevenueCenterId]))
  const itemByGuid = new Map(itemMaps.map((i) => [i.toastItemGuid, i]))
  const rcNameById = new Map(rcNames.map((r) => [r.id, r.name]))

  let orders: ToastOrder[]
  try {
    orders = await fetchOrdersForBusinessDateInt(yyyymmdd)
  } catch (e) {
    return {
      businessDate: yyyymmdd, ordersPulled: 0, status: 'error',
      perRc: [], skippedUnmappedRcOrders: 0, unattributedTips: 0,
      error: e instanceof Error ? e.message : String(e),
    }
  }

  const buckets = new Map<string, RcBucket>()
  let skippedUnmappedRcOrders = 0
  let unattributedTips = 0

  const getBucket = (rcId: string): RcBucket => {
    let b = buckets.get(rcId)
    if (!b) { b = { revenueCenterId: rcId, totalRevenue: 0, foodRevenue: 0, tips: 0, gratuity: 0, covers: 0, qtyByRecipe: new Map(), unmatched: new Map() }; buckets.set(rcId, b) }
    return b
  }

  for (const order of orders) {
    if (order.voided || order.deleted || order.excessFood) continue
    const rcGuid = order.revenueCenter?.guid
    // Resolve the order-level target: a leaf RC directly, or a location's default
    // RC. Stays undefined when unmapped, or a location has no default RC set — in
    // both cases un-menu-routed lines are skipped (same as an unmapped order).
    const target = rcGuid ? orderTargetByGuid.get(rcGuid) : undefined
    let orderRc: string | undefined
    if (target?.kind === 'rc') orderRc = target.rcId
    else if (target?.kind === 'location') orderRc = locationDefaultRc.get(target.locationId) ?? undefined

    // Per-LINE-ITEM routing: each selection goes to its menu's RC if that menu is
    // mapped (menuRoutes), else the order's RC. One order can split across RCs
    // (e.g. a café ticket's brunch → CAFE, its cocktail → BAR). Track per-RC
    // revenue in this order so covers can be attributed to the dominant RC.
    const orderRcRevenue = new Map<string, number>()
    let routedAny = false

    for (const check of order.checks ?? []) {
      if (check.voided || check.deleted) continue

      // Revenue this check routed, per RC — the weights the tip is split by.
      const checkRcRevenue = new Map<string, number>()

      for (const sel of check.selections ?? []) {
        if (sel.voided || sel.deferred) continue
        const item = sel.item?.guid ? itemByGuid.get(sel.item.guid) : undefined
        const menuRc = item?.toastMenu ? menuRoutes.get(item.toastMenu) : undefined
        const rcId = menuRc ?? orderRc
        if (!rcId) continue // can't route (no menu mapping, no order RC) → skip line

        const cls = classifyGroup(item?.toastGroup)
        if (cls.ignore) continue // Toast scaffolding lines

        const bucket = getBucket(rcId)
        routedAny = true
        const price = sel.price ?? 0
        bucket.totalRevenue += price
        if (cls.isFood) bucket.foodRevenue += price
        orderRcRevenue.set(rcId, (orderRcRevenue.get(rcId) ?? 0) + price)
        checkRcRevenue.set(rcId, (checkRcRevenue.get(rcId) ?? 0) + price)

        const qty = Math.round(sel.quantity ?? 0)
        if (qty <= 0) continue
        if (item?.recipeId) {
          bucket.qtyByRecipe.set(item.recipeId, (bucket.qtyByRecipe.get(item.recipeId) ?? 0) + qty)
        } else if (sel.item?.guid) {
          bucket.unmatched.set(sel.item.guid, (bucket.unmatched.get(sel.item.guid) ?? 0) + qty)
        }
      }

      // A tip belongs to the CHECK, not to a line, so split it across the RCs
      // this check actually sold into (see splitTipAcrossRcs). ALWAYS computed
      // with auto-gratuity included — `TipSettings.includeAutoGratuity` is a
      // read-time policy, and storing a filtered 0 here would be lossy.
      const { tips, gratuity } = checkTipTotals(check, true)
      if (tips > 0 || gratuity > 0) {
        const split = splitTipAcrossRcs({
          checkRcRevenue, orderRc, bucketExists: (rcId) => buckets.has(rcId), tips, gratuity,
        })
        for (const [rcId, amounts] of split.perRc) {
          const b = getBucket(rcId)
          b.tips += amounts.tips
          b.gratuity += amounts.gratuity
        }
        unattributedTips += split.unattributed
      }
    }

    if (!routedAny) { if (rcGuid) skippedUnmappedRcOrders++; continue }

    // Covers belong to the order's dominant (highest-revenue) RC.
    if (order.guestCount && orderRcRevenue.size) {
      const dominant = [...orderRcRevenue.entries()].sort((a, b) => b[1] - a[1])[0][0]
      getBucket(dominant).covers += order.guestCount
    }
  }

  const date = dateFromInt(yyyymmdd)
  const dayEnd = new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1)   // 23:59:59.999 same UTC day
  const perRc: DaySyncResult['perRc'] = []
  const manualConflicts: string[] = []

  for (const bucket of buckets.values()) {
    const foodSalesPct = bucket.totalRevenue > 0 ? bucket.foodRevenue / bucket.totalRevenue : 0
    const lineItems = [...bucket.qtyByRecipe.entries()].map(([recipeId, qtySold]) => ({ recipeId, qtySold }))

    // Belt and braces against a PHANTOM bucket. The transaction below deletes the
    // RC's same-day manual entry before writing the Toast row — an RC that saw no
    // Toast activity at all must never reach it, or a manager's manual entry is
    // replaced with $0. (splitTipAcrossRcs already refuses to create one; this
    // catches any other path that might.) Tips are re-reported, not dropped.
    const hasActivity =
      bucket.totalRevenue !== 0 || bucket.covers > 0 || lineItems.length > 0 || bucket.unmatched.size > 0
    if (!hasActivity) {
      unattributedTips += bucket.tips + bucket.gratuity
      continue
    }

    const supersededManual = await prisma.$transaction(async (tx) => {
      // Toast is authoritative for a day it has data. A MANUAL entry on the same
      // (day, RC) would double-count in reports (which sum sources raw) — the June
      // $421K→$217,863 incident. Supersede it: a same-day manual entry is deleted
      // (its line items cascade). A MULTI-day manual entry that merely overlaps this
      // day is left in place — deleting it would drop revenue for its other days —
      // and reported as a conflict for the user to resolve.
      const overlapping = (await tx.salesEntry.findMany({
        where: { source: 'manual', revenueCenterId: bucket.revenueCenterId, date: { lte: dayEnd } },
        select: { id: true, date: true, endDate: true },
      })).filter(m => (m.endDate ?? m.date).getTime() >= date.getTime())

      const singleDayIds = overlapping.filter(m => !m.endDate || m.endDate.getTime() === m.date.getTime()).map(m => m.id)
      for (const m of overlapping.filter(m => m.endDate && m.endDate.getTime() !== m.date.getTime())) {
        manualConflicts.push(`${rcNameById.get(bucket.revenueCenterId) ?? bucket.revenueCenterId}: manual ${m.date.toISOString().slice(0, 10)}…${m.endDate!.toISOString().slice(0, 10)} overlaps Toast day ${date.toISOString().slice(0, 10)} (left in place — resolve manually)`)
      }
      if (singleDayIds.length) {
        await tx.salesEntry.deleteMany({ where: { id: { in: singleDayIds } } })   // SaleLineItem cascades
      }

      const existing = await tx.salesEntry.findUnique({
        where: {
          date_revenueCenterId_source_periodType: {
            date, revenueCenterId: bucket.revenueCenterId, source: SOURCE, periodType: 'day',
          },
        },
        select: { id: true },
      })
      if (existing) {
        await tx.saleLineItem.deleteMany({ where: { saleId: existing.id } })
        await tx.salesEntry.update({
          where: { id: existing.id },
          data: {
            totalRevenue: bucket.totalRevenue,
            foodSalesPct,
            tipsCollected: Math.round(bucket.tips * 100) / 100,
            autoGratuity: Math.round(bucket.gratuity * 100) / 100,
            covers: bucket.covers || null,
            lineItems: { create: lineItems },
          },
        })
      } else {
        await tx.salesEntry.create({
          data: {
            date, revenueCenterId: bucket.revenueCenterId, source: SOURCE, periodType: 'day',
            totalRevenue: bucket.totalRevenue,
            foodSalesPct,
            tipsCollected: Math.round(bucket.tips * 100) / 100,
            autoGratuity: Math.round(bucket.gratuity * 100) / 100,
            covers: bucket.covers || null,
            lineItems: { create: lineItems },
          },
        })
      }
      return singleDayIds.length
    })

    const unmatchedQty = [...bucket.unmatched.values()].reduce((s, q) => s + q, 0)
    perRc.push({
      revenueCenterId: bucket.revenueCenterId,
      revenueCenterName: rcNameById.get(bucket.revenueCenterId) ?? bucket.revenueCenterId,
      totalRevenue: bucket.totalRevenue,
      foodSalesPct,
      covers: bucket.covers,
      tipsCollected: Math.round(bucket.tips * 100) / 100,
      lineItemsWritten: lineItems.length,
      unmatchedItems: bucket.unmatched.size,
      unmatchedQty,
      supersededManual,
    })
  }

  const unattributedTipsTotal = Math.round(unattributedTips * 100) / 100

  if (manualConflicts.length) console.warn(`[toast-sync ${yyyymmdd}] manual/Toast conflicts left in place:\n  ${manualConflicts.join('\n  ')}`)
  if (unattributedTipsTotal > 0) console.warn(`[toast-sync ${yyyymmdd}] ${unattributedTipsTotal.toFixed(2)} in tips could not be attributed to a revenue center`)

  return {
    businessDate: yyyymmdd,
    ordersPulled: orders.length,
    status: perRc.length ? 'ok' : 'skipped',
    perRc,
    skippedUnmappedRcOrders,
    unattributedTips: unattributedTipsTotal,
    ...(manualConflicts.length ? { manualConflicts } : {}),
  }
}

/**
 * Sync one day (or default to yesterday LA), write a `ToastSyncLog`, and update
 * `ToastConnection`. Returns the per-day result.
 */
export async function runToastSync(yyyymmdd?: number): Promise<DaySyncResult> {
  const day = yyyymmdd ?? priorBusinessDateInt()
  const result = await syncBusinessDay(day)

  const totals = result.perRc.reduce(
    (a, r) => ({ lines: a.lines + r.lineItemsWritten, unmatched: a.unmatched + r.unmatchedItems }),
    { lines: 0, unmatched: 0 },
  )
  const date = dateFromInt(day)
  const log = await prisma.toastSyncLog.create({
    data: {
      windowStart: date,
      windowEnd: date,
      ordersPulled: result.ordersPulled,
      lineItemsWritten: totals.lines,
      unmatchedCount: totals.unmatched,
      status: result.status === 'error' ? 'error' : 'ok',
      error: result.error ?? null,
    },
  })
  await prisma.toastConnection.upsert({
    where: { id: 'singleton' },
    update: {
      status: result.status === 'error' ? 'error' : 'ok',
      lastSyncedAt: new Date(),
      lastError: result.error ?? null,
      lastSyncLogId: log.id,
    },
    create: {
      id: 'singleton',
      status: result.status === 'error' ? 'error' : 'ok',
      lastSyncedAt: new Date(),
      lastError: result.error ?? null,
      lastSyncLogId: log.id,
    },
  })
  return result
}

/** Backfill an inclusive range of business days (oldest → newest). */
export async function runToastBackfill(fromInt: number, toInt: number): Promise<DaySyncResult[]> {
  const results: DaySyncResult[] = []
  let cursor = dateFromInt(fromInt)
  const end = dateFromInt(toInt)
  while (cursor.getTime() <= end.getTime()) {
    const dayInt =
      cursor.getUTCFullYear() * 10000 + (cursor.getUTCMonth() + 1) * 100 + cursor.getUTCDate()
    results.push(await runToastSync(dayInt))
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  }
  return results
}
