import { nextServiceStart, prepDeadline, type SchedulableRc } from './service-hours'
import { convertQty, sameDimension } from './uom'

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
    badgeClass: 'bg-red-soft text-red-text font-bold',
    borderClass: 'border-l-4 border-red',
    bgClass: 'bg-red-soft',
    headingClass: 'text-red-text',
  },
  'NEEDED_TODAY': {
    label: 'Needed Today',
    emoji: '🟠',
    badgeClass: 'bg-gold-soft text-gold-2',
    borderClass: 'border-l-4 border-gold',
    bgClass: 'bg-gold-soft',
    headingClass: 'text-gold-2',
  },
  'LATER': {
    label: 'Looking Good',
    emoji: '🟢',
    badgeClass: 'bg-green-soft text-green-text',
    borderClass: 'border-l-4 border-green',
    bgClass: 'bg-white',
    headingClass: 'text-green-text',
  },
}

export const PREP_STATUS_META: Record<string, { label: string; badgeClass: string }> = {
  NOT_STARTED: { label: 'Not Started', badgeClass: 'bg-bg-2 text-ink-3' },
  IN_PROGRESS: { label: 'In Progress', badgeClass: 'bg-blue-soft text-blue-text' },
  DONE:        { label: 'Done',        badgeClass: 'bg-green-soft text-green-text' },
  PARTIAL:     { label: 'Partial',     badgeClass: 'bg-gold-soft text-gold-2' },
  BLOCKED:     { label: 'Blocked',     badgeClass: 'bg-red-soft text-red-text' },
  SKIPPED:     { label: 'Skipped',     badgeClass: 'bg-bg-2 text-ink-4' },
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
  // Compatible as long as the prep unit shares the recipe yield unit's dimension —
  // convert the made qty into the yield unit before scaling (so "made 2 kg" of a
  // recipe that yields in g scales correctly instead of falsely flagging a mismatch).
  if (recipeBaseYieldQty > 0 && sameDimension(unit, recipeYieldUnit)) {
    const qtyInYieldUnit = convertQty(actualPrepQty, unit, recipeYieldUnit)
    return { scale: qtyInYieldUnit / recipeBaseYieldQty, unitMismatch: false }
  }
  return { scale: 1, unitMismatch: true }
}

/**
 * A single prep log this many batches or more is treated as an implausible
 * unit-magnitude typo (e.g. entering 25000 into a field whose unit is kg when one
 * batch is 25 kg → 1000 batches). Catering can legitimately make several batches at
 * once, so the ceiling is deliberately generous — it only catches the typo class.
 */
export const MAX_PLAUSIBLE_BATCHES_PER_LOG = 50

/**
 * Guards against unit-magnitude typos in "how much did you make?". Returns an error
 * message when the entered qty scales to an absurd number of batches, else null.
 * No-ops when we can't reason about it (no recipe yield, or cross-dimension units).
 */
export function validatePrepQty(
  actualPrepQty: number,
  prepUnit: string,
  recipeYieldUnit: string,
  recipeBaseYieldQty: number,
): string | null {
  if (!(actualPrepQty > 0) || !(recipeBaseYieldQty > 0)) return null
  const { scale, unitMismatch } = computeScale(actualPrepQty, prepUnit, recipeYieldUnit, recipeBaseYieldQty)
  if (unitMismatch) return null
  if (scale >= MAX_PLAUSIBLE_BATCHES_PER_LOG) {
    return `That's ~${Math.round(scale)} batches in one entry — looks like a unit mix-up (amount is in ${prepUnit}). Double-check how much was actually made.`
  }
  return null
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

/** Split on-list items into the design's groups.
 * Completed items (today's log DONE/PARTIAL) are pulled out of the actionable
 * groups into `done` — they show in the "Done today" section, not on the list. */
export function groupPrepItems<
  T extends { priority: PrepPriority; todayLog?: { status?: string | null } | null }
>(items: T[]): { critical: T[]; needed: T[]; later: T[]; done: T[] } {
  // Pin started (IN_PROGRESS) items to the top of each actionable group — mirrors
  // the desktop board's startedFirst sort so mobile and desktop agree. Stable:
  // non-started items keep their existing order.
  const startedFirst = (rows: T[]) =>
    [...rows].sort(
      (a, b) =>
        (a.todayLog?.status === 'IN_PROGRESS' ? 0 : 1) -
        (b.todayLog?.status === 'IN_PROGRESS' ? 0 : 1),
    )
  const isDone = (i: T) => i.todayLog?.status === 'DONE' || i.todayLog?.status === 'PARTIAL'
  const actionable = items.filter(i => !isDone(i))
  return {
    critical: startedFirst(actionable.filter(i => i.priority === '911')),
    needed:   startedFirst(actionable.filter(i => i.priority === 'NEEDED_TODAY')),
    later:    actionable.filter(i => i.priority === 'LATER'),
    done:     items.filter(isDone),
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
