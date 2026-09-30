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
// "Next: Bake" and the cook taps it. The row leads with the item and the
// stage it is IN; the button names the next stage and nothing else. No Remove: an
// in-flight job is not taken off the list from a row (same rule as Working On).
import { useRef, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { AssigneeChip, ClaimPopover } from './assignee'
import { StationTag, DeadlineChip, ChefNote, RestBar } from './atoms'
import { fmtClock, fmtMins, minutesBetween } from '@/lib/prep-runsheet'
import { restPhaseName } from '@/lib/prep-stages'

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
  showStation = true,
}: {
  item: PrepItemRich
  nowMin: number
  nowMs: number
  cooks: Cook[]
  /** Off when every item is on one station, or the list is filtered to one. */
  showStation?: boolean
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
            {fmtClock(rest.readyAtMin)}
          </div>
          <div className={`font-mono text-[9px] mt-0.5 whitespace-nowrap ${subCls}`}>{sub}</div>
        </div>

        {/* task — the item's name alone, then ONE line: the stage it is in, its
            clock and its note ("Curing · 2h44 of 24h · in the walk-in"), and the
            timer as a hairline. The blue edge already says "resting"; the word is
            not repeated in a chip, a subtitle and the title. */}
        <div className="min-w-0">
          <span
            onClick={() => onOpenRecipe(item)}
            title="Open recipe"
            className={`text-[14px] font-semibold tracking-[-0.015em] break-words cursor-pointer underline decoration-line-2 underline-offset-[3px] ${
              rest.state === 'resting' ? 'text-ink-2' : 'text-ink'
            }`}
          >
            {item.name}
          </span>
          <div className="flex items-center gap-x-3.5 gap-y-1 flex-wrap mt-1">
            <span className="font-mono text-[10.5px] text-ink-3">
              <span className="text-blue-text font-semibold">{restPhaseName(rest.stage)}</span>
              {` · ${fmtMins(elapsed)} of ${fmtMins(rest.stage.minutes)}`}
              {rest.stage.note ? ` · ${rest.stage.note}` : ''}
            </span>
            {showStation && item.station && <StationTag>{item.station}</StationTag>}
            <DeadlineChip item={item} onlyIfMoved />
          </div>
          <RestBar elapsed={elapsed} minutes={rest.stage.minutes} state={rest.state} />
          <ChefNote note={item.todayLog?.note} className="mt-2" />
        </div>

        {/* assignee · next (the name opens the recipe) */}
        <div className="col-start-2 lg:col-start-3 flex items-center gap-[7px] justify-start lg:justify-end">
          <div ref={claimAnchor} className="relative shrink-0">
            <AssigneeChip cook={item.assignedCook} compact onClick={() => setClaimOpen(o => !o)} />
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
          {rest.next && (
            <button
              onClick={() => onStage(item, rest.next!.index)}
              className={`inline-flex items-center gap-1.5 border-none rounded-[9px] px-3.5 py-2 text-[12.5px] font-semibold cursor-pointer shrink-0 whitespace-nowrap ${
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
