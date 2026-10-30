// Pure display helpers for the alerts bell (src/components/AlertsBell.tsx):
// which Inbox items the dropdown shows, the badge text, the aria label, and
// the "Your reports" rows a cook sees. No React, so `npm test` covers it.
import { whenLabel } from '@/components/inbox/format'

export const BELL_LIMIT = 5

type Severity = 'NOW' | 'TODAY' | 'FYI'

export type BellItem = {
  id: string
  severity: Severity
  status: string
  title: string
  createdAt: string
  tag: { color: string; name: string }
}

export type BellReport = {
  id: string
  /** Fixed since this cook last opened it: the gold "new" dot. */
  fixedSinceSeen?: boolean
  status: string
  title: string
  createdAt: string
  doneAt: string | null
  doneByName: string | null
}

/**
 * The few open items the bell shows: NOW first, then TODAY (the same two
 * severities the badge counts; FYI never reaches the bell). Keeps the list's
 * own order inside a severity, and only items that are still open.
 */
export function topBellItems<T extends Pick<BellItem, 'severity' | 'status'>>(items: T[], limit = BELL_LIMIT): T[] {
  const open = items.filter(i => i.status === 'OPEN')
  return [
    ...open.filter(i => i.severity === 'NOW'),
    ...open.filter(i => i.severity === 'TODAY'),
  ].slice(0, limit)
}

/** The red dot's text: nothing at 0, the number to 9, then 9+. */
export function badgeText(n: number): string {
  if (!(n > 0)) return ''
  return n > 9 ? '9+' : String(n)
}

export type BellKind = 'lead' | 'staff' | 'unknown'

/** Screen-reader name of the bell button. Until the role is known it is just "Inbox". */
export function bellAriaLabel(kind: BellKind, count: number): string {
  if (kind === 'unknown') return 'Inbox'
  if (kind === 'staff') return count > 0 ? `Your reports, ${count} fixed` : 'Your reports'
  return `Inbox, ${Math.max(0, count)} open`
}

/** A cook's report is FIXED once it is done; anything else is still OPEN. */
export function reportPill(status: string): { label: 'OPEN' | 'FIXED'; fixed: boolean } {
  return status === 'DONE' ? { label: 'FIXED', fixed: true } : { label: 'OPEN', fixed: false }
}

/** The grey line under a report: "Fixed by Sam · 7:41" or "Reported · WED 22:35". */
export function reportMeta(r: BellReport, now: Date = new Date()): string {
  if (r.status === 'DONE') {
    const when = whenLabel(r.doneAt, now)
    const who = r.doneByName ? `Fixed by ${r.doneByName}` : 'Fixed'
    return when ? `${who} · ${when}` : who
  }
  const when = whenLabel(r.createdAt, now)
  return when ? `Reported · ${when}` : 'Reported'
}

/** The phone "More" badge: invoices to review, price alerts, and the Inbox. */
export function moreBadgeTotal(c: { invoicesReview: number; priceAlerts: number; inbox: number }): number {
  return c.invoicesReview + c.priceAlerts + c.inbox
}

// ── a cook taps one of their reports ───────────────────────────────────────

export type ReportDetailResponse = {
  item: { body: string | null; status: string; doneAt: string | null; doneByName: string | null; createdAt: string }
  events: { kind: string; byName: string | null; note: string | null; at: string }[]
  limited?: true
}

/** What an opened report shows under its title: the body, how it ended, and the closing note. */
export function reportDetail(
  d: ReportDetailResponse,
  now: Date = new Date(),
): { body: string | null; resolution: string | null; note: string | null } {
  const last = (kind: string) => [...d.events].reverse().find(e => e.kind === kind)
  const cleared = last('CLEARED')
  if (d.item.status === 'DONE') {
    const done = last('DONE')
    return {
      body: d.item.body,
      resolution: reportMeta({ id: '', title: '', createdAt: d.item.createdAt, status: 'DONE', doneAt: d.item.doneAt, doneByName: d.item.doneByName }, now),
      note: done?.note ?? cleared?.note ?? null,
    }
  }
  if (cleared) {
    const when = whenLabel(cleared.at, now)
    return { body: d.item.body, resolution: when ? `Cleared · ${when}` : 'Cleared', note: cleared.note }
  }
  return { body: d.item.body, resolution: null, note: null }
}

/**
 * The STAFF badge only drops once a SEEN event exists, and only the item
 * detail read writes it. So opening a report is: read it (writes SEEN), refresh
 * the badge, then re-fetch the list so the "new" dot goes. A failed read stops
 * there: nothing changed, so nothing is refreshed.
 */
export async function openReport<D>(deps: {
  id: string
  rcId: string | null
  read: (id: string) => Promise<D>
  // Called as soon as the read lands, so the row opens without waiting on the
  // badge refresh (which can sit behind a slow poll).
  onRead?: (detail: D) => void
  refreshCount: (rcId: string) => Promise<unknown>
  reloadReports: () => Promise<unknown>
}): Promise<D> {
  const detail = await deps.read(deps.id)
  deps.onRead?.(detail)
  if (deps.rcId) await deps.refreshCount(deps.rcId).catch(() => {})
  await deps.reloadReports().catch(() => {})
  return detail
}
