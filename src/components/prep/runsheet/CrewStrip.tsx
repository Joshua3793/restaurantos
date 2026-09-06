'use client'
// Prep run-sheet — desktop crew strip ("kitchen mode" roster row).
// Ported from desktop.jsx's DCrew. One card per cook in the real `cooks`
// roster (not the prototype's hardcoded PT_CREW): current in-progress task +
// elapsed, queued count, hands-on load, and late-to-start count.
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { fmtMins, minutesBetween } from '@/lib/prep-runsheet'
import { lateToStart } from '@/lib/prep-plan'

// Elapsed is EPOCH MS (`startedAt` / `stageEnteredAt` against `nowMs`), never
// minute-of-day: the old `nowMin − minuteOfDay(startedAt)` clamped at 0 read a
// job started last evening as 0 elapsed this morning. For a staged job the
// clock is the current stage's own.

export function CrewStrip({
  cooks,
  items,
  nowMin,
  nowMs,
}: {
  cooks: Cook[]
  items: PrepItemRich[]
  nowMin: number
  nowMs: number
}) {
  // Cards grow to fill the row but never shrink below a readable width — past
  // that the strip scrolls horizontally instead of chopping names (iPad).
  return (
    <div className="flex gap-2.5 mb-[18px] overflow-x-auto">
      {cooks.map(cook => (
        <CrewCard key={cook.id} cook={cook} items={items} nowMin={nowMin} nowMs={nowMs} />
      ))}
    </div>
  )
}

function CrewCard({ cook, items, nowMin, nowMs }: { cook: Cook; items: PrepItemRich[]; nowMin: number; nowMs: number }) {
  // A cook's "doing" is a hands-on job only — a job resting in an unattended
  // stage (`rest`) does not hold a cook; it sits in the ladder.
  const doing = items.find(i => i.todayLog?.status === 'IN_PROGRESS' && !i.rest && i.assignedCook?.id === cook.id)
  const queue = items.filter(
    i => i.assignedCook?.id === cook.id && !(i.todayLog?.status === 'IN_PROGRESS' && !i.rest) && i.todayLog?.status !== 'DONE'
  )
  const load = queue.reduce((a, i) => a + (i.activeMinutes ?? 0), 0)
  // Same lateness test as the ladder's "Late to start" section (a low-stock
  // flag does not stop a job being late; a resting job is late only past its grace).
  const lateN = queue.filter(i => lateToStart(i, nowMin)).length

  const clockFrom = doing?.todayLog?.stageEnteredAt ?? doing?.todayLog?.startedAt
  const doingElapsed = clockFrom ? minutesBetween(new Date(clockFrom).getTime(), nowMs) : 0

  return (
    <div className="flex-[1_0_190px] min-w-0 flex items-center gap-2.5 bg-paper border border-line rounded-xl px-3 py-2.5">
      <span className="w-8 h-8 rounded-full bg-ink text-gold grid place-items-center font-mono text-[10px] font-bold shrink-0">
        {cook.initials}
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold tracking-[-0.01em] whitespace-nowrap overflow-hidden text-ellipsis">
          {cook.name.split(' ')[0]}{' '}
          {cook.homeStation && (
            <span className="font-mono text-[9px] font-medium text-ink-3">· {cook.homeStation.toUpperCase()}</span>
          )}
        </span>
        <span
          className={`block font-mono text-[9.5px] mt-0.5 whitespace-nowrap overflow-hidden text-ellipsis ${
            doing ? 'text-gold-2' : 'text-ink-3'
          }`}
        >
          {doing ? `● ${doing.name} · ${fmtMins(doingElapsed)}` : 'between tasks'}
        </span>
        <span
          className={`block font-mono text-[9.5px] mt-px whitespace-nowrap overflow-hidden text-ellipsis ${lateN ? 'text-red-text' : 'text-ink-4'}`}
        >
          {queue.length} queued · {fmtMins(load)} hands-on{lateN ? ` · ${lateN} late` : ''}
        </span>
      </span>
    </div>
  )
}
