// The start page (Pass on desktop, Today on mobile) — pure rules for what a chef
// sees on landing. Everything here is derived from rows the page already fetches;
// no DB, no React, so the ranking is covered by `npm test`.
//
// The page answers three things, in this order:
//   1. How long until doors, and how far along is prep?   (dayTimeline, prepProgress)
//   2. What needs me — before doors, then later today?    (buildNeeds)
//   3. How did yesterday go, and are we on cost?          (rendered straight from the API)
// Anything that does not change what the chef does in the next hour belongs in
// Reports, not here.

import { isSafe, rangeText, fmtTemp } from '@/components/temps/temp-utils'
import type { RcService, ServiceStatus } from '@/lib/service-hours'

// ── Inputs (the slices of each API response the rules read) ─────────────────

export interface StartPrepItem {
  id: string
  name: string
  unit: string
  onHand: number
  parLevel: number
  priority: '911' | 'NEEDED_TODAY' | 'LATER'
  assignedCook?: { name: string } | null
  todayLog?: { status: string; postedAt?: string | null } | null
}

export interface StartTempUnit {
  id: string
  name: string
  type: 'FRIDGE' | 'FREEZER' | 'HOT'
  safeMin: number | null
  safeMax: number | null
  readings?: { time: string; temp: number }[]
}

export interface StartPriceAlert {
  id: string
  changePct: number | string
  direction: string
  inventoryItem: { itemName: string } | null
  session: { supplierName: string | null } | null
}

export interface StartRecipeAlert {
  exceededThreshold: boolean
}

export interface StartCountSession {
  status: string
  finalizedAt: string | null
}

export interface StartOrderLine {
  id: string
  name: string
  onHand: number
  par: number
  unit: string
}

// ── Output ──────────────────────────────────────────────────────────────────

/** `now` = fix before doors; `today` = deal with it sometime today. */
export type NeedWhen = 'now' | 'today'
export type NeedKind = 'prep' | 'temp' | 'price' | 'invoice' | 'count'

export interface NeedItem {
  id: string
  when: NeedWhen
  kind: NeedKind
  title: string
  detail: string
  href: string
  cta: string
}

// ── Prep ────────────────────────────────────────────────────────────────────

const DONE = new Set(['DONE', 'PARTIAL'])

/** The posted To Do — the same count the run sheet's caption shows. */
export function prepProgress(items: StartPrepItem[]): { posted: number; done: number; doing: number } {
  const posted = items.filter(i => i.todayLog?.postedAt)
  return {
    posted: posted.length,
    done: posted.filter(i => DONE.has(i.todayLog!.status)).length,
    doing: posted.filter(i => i.todayLog!.status === 'IN_PROGRESS').length,
  }
}

const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

/**
 * Critical prep (the PASS step — needed for service) that nobody is on: either
 * not on today's To Do at all, or posted with no cook and not started. An item a
 * cook has already picked up is handled — it does not need the chef.
 */
export function unattendedCriticalPrep(items: StartPrepItem[]): StartPrepItem[] {
  return items.filter(i => {
    if (i.priority !== '911') return false
    const status = i.todayLog?.status
    if (status && (DONE.has(status) || status === 'IN_PROGRESS')) return false
    return !i.assignedCook
  })
}

function prepNeed(i: StartPrepItem, serviceName: string | null): NeedItem {
  const left = Number(i.onHand) <= 0
    ? 'none left'
    : `${fmtQty(Number(i.onHand))} ${i.unit} left`
  const where = i.todayLog?.postedAt ? 'on the To Do · nobody on it' : 'not on the To Do'
  return {
    id: `prep-${i.id}`,
    when: 'now',
    kind: 'prep',
    title: `${i.name} — ${left}`,
    detail: serviceName
      ? `Needed for ${serviceName.toLowerCase()} · ${where}`
      : where.charAt(0).toUpperCase() + where.slice(1),
    href: '/prep',
    cta: 'Open prep',
  }
}

// ── Temps ───────────────────────────────────────────────────────────────────

function listNames(names: string[], max = 3): string {
  if (names.length <= max) return names.join(', ')
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`
}

/**
 * Cold units with no reading today (one row for all of them), plus any unit
 * whose LATEST reading today is out of range (one row each). Hot-holding units
 * are only checked once they have a reading — they are logged during service,
 * so "not logged yet" before doors is normal.
 */
export function tempNeeds(units: StartTempUnit[]): NeedItem[] {
  const out: NeedItem[] = []
  for (const u of units) {
    const latest = u.readings?.length ? u.readings[u.readings.length - 1] : null
    if (latest && isSafe(u, latest.temp) === false) {
      out.push({
        id: `temp-bad-${u.id}`,
        when: 'now',
        kind: 'temp',
        title: `${u.name} at ${fmtTemp(latest.temp)}°C`,
        detail: `Safe is ${rangeText(u)} · read at ${latest.time}`,
        href: '/temps',
        cta: 'Check it',
      })
    }
  }
  const missing = units.filter(u => u.type !== 'HOT' && !u.readings?.length)
  if (missing.length > 0) {
    out.push({
      id: 'temp-missing',
      when: 'now',
      kind: 'temp',
      title: "Today's temps not logged",
      detail: listNames(missing.map(u => u.name)),
      href: '/temps',
      cta: 'Log temps',
    })
  }
  return out
}

// ── Prices, invoices, counts ────────────────────────────────────────────────

/** One row for supplier price rises: the biggest rise leads, the rest are counted. */
export function priceNeed(alerts: StartPriceAlert[], recipeAlerts: StartRecipeAlert[]): NeedItem | null {
  const ups = alerts
    .filter(a => a.direction === 'UP' && a.inventoryItem)
    .sort((a, b) => Number(b.changePct) - Number(a.changePct))
  if (ups.length === 0) return null
  const top = ups[0]
  const supplier = top.session?.supplierName
  const overTarget = recipeAlerts.filter(r => r.exceededThreshold).length
  const bits: string[] = []
  if (overTarget > 0) bits.push(`${overTarget} ${overTarget === 1 ? 'dish' : 'dishes'} now over target`)
  if (ups.length > 1) bits.push(`+${ups.length - 1} more price ${ups.length - 1 === 1 ? 'rise' : 'rises'}`)
  return {
    id: 'price-rises',
    when: 'today',
    kind: 'price',
    title: `${top.inventoryItem!.itemName} up ${Math.round(Number(top.changePct))}%${supplier ? ` from ${supplier}` : ''}`,
    detail: bits.length ? bits.join(' · ') : 'Check the dishes that use it',
    href: '/invoices',
    cta: 'Review',
  }
}

export function invoiceNeed(awaiting: number): NeedItem | null {
  if (awaiting <= 0) return null
  return {
    id: 'invoices',
    when: 'today',
    kind: 'invoice',
    title: `${awaiting} ${awaiting === 1 ? 'invoice' : 'invoices'} to approve`,
    detail: 'Prices update when you approve',
    href: '/invoices',
    cta: 'Review',
  }
}

/** Days since the newest finalized count, or null when there has never been one. */
export function daysSinceCount(sessions: StartCountSession[], nowMs: number): number | null {
  const latest = sessions
    .filter(s => s.status === 'FINALIZED' && s.finalizedAt)
    .map(s => new Date(s.finalizedAt!).getTime())
    .sort((a, b) => b - a)[0]
  return latest == null ? null : Math.floor((nowMs - latest) / 86_400_000)
}

/** Same threshold the old Pass used: a count older than 4 days is stale. */
export const COUNT_STALE_DAYS = 4

export function countNeed(days: number | null): NeedItem | null {
  if (days == null || days <= COUNT_STALE_DAYS) return null
  return {
    id: 'count',
    when: 'today',
    kind: 'count',
    title: `Last count was ${days} days ago`,
    detail: 'Stock and food cost drift until the next count',
    href: '/count',
    cta: 'Start count',
  }
}

// ── The list ────────────────────────────────────────────────────────────────

export interface NeedsInput {
  prep: StartPrepItem[]
  temps: StartTempUnit[]
  priceAlerts: StartPriceAlert[]
  recipeAlerts: StartRecipeAlert[]
  invoicesAwaiting: number
  countDays: number | null
  /** The service the "before doors" items are for (e.g. "Brunch"), if any. */
  serviceName: string | null
}

/** Critical prep rows shown one by one; beyond this they fold into one row. */
const PREP_ROWS = 2

/**
 * Everything that needs the chef, most urgent first: food safety and critical
 * prep before doors, then money and admin for later today.
 */
export function buildNeeds(input: NeedsInput): NeedItem[] {
  const now: NeedItem[] = []
  const today: NeedItem[] = []

  const temps = tempNeeds(input.temps)
  now.push(...temps.filter(t => t.id !== 'temp-missing'))

  const critical = unattendedCriticalPrep(input.prep)
  if (critical.length > PREP_ROWS) {
    now.push({
      id: 'prep-critical',
      when: 'now',
      kind: 'prep',
      title: `${critical.length} critical prep items — nobody on them`,
      detail: listNames(critical.map(i => i.name)),
      href: '/prep',
      cta: 'Open prep',
    })
  } else {
    now.push(...critical.map(i => prepNeed(i, input.serviceName)))
  }

  now.push(...temps.filter(t => t.id === 'temp-missing'))

  const price = priceNeed(input.priceAlerts, input.recipeAlerts)
  if (price) today.push(price)
  const inv = invoiceNeed(input.invoicesAwaiting)
  if (inv) today.push(inv)
  const count = countNeed(input.countDays)
  if (count) today.push(count)

  return [...now, ...today]
}

// ── Running low ─────────────────────────────────────────────────────────────

/** The below-par lines closest to empty, for the "Running low" chips. */
export function runningLow(lines: StartOrderLine[], max = 3): {
  top: (StartOrderLine & { out: boolean; label: string })[]
  more: number
} {
  const ratio = (l: StartOrderLine) => (l.par > 0 ? l.onHand / l.par : 1)
  const sorted = [...lines].sort((a, b) => ratio(a) - ratio(b) || a.name.localeCompare(b.name))
  return {
    top: sorted.slice(0, max).map(l => ({
      ...l,
      out: l.onHand <= 0,
      label: l.onHand <= 0 ? 'out' : `${fmtQty(Math.max(0, l.onHand))} ${l.unit} left`,
    })),
    more: Math.max(0, sorted.length - max),
  }
}

// ── Service clock ───────────────────────────────────────────────────────────

/** 545 → "9:05 am" (minute-of-day). */
export function fmtTimeOfDay(min: number): string {
  const m = ((min % 1440) + 1440) % 1440
  const h24 = Math.floor(m / 60)
  const mm = String(m % 60).padStart(2, '0')
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${mm} ${h24 < 12 ? 'am' : 'pm'}`
}

/** 80 → "1:20" (a countdown, hours:minutes). */
export function fmtCountdown(mins: number): string {
  const m = Math.max(0, Math.round(mins))
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

/** 80 → "1 h 20 m"; 25 → "25 m". */
export function fmtDurationWords(mins: number): string {
  const m = Math.max(0, Math.round(mins))
  const h = Math.floor(m / 60)
  return h > 0 ? `${h} h ${m % 60} m` : `${m} m`
}

export interface DayTimeline {
  /** Each service as a band on the bar (0–100 %). */
  bands: { id: string; name: string; startPct: number; endPct: number }[]
  /** Where "now" sits on the bar, clamped to 0–100 %. */
  nowPct: number
  ticks: { label: string; pct: number }[]
}

/**
 * A single-day bar from 3 h before the first service (or now, if earlier) to the
 * end of the last service; after close "now" pins to the right edge. Services
 * that cross midnight are drawn to the end of the bar. Null when there are no services.
 */
export function dayTimeline(services: RcService[], nowMin: number): DayTimeline | null {
  if (services.length === 0) return null
  const sorted = [...services].sort((a, b) => a.timeMinutes - b.timeMinutes)
  const first = sorted[0].timeMinutes
  const endOf = (s: RcService) =>
    s.endMinutes == null ? s.timeMinutes + 120 : s.endMinutes < s.timeMinutes ? 1440 : s.endMinutes
  const lastEnd = Math.max(...sorted.map(endOf))
  const start = Math.floor(Math.max(0, Math.min(first - 180, nowMin)) / 60) * 60
  const end = Math.min(1440, Math.ceil(lastEnd / 60) * 60)
  const span = Math.max(60, end - start)
  const pct = (m: number) => Math.min(100, Math.max(0, ((m - start) / span) * 100))
  const short = (m: number) => fmtTimeOfDay(m).replace(':00', '')
  return {
    bands: sorted.map(s => ({ id: s.id, name: s.name, startPct: pct(s.timeMinutes), endPct: pct(endOf(s)) })),
    nowPct: pct(nowMin),
    ticks: [
      { label: short(start), pct: 0 },
      ...sorted.map(s => ({ label: `${short(s.timeMinutes)} ${s.name}`, pct: pct(s.timeMinutes) })),
      { label: short(end), pct: 100 },
    ],
  }
}

/** "9:00 am – 3:00 pm" for a service (end omitted when unknown). */
export function serviceHours(s: RcService): string {
  return s.endMinutes == null
    ? fmtTimeOfDay(s.timeMinutes)
    : `${fmtTimeOfDay(s.timeMinutes)} – ${fmtTimeOfDay(s.endMinutes)}`
}

/**
 * The big figure on the service clock. Null when the RC has no services
 * (on-demand) — the clock then shows prep only.
 */
export function clockText(status: ServiceStatus, nowMin: number): { label: string; big: string; sub: string } | null {
  switch (status.kind) {
    case 'upcoming':
      return {
        label: `${status.service.name} in`,
        big: fmtCountdown(status.minsUntil),
        sub: `${status.service.name} · ${serviceHours(status.service)}`,
      }
    case 'underway': {
      const s = status.service
      const sub = `${s.name} · ${serviceHours(s)}`
      if (s.endMinutes == null) return { label: `${s.name} is on`, big: 'Now', sub }
      const left = (((s.endMinutes - nowMin) % 1440) + 1440) % 1440
      return { label: `${s.name} ends in`, big: fmtCountdown(left), sub }
    }
    case 'closed':
      return { label: 'Service', big: 'Done', sub: 'No more services today' }
    case 'none':
      return null
  }
}
