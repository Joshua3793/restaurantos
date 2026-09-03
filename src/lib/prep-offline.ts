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
  //
  // `segmentOf` is keyed by OBJECT IDENTITY, which is safe for the only caller
  // that matters — `loadQueue()` hands back freshly `JSON.parse`d objects, so no
  // two entries are the same reference. `deduplicateQueue` is exported though,
  // and a caller passing an array that contains the SAME object twice would see
  // both occurrences share one segment (and one anchor) rather than being
  // treated as two enqueues. Pass fresh objects.
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
      //
      // This REORDERS an edit past a removal that sat between two of its parts:
      // `[edit(A), remove_item(A), edit(A)]` emits `[draft_edit(A, merged),
      // remove_item(A)]`, so the second edit's fields now reach the server
      // BEFORE the removal rather than after. Benign, and deliberately so —
      // server-side the draft fields (`requiredQty`/`note`/`assignedTo`/
      // `listOrder`) and the removal's fields (`postedAt`/`isOnList`) are
      // orthogonal columns that never read each other, so both orders write the
      // same row state, and either way the post is left dirty. Not obvious from
      // the code, hence this note.
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
 * What the server (or the network) said about one request.
 *
 * THE RETRY RULE — the whole point of this queue is that a chef's work in a
 * walk-in dead zone survives, so a mutation is only ever dropped when replaying
 * it could not possibly change the outcome:
 *
 *  · `ok`        — 2xx. Done, drop it.
 *  · `permanent` — 4xx. A DECISION, not a hiccup: `requireSession('LEAD')`
 *                  returning 403 for a cook, `remove-item` returning 404 for an
 *                  item owned by another revenue center, `plan/post` returning
 *                  400 for an empty draft. The same request will get the same
 *                  answer forever, so keeping it would build an infinite retry
 *                  loop that also blocks everything queued behind it. Dropped,
 *                  and reported through the returned `failed` count — which the
 *                  page surfaces as an error banner.
 *  · `transient` — a THROWN fetch (offline / DNS / connection reset) or a 5xx.
 *                  The server never decided, so this may well succeed later.
 *                  Kept for the next flush. This is the dead-zone case.
 */
type Outcome = 'ok' | 'permanent' | 'transient'

async function send(url: string, init: RequestInit): Promise<{ outcome: Outcome; res: Response | null }> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    return { outcome: 'transient', res: null }   // never reached the server
  }
  if (res.ok) return { outcome: 'ok', res }
  return { outcome: res.status >= 500 ? 'transient' : 'permanent', res }
}

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
 *
 * A null `id` always comes with a non-`ok` outcome, so the caller can settle the
 * mutation on it directly.
 */
async function ensureLogId(
  m: OfflineMutation,
  extra: DraftPatch = {},
): Promise<{ id: string | null; applied: boolean; outcome: Outcome }> {
  if (m.logId && !m.logId.startsWith('_opt_')) return { id: m.logId, applied: false, outcome: 'ok' }
  const { outcome, res } = await send('/api/prep/logs', json('POST', {
    prepItemId: m.itemId, revenueCenterId: m.revenueCenterId ?? null, ...extra,
  }))
  if (outcome !== 'ok' || !res) return { id: null, applied: false, outcome }   // e.g. RC-less Shared item
  const log = await res.json().catch(() => null)
  // A 2xx with no id is a contract violation, not a network problem — retrying
  // it would loop, so treat it as permanent.
  if (!log?.id) return { id: null, applied: false, outcome: 'permanent' }
  return { id: log.id as string, applied: Object.keys(extra).length > 0, outcome: 'ok' }
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/** Send one deduped mutation. Every branch reports what the server said. */
async function runMutation(m: OfflineMutation): Promise<Outcome> {
  if (m.type === 'isOnList_toggle') {
    const { outcome } = await send(`/api/prep/items/${m.itemId}`, json('PUT', { isOnList: m.isOnList }))
    return outcome
  }

  if (m.type === 'priority') {
    const { outcome } = await send(`/api/prep/items/${m.itemId}`, json('PUT', { manualPriorityOverride: m.priority }))
    return outcome
  }

  if (m.type === 'status') {
    const { id: logId, outcome } = await ensureLogId(m)
    if (!logId) return outcome
    // PUT triggers the inventory transaction for DONE/PARTIAL.
    const put = await send(`/api/prep/logs/${logId}`, json('PUT', {
      status: m.status,
      ...(m.actualQty !== undefined ? { actualPrepQty: m.actualQty } : {}),
    }))
    return put.outcome
  }

  if (m.type === 'draft_edit') {
    const patch = m.patch ?? {}
    const { id: logId, applied, outcome } = await ensureLogId(m, patch)
    if (!logId) return outcome
    if (applied) return 'ok'
    // PUT /api/prep/logs/[id] is LEAD-gated for plan fields (403) and 404s on a
    // log deleted since it was queued — both permanent.
    const put = await send(`/api/prep/logs/${logId}`, json('PUT', patch))
    return put.outcome
  }

  if (m.type === 'remove_item') {
    // 404 here means the item belongs to another revenue center and the route
    // wrote NOTHING — counting that as synced is what left the job on the
    // kitchen's To Do while the chef's screen said it was gone.
    const { outcome } = await send('/api/prep/plan/remove-item', json('POST', {
      revenueCenterId: m.revenueCenterId ?? null,
      prepItemId: m.itemId,
      restore: m.restore === true,
    }))
    return outcome
  }

  if (m.type === 'post') {
    const { outcome } = await send('/api/prep/plan/post', json('POST', { revenueCenterId: m.revenueCenterId ?? null }))
    return outcome
  }

  // Unknown type — a queue written by a newer build. Nothing to send and no
  // retry will help.
  return 'permanent'
}

export async function flushQueue(): Promise<{ synced: number; failed: number }> {
  // Snapshot: everything enqueued AFTER this line is the page's, not ours.
  const original = loadQueue()
  if (original.length === 0) return { synced: 0, failed: 0 }

  const deduped = deduplicateQueue(original)
  let synced = 0
  let failed = 0

  // What to put back. Always the SURVIVOR, never the originals it was merged
  // from — the survivor already carries the merged patch and the last edit's
  // logId/RC, and that merged state is exactly what should reach the server.
  const retry: OfflineMutation[] = []

  for (let i = 0; i < deduped.length; i++) {
    const outcome = await runMutation(deduped[i])
    if (outcome === 'ok') { synced++; continue }
    failed++
    if (outcome === 'permanent') continue   // see THE RETRY RULE above
    // Transient. The network decided, not the server, so stop here: the rest of
    // the queue would only pile up identical failures, and firing them anyway
    // would let a later mutation land ahead of this one. Keep this mutation and
    // every un-attempted one behind it, in order, for the next flush.
    retry.push(...deduped.slice(i))
    break
  }

  // Anything the page enqueued DURING the awaits above must survive — the
  // planner enqueues a draft_edit per edit, so a chef typing through a flush is
  // ordinary. Identify them by id: they are not in the opening snapshot.
  const snapshotIds = new Set(original.map(o => o.id))
  const appended = loadQueue().filter(o => !snapshotIds.has(o.id))

  const next = [...retry, ...appended]
  try {
    if (next.length === 0) clearQueue()
    else localStorage.setItem(QUEUE_KEY, JSON.stringify(next))
  } catch { /* graceful degradation */ }

  return { synced, failed }
}
