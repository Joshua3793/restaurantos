// The numbers behind the Log yield sheet — ONE value (the unit amount that is
// stored as PrepLog.actualPrepQty) shown two ways. Batches are a view on top of
// the planner's batch math (prep-plan.ts: batchYield / batchCount /
// batchesToQty); nothing here is stored in batches.
//
// Design: docs/superpowers/specs/2026-09-13-log-yield-sheet-design.md
import { batchesToQty, suggestedBatches, type BatchFields } from './prep-plan'
import { validatePrepQty } from './prep-utils'

/** The sheet's batch scale: 0 → 10 in quarter steps (the planner's stepper keeps 0.5). */
export const BATCH_STEP = 0.25
export const BATCH_MAX = 10

export type YieldStatus = 'DONE' | 'PARTIAL'

export interface YieldItem extends BatchFields {
  /** The plan's suggestion in the item's unit (the API's `suggestedQty`). */
  suggestedQty: number
  /** The item's live log, when it has one — a completed one prefills its amount. */
  todayLog?: { status: string; actualPrepQty: number | null; requiredQty?: number | null } | null
  linkedRecipe?: { baseYieldQty: number; yieldUnit: string } | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** "×1", "×1.25", "×1.5" — and an exact "×1.13" for a typed, off-grid amount. */
export function fmtBatches(n: number): string {
  const r = round2(n)
  return `×${Number.isInteger(r) ? r : r}`
}

export function clampBatches(n: number): number {
  return Math.min(BATCH_MAX, Math.max(0, n))
}

/** Nearest quarter, clamped to the scale. */
export function snapBatches(n: number): number {
  return clampBatches(Math.round(n / BATCH_STEP) * BATCH_STEP)
}

/**
 * One press of − / +. An off-grid (typed) value snaps to its nearest quarter
 * first, so the press lands on a neighbouring grid point rather than staying
 * off-grid forever. A typed overflow above the scale is pinned at 10: either
 * button brings the value back onto the scale.
 */
export function stepBatches(n: number, dir: 1 | -1): number {
  if (n > BATCH_MAX) return BATCH_MAX
  return snapBatches(snapBatches(n) + dir * BATCH_STEP)
}

/**
 * What the plan asked for, in the item's unit: the quantity the chef posted on
 * the live log when there is one, else the half-batch-ceiled batch suggestion
 * (identical to the planner's draft seed), else the plain suggestion.
 */
export function plannedQty(item: YieldItem): number {
  const rq = item.todayLog?.requiredQty
  if (rq != null && rq > 0) return round2(rq)
  const nb = suggestedBatches(item)
  if (nb != null) return nb > 0 ? batchesToQty(item, nb) : 0
  return item.suggestedQty > 0 ? item.suggestedQty : 0
}

const COMPLETE = new Set(['DONE', 'PARTIAL'])

/**
 * The amount the sheet opens with:
 *   1. the amount already logged, when reopening a completed job;
 *   2. the cook-along yield the cook set in the drawer's upscale slider;
 *   3. the plan (see plannedQty);
 *   4. zero — nothing known, the cook types it.
 */
export function yieldPrefill(item: YieldItem, cookAlongQty: number | null | undefined): number {
  const log = item.todayLog
  if (log && COMPLETE.has(log.status) && log.actualPrepQty != null && log.actualPrepQty > 0) {
    return round2(log.actualPrepQty)
  }
  if (cookAlongQty != null && cookAlongQty > 0) return round2(cookAlongQty)
  return plannedQty(item)
}

/** The prep page's rule, in one place: at or above plan is Done, below it Partial. */
export function yieldStatus(qty: number, planned: number): YieldStatus {
  return qty >= planned ? 'DONE' : 'PARTIAL'
}

/**
 * The server's unit-mix-up guard (validatePrepQty: ≥ 50 batches in one entry),
 * run client-side so the sheet stops the request instead of showing a failed one.
 */
export function yieldWarning(qty: number, item: YieldItem): string | null {
  const r = item.linkedRecipe
  if (!r || !(qty > 0)) return null
  return validatePrepQty(qty, item.unit, r.yieldUnit, Number(r.baseYieldQty))
}
