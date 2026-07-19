'use client'
// Prep run-sheet — desktop ladder row.
// Ported from desktop.jsx's DRow (+ its inline claim popover, now the shared
// ClaimPopover atom). Grid: 64px start-by | 1fr task | auto assignee | auto action.
import { useState } from 'react'
import { Zap } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { AssigneeChip, ClaimPopover } from './assignee'
import { StationTag, NeedChip, RunwayBar, StockOutBadge, BlockedBadge } from './atoms'
import { IcRecipe } from '@/components/prep/icons'
import { fmtClock, fmtDuration, runState } from '@/lib/prep-runsheet'

// Local port of the prototype's `ptFmtQ` — kg/L show one decimal only when
// fractional, everything else rounds to a whole number. No existing helper in
// prep-utils.ts/utils.ts matches this exact rule (formatQtyUnit up-converts
// g→kg instead), so it stays a tiny local function rather than a shared export.
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

export function RunRow({
  item,
  nowMin,
  cooks,
  onStart,
  onOpenRecipe,
  onClaim,
  dense = false,
}: {
  item: PrepItemRich
  nowMin: number
  cooks: Cook[]
  onStart: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
  onClaim: (item: PrepItemRich, cookId: string | null) => void
  dense?: boolean
}) {
  const [claimOpen, setClaimOpen] = useState(false)

  const sb = item.startByMinutes
  const blocked = item.isBlocked || !!item.blockedReason
  const state = runState({ startBy: sb, blockedReason: item.blockedReason }, nowMin)
  const late = sb != null ? nowMin - sb : 0
  const qty = item.suggestedQty ?? item.targetToday ?? item.parLevel

  return (
    <div
      className={`grid grid-cols-[64px_1fr_auto_auto] items-center gap-4 bg-paper border border-line border-l-[3px] rounded-[11px] relative ${
        dense ? 'py-2 px-4' : 'py-[13px] px-4'
      } ${ACCENT_CLASS[state]}`}
    >
      {/* start-by time */}
      <div>
        {sb != null ? (
          <>
            <div
              className={`font-mono text-[14px] font-semibold tracking-[-0.01em] ${
                state === 'overdue' ? 'text-red' : 'text-ink'
              }`}
            >
              {fmtClock(sb)}
            </div>
            <div
              className={`font-mono text-[9px] mt-0.5 whitespace-nowrap ${
                state === 'overdue' ? 'text-red-text' : 'text-ink-4'
              }`}
            >
              {state === 'overdue' ? `${fmtDuration(late)} LATE` : `in ${fmtDuration(-late)}`}
            </div>
          </>
        ) : (
          <div className="font-mono text-[14px] font-semibold text-ink-4">—</div>
        )}
      </div>

      {/* task */}
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span
            onClick={() => onOpenRecipe(item)}
            title="Open recipe"
            className="text-[14px] font-semibold tracking-[-0.015em] whitespace-nowrap overflow-hidden text-ellipsis cursor-pointer underline decoration-line-2 underline-offset-[3px]"
          >
            {item.name}
          </span>
          <span className="font-mono text-[11px] text-ink-3 whitespace-nowrap">{fmtQty(qty, item.unit)}</span>
          {item.station && <StationTag>{item.station}</StationTag>}
          {item.priority === '911' && <StockOutBadge />}
          {blocked && <BlockedBadge reason={item.blockedReason ?? 'stock'} />}
        </div>
        {!dense && (
          <div className="flex items-center gap-3.5 mt-1.5">
            <RunwayBar activeMin={item.activeMinutes} passiveMin={item.passiveMinutes} passiveNote={item.passiveNote} />
            <NeedChip service={item.service} />
          </div>
        )}
      </div>

      {/* assignee + claim popover */}
      <div className="relative">
        <AssigneeChip cook={item.assignedCook} onClick={() => setClaimOpen(o => !o)} />
        {claimOpen && (
          <ClaimPopover
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

      {/* action — a stock-out / blocked item is NOT gated: the badge above flags the
          risk, but the cook can still start it (they may have uncounted stock, or be
          prepping toward a later restock). Only the label is advisory, never a blocker. */}
      <div className="flex items-center gap-[7px]">
        <button
          onClick={() => onOpenRecipe(item)}
          title="Recipe"
          className="w-[34px] h-[34px] rounded-[9px] bg-paper border border-line-2 grid place-items-center cursor-pointer shrink-0 text-ink-2"
        >
          <IcRecipe size={15} />
        </button>
        <button
          onClick={() => onStart(item)}
          className="inline-flex items-center gap-1.5 bg-ink text-paper border-none rounded-[9px] px-3.5 py-2 text-[12.5px] font-semibold cursor-pointer"
        >
          <Zap size={12} className="text-gold" /> Start
        </button>
      </div>
    </div>
  )
}
