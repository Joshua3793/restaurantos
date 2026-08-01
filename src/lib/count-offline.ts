const QUEUE_KEY = 'count_queue_v1'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CountMutation {
  id:        string
  ts:        number
  sessionId: string
  lineId:    string
  type:      'count' | 'skip' | 'uom'
  qty?:      number
  entries?:  { unit: string; qty: number }[]   // mixed-unit count (authoritative when present)
  carried?:  boolean                            // "Same as last" — record unchanged, zero variance
  // The unit `qty` was entered in (type 'count'), or the newly picked unit (type 'uom').
  // MUST ride along with the count: the server falls back to the line's stored
  // selectedUom when the body omits it, which silently reinterprets an offline count
  // in the line's default unit (a kg count recorded as cases).
  uom?:      string
  // type 'uom' only — the unit changed on a line that already had a count, so the
  // stored qty is meaningless in the new unit and must be reset to uncounted.
  clearsCount?: boolean
}

// ── Session cache ──────────────────────────────────────────────────────────────
// Keyed by sessionId so multiple sessions can be cached independently.

export function saveCountSessionCache(sessionId: string, data: unknown): void {
  try {
    localStorage.setItem(`count_session_${sessionId}`, JSON.stringify({ data, ts: Date.now() }))
  } catch { /* quota exceeded or private browsing */ }
}

export function loadCountSessionCache<T>(sessionId: string): T | null {
  try {
    const raw = localStorage.getItem(`count_session_${sessionId}`)
    if (!raw) return null
    return (JSON.parse(raw) as { data: T }).data
  } catch { return null }
}

// ── Queue ──────────────────────────────────────────────────────────────────────

export function enqueueCountMutation(m: Omit<CountMutation, 'id' | 'ts'>): void {
  try {
    const queue = loadCountQueue()
    queue.push({
      ...m,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ts: Date.now(),
    })
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch { /* graceful degradation */ }
}

export function loadCountQueue(): CountMutation[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    return raw ? (JSON.parse(raw) as CountMutation[]) : []
  } catch { return [] }
}

/**
 * Drop any queued count/skip for a line, leaving 'uom' mutations alone.
 * Used when a unit change invalidates an already-recorded count: without this the
 * superseded count would still flush and re-count the line under the new unit.
 * Returns the resulting queue length so callers can resync their pending badge.
 */
export function dropQueuedStateForLine(lineId: string): number {
  try {
    const remaining = loadCountQueue().filter(m => !(m.lineId === lineId && m.type !== 'uom'))
    localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining))
    return remaining.length
  } catch { return loadCountQueue().length }
}

export function clearCountQueue(): void {
  try { localStorage.removeItem(QUEUE_KEY) } catch { /* ok */ }
}

export function pendingCountForSession(sessionId: string): number {
  return loadCountQueue().filter(m => m.sessionId === sessionId).length
}

// ── Deduplication ──────────────────────────────────────────────────────────────
// Keep only the last mutation per line PER KEY. count/skip share a key — they're
// mutually exclusive states of the same line, so the later one wins. A 'uom' change
// gets its own key: it is a different field, and collapsing it into the shared key
// would let a unit change swallow a queued count (or vice versa) and lose the count.

function dedupeKey(m: CountMutation): string {
  return `${m.lineId}:${m.type === 'uom' ? 'uom' : 'state'}`
}

function deduplicateQueue(queue: CountMutation[]): CountMutation[] {
  const lastPerKey = new Map<string, CountMutation>()
  for (const m of queue) lastPerKey.set(dedupeKey(m), m)
  // Return in original insertion order, deduplicated
  const seen = new Set<string>()
  const result: CountMutation[] = []
  for (const m of queue) {
    const k = dedupeKey(m)
    if (lastPerKey.get(k) === m && !seen.has(k)) {
      result.push(m)
      seen.add(k)
    }
  }
  return result
}

// ── Flush ──────────────────────────────────────────────────────────────────────

export async function flushCountQueue(): Promise<{ synced: number; failed: number }> {
  const queue = loadCountQueue()
  if (queue.length === 0) return { synced: 0, failed: 0 }

  // Snapshot the ids we're flushing so we only remove THESE afterwards — a mutation
  // enqueued while we await below must survive (clearing the whole queue dropped it).
  const snapshotIds = new Set(queue.map(m => m.id))
  const deduped = deduplicateQueue(queue)
  let synced = 0
  let failed = 0
  const failedKeys = new Set<string>()

  for (const m of deduped) {
    try {
      const res = await fetch(`/api/count/sessions/${m.sessionId}/lines/${m.lineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          m.type === 'skip'
            ? { skipped: true }
            : m.type === 'uom'
              // `skipped: false` is this API's existing "reset to uncounted" verb
              // (see clearLine / unskipLine) — it drops the qty and keeps the unit.
              ? { selectedUom: m.uom, ...(m.clearsCount ? { skipped: false } : {}) }
              : m.entries && m.entries.length
                // Mixed-unit: entries carry their own units, and the server stores
                // selectedUom = baseUnit for that path. Sending a unit would fight it.
                ? { entries: m.entries }
                : {
                    countedQty: m.qty,
                    ...(m.uom ? { selectedUom: m.uom } : {}),
                    ...(m.carried ? { carriedForward: true } : {}),
                  },
        ),
      })
      // A 4xx/5xx is NOT a successful sync — keep it queued for retry. (fetch only
      // rejects on network failure, so without this an HTTP error silently "synced".)
      if (!res.ok) throw new Error(String(res.status))
      synced++
    } catch {
      failed++
      failedKeys.add(dedupeKey(m))
    }
  }

  // Drop only the snapshotted mutations whose key fully synced. Keep failed keys
  // (retry next flush) and anything enqueued during the flush.
  const remaining = loadCountQueue().filter(m => !snapshotIds.has(m.id) || failedKeys.has(dedupeKey(m)))
  if (remaining.length > 0) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining)) } catch { /* ok */ }
  } else {
    clearCountQueue()
  }
  return { synced, failed }
}
