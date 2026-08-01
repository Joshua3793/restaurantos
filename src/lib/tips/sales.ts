/**
 * Daily net sales for a tip period.
 *
 * THE SALES BASIS IS DELIBERATELY INDEPENDENT OF THE POOL'S REVENUE CENTER.
 * A kitchen tip pool is normally funded by the whole venue's sales, not by the
 * kitchen RC's own line: tips for RC "Kitchen" are typically driven by every RC
 * under Location "Cafe". TipSettings.salesSourceMode picks which:
 *   'LOCATION' → every active RC under salesLocationId
 *   'RC'       → exactly the ids listed in salesRcIds
 * Neither reads TipPeriod.revenueCenterId, which is the crew side of the pool.
 *
 * Only periodType 'day' rows are summed. A multi-day manual entry carries a
 * single start date and would dump a whole week onto one day pool (the same
 * trap documented in sales-dedup.ts).
 */
import 'server-only'
import { prisma } from '@/lib/prisma'
import type { TipSettings, User } from '@prisma/client'
import { dedupeSalesEntries } from '@/lib/sales-dedup'
import { resolveScopedRcIds } from '@/lib/rc-scope'
import { periodDays } from './period'

interface SalesRow {
  date: Date
  revenueCenterId: string
  totalRevenue: number
  tipsCollected: number | null
  autoGratuity: number | null
  source: string
  periodType: string
}

export interface DailyTotals {
  /** Net sales per day. A day with no row reads 0 and is listed in missingSalesDays. */
  net: number[]
  /** Customer tips per day. `null` on a day no revenue center reported tips. */
  tips: Array<number | null>
  missingSalesDays: number[]
  missingTipDays: number[]
}

/**
 * Folds SalesEntry rows into per-day net sales AND per-day customer tips.
 * PURE — exported so the fold is unit-testable without a database.
 *
 * The `missing*` lists carry day indexes with NO data at all, which is a
 * different (and much worse) condition than a day that genuinely took $0: the
 * audit turns a missing BASIS day into a blocking error rather than a warning.
 * A tip figure of 0 and a tip figure of null must never be conflated — that
 * distinction is the whole reason SalesEntry.tipsCollected is nullable.
 */
export function foldDailyTotals(
  rows: SalesRow[],
  days: string[],
  includeAutoGratuity = true,
): DailyTotals {
  const daily = rows.filter(r => r.periodType === 'day')
  const deduped = dedupeSalesEntries(daily)

  const salesByDay = new Map<string, number>()
  const tipsByDay = new Map<string, number>()
  const sawSales = new Set<string>()
  const sawTips = new Set<string>()

  for (const r of deduped) {
    const key = r.date.toISOString().slice(0, 10)
    salesByDay.set(key, (salesByDay.get(key) ?? 0) + Number(r.totalRevenue))
    sawSales.add(key)
    // Auto-gratuity counts as a tip only when the house says so — the decision
    // is applied here, at read time, never baked into the stored columns.
    const grat = includeAutoGratuity ? r.autoGratuity : null
    if (r.tipsCollected != null || grat != null) {
      const amount = Number(r.tipsCollected ?? 0) + Number(grat ?? 0)
      tipsByDay.set(key, (tipsByDay.get(key) ?? 0) + amount)
      sawTips.add(key)
    }
  }

  const round = (n: number) => Math.round(n * 100) / 100
  return {
    net: days.map(d => round(salesByDay.get(d) ?? 0)),
    tips: days.map(d => (sawTips.has(d) ? round(tipsByDay.get(d) ?? 0) : null)),
    missingSalesDays: days.map((d, i) => (sawSales.has(d) ? -1 : i)).filter(i => i >= 0),
    missingTipDays: days.map((d, i) => (sawTips.has(d) ? -1 : i)).filter(i => i >= 0),
  }
}

/**
 * The revenue centers the pool's sales are read from, intersected with the
 * caller's own access scope so a scoped manager can never widen their reach
 * through the tip settings.
 */
export async function resolveSalesScopeRcIds(
  user: User,
  settings: Pick<TipSettings, 'salesSourceMode' | 'salesLocationId' | 'salesRcIds'>,
): Promise<{ rcIds: string[]; label: string }> {
  const allowed = await resolveScopedRcIds(user)

  if (settings.salesSourceMode === 'LOCATION' && settings.salesLocationId) {
    const location = await prisma.location.findUnique({
      where: { id: settings.salesLocationId },
      select: { name: true, revenueCenters: { where: { isActive: true }, select: { id: true } } },
    })
    if (!location) return { rcIds: [], label: 'No sales source configured' }
    const ids = location.revenueCenters.map(rc => rc.id)
    return {
      rcIds: allowed === null ? ids : ids.filter(id => allowed.has(id)),
      label: `${location.name} · all revenue centers`,
    }
  }

  const configured = Array.isArray(settings.salesRcIds) ? (settings.salesRcIds as string[]) : []
  if (!configured.length) return { rcIds: [], label: 'No sales source configured' }
  const rcs = await prisma.revenueCenter.findMany({
    where: { id: { in: configured } },
    select: { id: true, name: true },
  })
  const ids = rcs.map(rc => rc.id)
  return {
    rcIds: allowed === null ? ids : ids.filter(id => allowed.has(id)),
    label: rcs.map(rc => rc.name).join(' + ') || 'No sales source configured',
  }
}

/** The period's daily net sales and customer tips, straight from SalesEntry. */
export async function dailyTotals(
  user: User,
  settings: Pick<TipSettings, 'salesSourceMode' | 'salesLocationId' | 'salesRcIds' | 'includeAutoGratuity'>,
  startDate: string,
  dayCount: number,
): Promise<DailyTotals & { rcIds: string[]; label: string }> {
  const days = periodDays(startDate, dayCount)
  const { rcIds, label } = await resolveSalesScopeRcIds(user, settings)
  const allMissing = days.map((_, i) => i)
  if (!rcIds.length) {
    return {
      net: days.map(() => 0), tips: days.map(() => null),
      missingSalesDays: allMissing, missingTipDays: allMissing, rcIds, label,
    }
  }

  const rows = await prisma.salesEntry.findMany({
    where: {
      revenueCenterId: { in: rcIds },
      date: { gte: new Date(days[0] + 'T00:00:00.000Z'), lte: new Date(days[days.length - 1] + 'T23:59:59.999Z') },
    },
    select: {
      date: true, revenueCenterId: true, totalRevenue: true,
      tipsCollected: true, autoGratuity: true, source: true, periodType: true,
    },
  })

  const folded = foldDailyTotals(
    rows.map(r => ({
      ...r,
      totalRevenue: Number(r.totalRevenue),
      tipsCollected: r.tipsCollected == null ? null : Number(r.tipsCollected),
      autoGratuity: r.autoGratuity == null ? null : Number(r.autoGratuity),
    })),
    days,
    settings.includeAutoGratuity,
  )
  return { ...folded, rcIds, label }
}

/**
 * Lays a stored per-day override array (the imported workbook's figures) over
 * a live series (the app's own SalesEntry figures).
 *
 * PURE, and the ONLY copy — it sits next to `selectBasis` because the two are
 * always used together and both callers, the page payload route and the
 * server-side freeze/export path in build.ts, already import from here. It was
 * previously duplicated verbatim in both; change the override semantics in one
 * copy and the page's numbers and the numbers frozen at payment drift apart,
 * which is the exact failure this seam exists to prevent.
 *
 * Semantics that matter:
 *   - An override of `0` is a REAL figure and wins. `?? `/`isFinite`, never
 *     `||` — a day that genuinely took nothing is not a day with no data.
 *   - Only `null`/`undefined`/non-finite entries fall through to the live
 *     value, so a short or sparse override array leaves the rest untouched.
 *   - A day that was missing becomes non-missing once overridden: supplying
 *     the figure is precisely how a manager clears a missing-basis error.
 */
export function applyOverride(
  liveSeries: Array<number | null>,
  raw: unknown,
  liveMissing: number[],
): { series: Array<number | null>; overridden: number[]; missing: number[] } {
  const override = Array.isArray(raw) ? (raw as Array<number | null>) : null
  const overridden: number[] = []
  const series = liveSeries.map((v, i) => {
    const o = override?.[i]
    if (o == null || !isFinite(Number(o))) return v
    overridden.push(i)
    return Number(o)
  })
  return { series, overridden, missing: liveMissing.filter(i => !overridden.includes(i)) }
}

/**
 * Picks the per-day amount the pool rate applies to, and the day indexes that
 * amount is missing on. One place, so the page, the freeze and the export can
 * never disagree about what the pool was a percentage of.
 */
export function selectBasis(
  totals: Pick<DailyTotals, 'net' | 'tips' | 'missingSalesDays' | 'missingTipDays'>,
  poolBasis: 'NET_SALES' | 'TIPS_COLLECTED',
): { basis: number[]; missingBasisDays: number[] } {
  return poolBasis === 'TIPS_COLLECTED'
    ? { basis: totals.tips.map(t => t ?? 0), missingBasisDays: totals.missingTipDays }
    : { basis: totals.net, missingBasisDays: totals.missingSalesDays }
}
