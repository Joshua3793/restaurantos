'use client'
// Recipe Scan — the "Reading" list on the Recipe Book page. One row per scan
// still in play (reading, couldn't read, or with a recipe not yet saved or
// discarded), and under a read scan one row per recipe found, each opening
// its review screen. Manager-only; the page mounts it when there is a scan.
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { FileText, Image as ImageIcon, FileSpreadsheet, Loader2, RotateCcw, X } from 'lucide-react'
import { Pill } from '@/components/ui/Pill'

export type ScanStatus = 'UPLOADING' | 'READING' | 'READY' | 'ERROR'
export type DraftStatus = 'OPEN' | 'SAVED' | 'DISCARDED'

/** One row of GET /api/recipe-scans. */
export interface RecipeScanSummary {
  id: string
  status: ScanStatus
  error: string | null
  revenueCenterId: string | null
  createdAt: string
  updatedAt: string
  files: { id: string; fileName: string; fileType: string }[]
  drafts: { id: string; index: number; title: string; status: DraftStatus; savedRecipeId: string | null }[]
}

/** While any scan is being read the list re-reads itself this often. */
const POLL_MS = 4_000

/** Still being read — the row shows Reading and the list keeps polling. */
export function isReading(s: Pick<RecipeScanSummary, 'status'>): boolean {
  return s.status === 'READING' || s.status === 'UPLOADING'
}

/**
 * The manager's open scans, polled every 4 s while any is READING (stops when
 * none are). `enabled` is false until the RC scope and the user's role are
 * known (house rule: loaders wait for useRc().ready).
 */
export function useRecipeScans(enabled: boolean) {
  const [scans, setScans] = useState<RecipeScanSummary[]>([])
  // Bumped when every load settles, ok or not — it re-arms the poll timer, so a
  // failed poll (wifi blip, 5xx) can't stop polling for good.
  const [tick, setTick] = useState(0)
  // Only the latest request may write — a slow earlier poll can't undo a newer one.
  const seq = useRef(0)

  const reload = useCallback(async () => {
    if (!enabled) return
    const mine = ++seq.current
    try {
      const res = await fetch('/api/recipe-scans', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      if (mine !== seq.current) return
      setScans(Array.isArray(data) ? data : [])
    } catch {
      // keep what is on screen; the next poll or action tries again
    } finally {
      setTick(t => t + 1)
    }
  }, [enabled])

  useEffect(() => {
    if (enabled) reload()
    else setScans([])
  }, [enabled, reload])

  const anyReading = scans.some(isReading)
  useEffect(() => {
    if (!enabled || !anyReading) return
    const t = setTimeout(reload, POLL_MS)
    return () => clearTimeout(t)
    // `tick` re-arms the timer after every load settles, whatever its outcome.
  }, [enabled, anyReading, tick, reload])

  /**
   * Start (or retry) reading a scan. The read can take minutes, so it is fired
   * without waiting (as invoices do); the row shows Reading at once, the poll
   * follows it, and the list re-reads as soon as the read returns.
   */
  const startReading = useCallback((id: string) => {
    setScans(prev => prev.map(s => (s.id === id ? { ...s, status: 'READING', error: null } : s)))
    fetch(`/api/recipe-scans/${id}/process`, { method: 'POST' })
      .catch(() => {})
      .finally(() => { reload() })
  }, [reload])

  /** Throw the scan away. Resolves to an error message, or null when it went. */
  const discard = useCallback(async (id: string): Promise<string | null> => {
    const before = scans
    setScans(prev => prev.filter(s => s.id !== id))
    try {
      const res = await fetch(`/api/recipe-scans/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setScans(before)
        return body.error ?? 'Could not discard this scan.'
      }
      return null
    } catch {
      setScans(before)
      return 'Could not discard this scan — check the connection.'
    } finally {
      reload()
    }
  }, [scans, reload])

  return { scans, reload, startReading, discard }
}

// ─── Presentation ────────────────────────────────────────────────────────────

function fileIcon(fileType: string, fileName: string) {
  const t = fileType.toLowerCase()
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  if (t.startsWith('image/')) return <ImageIcon size={13} />
  if (t.includes('sheet') || t === 'text/csv' || ext === 'xlsx' || ext === 'csv') return <FileSpreadsheet size={13} />
  return <FileText size={13} />
}

function scanTitle(scan: RecipeScanSummary): { title: string; meta: string | null } {
  const first = scan.files[0]
  if (!first) return { title: 'Scan', meta: null }
  const more = scan.files.length - 1
  const allPhotos = scan.files.every(f => f.fileType.toLowerCase().startsWith('image/'))
  return {
    title: first.fileName,
    meta: more > 0 ? (allPhotos ? `${scan.files.length} pages` : `+${more} more`) : null,
  }
}

function startedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

interface RowProps {
  scan: RecipeScanSummary
  onRetry: (id: string) => void
  onDiscard: (id: string) => Promise<string | null>
}

function ScanRow({ scan, onRetry, onDiscard }: RowProps) {
  const [confirming, setConfirming] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { title, meta } = scanTitle(scan)
  const reading = isReading(scan)
  const drafts = scan.drafts.filter(d => d.status !== 'DISCARDED')
  const found = scan.drafts.length

  const caption =
    error ? error
    : reading ? 'Reading the recipe — you can leave this page'
    : scan.status === 'ERROR' ? (scan.error ?? "Couldn't read this file.")
    : `Scanned ${startedAt(scan.createdAt)}`

  const doDiscard = async () => {
    setDiscarding(true)
    setError(null)
    const err = await onDiscard(scan.id)
    setDiscarding(false)
    setConfirming(false)
    if (err) setError(err)
  }

  return (
    <div className="border-b border-dashed border-line last:border-b-0">
      <div className="flex items-center justify-between gap-3 px-3 py-[11px]">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-6 h-6 rounded-[6px] bg-bg-2 grid place-items-center text-ink-3 shrink-0">
            {scan.files[0] ? fileIcon(scan.files[0].fileType, scan.files[0].fileName) : <FileText size={13} />}
          </div>
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5 min-w-0">
              <span className="text-[13.5px] font-medium text-ink truncate">{title}</span>
              {meta && <span className="ui-meta shrink-0">{meta}</span>}
            </div>
            <p className={`ui-meta mt-0.5 ${error || scan.status === 'ERROR' ? 'text-red-text' : ''}`}>{caption}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {confirming ? (
            <>
              <span className="text-[12.5px] text-ink-2 hidden sm:inline">Discard this scan?</span>
              <button
                onClick={doDiscard}
                disabled={discarding}
                className="px-2.5 py-1 rounded-[7px] text-[12px] font-medium text-paper bg-red hover:opacity-90 disabled:opacity-50"
              >
                {discarding ? 'Discarding…' : 'Discard'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={discarding}
                className="px-2.5 py-1 rounded-[7px] text-[12px] font-medium text-ink-2 bg-paper border border-line hover:border-ink-3"
              >
                Keep
              </button>
            </>
          ) : (
            <>
              {reading && (
                <Pill tone="gold"><Loader2 size={10} className="animate-spin" />Reading</Pill>
              )}
              {scan.status === 'READY' && (
                <Pill tone="ok">{found} {found === 1 ? 'recipe' : 'recipes'} found</Pill>
              )}
              {scan.status === 'ERROR' && (
                <>
                  <Pill tone="alert">Couldn&apos;t read</Pill>
                  <button
                    onClick={() => onRetry(scan.id)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-[7px] text-[12px] font-medium text-ink-2 bg-paper border border-line hover:border-ink-3"
                  >
                    <RotateCcw size={11} className="text-ink-3" />
                    Retry
                  </button>
                </>
              )}
              {!reading && (
                <button
                  onClick={() => { setError(null); setConfirming(true) }}
                  title="Discard this scan"
                  aria-label="Discard this scan"
                  className="p-1 rounded-[6px] text-ink-4 hover:text-ink-2 hover:bg-bg-2"
                >
                  <X size={14} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {scan.status === 'READY' && drafts.length > 0 && (
        <div className="pb-1.5">
          {drafts.map(d => d.status === 'OPEN' ? (
            <Link
              key={d.id}
              href={`/recipes/scan/${d.id}`}
              className="flex items-center justify-between gap-3 pl-[46px] pr-3 py-2 hover:bg-bg transition-colors"
            >
              <span className="text-[13px] text-ink truncate">{d.title}</span>
              <span className="flex items-center gap-1.5 shrink-0">
                <span className="font-mono text-[10.5px] uppercase text-ink-3">Review</span>
                <span className="text-ink-3 text-lg leading-none">›</span>
              </span>
            </Link>
          ) : (
            <div key={d.id} className="flex items-center justify-between gap-3 pl-[46px] pr-3 py-2">
              <span className="text-[13px] text-ink-3 truncate">{d.title}</span>
              <Pill>Saved</Pill>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface ListProps {
  scans: RecipeScanSummary[]
  onRetry: (id: string) => void
  onDiscard: (id: string) => Promise<string | null>
}

export function ScanReadingList({ scans, onRetry, onDiscard }: ListProps) {
  if (scans.length === 0) return null
  const reading = scans.filter(isReading).length
  return (
    <section>
      <p className="font-mono text-[10.5px] text-ink-3 tracking-[0.04em] uppercase mb-1.5">
        Scans · {scans.length}{reading > 0 && <> · {reading} reading</>}
      </p>
      <div className="bg-paper rounded-xl border border-line">
        {scans.map(s => (
          <ScanRow key={s.id} scan={s} onRetry={onRetry} onDiscard={onDiscard} />
        ))}
      </div>
    </section>
  )
}
