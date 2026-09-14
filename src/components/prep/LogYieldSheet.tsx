'use client'
/**
 * LogYieldSheet — the ONE place a cook says how much they made.
 *
 * Opened from a Working On row's Done, the item drawer's Done and the board
 * drawer's Done (the host passes the drawer's cook-along yield when the cook set
 * one). One value, the unit amount that becomes PrepLog.actualPrepQty, shown two
 * ways that stay in sync: a 0–10 quarter-step batch slider with a ± stepper, and
 * the unit field. Typing a unit amount leaves the value exact (the readout says
 * "×1.13") and parks the thumb at the nearest quarter; the next slider or ± touch
 * snaps back onto the grid. The button previews the Done/Partial outcome.
 *
 * Every number comes from src/lib/prep-yield.ts and prep-plan.ts — this file only
 * renders. Design: docs/superpowers/specs/2026-09-13-log-yield-sheet-design.md
 */
import { useEffect, useRef, useState } from 'react'
import { IcCheck, IcX } from '@/components/prep/icons'
import type { PrepItemRich } from '@/components/prep/types'
import { batchYield, batchCount, batchesToQty } from '@/lib/prep-plan'
import { fmtQty } from '@/lib/prep-runsheet'
import {
  BATCH_MAX, BATCH_STEP, fmtBatches, isCompleteStatus, plannedQty, round2, snapBatches, stepBatches,
  yieldPrefill, yieldStatus, yieldWarning, type YieldStatus,
} from '@/lib/prep-yield'

export interface YieldTarget {
  item: PrepItemRich
  /** The drawer's upscale-slider yield when the cook changed it (PrepLog.progress.makeQty); null otherwise. */
  cookAlongQty: number | null
}

interface Props {
  target: YieldTarget | null
  onClose: () => void
  onConfirm: (item: PrepItemRich, qty: number, status: YieldStatus) => void
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.005
/** Text for the unit field: up to 2 decimals, no trailing zeros, '' for zero. */
const qtyText = (q: number) => (q > 0 ? String(round2(q)) : '')

// ── module-scope pieces (never define these inside the component: they would remount) ──

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-8 px-3 rounded-[10px] border font-mono text-[10.5px] font-bold uppercase tracking-[0.04em] whitespace-nowrap ${
        active ? 'bg-ink text-gold border-ink' : 'bg-transparent text-ink-3 border-line'
      }`}
    >
      {label}
    </button>
  )
}

function StepButton({ label, onClick, disabled }: { label: '−' | '+'; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label === '−' ? 'Quarter batch less' : 'Quarter batch more'}
      disabled={disabled}
      onClick={onClick}
      className={`w-10 h-10 rounded-[10px] bg-bg-2 border border-line grid place-items-center text-[18px] font-mono leading-none ${
        disabled ? 'text-ink-4 cursor-not-allowed' : 'text-ink-2'
      }`}
    >
      {label}
    </button>
  )
}

export default function LogYieldSheet({ target, onClose, onConfirm }: Props) {
  const item = target?.item ?? null
  const [qty, setQty] = useState(0)
  const [text, setText] = useState('')
  const unitRef = useRef<HTMLInputElement>(null)
  const sliderRef = useRef<HTMLInputElement>(null)

  // Prefill each time a new target opens the sheet.
  useEffect(() => {
    if (!target) return
    const q = yieldPrefill(target.item, target.cookAlongQty)
    setQty(q)
    setText(qtyText(q))
    // Batch items start on the slider; unit-only items in the field.
    const t = setTimeout(() => (batchYield(target.item) != null ? sliderRef : unitRef).current?.focus(), 0)
    return () => clearTimeout(t)
  }, [target?.item.id, target?.cookAlongQty])

  // Escape closes.
  useEffect(() => {
    if (!target) return
    // Capture phase + stopPropagation: the drawers under the sheet listen for Escape
    // on document too, and one press must close only the sheet.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [target, onClose])

  if (!item) return null

  const q = round2(qty)                           // the rounded view; qty (raw typed state) stays the source
  const perBatch = batchYield(item)              // unit amount of one batch, null = batches don't apply
  const hasBatch = perBatch != null
  const batches = hasBatch ? (batchCount(item, q) ?? 0) : 0
  const thumb = hasBatch ? snapBatches(batches) : 0
  const planned = plannedQty(item)
  const status = yieldStatus(q, planned)
  const warning = yieldWarning(q, item)
  const reopening = isCompleteStatus(item.todayLog?.status)
  const canSubmit = q > 0 && !warning

  // ONE setter for the batch view: value in batches → unit amount.
  const setBatches = (n: number) => {
    const q = batchesToQty(item, n)
    setQty(q)
    setText(qtyText(q))
  }
  // ONE setter for the unit view: keep the raw text so "4." can be typed.
  const onUnitChange = (raw: string) => {
    setText(raw)
    const v = parseFloat(raw)
    setQty(Number.isFinite(v) && v > 0 ? v : 0)
  }
  const setUnit = (q: number) => { setQty(q); setText(qtyText(q)) }

  const submit = () => { if (canSubmit) onConfirm(item, q, status) }

  const onSliderKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Shift+arrow = a whole batch; plain arrows, Home and End are native to the range input.
    if (!e.shiftKey) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setBatches(snapBatches(thumb + 1)) }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setBatches(snapBatches(thumb - 1)) }
  }

  const pct = (thumb / BATCH_MAX) * 100
  const plannedLabel = hasBatch && planned > 0
    ? `Planned ${fmtBatches(batchCount(item, planned) ?? 0)} batch · ${fmtQty(planned, item.unit)}`
    : planned > 0 ? `Planned ${fmtQty(planned, item.unit)}` : 'No planned amount'
  const verb = reopening ? 'Update' : 'Log'
  const outcome = q <= 0
    ? 'Enter how much you made'
    : warning ? 'Check the amount before logging'
    : status === 'DONE' ? 'Records Done · at or above plan' : 'Records Partial · below plan'

  return (
    // z-[90]: above BOTH drawers (mobile aside z-50, desktop .pb-drawer z-81) — same as the sub-recipe peek.
    <div className="fixed inset-0 z-[90] flex items-end md:items-center md:justify-center md:p-6">
      {/* Plain dim scrim — NO backdrop-blur (documented freeze on weaker laptops). */}
      <div onClick={onClose} className="fixed inset-0 z-40 bg-[rgba(9,9,11,0.6)]" aria-hidden="true" />
      <div
        role="dialog"
        aria-label="Log yield"
        aria-modal="true"
        className="relative z-50 bg-paper w-full rounded-t-2xl border-t border-line px-[22px] pt-4 shadow-2xl md:w-[440px] md:rounded-2xl md:border md:pb-5"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 18px)' }}
      >
        {/* header */}
        <div className="flex items-start gap-3 mb-4">
          <span className="w-8 h-8 rounded-[9px] bg-green text-white grid place-items-center shrink-0">
            <IcCheck size={16} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-semibold tracking-[-0.02em] leading-tight truncate">{item.name}</div>
            <div className="font-mono text-[11px] text-ink-3 mt-0.5">{plannedLabel}</div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="w-8 h-8 rounded-lg border border-line grid place-items-center text-ink-2 shrink-0"
          >
            <IcX size={15} />
          </button>
        </div>

        {/* batch row — only when one batch means something in this unit */}
        {hasBatch && (
          <div className="mb-4">
            <div className="flex items-center gap-3">
              <StepButton label="−" disabled={thumb <= 0 && batches <= 0} onClick={() => setBatches(stepBatches(batches, -1))} />
              <div className="flex-1 flex items-baseline justify-center gap-1.5">
                <span className="font-mono text-[28px] font-semibold tracking-[-0.02em] text-ink leading-none">{fmtBatches(batches)}</span>
                <span className="font-mono text-[11px] text-ink-3">batch</span>
              </div>
              <StepButton label="+" disabled={batches >= BATCH_MAX} onClick={() => setBatches(stepBatches(batches, 1))} />
            </div>
            <div className="relative mt-2 h-11 flex items-center">
              <input
                ref={sliderRef}
                type="range"
                min={0}
                max={BATCH_MAX}
                step={BATCH_STEP}
                value={thumb}
                aria-label="Batches made"
                aria-valuetext={`${fmtBatches(batches)} batch · ${qtyText(q)} ${item.unit}`}
                onChange={(e) => setBatches(snapBatches(parseFloat(e.target.value)))}
                onKeyDown={onSliderKey}
                style={{ background: `linear-gradient(to right, var(--gold-hex) ${pct}%, var(--bg-2) ${pct}%)` }}
                className="w-full h-2 rounded-full appearance-none outline-none cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-ink [&::-webkit-slider-thumb]:border-[3px] [&::-webkit-slider-thumb]:border-paper [&::-webkit-slider-thumb]:shadow-md
                  [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-ink [&::-moz-range-thumb]:border-[3px] [&::-moz-range-thumb]:border-paper
                  focus-visible:ring-2 focus-visible:ring-offset-2"
              />
            </div>
            <div className="flex justify-between font-mono text-[9.5px] text-ink-4 -mt-1 px-0.5">
              <span>0</span><span>5</span><span>10</span>
            </div>
          </div>
        )}

        {/* unit row */}
        <label className="font-mono text-[10px] uppercase tracking-[0.03em] text-ink-3">
          {hasBatch ? `Or in ${item.unit}` : `How much did you make (${item.unit})`}
        </label>
        <div className="relative mt-1.5">
          <input
            ref={unitRef}
            type="number"
            inputMode="decimal"
            min={0}
            value={text}
            onChange={(e) => onUnitChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            placeholder={planned > 0 ? qtyText(planned) : 'e.g. 6.5'}
            className={`w-full border rounded-[10px] pl-3 pr-14 py-3 text-[18px] font-mono outline-none focus:border-ink-3 ${
              warning ? 'border-red' : 'border-line-2'
            }`}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[12px] text-ink-3 border-l border-line pl-3">
            {item.unit}
          </span>
        </div>
        {warning && <div className="font-mono text-[11px] text-red-text mt-1.5 leading-snug">{warning}</div>}

        {/* quick chips */}
        <div className="flex gap-2 mt-3 flex-wrap">
          {planned > 0 && <Chip label="Planned" active={near(q, planned)} onClick={() => setUnit(planned)} />}
          {hasBatch && <Chip label="×1 batch" active={near(q, batchesToQty(item, 1))} onClick={() => setBatches(1)} />}
          {hasBatch && <Chip label="½ batch" active={near(q, batchesToQty(item, 0.5))} onClick={() => setBatches(0.5)} />}
        </div>

        {/* outcome + confirm */}
        <div className="font-mono text-[11px] text-ink-3 mt-4">{outcome}</div>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className={`mt-2 w-full h-12 rounded-[10px] text-[14px] font-semibold inline-flex items-center justify-center gap-2 ${
            canSubmit ? 'bg-green text-white' : 'bg-bg-2 text-ink-4 cursor-not-allowed'
          }`}
        >
          <IcCheck size={16} />
          {canSubmit ? `${verb} ${qtyText(q)} ${item.unit} · ${status === 'DONE' ? 'Done' : 'Partial'}` : `${verb} yield`}
        </button>
      </div>
    </div>
  )
}
