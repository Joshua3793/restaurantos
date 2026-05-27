import type { PrepItemRich } from '@/components/prep/types'

const CACHE_KEY = 'prep_items_v1'
const QUEUE_KEY = 'prep_queue_v1'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface OfflineMutation {
  id:         string
  ts:         number
  type:       'isOnList_toggle' | 'status' | 'priority'
  itemId:     string
  isOnList?:  boolean         // for isOnList_toggle
  logId?:     string | null   // null or '_opt_<itemId>' = not yet on server (status type)
  status?:    string
  actualQty?: number
  priority?:  string
}

// ── Cache ──────────────────────────────────────────────────────────────────────

export function savePrepCache(items: PrepItemRich[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ items, ts: Date.now() }))
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
// For status and priority mutations, keep only the last one per item.
// Schedule add/remove are kept in order (they're intentional distinct ops).

function deduplicateQueue(queue: OfflineMutation[]): OfflineMutation[] {
  const lastIsOnList = new Map<string, OfflineMutation>()
  const lastStatus   = new Map<string, OfflineMutation>()
  const lastPriority = new Map<string, OfflineMutation>()
  for (const m of queue) {
    if (m.type === 'isOnList_toggle') lastIsOnList.set(m.itemId, m)
    if (m.type === 'status')          lastStatus.set(m.itemId, m)
    if (m.type === 'priority')        lastPriority.set(m.itemId, m)
  }

  const seenIsOnList = new Set<string>()
  const seenStatus   = new Set<string>()
  const seenPriority = new Set<string>()
  const result: OfflineMutation[] = []

  for (const m of queue) {
    if (m.type === 'isOnList_toggle' && lastIsOnList.get(m.itemId) === m && !seenIsOnList.has(m.itemId)) {
      result.push(m)
      seenIsOnList.add(m.itemId)
    } else if (m.type === 'status' && lastStatus.get(m.itemId) === m && !seenStatus.has(m.itemId)) {
      result.push(m)
      seenStatus.add(m.itemId)
    } else if (m.type === 'priority' && lastPriority.get(m.itemId) === m && !seenPriority.has(m.itemId)) {
      result.push(m)
      seenPriority.add(m.itemId)
    }
  }

  return result
}

// ── Flush ──────────────────────────────────────────────────────────────────────

export async function flushQueue(): Promise<{ synced: number; failed: number }> {
  const queue = loadQueue()
  if (queue.length === 0) return { synced: 0, failed: 0 }

  const deduped = deduplicateQueue(queue)
  let synced = 0
  let failed = 0

  for (const m of deduped) {
    try {
      if (m.type === 'isOnList_toggle') {
        await fetch(`/api/prep/items/${m.itemId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isOnList: m.isOnList }),
        })
        synced++

      } else if (m.type === 'status') {
        let logId = m.logId

        // If we still have no real ID, create the log first
        if (!logId) {
          const log = await fetch('/api/prep/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prepItemId: m.itemId }),
          }).then(r => r.json())
          logId = log.id
        }

        // PUT triggers inventory transaction for DONE/PARTIAL
        await fetch(`/api/prep/logs/${logId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: m.status,
            ...(m.actualQty !== undefined ? { actualPrepQty: m.actualQty } : {}),
          }),
        })
        synced++

      } else if (m.type === 'priority') {
        await fetch(`/api/prep/items/${m.itemId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ manualPriorityOverride: m.priority }),
        })
        synced++
      }
    } catch {
      failed++
    }
  }

  clearQueue()
  return { synced, failed }
}
