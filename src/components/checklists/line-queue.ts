// On-phone queue for station-checklist answers saved with no signal.
//
// A tick / reading / flag the server never answered (fetch threw, or the phone
// is offline) stays on screen and waits here; it is re-sent on 'online', when
// the page comes back into view, and on load. One entry per job: a later answer
// to the same job replaces the earlier one, because PUT /api/checklists/lines/[id]
// SETS the job's state (last write wins) — it never adds to it. A TEMP job's
// Temps-log reading is keyed by the id the line already holds (upsert), so a
// replay of a save whose answer was lost replaces that reading, never doubles it.
//
// Each entry carries `takenAt` (when the cook answered) so a replay keeps the
// real time on the job and its temp reading, and `userId`, so a job is only
// ever sent under the session of the cook who answered it (and `userName`, so a
// shared phone can say whose answers are waiting).
//
// A replay is refused quietly (`stale: true`, sent back as a normal answer) when
// someone else answered the job after this cook did; the screen then reloads.

import type { LineAction } from '@/lib/checklists/apply-line'

const KEY = 'checklist_queue_v1'

export interface QueuedLine {
  /** Unique per entry (a replaced entry gets a new one). */
  id: string
  lineId: string
  action: LineAction
  /** ISO moment the cook answered. */
  takenAt: string
  userId: string
  /** Display name of the cook who answered (older entries may lack it). */
  userName?: string
}

/** Statuses that are not a verdict on the answer — keep it and try again later. */
export function isTransientStatus(status: number): boolean {
  return status === 0 || status >= 500 || status === 401 || status === 408 || status === 429
}

export function loadLineQueue(): QueuedLine[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter(e => e && typeof e.lineId === 'string' && e.action) : []
  } catch {
    return []
  }
}

function save(list: QueuedLine[]): void {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list))
    else localStorage.removeItem(KEY)
  } catch { /* storage full or blocked */ }
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** Queue an answer, replacing any earlier one for the same job. */
export function enqueueLine(e: Omit<QueuedLine, 'id'>): void {
  save([...loadLineQueue().filter(x => x.lineId !== e.lineId), { ...e, id: newId() }])
}

export function hasQueued(lineId: string): boolean {
  return loadLineQueue().some(x => x.lineId === lineId)
}

/** Answers waiting on this phone from cooks other than `userId`, one row per cook. */
export function waitingFromOthers(userId: string): { userId: string; name: string; count: number }[] {
  const by = new Map<string, { userId: string; name: string; count: number }>()
  for (const e of loadLineQueue()) {
    if (e.userId === userId) continue
    const row = by.get(e.userId) ?? { userId: e.userId, name: e.userName?.trim() || 'another cook', count: 0 }
    row.count++
    by.set(e.userId, row)
  }
  return Array.from(by.values())
}

/** Throw away every answer one cook left waiting on this phone (a lead's call). */
export function discardQueuedFor(userId: string): void {
  save(loadLineQueue().filter(e => e.userId !== userId))
}

/**
 * Run `fn` only if no other tab on this phone is already sending the queue
 * (Web Locks). Without the API it just runs — the module guard still holds per tab.
 */
async function exclusive<T>(name: string, fn: () => Promise<T>, busy: () => T): Promise<T> {
  const locks = typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined
  if (!locks?.request) return fn()
  return locks.request(name, { ifAvailable: true }, lock => (lock ? fn() : busy())) as Promise<T>
}

/**
 * Send this user's queued answers, oldest first, one at a time. Stops at the
 * first one the network can't take. `sent` lines come back with the server's
 * view of the job; `rejected` were refused (signed off, job gone…) and dropped.
 */
export async function flushLineQueue<L>(
  userId: string,
  put: (lineId: string, body: unknown) => Promise<{ ok: true; data: { line: L } } | { ok: false; status: number; error: string }>,
): Promise<{ sent: L[]; rejected: number; left: number }> {
  return exclusive(KEY, () => flushMine(userId, put), () => ({
    sent: [], rejected: 0, left: loadLineQueue().filter(e => e.userId === userId).length,
  }))
}

async function flushMine<L>(
  userId: string,
  put: (lineId: string, body: unknown) => Promise<{ ok: true; data: { line: L } } | { ok: false; status: number; error: string }>,
): Promise<{ sent: L[]; rejected: number; left: number }> {
  const mine = loadLineQueue().filter(e => e.userId === userId)
  const sent: L[] = []
  let rejected = 0
  const done = new Set<string>()
  for (const e of mine) {
    const r = await put(e.lineId, { ...e.action, takenAt: e.takenAt })
    if (!r.ok && isTransientStatus(r.status)) break
    done.add(e.id)
    if (r.ok) sent.push(r.data.line)
    else rejected++
  }
  // Re-read: an answer queued while we were sending must survive.
  const left = loadLineQueue().filter(e => !done.has(e.id))
  save(left)
  return { sent, rejected, left: left.filter(e => e.userId === userId).length }
}
