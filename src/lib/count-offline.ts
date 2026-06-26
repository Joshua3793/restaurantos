const QUEUE_KEY = 'count_queue_v1'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CountMutation {
  id:        string
  ts:        number
  sessionId: string
  lineId:    string
  type:      'count' | 'skip'
  qty?:      number
  entries?:  { unit: string; qty: number }[]   // mixed-unit count (authoritative when present)
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

export function clearCountQueue(): void {
  try { localStorage.removeItem(QUEUE_KEY) } catch { /* ok */ }
}

export function pendingCountForSession(sessionId: string): number {
  return loadCountQueue().filter(m => m.sessionId === sessionId).length
}

// ── Deduplication ──────────────────────────────────────────────────────────────
// Keep only the last mutation per lineId — both count and skip replace each other.

function deduplicateQueue(queue: CountMutation[]): CountMutation[] {
  const lastPerLine = new Map<string, CountMutation>()
  for (const m of queue) lastPerLine.set(m.lineId, m)
  // Return in original insertion order, deduplicated
  const seen = new Set<string>()
  const result: CountMutation[] = []
  for (const m of queue) {
    if (lastPerLine.get(m.lineId) === m && !seen.has(m.lineId)) {
      result.push(m)
      seen.add(m.lineId)
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
  const failedLines = new Set<string>()

  for (const m of deduped) {
    try {
      const res = await fetch(`/api/count/sessions/${m.sessionId}/lines/${m.lineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          m.type === 'skip'
            ? { skipped: true }
            : m.entries && m.entries.length
              ? { entries: m.entries }
              : { countedQty: m.qty },
        ),
      })
      // A 4xx/5xx is NOT a successful sync — keep it queued for retry. (fetch only
      // rejects on network failure, so without this an HTTP error silently "synced".)
      if (!res.ok) throw new Error(String(res.status))
      synced++
    } catch {
      failed++
      failedLines.add(m.lineId)
    }
  }

  // Drop only the snapshotted mutations whose line fully synced. Keep failed lines
  // (retry next flush) and anything enqueued during the flush.
  const remaining = loadCountQueue().filter(m => !snapshotIds.has(m.id) || failedLines.has(m.lineId))
  if (remaining.length > 0) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining)) } catch { /* ok */ }
  } else {
    clearCountQueue()
  }
  return { synced, failed }
}
