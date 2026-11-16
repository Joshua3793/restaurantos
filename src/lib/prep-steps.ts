// The cook-along cursor — pure, vitest-covered.
//
// A recipe's method flattens into a COOK SEQUENCE: every method step is a STEP
// item, and a step's wait is a WAIT item straight after it. A job in flight is
// at exactly one item (`PrepLog.stepKey`, its own clock in `stepEnteredAt`), so
// Next / Back move ONE step at a time, not a whole block of the derived chain.
//
// The chain (`methodToChain`, the stage machinery the ladder, rest info,
// pipeline and start page read) is not replaced: each item knows the chain
// block it belongs to, and every cursor move keeps `stageIndex` in sync through
// `stepMoveFields` — the one function the API route and the optimistic client
// both apply.
//
// Design: docs/superpowers/specs/2026-11-16-prep-todo-step-flow-design.md
import { chainBlocks, methodToChain, type MethodStep } from './recipe-method'
import { appendStageEvent, restState, type RestState, type StageEvent } from './prep-stages'

interface ItemBase {
  /** The step's own key (STEP) or `${stepKey}:wait` (WAIT). */
  key: string
  /** The method step this item comes from. */
  stepKey: string
  minutes: number
  /** The phase in effect (a step's label, carried down to the next label). */
  phase: string | null
  /** The derived chain block this item belongs to; null for an untimed method. */
  chainIndex: number | null
  /** That block's chain key (what the stage history records); null with chainIndex. */
  chainKey: string | null
}

export type CookItem =
  | (ItemBase & { kind: 'STEP'; number: number; text: string })
  | (ItemBase & { kind: 'WAIT'; note: string | null })

export function cookSequence(method: MethodStep[] | null | undefined): CookItem[] | null {
  if (!method || method.length === 0) return null
  const chain = methodToChain(method)
  const blocks = chain ? chainBlocks(method) : []
  const activeOf = new Map<string, number>()
  const passiveOf = new Map<string, number>()
  for (const b of blocks) {
    for (const k of b.stepKeys) {
      if (b.kind === 'ACTIVE') { if (!activeOf.has(k)) activeOf.set(k, b.index) }
      else passiveOf.set(k, b.index)
    }
  }
  const keyOf = (i: number | null) => (i != null && chain?.[i] ? chain[i].key : null)

  const out: CookItem[] = []
  let phase: string | null = null
  method.forEach((step, idx) => {
    if (step.phase) phase = step.phase
    const stepChain = activeOf.get(step.key) ?? passiveOf.get(step.key) ?? null
    out.push({
      kind: 'STEP', key: step.key, stepKey: step.key, number: idx + 1, text: step.text,
      minutes: step.minutes ?? 0, phase, chainIndex: stepChain, chainKey: keyOf(stepChain),
    })
    if (step.wait) {
      const waitChain = passiveOf.get(step.key) ?? null
      out.push({
        kind: 'WAIT', key: `${step.key}:wait`, stepKey: step.key, minutes: step.wait.minutes,
        note: step.wait.note ?? null, phase, chainIndex: waitChain, chainKey: keyOf(waitChain),
      })
    }
  })
  return out
}

export interface CursorLog {
  status?: string
  stepKey?: string | null
  stepEnteredAt?: string | null
  stageIndex?: number | null
  stageEnteredAt?: string | null
  stageHistory?: unknown
}

/** The saved step; else the first item of the job's chain block (jobs started before the cursor existed, or a recipe edited mid-job); else the start. */
export function cursorOf(seq: CookItem[], log: CursorLog | null | undefined): number {
  if (log?.stepKey) {
    const i = seq.findIndex(it => it.key === log.stepKey)
    if (i >= 0) return i
  }
  if (log?.stageIndex != null) {
    const i = seq.findIndex(it => it.chainIndex === log.stageIndex)
    if (i >= 0) return i
  }
  return 0
}

export interface WaitClock { readyAtMs: number; leftMin: number; state: RestState }

/**
 * The current wait's timer. Its start is the step's own clock; a job whose place
 * came from the chain (started before the cursor existed — no `stepKey`) is on
 * the first item of its block, so the block's start is that wait's start.
 */
export function waitClock(item: CookItem & { kind: 'WAIT' }, log: CursorLog, nowMs: number): WaitClock | null {
  const start = log.stepEnteredAt ?? (log.stepKey ? null : log.stageEnteredAt)
  const entered = start ? new Date(start).getTime() : NaN
  if (!Number.isFinite(entered)) return null
  const readyAtMs = entered + item.minutes * 60_000
  return { readyAtMs, leftMin: Math.ceil(Math.max(0, readyAtMs - nowMs) / 60_000), state: restState(readyAtMs, nowMs) }
}

export type NextKind = 'work' | 'wait' | 'held' | 'ready' | 'log'
export interface NextAction { kind: NextKind; to: number | null; label: string; sub: string }

/** Button wording, spelled out so it reads at a glance: "5 min", "2 h 45 min". */
export function fmtDur(min: number): string {
  const m = Math.max(0, Math.round(min))
  const h = Math.floor(m / 60), r = m % 60
  if (!h) return `${m} min`
  return r ? `${h} h ${r} min` : `${h} h`
}

const handsOnSub = (m: number) => (m > 0 ? `Hands-on · ${fmtDur(m)}` : 'Hands-on')

export function nextAction(seq: CookItem[], pos: number, clock: WaitClock | null): NextAction {
  const cur = seq[pos]
  const nxt = seq[pos + 1]
  if (!cur || !nxt) return { kind: 'log', to: null, label: 'Log yield', sub: '' }
  // A wait is only "ready" on a clock that has run out — no clock reads as resting.
  if (cur.kind === 'WAIT' && (!clock || clock.state === 'resting')) {
    return { kind: 'held', to: pos + 1, label: clock ? `Resting · ${fmtDur(clock.leftMin)} left` : 'Resting', sub: 'Ready early? Open to move on' }
  }
  if (nxt.kind === 'WAIT') {
    return { kind: 'wait', to: pos + 1, label: `Start wait: ${nxt.phase ?? 'Wait'}`, sub: `${fmtDur(nxt.minutes)} wait` }
  }
  const label = nxt.phase === cur.phase ? 'Next step' : `Next: ${nxt.phase ?? 'next step'}`
  return { kind: cur.kind === 'WAIT' ? 'ready' : 'work', to: pos + 1, label, sub: handsOnSub(nxt.minutes) }
}

export interface StepMove {
  stepKey: string
  stepEnteredAt: string
  stageIndex?: number
  stageEnteredAt?: string
  stageHistory?: StageEvent[]
}

export function stepMoveFields(seq: CookItem[], log: CursorLog, stepKey: string, nowIso: string, byCookId?: string | null): StepMove | null {
  const targetIdx = seq.findIndex(it => it.key === stepKey)
  if (targetIdx < 0) return null
  const target = seq[targetIdx]
  // Back one step INTO a wait: the cook already left that wait when they started
  // the step they are on, so it goes back as finished at that moment — never a
  // fresh timer (a tapped Back must not turn a done 24 h ferment into "24 h left").
  let enteredAt = nowIso
  const leftAt = log.stepEnteredAt ? new Date(log.stepEnteredAt).getTime() : NaN
  if (target.kind === 'WAIT' && targetIdx === cursorOf(seq, log) - 1 && Number.isFinite(leftAt)) {
    enteredAt = new Date(leftAt - target.minutes * 60_000).toISOString()
  }
  const move: StepMove = { stepKey, stepEnteredAt: enteredAt }
  if (target.chainIndex != null && target.chainKey && target.chainIndex !== log.stageIndex) {
    move.stageIndex = target.chainIndex
    move.stageEnteredAt = nowIso
    move.stageHistory = appendStageEvent(log.stageHistory, {
      index: target.chainIndex, key: target.chainKey, enteredAt: nowIso, ...(byCookId ? { byCookId } : {}),
    })
  }
  return move
}

/**
 * The optimistic cursor move (Next / Back): the job is on the go at `stepKey`,
 * its first start time kept, the chain stage kept in sync. Returns the item
 * unchanged when the step is unknown or there is no log yet. Stock is never
 * touched — only DONE credits it.
 */
export function applyStepToItem<T extends {
  linkedRecipe?: { method?: MethodStep[] | null } | null
  todayLog?: (CursorLog & { id: string; startedAt?: string | null }) | null
}>(item: T, stepKey: string, nowIso: string): T {
  const log = item.todayLog
  const seq = cookSequence(item.linkedRecipe?.method)
  if (!log || !seq) return item
  const move = stepMoveFields(seq, log, stepKey, nowIso)
  if (!move) return item
  const todayLog = { ...log, status: 'IN_PROGRESS', startedAt: log.startedAt ?? nowIso, ...move } as NonNullable<T['todayLog']>
  return { ...item, todayLog }
}

const OPEN_STATUSES = new Set(['NOT_STARTED', 'IN_PROGRESS'])

/**
 * Guard for a cursor move. `from` is the step the cook's screen showed when the
 * button was tapped. `stale` when the job has already moved on another screen
 * (or is finished) — the caller refuses and refreshes; `noop` when the job is
 * already at `to` (a double tap, or two devices tapping the same Next).
 * A request with no `from` (an older screen) is allowed.
 */
export function checkStepMove(seq: CookItem[], log: CursorLog, from: string | null | undefined, to: string): 'ok' | 'noop' | 'stale' {
  if (log.status && !OPEN_STATUSES.has(log.status)) return 'stale'
  const current = seq[cursorOf(seq, log)]?.key
  if (to === current) return 'noop'
  if (from != null && from !== current) return 'stale'
  return 'ok'
}

/**
 * When a move happened: the time it was tapped (an offline tap replays later),
 * never later than now and never before the step it leaves began.
 */
export function moveTime(nowIso: string, atIso: string | null | undefined, floorIso: string | null | undefined): string {
  const now = new Date(nowIso).getTime()
  const at = atIso ? new Date(atIso).getTime() : NaN
  if (!Number.isFinite(at)) return nowIso
  let t = Math.min(at, now)
  const floor = floorIso ? new Date(floorIso).getTime() : NaN
  if (Number.isFinite(floor) && t < floor) t = floor
  return new Date(t).toISOString()
}
