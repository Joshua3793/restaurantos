// The cook's start page (/today for STAFF) — pure rules, no React, no DB.
//
// A cook lands on the app wanting one answer: what do I cook next? So the page
// is the posted To Do, cut to the cook:
//   - a login LINKED to a crew member (Cook.userId, set on the tip roster) sees
//     only the jobs the chef gave them, plus urgent jobs nobody has taken;
//   - an unlinked login (the shared kitchen iPad) sees every posted job with the
//     cook's name on it.
// Order and step come from the To Do itself (runSheetGroups), so the start page
// can never disagree with the run sheet. No money is shown anywhere.

import { runSheetGroups, draftQty, batchLabel, type LadderItem, type BatchFields } from '@/lib/prep-plan'
import { fmtQty } from '@/lib/prep-runsheet'
import type { PrepUrgency } from '@/lib/prep-utils'

export interface CookStartItem extends LadderItem {
  id: string
  unit: string
  assignedCook: { id: string; name: string } | null
  todayLog?: {
    status?: string
    postedAt?: string | null
    note?: string | null
    requiredQty?: number | null
    listOrder?: number | null
    stageIndex?: number | null
    stageEnteredAt?: string | null
  } | null
}

export interface CookJob<T> {
  item: T
  urg: PrepUrgency
  stepLabel: string
}

export interface CookBoard<T> {
  /** Jobs started and not finished (hands-on or resting). */
  doing: T[]
  /** Not-started jobs, in the To Do's own order (step, then the chef's order). */
  jobs: CookJob<T>[]
  /** Urgent jobs nobody has taken — only for a linked cook (the shared view already lists them). */
  grabs: CookJob<T>[]
  done: number
  total: number
}

const DONE = new Set(['DONE', 'PARTIAL'])
/** Steps worth offering to a cook who is not on them: needed for, or during, service. */
const GRAB_STEPS = new Set<PrepUrgency>(['PASS', 'MID'])
/** At most this many up-for-grabs rows — the page is about the cook's own jobs. */
const MAX_GRABS = 3

const posted = <T extends CookStartItem>(t: T) => !!t.todayLog?.postedAt
const isDone = <T extends CookStartItem>(t: T) => DONE.has(t.todayLog?.status ?? '')
const isDoing = <T extends CookStartItem>(t: T) => t.todayLog?.status === 'IN_PROGRESS'

function ordered<T extends CookStartItem>(rows: T[]): CookJob<T>[] {
  return runSheetGroups(rows).flatMap(g => g.rows.map(item => ({ item, urg: g.urg as PrepUrgency, stepLabel: g.label })))
}

/** Split the posted To Do into what this cook (or, with no cook, the kitchen) sees. */
export function cookBoard<T extends CookStartItem>(items: T[], cookId: string | null): CookBoard<T> {
  const onList = items.filter(posted)
  const scope = cookId ? onList.filter(t => t.assignedCook?.id === cookId) : onList
  const open = scope.filter(t => !isDone(t) && !isDoing(t))
  const grabs = cookId
    ? ordered(onList.filter(t => !t.assignedCook && !isDone(t) && !isDoing(t)))
        .filter(j => GRAB_STEPS.has(j.urg))
        .slice(0, MAX_GRABS)
    : []
  return {
    doing: scope.filter(isDoing),
    jobs: ordered(open),
    grabs,
    done: scope.filter(isDone).length,
    total: scope.length,
  }
}

/**
 * "Make 2 L · 1 batch" — the same quantity and batch label the To Do row shows
 * (RunRow: the chef's posted qty, else the live suggestion), so the two screens
 * never disagree.
 */
export function makeText(t: CookStartItem & BatchFields): string | null {
  const qty = draftQty(t) || (t.targetToday ?? t.parLevel)
  if (!(qty > 0)) return null
  const batch = batchLabel(t, qty)
  return `Make ${fmtQty(qty, t.unit)}${batch ? ` · ${batch}` : ''}`
}
