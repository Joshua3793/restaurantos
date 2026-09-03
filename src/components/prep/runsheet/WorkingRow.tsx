'use client'
// Prep run-sheet — desktop in-progress row.
//
// Replaces the old horizontal-scroll InProgressRail: an item being worked on is
// part of the list, not a widget beside it, so it uses RunRow's grid and reads
// as one more line above the ladder. Gold contrast marks it as live.
//
// The 64px column that carries start-by on a RunRow carries the live timer here
// — start-by is meaningless once a job has started, and elapsed/remaining is the
// number a cook actually wants.
import { useRef, useState } from 'react'
import { Flame, RotateCcw } from 'lucide-react'
import { draftQty, batchLabel } from '@/lib/prep-plan'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { AssigneeChip, ClaimPopover } from './assignee'
import { StationTag } from './atoms'
import { IcCheck, IcRecipe } from '@/components/prep/icons'
import { minutesBetween, fmtMins, fmtQty } from '@/lib/prep-runsheet'

export function WorkingRow({
  item,
  nowMs,
  cooks,
  onClaim,
  onLog,
  onStop,
  onOpenRecipe,
}: {
  item: PrepItemRich
  nowMs: number
  cooks: Cook[]
  onClaim?: (item: PrepItemRich, cookId: string | null) => void
  onLog: (item: PrepItemRich) => void
  /** Abandon an in-progress prep (no yield logged) → back onto the run sheet. */
  onStop: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  const [claimOpen, setClaimOpen] = useState(false)
  const claimAnchor = useRef<HTMLDivElement>(null)

  const startedAt = item.todayLog?.startedAt
  const elapsed = startedAt ? minutesBetween(new Date(startedAt).getTime(), nowMs) : 0
  const remaining = (item.activeMinutes ?? 0) + (item.passiveMinutes ?? 0) - elapsed
  const qty = draftQty(item) || (item.targetToday ?? item.parLevel)
  const batch = batchLabel(item, qty)

  // Same lg: stacking rule the ladder rows follow — below lg the action cluster
  // drops to its own line rather than squeezing the name column.
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] lg:grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 bg-gold-soft border border-[#fcd34d] border-l-[3px] border-l-gold rounded-[11px] py-[13px] px-4">
      {/* live timer — where start-by sits on a RunRow */}
      <div className="self-start lg:self-center">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse shrink-0" />
          <span className="font-mono text-[14px] font-semibold tracking-[-0.01em] text-ink">
            {fmtMins(elapsed)}
          </span>
        </div>
        <div
          className={`font-mono text-[9px] mt-0.5 whitespace-nowrap ${
            remaining >= 0 ? 'text-gold-2' : 'text-red-text font-semibold'
          }`}
        >
          {remaining >= 0 ? `~${fmtMins(remaining)} to go` : `over by ${fmtMins(-remaining)}`}
        </div>
      </div>

      {/* task — the name never truncates; it is the one thing a cook must read. */}
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-[22px] h-[22px] rounded-[7px] bg-ink grid place-items-center shrink-0">
            <Flame size={13} className="text-gold" />
          </span>
          <span
            onClick={() => onOpenRecipe(item)}
            title="Open recipe"
            className="text-[14px] font-semibold tracking-[-0.015em] break-words cursor-pointer underline decoration-[#fcd34d] underline-offset-[3px]"
          >
            {item.name}
          </span>
        </div>
        <div className="flex items-center gap-x-3.5 gap-y-1 flex-wrap mt-1">
          <span className="font-mono text-[11px] text-gold-2">
            {batch ? `${batch} · ${fmtQty(qty, item.unit)}` : fmtQty(qty, item.unit)}
          </span>
          {item.station && <StationTag>{item.station}</StationTag>}
        </div>
      </div>

      {/* claim · recipe · stop · done */}
      <div className="col-start-2 lg:col-start-3 flex items-center gap-[7px] justify-start lg:justify-end">
        {onClaim ? (
          <div ref={claimAnchor} className="relative shrink-0">
            <AssigneeChip cook={item.assignedCook} onClick={() => setClaimOpen(o => !o)} />
            {claimOpen && (
              <ClaimPopover
                anchorRef={claimAnchor}
                cooks={cooks}
                currentId={item.assignedCook?.id ?? null}
                onPick={cookId => {
                  onClaim(item, cookId)
                  setClaimOpen(false)
                }}
                onClose={() => setClaimOpen(false)}
              />
            )}
          </div>
        ) : (
          <AssigneeChip cook={item.assignedCook} />
        )}
        <button
          onClick={() => onOpenRecipe(item)}
          title="Recipe"
          className="w-[34px] h-[34px] rounded-[9px] bg-paper border border-[#fcd34d] grid place-items-center cursor-pointer shrink-0 text-ink-2"
        >
          <IcRecipe size={15} />
        </button>
        <button
          onClick={() => onStop(item)}
          title="Stop prep — back to the run sheet"
          className="inline-flex items-center gap-[5px] bg-paper text-ink-2 border border-[#fcd34d] rounded-[9px] px-3 py-2 text-[12.5px] font-semibold cursor-pointer shrink-0 hover:border-ink-3"
        >
          <RotateCcw size={13} /> Stop
        </button>
        <button
          onClick={() => onLog(item)}
          className="inline-flex items-center gap-1.5 bg-ink text-paper border-none rounded-[9px] px-3.5 py-2 text-[12.5px] font-semibold cursor-pointer shrink-0"
        >
          <IcCheck size={13} className="text-gold" strokeWidth={2.8} /> Done
        </button>
      </div>
    </div>
  )
}
