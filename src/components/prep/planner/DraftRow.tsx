'use client'
// Smart Prep v2 — right-pane draft row (design PPDraftRow): qty stepper,
// priority picker, assign pill, note-for-the-cook, drag handle.
import { GripVertical, Minus, Plus, X } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import { effectivePriority, suggestedDraftQty, draftQty, prepStep } from '@/lib/prep-plan'
import { fmtClock, fmtMins } from '@/lib/prep-runsheet'
import { PrioPicker, AssignPill } from './atoms'

const fmtQ = (q: number, u: string) => `${(u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)} ${u}`

export function DraftRow({
  item, cooks, locked, dragging, over,
  onQty, onNote, onAssign, onPriorityChange, onRemove, onOpen,
  onDragStart, onDragOver, onDrop, onDragEnd,
}: {
  item: PrepItemRich
  cooks: Cook[]
  locked: boolean
  dragging: boolean
  over: boolean
  onQty: (item: PrepItemRich, qty: number) => void
  onNote: (item: PrepItemRich, note: string) => void
  onAssign: (item: PrepItemRich, cookId: string | null) => void
  onPriorityChange: (id: string, prio: string) => void
  onRemove: (item: PrepItemRich) => void
  onOpen: (item: PrepItemRich) => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}) {
  const p = effectivePriority(item)
  const sugg = suggestedDraftQty(item)
  const qty = draftQty(item)
  const step = prepStep(item.unit)
  const overridden = sugg > 0 && Math.abs(qty - sugg) > 0.01
  return (
    <div
      draggable={!locked}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`bg-paper border border-line rounded-[10px] pt-2 pb-[7px] px-2.5 border-l-[3px] ${dragging ? 'opacity-35' : ''} ${over ? 'shadow-[0_-2px_0_#09090b]' : ''}`}
      style={{ borderLeftColor: p === '911' ? '#dc2626' : p === 'NEEDED_TODAY' ? '#d97706' : '#16a34a' }}
    >
      <div className="flex items-center gap-2">
        <span
          title={locked ? 'Chef only' : 'Drag to reorder within this priority'}
          className={`shrink-0 ${locked ? 'opacity-35' : 'cursor-grab'}`}
        >
          <GripVertical size={13} className="text-ink-4" />
        </span>
        <button type="button" onClick={() => onOpen(item)} className="flex-1 min-w-0 flex items-center gap-1.5 text-left">
          <span className="text-[13px] font-semibold tracking-[-0.01em] text-ink truncate">{item.name}</span>
          {item.station && <span className="font-mono text-[9px] font-medium uppercase tracking-[0.04em] bg-bg-2 text-ink-2 px-1.5 py-0.5 rounded whitespace-nowrap shrink-0">{item.station}</span>}
          {item.isBlocked && <span className="font-mono text-[9px] font-bold uppercase bg-gold-soft text-gold-2 px-1.5 py-0.5 rounded-full shrink-0">BLOCKED</span>}
        </button>
        <div className="inline-flex items-center bg-bg-2 border border-line rounded-lg shrink-0">
          <button type="button" disabled={locked} onClick={() => onQty(item, Math.max(step, +(qty - step).toFixed(2)))}
            className={`w-[26px] h-7 grid place-items-center ${locked ? 'cursor-not-allowed' : ''}`}>
            <Minus size={12} className={locked ? 'text-ink-4' : 'text-ink-2'} />
          </button>
          <span className={`min-w-[50px] text-center font-mono text-[12px] font-bold ${overridden ? 'text-gold-2' : 'text-ink'}`}>{fmtQ(qty, item.unit)}</span>
          <button type="button" disabled={locked} onClick={() => onQty(item, +(qty + step).toFixed(2))}
            className={`w-[26px] h-7 grid place-items-center ${locked ? 'cursor-not-allowed' : ''}`}>
            <Plus size={12} className={locked ? 'text-ink-4' : 'text-ink-2'} />
          </button>
        </div>
        <PrioPicker item={item} locked={locked} onChange={prio => onPriorityChange(item.id, prio)} />
        <AssignPill cookId={item.todayLog?.assignedTo ?? null} cooks={cooks} locked={locked} onAssign={id => onAssign(item, id)} />
        <button type="button" disabled={locked} onClick={() => onRemove(item)} title="Take off the list"
          className="w-6 h-6 rounded-[7px] grid place-items-center shrink-0">
          <X size={13} className={locked ? 'text-line-2' : 'text-ink-4'} />
        </button>
      </div>
      <div className="flex items-center gap-2.5 mt-[5px] pl-[18px]">
        <input
          key={item.todayLog?.id ?? item.id}
          defaultValue={item.todayLog?.note ?? ''}
          disabled={locked}
          onBlur={e => { if ((item.todayLog?.note ?? '') !== e.target.value) onNote(item, e.target.value) }}
          placeholder="+ note for the cook"
          className={`flex-1 min-w-0 text-[11.5px] text-ink-2 bg-transparent border-0 border-b border-dashed ${item.todayLog?.note ? 'border-line-2' : 'border-transparent'} py-0.5 outline-none placeholder:text-ink-4`}
        />
        <span className="font-mono text-[9px] text-ink-4 whitespace-nowrap shrink-0">
          {overridden
            ? <button type="button" disabled={locked} onClick={() => onQty(item, sugg)} className="font-mono text-[9px] font-bold text-gold-2">SUGG {fmtQ(sugg, item.unit)} ↺</button>
            : <span className="font-semibold text-ink-3">SMART QTY</span>}
          {item.startByMinutes != null && <> · START {fmtClock(item.startByMinutes)}</>}
          {item.activeMinutes != null && <> · {fmtMins(item.activeMinutes)}</>}
          {item.service && <> · {item.service.name.toUpperCase()}</>}
        </span>
      </div>
    </div>
  )
}
