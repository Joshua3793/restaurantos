'use client'
// Prep run-sheet — mobile REST row. Twin of RestRow on RunRowMobile's shape:
// 44px ready-at column | task (next stage · name, one meta line) | one 44px
// action button that moves the job to its next hands-on stage. Muted while
// resting, green once ready, red only past the grace — never "late" mid-rest.
import { Hourglass, ArrowRight } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import { AssigneeChip } from './assignee'
import { StageChip } from './atoms'
import { fmtStartBy, fmtClock, fmtMins, minutesBetween } from '@/lib/prep-runsheet'
import { fmtDeadline } from '@/lib/prep-plan'
import { stageLabel } from '@/lib/prep-stages'

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
}: {
  item: PrepItemRich
  nowMin: number
  nowMs: number
  kitchen?: boolean
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
  const dl = item.deadlineMinutes
  const metaText = [
    rest.state === 'resting' ? `resting ${fmtMins(elapsed)} of ${fmtMins(rest.stage.minutes)}` : `rested ${fmtMins(elapsed)}`,
    rest.stage.note ?? null,
    kitchen && item.station ? item.station : null,
    dl != null ? `by ${fmtDeadline(dl, fmtClock)}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="relative">
      <div
        className={`flex items-center gap-3 border border-line border-l-[3px] rounded-[11px] py-[11px] px-[13px] ${
          rest.state === 'resting' ? 'bg-bg' : 'bg-paper'
        } ${ACCENT[rest.state]}`}
      >
        <div className="w-11 shrink-0">
          <div className={`font-mono text-[12.5px] font-semibold tracking-[-0.01em] ${timeCls}`}>{fmtStartBy(rest.readyAtMin)}</div>
          <div className={`font-mono text-[8.5px] mt-px whitespace-nowrap ${subCls}`}>{sub}</div>
        </div>

        <div onClick={() => onOpenRecipe(item)} className="flex-1 min-w-0 cursor-pointer">
          <div className="flex items-center gap-1.5">
            <span className="w-5 h-5 rounded-[6px] bg-blue-soft grid place-items-center shrink-0">
              <Hourglass size={11} className="text-blue-text" />
            </span>
            <div className={`text-[13.5px] font-semibold tracking-[-0.01em] break-words min-w-0 ${rest.state === 'resting' ? 'text-ink-2' : 'text-ink'}`}>
              {nextName} · {item.name}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap font-mono text-[9.5px] text-ink-3 mt-[3px]">
            <StageChip label={stageLabel(rest.index, rest.total, rest.stage)} passive />
            <span>{metaText}</span>
            {kitchen && (
              <span onClick={e => e.stopPropagation()}>
                <AssigneeChip cook={item.assignedCook} size="sm" onClick={() => onClaim(item)} />
              </span>
            )}
          </div>
        </div>

        {rest.next && (
          <button
            onClick={() => onStage(item, rest.next!.index)}
            aria-label={`Next: ${nextName}`}
            title={`Next: ${nextName}`}
            className={`w-11 h-11 rounded-[10px] grid place-items-center cursor-pointer shrink-0 ${
              rest.state === 'resting' ? 'bg-paper border border-line-2 text-ink-2' : 'bg-ink border-none text-gold'
            }`}
          >
            <ArrowRight size={15} />
          </button>
        )}
      </div>
    </div>
  )
}
