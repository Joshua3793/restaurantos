'use client'
// Prep run-sheet — desktop in-progress rail (horizontal live-timer cards).
// Ported from desktop.jsx's DRailCard. One card per item already filtered to
// todayLog.status === 'IN_PROGRESS' by the parent; each shows a flame badge,
// name + qty, a pulsing elapsed/remaining line, the assignee chip, and a
// "Done" button that opens the log-yield flow.
import { Flame, RotateCcw } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { AssigneeChip } from './assignee'
import { IcCheck } from '@/components/prep/icons'
import { minutesBetween, fmtDuration } from '@/lib/prep-runsheet'

// Local port of the prototype's `ptFmtQ` (same rule RunRow.tsx uses for its
// ladder rows: kg/L show one decimal only when fractional, everything else
// rounds to a whole number). Kept local rather than shared since no existing
// helper in prep-utils.ts/utils.ts matches this exact rounding rule.
function fmtQty(q: number, u: string): string {
  const v = (u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)
  return `${v} ${u}`
}

export function InProgressRail({
  items,
  nowMs,
  onLog,
  onStop,
  onOpenRecipe,
}: {
  items: PrepItemRich[]
  nowMs: number
  // Accepted for interface parity with the brief (each card's assignee is
  // already resolved on the item via `assignedCook`, so the roster itself
  // isn't needed here — unlike RunRow, this card has no claim popover).
  cooks?: Cook[]
  onLog: (item: PrepItemRich) => void
  /** Abandon an in-progress prep (no yield logged) → back onto the run sheet. */
  onStop: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  return (
    <div className="flex gap-2.5 overflow-x-auto pb-1">
      {items.map(item => (
        <RailCard key={item.id} item={item} nowMs={nowMs} onLog={onLog} onStop={onStop} onOpenRecipe={onOpenRecipe} />
      ))}
    </div>
  )
}

function RailCard({
  item,
  nowMs,
  onLog,
  onStop,
  onOpenRecipe,
}: {
  item: PrepItemRich
  nowMs: number
  onLog: (item: PrepItemRich) => void
  onStop: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  const startedAt = item.todayLog?.startedAt
  const elapsed = startedAt ? minutesBetween(new Date(startedAt).getTime(), nowMs) : 0
  const remaining = (item.activeMinutes ?? 0) + (item.passiveMinutes ?? 0) - elapsed
  const qty = item.suggestedQty ?? item.targetToday ?? item.parLevel

  return (
    <div className="flex items-center gap-3 bg-gold-soft border border-[#fcd34d] rounded-xl px-[13px] py-2.5 min-w-[300px] shrink-0">
      <span className="w-[30px] h-[30px] rounded-[9px] bg-ink grid place-items-center shrink-0">
        <Flame size={16} className="text-gold" />
      </span>
      <span onClick={() => onOpenRecipe(item)} className="flex-1 min-w-0 cursor-pointer">
        <span className="block text-[13.5px] font-semibold tracking-[-0.01em] whitespace-nowrap overflow-hidden text-ellipsis">
          {item.name} <span className="font-mono text-[10.5px] font-normal text-gold-2">{fmtQty(qty, item.unit)}</span>
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-gold-2 mt-[3px] whitespace-nowrap">
          <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse shrink-0" />
          {fmtDuration(elapsed)} in ·{' '}
          {remaining >= 0 ? (
            `~${fmtDuration(remaining)} to go`
          ) : (
            <b className="text-red-text font-semibold">over by {fmtDuration(-remaining)}</b>
          )}
        </span>
      </span>
      <AssigneeChip cook={item.assignedCook} size="sm" />
      {/* Stop = abandon this in-progress prep (no yield logged) → back onto the run sheet.
          Sits beside Done so a mistakenly-started item can be backed out without the drawer. */}
      <button
        onClick={() => onStop(item)}
        title="Stop prep — back to the run sheet"
        className="inline-flex items-center gap-[5px] bg-paper text-ink-2 border border-line rounded-[9px] px-2.5 py-2 text-[12px] font-semibold cursor-pointer shrink-0 hover:border-ink-3"
      >
        <RotateCcw size={13} /> Stop
      </button>
      <button
        onClick={() => onLog(item)}
        className="inline-flex items-center gap-[5px] bg-ink text-paper border-none rounded-[9px] px-3 py-2 text-[12px] font-semibold cursor-pointer shrink-0"
      >
        <IcCheck size={13} className="text-gold" strokeWidth={2.8} /> Done
      </button>
    </div>
  )
}
