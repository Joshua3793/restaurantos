'use client'
// Prep run-sheet — mobile in-progress rail (horizontal live-timer cards).
// Ported from mobile.jsx's MRailCard. Same data/timer math as the desktop
// InProgressRail.tsx card, but a taller two-row layout (icon+name+qty row,
// then elapsed/remaining + Done button row) sized for a narrow viewport.
import { Flame } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import { AssigneeChip } from './assignee'
import { IcCheck } from '@/components/prep/icons'
import { minutesBetween, fmtDuration } from '@/lib/prep-runsheet'

// Local port of the prototype's `ptFmtQ` — same rule as RunRowMobile.tsx /
// RunRow.tsx / InProgressRail.tsx.
function fmtQty(q: number, u: string): string {
  const v = (u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)
  return `${v} ${u}`
}

export function InProgressRailMobile({
  items,
  nowMs,
  onLog,
  onOpenRecipe,
}: {
  items: PrepItemRich[]
  nowMs: number
  onLog: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {items.map(item => (
        <RailCardMobile key={item.id} item={item} nowMs={nowMs} onLog={onLog} onOpenRecipe={onOpenRecipe} />
      ))}
    </div>
  )
}

function RailCardMobile({
  item,
  nowMs,
  onLog,
  onOpenRecipe,
}: {
  item: PrepItemRich
  nowMs: number
  onLog: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  const startedAt = item.todayLog?.startedAt
  const elapsed = startedAt ? minutesBetween(new Date(startedAt).getTime(), nowMs) : 0
  const remaining = (item.activeMinutes ?? 0) + (item.passiveMinutes ?? 0) - elapsed
  const qty = item.suggestedQty ?? item.targetToday ?? item.parLevel

  return (
    <div className="flex flex-col gap-[9px] bg-gold-soft border border-[#fcd34d] rounded-[13px] px-[13px] py-[11px] min-w-[228px] shrink-0">
      <div onClick={() => onOpenRecipe(item)} className="flex items-center gap-[9px] cursor-pointer">
        <span className="w-7 h-7 rounded-lg bg-ink grid place-items-center shrink-0">
          <Flame size={15} className="text-gold" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold tracking-[-0.01em] whitespace-nowrap overflow-hidden text-ellipsis">
            {item.name}
          </span>
          <span className="block font-mono text-[9.5px] text-gold-2 mt-0.5">{fmtQty(qty, item.unit)}</span>
        </span>
        <AssigneeChip cook={item.assignedCook} size="sm" />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-gold-2 whitespace-nowrap">
          <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse shrink-0" />
          {fmtDuration(elapsed)} ·{' '}
          {remaining >= 0 ? (
            `~${fmtDuration(remaining)} left`
          ) : (
            <b className="text-red-text font-semibold">over {fmtDuration(-remaining)}</b>
          )}
        </span>
        <button
          onClick={() => onLog(item)}
          className="inline-flex items-center gap-1 bg-ink text-paper border-none rounded-[8px] px-[11px] py-[7px] text-[12px] font-semibold cursor-pointer shrink-0"
        >
          <IcCheck size={12} className="text-gold" strokeWidth={2.8} /> Done
        </button>
      </div>
    </div>
  )
}
