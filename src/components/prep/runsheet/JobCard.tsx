'use client'
// Prep To Do — a job ON THE GO (started, not done). Replaces the old Working On
// row + Waiting (rest) row: a started job keeps ONE card in ONE lane until it is
// done, whatever step it is on. The card shows the step the job is on, the step
// track (square = hands-on, capsule = wait), and ONE Next button whose look says
// what comes next. Stop and the alarm switch live in the ⋯ menu, never beside Next.
//
// Design: docs/superpowers/specs/2026-11-16-prep-todo-step-flow-design.md
import { useRef, useState } from 'react'
import type { PrepItemRich } from '@/components/prep/types'
import type { GoRow } from '@/lib/prep-on-the-go'
import { nextAction, type CookItem, type NextAction } from '@/lib/prep-steps'
import { draftQty, batchLabel } from '@/lib/prep-plan'
import { fmtMins, fmtQty, fmtClock, minutesBetween } from '@/lib/prep-runsheet'
import type { Cook } from './assignee'
import { AssigneeChip, ClaimPopover } from './assignee'
import { StationTag, ChefNote } from './atoms'
import { StepTrack, NextButton, JobMenu, type JobMenuEntry } from './step-ui'
import { pacificMinuteOfDay } from './useNowMinute'

export interface JobCardProps {
  row: GoRow<PrepItemRich>
  nowMs: number
  onStep: (item: PrepItemRich, stepKey: string) => void
  onLog: (item: PrepItemRich) => void
  onStop: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
  /** Per-device alarm switch (the ⋯ menu). Omitted → no alarm entry. */
  alarmsMuted?: boolean
  onToggleAlarms?: () => void
  onEnableNotifications?: () => void
  showStation?: boolean
}

// ── what the card says (shared by both renderers) ────────────────────────────
interface CardView {
  clock: string
  clockSub: string
  clockCls: string
  subCls: string
  stepLabel: string | null
  stepText: string | null
  action: NextAction
  qtyLine: string
}

const ms = (v: string | null | undefined) => (v ? new Date(v).getTime() : NaN)

function stepCount(seq: CookItem[]): number {
  return seq.filter(i => i.kind === 'STEP').length
}

export function cardView(row: GoRow<PrepItemRich>, nowMs: number): CardView {
  const { item, seq, pos, cur, clock } = row
  const log = item.todayLog
  const qty = draftQty(item) || (item.targetToday ?? item.parLevel)
  const batch = batchLabel(item, qty)
  const qtyLine = batch ? `${fmtQty(qty, item.unit)} · ${batch}` : fmtQty(qty, item.unit)
  const logAction: NextAction = { kind: 'log', to: null, label: 'Log yield', sub: `${fmtQty(qty, item.unit)} planned` }

  if (cur && cur.kind === 'WAIT' && clock) {
    const readyMin = pacificMinuteOfDay(clock.readyAtMs)
    const next = seq?.[pos + 1]
    const upNext = next && next.kind === 'STEP' ? `Up next: ${next.text}` : null
    const action = nextAction(seq!, pos, clock)
    if (clock.state === 'resting') {
      return {
        clock: fmtMins(clock.leftMin), clockSub: `left · ready ${fmtClock(readyMin)}`,
        clockCls: 'text-blue-text', subCls: 'text-blue-text',
        stepLabel: `Wait · ${cur.phase ?? 'resting'}`,
        stepText: [cur.note, upNext].filter(Boolean).join(' · ') || null,
        action, qtyLine,
      }
    }
    const past = minutesBetween(clock.readyAtMs, nowMs)
    return {
      clock: clock.state === 'overdue' ? fmtMins(past) : 'READY',
      clockSub: clock.state === 'overdue' ? 'past ready' : `since ${fmtClock(readyMin)}`,
      clockCls: clock.state === 'overdue' ? 'text-red-text' : 'text-green-text',
      subCls: clock.state === 'overdue' ? 'text-red-text' : 'text-green-text',
      stepLabel: `Wait done · ${cur.phase ?? 'wait'}`,
      stepText: upNext,
      action: action.to == null ? logAction : action,
      qtyLine,
    }
  }

  // Hands-on (or no method): the step's own clock.
  const from = [log?.stepEnteredAt, log?.stageEnteredAt, log?.startedAt].map(ms).find(Number.isFinite)
  const elapsed = from != null ? minutesBetween(from, nowMs) : 0
  if (cur && cur.kind === 'STEP' && seq) {
    const over = cur.minutes > 0 && elapsed > cur.minutes
    const action = nextAction(seq, pos, null)
    return {
      clock: fmtMins(elapsed),
      clockSub: cur.minutes > 0 ? (over ? `over by ${fmtMins(elapsed - cur.minutes)}` : `of ${fmtMins(cur.minutes)}`) : 'on this step',
      clockCls: 'text-ink', subCls: over ? 'text-red-text font-semibold' : 'text-ink-3',
      stepLabel: `Step ${cur.number} of ${stepCount(seq)}${cur.phase ? ` · ${cur.phase}` : ''}`,
      stepText: cur.text,
      action: action.kind === 'log' ? logAction : action,
      qtyLine,
    }
  }
  const budget = (item.activeMinutes ?? 0) + (item.passiveMinutes ?? 0)
  const over = budget > 0 && elapsed > budget
  return {
    clock: fmtMins(elapsed),
    clockSub: budget > 0 ? (over ? `over by ${fmtMins(elapsed - budget)}` : `of ${fmtMins(budget)}`) : 'started',
    clockCls: 'text-ink', subCls: over ? 'text-red-text font-semibold' : 'text-ink-3',
    stepLabel: null, stepText: null, action: logAction, qtyLine,
  }
}

/** What tapping the card's Next does: log the yield, open the drawer (resting), or move one step. */
export function runAction(p: Pick<JobCardProps, 'onStep' | 'onLog' | 'onOpenRecipe'>, row: GoRow<PrepItemRich>, action: NextAction) {
  if (action.kind === 'log' || action.to == null || !row.seq) return p.onLog(row.item)
  if (action.kind === 'held') return p.onOpenRecipe(row.item)
  p.onStep(row.item, row.seq[action.to].key)
}

export function menuEntries(p: JobCardProps): JobMenuEntry[] {
  const out: JobMenuEntry[] = [
    { label: 'Stop for now', sub: 'keeps the step — Start carries on from here', onClick: () => p.onStop(p.row.item) },
  ]
  if (p.onToggleAlarms) {
    out.push(p.alarmsMuted
      ? { label: 'Turn alarms back on', sub: 'chime + buzz when a wait is over', onClick: p.onToggleAlarms }
      : { label: 'Mute alarms on this device', sub: 'the banner still shows', onClick: p.onToggleAlarms })
  }
  if (p.onEnableNotifications) {
    out.push({ label: 'Turn on notifications', sub: 'a notice when a wait is over, even in another tab', onClick: p.onEnableNotifications })
  }
  return out
}

const cardSurface = (row: GoRow<PrepItemRich>) =>
  row.state === 'ready' ? 'bg-paper border-green ring-1 ring-green'
  : row.state === 'waiting' ? 'bg-bg border-line'
  : 'bg-paper border-line'

// ── desktop / iPad ───────────────────────────────────────────────────────────
export function JobCard(props: JobCardProps & { cooks: Cook[]; onClaim: (item: PrepItemRich, cookId: string | null) => void }) {
  const { row, nowMs, cooks, onClaim, onOpenRecipe, showStation = true } = props
  const { item, seq, pos } = row
  const v = cardView(row, nowMs)
  const [claimOpen, setClaimOpen] = useState(false)
  const claimAnchor = useRef<HTMLDivElement>(null)
  return (
    <div className={`grid grid-cols-[84px_minmax(0,1fr)] lg:grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 border rounded-[12px] py-3.5 px-[18px] ${cardSurface(row)}`}>
      <div className="self-start lg:self-center">
        <div className={`font-mono text-[17px] font-semibold tracking-[-0.02em] leading-tight ${v.clockCls}`}>{v.clock}</div>
        <div className={`font-mono text-[10px] mt-1 ${v.subCls}`}>{v.clockSub}</div>
      </div>

      <div className="min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span
            onClick={() => onOpenRecipe(item)}
            title="Open the job"
            className="text-[15px] font-semibold tracking-[-0.015em] break-words cursor-pointer underline decoration-line-2 underline-offset-[3px]"
          >
            {item.name}
          </span>
          <span className="font-mono text-[11px] text-ink-3">{v.qtyLine}</span>
          {showStation && item.station && <StationTag>{item.station}</StationTag>}
        </div>
        {v.stepLabel && (
          <div className="text-[13.5px] text-ink-2 mt-1 leading-snug">
            <span className="font-mono text-[10.5px] font-medium uppercase text-ink-3 mr-1.5">{v.stepLabel}</span>
            {v.stepText}
          </div>
        )}
        {seq && <div className="mt-2.5"><StepTrack seq={seq} pos={pos} ready={row.state === 'ready'} /></div>}
        <ChefNote note={item.todayLog?.note} className="mt-2" />
      </div>

      <div className="col-start-2 lg:col-start-3 flex items-center gap-2 justify-start lg:justify-end">
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
        <NextButton action={v.action} onClick={() => runAction(props, row, v.action)} />
        <JobMenu entries={menuEntries(props)} />
      </div>
    </div>
  )
}

// ── phone ────────────────────────────────────────────────────────────────────
export function JobCardMobile(props: JobCardProps & { onClaim?: (item: PrepItemRich) => void }) {
  const { row, nowMs, onClaim, onOpenRecipe, showStation = true } = props
  const { item, seq, pos } = row
  const v = cardView(row, nowMs)
  return (
    <div className={`border rounded-[14px] px-3.5 py-[13px] ${cardSurface(row)}`}>
      <div className="flex items-start gap-2.5">
        <div onClick={() => onOpenRecipe(item)} className="flex-1 min-w-0 cursor-pointer">
          <div className="text-[15px] font-semibold tracking-[-0.015em] leading-tight break-words">{item.name}</div>
          <div className="flex items-center gap-2 flex-wrap font-mono text-[10px] text-ink-3 mt-1">
            <span>{v.qtyLine}</span>
            {showStation && item.station && <span>{item.station}</span>}
            <span onClick={e => e.stopPropagation()}>
              <AssigneeChip cook={item.assignedCook} size="sm" onClick={onClaim ? () => onClaim(item) : undefined} />
            </span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`font-mono text-[13px] font-semibold leading-tight ${v.clockCls}`}>{v.clock}</div>
          <div className={`font-mono text-[9.5px] mt-0.5 ${v.subCls}`}>{v.clockSub}</div>
        </div>
        <JobMenu entries={menuEntries(props)} size={44} />
      </div>
      {v.stepLabel && (
        <div className="text-[13px] text-ink-2 mt-2 leading-snug">
          <span className="font-mono text-[10px] font-medium uppercase text-ink-3 mr-1.5">{v.stepLabel}</span>
          {v.stepText}
        </div>
      )}
      {seq && <div className="mt-2.5"><StepTrack seq={seq} pos={pos} ready={row.state === 'ready'} window={7} /></div>}
      <ChefNote note={item.todayLog?.note} compact className="mt-2" />
      {v.action.kind === 'held' ? (
        <button
          type="button"
          onClick={() => onOpenRecipe(item)}
          className="mt-2.5 font-mono text-[10.5px] text-blue-text border-b border-dashed border-current bg-transparent cursor-pointer"
        >
          You get a chime when it is time · open to move on early
        </button>
      ) : (
        <div className="mt-3">
          <NextButton action={v.action} size="big" onClick={() => runAction(props, row, v.action)} />
        </div>
      )}
    </div>
  )
}
