'use client'
// The wait-over banner on top of the To Do — one per job whose wait has run
// out, longest-ready first, each with that job's own (green) Next button. It
// stays until someone moves the job on (useWaitAlarms owns the chime).
import { Bell } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { GoRow } from '@/lib/prep-on-the-go'
import { nextAction } from '@/lib/prep-steps'
import { fmtClock } from '@/lib/prep-runsheet'
import { NextButton } from './step-ui'
import { runAction } from './JobCard'
import { pacificMinuteOfDay } from './useNowMinute'

export function AlarmBanner({
  rows,
  onStep,
  onLog,
  onOpenRecipe,
}: {
  rows: GoRow<PrepItemRich>[]
  onStep: (item: PrepItemRich, stepKey: string) => void
  onLog: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  const live = rows.filter(r => r.seq && r.clock)
  if (live.length === 0) return null
  return (
    <div className="flex flex-col gap-2 mb-3">
      {live.map(r => {
        const action = nextAction(r.seq!, r.pos, r.clock)
        return (
          <div key={r.item.id} role="status" className="flex flex-wrap items-center gap-3 bg-green-soft border border-green rounded-[12px] pl-4 pr-3 py-3">
            <span className="w-[34px] h-[34px] rounded-full bg-green grid place-items-center shrink-0">
              <Bell size={16} className="text-paper" />
            </span>
            <div className="flex-1 min-w-[180px]">
              <div className="text-[14px] font-semibold tracking-[-0.015em] text-ink break-words">
                {r.item.name} — {r.cur?.phase ?? 'wait'} is done
              </div>
              <div className="font-mono text-[10.5px] uppercase text-green-text mt-0.5">
                Ready since {fmtClock(pacificMinuteOfDay(r.clock!.readyAtMs))} · {action.label}
              </div>
            </div>
            <NextButton action={action} onClick={() => runAction({ onStep, onLog, onOpenRecipe }, r, action)} />
          </div>
        )
      })}
    </div>
  )
}
