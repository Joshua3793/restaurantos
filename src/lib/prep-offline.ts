import type { PrepItemRich, PrepPostInfo } from '@/components/prep/types'

const CACHE_KEY = 'prep_items_v1'
const QUEUE_KEY = 'prep_queue_v1'
const PLAN_KEY  = 'prep_plan_v1'

// ── Types ──────────────────────────────────────────────────────────────────────

/** The planner draft fields a chef can edit on a PrepLog. */
export interface DraftPatch {
  requiredQty?: number
  note?:        string
  assignedTo?:  string | null
  listOrder?:   number
}

export interface OfflineMutation {
  id:         string
  ts:         number
  type:       'isOnList_toggle' | 'status' | 'priority' | 'draft_edit' | 'post' | 'remove_item'
  /** '' for `post`, which is RC-scoped rather than item-scoped. */
  itemId:     string
  isOnList?:  boolean         // for isOnList_toggle
  logId?:     string | null   // null or '_opt_<itemId>' = not yet on server
  status?:    string
  actualQty?: number
  priority?:  string
  revenueCenterId?: string | null   // active RC captured at enqueue time
  patch?:     DraftPatch      // for draft_edit
  restore?:   boolean         // for remove_item — true puts the item back
}

// ── Cache ──────────────────────────────────────────────────────────────────────

/**
 * Persist the item list.
 *
 * `ts` is the last time this data came from the SERVER, not the last time it was
 * written. Optimistic re-saves (which happen on every draft edit, so the chef's
 * work survives a reload in a dead zone) omit `fetchedAt` and inherit the stored
 * ts — otherwise "data from 40m ago" would reset to "just now" every keystroke
 * and the age stamp would lie.
 */
export function savePrepCache(items: PrepItemRich[], opts?: { fetchedAt?: number }): void {
  try {
    const ts = opts?.fetchedAt ?? loadPrepCache()?.ts ?? Date.now()
    localStorage.setItem(CACHE_KEY, JSON.stringify({ items, ts }))
  } catch { /* quota exceeded or private browsing */ }
}

export function loadPrepCache(): { items: PrepItemRich[]; ts: number } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed?.items)) return null
    return parsed as { items: PrepItemRich[]; ts: number }
  } catch { return null }
}

/** The posted-list header, so PostedBand and the dirty pill render offline. */
export function savePlanCache(post: PrepPostInfo | null): void {
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify({ post, ts: Date.now() }))
  } catch { /* graceful degradation */ }
}

export function loadPlanCache(): { post: PrepPostInfo | null; ts: number } | null {
  try {
    const raw = localStorage.getItem(PLAN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!('post' in parsed)) return null
    return parsed as { post: PrepPostInfo | null; ts: number }
  } catch { return null }
}

// ── Queue ──────────────────────────────────────────────────────────────────────

export function enqueueMutation(m: Omit<OfflineMutation, 'id' | 'ts'>): void {
  try {
    const queue = loadQueue()
    queue.push({
      ...m,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ts: Date.now(),
    })
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch { /* graceful degradation */ }
}

export function loadQueue(): OfflineMutation[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    return raw ? (JSON.parse(raw) as OfflineMutation[]) : []
  } catch { return [] }
}

export function clearQueue(): void {
  try { localStorage.removeItem(QUEUE_KEY) } catch { /* ok */ }
}

// ── Deduplication ──────────────────────────────────────────────────────────────
//
// Three rules, one pass, order preserved:
//
//  · isOnList_toggle / status / priority — keep the LAST per item. The final
//    value is the only one that matters.
//  · post — keep the LAST per revenue center.
//  · draft_edit — MERGE per item, field by field, in enqueue order. Keeping only
//    the last mutation would drop a qty edit as soon as a note edit followed it.
//  · remove_item — keep the LAST per item, so a remove immediately undone
//    collapses to the undo.
//
// draft_edit merging is bounded by `post` boundaries: an edit made before a post
// belongs to that post, an edit made after it is an unposted change. Merging
// across a post would fold a later edit into an earlier post.
//
// Preserving the relative order of survivors is the entire ordering guarantee the
// flush needs — a post enqueued after its edits flushes after them, so the server
// builds the post from a draft that is already correct.

export function deduplicateQueue(queue: OfflineMutation[]): OfflineMutation[] {
  // Which post-delimited segment each mutation sits in.
  let segment = 0
  const segmentOf = new Map<OfflineMutation, number>()
  for (const m of queue) {
    segmentOf.set(m, segment)
    if (m.type === 'post') segment++
  }

  const keyOf = (m: OfflineMutation): string =>
    m.type === 'post' ? `post|${m.revenueCenterId ?? ''}`
    : m.type === 'draft_edit' ? `draft_edit|${segmentOf.get(m)}|${m.itemId}`
    : `${m.type}|${m.itemId}`

  // First pass — the survivor for each key, and (for draft_edit) the merged patch.
  const winner = new Map<string, OfflineMutation>()
  const merged = new Map<string, DraftPatch>()
  const anchor = new Map<string, OfflineMutation>()
  for (const m of queue) {
    const k = keyOf(m)
    if (m.type === 'draft_edit') {
      // The merged entry takes the position of the segment's FIRST edit for this
      // item, so it lands before any post that follows it.
      if (!anchor.has(k)) anchor.set(k, m)
      merged.set(k, { ...(merged.get(k) ?? {}), ...(m.patch ?? {}) })
    }
    winner.set(k, m)
  }

  // Second pass — emit each key once, in the order its representative appears.
  const emitted = new Set<string>()
  const result: OfflineMutation[] = []
  for (const m of queue) {
    const k = keyOf(m)
    if (emitted.has(k)) continue
    if (m.type === 'draft_edit') {
      if (anchor.get(k) !== m) continue
      const last = winner.get(k) as OfflineMutation
      emitted.add(k)
      // Fields from the LAST edit (freshest logId / RC), patch from the merge.
      result.push({ ...last, id: m.id, ts: m.ts, patch: merged.get(k) })
      continue
    }
    if (winner.get(k) !== m) continue
    emitted.add(k)
    result.push(m)
  }

  return result
}

// ── Flush ──────────────────────────────────────────────────────────────────────

/**
 * Resolve the server-side PrepLog id for a mutation, creating the log when the
 * client only ever had an optimistic one.
 *
 * The `_opt_` check matters: `logId` is documented as "null or '_opt_<itemId>' =
 * not yet on server", but an `_opt_` id used to fall through to
 * `PUT /api/prep/logs/_opt_abc`, which 404s and silently loses the mutation.
 *
 * `POST /api/prep/logs` is an upsert on (prepItem, day) and takes the draft
 * fields directly, so a create can carry the patch in the same request —
 * `applied` says whether it did, so the caller can skip the follow-up PUT.
 */
async function ensureLogId(
  m: OfflineMutation,
  extra: DraftPatch = {},
): Promise<{ id: string | null; applied: boolean }> {
  if (m.logId && !m.logId.startsWith('_opt_')) return { id: m.logId, applied: false }
  const res = await fetch('/api/prep/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prepItemId: m.itemId, revenueCenterId: m.revenueCenterId ?? null, ...extra }),
  })
  if (!res.ok) return { id: null, applied: false }   // e.g. RC-less Shared item
  const log = await res.json()
  return { id: log.id as string, applied: Object.keys(extra).length > 0 }
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export async function flushQueue(): Promise<{ synced: number; failed: number }> {
  const queue = loadQueue()
  if (queue.length === 0) return { synced: 0, failed: 0 }

  const deduped = deduplicateQueue(queue)
  let synced = 0
  let failed = 0

  for (const m of deduped) {
    try {
      if (m.type === 'isOnList_toggle') {
        await fetch(`/api/prep/items/${m.itemId}`, json('PUT', { isOnList: m.isOnList }))
        synced++

      } else if (m.type === 'priority') {
        await fetch(`/api/prep/items/${m.itemId}`, json('PUT', { manualPriorityOverride: m.priority }))
        synced++

      } else if (m.type === 'status') {
        const { id: logId } = await ensureLogId(m)
        if (!logId) { failed++; continue }
        // PUT triggers the inventory transaction for DONE/PARTIAL.
        await fetch(`/api/prep/logs/${logId}`, json('PUT', {
          status: m.status,
          ...(m.actualQty !== undefined ? { actualPrepQty: m.actualQty } : {}),
        }))
        synced++

      } else if (m.type === 'draft_edit') {
        const patch = m.patch ?? {}
        const { id: logId, applied } = await ensureLogId(m, patch)
        if (!logId) { failed++; continue }
        if (!applied) await fetch(`/api/prep/logs/${logId}`, json('PUT', patch))
        synced++

      } else if (m.type === 'remove_item') {
        await fetch('/api/prep/plan/remove-item', json('POST', {
          revenueCenterId: m.revenueCenterId ?? null,
          prepItemId: m.itemId,
          restore: m.restore === true,
        }))
        synced++

      } else if (m.type === 'post') {
        await fetch('/api/prep/plan/post', json('POST', { revenueCenterId: m.revenueCenterId ?? null }))
        synced++
      }
    } catch {
      failed++
    }
  }

  clearQueue()
  return { synced, failed }
}
