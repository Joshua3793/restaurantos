const QUEUE_KEY = 'count_queue_v1'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CountMutation {
  id:        string
  ts:        number
  sessionId: string
  lineId:    string
  type:      'count' | 'skip'
  qty?:      number
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

  const deduped = deduplicateQueue(queue)
  let synced = 0
  let failed = 0

  for (const m of deduped) {
    try {
      await fetch(`/api/count/sessions/${m.sessionId}/lines/${m.lineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m.type === 'skip' ? { skipped: true } : { countedQty: m.qty }),
      })
      synced++
    } catch {
      failed++
    }
  }

  if (failed === 0) clearCountQueue()
  return { synced, failed }
}
