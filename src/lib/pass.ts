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
  ['/checklist/crew', 'Review'],
  ['/temps', 'Check it'],
  ['/prep', 'Prep'],
  ['/invoices', 'Invoices'],
  ['/count', 'Count'],
  ['/inventory', 'Stock'],
  ['/recipes', 'Recipe'],
  ['/end-of-day', 'Close'],
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
