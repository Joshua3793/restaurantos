// Smart Prep v2 — pure planner math. Priority is ALWAYS computed from stock
// (computePriority), never trusted from a snapshot: the stale-pill bug was the
// client keeping a server-computed `priority` after a completion changed onHand.
import { computePriority, computeSuggestedQty, type PrepPriority } from './prep-utils'

export interface PlanFields {
  onHand: number
  parLevel: number
  minThreshold: number
  targetToday: number | null
  manualPriorityOverride: string | null
  unit: string
}

export const PLAN_PRIORITY_ORDER: PrepPriority[] = ['911', 'NEEDED_TODAY', 'LATER']

export const PLAN_PRIO_META: Record<PrepPriority, {
  label: string; sub: string
  dotClass: string; softClass: string; textClass: string; barClass: string
}> = {
  '911':          { label: 'Critical', sub: 'stock out, or under today’s target', dotClass: 'bg-red',   softClass: 'bg-red-soft',   textClass: 'text-red-text',   barClass: 'bg-red' },
  'NEEDED_TODAY': { label: 'Needed',   sub: 'below par level',                    dotClass: 'bg-gold',  softClass: 'bg-gold-soft',  textClass: 'text-gold-2',     barClass: 'bg-gold' },
  'LATER':        { label: 'Later',    sub: 'at or above par — no make needed',   dotClass: 'bg-green', softClass: 'bg-green-soft', textClass: 'text-green-text', barClass: 'bg-green' },
}

export const autoPriority = (t: PlanFields): PrepPriority =>
  computePriority(t.onHand, t.parLevel, t.minThreshold, t.targetToday, null)

export const effectivePriority = (t: PlanFields): PrepPriority =>
  computePriority(t.onHand, t.parLevel, t.minThreshold, t.targetToday, t.manualPriorityOverride)

/** Sensible stepper increment per unit. */
export function prepStep(unit: string): number {
  const u = (unit || '').toLowerCase()
  if (u === 'kg' || u === 'l') return 0.5
  if (u === 'g' || u === 'ml') return 25
  return 1 // each, ea, batch, loaves, bunch, portion…
}

/** Snap a quantity to the unit's step (float-cleaned). */
export function roundPrepQty(v: number, unit: string): number {
  const step = prepStep(unit)
  return +(Math.round(v / step) * step).toFixed(2)
}

/** Rounded make-suggestion: 0 at/above par, otherwise ≥ one step. */
export function suggestedDraftQty(t: PlanFields): number {
  const raw = computeSuggestedQty(t.onHand, t.parLevel, t.targetToday)
  if (raw <= 0) return 0
  return Math.max(prepStep(t.unit), roundPrepQty(raw, t.unit))
}

const fmtQ = (q: number, u: string) => `${q % 1 === 0 ? q : +q.toFixed(2)} ${u}`

/** One-line reason a suggestion carries its priority. */
export function whyLabel(t: PlanFields): string {
  if (t.manualPriorityOverride) return 'chef override'
  if (t.onHand <= 0 && t.parLevel > 0) return 'stock out'
  if (t.targetToday != null && t.onHand < t.targetToday) return `under today's target ${fmtQ(t.targetToday, t.unit)}`
  if (t.onHand < t.parLevel) return `below par by ${fmtQ(+(t.parLevel - t.onHand).toFixed(2), t.unit)}`
  return 'at par'
}

const COMPLETE = new Set(['DONE', 'PARTIAL'])

/**
 * Optimistically re-derive an item after a status change: move onHand by the
 * yield delta, clear the override on completion (mirrors the server rule in
 * /api/prep/logs/[id]), and recompute priority + suggestedQty. This is the fix
 * for "done items drop back to Smart Prep still wearing a Critical pill".
 */
export function applyStatusToItem<T extends PlanFields & {
  priority: PrepPriority
  suggestedQty: number
  todayLog?: { status: string; actualPrepQty: number | null } | null
}>(item: T, newStatus: string, actualQty?: number): T {
  const completing = COMPLETE.has(newStatus)
  const prevQty = item.todayLog && COMPLETE.has(item.todayLog.status)
    ? Number(item.todayLog.actualPrepQty ?? 0)
    : 0
  let onHand = item.onHand
  if (completing) onHand += (actualQty ?? prevQty) - prevQty
  else onHand -= prevQty
  const manualPriorityOverride = completing ? null : item.manualPriorityOverride
  return {
    ...item,
    onHand,
    manualPriorityOverride,
    priority: computePriority(onHand, item.parLevel, item.minThreshold, item.targetToday, manualPriorityOverride),
    suggestedQty: computeSuggestedQty(onHand, item.parLevel, item.targetToday),
  }
}

/** Planned qty for a draft row: chef-set requiredQty wins, else rounded suggestion. */
export function draftQty(t: PlanFields & { todayLog?: { requiredQty?: number | string | null } | null }): number {
  const rq = t.todayLog?.requiredQty
  if (rq != null && Number(rq) > 0) return Number(rq)
  return suggestedDraftQty(t)
}
