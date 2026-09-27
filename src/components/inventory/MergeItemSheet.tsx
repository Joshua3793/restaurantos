// Merge UI in the item drawer (item-consolidation Task 10). One sheet, three
// states: pick the duplicate → preview the server's dry-run plan → done.
// The server (src/lib/item-merge.ts + api/inventory/[id]/merge) does every
// bit of the actual work; this component only calls it and renders what it
// says. See .superpowers/sdd/item-consolidation/task-10-{brief,addendum}.md.
//
// ONE dry run per pick. When the plan needs a combined on-hand, the server
// plans it a second time with one in the same response (`withOnHand`), so the
// preview is on screen before anyone types and Merge enables as soon as the
// figure is valid. The combined on-hand is entered as one or more
// (qty, unit) rows over the survivor's own countable units — "2 case + 5 each"
// — and sent in the row's unit when there is one row, else summed to base.
'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Search, GitMerge, Loader2, ArrowLeft, TriangleAlert, Plus, Trash2, ArrowDown } from 'lucide-react'
import type { MergeGuard, MergeSummary } from '@/lib/item-merge'
import { mergeSummaryLines, mergeNotes, UNDO_DISABLED_NOTE } from '@/lib/item-merge-copy'
import {
  getCountableUoms, resolveCountUom, countUomFactor, convertBaseToCountUom, type ItemDims,
} from '@/lib/count-uom'

export interface MergeHit {
  id: string; itemName: string; baseUnit: string
  recipeCount: number; purchaseCount: number; stockOnHand: number
}

type PlanFailure = { ok: false; guard: MergeGuard; message: string; withOnHand?: { summary: MergeSummary } }
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

export interface MergeSurvivor {
  id: string; itemName: string; baseUnit: string
  dimension?: string | null; packChain?: unknown; countUnit?: string | null
  eachMeasureQty?: unknown; eachMeasureUnit?: string | null
}

interface OnHandRow { key: number; qty: string; unit: string }

interface MergeItemSheetProps {
  survivor: MergeSurvivor
  rcId: string | null
  rcName?: string | null
  onClose: () => void
  /** Fired once the merge has actually happened (not on a mere preview). */
  onMerged: () => void
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(n >= 10 ? 1 : 2).replace(/\.?0+$/, ''))

function SummaryList({ summary, willDisableUndo }: { summary: MergeSummary; willDisableUndo: boolean }) {
  const notes = mergeNotes(summary, willDisableUndo)
  return (
    <>
      <dl className="text-[13px] divide-y divide-line border border-line rounded-lg bg-paper">
        {mergeSummaryLines(summary).map(row => (
          <div key={row.label} className="flex justify-between px-3 py-2">
            <dt className="text-ink-3">{row.label}</dt>
            <dd className="text-ink font-mono">{row.value}</dd>
          </div>
        ))}
      </dl>
      {notes.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {notes.map((note, i) => (
            <li key={i} className="text-[12.5px] text-ink-2 bg-blue-soft rounded-lg px-3 py-2">{note}</li>
          ))}
        </ul>
      )}
    </>
  )
}

/** "Keep X ← fold in Y" — the one picture of what a merge does. */
function MergePair({ keep, fold }: { keep: string; fold: string }) {
  return (
    <div className="rounded-xl border border-line bg-paper overflow-hidden text-[13px]">
      <div className="px-3 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4">Goes away</div>
        <div className="text-ink font-medium">{fold}</div>
      </div>
      <div className="flex items-center gap-2 px-3 py-1 bg-bg-2 text-[11.5px] text-ink-3">
        <ArrowDown size={12} /> invoices, recipes, counts and its supplier move into
      </div>
      <div className="px-3 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4">Stays</div>
        <div className="text-ink font-medium">{keep}</div>
      </div>
    </div>
  )
}

export function MergeItemSheet({ survivor, rcId, rcName, onClose, onMerged }: MergeItemSheetProps) {
  const dims: ItemDims = useMemo(() => ({
    dimension: survivor.dimension ?? 'COUNT',
    baseUnit: survivor.baseUnit,
    packChain: survivor.packChain ?? [],
    countUnit: survivor.countUnit ?? null,
    eachMeasureQty: survivor.eachMeasureQty,
    eachMeasureUnit: survivor.eachMeasureUnit ?? null,
  }), [survivor])
  const uoms = useMemo(() => getCountableUoms(dims), [dims])
  const unitLabels = useMemo(() => {
    const labels = uoms.map(u => u.label)
    return labels.includes(survivor.baseUnit) ? labels : [...labels, survivor.baseUnit]
  }, [uoms, survivor.baseUnit])
  const unitDisplay = (lbl: string) => uoms.find(u => u.label === lbl)?.display ?? lbl
  const defaultUnit = useMemo(() => {
    const u = resolveCountUom(dims)
    return unitLabels.includes(u) ? u : survivor.baseUnit
  }, [dims, unitLabels, survivor.baseUnit])

  // Opens already searching on this item's own name, so the likely duplicates
  // are listed before anyone types. The text is selected, so typing replaces it.
  const [q, setQ] = useState(survivor.itemName)
  const [hits, setHits] = useState<MergeHit[]>([])
  const [searching, setSearching] = useState(false)

  const [picked, setPicked] = useState<MergeHit | null>(null)
  const [preview, setPreview] = useState<DryRunResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const rowKey = useRef(0)
  const newRow = (unit: string): OnHandRow => ({ key: ++rowKey.current, qty: '', unit })
  const [rows, setRows] = useState<OnHandRow[]>(() => [newRow(defaultUnit)])
  const [busy, setBusy] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [result, setResult] = useState<ConfirmOk | null>(null)

  // A dry run reads the stock ledger (several seconds). Guard against a stale
  // response landing after the user has gone Back and picked something else —
  // bump the req id and abort the in-flight fetch on every new pick / Back /
  // unmount. The search box gets its own pair: fast typing must never paint an
  // older query's results.
  const reqId = useRef(0)
  const inFlight = useRef<AbortController | null>(null)
  // State is read from the render closure, so two clicks in one tick both pass a
  // `busy` check. The ref flips synchronously.
  const submitting = useRef(false)
  const searchReqId = useRef(0)
  const searchInFlight = useRef<AbortController | null>(null)
  useEffect(() => () => {
    inFlight.current?.abort()
    searchInFlight.current?.abort()
  }, [])

  useEffect(() => {
    if (q.trim().length < 2) {
      searchInFlight.current?.abort()
      searchReqId.current++          // invalidate anything still in flight
      setHits([]); setSearching(false); return
    }
    setSearching(true)
    const t = setTimeout(() => {
      searchInFlight.current?.abort()
      const myReq = ++searchReqId.current
      const controller = new AbortController()
      searchInFlight.current = controller
      fetch(`/api/inventory/search?q=${encodeURIComponent(q)}&limit=12&withUsage=1`, { signal: controller.signal })
        .then(r => r.json())
        .then((rows: unknown) => {
          if (searchReqId.current !== myReq) return // superseded — ignore
          setHits(Array.isArray(rows) ? (rows as MergeHit[]).filter(h => h.id !== survivor.id) : [])
        })
        .catch(() => { if (searchReqId.current === myReq) setHits([]) })
        .finally(() => { if (searchReqId.current === myReq) setSearching(false) })
    }, 200)
    return () => clearTimeout(t)
  }, [q, survivor.id])

  function resetEntry() {
    setRows([newRow(defaultUnit)])
    setConfirmError(null)
  }

  async function pick(h: MergeHit) {
    inFlight.current?.abort()
    const myReq = ++reqId.current
    const controller = new AbortController()
    inFlight.current = controller

    setPicked(h)
    setPreview(null)
    setPreviewError(null)
    setResult(null)
    resetEntry()

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
    resetEntry()
  }

  const needsOnHand = !!preview && !preview.ok && preview.guard === 'NEEDS_ON_HAND'
  const blocked = !!preview && !preview.ok && preview.guard !== 'NEEDS_ON_HAND'
  const onHandSummary = needsOnHand && preview && !preview.ok ? preview.withOnHand?.summary ?? null : null

  // Every row must be a real, non-negative number in a unit this item can be
  // counted in (the same strict resolver the count write path uses). Blank rows
  // are ignored unless every row is blank.
  const filled = rows.filter(r => r.qty.trim() !== '')
  const parsed = filled.map(r => ({ ...r, n: Number(r.qty), factor: countUomFactor(r.unit, dims) }))
  const entryValid = parsed.length > 0 && parsed.every(r => Number.isFinite(r.n) && r.n >= 0 && r.factor != null)
  const totalBase = entryValid ? parsed.reduce((s, r) => s + r.n * (r.factor as number), 0) : null
  // One row → send it in its own unit (the count reads "3 case"). Several →
  // send the base total, which every item can always be counted in.
  const combinedOnHand = entryValid && rcId
    ? (parsed.length === 1
        ? { countedQty: parsed[0].n, selectedUom: parsed[0].unit, rcId }
        : { countedQty: totalBase as number, selectedUom: survivor.baseUnit, rcId })
    : null

  const canConfirm = !!picked && !busy && !!preview
    && (preview.ok || (needsOnHand && !!onHandSummary && !!combinedOnHand))

  async function confirm() {
    if (!picked || busy || !canConfirm || submitting.current) return
    submitting.current = true
    setBusy(true)
    setConfirmError(null)
    try {
      const body: Record<string, unknown> = { absorbedId: picked.id }
      if (needsOnHand && combinedOnHand) body.combinedOnHand = combinedOnHand
      const r = await fetch(`/api/inventory/${survivor.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json().catch(() => null)
      submitting.current = false
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
      submitting.current = false
      setBusy(false)
      setConfirmError('The merge could not be completed.')
    }
  }

  function finish() {
    onMerged()
    onClose()
  }

  const setRow = (key: number, patch: Partial<OnHandRow>) =>
    setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)))

  // What the app currently thinks both items hold (all revenue centers), shown
  // in the first row's unit as a reference — never pre-filled, because the
  // figure being entered is a count for ONE revenue center.
  const hintUnit = rows[0]?.unit ?? defaultUnit
  const inUnit = (base: number) => fmt(convertBaseToCountUom(base, hintUnit, dims))

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center">
      <div className="fixed inset-0 z-40 bg-black/40" onClick={result ? finish : onClose} />
      <div className="relative z-50 bg-bg w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl p-4 max-h-[88vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[15px] font-semibold text-ink flex items-center gap-2 min-w-0">
            <GitMerge size={16} className="shrink-0" />
            <span className="truncate">{picked ? 'Merge items' : `Find a duplicate of ${survivor.itemName}`}</span>
          </h3>
          <button type="button" onClick={result ? finish : onClose} aria-label="Close" className="shrink-0"><X size={18} className="text-ink-3" /></button>
        </div>

        {!picked && (
          <>
            <label className="flex items-center gap-2 border border-line rounded-lg px-3 py-2.5 bg-paper">
              <Search size={14} className="text-ink-3" />
              <input
                autoFocus value={q} onChange={e => setQ(e.target.value)}
                onFocus={e => e.currentTarget.select()}
                placeholder="Search for the duplicate item…"
                className="flex-1 outline-none text-[14px] bg-transparent text-ink"
              />
              {searching && <Loader2 size={14} className="text-ink-3 animate-spin" />}
              {q && !searching && (
                <button type="button" onClick={() => setQ('')} aria-label="Clear search"><X size={14} className="text-ink-3" /></button>
              )}
            </label>
            <p className="mt-2 text-[12px] text-ink-3">
              Tap the item that is the same product. It folds into <b className="text-ink-2">{survivor.itemName}</b>.
            </p>
            {q.trim().length >= 2 && !searching && hits.length === 0 && (
              <p className="mt-3 text-[13px] text-ink-3">No matching items. Try a shorter word.</p>
            )}
            <ul className="mt-2 space-y-1.5">
              {hits.map(h => {
                const mismatch = h.baseUnit !== survivor.baseUnit
                return (
                  <li key={h.id}>
                    <button
                      type="button" onClick={() => pick(h)}
                      className="w-full text-left px-3 py-2.5 rounded-lg border border-line bg-paper hover:border-ink-3 active:bg-bg-2 transition-colors"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-[14px] text-ink font-medium">{h.itemName}</span>
                        {mismatch && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-red-text" title={`Tracked in ${h.baseUnit}, not ${survivor.baseUnit}`}>
                            <TriangleAlert size={11} /> {h.baseUnit}
                          </span>
                        )}
                      </div>
                      <div className="text-[12px] text-ink-3 font-mono">
                        {h.recipeCount} recipe{h.recipeCount === 1 ? '' : 's'} · {h.purchaseCount} purchase{h.purchaseCount === 1 ? '' : 's'}
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
              <ArrowLeft size={13} /> Pick a different item
            </button>
            <MergePair keep={survivor.itemName} fold={picked.itemName} />

            {!preview && !previewError && (
              <div className="mt-3 flex items-center gap-2 px-3 py-3 rounded-lg bg-bg-2 text-[13px] text-ink-2">
                <Loader2 size={15} className="animate-spin text-ink-3" />
                Checking stock and history for both items…
              </div>
            )}

            {previewError && (
              <div className="mt-3 rounded-lg px-3 py-2.5 text-[13px] bg-red-soft text-red-text">{previewError}</div>
            )}

            {preview?.ok && (
              <div className="mt-3"><SummaryList summary={preview.summary} willDisableUndo={preview.willDisableUndo} /></div>
            )}

            {blocked && preview && !preview.ok && (
              <div className="mt-3 rounded-lg px-3 py-2.5 text-[13px] bg-red-soft text-red-text">{preview.message}</div>
            )}

            {needsOnHand && preview && !preview.ok && (
              <>
                <div className="mt-3 rounded-xl border border-line bg-paper p-3">
                  <div className="text-[13.5px] font-semibold text-ink">How much is on hand, both together?</div>
                  <p className="text-[12.5px] text-ink-3 mt-0.5">
                    {preview.message}
                    {rcName ? <> Counted for <b className="text-ink-2">{rcName}</b>.</> : null}
                  </p>
                  {!rcId && <p className="mt-2 text-[12.5px] text-red-text">Pick a revenue center at the top of the app first.</p>}

                  <div className="mt-3 space-y-2">
                    {rows.map((row, i) => (
                      <div key={row.key}>
                        <div className="flex items-center gap-2">
                          {i > 0 && <span className="text-[13px] text-ink-3 w-3 text-center">+</span>}
                          <input
                            type="number" min="0" step="any" inputMode="decimal"
                            autoFocus={i === rows.length - 1 && i > 0}
                            value={row.qty} onChange={e => setRow(row.key, { qty: e.target.value })}
                            placeholder="0"
                            aria-label={`Quantity in ${row.unit}`}
                            className="w-24 border border-line rounded-lg px-3 py-2 text-[15px] font-mono text-ink bg-paper"
                          />
                          <span className="flex-1 text-[13px] text-ink-2 truncate">{unitDisplay(row.unit)}</span>
                          {rows.length > 1 && (
                            <button type="button" onClick={() => setRows(rs => rs.filter(r => r.key !== row.key))} aria-label="Remove this line" className="p-1.5 text-ink-3">
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                        {unitLabels.length > 1 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {unitLabels.map(label => (
                              <button
                                key={label} type="button" onClick={() => setRow(row.key, { unit: label })}
                                className={`px-2.5 py-1 rounded-full text-[12px] border transition-colors ${row.unit === label ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'}`}
                              >
                                {unitDisplay(label)}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {unitLabels.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setRows(rs => [...rs, newRow(unitLabels.find(u => !rs.some(r => r.unit === u)) ?? survivor.baseUnit)])}
                      className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-2"
                    >
                      <Plus size={13} /> Add another unit (e.g. cases + singles)
                    </button>
                  )}

                  {parsed.length > 1 && totalBase != null && (
                    <p className="mt-2 text-[12.5px] text-ink-2">Total: <b className="font-mono">{fmt(totalBase)} {survivor.baseUnit}</b></p>
                  )}
                  {filled.length > 0 && !entryValid && (
                    <p className="mt-2 text-[12.5px] text-red-text">Enter a number of 0 or more.</p>
                  )}

                  {onHandSummary && (
                    <p className="mt-3 text-[12px] text-ink-3">
                      The app currently thinks: {inUnit(onHandSummary.survivorOnHand)} + {inUnit(onHandSummary.absorbedOnHand)} {hintUnit}
                      {' '}(all revenue centers). Enter what is really there.
                    </p>
                  )}
                </div>

                <p className="mt-2 text-[12px] text-ink-3">{UNDO_DISABLED_NOTE}</p>

                {onHandSummary && (
                  <div className="mt-3"><SummaryList summary={onHandSummary} willDisableUndo={false} /></div>
                )}
              </>
            )}

            {confirmError && <p className="mt-3 text-[13px] text-red-text">{confirmError}</p>}

            <div className="sticky bottom-0 -mx-4 -mb-4 mt-4 px-4 py-3 bg-bg border-t border-line flex gap-2 justify-end">
              <button type="button" onClick={back} disabled={busy} className="px-3 py-2 text-[13px] text-ink-2 disabled:opacity-40">Back</button>
              {!blocked && (
                <button
                  type="button" disabled={!canConfirm} onClick={confirm}
                  className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-semibold disabled:opacity-40 inline-flex items-center gap-1.5"
                >
                  {busy && <Loader2 size={13} className="animate-spin" />}
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
            <SummaryList summary={result.summary} willDisableUndo={result.willDisableUndo} />
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
