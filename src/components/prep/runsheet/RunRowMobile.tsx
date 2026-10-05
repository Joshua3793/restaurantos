'use client'
// Prep run-sheet — mobile compact row.
// Ported from mobile.jsx's MRow. Compact layout vs. the desktop RunRow.tsx
// ladder: 44px start-by column | task (name+qty, single meta line) | assignee
// chip (kitchen mode only) | Start/Lock action button.
import { Zap, X } from 'lucide-react'
import { draftQty, batchLabel } from '@/lib/prep-plan'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { AssigneeChip } from './assignee'
import { UrgencyDot, ChefNote, LateTag } from './atoms'
import { fmtMins, fmtQty, fmtClock, runState, startBySub } from '@/lib/prep-runsheet'
import { fmtDeadline, postedDeadlineMoved } from '@/lib/prep-plan'

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
  onRemove,
  showStation = true,
  showDeadline = true,
}: {
  item: PrepItemRich
  nowMin: number
  dense?: boolean
  kitchen?: boolean
  /** Off when every item is on one station. */
  showStation?: boolean
  /** Off under a step header that already states the deadline (a real move still shows). */
  showDeadline?: boolean
  // Currently-viewing cook. Not read directly here — claim-toggle logic
  // (assign to me vs. unassign) lives in the parent's onClaim handler, same
  // split as the prototype's `claimTap`. Accepted for interface parity.
  cook?: Cook | null
  onClaim: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
  onStart: (item: PrepItemRich) => void
  /** Take this item straight off the kitchen's list. Omitted for non-planners. */
  onRemove?: (item: PrepItemRich) => void
}) {
  const sb = item.startByMinutes
  const state = runState({ startBy: sb, blockedReason: item.blockedReason }, nowMin)
  const overdue = state === 'overdue'
  const sub = sb != null ? startBySub(sb, nowMin) : null
  const qty = draftQty(item) || (item.targetToday ?? item.parLevel)
  const active = item.activeMinutes ?? 0
  const passive = item.passiveMinutes ?? 0

  // Timings/station/service only. The low-stock sentence used to REPLACE this
  // line whenever the item was blocked; it now lives in the item drawer (the
  // urgency dot beside the name carries it as a tooltip), so the row keeps its
  // one useful meta line and the name keeps its width.
  const dl = item.deadlineMinutes
  const liveBy = dl != null ? fmtDeadline(dl, fmtClock) : null
  const postedBy = item.todayLog?.dueTime ?? null
  const moved = liveBy != null && postedDeadlineMoved(liveBy, postedBy)
  const batch = batchLabel(item, qty)
  // ONE meta line: amount, time, then only what the section header doesn't
  // already say (the station when there is more than one; the deadline when the
  // header isn't a step, or when the chef's posted deadline really moved).
  const metaText = [
    batch ? `${fmtQty(qty, item.unit)} · ${batch}` : fmtQty(qty, item.unit),
    // no timing on the recipe → say nothing rather than "0m"
    active > 0 || passive > 0 ? `${fmtMins(active)}${passive > 0 ? ` + ${fmtMins(passive)} ${item.passiveNote || 'rest'}` : ''}` : null,
    kitchen && showStation && item.station ? item.station : null,
    liveBy && (showDeadline || moved) ? `by ${liveBy}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    // Wrapper so Remove can hang in the gutter beside the card (see MOBILE_GUTTER
    // in RunSheetMobile). Outside is also the SAFER place on a phone: inside, the
    // only spot left is hard against the 44px Start button, and a mis-tap there
    // is a destructive action a thumb reached for by accident.
    <div className="relative">
    <div
      className={`bg-paper border border-line border-l-[3px] rounded-[11px] ${
        dense ? 'py-2 px-3' : 'py-[11px] px-[13px]'
      } ${ACCENT_CLASS[state]}`}
    >
    <div className="flex items-center gap-3">
      {/* start-by time — and, in kitchen mode, the claim button under it: the
          time column has height to spare, the name column has no width to spare. */}
      <div className="w-11 shrink-0">
        {sb != null ? (
          <>
            <div
              className={`font-mono text-[12.5px] font-semibold tracking-[-0.01em] ${
                overdue ? 'text-red' : 'text-ink'
              }`}
            >
              {fmtClock(sb)}
            </div>
            {sub?.text && (
              <div
                className={`font-mono text-[8.5px] mt-px whitespace-nowrap ${
                  sub.late ? 'text-red-text' : 'text-ink-4'
                }`}
              >
                {sub.text}
              </div>
            )}
          </>
        ) : (
          <div className="font-mono text-[12.5px] font-semibold text-ink-4">—</div>
        )}
        {kitchen && (
          <div className="mt-1.5">
            <AssigneeChip cook={item.assignedCook} size="sm" compact onClick={() => onClaim(item)} />
          </div>
        )}
      </div>

      {/* task — the name wraps rather than truncating; it is the one thing a cook
          must always be able to read. */}
      <div onClick={() => onOpenRecipe(item)} className="flex-1 min-w-0 cursor-pointer">
        <div className="flex items-center gap-1.5">
          <UrgencyDot item={item} />
          <div className="text-[13.5px] font-semibold tracking-[-0.01em] break-words min-w-0">
            {item.name}
          </div>
          <LateTag item={item} nowMin={nowMin} />
        </div>
        <div className={`font-mono text-[9.5px] text-ink-3 ${dense ? 'mt-px' : 'mt-[3px]'}`}>
          {metaText}
          {moved && <span className="text-gold-2"> · posted by {postedBy}</span>}
        </div>
      </div>

      {/* Borderless/quiet at rest (Undo is the safety net, not a confirm step) and
          narrower than a square tap target so it gives width back to the name
          column — the one thing a cook must always be able to read — while
          keeping the tappable height at 44px. */}
      {/* Stock-out / blocked items are NOT gated — the urgency dot flags the risk and the
          drawer spells it out, but the cook can still start (uncounted stock, or prepping
          toward a restock). */}
      <button
        onClick={() => onStart(item)}
        aria-label={`Start ${item.name}`}
        // Soft gold, not a black square: on a phone list of twenty rows the ink
        // buttons were the loudest thing on screen. Same tint family as the
        // brand's gold pills; the gold-2 bolt keeps it readable as the action.
        className="w-11 h-11 rounded-[10px] bg-gold-soft border border-gold/40 grid place-items-center cursor-pointer shrink-0 active:bg-gold/25"
      >
        <Zap size={16} strokeWidth={2.4} className="text-gold-2" />
      </button>
    </div>
      {/* The chef's note runs the card's width under the name column, so a real
          sentence reads in two lines instead of six. */}
      <ChefNote note={item.todayLog?.note} compact className="mt-2 ml-14" />
    </div>
      {onRemove && (
        <button
          onClick={() => onRemove(item)}
          aria-label={`Remove ${item.name} from the list`}
          // h-11: 44px of thumb, in a 22px-wide gutter. Height is free here —
          // it costs no horizontal space and the 7px row gap keeps it clear of
          // the neighbouring rows.
          className="absolute top-1/2 -translate-y-1/2 -right-[22px] w-[22px] h-11 grid place-items-center cursor-pointer text-ink-4/70 hover:text-red bg-transparent border-none"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}
