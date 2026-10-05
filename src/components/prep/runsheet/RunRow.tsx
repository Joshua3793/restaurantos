'use client'
// Prep run-sheet — desktop ladder row.
// Ported from desktop.jsx's DRow (+ its inline claim popover, now the shared
// ClaimPopover atom). Grid: 1fr task | auto assignee + action. No start-by
// clock: the step and the chef's order say what comes next.
import { useRef, useState } from 'react'
import { Zap, X } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { AssigneeChip, ClaimPopover } from './assignee'
import { StationTag, RunwayBar, UrgencyDot, ChefNote } from './atoms'
import { fmtQty } from '@/lib/prep-runsheet'
import { draftQty, batchLabel, effectiveUrgency, PLAN_URG_META } from '@/lib/prep-plan'

export function RunRow({
  item,
  cooks,
  onStart,
  onOpenRecipe,
  onClaim,
  onRemove,
  dense = false,
  showStation = true,
}: {
  item: PrepItemRich
  cooks: Cook[]
  onStart: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
  onClaim: (item: PrepItemRich, cookId: string | null) => void
  /** Take this item straight off the kitchen's list. Omitted (not just
   *  disabled) for anyone who cannot plan — that is what hides the button. */
  onRemove?: (item: PrepItemRich) => void
  dense?: boolean
  /** Off when every item is on one station, or the list is already filtered to one. */
  showStation?: boolean
}) {
  const [claimOpen, setClaimOpen] = useState(false)
  const claimAnchor = useRef<HTMLDivElement>(null)

  // Left accent = the item's step colour; gold when something blocks it.
  const accent = item.blockedReason ? undefined : PLAN_URG_META[effectiveUrgency(item)].hex
  // Planned qty: the chef's posted requiredQty wins, then the live suggestion.
  const qty = draftQty(item) || (item.targetToday ?? item.parLevel)
  const batch = batchLabel(item, qty)

  // Below lg (iPad portrait, and landscape before the sidebar docks) the row
  // stacks: name on the first line, the claim/Start cluster on a second.
  return (
    // The card sits inside a wrapper so Remove can hang in the gutter BESIDE it
    // rather than inside the action cluster. The gutter is reserved by the row
    // containers in RunSheet (see RUN_GUTTER), so the button is visually outside
    // the bar without ever overflowing the sheet.
    <div className="relative">
    <div
      className={`grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 bg-paper border border-line border-l-[3px] rounded-[11px] relative ${
        dense ? 'py-2 px-4' : 'py-[13px] px-4'
      } ${item.blockedReason ? 'border-l-gold' : ''}`}
      style={accent ? { borderLeftColor: accent } : undefined}
    >
      {/* task — the name owns its own line and NEVER truncates (it is the one
          thing a cook has to be able to read). Everything else wraps beneath it,
          so a narrow frame (iPad portrait/landscape, split desktop) costs a row
          of height rather than the end of the name. */}
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <UrgencyDot item={item} />
          <span
            onClick={() => onOpenRecipe(item)}
            title="Open recipe"
            className="text-[14px] font-semibold tracking-[-0.015em] break-words cursor-pointer underline decoration-line-2 underline-offset-[3px]"
          >
            {item.name}
          </span>
        </div>
        <div className="flex items-center gap-x-3.5 gap-y-1 flex-wrap mt-1">
          <span className="font-mono text-[11px] text-ink-3">{batch ? `${fmtQty(qty, item.unit)} · ${batch}` : fmtQty(qty, item.unit)}</span>
          {showStation && item.station && <StationTag>{item.station}</StationTag>}
          {!dense && <RunwayBar activeMin={item.activeMinutes} passiveMin={item.passiveMinutes} passiveNote={item.passiveNote} />}
        </div>
        <ChefNote note={item.todayLog?.note} compact={dense} className="mt-2" />
      </div>

      {/* assignee + actions — one cluster so it can drop to its own line under the
          name on a narrow frame. A stock-out / blocked item is NOT gated: the
          urgency dot flags the risk and the drawer spells it out, but the cook can
          still start it (uncounted stock, or prepping toward a later restock). */}
      <div className="col-start-1 lg:col-start-2 flex items-center gap-[7px] justify-start lg:justify-end">
        <div ref={claimAnchor} className="relative shrink-0">
          <AssigneeChip cook={item.assignedCook} compact onClick={() => setClaimOpen(o => !o)} />
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
        <button
          onClick={() => onStart(item)}
          className="inline-flex items-center gap-1.5 bg-ink text-paper border-none rounded-[9px] px-3.5 py-2 text-[12.5px] font-semibold cursor-pointer shrink-0"
        >
          <Zap size={12} className="text-gold" /> Start
        </button>
      </div>
    </div>
      {onRemove && (
        // Off the card entirely, past its right edge and clear of Start: it is
        // destructive (Undo is the only safety net — there is no confirm step),
        // so it must never sit where a thumb aiming for Start can land. Quiet at
        // rest, and only signals on hover.
        <button
          onClick={() => onRemove(item)}
          title="Remove from the list"
          aria-label={`Remove ${item.name} from the list`}
          className="absolute top-1/2 -translate-y-1/2 -right-[30px] w-[26px] h-[26px] rounded-[7px] bg-transparent border-none grid place-items-center cursor-pointer text-ink-4/70 hover:text-red hover:bg-red-soft transition-colors"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}
