'use client'
// Smart Prep v2 — right-pane prep-list row (design PPDraftRow): batch-aware qty
// stepper, THE urgency dial (which carries the deadline), assign button, one
// plain reason line, and the chef's note in the To Do's own style.
import { GripVertical, X } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import {
  PLAN_URG_META, effectiveUrgency, suggestedDraftQty, draftQty,
  suggestedBatches, batchesToQty, fmtBatch, fmtDeadline, plainReason, whyLabel,
  type PlanDayContext, type PlanSlot,
} from '@/lib/prep-plan'
import { fmtClock } from '@/lib/prep-runsheet'
import { UrgPicker, AssignPill, QtyStepper, NoteField } from './atoms'

const fmtQ = (q: number, u: string) => `${(u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)} ${u}`

export function DraftRow({
  item, cooks, locked, ctx, slot, batchMode, dragging, over, showStation = false,
  onQty, onToggleBatch, onNote, onAssign, onUrgChange, onRemove, onOpen,
  onDragStart, onDragOver, onDrop, onDragEnd,
}: {
  item: PrepItemRich
  cooks: Cook[]
  locked: boolean
  ctx: PlanDayContext | null
  slot: PlanSlot | null
  batchMode: boolean
  dragging: boolean
  over: boolean
  /** The station tag, only when the kitchen has more than one. */
  showStation?: boolean
  onQty: (item: PrepItemRich, qty: number) => void
  onToggleBatch: (item: PrepItemRich, next: boolean) => void
  onNote: (item: PrepItemRich, note: string) => void
  onAssign: (item: PrepItemRich, cookId: string | null) => void
  onUrgChange: (id: string, step: string) => void
  onRemove: (item: PrepItemRich) => void
  onOpen: (item: PrepItemRich) => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}) {
  const m = PLAN_URG_META[effectiveUrgency(item)]
  const sugg = suggestedDraftQty(item)
  const qty = draftQty(item)
  const nb = suggestedBatches(item)
  const suggQ = batchMode && nb != null ? batchesToQty(item, nb) : sugg
  const overridden = suggQ > 0 && Math.abs(qty - suggQ) > 0.01
  return (
    <div
      draggable={!locked}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`bg-paper border border-line rounded-[10px] pt-2 pb-[7px] px-2.5 border-l-[3px] ${dragging ? 'opacity-35' : ''} ${over ? 'shadow-[0_-2px_0_#09090b]' : ''}`}
      style={{ borderLeftColor: m.hex }}
    >
      {/* flex-wrap + a name min-width: the stepper/dial/assign cluster is
          ~400px of fixed-width controls, so on a narrow pane (iPad) it wraps
          under the name instead of clipping at the pane edge — and the name
          can never be squeezed to zero. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span
          title={locked ? 'Pick a revenue center you can edit' : 'Drag to reorder within this step'}
          className={`shrink-0 ${locked ? 'opacity-35' : 'cursor-grab'}`}
        >
          <GripVertical size={13} className="text-ink-4" />
        </span>
        {/* the name wraps; it never truncates */}
        <button type="button" onClick={() => onOpen(item)} className="flex-1 min-w-[140px] flex items-center gap-1.5 text-left">
          <span className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink break-words min-w-0">{item.name}</span>
          {showStation && item.station && <span className="font-mono text-[9px] font-medium uppercase tracking-[0.04em] bg-bg-2 text-ink-2 px-1.5 py-0.5 rounded whitespace-nowrap shrink-0">{item.station}</span>}
        </button>
        <QtyStepper item={item} locked={locked} batchMode={batchMode} onQty={onQty} onToggleBatch={onToggleBatch} suggested={sugg} />
        <UrgPicker item={item} locked={locked} ctx={ctx} onChange={step => onUrgChange(item.id, step)} />
        <AssignPill cookId={item.todayLog?.assignedTo ?? null} cooks={cooks} locked={locked} onAssign={id => onAssign(item, id)} />
        <button type="button" disabled={locked} onClick={() => onRemove(item)} title="Take off the list"
          className="w-6 h-6 rounded-[7px] grid place-items-center shrink-0">
          <X size={13} className={locked ? 'text-line-2' : 'text-ink-4'} />
        </button>
      </div>
      {/* ONE plain line: why it is on the list (full evidence in the tooltip and
          the drawer), the suggested amount only when the chef changed it, and
          the schedule only when it won't fit. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 pl-[21px] min-w-0">
        <DraftReason item={item} />
        {overridden && (
          <button type="button" disabled={locked} onClick={() => onQty(item, suggQ)} className="font-mono text-[10px] font-semibold text-gold-2 shrink-0 hover:underline">
            · suggested {batchMode && nb ? `${fmtBatch(nb)} batch` : fmtQ(sugg, item.unit)} ↺
          </button>
        )}
        <WontFit slot={slot} />
      </div>
      <div className="pl-[21px]">
        <NoteField item={item} locked={locked} onNote={onNote} />
      </div>
    </div>
  )
}

/** The plain reason, red when out of stock; the full evidence is the tooltip. */
export function DraftReason({ item }: { item: PrepItemRich }) {
  const out = !item.pipeline && (item.parLevel ?? 0) > 0 && (item.onHand ?? 0) <= 0
  return (
    <span title={whyLabel(item)} className={`text-[11.5px] leading-snug min-w-0 ${out ? 'text-red-text font-medium' : 'text-ink-3'}`}>
      {plainReason(item)}
    </span>
  )
}

/** The schedule, said only when it matters: the job won't fit before its deadline. */
export function WontFit({ slot }: { slot: PlanSlot | null }) {
  if (!slot || slot.fits) return null
  return (
    <span className="font-mono text-[10px] font-semibold text-red-text whitespace-nowrap">
      · won&apos;t fit — {slot.over}m past {fmtDeadline(slot.deadline, fmtClock)}
    </span>
  )
}
