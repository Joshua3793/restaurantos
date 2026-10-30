// Pure Inbox rules: severity, snooze, visibility, flag routing, and how a
// system alert reconciles with its live condition. No Prisma client and no
// React imports, so this is safe on the client.
import type { Role } from '@prisma/client'
import { atLeast } from '@/lib/roles'
import { pacificDate } from '@/lib/checklists/rules'

export type Severity = 'NOW' | 'TODAY' | 'FYI'
export type Status = 'OPEN' | 'SNOOZED' | 'WAITING' | 'DONE'

export type TagLite = {
  id: string
  builtIn: string | null
  name: string
  color: string
  cookCanPick: boolean
  managerOnly: boolean
  isActive: boolean
}

export type ItemLite = {
  id: string
  tagId: string
  severity: Severity
  status: Status
  managerOnly: boolean
  snoozeUntil: string | null
  clearedAt: string | null
  doneById: string | null
  createdAt: string
}

const TZ = 'America/Los_Angeles'

/**
 * How a system alert meets its live condition.
 * - no item + present: create
 * - open / snoozed / waiting + gone: clear (the app closes it, "Cleared itself")
 * - DONE by the app (clearedAt set) + present again: reopen
 * - anything else (including DONE by a person): none
 */
export function reconcile(
  existing: Pick<ItemLite, 'status' | 'clearedAt' | 'doneById'> | null,
  present: boolean,
  now: Date,
): { action: 'create' | 'clear' | 'reopen' | 'none' } {
  void now
  if (!existing) return { action: present ? 'create' : 'none' }
  if (existing.status === 'DONE') {
    return { action: present && existing.clearedAt ? 'reopen' : 'none' }
  }
  return { action: present ? 'none' : 'clear' }
}

/** Does `d` read as 05:00 on the given Pacific calendar day? */
function isFiveAmOn(d: Date, ymd: string): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(d)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
  return pacificDate(d) === ymd && get('hour') === 5 && get('minute') === 0
}

/** 05:00 Pacific on the next Pacific calendar day (DST-safe). */
export function snoozeUntilTomorrow(now: Date): Date {
  const [y, m, d] = pacificDate(now).split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  const ymd = next.toISOString().slice(0, 10)
  // Pacific is UTC-7 (PDT) or UTC-8 (PST): 05:00 local is 12:00Z or 13:00Z.
  for (const offset of [7, 8]) {
    const cand = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), 5 + offset))
    if (isFiveAmOn(cand, ymd)) return cand
  }
  // Unreachable for America/Los_Angeles; keep a sane answer anyway.
  return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), 13))
}

/** OPEN or WAITING, or SNOOZED once its snooze time has passed. */
export function isOpenNow(item: Pick<ItemLite, 'status' | 'snoozeUntil'>, now: Date): boolean {
  if (item.status === 'OPEN' || item.status === 'WAITING') return true
  if (item.status === 'SNOOZED') {
    return item.snoozeUntil != null && new Date(item.snoozeUntil).getTime() <= now.getTime()
  }
  return false
}

/** Below LEAD sees nothing; LEAD does not see manager-only items or tags. */
export function canSee(
  role: Role,
  item: { managerOnly: boolean },
  tag?: { managerOnly: boolean },
): boolean {
  if (!atLeast(role, 'LEAD')) return false
  if (atLeast(role, 'MANAGER')) return true
  return !item.managerOnly && !tag?.managerOnly
}

/** Which tag a checklist flag lands in. */
export function flagTagId(reason: string, routes: Record<string, string>, tags: TagLite[]): string {
  const builtIn = (key: string) => tags.find(t => t.builtIn === key)?.id ?? `tag-${key.toLowerCase()}`
  if (reason === 'OUT_OF_RANGE') return builtIn('FOOD_SAFETY')
  const routed = routes[reason]
  if (routed && tags.some(t => t.id === routed && t.isActive)) return routed
  return builtIn('CHECKLISTS')
}

export function flagSeverity(isBlocker: boolean): Severity {
  return isBlocker ? 'NOW' : 'TODAY'
}

const SEVERITY_ORDER: Severity[] = ['NOW', 'TODAY', 'FYI']

export function groupItems<T extends { severity: Severity }>(items: T[]): { severity: Severity; items: T[] }[] {
  return SEVERITY_ORDER
    .map(severity => ({ severity, items: items.filter(i => i.severity === severity) }))
    .filter(g => g.items.length > 0)
}

/** Items the viewer can see that are open now and NOW or TODAY. */
export function badgeCount(
  items: ItemLite[],
  role: Role,
  tagsById: Map<string, { managerOnly: boolean }>,
  now: Date,
): number {
  return items.filter(i =>
    i.severity !== 'FYI' &&
    isOpenNow(i, now) &&
    canSee(role, i, tagsById.get(i.tagId)),
  ).length
}

type SeedTag = {
  id: string
  builtIn: string | null
  name: string
  color: string
  cookCanPick: boolean
  managerOnly: boolean
  sortOrder: number
}

const seed = (
  key: string, builtIn: boolean, name: string, color: string,
  flags: { cookCanPick?: boolean; managerOnly?: boolean } = {},
): Omit<SeedTag, 'sortOrder'> => ({
  id: `tag-${key}`,
  builtIn: builtIn ? key.toUpperCase() : null,
  name,
  color,
  cookCanPick: flags.cookCanPick ?? false,
  managerOnly: flags.managerOnly ?? false,
})

export const SEED_TAGS: SeedTag[] = [
  seed('food_safety', true, 'Food safety', '#dc2626', { cookCanPick: true }),
  seed('checklists', true, 'Checklists', '#2563eb'),
  seed('prep', true, 'Prep', '#16a34a', { cookCanPick: true }),
  seed('stock', true, 'Stock', '#0d9488', { cookCanPick: true }),
  seed('money', true, 'Money', '#7c3aed', { managerOnly: true }),
  seed('team', true, 'Team', '#71717a'),
  seed('maintenance', false, 'Maintenance', '#ea580c', { cookCanPick: true }),
  seed('events', false, 'Events', '#db2777', { cookCanPick: true }),
  seed('other', false, 'Other', '#71717a', { cookCanPick: true }),
].map((t, sortOrder) => ({ ...t, sortOrder }))

export const SEED_ROUTES: Record<string, string> = {
  BROKEN: 'tag-maintenance',
  RAN_OUT: 'tag-stock',
  OTHER: 'tag-other',
}
