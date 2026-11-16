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
import { fmtMins } from './prep-runsheet'

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

export function waitClock(item: CookItem & { kind: 'WAIT' }, log: CursorLog, nowMs: number): WaitClock | null {
  const entered = log.stepEnteredAt ? new Date(log.stepEnteredAt).getTime() : NaN
  if (!Number.isFinite(entered)) return null
  const readyAtMs = entered + item.minutes * 60_000
  return { readyAtMs, leftMin: Math.ceil(Math.max(0, readyAtMs - nowMs) / 60_000), state: restState(readyAtMs, nowMs) }
}

export type NextKind = 'work' | 'wait' | 'held' | 'ready' | 'log'
export interface NextAction { kind: NextKind; to: number | null; label: string; sub: string }

const handsOnSub = (m: number) => (m > 0 ? `Hands-on · ${fmtMins(m)}` : 'Hands-on')

export function nextAction(seq: CookItem[], pos: number, clock: WaitClock | null): NextAction {
  const cur = seq[pos]
  const nxt = seq[pos + 1]
  if (!cur || !nxt) return { kind: 'log', to: null, label: 'Log yield', sub: '' }
  if (cur.kind === 'WAIT' && clock && clock.state === 'resting') {
    return { kind: 'held', to: pos + 1, label: `Resting · ${fmtMins(clock.leftMin)} left`, sub: 'Ready early? Open to move on' }
  }
  if (nxt.kind === 'WAIT') {
    return { kind: 'wait', to: pos + 1, label: `Start wait: ${nxt.phase ?? 'Wait'}`, sub: fmtMins(nxt.minutes) }
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
  const target = seq.find(it => it.key === stepKey)
  if (!target) return null
  const move: StepMove = { stepKey, stepEnteredAt: nowIso }
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
