// The Pass (manager hub, /pass and /today for LEAD+) — pure rules for what it
// shows from the Inbox, the station board and last night's handovers. No React,
// no Prisma, so `npm test` covers it (src/lib/__tests__/pass.test.ts).
import type { ServiceStatus } from '@/lib/service-hours'
import type { Severity, TagLite } from '@/lib/inbox/rules'
import type { StationTone, StationStatus } from '@/lib/checklists/station-status'
import { metaLine, whenLabel, type InboxItem } from '@/components/inbox/format'

// ── GET /api/checklists/handovers ──────────────────────────────────────────

export type HandoverNote = {
  stationName: string
  color: string
  isShared: boolean
  byName: string | null
  at: string | null
  note: string
}

export type HandoversView = { businessDate: string; notes: HandoverNote[] }

// ── Needs you first ────────────────────────────────────────────────────────

/** The phone shows 3, the desktop 6. */
export const PHONE_TOP = 3
export const DESKTOP_TOP = 6

/** NOW items first, then TODAY, up to `n`; FYI never. Keeps the list's own order inside a severity. */
export function topItems<T extends { severity: Severity }>(items: T[], n: number): T[] {
  const now = items.filter(i => i.severity === 'NOW')
  const today = items.filter(i => i.severity === 'TODAY')
  return [...now, ...today].slice(0, Math.max(0, n))
}

// ── Repeats become one line ────────────────────────────────────────────────

/**
 * How a family of app alerts reads as ONE line on the Pass. 14 "X — none left"
 * prep alerts become "14 prep items with nobody on them"; nine price rises
 * become "9 price rises". `short` cuts one alert's title to the name the line
 * lists ("Hollandaise — none left" → "Hollandaise").
 */
type GroupSpec = { title: (n: number) => string; href: string | null; short: (title: string) => string }

const GROUPS: Record<string, GroupSpec> = {
  prep: {
    title: n => `${n} prep items with nobody on them`,
    href: '/prep',
    short: t => t.replace(/\s+—\s+.*$/, ''),
  },
  price: {
    title: n => `${n} price rises`,
    href: '/invoices',
    short: t => t.replace(/\s+at\s+.*$/, '').replace(/\s+up\s+/, ' +'),
  },
  'station-open': {
    title: n => `${n} stations haven’t started opening`,
    href: '/checklist/today?phase=OPEN',
    short: t => t.replace(/\s+hasn't started opening$/, ''),
  },
  'close-unsigned': {
    title: n => `${n} closing lists weren’t signed off`,
    href: '/checklist/today?phase=CLOSE',
    short: t => t.replace(/\s+closing wasn't signed off$/, ''),
  },
  'temp-bad': {
    title: n => `${n} fridges out of range`,
    href: '/temps',
    short: t => t,
  },
  flag: {
    title: n => `${n} flagged jobs`,
    href: '/checklist/today',
    short: t => t,
  },
  phone: {
    title: n => `${n} phones waiting for an OK`,
    href: '/setup/sign-ins',
    short: t => t,
  },
}

export type PassItemRow<T> = { type: 'item'; key: string; severity: Severity; item: T }
export type PassGroupRow<T> = {
  type: 'group'
  key: string
  kind: string
  severity: Severity
  title: string
  /** "Hollandaise · Bacon Jam · Chimichurri +11" */
  detail: string
  href: string | null
  tag: TagLite
  items: T[]
}
export type PassRow<T> = PassItemRow<T> | PassGroupRow<T>

type Groupable = { id: string; severity: Severity; title: string; kind?: string | null; tag: TagLite }

const RANK: Record<Severity, number> = { NOW: 0, TODAY: 1, FYI: 2 }

/** "A · B · C +4" — the first three names, then how many more. */
export function namesLine(names: string[], show = 3): string {
  const head = names.slice(0, show).join(' · ')
  return names.length > show ? `${head} +${names.length - show}` : head
}

/**
 * The Pass list: NOW then TODAY (FYI never), with every family of two or more
 * app alerts folded into one row at the place its first alert stood. A row's
 * severity is its most urgent alert. Reports and lone alerts stay as they are.
 */
export function passRows<T extends Groupable>(items: T[]): PassRow<T>[] {
  const live = items.filter(i => i.severity !== 'FYI')
  const byKind = new Map<string, T[]>()
  for (const i of live) {
    if (!i.kind || !GROUPS[i.kind]) continue
    byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), i])
  }
  const rows: PassRow<T>[] = []
  const placed = new Set<string>()
  for (const i of live) {
    const family = i.kind ? byKind.get(i.kind) : undefined
    if (family && family.length > 1) {
      if (placed.has(i.kind!)) continue
      placed.add(i.kind!)
      const spec = GROUPS[i.kind!]
      const severity = family.reduce<Severity>((s, x) => (RANK[x.severity] < RANK[s] ? x.severity : s), 'FYI')
      rows.push({
        type: 'group',
        key: `group:${i.kind}`,
        kind: i.kind!,
        severity,
        title: spec.title(family.length),
        detail: namesLine(family.map(x => spec.short(x.title))),
        href: spec.href,
        tag: i.tag,
        items: family,
      })
    } else {
      rows.push({ type: 'item', key: i.id, severity: i.severity, item: i })
    }
  }
  // Stable: NOW rows first, then TODAY, each in the list's own order.
  return rows.sort((a, b) => RANK[a.severity] - RANK[b.severity])
}

/** The rows on screen and how many more are left behind "See all". */
export function topRows<T extends Groupable>(items: T[], n: number): { rows: PassRow<T>[]; more: number; nowCount: number } {
  const all = passRows(items)
  return {
    rows: all.slice(0, Math.max(0, n)),
    more: Math.max(0, all.length - n),
    nowCount: all.filter(r => r.severity === 'NOW').length,
  }
}

/** NOW + TODAY items left in the Inbox after the ones shown. */
export function moreCount(items: Array<{ severity: Severity }>, shown: number): number {
  return Math.max(0, items.filter(i => i.severity !== 'FYI').length - shown)
}

export const countNow = (items: Array<{ severity: Severity }>) => items.filter(i => i.severity === 'NOW').length

/** 68 → "1h 08m"; 45 → "45m". */
export function fmtDoors(mins: number): string {
  const m = Math.max(0, Math.round(mins))
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

/**
 * The sentence under the greeting, in parts so the page can bold them:
 * "Doors in 1h 08m. 3 things need you before then." The doors clause is only
 * there while a service is still to come today; during service it reads
 * "Lunch is on.", and with no service today it is left out.
 */
export type PassLede = { doors: string | null; on: string | null; things: string | null; rest: string }

export function passLede(status: ServiceStatus, nowCount: number): PassLede {
  const doors = status.kind === 'upcoming' ? fmtDoors(status.minsUntil) : null
  const on = status.kind === 'underway' ? status.service.name : null
  const when = doors ? 'before then' : on ? 'now' : 'right now'
  if (nowCount <= 0) return { doors, on, things: null, rest: `Nothing needs you ${when}.` }
  return {
    doors,
    on,
    things: `${nowCount} ${nowCount === 1 ? 'thing' : 'things'}`,
    rest: ` ${nowCount === 1 ? 'needs' : 'need'} you ${when}.`,
  }
}

/** The lede as one plain string (tests, aria). */
export function ledeText(l: PassLede): string {
  return [
    l.doors ? `Doors in ${l.doors}. ` : '',
    l.on ? `${l.on} is on. ` : '',
    l.things ?? '',
    l.rest,
  ].join('').replace(/^\s+/, '')
}

const SHORT_CTA: Array<[string, string]> = [
  ['/checklist/today', 'Board'],
  ['/setup/sign-ins', 'Review'],
  // Alerts raised before the move keep the old address; the middleware redirects it.
  ['/checklist/crew', 'Review'],
  ['/temps', 'Check it'],
  ['/prep', 'Prep'],
  ['/invoices', 'Invoices'],
  ['/count', 'Count'],
  ['/inventory', 'Stock'],
  ['/recipes', 'Recipe'],
]

/** A row's button: where its link goes in a word, or "Open" (the item sheet) when it has none. */
export function ctaLabel(href: string | null): string {
  if (!href) return 'Open'
  const path = href.split(/[?#]/)[0]
  return SHORT_CTA.find(([p]) => path === p || path.startsWith(p + '/'))?.[1] ?? 'Go'
}

/** Row meta: who · where · what they said · when. */
export function itemMeta(item: Pick<InboxItem, 'title' | 'body' | 'place' | 'raisedByName' | 'source' | 'createdAt'>, now: Date = new Date()): string {
  return [metaLine(item), whenLabel(item.createdAt, now)].filter(Boolean).join(' · ')
}

// ── Inbox by tag ───────────────────────────────────────────────────────────

export type TagRow = { tag: TagLite; count: number; now: number }

/** Tags with something open, in tag order, with how many of those are NOW. */
export function tagRows(tags: TagLite[], byTag: Record<string, number>, items: Array<{ tagId: string; severity: Severity }>): TagRow[] {
  return tags
    .map(tag => ({
      tag,
      count: byTag[tag.id] ?? 0,
      now: items.filter(i => i.tagId === tag.id && i.severity === 'NOW').length,
    }))
    .filter(r => r.count > 0)
}

// ── Stations ───────────────────────────────────────────────────────────────

export type PassStation = {
  id: string
  name: string
  color: string
  isShared: boolean
  crew: string[]
  handled: number
  total: number
  status: StationStatus
  signedOffAt: string | null
}

export type StationTile = { stat: string; who: string | null; pct: number; tone: StationTone }

const firstName = (s: string) => s.trim().split(/\s+/)[0] ?? s

/**
 * One station tile: the stat ("NOT STARTED", "9/12", "6/9 · 1 FLAGGED",
 * "DONE 7:48"), who is on it, and how far along the bar is.
 */
export function stationTile(s: PassStation, now: Date = new Date()): StationTile {
  const who = s.crew.length > 0
    ? `${firstName(s.crew[0])}${s.crew.length > 1 ? ` +${s.crew.length - 1}` : ''}`
    : s.isShared ? 'Shared' : null
  const tone = s.status.tone
  const pct = s.total > 0 ? Math.round((s.handled / s.total) * 100) : tone === 'green' ? 100 : 0
  if (tone === 'green') {
    const at = s.signedOffAt ? whenLabel(s.signedOffAt, now) : ''
    return { stat: at ? `DONE ${at}` : 'DONE', who, pct: 100, tone }
  }
  if (s.status.label === 'NOT STARTED' || s.status.label === 'NOTHING TODAY') {
    return { stat: s.status.label, who, pct: 0, tone }
  }
  const progress = `${s.handled}/${s.total}`
  return { stat: s.status.label === 'IN PROGRESS' ? progress : `${progress} · ${s.status.label}`, who, pct, tone }
}

/** "3 OF 6 DONE" — stations with nothing on today's list are left out of both numbers. */
export function stationsDone(stations: PassStation[]): { done: number; of: number } {
  const live = stations.filter(s => s.status.label !== 'NOTHING TODAY')
  return { done: live.filter(s => s.status.tone === 'green').length, of: live.length }
}

// ── Ready for doors (it replaced the Pre-shift page) ───────────────────────

export type ReadyGauge = { key: 'stations' | 'mustdos' | 'prep'; label: string; done: number; of: number }
export type ReadyForDoors = { gauges: ReadyGauge[]; pct: number }

const PREP_DONE = new Set(['DONE', 'PARTIAL'])

/**
 * Before doors, the Pass shows how ready the kitchen is, from what is already
 * true elsewhere — no list of its own to tick:
 * - stations: opening lists started (not "NOT STARTED"), shared list and
 *   stations with nothing today left out;
 * - must-dos: every opening must-do across the stations and the whole-kitchen
 *   list, done or flagged;
 * - 911 prep: critical prep done.
 * A gauge with nothing to count is left out; `pct` is all done ÷ all counted.
 */
export function readyForDoors(
  stations: Array<{ isShared: boolean; status: { label: string }; lines: Array<{ isBlocker: boolean; status: string }> }>,
  prep: Array<{ priority: string; todayLog?: { status: string } | null }>,
): ReadyForDoors {
  const live = stations.filter(s => !s.isShared && s.status.label !== 'NOTHING TODAY')
  const blockers = stations.flatMap(s => s.lines.filter(l => l.isBlocker))
  const critical = prep.filter(p => p.priority === '911')
  const gauges: ReadyGauge[] = [
    { key: 'stations' as const, label: 'Stations open', done: live.filter(s => s.status.label !== 'NOT STARTED').length, of: live.length },
    { key: 'mustdos' as const, label: 'Must-dos done', done: blockers.filter(l => l.status !== 'TODO').length, of: blockers.length },
    { key: 'prep' as const, label: '911 prep done', done: critical.filter(p => !!p.todayLog && PREP_DONE.has(p.todayLog.status)).length, of: critical.length },
  ].filter(g => g.of > 0)
  const done = gauges.reduce((n, g) => n + g.done, 0)
  const of = gauges.reduce((n, g) => n + g.of, 0)
  return { gauges, pct: of > 0 ? Math.round((done / of) * 100) : 100 }
}

export type DayPart = 'before' | 'service' | 'closing'

/** Where the day is, from the service clock: before doors, in service, or closing (after the last service). */
export function dayPart(status: ServiceStatus): DayPart | null {
  if (status.kind === 'upcoming') return 'before'
  if (status.kind === 'underway') return 'service'
  if (status.kind === 'closed') return 'closing'
  return null
}
