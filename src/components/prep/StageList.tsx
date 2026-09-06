'use client'
// The stage chain inside the item drawer (mobile PrepDrawer + desktop
// PrepBoardDrawer): every stage in order with the current one lit, the clock
// on it, and an action row that mirrors the run-sheet buttons — Back a stage,
// Next: <stage>. Done is the drawer's own footer button (it logs the yield);
// this list never credits stock and never advances a stage on its own.
import { Hand, Hourglass, Check, ArrowLeft, ArrowRight } from 'lucide-react'
import type { RecipeStage } from '@/lib/prep-stages'
import { currentStage, stageElapsed } from '@/lib/prep-stages'
import type { StageLogShape } from '@/lib/prep-plan'
import { fmtMins, fmtClock } from '@/lib/prep-runsheet'
import { useNowMinute } from '@/components/prep/runsheet/useNowMinute'

function minuteOfDay(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

export function StageList({ stages, log, onStage }: {
  stages: RecipeStage[]
  log: StageLogShape | null
  /** Move the live log to this index. Omitted → read-only (not in progress, or no permission). */
  onStage?: (stageIndex: number) => void
}) {
  const { nowMs } = useNowMinute()
  const live = log?.status === 'IN_PROGRESS' ? currentStage(stages, log) : null
  const cur = live?.index ?? -1
  const elapsed = live ? stageElapsed(log, nowMs) : 0
  const canAct = !!onStage && live != null
  const last = stages.length - 1

  return (
    <div>
      <ol className="flex flex-col gap-1">
        {stages.map((s, i) => {
          const state = i < cur ? 'past' : i === cur ? 'now' : 'todo'
          const passive = s.kind === 'PASSIVE'
          return (
            <li
              key={s.key}
              className={`flex items-start gap-2.5 rounded-[9px] px-2.5 py-2 border ${
                state === 'now'
                  ? passive ? 'bg-blue-soft border-transparent' : 'bg-gold-soft border-[#fcd34d]'
                  : 'bg-paper border-line'
              } ${state === 'past' ? 'opacity-60' : ''}`}
            >
              <span className={`w-[22px] h-[22px] rounded-[7px] grid place-items-center shrink-0 font-mono text-[10.5px] font-semibold ${
                state === 'past' ? 'bg-green-soft text-green-text' : state === 'now' ? 'bg-ink text-gold' : 'bg-bg-2 text-ink-3'
              }`}>
                {state === 'past' ? <Check size={12} strokeWidth={3} /> : i + 1}
              </span>
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className={`text-[13px] font-semibold tracking-[-0.01em] ${state === 'now' ? 'text-ink' : 'text-ink-2'}`}>{s.name}</span>
                  <span className={`inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.04em] ${passive ? 'text-blue-text' : 'text-ink-3'}`}>
                    {passive ? <Hourglass size={10} /> : <Hand size={10} />}
                    {passive ? 'unattended' : 'hands-on'} · {fmtMins(s.minutes)}
                  </span>
                </span>
                {s.note && <span className="block text-[11.5px] text-ink-3 mt-0.5">{s.note}</span>}
                {state === 'now' && log?.stageEnteredAt && (
                  <span className={`block font-mono text-[10px] mt-1 ${elapsed > s.minutes ? (passive ? 'text-green-text' : 'text-red-text') : 'text-ink-2'}`}>
                    since {fmtClock(minuteOfDay(log.stageEnteredAt))} · {fmtMins(elapsed)} of {fmtMins(s.minutes)}
                    {elapsed > s.minutes ? (passive ? ' · ready' : ` · over by ${fmtMins(elapsed - s.minutes)}`) : ''}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ol>
      {canAct && (
        <div className="flex items-center gap-2 mt-2.5">
          <button
            type="button"
            disabled={cur <= 0}
            onClick={() => onStage!(cur - 1)}
            className="inline-flex items-center gap-1.5 h-10 px-3 rounded-[9px] text-[12.5px] font-semibold bg-paper border border-line text-ink-2 disabled:opacity-40"
          >
            <ArrowLeft size={13} /> Back
          </button>
          {cur < last ? (
            <button
              type="button"
              onClick={() => onStage!(cur + 1)}
              className="flex-1 inline-flex items-center justify-center gap-1.5 h-10 px-3 rounded-[9px] text-[12.5px] font-semibold bg-ink text-paper"
            >
              Next: {stages[cur + 1].name} <ArrowRight size={13} className="text-gold" />
            </button>
          ) : (
            <span className="flex-1 font-mono text-[10px] text-ink-3 text-center">last stage — Done logs the yield</span>
          )}
        </div>
      )}
    </div>
  )
}
