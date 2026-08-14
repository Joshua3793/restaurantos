'use client'
// Smart Prep v2 planner — shared atoms. ONE urgency step per item (the dial),
// read-only stock evidence (Reason), a batch-aware qty stepper, and the
// generic group heading. Ported from the design's planner.jsx with flat
// Tailwind tokens and Lucide icons.
import { useState } from 'react'
import { Pencil, ChevronDown, Undo2, Minus, Plus } from 'lucide-react'
import type { PrepUrgency } from '@/lib/prep-utils'
import {
  PLAN_URG_META, PLAN_URG_ORDER, effectiveUrgency, autoUrgencyOf, whyLabel,
  batchYield, batchCount, batchesToQty, fmtBatch, draftQty, prepStep,
  urgencyDeadline, fmtDeadline,
  type PlanDayContext, type PlanGroup,
} from '@/lib/prep-plan'
import { fmtClock, fmtMins } from '@/lib/prep-runsheet'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'

export function Popover({ children, onClose, w = 'w-48', align = 'right' }: {
  children: React.ReactNode; onClose: () => void; w?: string; align?: 'left' | 'right'
}) {
  return (
    <>
      <span className="fixed inset-0 z-40" onClick={onClose} />
      <div className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-[calc(100%+5px)] z-50 ${w} bg-paper border border-line-2 rounded-xl shadow-[0_14px_34px_-10px_rgba(9,9,11,0.28)] p-1.5`}>
        {children}
      </div>
    </>
  )
}

export const popItemCls = (active: boolean) =>
  `flex items-center gap-2 w-full text-left rounded-lg px-2.5 py-2 text-[12.5px] cursor-pointer ${active ? 'bg-bg-2 font-semibold' : 'font-medium'} text-ink-2 hover:bg-bg-2`

export const popHeadCls = 'font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em] text-ink-4 px-2.5 pt-1.5 pb-2'

// ─── group heading (urgency / station / category via planGroups) ───────────
export function GroupHead({ g, count, mins, warn }: {
  g: Pick<PlanGroup<never>, 'label' | 'sub' | 'urg'>
  count: number
  mins?: number | null
  warn?: boolean
}) {
  const m = g.urg ? PLAN_URG_META[g.urg] : null
  return (
    <div className="flex items-center gap-2 mt-3.5 mb-1.5 mx-0.5">
      {m && <span className={`w-[7px] h-[7px] rounded-full ${m.dotClass}`} />}
      <span className="font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] text-ink">{g.label}</span>
      <span className="font-mono text-[9.5px] text-ink-4">· {count}{mins != null ? ` · ${fmtMins(mins)}` : ''}</span>
      {warn
        ? <span className="ml-auto font-mono text-[9px] font-bold uppercase bg-red-soft text-red-text px-2 py-0.5 rounded-full whitespace-nowrap">Change the step to move it</span>
        : <span className="ml-auto font-mono text-[9px] text-ink-4 truncate">{g.sub ?? ''}</span>}
    </div>
  )
}

// ─── read-only stock evidence — what used to be a second pill ──────────────
export function Reason({ item, sm }: { item: PrepItemRich; sm?: boolean }) {
  const overridden = !!item.manualPriorityOverride
  const m = PLAN_URG_META[effectiveUrgency(item)]
  return (
    <span className={`inline-flex items-center gap-[5px] min-w-0 font-mono ${sm ? 'text-[9px]' : 'text-[9.5px]'} ${overridden ? 'text-gold-2' : 'text-ink-3'} whitespace-nowrap overflow-hidden text-ellipsis`}>
      <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${overridden ? 'bg-gold' : m.dotClass}`} />
      {whyLabel(item)}
    </span>
  )
}

// ─── THE dial: one step, carrying deadline + stock meaning ─────────────────
export function UrgPicker({ item, locked, ctx, onChange, w = 'w-[126px]' }: {
  item: PrepItemRich
  locked: boolean
  /** day anchors for the per-step deadline captions; null hides the times */
  ctx: PlanDayContext | null
  onChange: (step: string) => void
  w?: string
}) {
  const [open, setOpen] = useState(false)
  const u = effectiveUrgency(item)
  const auto = autoUrgencyOf(item)
  const m = PLAN_URG_META[u]
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => !locked && setOpen(v => !v)}
        title={locked ? 'Chef only' : 'When is it needed?'}
        className={`inline-flex items-center gap-1.5 ${w} ${m.softClass} ${m.textClass} border ${item.manualPriorityOverride ? 'border-current' : 'border-transparent'} rounded-lg px-2 py-1.5 font-mono text-[9.5px] font-bold ${locked ? 'cursor-default' : 'cursor-pointer'}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${m.dotClass} shrink-0`} />
        <span className="flex-1 text-left truncate">{m.short}</span>
        {item.manualPriorityOverride ? <Pencil size={10} className="shrink-0" /> : !locked && <ChevronDown size={10} className="shrink-0" />}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} w="w-[274px]">
          <div className={popHeadCls}>Needed</div>
          {PLAN_URG_ORDER.map(k => {
            const km = PLAN_URG_META[k]
            const dl = ctx ? urgencyDeadline(k, ctx, item.service?.timeMinutes ?? null) : null
            return (
              <button key={k} type="button" onClick={() => { onChange(k === auto ? '' : k); setOpen(false) }} className={`${popItemCls(u === k)} !items-start`}>
                <span className={`w-[7px] h-[7px] rounded-full mt-[5px] shrink-0 ${km.dotClass}`} />
                <span className="flex-1 min-w-0">
                  <span className="flex items-baseline gap-1.5">
                    {km.label}
                    {dl != null && <span className="font-mono text-[9.5px] font-bold text-ink-3">{fmtDeadline(dl, fmtClock)}</span>}
                    {k === auto && <span className="ml-auto font-mono text-[9px] font-semibold text-ink-4 uppercase">Smart</span>}
                  </span>
                  <span className="block text-[10.5px] text-ink-4 font-medium mt-0.5 leading-[1.35]">{km.stock}</span>
                </span>
              </button>
            )
          })}
          {item.manualPriorityOverride && (
            <button type="button" onClick={() => { onChange(''); setOpen(false) }} className={`${popItemCls(false)} border-t border-line rounded-none mt-1 pt-2.5 !text-gold-2`}>
              <Undo2 size={13} /> Back to smart ({PLAN_URG_META[auto].label})
            </button>
          )}
        </Popover>
      )}
    </div>
  )
}

// ─── quantity: UOM or batches of the recipe's own yield ────────────────────
const fmtUom = (q: number, u: string) => `${(u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)} ${u}`

export function QtyStepper({ item, locked, batchMode, onQty, onToggleBatch, suggested, sm }: {
  item: PrepItemRich
  locked: boolean
  /** display/entry in batches when true and the item has a usable base yield */
  batchMode: boolean
  onQty: (item: PrepItemRich, qty: number) => void
  onToggleBatch: (item: PrepItemRich, next: boolean) => void
  /** suggested qty in the item's UOM (for the overridden tint) */
  suggested: number
  sm?: boolean
}) {
  const yieldPerBatch = batchYield(item)
  const batch = batchMode && yieldPerBatch != null
  const qty = draftQty(item)
  const step = batch ? 0.5 : prepStep(item.unit)
  const val = batch ? (batchCount(item, qty) ?? qty) : qty
  const overridden = suggested > 0 && Math.abs(qty - suggested) > 0.01
  const set = (v: number) => {
    const nv = Math.max(step, Math.round(v * 100) / 100)
    onQty(item, batch ? batchesToQty(item, nv) : +nv.toFixed(2))
  }
  // sm (mobile) is deliberately narrower — on a 375px screen the batch stepper +
  // urgency dial + assign pill must share one row (wrapping is the fallback).
  const h = sm ? 'h-8' : 'h-7'
  const bw = sm ? 'w-6' : 'w-[26px]'
  const midW = batch ? (sm ? 'min-w-[68px]' : 'min-w-[84px]') : (sm ? 'min-w-[44px]' : 'min-w-[52px]')
  return (
    <div className="inline-flex items-stretch bg-bg-2 border border-line rounded-lg shrink-0 overflow-hidden">
      <button type="button" disabled={locked} onClick={() => set(val - step)} className={`${bw} ${h} grid place-items-center ${locked ? 'cursor-not-allowed' : ''}`}>
        <Minus size={12} className={locked ? 'text-ink-4' : 'text-ink-2'} />
      </button>
      <span className={`${midW} flex flex-col items-center justify-center leading-[1.05] px-0.5`}>
        <span className={`font-mono ${batch ? (sm ? 'text-[10.5px]' : 'text-[11.5px]') : 'text-[12px]'} font-bold whitespace-nowrap ${overridden ? 'text-gold-2' : 'text-ink'}`}>
          {batch ? `${fmtBatch(val)} batch` : fmtUom(qty, item.unit)}
        </span>
        {batch && <span className="font-mono text-[8.5px] text-ink-4 whitespace-nowrap">{fmtUom(qty, item.unit)}</span>}
      </span>
      <button type="button" disabled={locked} onClick={() => set(val + step)} className={`${bw} ${h} grid place-items-center ${locked ? 'cursor-not-allowed' : ''}`}>
        <Plus size={12} className={locked ? 'text-ink-4' : 'text-ink-2'} />
      </button>
      {yieldPerBatch != null && (
        <button
          type="button"
          disabled={locked}
          onClick={() => onToggleBatch(item, !batch)}
          title={batch ? `1 batch = ${fmtUom(yieldPerBatch, item.unit)} · switch to ${item.unit}` : `Count in batches of ${fmtUom(yieldPerBatch, item.unit)}`}
          className={`border-l border-line ${sm ? 'px-1' : 'px-[7px]'} font-mono text-[8.5px] font-bold tracking-[0.04em] ${batch ? 'bg-ink text-gold' : 'bg-transparent text-ink-3'} ${locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
        >
          {batch ? '×' : item.unit.toUpperCase()}
        </button>
      )}
    </div>
  )
}

// ─── assignment control ────────────────────────────────────────────────────
export function AssignPill({ cookId, cooks, locked, onAssign, sm }: {
  cookId: string | null; cooks: Cook[]; locked: boolean; onAssign: (id: string | null) => void; sm?: boolean
}) {
  const [open, setOpen] = useState(false)
  const c = cookId ? cooks.find(x => x.id === cookId) ?? null : null
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => !locked && setOpen(v => !v)}
        title={locked ? 'Chef only' : 'Assign'}
        className={`inline-flex items-center gap-1.5 rounded-full font-mono text-[9.5px] font-bold whitespace-nowrap ${sm ? 'px-2 py-0.5' : 'px-2.5 py-1.5'} ${c ? 'bg-ink text-paper border border-ink' : 'bg-paper text-ink-3 border border-dashed border-line-2'} ${locked ? 'cursor-default' : 'cursor-pointer'}`}
      >
        {c ? <><span className="w-[5px] h-[5px] rounded-full bg-gold" />{c.initials}</> : '+ ASSIGN'}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)}>
          <div className={popHeadCls}>Assign to</div>
          {cooks.map(x => (
            <button key={x.id} type="button" onClick={() => { onAssign(x.id); setOpen(false) }} className={popItemCls(cookId === x.id)}>
              <span className="font-mono text-[10px] font-bold bg-bg-2 rounded px-1.5 py-0.5">{x.initials}</span>
              <span className="truncate">{x.name}</span>
              <span className="ml-auto font-mono text-[9.5px] text-ink-4 font-medium">{x.homeStation ?? ''}</span>
            </button>
          ))}
          {cooks.length === 0 && <div className="px-2.5 py-2 text-[12px] text-ink-3">No crew yet — add cooks in Setup.</div>}
          {cookId && <button type="button" onClick={() => { onAssign(null); setOpen(false) }} className={`${popItemCls(false)} !text-ink-3`}>Leave open</button>}
        </Popover>
      )}
    </div>
  )
}
