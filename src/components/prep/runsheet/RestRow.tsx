'use client'
// Prep run-sheet — desktop REST row.
//
// A staged job whose current stage is unattended (a cure, a proof, a hang)
// leaves Working On and sits in the ladder at the time its next hands-on stage
// is due. Same grid as RunRow (64px time | task | actions) so it reads as one
// more line of the ladder, but the time column is READY-AT, not start-by, and
// the row is never painted late while it is legitimately resting: muted while
// `resting`, green from `readyAt` (`ready since 07:30`), red only once it is
// `overdue` past the grace. Nothing advances on its own — the primary button is
// "Next: Bake" and the cook taps it. No Remove: an in-flight job is not taken
// off the list from a row (same rule as Working On).
import { useRef, useState } from 'react'
import { Hourglass, ArrowRight } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { AssigneeChip, ClaimPopover } from './assignee'
import { StationTag, DeadlineChip, StageChip } from './atoms'
import { IcRecipe } from '@/components/prep/icons'
import { fmtStartBy, fmtClock, fmtMins, minutesBetween } from '@/lib/prep-runsheet'
import { stageLabel } from '@/lib/prep-stages'

const ACCENT: Record<'resting' | 'ready' | 'overdue', string> = {
  resting: 'border-l-blue',
  ready: 'border-l-green',
  overdue: 'border-l-red',
}

export function RestRow({
  item,
  nowMin,
  nowMs,
  cooks,
  onStage,
  onOpenRecipe,
  onClaim,
}: {
  item: PrepItemRich
  nowMin: number
  nowMs: number
  cooks: Cook[]
  /** Move the live log to `stageIndex` (the next hands-on stage). */
  onStage: (item: PrepItemRich, stageIndex: number) => void
  onOpenRecipe: (item: PrepItemRich) => void
  onClaim: (item: PrepItemRich, cookId: string | null) => void
}) {
  const [claimOpen, setClaimOpen] = useState(false)
  const claimAnchor = useRef<HTMLDivElement>(null)
  const rest = item.rest
  if (!rest) return null

  const entered = item.todayLog?.stageEnteredAt
  const elapsed = entered ? minutesBetween(new Date(entered).getTime(), nowMs) : 0
  const delta = rest.readyAtMin - nowMin
  const sub =
    rest.state === 'resting' ? `ready in ${fmtMins(delta)}`
    : rest.state === 'ready' ? `ready since ${fmtClock(rest.readyAtMin)}`
    : `${fmtMins(-delta)} past ready`
  const timeCls =
    rest.state === 'overdue' ? 'text-red' : rest.state === 'ready' ? 'text-green-text' : 'text-ink-3'
  const subCls =
    rest.state === 'overdue' ? 'text-red-text' : rest.state === 'ready' ? 'text-green-text' : 'text-ink-4'
  const nextName = rest.next?.stage.name ?? 'Next stage'

  return (
    <div className="relative">
      <div
        className={`grid grid-cols-[64px_minmax(0,1fr)] lg:grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border border-line border-l-[3px] rounded-[11px] py-[13px] px-4 ${
          rest.state === 'resting' ? 'bg-bg' : 'bg-paper'
        } ${ACCENT[rest.state]}`}
      >
        {/* ready-at — where start-by sits on a RunRow */}
        <div className="self-start lg:self-center">
          <div className={`font-mono text-[14px] font-semibold tracking-[-0.01em] ${timeCls}`}>
            {fmtStartBy(rest.readyAtMin)}
          </div>
          <div className={`font-mono text-[9px] mt-0.5 whitespace-nowrap ${subCls}`}>{sub}</div>
        </div>

        {/* task — "Bake · Sourdough": the next hands-on stage, then the item */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-[22px] h-[22px] rounded-[7px] bg-blue-soft grid place-items-center shrink-0">
              <Hourglass size={12} className="text-blue-text" />
            </span>
            <span
              onClick={() => onOpenRecipe(item)}
              title="Open recipe"
              className={`text-[14px] font-semibold tracking-[-0.015em] break-words cursor-pointer underline decoration-line-2 underline-offset-[3px] ${
                rest.state === 'resting' ? 'text-ink-2' : 'text-ink'
              }`}
            >
              {nextName} · {item.name}
            </span>
          </div>
          <div className="flex items-center gap-x-3.5 gap-y-1 flex-wrap mt-1">
            <StageChip label={stageLabel(rest.index, rest.total, rest.stage)} passive />
            <span className="font-mono text-[10px] text-ink-3 whitespace-nowrap">
              {rest.state === 'resting'
                ? `resting ${fmtMins(elapsed)} of ${fmtMins(rest.stage.minutes)}`
                : `rested ${fmtMins(elapsed)}`}
              {rest.stage.note ? ` · ${rest.stage.note}` : ''}
            </span>
            {item.station && <StationTag>{item.station}</StationTag>}
            <DeadlineChip item={item} />
          </div>
        </div>

        {/* assignee · recipe · next */}
        <div className="col-start-2 lg:col-start-3 flex items-center gap-[7px] justify-start lg:justify-end">
          <div ref={claimAnchor} className="relative shrink-0">
            <AssigneeChip cook={item.assignedCook} onClick={() => setClaimOpen(o => !o)} />
            {claimOpen && (
              <ClaimPopover
                anchorRef={claimAnchor}
                cooks={cooks}
                currentId={item.assignedCook?.id ?? null}
                onPick={cookId => { onClaim(item, cookId); setClaimOpen(false) }}
                onClose={() => setClaimOpen(false)}
              />
            )}
          </div>
          <button
            onClick={() => onOpenRecipe(item)}
            title="Recipe"
            className="w-[34px] h-[34px] rounded-[9px] bg-paper border border-line-2 grid place-items-center cursor-pointer shrink-0 text-ink-2"
          >
            <IcRecipe size={15} />
          </button>
          {rest.next && (
            <button
              onClick={() => onStage(item, rest.next!.index)}
              className={`inline-flex items-center gap-1.5 border-none rounded-[9px] px-3.5 py-2 text-[12.5px] font-semibold cursor-pointer shrink-0 ${
                rest.state === 'resting' ? 'bg-paper text-ink-2 border border-line-2' : 'bg-ink text-paper'
              }`}
            >
              Next: {nextName} <ArrowRight size={12} className={rest.state === 'resting' ? 'text-ink-3' : 'text-gold'} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
