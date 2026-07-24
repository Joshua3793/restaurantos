'use client'
// Prep run-sheet — desktop in-progress rail (horizontal live-timer cards).
// Ported from desktop.jsx's DRailCard. One card per item already filtered to
// todayLog.status === 'IN_PROGRESS' by the parent; each shows a flame badge,
// name + qty, a pulsing elapsed/remaining line, the assignee chip, and a
// "Done" button that opens the log-yield flow.
import { useRef, useState } from 'react'
import { Flame, RotateCcw } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { AssigneeChip, ClaimPopover } from './assignee'
import { IcCheck } from '@/components/prep/icons'
import { minutesBetween, fmtMins } from '@/lib/prep-runsheet'

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
  cooks = [],
  onClaim,
  onLog,
  onStop,
  onOpenRecipe,
}: {
  items: PrepItemRich[]
  nowMs: number
  // Roster for the assignee chip's claim popover — an in-progress item can still
  // be (re)assigned, same as a ladder row.
  cooks?: Cook[]
  onClaim?: (item: PrepItemRich, cookId: string | null) => void
  onLog: (item: PrepItemRich) => void
  /** Abandon an in-progress prep (no yield logged) → back onto the run sheet. */
  onStop: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  return (
    <div className="flex gap-2.5 overflow-x-auto pb-1">
      {items.map(item => (
        <RailCard key={item.id} item={item} nowMs={nowMs} cooks={cooks} onClaim={onClaim} onLog={onLog} onStop={onStop} onOpenRecipe={onOpenRecipe} />
      ))}
    </div>
  )
}

function RailCard({
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
  onStop: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  const [claimOpen, setClaimOpen] = useState(false)
  const claimAnchor = useRef<HTMLDivElement>(null)
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
          {fmtMins(elapsed)} in ·{' '}
          {remaining >= 0 ? (
            `~${fmtMins(remaining)} to go`
          ) : (
            <b className="text-red-text font-semibold">over by {fmtMins(-remaining)}</b>
          )}
        </span>
      </span>
      {/* Assignee chip — clickable (claim popover) when an onClaim handler is wired,
          so an in-progress item can still be claimed/reassigned. Without a handler it
          falls back to a read-only chip rather than a dead "+ CLAIM" button. */}
      {onClaim ? (
        <div ref={claimAnchor} className="relative shrink-0">
          <AssigneeChip cook={item.assignedCook} size="sm" onClick={() => setClaimOpen(o => !o)} />
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
        <AssigneeChip cook={item.assignedCook} size="sm" />
      )}
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
