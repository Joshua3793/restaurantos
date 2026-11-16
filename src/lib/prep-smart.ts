// Smart Prep — the planner's own decisions, in one pure place.
//
// Spec: docs/superpowers/specs/2026-11-16-smart-prep-redesign-design.md
//  · one "to make" rule (tab badge, header, filter chip and "Add all" all read it)
//  · par flags: a par that cannot be right is flagged, never acted on
//  · the whole list by category, in a fixed row order
// Components render what this returns; nothing here touches React or the network.

import {
  batchYield, suggestedDraftQty, mustStartToday, effectiveUrgency, slotInputs, deadlineLabel,
  type BatchFields, type TimedFields, type PlanDayContext, type PlanSlot,
} from './prep-plan'
import { fmtDur } from './prep-steps'
import { URGENCY_ORDER } from './prep-utils'
import { UNIT_FACTORS, canonicalUom } from './uom'

export { fmtAmount, fmtAmountOf, stepOnGrid, onGrid } from './prep-amount'

/** More batches than this for one par is a typo, not a plan (Kimchi: 377). */
export const PAR_MAX_BATCHES = 20
/** A weight/volume par under this many g / ml is a typo (Hollandaise: 4 g). */
export const PAR_MIN_BASE = 10

export type ParFlag = 'WRONG' | 'NONE' | null

export type SmartItem = BatchFields & TimedFields & {
  id: string
  name: string
  category: string
  isOnList: boolean
  prepEnabled?: boolean
}

export function parFlag(t: BatchFields): ParFlag {
  const par = Number(t.parLevel) || 0
  if (par <= 0) return Number(t.targetToday) > 0 ? null : 'NONE'
  const b = batchYield(t)
  if (b != null && b > 0 && par / b > PAR_MAX_BATCHES) return 'WRONG'
  const f = UNIT_FACTORS[canonicalUom(t.unit)]
  if (f && f.dim !== 'count' && par * f.toBase < PAR_MIN_BASE) return 'WRONG'
  return null
}

export function isToMake(t: SmartItem, ctx: PlanDayContext | null, nowMin: number): boolean {
  if (t.prepEnabled === false || t.isOnList || t.pipeline) return false
  if (parFlag(t) !== null) return false
  return suggestedDraftQty(t) > 0 || mustStartToday(t, ctx, nowMin)
}

export function toMakeCount(items: SmartItem[], ctx: PlanDayContext | null, nowMin: number): number {
  return items.reduce((n, t) => n + (isToMake(t, ctx, nowMin) ? 1 : 0), 0)
}

export type RowKind = 'MAKE' | 'FLAG' | 'LISTED' | 'COOKING' | 'ATPAR'

export function rowKind(t: SmartItem, ctx: PlanDayContext | null, nowMin: number): RowKind {
  if (t.pipeline) return 'COOKING'
  if (t.isOnList) return 'LISTED'
  if (parFlag(t) !== null) return 'FLAG'
  if (isToMake(t, ctx, nowMin)) return 'MAKE'
  return 'ATPAR'
}

export type PrepFilter = 'ALL' | 'MAKE' | 'FIX' | 'NOPAR'

export function matchesFilter(t: SmartItem, f: PrepFilter, ctx: PlanDayContext | null, nowMin: number): boolean {
  switch (f) {
    case 'ALL': return true
    case 'MAKE': return isToMake(t, ctx, nowMin)
    case 'FIX': return parFlag(t) === 'WRONG'
    case 'NOPAR': return parFlag(t) === 'NONE'
  }
}

export function filterCounts(items: SmartItem[], ctx: PlanDayContext | null, nowMin: number): Record<PrepFilter, number> {
  const out: Record<PrepFilter, number> = { ALL: 0, MAKE: 0, FIX: 0, NOPAR: 0 }
  for (const t of items) {
    out.ALL++
    if (isToMake(t, ctx, nowMin)) out.MAKE++
    const f = parFlag(t)
    if (f === 'WRONG') out.FIX++
    else if (f === 'NONE') out.NOPAR++
  }
  return out
}

export interface PrepSection<T> {
  key: string
  label: string
  rows: T[]
  toMake: number
  listed: number
  cooking: number
  flagged: number
}

const KIND_ORDER: RowKind[] = ['MAKE', 'FLAG', 'LISTED', 'COOKING', 'ATPAR']

/** The whole prep list, one section per category (alphabetical, as cooks learn
 *  where things are). Inside a category: what needs making first (by step, then
 *  the chef's order), then par flags, on the list, cooking, and at par last. */
export function prepListSections<T extends SmartItem>(
  items: T[],
  opts: { ctx: PlanDayContext | null; nowMin: number; ord?: (t: T) => number },
): PrepSection<T>[] {
  const { ctx, nowMin } = opts
  const ord = opts.ord ?? (() => 0)
  const cats = [...new Set(items.map(t => t.category))].sort((a, b) => a.localeCompare(b))
  return cats.map(cat => {
    const rows = items
      .filter(t => t.category === cat)
      .map(t => ({ t, k: rowKind(t, ctx, nowMin) }))
      .sort((a, b) => {
        const ka = KIND_ORDER.indexOf(a.k), kb = KIND_ORDER.indexOf(b.k)
        if (ka !== kb) return ka - kb
        if (a.k === 'MAKE') {
          const ua = URGENCY_ORDER.indexOf(effectiveUrgency(a.t)), ub = URGENCY_ORDER.indexOf(effectiveUrgency(b.t))
          if (ua !== ub) return ua - ub
        }
        const oa = ord(a.t), ob = ord(b.t)
        if (oa !== ob) return oa - ob
        return a.t.name.localeCompare(b.t.name)
      })
    const count = (k: RowKind) => rows.filter(r => r.k === k).length
    return {
      key: cat, label: cat, rows: rows.map(r => r.t),
      toMake: count('MAKE'), listed: count('LISTED'), cooking: count('COOKING'), flagged: count('FLAG'),
    }
  })
}

// ─── who's on today: hands vs the list ──────────────────────────────────────

export interface CrewCapacity { hands: number; needs: number; fits: boolean }

/** Hands until close (cooks ticked × minutes left) against the hands-on minutes
 *  the list still needs. Null — say nothing — without a crew or a service day. */
/** Planning tomorrow after close: assume tomorrow's prep starts this long
 *  before doors (there is no stored shift start). */
export const NEXT_DAY_PREP_LEAD = 120

/** When the crew's hands start: now — or, once the day has rolled after close,
 *  tomorrow's prep start, so the night is never counted as hands. */
export function crewStart(ctx: PlanDayContext): number {
  return ctx.roll ? Math.max(ctx.shiftStart, ctx.doorsOpen - NEXT_DAY_PREP_LEAD) : ctx.shiftStart
}

export function crewCapacity(draft: SmartItem[], crewSize: number, ctx: PlanDayContext | null): CrewCapacity | null {
  if (!ctx || crewSize < 1) return null
  const hands = crewSize * Math.max(0, ctx.close - crewStart(ctx))
  const needs = draft.reduce((n, t) => n + slotInputs(t, ctx).active, 0)
  return { hands, needs, fits: needs <= hands }
}

const URG_LOCAL = ['PASS', 'MID', 'CLOSE', 'TMRW']

/** One shared pool of the ticked cooks (stations ignored), deadline first.
 *  Jobs already cooking and jobs whose deadline has passed still take a cook
 *  but are never called "won't fit". No crew → empty: no warnings at all. */
export function crewSchedule<T extends SmartItem>(
  draft: T[], crewSize: number, ctx: PlanDayContext | null, nowMin: number, ord: (t: T) => number = () => 0,
): Map<string, PlanSlot> {
  const map = new Map<string, PlanSlot>()
  if (!ctx || crewSize < 1) return map
  const start0 = crewStart(ctx)
  const cursors = Array<number>(crewSize).fill(start0)
  draft
    .map(t => ({ t, si: slotInputs(t, ctx) }))
    .sort((a, b) =>
      a.si.deadline - b.si.deadline ||
      URG_LOCAL.indexOf(effectiveUrgency(a.t)) - URG_LOCAL.indexOf(effectiveUrgency(b.t)) ||
      a.si.earliest - b.si.earliest ||
      ord(a.t) - ord(b.t))
    .forEach(({ t, si }) => {
      let i = 0
      cursors.forEach((c, j) => { if (c < cursors[i]) i = j })
      const start = Math.max(cursors[i], si.earliest, start0)
      cursors[i] = start + si.active
      const end = start + si.active + si.passive
      const exempt = !!t.pipeline || si.deadline <= nowMin
      const over = exempt ? 0 : Math.max(0, end - si.deadline)
      map.set(t.id, { start, end, deadline: si.deadline, fits: over === 0, over })
    })
  return map
}

/** "won't be ready by 15:00 — 1 h 20 min over with 2 cooks" */
export function wontFitText(slot: PlanSlot, crewSize: number, fmtClock: (min: number) => string): string {
  return `won't be ready by ${deadlineLabel(slot.deadline, -Infinity, fmtClock)} — ${fmtDur(slot.over)} over with ${crewSize} ${crewSize === 1 ? 'cook' : 'cooks'}`
}

// ─── your list: by cook, and what changes on posting ────────────────────────

type WithLog = { todayLog?: { assignedTo?: string | null; postedAt?: string | null; status?: string } | null }

/** Today's crew first (in the order ticked), then other assigned cooks, then Open. */
export function cookGroups<T extends SmartItem & WithLog>(
  draft: T[], cooks: Array<{ id: string; name: string }>, crewIds: string[],
): Array<{ key: string; label: string; rows: T[] }> {
  const crew = new Set(crewIds)
  const others = cooks.filter(c => !crew.has(c.id)).map(c => c.id)
  const order = [...crewIds, ...others]
  const name = new Map(cooks.map(c => [c.id, c.name]))
  const groups = order.map(id => ({ key: id, label: name.get(id) ?? 'Unknown cook', rows: draft.filter(t => t.todayLog?.assignedTo === id) }))
  const known = new Set(order)
  const stray = draft.filter(t => t.todayLog?.assignedTo && !known.has(t.todayLog.assignedTo))
  const open = draft.filter(t => !t.todayLog?.assignedTo)
  return [...groups, { key: '_stray', label: 'Other', rows: stray }, { key: '_open', label: 'Open', rows: open }]
    .filter(g => g.rows.length > 0)
}

export interface PlanChanges<T> { added: T[]; removed: T[]; unchanged: number; cooking: T[] }

const CLOSED = new Set(['DONE', 'PARTIAL', 'SKIPPED'])

/** What posting changes for the cooks: added since the last post, taken off since
 *  (posted, still open, no longer on the list), unchanged, and jobs cooking. */
export function planChanges<T extends SmartItem & WithLog>(all: T[]): PlanChanges<T> {
  const added: T[] = [], removed: T[] = [], cooking: T[] = []
  let unchanged = 0
  for (const t of all) {
    const posted = !!t.todayLog?.postedAt
    if (t.isOnList && t.pipeline) cooking.push(t)
    else if (t.isOnList && !posted) added.push(t)
    else if (t.isOnList) unchanged++
    else if (posted && !CLOSED.has(t.todayLog?.status ?? '')) removed.push(t)
  }
  return { added, removed, unchanged, cooking }
}
