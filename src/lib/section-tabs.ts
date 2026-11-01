// The one row of tabs at the top of a section (Open & close, Inbox): which
// tabs a role sees, where each goes, and the count it carries. Pure, so the
// role rules are tested without rendering. What a page REQUIRES is still
// enforced by route-access + the API; this only decides what to offer.
import type { Role } from '@prisma/client'
import { atLeast } from '@/lib/roles'

export type SectionTab = {
  key: string
  label: string
  href: string
  /** Shown beside the label when > 0. */
  count?: number
  /** Red count: something needs someone now. */
  alert?: boolean
}

export type ChecklistTabKey = 'mine' | 'board' | 'crew' | 'history' | 'edit'
export type ChecklistTabCounts = { behind?: number; phones?: number }

/**
 * Open & close. A cook has only their own list, so no row at all (empty).
 * A lead adds the station board; a manager also gets sign-ins, history and
 * the list editor.
 */
export function checklistTabs(role: Role | null, counts: ChecklistTabCounts = {}): SectionTab[] {
  if (!role || !atLeast(role, 'LEAD')) return []
  const tabs: SectionTab[] = [
    { key: 'mine', label: 'My list', href: '/checklist' },
    { key: 'board', label: 'Stations', href: '/checklist/today', count: counts.behind, alert: true },
  ]
  if (atLeast(role, 'MANAGER')) {
    tabs.push(
      { key: 'crew', label: 'Sign-ins', href: '/checklist/crew', count: counts.phones, alert: true },
      { key: 'history', label: 'History', href: '/checklist/history' },
      { key: 'edit', label: 'Edit lists', href: '/checklist/edit' },
    )
  }
  return tabs
}

export type InboxTabKey = 'open' | 'waiting' | 'snoozed' | 'done' | 'tags'
export type InboxTabCounts = { open?: number; now?: number; waiting?: number; snoozed?: number }

/** Inbox views are `?view=` on /inbox; Tags is its own page for managers. */
export function inboxTabs(role: Role | null, counts: InboxTabCounts = {}): SectionTab[] {
  const tabs: SectionTab[] = [
    { key: 'open', label: 'Open', href: '/inbox', count: counts.open, alert: (counts.now ?? 0) > 0 },
    { key: 'waiting', label: 'Waiting', href: '/inbox?view=waiting', count: counts.waiting },
    { key: 'snoozed', label: 'Snoozed', href: '/inbox?view=snoozed', count: counts.snoozed },
    { key: 'done', label: 'Done', href: '/inbox?view=done' },
  ]
  if (role && atLeast(role, 'MANAGER')) tabs.push({ key: 'tags', label: 'Tags', href: '/inbox/tags' })
  return tabs
}

const INBOX_VIEWS = ['open', 'waiting', 'snoozed', 'done'] as const
export type InboxViewKey = (typeof INBOX_VIEWS)[number]

/** `?view=` → a list view; anything else (missing, junk) is Open. */
export function parseInboxView(v: string | null): InboxViewKey {
  return (INBOX_VIEWS as readonly string[]).includes(v ?? '') ? (v as InboxViewKey) : 'open'
}
