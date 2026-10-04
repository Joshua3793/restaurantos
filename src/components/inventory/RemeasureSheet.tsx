// "Change how it's measured" in the item drawer (item backbone Stage 2c, Task 3).
// One sheet, two steps: pick the new measure (+ how much one piece weighs/holds,
// or the density) → preview what changes → Apply. The server
// (src/lib/remeasure-exec.ts + api/inventory/[id]/remeasure) does every bit of
// the work; this component only calls it and renders what it says. Same shell
// as MergeItemSheet. MANAGER+ only (the routes enforce it too).
'use client'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { X, Ruler, Loader2, ArrowRight, Star, TriangleAlert } from 'lucide-react'
import { useToast } from '@/components/Toast'
import { asChainItem, type Dimension } from '@/lib/item-model'
import { canonicalUom } from '@/lib/uom'
import { packLabel, priceLabel, type RemeasureSummary } from '@/lib/remeasure-plan'
import {
  measureWord, bridgePrompt, changeLines, appliedToast, changedAgo, defaultTargetUnit, TARGET_UNITS,
} from '@/lib/remeasure-copy'

export interface RemeasureItem {
  id: string
  itemName: string
  dimension: Dimension
  baseUnit: string
  packChain: unknown
  pricing: unknown
  countUnit?: string | null
  eachMeasureQty?: unknown
  eachMeasureUnit?: string | null
  densityGPerMl?: unknown
  /** The row version Apply names (a mismatch → STALE). */
  lastUpdated?: string | null
}

interface RemeasureSheetProps {
  item: RemeasureItem
  onClose: () => void
  /** Fired once the item has actually changed (`applied` — this user's own
   *  change), or someone else changed it first and it must be reloaded (`stale`). */
  onChanged: (why: 'applied' | 'stale') => void
}

const CHOICES: { dim: Dimension; label: string }[] = [
  { dim: 'MASS', label: 'Weight' },
  { dim: 'VOLUME', label: 'Volume' },
  { dim: 'COUNT', label: 'Pieces' },
]
type Refusal = { error: string; code?: string }

/** Exactly what "Show what changes" sent — Apply re-sends this object, never a
 *  rebuild from the inputs, so what lands is what was previewed. */
interface PreviewRequest {
  to: { dimension: Dimension; unit: string }
  bridge: { densityGPerMl: number } | { eachQty: number; eachUnit: string }
}

const errorOf = (d: unknown, fallback: string): Refusal => {
  const o = d as { error?: unknown; code?: unknown } | null
  return {
    error: o && typeof o.error === 'string' && o.error ? o.error : fallback,
    code: o && typeof o.code === 'string' ? o.code : undefined,
  }
}

/** The bridge the form starts from — the item's own, when its unit fits the prompt. */
function prefill(item: RemeasureItem, to: Dimension): { qty: string; unit: string } {
  const p = bridgePrompt(item.dimension, to)
  if (p.kind === 'density') {
    const d = Number(item.densityGPerMl)
    return { qty: d > 0 ? String(d) : '', unit: 'g' }
  }
  const q = Number(item.eachMeasureQty)
  const u = item.eachMeasureUnit ? canonicalUom(item.eachMeasureUnit) : ''
  return q > 0 && p.unitOptions.includes(u)
    ? { qty: String(q), unit: u }
    : { qty: '', unit: p.unitOptions[0] }
}

function BeforeAfter({ s }: { s: RemeasureSummary }) {
  const rows: [string, string, string][] = [
    ['Measured by', measureWord(s.from.dimension), measureWord(s.to.dimension)],
    ['Pack', s.from.packLabel, s.to.packLabel],
    ['Price', s.from.priceLabel, s.to.priceLabel],
    ['Counted in', s.from.countUnit, s.to.countUnit],
  ]
  return (
    <div className="rounded-xl border border-line bg-paper overflow-hidden text-[13px]">
      <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_auto_minmax(0,1fr)] gap-x-2 px-3 py-1.5 bg-bg-2 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4">
        <span /><span>Before</span><span /><span>After</span>
      </div>
      {rows.map(([label, before, after]) => (
        <div key={label} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_auto_minmax(0,1fr)] gap-x-2 items-start px-3 py-2 border-t border-line">
          <span className="text-ink-3">{label}</span>
          <span className="text-ink-2 break-words">{before}</span>
          <ArrowRight size={12} className="text-ink-4 mt-1" />
          <span className={`break-words ${before !== after ? 'text-ink font-medium' : 'text-ink-2'}`}>{after}</span>
        </div>
      ))}
    </div>
  )
}

function BoxList({ boxes }: { boxes: RemeasureSummary['boxes'] }) {
  if (boxes.length === 0) return null
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4 mb-1">Supplier boxes</div>
      <ul className="rounded-xl border border-line bg-paper divide-y divide-line text-[12.5px]">
        {boxes.map((b, i) => (
          <li key={i} className="px-3 py-2">
            <div className="flex items-center gap-1.5 text-ink font-medium">
              {b.supplierName}
              {b.isPrimary && <span className="inline-flex items-center gap-0.5 text-[11px] text-gold-2 font-normal"><Star size={11} /> main</span>}
            </div>
            <div className="text-ink-3 mt-0.5">{b.before} <ArrowRight size={11} className="inline -mt-0.5" /> <span className="text-ink-2">{b.after}</span></div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function RemeasureSheet({ item, onClose, onChanged }: RemeasureSheetProps) {
  const toast = useToast()
  const titleId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const today = useMemo(() => {
    const ci = asChainItem({
      dimension: item.dimension, baseUnit: item.baseUnit, packChain: item.packChain, pricing: item.pricing,
      countUnit: item.countUnit ?? undefined,
      eachMeasureQty: item.eachMeasureQty, eachMeasureUnit: item.eachMeasureUnit ?? null, densityGPerMl: item.densityGPerMl,
    })
    return `${measureWord(item.dimension)} · ${packLabel(ci)} · ${priceLabel(ci)}`
  }, [item])

  const [to, setTo] = useState<Dimension | null>(null)
  const [unit, setUnit] = useState('')
  /** The Unit select was picked by hand — it stops following the bridge unit. */
  const [unitTouched, setUnitTouched] = useState(false)
  const [bridgeQty, setBridgeQty] = useState('')
  const [bridgeUnit, setBridgeUnit] = useState('')

  /** The previewed plan: the request that produced it + the server's summary. */
  const [plan, setPlan] = useState<{ req: PreviewRequest; summary: RemeasureSummary } | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<Refusal | null>(null)
  const stale = applyError?.code === 'STALE'

  // A stale preview must never land after the choice changed; two clicks in one
  // tick must never apply twice; nothing closes the sheet while Apply runs.
  const reqId = useRef(0)
  const inFlight = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  useEffect(() => () => { inFlight.current?.abort() }, [])

  function tryClose() {
    if (submitting.current) return
    onClose()
  }
  const closeRef = useRef(tryClose)
  closeRef.current = tryClose

  // Escape closes (never while applying); focus starts on the first pickable card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeRef.current()
    }
    document.addEventListener('keydown', onKey, true)
    const root = rootRef.current
    const first = root?.querySelector<HTMLButtonElement>('button[data-measure-card]:not(:disabled)')
      ?? root?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    first?.focus()
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  const prompt = to ? bridgePrompt(item.dimension, to) : null
  const qtyNum = Number(bridgeQty)
  const bridgeOk = bridgeQty.trim() !== '' && Number.isFinite(qtyNum) && qtyNum > 0

  /** Any edit drops the previewed plan (and any check in flight) — Apply can
   *  never run against a preview of other inputs. */
  function invalidate() {
    inFlight.current?.abort()
    reqId.current++
    setPlan(null)
    setChecking(false)
    setCheckError(null)
    setApplyError(null)
  }

  function choose(d: Dimension) {
    if (d === item.dimension || checking) return
    invalidate()
    const p = prefill(item, d)
    setTo(d)
    setUnit(defaultTargetUnit(d, p.unit))
    setUnitTouched(false)
    setBridgeQty(p.qty)
    setBridgeUnit(p.unit)
  }

  function editUnit(u: string) {
    invalidate()
    setUnit(u)
    setUnitTouched(true)
  }

  function editBridgeQty(v: string) {
    invalidate()
    setBridgeQty(v)
  }

  function editBridgeUnit(u: string) {
    invalidate()
    setBridgeUnit(u)
    if (to && !unitTouched) setUnit(defaultTargetUnit(to, u))
  }

  function request(): PreviewRequest | null {
    if (!to || !prompt || !bridgeOk) return null
    return {
      to: { dimension: to, unit },
      bridge: prompt.kind === 'density' ? { densityGPerMl: qtyNum } : { eachQty: qtyNum, eachUnit: bridgeUnit },
    }
  }

  async function check() {
    const req = request()
    if (!req || checking) return
    inFlight.current?.abort()
    const myReq = ++reqId.current
    const controller = new AbortController()
    inFlight.current = controller
    setChecking(true)
    setCheckError(null)
    setPlan(null)
    try {
      const r = await fetch(`/api/inventory/${item.id}/remeasure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...req, apply: false }),
        signal: controller.signal,
      })
      const d = await r.json().catch(() => null)
      if (reqId.current !== myReq) return
      if (r.ok && d?.ok && d.plan?.summary) setPlan({ req, summary: d.plan.summary as RemeasureSummary })
      else setCheckError(errorOf(d, 'Could not check this change.').error)
    } catch (e) {
      if (reqId.current !== myReq) return
      if ((e as { name?: string } | null)?.name === 'AbortError') return
      setCheckError('Could not check this change.')
    } finally {
      if (reqId.current === myReq) setChecking(false)
    }
  }

  function back() {
    if (submitting.current) return
    invalidate()
  }

  async function apply() {
    if (!plan || stale || submitting.current) return
    const { req } = plan
    submitting.current = true
    setApplying(true)
    setApplyError(null)
    try {
      const r = await fetch(`/api/inventory/${item.id}/remeasure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...req, apply: true, expectedLastUpdated: item.lastUpdated ?? null }),
      })
      const d = await r.json().catch(() => null)
      if (!r.ok || !d?.ok) {
        setApplyError(errorOf(d, 'The measure change could not be completed. Nothing was changed.'))
        return
      }
      toast.show({ type: 'success', title: appliedToast(req.to.dimension) })
      onChanged('applied')
      onClose()
    } catch {
      setApplyError({ error: 'The measure change could not be completed. Nothing was changed.' })
    } finally {
      submitting.current = false
      setApplying(false)
    }
  }

  function reload() {
    if (submitting.current) return
    onChanged('stale')
    onClose()
  }

  const preview = plan?.summary ?? null
  const lines = preview ? changeLines(preview) : []
  const warnings = new Set(preview?.warnings ?? [])

  return (
    <div
      ref={rootRef}
      role="dialog" aria-modal="true" aria-labelledby={titleId}
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center"
    >
      <div className="fixed inset-0 z-40 bg-black/40" onClick={tryClose} />
      <div className="relative z-50 bg-bg w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl p-4 max-h-[88vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0">
            <h3 id={titleId} className="text-[15px] font-semibold text-ink flex items-center gap-2 min-w-0">
              <Ruler size={16} className="shrink-0" />
              <span className="truncate">Change how {item.itemName} is measured</span>
            </h3>
            <p className="mt-0.5 text-[12.5px] text-ink-3">Today: {today}</p>
          </div>
          <button type="button" onClick={tryClose} disabled={applying} aria-label="Close" className="shrink-0 disabled:opacity-40"><X size={18} className="text-ink-3" /></button>
        </div>

        {!preview && (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4 mb-1.5">Measure it by</div>
            <div className="grid grid-cols-3 gap-2">
              {CHOICES.map(c => {
                const current = c.dim === item.dimension
                const on = c.dim === to
                return (
                  <button
                    key={c.dim} type="button" data-measure-card disabled={current || checking} aria-pressed={on} onClick={() => choose(c.dim)}
                    className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                      current ? 'border-line bg-bg-2 text-ink-4 cursor-not-allowed'
                      : on ? 'border-ink bg-paper text-ink' : 'border-line bg-paper text-ink-2 hover:border-ink-3'}${
                      checking && !current ? ' opacity-60' : ''}`}
                  >
                    <div className="text-[14px] font-medium">{c.label}</div>
                    {current && <div className="text-[11px] mt-0.5">current</div>}
                  </button>
                )
              })}
            </div>

            {to && prompt && (
              <div className="mt-3 space-y-3 rounded-xl border border-line bg-paper p-3">
                {to !== 'COUNT' && (
                  <label className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-ink-2">Unit</span>
                    <select
                      value={unit} onChange={e => editUnit(e.target.value)} disabled={checking}
                      className="border border-line rounded-lg px-2 py-1.5 text-[13px] bg-paper text-ink disabled:opacity-60"
                    >
                      {TARGET_UNITS[to].map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </label>
                )}
                <div className="flex items-center justify-between gap-3 text-[13px]">
                  <span className="text-ink-2">{prompt.label}</span>
                  <span className="flex items-center gap-1.5">
                    <input
                      type="number" min="0" step="any" inputMode="decimal"
                      value={bridgeQty} onChange={e => editBridgeQty(e.target.value)} disabled={checking}
                      placeholder="0" aria-label={prompt.label}
                      className="w-24 border border-line rounded-lg px-2 py-1.5 text-[14px] font-mono text-ink bg-paper disabled:opacity-60"
                    />
                    {prompt.unitOptions.length > 1 ? (
                      <select
                        value={bridgeUnit} onChange={e => editBridgeUnit(e.target.value)} disabled={checking}
                        aria-label="Unit"
                        className="border border-line rounded-lg px-2 py-1.5 text-[13px] bg-paper text-ink disabled:opacity-60"
                      >
                        {prompt.unitOptions.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    ) : prompt.kind === 'each' ? (
                      <span className="text-ink-3">{prompt.unitOptions[0]}</span>
                    ) : null}
                  </span>
                </div>
              </div>
            )}

            {checkError && (
              <div className="mt-3 rounded-lg px-3 py-2.5 text-[13px] bg-red-soft text-red-text">{checkError}</div>
            )}

            <div className="sticky bottom-0 -mx-4 -mb-4 mt-4 px-4 py-3 bg-bg border-t border-line flex gap-2 justify-end">
              <button type="button" onClick={tryClose} className="px-3 py-2 text-[13px] text-ink-2">Cancel</button>
              <button
                type="button" disabled={!to || !bridgeOk || checking} onClick={check}
                className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-semibold disabled:opacity-40 inline-flex items-center gap-1.5"
              >
                {checking && <Loader2 size={13} className="animate-spin" />}
                {checking ? 'Checking…' : 'Show what changes'}
              </button>
            </div>
          </>
        )}

        {preview && (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4 mb-1.5">What changes</div>
            <BeforeAfter s={preview} />
            <div className="mt-3"><BoxList boxes={preview.boxes} /></div>
            <ul className="mt-3 space-y-1.5">
              {lines.map((line, i) => (
                warnings.has(line) ? (
                  <li key={i} className="flex items-start gap-1.5 text-[12.5px] text-gold-2 bg-gold-soft rounded-lg px-3 py-2">
                    <TriangleAlert size={13} className="shrink-0 mt-0.5" /> {line}
                  </li>
                ) : (
                  <li key={i} className="flex items-start gap-1.5 text-[12.5px] text-ink-2"><span className="text-ink-4">•</span>{line}</li>
                )
              ))}
            </ul>

            {applyError && (
              <div role="alert" className="mt-3 rounded-lg px-3 py-2.5 text-[13px] bg-red-soft text-red-text">{applyError.error}</div>
            )}

            <div className="sticky bottom-0 -mx-4 -mb-4 mt-4 px-4 py-3 bg-bg border-t border-line flex gap-2 justify-end">
              <button type="button" onClick={back} disabled={applying} className="px-3 py-2 text-[13px] text-ink-2 disabled:opacity-40">Back</button>
              {stale ? (
                <button type="button" onClick={reload} className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-semibold">
                  Reload
                </button>
              ) : (
                <button
                  type="button" disabled={applying} onClick={apply}
                  className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-semibold disabled:opacity-40 inline-flex items-center gap-1.5"
                >
                  {applying && <Loader2 size={13} className="animate-spin" />}
                  {applying ? 'Applying…' : 'Apply'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

interface RemeasureChangeRow {
  id: string
  changedAt: string
  to: { dimension: Dimension; unit: string }
  canUndo: boolean
  reason: string | null
}

/** The "Measure changed to weight · 5 min ago · Undo" line(s) under the item's
 *  drawer content — reads GET /api/inventory/:id/remeasure (changes not undone). */
export function RemeasuredRow({ itemId, refreshKey, onChanged }: { itemId: string; refreshKey: number; onChanged: () => void }) {
  const [changes, setChanges] = useState<RemeasureChangeRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  /** Bumped after a refused undo — the list is re-read so a change that can no
   *  longer be undone loses its Undo and shows why. */
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let alive = true
    fetch(`/api/inventory/${itemId}/remeasure`)
      .then(r => (r.ok ? r.json() : { changes: [] }))
      .then(d => { if (alive) setChanges(Array.isArray(d?.changes) ? d.changes : []) })
      .catch(() => { if (alive) setChanges([]) })
    return () => { alive = false }
  }, [itemId, refreshKey, reloadTick])

  if (changes.length === 0 && !err) return null

  async function undo(id: string) {
    if (busyId) return
    setErr(null)
    setBusyId(id)
    try {
      const r = await fetch(`/api/inventory/remeasures/${id}/undo`, { method: 'POST' })
      if (!r.ok) {
        const d = await r.json().catch(() => null)
        setErr(errorOf(d, 'The undo could not be completed. Nothing was changed.').error)
        setReloadTick(t => t + 1)
        return
      }
      setChanges(c => c.filter(x => x.id !== id))
      onChanged()
    } catch {
      setErr('The undo could not be completed. Nothing was changed.')
      setReloadTick(t => t + 1)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="mt-3 text-[12.5px] text-ink-3 space-y-1">
      {changes.map(c => {
        const ago = changedAgo(c.changedAt)
        return (
          <div key={c.id}>
            <div className="flex items-center gap-2 flex-wrap">
              <span>Measure changed to <span className="text-ink-2">{measureWord(c.to.dimension)}</span>{ago && ` · ${ago}`}</span>
              {c.canUndo
                ? (
                  <button type="button" onClick={() => undo(c.id)} disabled={!!busyId} className="underline underline-offset-2 text-ink-2 disabled:opacity-40 inline-flex items-center gap-1">
                    {busyId === c.id && <Loader2 size={11} className="animate-spin" />}Undo
                  </button>
                )
                : <span>· undo no longer safe</span>}
            </div>
            {!c.canUndo && c.reason && <p className="text-[11.5px] text-ink-4">{c.reason}</p>}
          </div>
        )
      })}
      {err && <p className="text-red-text">{err}</p>}
    </div>
  )
}
