import { nextServiceStart, prepDeadline, type SchedulableRc } from './service-hours'

export type PrepPriority = '911' | 'NEEDED_TODAY' | 'LATER'

export const PREP_PRIORITY_ORDER: PrepPriority[] = ['911', 'NEEDED_TODAY', 'LATER']

export const PREP_PRIORITY_META: Record<PrepPriority, {
  label: string
  badgeClass: string
  borderClass: string
  bgClass: string
  headingClass: string
  emoji: string
}> = {
  '911': {
    label: 'Critical',
    emoji: '🔴',
    badgeClass: 'bg-red-100 text-red-700 font-bold',
    borderClass: 'border-l-4 border-red-500',
    bgClass: 'bg-red-50',
    headingClass: 'text-red-700',
  },
  'NEEDED_TODAY': {
    label: 'Needed Today',
    emoji: '🟠',
    badgeClass: 'bg-orange-100 text-orange-700',
    borderClass: 'border-l-4 border-orange-400',
    bgClass: 'bg-orange-50',
    headingClass: 'text-orange-700',
  },
  'LATER': {
    label: 'Looking Good',
    emoji: '🟢',
    badgeClass: 'bg-green-100 text-green-700',
    borderClass: 'border-l-4 border-green-400',
    bgClass: 'bg-white',
    headingClass: 'text-green-700',
  },
}

export const PREP_STATUS_META: Record<string, { label: string; badgeClass: string }> = {
  NOT_STARTED: { label: 'Not Started', badgeClass: 'bg-gray-100 text-gray-500' },
  IN_PROGRESS: { label: 'In Progress', badgeClass: 'bg-blue-100 text-blue-700' },
  DONE:        { label: 'Done',        badgeClass: 'bg-green-100 text-green-700' },
  PARTIAL:     { label: 'Partial',     badgeClass: 'bg-amber-100 text-amber-700' },
  BLOCKED:     { label: 'Blocked',     badgeClass: 'bg-red-100 text-red-700' },
  SKIPPED:     { label: 'Skipped',     badgeClass: 'bg-gray-100 text-gray-400' },
}

export const PREP_CATEGORIES = ['MISC', 'SAUCE', 'DRESSING', 'PROTEIN', 'BAKED', 'GARNISH', 'BASE', 'PICKLED', 'DAIRY']
export const PREP_STATIONS   = ['Cold', 'Hot', 'Pastry', 'Butchery', 'Garde Manger']

/**
 * Compute the priority for a prep item.
 * manualOverride wins unconditionally.
 * _minThreshold is deprecated — kept for call-site compat during transition, ignored.
 */
export function computePriority(
  onHand: number,
  parLevel: number,
  _minThreshold: number,
  targetToday: number | null,
  manualOverride: string | null,
): PrepPriority {
  if (manualOverride) return manualOverride as PrepPriority
  if (onHand <= 0 && parLevel > 0) return '911'
  if (targetToday !== null && onHand < targetToday) return '911'
  if (onHand < parLevel) return 'NEEDED_TODAY'
  return 'LATER'
}

/** max(parLevel - onHand, targetToday - onHand, 0) */
export function computeSuggestedQty(
  onHand: number,
  parLevel: number,
  targetToday: number | null,
): number {
  const base = parLevel - onHand
  if (targetToday !== null) return Math.max(targetToday - onHand, base, 0)
  return Math.max(base, 0)
}

/**
 * Compute the scale factor for ingredient deduction / output credit.
 * unit='batch' → scale = actualPrepQty (each batch = one recipe run)
 * unit matches recipe yieldUnit → scale = actualPrepQty / baseYieldQty
 * otherwise → scale = 1, unitMismatch = true
 */
/**
 * Total estimated minutes of work remaining across all items.
 * Excludes items whose todayLog status is DONE or SKIPPED.
 */
export function computeWorkloadMinutes(
  items: Array<{ estimatedPrepTime: number | null; todayLog?: { status: string } | null }>,
): number {
  return items.reduce((sum, item) => {
    const status = item.todayLog?.status ?? 'NOT_STARTED'
    if (status === 'DONE' || status === 'SKIPPED') return sum
    return sum + (item.estimatedPrepTime ?? 0)
  }, 0)
}

export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return '0min'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}min`
  if (m === 0) return `${h}h`
  return `${h}h ${m}min`
}

export function computeScale(
  actualPrepQty: number,
  unit: string,
  recipeYieldUnit: string,
  recipeBaseYieldQty: number,
): { scale: number; unitMismatch: boolean } {
  if (unit === 'batch') return { scale: actualPrepQty, unitMismatch: false }
  if (unit === recipeYieldUnit && recipeBaseYieldQty > 0) {
    return { scale: actualPrepQty / recipeBaseYieldQty, unitMismatch: false }
  }
  return { scale: 1, unitMismatch: true }
}

/** Design status pills: maps our PrepStatus → the design's state + class suffix. */
export const PREP_STATE_META: Record<string, { key: 'not-started'|'in-progress'|'done'|'skipped'; label: string }> = {
  NOT_STARTED: { key: 'not-started', label: 'Not started' },
  IN_PROGRESS: { key: 'in-progress', label: 'In progress' },
  DONE:        { key: 'done',        label: 'Done' },
  PARTIAL:     { key: 'in-progress', label: 'Partial' },
  BLOCKED:     { key: 'not-started', label: 'Blocked' },
  SKIPPED:     { key: 'skipped',     label: 'Skipped' },
}

/** Short relative age like the design's "6d ago" / "just now". */
export function formatShortAge(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export interface ShiftSummary { total: number; done: number; inProgress: number; resolved: number; critical: number; blocked: number; onPar: number }

/** Shift-band rollup. `items` are the on-list items; statuses come from todayLog. */
export function computeShiftSummary(items: Array<{ priority: PrepPriority; isBlocked: boolean; todayLog?: { status: string } | null }>): ShiftSummary {
  let done = 0, inProgress = 0, resolved = 0, critical = 0, blocked = 0, onPar = 0
  for (const it of items) {
    const s = it.todayLog?.status ?? 'NOT_STARTED'
    if (s === 'DONE') { done++; resolved++ }
    else if (s === 'SKIPPED') resolved++
    else if (s === 'IN_PROGRESS') inProgress++
    const isResolved = s === 'DONE' || s === 'SKIPPED'
    if (!isResolved && it.priority === '911') critical++
    if (!isResolved && it.isBlocked) blocked++
    if (it.priority === 'LATER') onPar++
  }
  return { total: items.length, done, inProgress, resolved, critical, blocked, onPar }
}

/** Split on-list items into the design's groups. */
export function groupPrepItems<T extends { priority: PrepPriority }>(items: T[]): { critical: T[]; needed: T[]; later: T[] } {
  return {
    critical: items.filter(i => i.priority === '911'),
    needed:   items.filter(i => i.priority === 'NEEDED_TODAY'),
    later:    items.filter(i => i.priority === 'LATER'),
  }
}

// ── Service-time countdown (bridges the RC session's service-hours helpers) ──

/** View-model the prep header/band/rows consume for the service countdown. */
export interface PrepCountdown { serviceLabel: string; minsToService: number; startByHHMM: string }

/**
 * Build the prep countdown from the active revenue center's service schedule.
 * Returns null when the RC has no usable upcoming service window (feature off,
 * on-demand center, or no schedule) — callers then hide the countdown UI.
 */
export function buildPrepCountdown(rc: SchedulableRc | null | undefined, now: Date = new Date()): PrepCountdown | null {
  if (!rc) return null
  const next = nextServiceStart(rc, now)
  if (!next) return null
  const minsToService = Math.round((next.start.getTime() - now.getTime()) / 60_000)
  if (minsToService < 0) return null
  const startBy = prepDeadline(rc, now) ?? next.start
  const startByHHMM = `${String(startBy.getHours()).padStart(2, '0')}:${String(startBy.getMinutes()).padStart(2, '0')}`
  const hh = Math.floor(minsToService / 60), mm = minsToService % 60
  return { serviceLabel: hh > 0 ? `${hh}h ${mm}m` : `${mm}m`, minsToService, startByHHMM }
}
