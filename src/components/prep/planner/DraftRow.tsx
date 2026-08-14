'use client'
// Smart Prep v2 — right-pane prep-list row (design PPDraftRow): batch-aware qty
// stepper, THE urgency dial, assign pill, reason + schedule-slot line, note.
import { GripVertical, X } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import {
  PLAN_URG_META, effectiveUrgency, suggestedDraftQty, draftQty,
  suggestedBatches, batchesToQty, fmtBatch, fmtDeadline,
  type PlanDayContext, type PlanSlot,
} from '@/lib/prep-plan'
import { fmtClock } from '@/lib/prep-runsheet'
import { UrgPicker, AssignPill, QtyStepper, Reason } from './atoms'

const fmtQ = (q: number, u: string) => `${(u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)} ${u}`

export function DraftRow({
  item, cooks, locked, ctx, slot, batchMode, dragging, over,
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
      <div className="flex items-center gap-2">
        <span
          title={locked ? 'Chef only' : 'Drag to reorder within this step'}
          className={`shrink-0 ${locked ? 'opacity-35' : 'cursor-grab'}`}
        >
          <GripVertical size={13} className="text-ink-4" />
        </span>
        <button type="button" onClick={() => onOpen(item)} className="flex-1 min-w-0 flex items-center gap-1.5 text-left">
          <span className="text-[13px] font-semibold tracking-[-0.01em] text-ink truncate">{item.name}</span>
          {item.station && <span className="font-mono text-[9px] font-medium uppercase tracking-[0.04em] bg-bg-2 text-ink-2 px-1.5 py-0.5 rounded whitespace-nowrap shrink-0">{item.station}</span>}
          {item.isBlocked && <span className="font-mono text-[9px] font-bold uppercase bg-gold-soft text-gold-2 px-1.5 py-0.5 rounded-full shrink-0">BLOCKED</span>}
        </button>
        <QtyStepper item={item} locked={locked} batchMode={batchMode} onQty={onQty} onToggleBatch={onToggleBatch} suggested={sugg} />
        <UrgPicker item={item} locked={locked} ctx={ctx} onChange={step => onUrgChange(item.id, step)} />
        <AssignPill cookId={item.todayLog?.assignedTo ?? null} cooks={cooks} locked={locked} onAssign={id => onAssign(item, id)} />
        <button type="button" disabled={locked} onClick={() => onRemove(item)} title="Take off the list"
          className="w-6 h-6 rounded-[7px] grid place-items-center shrink-0">
          <X size={13} className={locked ? 'text-line-2' : 'text-ink-4'} />
        </button>
      </div>
      <div className="flex items-center gap-[7px] mt-[5px] pl-[18px] font-mono text-[9px] text-ink-4 whitespace-nowrap min-w-0">
        <Reason item={item} sm />
        <span>·</span>
        {overridden
          ? (
            <button type="button" disabled={locked} onClick={() => onQty(item, suggQ)} className="font-mono text-[9px] font-bold text-gold-2 shrink-0">
              SUGG {batchMode && nb ? `${fmtBatch(nb)} BATCH` : fmtQ(sugg, item.unit)} ↺
            </button>
          )
          : <span className="font-semibold text-ink-3 shrink-0">SMART QTY</span>}
        {slot && (
          <span className={`truncate ${slot.fits ? 'text-ink-3' : 'text-red-text font-bold'}`}>
            · {fmtClock(slot.start)}–{fmtClock(slot.end % 1440)} · BY {fmtDeadline(slot.deadline, fmtClock)}{slot.fits ? '' : ` · ${slot.over}m PAST`}
          </span>
        )}
      </div>
      <div className="pl-[18px]">
        <input
          key={item.todayLog?.id ?? item.id}
          defaultValue={item.todayLog?.note ?? ''}
          disabled={locked}
          onBlur={e => { if ((item.todayLog?.note ?? '') !== e.target.value) onNote(item, e.target.value) }}
          placeholder="+ note for the cook"
          className={`w-full mt-1 text-[11.5px] text-ink-2 bg-transparent border-0 border-b border-dashed ${item.todayLog?.note ? 'border-line-2' : 'border-transparent'} py-0.5 outline-none placeholder:text-ink-4`}
        />
      </div>
    </div>
  )
}
