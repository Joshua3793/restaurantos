'use client'
// Cook mode — what the item drawer opens on while a job is ON THE GO: the step
// track, the step the job is on (large), what comes next, and a footer with
// ← Back and the same Next button the job card carries. Ingredients, batch,
// cost and stock fold away below (the host drawer owns that). Ticking a step is
// only ever a tick — moving the job is always Back / Next.
//
// Used by both drawers: PrepDrawer (phone) and PrepBoardDrawer (computer / iPad).
// Design: docs/superpowers/specs/2026-11-16-prep-todo-step-flow-design.md
import { Hourglass, Bell } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import { cookSequence, cursorOf, waitClock, nextAction, type CookItem, type NextAction, type WaitClock } from '@/lib/prep-steps'
import { fmtMins, fmtClock, minutesBetween } from '@/lib/prep-runsheet'
import { StepTrack, NextButton } from '@/components/prep/runsheet/step-ui'
import { pacificMinuteOfDay } from '@/components/prep/runsheet/useNowMinute'

export interface CookState {
  seq: CookItem[]
  pos: number
  cur: CookItem
  clock: WaitClock | null
  action: NextAction
  /** Minutes on the current hands-on step (0 on a wait). */
  elapsed: number
}

/** The job's place in its method, or null when it is not on the go / has no method. */
export function cookState(item: PrepItemRich | null, nowMs: number): CookState | null {
  const log = item?.todayLog
  if (!item || !log || log.status !== 'IN_PROGRESS') return null
  const seq = cookSequence(item.linkedRecipe?.method)
  if (!seq) return null
  const pos = cursorOf(seq, log)
  const cur = seq[pos]
  const clock = cur.kind === 'WAIT' ? waitClock(cur, log, nowMs) : null
  const from = [log.stepEnteredAt, log.stageEnteredAt, log.startedAt].map(v => (v ? new Date(v).getTime() : NaN)).find(Number.isFinite)
  const elapsed = cur.kind === 'STEP' && from != null ? minutesBetween(from, nowMs) : 0
  return { seq, pos, cur, clock, action: nextAction(seq, pos, clock), elapsed }
}

const stepTotal = (seq: CookItem[]) => seq.filter(i => i.kind === 'STEP').length
const stepsDone = (seq: CookItem[], pos: number) => seq.slice(0, pos + 1).filter(i => i.kind === 'STEP').length

/** "about 10:20 tomorrow" style finish estimate: what is left of this item + every item after it. */
function readyAbout(s: CookState, nowMs: number): string {
  const left = s.cur.kind === 'WAIT' ? (s.clock?.leftMin ?? s.cur.minutes) : Math.max(0, s.cur.minutes - s.elapsed)
  const rest = s.seq.slice(s.pos + 1).reduce((a, i) => a + i.minutes, 0)
  const endMs = nowMs + (left + rest) * 60_000
  const days = Math.floor((pacificMinuteOfDay(nowMs) + left + rest) / 1440)
  return `done about ${fmtClock(pacificMinuteOfDay(endMs))}${days === 1 ? ' tomorrow' : days > 1 ? ` in ${days} days` : ''}`
}

export function CookModeBlock({ state, nowMs }: { state: CookState; nowMs: number }) {
  const { seq, pos, cur, clock, elapsed } = state
  const next = seq[pos + 1]
  const where = cur.kind === 'STEP'
    ? `${cur.phase ? `${cur.phase} · ` : ''}step ${cur.number} of ${stepTotal(seq)}`
    : `Wait · after step ${stepsDone(seq, pos)}`
  const ready = cur.kind === 'WAIT' && !!clock && clock.state !== 'resting'
  return (
    <div className="flex flex-col gap-3.5">
      <div>
        <div className="flex justify-between items-baseline gap-3 mb-2.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">{where}</span>
          <span className="font-mono text-[10.5px] text-ink-3">{readyAbout(state, nowMs)}</span>
        </div>
        <StepTrack seq={seq} pos={pos} ready={ready} size="lg" />
      </div>

      {cur.kind === 'STEP' && (
        <div className="bg-paper border-[1.5px] border-ink rounded-[14px] px-4 py-4 flex flex-col gap-3">
          <div className="flex justify-between items-center gap-3">
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase font-medium bg-ink text-paper px-2.5 py-[3px] rounded-full">
              <span className="w-2 h-2 rounded-[2px] bg-gold" /> Now · hands-on
            </span>
            <span className={`font-mono text-[12.5px] font-semibold ${cur.minutes > 0 && elapsed > cur.minutes ? 'text-red-text' : 'text-ink'}`}>
              {fmtMins(elapsed)}
              {cur.minutes > 0 && <span className="font-normal text-ink-3"> of {fmtMins(cur.minutes)}</span>}
            </span>
          </div>
          <div className="text-[19px] sm:text-[21px] font-semibold tracking-[-0.025em] leading-[1.3] whitespace-pre-wrap">{cur.text}</div>
        </div>
      )}

      {cur.kind === 'WAIT' && !ready && clock && (
        <div className="bg-blue-soft border-[1.5px] border-dashed border-blue rounded-[14px] px-4 py-5 flex flex-col items-center gap-1.5 text-center">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-blue-text">Wait · {cur.phase ?? 'resting'}</span>
          <span className="font-mono text-[40px] font-semibold tracking-[-0.04em] leading-none text-blue-text">{fmtMins(clock.leftMin)}</span>
          <span className="font-mono text-[11px] text-blue-text">
            left · ready at {fmtClock(pacificMinuteOfDay(clock.readyAtMs))}{cur.note ? ` · ${cur.note}` : ''}
          </span>
          <span className="text-[12.5px] text-ink-2 mt-1.5">Walk away. You get a chime when it is time.</span>
        </div>
      )}

      {cur.kind === 'WAIT' && !clock && (
        <div className="bg-blue-soft border-[1.5px] border-dashed border-blue rounded-[14px] px-4 py-5 flex flex-col items-center gap-1.5 text-center">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-blue-text">Wait · {cur.phase ?? 'resting'}</span>
          <span className="font-mono text-[13px] text-blue-text">{fmtMins(cur.minutes)} wait{cur.note ? ` · ${cur.note}` : ''}</span>
          <span className="text-[12.5px] text-ink-2 mt-1">No start time was recorded for this wait. Move on when it is ready.</span>
        </div>
      )}

      {cur.kind === 'WAIT' && ready && clock && (
        <div className="bg-green-soft border-[1.5px] border-green rounded-[14px] px-4 py-5 flex flex-col items-center gap-2 text-center">
          <span className="w-11 h-11 rounded-full bg-green grid place-items-center"><Bell size={20} className="text-paper" /></span>
          <span className="text-[20px] font-semibold tracking-[-0.025em]">Time is up</span>
          <span className="font-mono text-[11px] text-green-text">
            {cur.phase ?? 'Wait'} done · ready since {fmtClock(pacificMinuteOfDay(clock.readyAtMs))}
          </span>
        </div>
      )}

      {next && (
        <div className={`rounded-[12px] px-3.5 py-3 bg-paper flex gap-3 items-start ${next.kind === 'WAIT' ? 'border-[1.5px] border-dashed border-blue' : 'border border-line'}`}>
          {next.kind === 'WAIT' && <Hourglass size={16} className="text-blue shrink-0 mt-0.5" />}
          <div className="min-w-0">
            <div className={`font-mono text-[10px] uppercase tracking-[0.08em] ${next.kind === 'WAIT' ? 'text-blue-text' : 'text-ink-3'}`}>
              Up next · {next.kind === 'WAIT' ? `wait ${fmtMins(next.minutes)}` : next.minutes > 0 ? `hands-on ${fmtMins(next.minutes)}` : 'hands-on'}
            </div>
            <div className="text-[13.5px] text-ink-2 mt-0.5 leading-snug">
              {next.kind === 'WAIT' ? [next.phase, next.note].filter(Boolean).join(' — ') || 'Wait' : next.text}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** ← Back + Next. Next on the last step is Log yield; on a resting wait it says "Move on early". */
export function CookFooter({
  item,
  state,
  onStep,
  onLogYield,
  wide = false,
}: {
  item: PrepItemRich
  state: CookState
  onStep: (item: PrepItemRich, stepKey: string) => void
  onLogYield: (item: PrepItemRich) => void
  /** Computer drawer: a wider Back button with its own sub line. */
  wide?: boolean
}) {
  const { seq, pos, action } = state
  const prev = seq[pos - 1]
  const held = action.kind === 'held'
  const goNext = () => {
    if (action.kind === 'log' || action.to == null) onLogYield(item)
    else onStep(item, seq[action.to].key)
  }
  return (
    <div className={`grid gap-2 ${wide ? 'grid-cols-[150px_minmax(0,1fr)]' : 'grid-cols-[80px_minmax(0,1fr)]'}`}>
      <button
        type="button"
        disabled={!prev}
        onClick={() => prev && onStep(item, prev.key)}
        className="min-h-[54px] rounded-[12px] border border-line-2 bg-paper text-[14px] font-semibold text-ink-2 flex flex-col items-center justify-center gap-px disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        ← Back
        {wide && prev && (
          <span className="font-mono text-[9.5px] font-normal uppercase text-ink-3 px-2 text-center leading-tight">
            {prev.kind === 'WAIT' ? `wait · ${prev.phase ?? ''}` : prev.phase ?? `step ${prev.number}`}
          </span>
        )}
      </button>
      <NextButton
        action={action.kind === 'log' ? { ...action, sub: action.sub || 'Finish the job' } : action}
        size="big"
        label={held ? 'Move on early' : undefined}
        sub={held ? 'Skip the rest of the wait' : undefined}
        onClick={goNext}
      />
    </div>
  )
}
