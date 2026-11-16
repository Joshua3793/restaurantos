// Smart Prep — the planner's own decisions, in one pure place.
//
// Spec: docs/superpowers/specs/2026-11-16-smart-prep-redesign-design.md
//  · one "to make" rule (tab badge, header, filter chip and "Add all" all read it)
//  · par flags: a par that cannot be right is flagged, never acted on
//  · the whole list by category, in a fixed row order
// Components render what this returns; nothing here touches React or the network.

import {
  batchYield, suggestedDraftQty, mustStartToday, effectiveUrgency,
  type BatchFields, type TimedFields, type PlanDayContext,
} from './prep-plan'
import { URGENCY_ORDER } from './prep-utils'
import { UNIT_FACTORS, canonicalUom } from './uom'

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
