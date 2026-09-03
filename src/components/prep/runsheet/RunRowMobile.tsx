'use client'
// Prep run-sheet — mobile compact row.
// Ported from mobile.jsx's MRow. Compact layout vs. the desktop RunRow.tsx
// ladder: 44px start-by column | task (name+qty, single meta line) | assignee
// chip (kitchen mode only) | Start/Lock action button.
import { Zap } from 'lucide-react'
import { draftQty, batchLabel } from '@/lib/prep-plan'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { AssigneeChip } from './assignee'
import { UrgencyDot } from './atoms'
import { fmtStartBy, fmtMins, fmtQty, runState } from '@/lib/prep-runsheet'

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
  const state = runState({ startBy: sb, blockedReason: item.blockedReason }, nowMin)
  const overdue = state === 'overdue'
  const late = sb != null ? nowMin - sb : 0
  const qty = draftQty(item) || (item.targetToday ?? item.parLevel)
  const active = item.activeMinutes ?? 0
  const passive = item.passiveMinutes ?? 0

  // Timings/station/service only. The low-stock sentence used to REPLACE this
  // line whenever the item was blocked; it now lives in the item drawer (the
  // urgency dot beside the name carries it as a tooltip), so the row keeps its
  // one useful meta line and the name keeps its width.
  const metaText = [
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

      {/* task — the name wraps rather than truncating; it is the one thing a cook
          must always be able to read. */}
      <div onClick={() => onOpenRecipe(item)} className="flex-1 min-w-0 cursor-pointer">
        <div className="flex items-center gap-1.5">
          <UrgencyDot item={item} />
          <div className="text-[13.5px] font-semibold tracking-[-0.01em] break-words min-w-0">
            {item.name} <span className="font-mono text-[10.5px] font-normal text-ink-3 whitespace-nowrap">{(() => { const b = batchLabel(item, qty); return b ? `${b} · ${fmtQty(qty, item.unit)}` : fmtQty(qty, item.unit) })()}</span>
          </div>
        </div>
        {/* Claim chip rides the meta line rather than holding its own column — on a
            phone that column cost the name ~80px of width, i.e. two extra wrapped
            lines on any real prep name. stopPropagation so tapping it claims the
            item instead of opening the recipe. */}
        <div className={`flex items-center gap-2 flex-wrap font-mono text-[9.5px] text-ink-3 ${dense ? 'mt-px' : 'mt-[3px]'}`}>
          <span>{metaText}</span>
          {kitchen && (
            <span onClick={e => e.stopPropagation()}>
              <AssigneeChip cook={item.assignedCook} size="sm" onClick={() => onClaim(item)} />
            </span>
          )}
        </div>
      </div>

      {/* Stock-out / blocked items are NOT gated — the urgency dot flags the risk and the
          drawer spells it out, but the cook can still start (uncounted stock, or prepping
          toward a restock). */}
      <button
        onClick={() => onStart(item)}
        className="w-11 h-11 rounded-[10px] bg-ink border-none grid place-items-center cursor-pointer shrink-0"
      >
        <Zap size={15} className="text-gold" />
      </button>
    </div>
  )
}
