'use client'
// Prep run-sheet — desktop crew strip ("kitchen mode" roster row).
// Ported from desktop.jsx's DCrew. One card per cook in the real `cooks`
// roster (not the prototype's hardcoded PT_CREW): current in-progress task +
// elapsed, queued count, hands-on load, and late-to-start count.
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { fmtMins, runState } from '@/lib/prep-runsheet'

// `nowMin` (like the rest of the run sheet's clock math — see RunRow.tsx,
// prep-runsheet.ts) is minutes-since-midnight, not an epoch timestamp. A
// task's `todayLog.startedAt` is an absolute ISO timestamp, so to get an
// "elapsed" figure comparable to `nowMin` we reduce it to the same
// minutes-since-midnight basis first. This mirrors the prototype, where
// `now` and `t.startedMin` were both plain minute integers throughout.
function minuteOfDay(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

export function CrewStrip({
  cooks,
  items,
  nowMin,
}: {
  cooks: Cook[]
  items: PrepItemRich[]
  nowMin: number
}) {
  return (
    <div className="grid gap-2.5 mb-[18px]" style={{ gridTemplateColumns: `repeat(${cooks.length || 1},1fr)` }}>
      {cooks.map(cook => (
        <CrewCard key={cook.id} cook={cook} items={items} nowMin={nowMin} />
      ))}
    </div>
  )
}

function CrewCard({ cook, items, nowMin }: { cook: Cook; items: PrepItemRich[]; nowMin: number }) {
  const doing = items.find(i => i.todayLog?.status === 'IN_PROGRESS' && i.assignedCook?.id === cook.id)
  const queue = items.filter(
    i => i.assignedCook?.id === cook.id && i.todayLog?.status !== 'IN_PROGRESS' && i.todayLog?.status !== 'DONE'
  )
  const load = queue.reduce((a, i) => a + (i.activeMinutes ?? 0), 0)
  const lateN = queue.filter(
    i => runState({ startBy: i.startByMinutes, blockedReason: i.blockedReason }, nowMin) === 'overdue'
  ).length

  const doingElapsed = doing?.todayLog?.startedAt ? Math.max(0, nowMin - minuteOfDay(doing.todayLog.startedAt)) : 0

  return (
    <div className="flex items-center gap-2.5 bg-paper border border-line rounded-xl px-3 py-2.5">
      <span className="w-8 h-8 rounded-full bg-ink text-gold grid place-items-center font-mono text-[10px] font-bold shrink-0">
        {cook.initials}
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold tracking-[-0.01em] whitespace-nowrap">
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
          className={`block font-mono text-[9.5px] mt-px whitespace-nowrap ${lateN ? 'text-red-text' : 'text-ink-4'}`}
        >
          {queue.length} queued · {fmtMins(load)} hands-on{lateN ? ` · ${lateN} late` : ''}
        </span>
      </span>
    </div>
  )
}
