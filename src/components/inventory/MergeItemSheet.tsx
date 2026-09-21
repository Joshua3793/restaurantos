// Merge UI in the item drawer (item-consolidation Task 10). One sheet, three
// states: pick the duplicate → preview the server's dry-run plan → done.
// The server (src/lib/item-merge.ts + api/inventory/[id]/merge) does every
// bit of the actual work; this component only calls it and renders what it
// says. See .superpowers/sdd/item-consolidation/task-10-{brief,addendum}.md.
'use client'
import { useEffect, useRef, useState } from 'react'
import { X, Search, GitMerge, Loader2, ArrowLeft, TriangleAlert } from 'lucide-react'
import type { MergeGuard, MergeSummary } from '@/lib/item-merge'
import { mergeSummaryLines, mergeNotes, UNDO_DISABLED_NOTE } from '@/lib/item-merge-copy'

export interface MergeHit {
  id: string; itemName: string; baseUnit: string
  recipeCount: number; purchaseCount: number; stockOnHand: number
}

type PlanFailure = { ok: false; guard: MergeGuard; message: string }
type DryRunOk = { ok: true; dryRun: true; summary: MergeSummary; willDisableUndo: boolean }
type DryRunResult = DryRunOk | PlanFailure
type ConfirmOk = {
  ok: true; dryRun: false; mergeId: string; summary: MergeSummary
  willDisableUndo: boolean; warning?: string
}

const isDryRunOk = (d: unknown): d is DryRunOk =>
  !!d && typeof d === 'object' && (d as { ok?: unknown }).ok === true
const isPlanFailure = (d: unknown): d is PlanFailure =>
  !!d && typeof d === 'object' && (d as { ok?: unknown }).ok === false && typeof (d as { guard?: unknown }).guard === 'string'

interface MergeItemSheetProps {
  survivor: { id: string; itemName: string; countUnit: string; baseUnit: string }
  rcId: string | null
  onClose: () => void
  /** Fired once the merge has actually happened (not on a mere preview). */
  onMerged: () => void
}

export function MergeItemSheet({ survivor, rcId, onClose, onMerged }: MergeItemSheetProps) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<MergeHit[]>([])
  const [searching, setSearching] = useState(false)

  const [picked, setPicked] = useState<MergeHit | null>(null)
  const [preview, setPreview] = useState<DryRunResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const [onHand, setOnHand] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [result, setResult] = useState<ConfirmOk | null>(null)

  // A dry run is slow (8-13s measured). Guard against a stale response landing
  // after the user has gone Back and picked something else — bump reqId and
  // abort the in-flight fetch on every new pick / Back / unmount.
  const reqId = useRef(0)
  const inFlight = useRef<AbortController | null>(null)
  useEffect(() => () => inFlight.current?.abort(), [])

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); setSearching(false); return }
    setSearching(true)
    const t = setTimeout(() => {
      fetch(`/api/inventory/search?q=${encodeURIComponent(q)}&limit=12&withUsage=1`)
        .then(r => r.json())
        .then((rows: unknown) => setHits(Array.isArray(rows) ? (rows as MergeHit[]).filter(h => h.id !== survivor.id) : []))
        .catch(() => setHits([]))
        .finally(() => setSearching(false))
    }, 200)
    return () => clearTimeout(t)
  }, [q, survivor.id])

  async function pick(h: MergeHit) {
    inFlight.current?.abort()
    const myReq = ++reqId.current
    const controller = new AbortController()
    inFlight.current = controller

    setPicked(h)
    setPreview(null)
    setPreviewError(null)
    setOnHand('')
    setConfirmError(null)
    setResult(null)

    try {
      const r = await fetch(`/api/inventory/${survivor.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ absorbedId: h.id, dryRun: true }),
        signal: controller.signal,
      })
      if (reqId.current !== myReq) return // superseded — ignore
      const d = await r.json().catch(() => null)
      if (reqId.current !== myReq) return
      if (isDryRunOk(d) || isPlanFailure(d)) { setPreview(d); return }
      setPreviewError((d && typeof d === 'object' && 'error' in d ? String((d as { error: unknown }).error) : null) ?? 'Could not check this merge.')
    } catch (e) {
      if (reqId.current !== myReq) return
      if ((e as { name?: string } | null)?.name === 'AbortError') return
      setPreviewError('Could not check this merge.')
    }
  }

  function back() {
    inFlight.current?.abort()
    reqId.current++ // invalidate anything still in flight
    setPicked(null)
    setPreview(null)
    setPreviewError(null)
    setOnHand('')
    setConfirmError(null)
  }

  const needsOnHand = !!preview && !preview.ok && preview.guard === 'NEEDS_ON_HAND'
  const blocked = !!preview && !preview.ok && preview.guard !== 'NEEDS_ON_HAND'
  const onHandNum = onHand.trim() === '' ? null : Number(onHand)
  const onHandValid = onHandNum != null && Number.isFinite(onHandNum) && onHandNum >= 0
  const willUseOnHand = needsOnHand && onHandValid && !!rcId
  const canConfirm = !!picked && !busy && !!preview && (preview.ok || willUseOnHand)

  async function confirm() {
    if (!picked || busy || !canConfirm) return
    setBusy(true)
    setConfirmError(null)
    try {
      const body: Record<string, unknown> = { absorbedId: picked.id }
      if (willUseOnHand) body.combinedOnHand = { countedQty: onHandNum, selectedUom: survivor.countUnit, rcId }
      const r = await fetch(`/api/inventory/${survivor.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json().catch(() => null)
      setBusy(false)
      if (r.status === 409) {
        setConfirmError((d && d.error) || 'The item changed while merging — try again.')
        return // stay on the preview so they can retry
      }
      if (!r.ok || !d?.ok) {
        setConfirmError(d?.message ?? d?.error ?? 'The merge could not be completed.')
        return
      }
      setResult(d as ConfirmOk)
    } catch {
      setBusy(false)
      setConfirmError('The merge could not be completed.')
    }
  }

  function finish() {
    onMerged()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="fixed inset-0 z-40 bg-black/40" onClick={result ? finish : onClose} />
      <div className="relative z-50 bg-paper w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl p-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[15px] font-semibold text-ink flex items-center gap-2">
            <GitMerge size={16} /> Merge into {survivor.itemName}
          </h3>
          <button type="button" onClick={result ? finish : onClose} aria-label="Close"><X size={18} className="text-ink-3" /></button>
        </div>

        {!picked && (
          <>
            <label className="flex items-center gap-2 border border-line rounded-lg px-3 py-2">
              <Search size={14} className="text-ink-3" />
              <input
                autoFocus value={q} onChange={e => setQ(e.target.value)}
                placeholder="Find the duplicate item…"
                className="flex-1 outline-none text-[14px] bg-transparent text-ink"
              />
              {searching && <Loader2 size={14} className="text-ink-3 animate-spin" />}
            </label>
            {q.trim().length >= 2 && !searching && hits.length === 0 && (
              <p className="mt-3 text-[13px] text-ink-3">No matching items.</p>
            )}
            <ul className="mt-2 divide-y divide-line">
              {hits.map(h => {
                const mismatch = h.baseUnit !== survivor.baseUnit
                return (
                  <li key={h.id}>
                    <button type="button" onClick={() => pick(h)} className="w-full text-left py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[14px] text-ink">{h.itemName}</span>
                        {mismatch && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-red-text" title={`Tracked in ${h.baseUnit}, not ${survivor.baseUnit}`}>
                            <TriangleAlert size={11} /> {h.baseUnit}
                          </span>
                        )}
                      </div>
                      <div className="text-[12px] text-ink-3 font-mono">
                        {h.recipeCount} recipe{h.recipeCount === 1 ? '' : 's'} · {h.purchaseCount} purchase{h.purchaseCount === 1 ? '' : 's'} · {h.stockOnHand} {h.baseUnit} on hand
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        {picked && !result && (
          <>
            <button type="button" onClick={back} className="flex items-center gap-1 text-[12.5px] text-ink-3 mb-2">
              <ArrowLeft size={13} /> Back
            </button>
            <p className="text-[13px] text-ink-2 mb-3">
              <b className="text-ink">{picked.itemName}</b> will be folded into <b className="text-ink">{survivor.itemName}</b> and hidden.
              Its supplier, SKU and pack stay, as a supplier of this item.
            </p>

            {!preview && !previewError && (
              <div className="flex items-center gap-2 px-3 py-3 rounded-lg bg-bg-2 text-[13px] text-ink-2">
                <Loader2 size={15} className="animate-spin text-ink-3" />
                Checking what this merge would move — this can take up to 15 seconds…
              </div>
            )}

            {previewError && (
              <div className="rounded-lg px-3 py-2.5 text-[13px] bg-red-soft text-red-text">{previewError}</div>
            )}

            {preview?.ok && (
              <>
                <dl className="text-[13px] divide-y divide-line border border-line rounded-lg">
                  {mergeSummaryLines(preview.summary).map(row => (
                    <div key={row.label} className="flex justify-between px-3 py-2">
                      <dt className="text-ink-3">{row.label}</dt>
                      <dd className="text-ink font-mono">{row.value}</dd>
                    </div>
                  ))}
                </dl>
                {mergeNotes(preview.summary, preview.willDisableUndo).length > 0 && (
                  <ul className="mt-3 space-y-1.5">
                    {mergeNotes(preview.summary, preview.willDisableUndo).map((note, i) => (
                      <li key={i} className="text-[12.5px] text-ink-2 bg-blue-soft rounded-lg px-3 py-2">{note}</li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {blocked && preview && !preview.ok && (
              <div className="rounded-lg px-3 py-2.5 text-[13px] bg-red-soft text-red-text">{preview.message}</div>
            )}

            {needsOnHand && preview && !preview.ok && (
              <>
                <div className="rounded-lg px-3 py-2.5 text-[13px] bg-blue-soft text-ink-2">{preview.message}</div>
                <label className="block mt-3 text-[13px] text-ink-2">
                  Combined on hand ({survivor.countUnit})
                  {!rcId && <span className="text-red-text"> — pick a revenue center first</span>}
                  <input
                    type="number" min="0" step="any" inputMode="decimal"
                    value={onHand} onChange={e => setOnHand(e.target.value)}
                    className="mt-1 w-full border border-line rounded-lg px-3 py-2 text-[14px] text-ink bg-paper"
                  />
                </label>
                <p className="mt-2 text-[12.5px] text-ink-2 bg-blue-soft rounded-lg px-3 py-2">{UNDO_DISABLED_NOTE}</p>
              </>
            )}

            {confirmError && <p className="mt-3 text-[13px] text-red-text">{confirmError}</p>}

            <div className="mt-4 flex gap-2 justify-end">
              <button type="button" onClick={back} disabled={busy} className="px-3 py-2 text-[13px] text-ink-2 disabled:opacity-40">Back</button>
              {!blocked && (
                <button
                  type="button" disabled={!canConfirm} onClick={confirm}
                  className="px-3 py-2 rounded-lg bg-ink text-paper text-[13px] font-semibold disabled:opacity-40"
                >
                  {busy ? 'Merging…' : 'Merge items'}
                </button>
              )}
            </div>
          </>
        )}

        {result && (
          <>
            <p className="text-[13px] text-ink-2 mb-3">
              <b className="text-ink">{picked?.itemName}</b> is merged into <b className="text-ink">{survivor.itemName}</b>.
            </p>
            {result.warning && (
              <div className="rounded-lg px-3 py-2.5 text-[13px] bg-gold-soft text-gold-2 mb-3">{result.warning}</div>
            )}
            <dl className="text-[13px] divide-y divide-line border border-line rounded-lg">
              {mergeSummaryLines(result.summary).map(row => (
                <div key={row.label} className="flex justify-between px-3 py-2">
                  <dt className="text-ink-3">{row.label}</dt>
                  <dd className="text-ink font-mono">{row.value}</dd>
                </div>
              ))}
            </dl>
            {mergeNotes(result.summary, result.willDisableUndo).length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {mergeNotes(result.summary, result.willDisableUndo).map((note, i) => (
                  <li key={i} className="text-[12.5px] text-ink-2 bg-blue-soft rounded-lg px-3 py-2">{note}</li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={finish} className="px-3 py-2 rounded-lg bg-ink text-paper text-[13px] font-semibold">Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

interface MergedItemRow { id: string; absorbedName: string; canUndo: boolean; reason: string | null }

/** The "Merged: X · Undo" line(s) under an item's own drawer content — reads
 *  GET /api/inventory/:id/merge (merges still linked to THIS item as survivor). */
export function MergedItemsRow({ itemId, refreshKey, onChanged }: { itemId: string; refreshKey: number; onChanged: () => void }) {
  const [merges, setMerges] = useState<MergedItemRow[]>([])
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/inventory/${itemId}/merge`)
      .then(r => (r.ok ? r.json() : { merges: [] }))
      .then(d => setMerges(Array.isArray(d?.merges) ? d.merges : []))
      .catch(() => setMerges([]))
  }, [itemId, refreshKey])

  if (merges.length === 0) return null

  async function undo(id: string) {
    setErr(null)
    const r = await fetch(`/api/inventory/merges/${id}/undo`, { method: 'POST' })
    if (!r.ok) {
      const d = await r.json().catch(() => null)
      setErr(d?.error ?? 'Undo failed')
      return
    }
    setMerges(m => m.filter(x => x.id !== id))
    onChanged()
  }

  return (
    <div className="mt-3 text-[12.5px] text-ink-3 space-y-1">
      {merges.map(m => (
        <div key={m.id} className="flex items-center gap-2">
          <span>Merged: <span className="text-ink-2">{m.absorbedName}</span></span>
          {m.canUndo
            ? <button type="button" onClick={() => undo(m.id)} className="underline underline-offset-2 text-ink-2">Undo</button>
            : <span title={m.reason ?? ''}>· undo no longer safe</span>}
        </div>
      ))}
      {err && <p className="text-red-text">{err}</p>}
    </div>
  )
}
