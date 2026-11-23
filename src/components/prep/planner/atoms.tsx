'use client'
// Smart Prep v2 planner — shared atoms. ONE urgency step per item (the dial),
// read-only stock evidence (Reason), a batch-aware qty stepper, and the
// generic group heading. Ported from the design's planner.jsx with flat
// Tailwind tokens and Lucide icons.
import { fmtAmount, stepOnGrid, onGrid } from '@/lib/prep-amount'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pencil, ChevronDown, Undo2, Minus, Plus, UserPlus, MessageSquareText } from 'lucide-react'
import type { PrepUrgency } from '@/lib/prep-utils'
import {
  PLAN_URG_META, PLAN_URG_ORDER, effectiveUrgency, autoUrgencyOf, whyLabel,
  batchYield, batchCount, batchesToQty, fmtBatch, draftQty, prepStep,
  urgencyDeadline, fmtDeadline, deadlineLabel,
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

/**
 * Phone: the choices slide up from the bottom, full width, above the tab bar
 * and the post bar — a popover anchored to a button near the screen edge got
 * cut off on the left and hidden under the post bar on the last card.
 * Portalled to <body> so no card's overflow or transform can clip it.
 */
export function Sheet({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end">
      <span className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <div role="dialog" aria-label={title}
        className="relative w-full max-h-[80vh] overflow-y-auto bg-paper rounded-t-2xl shadow-[0_-10px_30px_-12px_rgba(9,9,11,0.3)] px-2 pt-2 pb-[max(12px,env(safe-area-inset-bottom))]">
        <div className="mx-auto mb-1 h-1 w-9 rounded-full bg-line-2" />
        <div className="flex items-center px-2.5 pt-1 pb-1.5">
          <span className="text-[13px] font-semibold text-ink-3">{title}</span>
          <button type="button" onClick={onClose} className="ml-auto min-h-[40px] px-2 text-[13px] font-semibold text-ink-2">Done</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

export const popItemCls = (active: boolean) =>
  `flex items-center gap-2 w-full text-left rounded-lg px-2.5 py-2 text-[12.5px] cursor-pointer ${active ? 'bg-bg-2 font-semibold' : 'font-medium'} text-ink-2 hover:bg-bg-2`

export const popHeadCls = 'text-[11.5px] font-semibold text-ink-3 px-2.5 pt-1.5 pb-1.5'

// ─── group heading (urgency / station / category via planGroups) ───────────
export function GroupHead({ g, count, mins, warn }: {
  g: Pick<PlanGroup<never>, 'label' | 'sub' | 'urg'>
  count: number
  mins?: number | null
  warn?: boolean
}) {
  const m = g.urg ? PLAN_URG_META[g.urg] : null
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-3.5 mb-1.5 mx-0.5">
      {m && <span className={`w-[7px] h-[7px] rounded-full ${m.dotClass}`} />}
      <span className="text-[13px] font-semibold text-ink">{g.label}</span>
      <span className="text-[12px] text-ink-3">· {count}{mins != null ? ` · ${fmtMins(mins)}` : ''}</span>
      {warn
        ? <span className="ml-auto text-[11.5px] font-semibold bg-red-soft text-red-text px-2 py-0.5 rounded-full whitespace-nowrap">Change the step to move it</span>
        : <span className="ml-auto text-[12px] text-ink-3">{g.sub ?? ''}</span>}
    </div>
  )
}

// ─── read-only stock evidence — what used to be a second pill ──────────────
export function Reason({ item, sm }: { item: PrepItemRich; sm?: boolean }) {
  const overridden = !!item.manualPriorityOverride
  const m = PLAN_URG_META[effectiveUrgency(item)]
  return (
    <span className={`inline-flex items-center gap-[5px] min-w-0 font-mono ${sm ? 'text-[11px]' : 'text-[11.5px]'} ${overridden ? 'text-gold-2' : 'text-ink-3'} whitespace-nowrap overflow-hidden text-ellipsis`}>
      <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${overridden ? 'bg-gold' : m.dotClass}`} />
      {whyLabel(item)}
    </span>
  )
}

// ─── THE dial: one step, carrying deadline + stock meaning ─────────────────
// The step's name as the button says it — the section header already uses the
// long label, and "CRIT" read as a code rather than a word.
const STEP_NAME: Record<PrepUrgency, string> = { PASS: 'Critical', MID: 'Mid-service', CLOSE: 'Before close', TMRW: 'Tomorrow' }

export function UrgPicker({ item, locked, ctx, onChange, w = 'min-w-[126px]', sm }: {
  item: PrepItemRich
  locked: boolean
  /** day anchors for the per-step deadline captions; null hides the times */
  ctx: PlanDayContext | null
  onChange: (step: string) => void
  w?: string
  /** phone: step over its time on two short lines, choices in a bottom sheet */
  sm?: boolean
}) {
  const [open, setOpen] = useState(false)
  const u = effectiveUrgency(item)
  const auto = autoUrgencyOf(item)
  const m = PLAN_URG_META[u]
  // The deadline rides the button ("Critical · 09:00"), so the card never
  // repeats it on a meta line.
  const dl = ctx ? urgencyDeadline(u, ctx) : null
  return (
    <div className={`relative ${sm ? 'flex-1 min-w-0' : 'shrink-0'}`}>
      <button
        type="button"
        onClick={() => !locked && setOpen(v => !v)}
        title={locked ? 'Pick a revenue center you can edit' : 'When is it needed?'}
        className={`inline-flex items-center gap-1.5 ${w} ${m.softClass} ${m.textClass} border ${item.manualPriorityOverride ? 'border-current' : 'border-transparent'} rounded-lg px-2 py-1.5 text-[11.5px] font-semibold whitespace-nowrap ${locked ? 'cursor-default' : 'cursor-pointer'}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${m.dotClass} shrink-0`} />
        {sm ? (
          <span className="flex-1 min-w-0 flex flex-col text-left leading-[1.15]">
            <span className="text-[12.5px]">{STEP_NAME[u]}</span>
            {dl != null && ctx && <span className="font-mono text-[11px] font-medium">{deadlineLabel(dl, ctx.shiftStart, fmtClock)}</span>}
          </span>
        ) : (
          <span className="flex-1 text-left">
            {STEP_NAME[u]}
            {dl != null && ctx && <span className="font-mono text-[11px] font-medium"> · {deadlineLabel(dl, ctx.shiftStart, fmtClock)}</span>}
          </span>
        )}
        {item.manualPriorityOverride ? <Pencil size={10} className="shrink-0" /> : !locked && <ChevronDown size={10} className="shrink-0" />}
      </button>
      {open && (() => {
        const choices = (
          <>
          {PLAN_URG_ORDER.map(k => {
            const km = PLAN_URG_META[k]
            const dl = ctx ? urgencyDeadline(k, ctx) : null
            return (
              <button key={k} type="button" onClick={() => { onChange(k === auto ? '' : k); setOpen(false) }} className={`${popItemCls(u === k)} !items-start ${sm ? 'min-h-[52px] !text-[14px]' : ''}`}>
                <span className={`w-[7px] h-[7px] rounded-full mt-[5px] shrink-0 ${km.dotClass}`} />
                <span className="flex-1 min-w-0">
                  <span className="flex items-baseline gap-1.5">
                    {km.label}
                    {dl != null && <span className="font-mono text-[11.5px] font-bold text-ink-3">{fmtDeadline(dl, fmtClock)}</span>}
                    {k === auto && <span className="ml-auto text-[11px] font-semibold text-ink-3">Smart</span>}
                  </span>
                  <span className="flex text-[11.5px] text-ink-3 font-medium mt-0.5 leading-[1.35]">{km.stock}</span>
                </span>
              </button>
            )
          })}
          {item.manualPriorityOverride && (
            <button type="button" onClick={() => { onChange(''); setOpen(false) }} className={`${popItemCls(false)} ${sm ? 'min-h-[48px]' : ''} border-t border-line rounded-none mt-1 pt-2.5 !text-gold-2`}>
              <Undo2 size={13} /> Back to smart ({PLAN_URG_META[auto].label})
            </button>
          )}
          </>
        )
        return sm
          ? <Sheet title={`${item.name} — needed`} onClose={() => setOpen(false)}>{choices}</Sheet>
          : <Popover onClose={() => setOpen(false)} w="w-[274px]"><div className={popHeadCls}>Needed</div>{choices}</Popover>
      })()}
    </div>
  )
}

// ─── quantity: UOM or batches of the recipe's own yield ────────────────────
// exact: every 25 g step reads differently (1,025 g — never "1 kg" twice)
const fmtUom = (q: number, u: string) => fmtAmount(q, u, { exact: true })

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
  // An amount off the step grid (1.3 batches) shows gold until the first tap
  // snaps it: + goes to the next half batch, − to the one below.
  const overridden = (suggested > 0 && Math.abs(qty - suggested) > 0.01) || !onGrid(val, step)
  const nudge = (dir: 1 | -1) => {
    const nv = stepOnGrid(val, step, dir)
    onQty(item, batch ? batchesToQty(item, nv) : nv)
  }
  // sm (mobile) is deliberately narrower — on a 375px screen the batch stepper +
  // urgency dial + assign pill must share one row (wrapping is the fallback).
  // sm = phone: 44 px targets (the row wraps under the name when it must)
  const h = sm ? 'h-11' : 'h-7'
  const bw = sm ? 'w-10' : 'w-[26px]'
  const midW = batch ? (sm ? 'min-w-[64px]' : 'min-w-[84px]') : (sm ? 'min-w-[56px]' : 'min-w-[52px]')
  return (
    <div className="inline-flex items-stretch bg-bg-2 border border-line rounded-lg shrink-0 overflow-hidden">
      <button type="button" disabled={locked} onClick={() => nudge(-1)} className={`${bw} ${h} grid place-items-center ${locked ? 'cursor-not-allowed' : ''}`}>
        <Minus size={12} className={locked ? 'text-ink-4' : 'text-ink-2'} />
      </button>
      <span className={`${midW} flex flex-col items-center justify-center leading-[1.05] px-0.5`}>
        <span className={`font-mono ${batch ? (sm ? 'text-[11.5px]' : 'text-[11.5px]') : 'text-[12px]'} font-bold whitespace-nowrap ${overridden ? 'text-gold-2' : 'text-ink'}`}>
          {batch ? `${fmtBatch(val)} batch` : fmtUom(qty, item.unit)}
        </span>
        {batch && <span className="font-mono text-[11px] text-ink-2 whitespace-nowrap">{fmtUom(qty, item.unit)}</span>}
      </span>
      <button type="button" disabled={locked} onClick={() => nudge(1)} className={`${bw} ${h} grid place-items-center ${locked ? 'cursor-not-allowed' : ''}`}>
        <Plus size={12} className={locked ? 'text-ink-4' : 'text-ink-2'} />
      </button>
      {yieldPerBatch != null && (
        <button
          type="button"
          disabled={locked}
          onClick={() => onToggleBatch(item, !batch)}
          title={batch ? `1 batch = ${fmtUom(yieldPerBatch, item.unit)} · switch to ${item.unit}` : `Count in batches of ${fmtUom(yieldPerBatch, item.unit)}`}
          // Names what a tap switches TO ("kg" while counting batches, "batch"
          // while counting kg) — the old black "×" read as a delete button.
          className={`border-l border-line ${sm ? 'min-w-[40px] px-1.5' : 'px-2'} font-mono text-[11px] font-semibold text-ink-3 bg-paper hover:text-ink ${locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
        >
          {batch ? item.unit : 'batch'}
        </button>
      )}
    </div>
  )
}

// ─── assignment control ────────────────────────────────────────────────────
export function AssignPill({ cookId, cooks, crewIds = [], locked, onAssign, sm }: {
  cookId: string | null; cooks: Cook[]; crewIds?: string[]; locked: boolean; onAssign: (id: string | null) => void; sm?: boolean
}) {
  const [open, setOpen] = useState(false)
  const c = cookId ? cooks.find(x => x.id === cookId) ?? null : null
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => !locked && setOpen(v => !v)}
        title={locked ? 'Pick a revenue center you can edit' : 'Assign'}
        aria-label={c ? `Assigned to ${c.name}` : 'Assign'}
        // Unassigned is a small round button, the same one the To Do uses —
        // "+ ASSIGN" cost a pill's width on every card.
        className={c
          ? `inline-flex items-center gap-1.5 rounded-full font-mono text-[11px] font-bold whitespace-nowrap ${sm ? 'px-3 min-h-[40px]' : 'px-2.5 py-1.5'} bg-ink text-paper border border-ink ${locked ? 'cursor-default' : 'cursor-pointer'}`
          : `${sm ? 'w-10 h-10' : 'w-[30px] h-[30px]'} rounded-full grid place-items-center bg-paper text-ink-3 border border-dashed border-line-2 ${locked ? 'cursor-default' : 'cursor-pointer hover:text-ink hover:border-ink-3'}`}
      >
        {c ? <><span className="w-[5px] h-[5px] rounded-full bg-gold" />{c.initials}</> : <UserPlus size={13} strokeWidth={2.2} />}
      </button>
      {open && (() => {
        const choices = (
          <>
          {/* Today's crew first ("Who's on today"), then everyone else. */}
          {[
            { head: crewIds.length ? 'On today' : 'Assign to', list: cooks.filter(x => crewIds.includes(x.id)).sort((a, b) => crewIds.indexOf(a.id) - crewIds.indexOf(b.id)) },
            { head: crewIds.length ? 'Everyone else' : null, list: cooks.filter(x => !crewIds.includes(x.id)) },
          ].filter(g => g.list.length).map(g => (
            <div key={g.head ?? 'all'}>
              {g.head && <div className={popHeadCls}>{g.head}</div>}
              {g.list.map(x => (
                <button key={x.id} type="button" onClick={() => { onAssign(x.id); setOpen(false) }} className={`${popItemCls(cookId === x.id)} ${sm ? 'min-h-[48px] !text-[14px]' : ''}`}>
                  <span className="font-mono text-[11px] font-bold bg-bg-2 rounded px-1.5 py-0.5">{x.initials}</span>
                  <span className="truncate">{x.name}</span>
                </button>
              ))}
            </div>
          ))}
          {cooks.length === 0 && <div className="px-2.5 py-2 text-[12px] text-ink-3">No crew yet — add cooks in Setup.</div>}
          {cookId && <button type="button" onClick={() => { onAssign(null); setOpen(false) }} className={`${popItemCls(false)} ${sm ? 'min-h-[48px]' : ''} !text-ink-3`}>Leave open</button>}
          </>
        )
        return sm
          ? <Sheet title="Who makes it?" onClose={() => setOpen(false)}>{choices}</Sheet>
          : <Popover onClose={() => setOpen(false)}>{choices}</Popover>
      })()}
    </div>
  )
}

// ─── the chef's note, written where the cook will read it ─────────────────
// The same gold-rule "Chef's note" box the To Do shows, edited in place — so
// the chef writes exactly what the cook will see. No note yet: one quiet
// "Add a note" link instead of an empty input line on every card. Saved on
// blur (unchanged text is not re-sent); clearing it folds the box away.
export function NoteField({ item, locked, onNote, sm }: {
  item: PrepItemRich
  locked: boolean
  onNote: (item: PrepItemRich, note: string) => void
  /** phone: a 44 px "Add a note" target */
  sm?: boolean
}) {
  const saved = item.todayLog?.note ?? ''
  const [expanded, setExpanded] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const open = expanded || saved.trim() !== ''
  const fit = () => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }
  useEffect(fit, [open, saved])
  if (!open) {
    if (locked) return null
    return (
      <button type="button" onClick={() => setExpanded(true)}
        className={`inline-flex items-center gap-1 ${sm ? 'min-h-[44px]' : 'mt-1.5'} text-[12px] text-ink-3 hover:text-gold-2`}>
        <MessageSquareText size={11} /> Add a note for the cook
      </button>
    )
  }
  return (
    <label className="flex flex-col mt-2 border-l-2 border-gold rounded-r-[7px] bg-gold/[0.10] pl-3 pr-3 py-[6px] cursor-text">
      <span className="flex items-center gap-1 text-[11px] font-semibold text-gold-2">
        <MessageSquareText size={10} strokeWidth={2.4} aria-hidden /> Chef&apos;s note
      </span>
      <textarea
        ref={ref}
        key={item.todayLog?.id ?? item.id}
        rows={1}
        defaultValue={saved}
        disabled={locked}
        autoFocus={expanded && !saved}
        onInput={fit}
        onBlur={e => {
          const v = e.target.value
          if (v !== saved) onNote(item, v)
          if (!v.trim()) setExpanded(false)
        }}
        placeholder="What should the cook know?"
        className="w-full mt-0.5 bg-transparent border-0 outline-none resize-none overflow-hidden text-[13px] font-medium leading-snug text-ink-2 placeholder:text-ink-4 placeholder:font-normal"
      />
    </label>
  )
}
