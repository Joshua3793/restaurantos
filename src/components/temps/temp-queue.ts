// On-phone queue for temp readings logged with no signal.
//
// A reading that never reached the server (fetch threw, or the server could not
// decide: 5xx / 401 / 408 / 429) is kept here with the moment it was TAKEN and
// a client-minted id, then re-sent on 'online', when the page comes back into
// view, and on load. The server treats `clientId` as the row id (upsert), so a
// resend of a save whose answer was lost never makes a second reading, and it
// believes `takenAt` only within the last 24 h (src/app/api/temps/readings).
//
// A server refusal (any other 4xx) is a real answer: that reading is dropped
// from the queue and reported, never retried forever. One taken more than 24 h
// ago is refused as too old (422 TOO_OLD): it stays on the phone marked
// `tooOld`, is never sent again, and waits for a cook to discard it.
//
// Only one tab on the phone sends at a time (Web Locks, where available).

const KEY = 'temps_queue_v1'

export interface QueuedReading {
  clientId: string
  unitId: string
  temp: number
  /** 'HH:MM' on the "Logged at" clock when the cook tapped Log. */
  time: string
  /** 'YYYY-MM-DD' the reading belongs to. */
  logDate: string
  recordedBy: string | null
  /** ISO moment the cook tapped Log. */
  takenAt: string
  /** The server refused it as taken more than 24 h ago: kept to show, never resent. */
  tooOld?: boolean
}

export type SendResult =
  | { outcome: 'ok' }
  | { outcome: 'retry' }
  | { outcome: 'rejected'; error: string; status: number; code?: string }

const SEND_TIMEOUT_MS = 15_000

/** Statuses that are not a verdict on the reading — keep it and try again later. */
export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 401 || status === 408 || status === 429
}

export function newClientId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* fall through */ }
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}

export function loadTempQueue(): QueuedReading[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter(r => r && typeof r.clientId === 'string') : []
  } catch {
    return []
  }
}

function saveTempQueue(list: QueuedReading[]): void {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list))
    else localStorage.removeItem(KEY)
  } catch { /* storage full or blocked: nothing more we can do */ }
}

export function enqueueReading(r: QueuedReading): void {
  const list = loadTempQueue().filter(x => x.clientId !== r.clientId)
  saveTempQueue([...list, r])
}

export function dropQueuedReading(clientId: string): void {
  saveTempQueue(loadTempQueue().filter(x => x.clientId !== clientId))
}

/** One POST. Never throws. */
export async function postReading(r: QueuedReading): Promise<SendResult> {
  let res: Response
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS)
  try {
    res = await fetch('/api/temps/readings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(r),
      signal: ctl.signal,
    })
  } catch {
    return { outcome: 'retry' }   // never reached the server (or hung past the timeout)
  } finally {
    clearTimeout(timer)
  }
  if (res.ok) return { outcome: 'ok' }
  if (isTransientStatus(res.status)) return { outcome: 'retry' }
  const body = await res.json().catch(() => null)
  return {
    outcome: 'rejected',
    status: res.status,
    error: (body && typeof body.error === 'string' && body.error) || 'Not saved',
    ...(body && typeof body.code === 'string' ? { code: body.code } : {}),
  }
}

/** Run `fn` only if no other tab on this phone is already sending the queue. */
async function exclusive<T>(name: string, fn: () => Promise<T>, busy: () => T): Promise<T> {
  const locks = typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined
  if (!locks?.request) return fn()
  return locks.request(name, { ifAvailable: true }, lock => (lock ? fn() : busy())) as Promise<T>
}

let flushing = false

/**
 * Send every queued reading, oldest first. Stops at the first one the network
 * can't take (the rest would fail the same way). Readings queued during the
 * flush are kept.
 */
export async function flushTempQueue(): Promise<{ sent: number; rejected: number; tooOld: number; left: number }> {
  const idle = () => ({ sent: 0, rejected: 0, tooOld: 0, left: loadTempQueue().filter(r => !r.tooOld).length })
  if (flushing) return idle()
  flushing = true
  try {
    return await exclusive(KEY, flushAll, idle)
  } finally {
    flushing = false
  }
}

async function flushAll(): Promise<{ sent: number; rejected: number; tooOld: number; left: number }> {
  const snapshot = loadTempQueue().filter(r => !r.tooOld)
  let sent = 0
  let rejected = 0
  const done = new Set<string>()
  const old = new Set<string>()
  for (const r of snapshot) {
    const out = await postReading(r)
    if (out.outcome === 'retry') break
    if (out.outcome === 'rejected' && out.code === 'TOO_OLD') { old.add(r.clientId); continue }
    done.add(r.clientId)
    if (out.outcome === 'ok') sent++
    else rejected++
  }
  const left = loadTempQueue()
    .filter(r => !done.has(r.clientId))
    .map(r => (old.has(r.clientId) ? { ...r, tooOld: true } : r))
  saveTempQueue(left)
  return { sent, rejected, tooOld: old.size, left: left.filter(r => !r.tooOld).length }
}
