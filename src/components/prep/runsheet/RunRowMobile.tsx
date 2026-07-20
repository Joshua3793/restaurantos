'use client'
// Prep run-sheet — mobile compact row.
// Ported from mobile.jsx's MRow. Compact layout vs. the desktop RunRow.tsx
// ladder: 44px start-by column | task (name+qty, single meta line) | assignee
// chip (kitchen mode only) | Start/Lock action button.
import { Zap } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { AssigneeChip } from './assignee'
import { fmtClock, fmtStartBy, fmtMins, runState } from '@/lib/prep-runsheet'

// Local port of the prototype's `ptFmtQ` — kg/L show one decimal only when
// fractional, everything else rounds to a whole number. Same rule as
// RunRow.tsx/InProgressRail.tsx; kept local since no shared helper matches it.
function fmtQty(q: number, u: string): string {
  const v = (u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)
  return `${v} ${u}`
}

const ACCENT_CLASS: Record<ReturnType<typeof runState>, string> = {
  blocked: 'border-l-gold',
  overdue: 'border-l-red',
  soon: 'border-l-ink',
  later: 'border-l-line-2',
}

export function RunRowMobile({
  item,
  nowMin,
  dense = false,
  kitchen = false,
  cook,
  onClaim,
  onOpenRecipe,
  onStart,
}: {
  item: PrepItemRich
  nowMin: number
  dense?: boolean
  kitchen?: boolean
  // Currently-viewing cook. Not read directly here — claim-toggle logic
  // (assign to me vs. unassign) lives in the parent's onClaim handler, same
  // split as the prototype's `claimTap`. Accepted for interface parity.
  cook?: Cook | null
  onClaim: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
  onStart: (item: PrepItemRich) => void
}) {
  const sb = item.startByMinutes
  const blocked = item.isBlocked || !!item.blockedReason
  const state = runState({ startBy: sb, blockedReason: item.blockedReason }, nowMin)
  const overdue = state === 'overdue'
  const late = sb != null ? nowMin - sb : 0
  const qty = item.suggestedQty ?? item.targetToday ?? item.parLevel
  const active = item.activeMinutes ?? 0
  const passive = item.passiveMinutes ?? 0

  const metaText = blocked
    ? (item.blockedReason ?? 'low stock')
    : [
        `${fmtMins(active)}${passive > 0 ? ` + ${fmtMins(passive)} ${item.passiveNote || 'rest'}` : ''}`,
        kitchen && item.station ? item.station : null,
        item.service ? `for ${item.service.name}` : null,
      ]
        .filter(Boolean)
        .join(' · ')

  return (
    <div
      className={`flex items-center gap-3 bg-paper border border-line border-l-[3px] rounded-[11px] ${
        dense ? 'py-2 px-3' : 'py-[11px] px-[13px]'
      } ${ACCENT_CLASS[state]}`}
    >
      {/* start-by time */}
      <div className="w-11 shrink-0">
        {sb != null ? (
          <>
            <div
              className={`font-mono text-[12.5px] font-semibold tracking-[-0.01em] ${
                overdue ? 'text-red' : 'text-ink'
              }`}
            >
              {fmtStartBy(sb)}
            </div>
            <div
              className={`font-mono text-[8.5px] mt-px whitespace-nowrap ${
                overdue ? 'text-red-text' : 'text-ink-4'
              }`}
            >
              {overdue ? `${fmtMins(late)} late` : `in ${fmtMins(-late)}`}
            </div>
          </>
        ) : (
          <div className="font-mono text-[12.5px] font-semibold text-ink-4">—</div>
        )}
      </div>

      {/* task */}
      <div onClick={() => onOpenRecipe(item)} className="flex-1 min-w-0 cursor-pointer">
        <div className="text-[13.5px] font-semibold tracking-[-0.01em] whitespace-nowrap overflow-hidden text-ellipsis">
          {item.name} <span className="font-mono text-[10.5px] font-normal text-ink-3">{fmtQty(qty, item.unit)}</span>
        </div>
        <div
          className={`font-mono text-[9.5px] whitespace-nowrap overflow-hidden text-ellipsis ${
            blocked ? 'text-gold-2' : 'text-ink-3'
          } ${dense ? 'mt-px' : 'mt-[3px]'}`}
        >
          {metaText}
        </div>
      </div>

      {kitchen && <AssigneeChip cook={item.assignedCook} size="sm" onClick={() => onClaim(item)} />}

      {/* Stock-out / blocked items are NOT gated — the meta line already flags the risk,
          but the cook can still start (uncounted stock, or prepping toward a restock). */}
      <button
        onClick={() => onStart(item)}
        className="w-11 h-11 rounded-[10px] bg-ink border-none grid place-items-center cursor-pointer shrink-0"
      >
        <Zap size={15} className="text-gold" />
      </button>
    </div>
  )
}
