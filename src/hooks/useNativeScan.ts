// src/hooks/useNativeScan.ts
'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { scanDocument } from '@/lib/capacitor'
import { uploadFiles } from '@/lib/uploadthing-client'
import { compressImageFile } from '@/lib/image-compress'
import {
  savePendingScan, putPendingScan, getPendingScan, listPendingScans, removePendingScan,
  pendingToFiles, summarize, autoRetryable, newScanId, mintSessionId,
  type PendingScan, type PendingScanSummary,
} from '@/lib/pending-scans'

interface Options {
  activeRcId: string | null
  onComplete: () => void
  /** Called with the session id when >1 page was captured — parent opens the grouping screen. */
  onGrouping?: (sessionId: string) => void
}

// Converts a base64 JPEG string (no data-URI prefix) to Uint8Array.
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export type ScanUploader = 'invoiceUploader' | 'recipeScanUploader'

export interface UploadedScanFile { url: string; fileName: string; fileType: string }

/** Cloud timeout for scanned pages — fail fast so the caller's fallback kicks in (same as InvoiceUploadModal). */
const PAGE_UPLOAD_TIMEOUT_MS = 8_000

/**
 * Upload files to UploadThing with a timeout. Resolves to the uploaded files,
 * or null when the cloud upload failed or timed out (the caller decides on a
 * fallback). Never throws.
 */
export async function uploadToCloud(
  files: File[],
  uploader: ScanUploader,
  timeoutMs: number = PAGE_UPLOAD_TIMEOUT_MS,
): Promise<UploadedScanFile[] | null> {
  try {
    const uploaded = await Promise.race([
      uploadFiles(uploader, { files }),
      new Promise<null>((_, rej) =>
        setTimeout(() => rej(new Error('Cloud upload timed out')), timeoutMs)
      ),
    ])
    if (!uploaded?.length) return null
    return uploaded.map(f => ({
      url: f.url,
      fileName: f.name,
      fileType: f.type ?? 'image/jpeg',
    }))
  } catch {
    return null
  }
}

/**
 * Step one of a native scan's page upload: the scanner's base64 pages as
 * compressed JPEG files. Individual images (not a merged PDF) so the server
 * runs them through the sharp enhancement pipeline and one combined
 * multi-image OCR call — and bbox page indexes line up with file order. Done
 * sequentially, one canvas at a time: rasterizing every page concurrently can
 * transiently hold hundreds of MB of bitmaps and OOM low-end mobile WebViews.
 */
export async function scanPagesToFiles(pages: string[]): Promise<File[]> {
  const files: File[] = []
  for (const [i, raw] of pages.entries()) {
    const b64 = raw.replace(/^data:image\/[^;]+;base64,/, '')
    const bytes = base64ToUint8Array(b64)
    const file = new File([new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' })],
      `scan_p${i + 1}.jpg`, { type: 'image/jpeg' })
    files.push(await compressImageFile(file))
  }
  return files
}

/**
 * Both steps at once, for callers with nothing to do in between (recipe
 * scans): pages → files → UploadThing. `uploaded` is null when the cloud
 * upload failed — `files` are still returned so the caller can fall back.
 * The invoice hook calls the two steps itself so its session is created
 * between them, as before.
 */
export async function uploadScanPages(
  pages: string[],
  uploader: ScanUploader,
): Promise<{ files: File[]; uploaded: UploadedScanFile[] | null }> {
  const files = await scanPagesToFiles(pages)
  const uploaded = await uploadToCloud(files, uploader)
  return { files, uploaded }
}


// ── Sending a scan (kept on the phone until it lands) ─────────────────────────

type SendResult =
  | { ok: true; sessionId: string; pageCount: number; needsProcess: boolean }
  | { ok: false; error: string; offline: boolean; needsPerson: boolean }

const OFFLINE = 'No signal'

/** Shared across every mounted copy of the hook: a scan is never sent twice at once (this tab). */
const inFlight = new Set<string>()
let retryRun: Promise<void> | null = null

const pagesWord = (n: number) => `${n} page${n === 1 ? '' : 's'}`

async function safePut(rec: PendingScan) {
  if (!rec.pages.length) return // never saved (no IndexedDB) — don't write an empty record
  try { await putPendingScan(rec) } catch { /* no IndexedDB — the in-memory record still drives this attempt */ }
}

/**
 * Run `fn` holding a cross-tab lock, or skip it (resolves false) when another
 * tab holds it. Browsers without Web Locks just run it — the per-tab guards
 * and the phone-minted session id still keep a scan from landing twice.
 */
async function withLock(name: string, fn: () => Promise<void>): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks?.request) { await fn(); return true }
  return locks.request(name, { ifAvailable: true }, async lock => {
    if (!lock) return false
    await fn()
    return true
  })
}
const scanLock = (id: string) => `pending-scan:${id}`

/**
 * fetch() that gives up after `ms` — one bar of fake signal must not hold the
 * screen for a minute. A timeout rejects like a dropped connection does.
 */
async function fetchT(url: string, init: RequestInit = {}, ms = 15_000): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try { return await fetch(url, { ...init, signal: ctrl.signal }) }
  finally { clearTimeout(t) }
}

/** A failed fetch() (TypeError / timeout) means the request never got an answer. */
function failNetwork(): SendResult { return { ok: false, error: OFFLINE, offline: true, needsPerson: false } }

/**
 * The server answered with an error. 5xx (and 404 / 408 / 429) can clear by
 * themselves and are retried automatically; any other 4xx will fail the same
 * way every time, so it waits for a person.
 */
function failHttp(status: number, error: string): SendResult {
  const transient = status >= 500 || status === 404 || status === 408 || status === 429
  return { ok: false, error, offline: false, needsPerson: !transient }
}

/**
 * Best-effort: delete this scan's session only if it is still exactly what the
 * phone made — UPLOADING, no pages, no lines, never sorted or copied. The server
 * checks all of that in one statement (`?ifUnstarted=1`) and refuses anything
 * else, so a session that landed, was sorted or approved is never touched.
 */
async function clearIfUnstarted(sessionId: string): Promise<void> {
  try { await fetchT(`/api/invoices/sessions/${sessionId}?ifUnstarted=1`, { method: 'DELETE' }) }
  catch { /* offline — the next try finds and reuses it */ }
}

type Reconciled = { done: SendResult } | { done: null; exists: boolean; held: number }

/**
 * Before sending, find out what the server holds under this scan's session id.
 * Nothing → create it. Still UPLOADING, or an unsorted GROUPING batch nobody
 * has opened, with fewer pages than the phone has → send only the missing
 * pages into it (pages land in order, so the first `held` are there). Anything
 * else — every page there, scanned, sorted, in review, approved — the upload
 * landed: the saved pages are dropped and nothing is deleted or re-sent.
 */
async function reconcileSession(rec: PendingScan, id: string): Promise<Reconciled> {
  let res: Response
  try { res = await fetchT(`/api/invoices/sessions/${id}`, { cache: 'no-store' }) }
  catch { return { done: failNetwork() } }
  if (res.status === 404) return { done: null, exists: false, held: 0 }
  if (!res.ok) return { done: failHttp(res.status, `Could not check the half-sent invoice (${res.status}).`) }
  const s: {
    status?: string; files?: unknown[]; scanItems?: unknown[]
    groupingDraft?: unknown; parentSessionId?: string | null
  } = await res.json().catch(() => ({}))
  const n = rec.pages.length
  const held = s.files?.length ?? 0
  const scanned = (s.scanItems?.length ?? 0) > 0
  const untouched = !scanned && !s.parentSessionId && (
    s.status === 'UPLOADING' || (s.status === 'GROUPING' && s.groupingDraft == null)
  )
  if (untouched && held < n) return { done: null, exists: true, held }
  return {
    done: {
      ok: true, sessionId: id, pageCount: n,
      needsProcess: n === 1 && s.status === 'PROCESSING' && !scanned,
    },
  }
}

/**
 * One attempt to turn a pending scan into an invoice session: make sure the
 * session exists (under the id the phone minted), then send the pages it does
 * not hold yet (UploadThing first, then one page per request). Never throws.
 */
async function sendScan(
  rec: PendingScan,
  pageFiles: File[],
  onProgress: (text: string | null) => void,
): Promise<SendResult> {
  const n = pageFiles.length
  try {
    // Name the session before asking for it, and remember the name at once:
    // if the reply is lost (or the phone dies) the next try asks for the same one.
    if (!rec.sessionId) {
      rec.sessionId = mintSessionId()
      await safePut(rec)
    }

    let held = 0
    let exists = false
    if (rec.sessionId) {
      const r = await reconcileSession(rec, rec.sessionId)
      if (r.done) return r.done
      held = r.held
      exists = r.exists
    }

    // 1. Create session (for the kitchen the scan was taken in). Idempotent on
    //    the minted id: a create that already happened hands that session back.
    let sessionId = rec.sessionId
    if (!exists) {
      onProgress(`Sending ${pagesWord(n)}…`)
      let sessRes: Response
      try {
        sessRes = await fetchT('/api/invoices/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revenueCenterId: rec.rcId, ...(rec.sessionId ? { id: rec.sessionId } : {}) }),
        })
      } catch { return failNetwork() }
      if (!sessRes.ok) return failHttp(sessRes.status, `Could not start the invoice (${sessRes.status}).`)
      const sess = await sessRes.json()
      sessionId = sess.id as string
      if (rec.sessionId !== sessionId) { rec.sessionId = sessionId; await safePut(rec) }
    }
    const sid = sessionId as string

    // A failed try keeps rec.sessionId: the next one resumes into the same
    // session. Only a session still empty and untouched is cleared, so it
    // can't sit in the inbox as "Uploading" meanwhile (the server re-checks).
    const fail = async (r: SendResult): Promise<SendResult> => {
      await clearIfUnstarted(sid)
      return r
    }

    const toSend = pageFiles.slice(held)

    // 2a. Try UploadThing CDN (8 s timeout, same as InvoiceUploadModal)
    let uploadOk = false
    const uploaded = await uploadToCloud(toSend, 'invoiceUploader')
    if (uploaded) {
      try {
        const regRes = await fetch(`/api/invoices/sessions/${sid}/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: uploaded }),
        })
        if (regRes.ok) uploadOk = true
      } catch {
        // fall through to local fallback
      }
    }

    // 2b. Local fallback — one page per request to stay under the ~4.5 MB
    // serverless body limit (the route tolerates repeated calls; status
    // reset to PROCESSING is idempotent).
    if (!uploadOk) {
      const limitBytes = 4 * 1024 * 1024
      const oversize = toSend.find(f => f.size > limitBytes)
      if (oversize) {
        return fail({
          ok: false, offline: false, needsPerson: true,
          error: `A scanned page is too large (${(oversize.size / 1024 / 1024).toFixed(1)} MB) even after compression. Please retake the photo.`,
        })
      }
      for (const [i, f] of toSend.entries()) {
        onProgress(`Sending page ${held + i + 1} of ${n}…`)
        const fd = new FormData()
        fd.append('files', f)
        let localRes: Response
        try {
          localRes = await fetchT(`/api/invoices/sessions/${sid}/upload-local`, { method: 'POST', body: fd }, 45_000)
        } catch { return fail(failNetwork()) }
        if (!localRes.ok) {
          const body = await localRes.json().catch(() => ({}))
          return fail(failHttp(localRes.status, body.error ?? `Upload failed (${localRes.status}).`))
        }
      }
    }
    return { ok: true, sessionId: sid, pageCount: n, needsProcess: n === 1 }
  } catch (err) {
    return { ok: false, error: `Scan error: ${err instanceof Error ? err.message : String(err)}`, offline: false, needsPerson: false }
  }
}

/** What the cook reads when a send failed but the pages are safe on the phone. */
function keptMessage(r: { error: string; offline: boolean; needsPerson: boolean }, pages: number): string {
  if (r.offline) return `No signal — ${pagesWord(pages)} saved on this phone. They'll send by themselves when you're back online.`
  return r.needsPerson
    ? `Couldn't send: ${r.error} ${pagesWord(pages)} saved on this phone — Send again, or Discard.`
    : `${r.error} ${pagesWord(pages)} saved on this phone — tap Send now to try again.`
}

export function useNativeScan({ activeRcId, onComplete, onGrouping }: Options) {
  const [isScanning, setIsScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  /** Overlay text for a fresh scan: "Sending page 2 of 4…". */
  const [progress, setProgress] = useState<string | null>(null)
  /** Scans saved on this phone that have not reached the server yet. */
  const [pending, setPending] = useState<PendingScanSummary[]>([])
  /** A retry of the saved scans is running, and what it is doing. */
  const [retrying, setRetrying] = useState(false)
  const [retryProgress, setRetryProgress] = useState<string | null>(null)

  // Refs so the retry triggers below stay mounted once, not on every scope change.
  const onCompleteRef = useRef(onComplete)
  const onGroupingRef = useRef(onGrouping)
  onCompleteRef.current = onComplete
  onGroupingRef.current = onGrouping

  const refreshPending = useCallback(async () => {
    setPending((await listPendingScans()).map(summarize))
  }, [])

  /** After an attempt: drop the saved pages only once the server holds them all. */
  const settle = useCallback(async (rec: PendingScan, r: SendResult, openGrouping: boolean) => {
    if (r.ok) {
      try { await removePendingScan(rec.id) } catch { /* nothing saved, or already gone */ }
      // 3. One page → OCR immediately. Multi-page capture → grouping screen
      //    (the batch may be several invoices photographed in one go).
      if (r.pageCount > 1 && openGrouping && onGroupingRef.current) onGroupingRef.current(r.sessionId)
      else if (r.needsProcess) fetch(`/api/invoices/sessions/${r.sessionId}/process`, { method: 'POST' }).catch(() => {})
      // 4. Notify parent
      onCompleteRef.current()
    } else {
      // No-signal tries don't count toward the automatic-retry cap.
      if (!r.offline) rec.attempts += 1
      rec.needsPerson = r.needsPerson
      rec.lastError = r.offline ? OFFLINE : r.error
      await safePut(rec)
    }
  }, [])

  /**
   * Send pages (already JPEG files) into a new invoice session — the shared
   * second half of both scanners: the native one below and the browser
   * scanner (WebScanner), which hands its cleaned pages in directly. The pages
   * are saved on the phone first, so a failed upload loses nothing.
   */
  const submitPages = useCallback(async (pageFiles: File[]) => {
    if (!pageFiles.length) return
    setIsScanning(true)
    setScanError(null)
    // The scan's lock is taken before its record exists, so a retry run in
    // another tab can never pick it up while this tab is sending it.
    const id = newScanId()
    inFlight.add(id)
    try {
      await withLock(scanLock(id), async () => {
        let rec: PendingScan
        let saved = true
        try { rec = await savePendingScan(pageFiles, activeRcId, id) }
        catch {
          saved = false
          rec = { id, createdAt: Date.now(), rcId: activeRcId, pages: [], sessionId: null, attempts: 0, lastError: null }
        }
        const r: SendResult = typeof navigator !== 'undefined' && navigator.onLine === false
          ? failNetwork()
          : await sendScan(rec, pageFiles, setProgress)
        if (r.ok || saved) await settle(rec, r, true)
        if (!r.ok) {
          setScanError(saved ? keptMessage(r, pageFiles.length)
            : r.offline ? 'No signal — the scan could not be sent. Please scan again when you are back online.' : r.error)
        }
      })
    } finally {
      inFlight.delete(id)
      setIsScanning(false)
      setProgress(null)
      refreshPending()
    }
  }, [activeRcId, settle, refreshPending])

  /**
   * Try the saved scans again, oldest first. One run at a time across every
   * tab (Web Locks); a scan already being sent is skipped. `fromTap` (the Send
   * now button) tries every scan and reports a failure; the automatic runs
   * (page load, back online, app reopened) stay quiet and skip scans that
   * need a person or have failed MAX_AUTO_ATTEMPTS times.
   */
  const retryPending = useCallback((fromTap = false): Promise<void> => {
    if (retryRun) return retryRun
    retryRun = (async () => {
      const ran = await withLock('pending-scans', async () => {
        const all = await listPendingScans()
        const todo = fromTap ? all : all.filter(autoRetryable)
        if (!todo.length) return
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          if (fromTap) setScanError('Still no signal — the pages stay saved on this phone.')
          return
        }
        setRetrying(true)
        if (fromTap) setScanError(null)
        for (const rec of todo) {
          if (inFlight.has(rec.id)) continue
          let offline = false
          inFlight.add(rec.id)
          try {
            await withLock(scanLock(rec.id), async () => {
              // Re-read under the lock: a Discard or another tab may have changed it.
              const fresh = await getPendingScan(rec.id)
              if (!fresh) return
              if (!fresh.pages.length) { await removePendingScan(fresh.id).catch(() => {}); return }
              const r = await sendScan(fresh, pendingToFiles(fresh), setRetryProgress)
              await settle(fresh, r, false)
              if (!r.ok) {
                if (fromTap) setScanError(keptMessage(r, fresh.pages.length))
                offline = r.offline
              }
            })
          } finally {
            inFlight.delete(rec.id)
            setRetryProgress(null)
          }
          if (offline) break // no signal — the rest would fail the same way
        }
      })
      if (!ran && fromTap) setScanError('Another window is sending these scans — give it a moment.')
    })().finally(() => {
      retryRun = null
      setRetrying(false)
      setRetryProgress(null)
      refreshPending()
    })
    return retryRun
  }, [settle, refreshPending])

  /**
   * Throw a saved scan away (the banner owns the confirm). Its session is
   * cleared only while it is still empty and untouched; anything that landed
   * stays in the inbox.
   */
  const discardPending = useCallback(async (id: string) => {
    if (inFlight.has(id)) return
    await withLock(scanLock(id), async () => {
      const rec = await getPendingScan(id)
      if (rec?.sessionId) await clearIfUnstarted(rec.sessionId)
      try { await removePendingScan(id) } catch { /* already gone */ }
    })
    refreshPending()
  }, [refreshPending])

  // Automatic retries: when the page loads, when signal comes back, and when
  // the app or tab is reopened.
  useEffect(() => {
    retryPending()
    // Give the connection a moment to settle before the first try.
    let onlineTimer: ReturnType<typeof setTimeout> | undefined
    const onOnline = () => { clearTimeout(onlineTimer); onlineTimer = setTimeout(() => { retryPending() }, 2000) }
    const onVisible = () => { if (document.visibilityState === 'visible') retryPending() }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(onlineTimer)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [retryPending])

  /** Native app: open the phone's own document scanner, then submit its pages. */
  const triggerScan = useCallback(async () => {
    setScanError(null)
    try {
      const pages = await scanDocument()
      if (!pages.length) return
      setIsScanning(true)
      const pageFiles = await scanPagesToFiles(pages)
      await submitPages(pageFiles)
    } catch (err) {
      setScanError(`Scan error: ${err instanceof Error ? err.message : String(err)}`)
      setIsScanning(false)
    }
  }, [submitPages])

  const clearError = () => setScanError(null)

  return {
    triggerScan, submitPages, isScanning, progress, scanError, clearError,
    pending, retrying, retryProgress, retryPending, discardPending,
  }
}
