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

/** Screen-reader name of the bell button. */
export function bellAriaLabel(isLead: boolean, count: number): string {
  if (!isLead) return count > 0 ? `Your reports, ${count} fixed` : 'Your reports'
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
