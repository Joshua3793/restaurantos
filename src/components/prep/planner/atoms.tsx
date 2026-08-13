'use client'
// Smart Prep v2 planner — shared atoms. Ported from the design's planner.jsx
// (PPBucketHead / PPPrioPill / PPPrioPicker / PPAssign / PPPop) with flat
// Tailwind tokens and Lucide icons.
import { useState } from 'react'
import { Pencil, ChevronDown, Undo2 } from 'lucide-react'
import type { PrepPriority } from '@/lib/prep-utils'
import { PLAN_PRIO_META, PLAN_PRIORITY_ORDER, effectivePriority, autoPriority } from '@/lib/prep-plan'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import { fmtMins } from '@/lib/prep-runsheet'

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

export function BucketHead({ p, count, mins, warn }: {
  p: PrepPriority; count: number; mins?: number | null; warn?: boolean
}) {
  const m = PLAN_PRIO_META[p]
  return (
    <div className="flex items-center gap-2 mt-3.5 mb-1.5 mx-0.5">
      <span className={`w-[7px] h-[7px] rounded-full ${m.dotClass}`} />
      <span className="font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] text-ink">{m.label}</span>
      <span className="font-mono text-[9.5px] text-ink-4">· {count}{mins != null ? ` · ${fmtMins(mins)}` : ''}</span>
      {warn
        ? <span className="ml-auto font-mono text-[9px] font-bold uppercase bg-red-soft text-red-text px-2 py-0.5 rounded-full whitespace-nowrap">Change the priority to move it</span>
        : <span className="ml-auto font-mono text-[9px] text-ink-4 truncate">{m.sub}</span>}
    </div>
  )
}

export function PrioPill({ p, override, sm }: { p: PrepPriority; override?: boolean; sm?: boolean }) {
  const m = PLAN_PRIO_META[p]
  return (
    <span className={`inline-flex items-center gap-1.5 ${m.softClass} ${m.textClass} rounded-full font-mono font-bold ${sm ? 'text-[9px] px-2 py-0.5' : 'text-[9.5px] px-2.5 py-1'} whitespace-nowrap`}>
      <span className={`w-[5px] h-[5px] rounded-full ${m.dotClass}`} />{m.label.toUpperCase()}
      {override && <Pencil size={9} />}
    </span>
  )
}

// ─── priority override control ─────────────────────────────────────────────
export function PrioPicker({ item, locked, onChange }: {
  item: PrepItemRich; locked: boolean; onChange: (prio: string) => void
}) {
  const [open, setOpen] = useState(false)
  const p = effectivePriority(item)
  const auto = autoPriority(item)
  const m = PLAN_PRIO_META[p]
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => !locked && setOpen(v => !v)}
        title={locked ? 'Chef only' : 'Set priority'}
        className={`inline-flex items-center gap-1.5 w-[92px] ${m.softClass} ${m.textClass} border ${item.manualPriorityOverride ? 'border-current' : 'border-transparent'} rounded-lg px-2 py-1.5 font-mono text-[9.5px] font-bold ${locked ? 'cursor-default' : 'cursor-pointer'}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${m.dotClass} shrink-0`} />
        <span className="flex-1 text-left">{m.label.toUpperCase()}</span>
        {item.manualPriorityOverride ? <Pencil size={10} /> : !locked && <ChevronDown size={10} />}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} w="w-52">
          <div className={popHeadCls}>Override priority</div>
          {PLAN_PRIORITY_ORDER.map(k => (
            <button key={k} type="button" onClick={() => { onChange(k === auto ? '' : k); setOpen(false) }} className={popItemCls(p === k)}>
              <span className={`w-[7px] h-[7px] rounded-full ${PLAN_PRIO_META[k].dotClass}`} />
              {PLAN_PRIO_META[k].label}
              {k === auto && <span className="ml-auto font-mono text-[9px] font-semibold text-ink-4 uppercase">Smart</span>}
            </button>
          ))}
          {item.manualPriorityOverride && (
            <button type="button" onClick={() => { onChange(''); setOpen(false) }} className={`${popItemCls(false)} border-t border-line rounded-none mt-1 pt-2.5 !text-gold-2`}>
              <Undo2 size={13} /> Back to smart ({PLAN_PRIO_META[auto].label})
            </button>
          )}
        </Popover>
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
