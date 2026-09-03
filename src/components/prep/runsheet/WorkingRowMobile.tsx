'use client'
// Prep run-sheet — mobile in-progress row.
//
// Mobile twin of WorkingRow: replaces the horizontal-scroll InProgressRailMobile
// so a live job reads as one more line in the list. Shape mirrors RunRowMobile
// (44px left column, flex-1 name + meta with the claim chip riding the meta
// line), with the timer in the left column instead of start-by.
//
// RunRowMobile has room for ONE 44px action button; this row needs two (Stop and
// Done), so there is no room for a recipe button — the name is the recipe-open
// target, exactly as it is on RunRowMobile.
import { Flame, RotateCcw } from 'lucide-react'
import { draftQty, batchLabel } from '@/lib/prep-plan'
import type { PrepItemRich } from '@/components/prep/types'
import { AssigneeChip } from './assignee'
import { IcCheck } from '@/components/prep/icons'
import { minutesBetween, fmtMins, fmtQty } from '@/lib/prep-runsheet'

export function WorkingRowMobile({
  item,
  nowMs,
  onClaim,
  onLog,
  onStop,
  onOpenRecipe,
}: {
  item: PrepItemRich
  nowMs: number
  /** Tap-to-claim (the parent's claimTap closes over the current cook). */
  onClaim?: (item: PrepItemRich) => void
  onLog: (item: PrepItemRich) => void
  /** Abandon an in-progress prep (no yield logged) → back onto the run sheet. */
  onStop: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  const startedAt = item.todayLog?.startedAt
  const elapsed = startedAt ? minutesBetween(new Date(startedAt).getTime(), nowMs) : 0
  const remaining = (item.activeMinutes ?? 0) + (item.passiveMinutes ?? 0) - elapsed
  const qty = draftQty(item) || (item.targetToday ?? item.parLevel)
  const batch = batchLabel(item, qty)

  return (
    <div className="flex items-center gap-3 bg-gold-soft border border-[#fcd34d] border-l-[3px] border-l-gold rounded-[11px] py-[11px] px-[13px]">
      {/* live timer — where start-by sits on a RunRowMobile */}
      <div className="w-11 shrink-0">
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse shrink-0" />
          <span className="font-mono text-[12.5px] font-semibold tracking-[-0.01em] text-ink">
            {fmtMins(elapsed)}
          </span>
        </div>
        <div
          className={`font-mono text-[8.5px] mt-px whitespace-nowrap ${
            remaining >= 0 ? 'text-gold-2' : 'text-red-text font-semibold'
          }`}
        >
          {remaining >= 0 ? `${fmtMins(remaining)} left` : `over ${fmtMins(-remaining)}`}
        </div>
      </div>

      {/* task — tapping the name opens the recipe (no room for a recipe button) */}
      <div onClick={() => onOpenRecipe(item)} className="flex-1 min-w-0 cursor-pointer">
        <div className="flex items-center gap-1.5">
          <span className="w-5 h-5 rounded-[6px] bg-ink grid place-items-center shrink-0">
            <Flame size={12} className="text-gold" />
          </span>
          <div className="text-[13.5px] font-semibold tracking-[-0.01em] break-words min-w-0">
            {item.name}{' '}
            <span className="font-mono text-[10.5px] font-normal text-gold-2 whitespace-nowrap">
              {batch ? `${batch} · ${fmtQty(qty, item.unit)}` : fmtQty(qty, item.unit)}
            </span>
          </div>
        </div>
        {/* stopPropagation so tapping the chip claims the item instead of opening
            the recipe (the whole block above is the recipe-open target). */}
        <div className="flex items-center gap-2 flex-wrap font-mono text-[9.5px] text-gold-2 mt-[3px]">
          {item.station && <span>{item.station}</span>}
          <span onClick={e => e.stopPropagation()}>
            <AssigneeChip cook={item.assignedCook} size="sm" onClick={onClaim ? () => onClaim(item) : undefined} />
          </span>
        </div>
      </div>

      <button
        onClick={() => onStop(item)}
        title="Stop prep — back to the run sheet"
        aria-label="Stop prep"
        className="w-11 h-11 rounded-[10px] bg-paper border border-[#fcd34d] grid place-items-center cursor-pointer shrink-0 text-ink-2"
      >
        <RotateCcw size={15} />
      </button>
      <button
        onClick={() => onLog(item)}
        aria-label="Done — log yield"
        className="w-11 h-11 rounded-[10px] bg-ink border-none grid place-items-center cursor-pointer shrink-0"
      >
        <IcCheck size={15} className="text-gold" strokeWidth={2.8} />
      </button>
    </div>
  )
}
