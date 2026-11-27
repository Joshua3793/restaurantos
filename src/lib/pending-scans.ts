// src/lib/pending-scans.ts
'use client'

// Scanned invoice pages kept on the phone until they are safely uploaded.
// A cook can snap a 4-page invoice at the back door with no signal: the pages
// are written here BEFORE the upload starts and removed only once the server
// holds every page. Plain IndexedDB, no dependency. Pages are stored as
// ArrayBuffers (not Blobs) — older iOS WebViews could not keep Blobs in IDB.
//
// Every function is safe to call where IndexedDB is missing (SSR, a private
// window, a locked-down WebView): reads return empty, writes reject, and the
// caller carries on with the in-memory pages as before.

const DB_NAME = 'fergies-pending-scans'
const STORE = 'scans'
const VERSION = 1

export interface PendingPage { name: string; type: string; data: ArrayBuffer }

export interface PendingScan {
  id: string
  /** Capture time (ms since epoch). */
  createdAt: number
  /** The revenue center the scan was taken for — retries use this, not the current one. */
  rcId: string | null
  pages: PendingPage[]
  /** The invoice session this scan goes into. The phone mints it BEFORE the
   *  first create request and keeps it across retries (the server creates it
   *  idempotently under that id), so a retry always finds what an earlier try
   *  left and never uploads the pages twice. */
  sessionId: string | null
  /** Failed tries that reached the server (no-signal tries do not count). */
  attempts: number
  lastError: string | null
  /** The last failure will not fix itself (refused, page too large): only
   *  Send again or Discard, never an automatic retry. */
  needsPerson?: boolean
}

/** Automatic retries stop after this many failed tries; Send again still works. */
export const MAX_AUTO_ATTEMPTS = 5

/** May the automatic retries (page load, back online, app reopened) send this? */
export function autoRetryable(rec: PendingScan): boolean {
  return !rec.needsPerson && rec.attempts < MAX_AUTO_ATTEMPTS
}

/** What the banner needs — no page bytes. */
export interface PendingScanSummary {
  id: string
  createdAt: number
  pageCount: number
  lastError: string | null
  /** Waiting on a person: Send again or Discard. */
  stuck: boolean
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return }
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const req = fn(tx.objectStore(STORE))
    let result: T
    req.onsuccess = () => { result = req.result }
    tx.oncomplete = () => { db.close(); resolve(result) }
    tx.onerror = () => { db.close(); reject(tx.error ?? req.error ?? new Error('IndexedDB request failed')) }
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('IndexedDB transaction aborted')) }
  }))
}

export function newScanId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `scan_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

/** A v4 UUID for a new invoice session, or null where the browser has no crypto (server mints one). */
export function mintSessionId(): string | null {
  if (typeof crypto === 'undefined') return null
  // randomUUID needs a secure context; getRandomValues does not.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  if (typeof crypto.getRandomValues !== 'function') return null
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Save freshly scanned pages. Resolves to the stored record. */
export async function savePendingScan(files: File[], rcId: string | null, id: string = newScanId()): Promise<PendingScan> {
  const pages: PendingPage[] = []
  for (const f of files) pages.push({ name: f.name, type: f.type || 'image/jpeg', data: await f.arrayBuffer() })
  const rec: PendingScan = {
    id, createdAt: Date.now(), rcId, pages,
    sessionId: null, attempts: 0, lastError: null,
  }
  await run('readwrite', s => s.put(rec))
  return rec
}

export async function putPendingScan(rec: PendingScan): Promise<void> {
  await run('readwrite', s => s.put(rec))
}

export async function getPendingScan(id: string): Promise<PendingScan | null> {
  try { return (await run<PendingScan | undefined>('readonly', s => s.get(id))) ?? null }
  catch { return null }
}

/** Every pending scan, oldest first. Empty when IndexedDB is unavailable. */
export async function listPendingScans(): Promise<PendingScan[]> {
  try {
    const all = await run<PendingScan[]>('readonly', s => s.getAll())
    return (all ?? []).sort((a, b) => a.createdAt - b.createdAt)
  } catch {
    return []
  }
}

export async function removePendingScan(id: string): Promise<void> {
  await run('readwrite', s => s.delete(id))
}

export function pendingToFiles(rec: PendingScan): File[] {
  return rec.pages.map(p => new File([p.data], p.name, { type: p.type }))
}

export function summarize(rec: PendingScan): PendingScanSummary {
  return {
    id: rec.id, createdAt: rec.createdAt, pageCount: rec.pages.length,
    lastError: rec.lastError, stuck: !autoRetryable(rec),
  }
}
