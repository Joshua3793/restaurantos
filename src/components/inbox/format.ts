// Pure display helpers for the Inbox screens: times, severity groups, row meta
// and the "What happened" wording. No React and no server imports, so it is
// covered by `npm test` (src/components/inbox/__tests__/format.test.ts).
import type { Severity, Status, TagLite } from '@/lib/inbox/rules'

const PACIFIC = 'America/Los_Angeles'
const DAY_MS = 24 * 60 * 60 * 1000

// ── API shapes (mirrors src/lib/inbox/store.ts, which is server-only) ──────

export type InboxSource = 'REPORT' | 'FLAG' | 'SYSTEM'

export type InboxItem = {
  id: string
  tagId: string
  severity: Severity
  status: Status
  managerOnly: boolean
  snoozeUntil: string | null
  clearedAt: string | null
  doneById: string | null
  createdAt: string
  title: string
  body: string | null
  place: string | null
  href: string | null
  source: InboxSource
  tag: TagLite
  raisedById: string | null
  raisedByName: string | null
  doneByName: string | null
  doneAt: string | null
  unread: boolean
  revenueCenterId: string | null
}

export type InboxEventKind =
  | 'RAISED' | 'SEEN' | 'NOTE' | 'SNOOZED' | 'WAITING' | 'REOPENED' | 'DONE' | 'CLEARED' | 'RETAGGED'

export type InboxEvent = { kind: InboxEventKind; byName: string | null; note: string | null; at: string }

export type InboxCounts = { byTag: Record<string, number>; open: number; done: number; snoozed: number }

export type InboxList = { items: InboxItem[]; counts: InboxCounts; tags: TagLite[] }

export type InboxDetail = { item: InboxItem; events: InboxEvent[]; limited?: true }

export type InboxAction =
  | { kind: 'note'; note: string }
  | { kind: 'snooze' }
  | { kind: 'wait'; note?: string }
  | { kind: 'done'; note?: string }
  | { kind: 'reopen' }
  | { kind: 'retag'; tagId: string }

/** The one list the page shows: open (or its waiting slice), snoozed (still asleep), or done. */
export type InboxView = 'open' | 'snoozed' | 'waiting' | 'done'

// ── times ──────────────────────────────────────────────────────────────────

const pacificDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: PACIFIC, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

function parts(d: Date) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC, weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)
  const get = (t: string) => p.find(x => x.type === t)?.value ?? ''
  return { weekday: get('weekday'), day: get('day'), month: get('month'), hour: get('hour'), minute: get('minute') }
}

/**
 * Pacific time of an item or event: today reads '7:41', the past week reads
 * 'WED 22:35', anything older reads '25 OCT'.
 */
export function whenLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  const p = parts(d)
  const time = `${Number(p.hour)}:${p.minute}`
  if (pacificDay(d) === pacificDay(now)) return time
  if (now.getTime() - d.getTime() < 6 * DAY_MS) return `${p.weekday.toUpperCase()} ${time}`
  return `${p.day} ${p.month.toUpperCase()}`
}

// ── severity ───────────────────────────────────────────────────────────────

export const SEVERITY_ORDER: Severity[] = ['NOW', 'TODAY', 'FYI']

export const GROUP_LABEL: Record<Severity, string> = {
  NOW: 'NOW · BEFORE DOORS',
  TODAY: 'TODAY',
  FYI: 'FOR YOUR INFO',
}

export const GROUP_TONE: Record<Severity, string> = {
  NOW: 'text-red-text',
  TODAY: 'text-gold-2',
  FYI: 'text-blue-text',
}

export const SEVERITY_PILL: Record<Severity, string> = {
  NOW: 'bg-red-soft text-red-text',
  TODAY: 'bg-gold-soft text-gold-2',
  FYI: 'bg-blue-soft text-blue-text',
}

/** Severity groups in NOW → TODAY → FYI order, empty groups left out. Keeps the list's own order inside a group. */
export function groupBySeverity<T extends { severity: Severity }>(items: T[]): Array<{ severity: Severity; items: T[] }> {
  return SEVERITY_ORDER
    .map(severity => ({ severity, items: items.filter(i => i.severity === severity) }))
    .filter(g => g.items.length > 0)
}

// ── filters ────────────────────────────────────────────────────────────────

export type InboxFilter = { view: InboxView; tagId: string | null; place: string | null; from: string | null }

/** Applies the view slice and the tag / where / from picks to a fetched list. */
export function applyFilter(items: InboxItem[], f: InboxFilter): InboxItem[] {
  return items.filter(i =>
    (f.view === 'snoozed' ? i.status === 'SNOOZED' : f.view === 'waiting' ? i.status === 'WAITING' : true) &&
    (!f.tagId || i.tagId === f.tagId) &&
    (!f.place || i.place === f.place) &&
    (!f.from || i.raisedById === f.from))
}

/** Distinct places, A→Z. */
export function placesOf(items: InboxItem[]): string[] {
  return Array.from(new Set(items.map(i => i.place).filter((p): p is string => !!p))).sort((a, b) => a.localeCompare(b))
}

/** Distinct people who raised something, by name A→Z. */
export function peopleOf(items: InboxItem[]): Array<{ id: string; name: string }> {
  const m = new Map<string, string>()
  for (const i of items) if (i.raisedById && i.raisedByName && !m.has(i.raisedById)) m.set(i.raisedById, i.raisedByName)
  return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}

/** Count per tag in a list (the Done tab, where the API's chip counts are open counts). */
export function countByTag(items: InboxItem[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const i of items) out[i.tagId] = (out[i.tagId] ?? 0) + 1
  return out
}

// ── row + sheet wording ────────────────────────────────────────────────────

/** The body, unless it only repeats the title (a one-line report). */
export function extraBody(item: Pick<InboxItem, 'title' | 'body'>): string | null {
  const b = item.body?.trim()
  return b && b !== item.title.trim() ? b : null
}

/** Row meta: who · where · what they said. A cook's own words are quoted. */
export function metaLine(item: Pick<InboxItem, 'title' | 'body' | 'place' | 'raisedByName' | 'source'>): string {
  const body = extraBody(item)
  const said = body ? (item.source === 'REPORT' ? `“${body}”` : body) : null
  return [item.raisedByName, item.place, said].filter(Boolean).join(' · ')
}

/**
 * The done pill: who fixed it, or — when it closed itself — the app's own
 * reason from the latest CLEARED event, in caps.
 */
export function doneLabel(
  item: Pick<InboxItem, 'doneByName' | 'clearedAt'>,
  events: Pick<InboxEvent, 'kind' | 'note'>[],
): string {
  if (item.doneByName?.trim()) return `FIXED BY ${item.doneByName.trim().toUpperCase()}`
  if (item.clearedAt) {
    const note = [...events].reverse().find(e => e.kind === 'CLEARED')?.note?.trim()
    return note ? note.toUpperCase() : 'CLEARED'
  }
  return 'FIXED'
}

/** Who did it — events with no name were written by the app. */
export const who = (e: Pick<InboxEvent, 'byName'>) => e.byName?.trim() || 'The app'

/** One "What happened" line. */
export function eventText(e: InboxEvent, source: InboxSource): string {
  const name = who(e)
  const quoted = e.note?.trim() ? `“${e.note.trim()}”` : null
  switch (e.kind) {
    case 'RAISED':
      if (source === 'SYSTEM') return 'Spotted by the app'
      return `${source === 'FLAG' ? 'Flagged' : 'Raised'} by ${name}`
    case 'SEEN': return `Seen by ${name}`
    case 'NOTE': return `${name}: ${quoted ?? ''}`.trim()
    case 'SNOOZED': return 'Snoozed till tomorrow'
    case 'WAITING': return quoted ? `Waiting on someone: ${quoted}` : 'Waiting on someone'
    case 'DONE': return quoted ? `Fixed by ${name}: ${quoted}` : `Fixed by ${name}`
    case 'REOPENED': return 'Reopened'
    // The app says why it closed it: 'Day ended — not fixed', 'Cleared itself — the job was redone'.
    case 'CLEARED': return e.note?.trim() || 'Cleared itself'
    case 'RETAGGED': {
      // Stored as "Old → New".
      const to = e.note?.split('→').pop()?.trim()
      return to ? `Moved to ${to}` : 'Moved to another tag'
    }
  }
}

/** Who to name after a line whose wording does not already say it. */
export function eventBy(e: InboxEvent): string | null {
  if (e.kind === 'SNOOZED' || e.kind === 'WAITING' || e.kind === 'REOPENED' || e.kind === 'RETAGGED') {
    return e.byName?.trim() || null
  }
  return null
}

const GO_TO: Array<[string, string]> = [
  ['/checklist/today', 'today’s checklists'],
  ['/checklist/crew', 'crew sign-in'],
  ['/temps', 'temps'],
  ['/prep', 'prep'],
  ['/invoices', 'invoices'],
  ['/count', 'the count'],
  ['/inventory', 'inventory'],
  ['/recipes', 'recipes'],
  ['/end-of-day', 'end of day'],
]

/** "Go to …" wording for a system item's own link. */
export function goToLabel(href: string): string {
  const path = href.split(/[?#]/)[0]
  const hit = GO_TO.find(([p]) => path === p || path.startsWith(p + '/'))
  return `Go to ${hit ? hit[1] : 'it'}`
}
