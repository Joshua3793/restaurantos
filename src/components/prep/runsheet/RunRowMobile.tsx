'use client'
// Prep run-sheet — mobile compact row.
// Ported from mobile.jsx's MRow. Compact layout vs. the desktop RunRow.tsx
// ladder: assignee chip (kitchen mode only) | task (name+qty, single meta line)
// | Start/Lock action button. No start-by clock: the step and the chef's order
// say what comes next.
import { Zap, X } from 'lucide-react'
import { draftQty, batchLabel, effectiveUrgency, PLAN_URG_META } from '@/lib/prep-plan'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { AssigneeChip } from './assignee'
import { UrgencyDot, ChefNote } from './atoms'
import { fmtMins, fmtQty } from '@/lib/prep-runsheet'

export function RunRowMobile({
  item,
  dense = false,
  kitchen = false,
  cook,
  onClaim,
  onOpenRecipe,
  onStart,
  onRemove,
  showStation = true,
}: {
  item: PrepItemRich
  dense?: boolean
  kitchen?: boolean
  /** Off when every item is on one station. */
  showStation?: boolean
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
  // Left accent = the item's step colour; gold when something blocks it.
  const accent = item.blockedReason ? undefined : PLAN_URG_META[effectiveUrgency(item)].hex
  const qty = draftQty(item) || (item.targetToday ?? item.parLevel)
  const active = item.activeMinutes ?? 0
  const passive = item.passiveMinutes ?? 0

  // Timings/station/service only. The low-stock sentence used to REPLACE this
  // line whenever the item was blocked; it now lives in the item drawer (the
  // urgency dot beside the name carries it as a tooltip), so the row keeps its
  // one useful meta line and the name keeps its width.
  const batch = batchLabel(item, qty)
  // ONE meta line: amount, time, then the station when there is more than one.
  const metaText = [
    batch ? `${fmtQty(qty, item.unit)} · ${batch}` : fmtQty(qty, item.unit),
    // no timing on the recipe → say nothing rather than "0m"
    active > 0 || passive > 0 ? `${fmtMins(active)}${passive > 0 ? ` + ${fmtMins(passive)} ${item.passiveNote || 'rest'}` : ''}` : null,
    kitchen && showStation && item.station ? item.station : null,
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
      } ${item.blockedReason ? 'border-l-gold' : ''}`}
      style={accent ? { borderLeftColor: accent } : undefined}
    >
    <div className="flex items-center gap-3">
      {/* kitchen mode: the claim button leads the row */}
      {kitchen && (
        <div className="shrink-0">
          <AssigneeChip cook={item.assignedCook} size="sm" compact onClick={() => onClaim(item)} />
        </div>
      )}

      {/* task — the name wraps rather than truncating; it is the one thing a cook
          must always be able to read. */}
      <div onClick={() => onOpenRecipe(item)} className="flex-1 min-w-0 cursor-pointer">
        <div className="flex items-center gap-1.5">
          <UrgencyDot item={item} />
          <div className="text-[13.5px] font-semibold tracking-[-0.01em] break-words min-w-0">
            {item.name}
          </div>
        </div>
        <div className={`font-mono text-[9.5px] text-ink-3 ${dense ? 'mt-px' : 'mt-[3px]'}`}>
          {metaText}
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
