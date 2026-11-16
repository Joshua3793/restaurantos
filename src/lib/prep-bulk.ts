// Smart Prep bulk actions — which items each button touches, and the snapshot
// that lets Undo put the list back exactly as it was (on/off the list, qty,
// note, cook, order). Pure: the page replays the result through its normal
// per-item handlers, so offline queueing and error reverts keep working.

import { defaultDraftQty, longLeadQty, mustStartToday, type PlanDayContext } from './prep-plan'
import { isToMake, parFlag, type SmartItem } from './prep-smart'

type DraftLog = { requiredQty?: number | string | null; note?: string | null; assignedTo?: string | null; listOrder?: number | null } | null | undefined
export type BulkItem = SmartItem & { todayLog?: DraftLog }

/** "Add all N to make" — the to-make rule exactly; a flagged par never qualifies. */
export function addAllToMakeIds(items: SmartItem[], ctx: PlanDayContext | null, nowMin: number): string[] {
  return items.filter(t => isToMake(t, ctx, nowMin)).map(t => t.id)
}

export interface DraftSnapshot {
  id: string
  isOnList: boolean
  requiredQty: number | null
  note: string | null
  assignedTo: string | null
  listOrder: number | null
}

const qtyOf = (l: DraftLog): number | null => {
  const n = Number(l?.requiredQty)
  return l?.requiredQty != null && Number.isFinite(n) ? n : null
}

export function snapshotDraft(items: BulkItem[]): DraftSnapshot[] {
  return items.map(t => ({
    id: t.id,
    isOnList: t.isOnList,
    requiredQty: qtyOf(t.todayLog),
    note: t.todayLog?.note ?? null,
    assignedTo: t.todayLog?.assignedTo ?? null,
    listOrder: t.todayLog?.listOrder ?? null,
  }))
}

export type DraftPatch = { requiredQty?: number; note?: string; assignedTo?: string | null; listOrder?: number }

/** What to replay to get from `current` back to `snap`: the list flags that
 *  differ, then the fields that differ on every item that ends up on the list. */
export function restorePlan(current: BulkItem[], snap: DraftSnapshot[]): {
  toggles: Array<{ id: string; isOnList: boolean }>
  edits: Array<{ id: string; patch: DraftPatch }>
} {
  const byId = new Map(current.map(t => [t.id, t]))
  const toggles: Array<{ id: string; isOnList: boolean }> = []
  const edits: Array<{ id: string; patch: DraftPatch }> = []
  for (const s of snap) {
    const now = byId.get(s.id)
    if (!now) continue
    if (now.isOnList !== s.isOnList) toggles.push({ id: s.id, isOnList: s.isOnList })
    if (!s.isOnList) continue
    const patch: DraftPatch = {}
    if (s.requiredQty != null && qtyOf(now.todayLog) !== s.requiredQty) patch.requiredQty = s.requiredQty
    if ((now.todayLog?.note ?? null) !== s.note) patch.note = s.note ?? ''
    if ((now.todayLog?.assignedTo ?? null) !== s.assignedTo) patch.assignedTo = s.assignedTo
    if (s.listOrder != null && (now.todayLog?.listOrder ?? null) !== s.listOrder) patch.listOrder = s.listOrder
    if (Object.keys(patch).length) edits.push({ id: s.id, patch })
  }
  return { toggles, edits }
}

/** "Reset N quantities to suggested" — only rows that differ; a job already
 *  cooking is never touched. A long-lead row resets to the most that keeps. */
export function resetTargets(draft: BulkItem[], ctx: PlanDayContext | null, nowMin: number): Array<{ id: string; from: number; to: number }> {
  const out: Array<{ id: string; from: number; to: number }> = []
  for (const t of draft) {
    // A wrong par's "suggestion" (Kimchi: 376 batches) is never written.
    if (!t.isOnList || t.pipeline || parFlag(t) !== null) continue
    const to = mustStartToday(t, ctx, nowMin) ? longLeadQty(t) : defaultDraftQty(t)
    if (!(to > 0)) continue
    const set = qtyOf(t.todayLog)
    const from = set != null && set > 0 ? set : to
    if (Math.abs(from - to) > 0.01) out.push({ id: t.id, from, to })
  }
  return out
}

/** "Empty the list…" — everything on the list except jobs already cooking. */
export function emptyListIds(draft: SmartItem[]): string[] {
  return draft.filter(t => t.isOnList && !t.pipeline).map(t => t.id)
}
