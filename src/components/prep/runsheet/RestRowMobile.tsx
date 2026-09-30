'use client'
// Prep run-sheet — mobile REST row. Twin of RestRow on RunRowMobile's shape:
// 44px ready-at column | task (name · stage, meta line, Next subtitle) | one 44px
// action button that moves the job to its next hands-on stage. Muted while
// resting, green once ready, red only past the grace — never "late" mid-rest.
import { ArrowRight } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import { AssigneeChip } from './assignee'
import { ChefNote, RestBar } from './atoms'
import { fmtClock, fmtMins, minutesBetween } from '@/lib/prep-runsheet'
import { restPhaseName } from '@/lib/prep-stages'

const ACCENT: Record<'resting' | 'ready' | 'overdue', string> = {
  resting: 'border-l-blue',
  ready: 'border-l-green',
  overdue: 'border-l-red',
}

export function RestRowMobile({
  item,
  nowMin,
  nowMs,
  kitchen = false,
  onClaim,
  onOpenRecipe,
  onStage,
  showStation = true,
}: {
  item: PrepItemRich
  nowMin: number
  nowMs: number
  kitchen?: boolean
  /** Off when every item is on one station. */
  showStation?: boolean
  onClaim: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
  onStage: (item: PrepItemRich, stageIndex: number) => void
}) {
  const rest = item.rest
  if (!rest) return null
  const entered = item.todayLog?.stageEnteredAt
  const elapsed = entered ? minutesBetween(new Date(entered).getTime(), nowMs) : 0
  const delta = rest.readyAtMin - nowMin
  const sub =
    rest.state === 'resting' ? `in ${fmtMins(delta)}`
    : rest.state === 'ready' ? `since ${fmtClock(rest.readyAtMin)}`
    : `${fmtMins(-delta)} past`
  const timeCls = rest.state === 'overdue' ? 'text-red' : rest.state === 'ready' ? 'text-green-text' : 'text-ink-3'
  const subCls = rest.state === 'overdue' ? 'text-red-text' : rest.state === 'ready' ? 'text-green-text' : 'text-ink-4'
  const nextName = rest.next?.stage.name ?? 'Next stage'
  // ONE line after the name: stage · clock · its note (· station when there are several).
  const metaRest = [
    `${fmtMins(elapsed)} of ${fmtMins(rest.stage.minutes)}`,
    rest.stage.note ?? null,
    kitchen && showStation && item.station ? item.station : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="relative">
      <div
        className={`border border-line border-l-[3px] rounded-[11px] py-[11px] px-[13px] ${
          rest.state === 'resting' ? 'bg-bg' : 'bg-paper'
        } ${ACCENT[rest.state]}`}
      >
      <div className="flex items-center gap-3">
        {/* ready-at, and in kitchen mode the claim button under it (the time
            column has height to spare; the name column has no width to spare) */}
        <div className="w-11 shrink-0">
          <div className={`font-mono text-[12.5px] font-semibold tracking-[-0.01em] ${timeCls}`}>{fmtClock(rest.readyAtMin)}</div>
          <div className={`font-mono text-[8.5px] mt-px whitespace-nowrap ${subCls}`}>{sub}</div>
          {kitchen && (
            <div className="mt-1.5">
              <AssigneeChip cook={item.assignedCook} size="sm" compact onClick={() => onClaim(item)} />
            </div>
          )}
        </div>

        <div onClick={() => onOpenRecipe(item)} className="flex-1 min-w-0 cursor-pointer">
          <div className={`text-[13.5px] font-semibold tracking-[-0.01em] break-words min-w-0 ${rest.state === 'resting' ? 'text-ink-2' : 'text-ink'}`}>
            {item.name}
          </div>
          <div className="font-mono text-[9.5px] text-ink-3 mt-[3px]">
            <span className="text-blue-text font-semibold">{restPhaseName(rest.stage)}</span> · {metaRest}
          </div>
          <RestBar elapsed={elapsed} minutes={rest.stage.minutes} state={rest.state} />
        </div>

        {/* The button names the next stage ("Slice →") — the one place it is said. */}
        {rest.next && (
          <button
            onClick={() => onStage(item, rest.next!.index)}
            aria-label={`Next: ${nextName}`}
            className={`min-h-11 max-w-[92px] px-2.5 py-1.5 rounded-[10px] inline-flex items-center gap-1 cursor-pointer shrink-0 text-[11.5px] font-semibold leading-tight text-left ${
              rest.state === 'resting' ? 'bg-paper border border-line-2 text-ink-2' : 'bg-gold-soft border border-gold/40 text-gold-2 active:bg-gold/25'
            }`}
          >
            <span className="break-words min-w-0">{nextName}</span>
            <ArrowRight size={13} className={`shrink-0 ${rest.state === 'resting' ? 'text-ink-3' : 'text-gold-2'}`} />
          </button>
        )}
      </div>
      <ChefNote note={item.todayLog?.note} compact className="mt-2 ml-14" />
      </div>
    </div>
  )
}
