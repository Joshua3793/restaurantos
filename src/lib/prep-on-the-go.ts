// "On the go" — every started prep job, in one lane, in the order it needs a
// cook; and the rule for when a finished wait rings. Pure, vitest-covered.
//
// A started job never leaves this lane until it is done: its card stays put
// and only its step track moves (src/lib/prep-steps.ts).
// Design: docs/superpowers/specs/2026-11-16-prep-todo-step-flow-design.md
import type { MethodStep } from './recipe-method'
import { cookSequence, cursorOf, waitClock, type CookItem, type CursorLog, type WaitClock } from './prep-steps'

export type GoState = 'ready' | 'working' | 'waiting'

export interface GoRow<T> {
  item: T
  /** The cook sequence, or null when the recipe has no method. */
  seq: CookItem[] | null
  pos: number
  cur: CookItem | null
  /** The current wait's timer; null on a hands-on step. */
  clock: WaitClock | null
  state: GoState
}

type GoLog = CursorLog & { startedAt?: string | null }

const ms = (v: string | null | undefined): number => {
  const n = v ? new Date(v).getTime() : NaN
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER
}

/** ready (longest-ready first) → hands-on (longest-running first) → waiting (soonest ready first). */
export function onTheGo<T extends {
  id: string
  todayLog?: GoLog | null
  linkedRecipe?: { method?: MethodStep[] | null } | null
}>(items: T[], nowMs: number): GoRow<T>[] {
  const rows: GoRow<T>[] = []
  for (const item of items) {
    const log = item.todayLog
    if (!log || log.status !== 'IN_PROGRESS') continue
    const seq = cookSequence(item.linkedRecipe?.method)
    const pos = seq ? cursorOf(seq, log) : 0
    const cur = seq ? seq[pos] ?? null : null
    const clock = cur && cur.kind === 'WAIT' ? waitClock(cur, log, nowMs) : null
    // Ready only on a wait clock that has run out — a wait with no clock rests.
    const state: GoState = cur?.kind === 'WAIT' ? (clock && clock.state !== 'resting' ? 'ready' : 'waiting') : 'working'
    rows.push({ item, seq, pos, cur, clock, state })
  }
  const rank: Record<GoState, number> = { ready: 0, working: 1, waiting: 2 }
  const key = (r: GoRow<T>) =>
    r.state === 'working' ? ms(r.item.todayLog?.stepEnteredAt ?? r.item.todayLog?.startedAt) : r.clock?.readyAtMs ?? Number.MAX_SAFE_INTEGER
  return rows.sort((a, b) => rank[a.state] - rank[b.state] || key(a) - key(b))
}

/** Minutes between repeat chimes while a finished wait has not been moved on. */
export const ALARM_REPEAT_MIN = 5

export function alarmShouldRing(readyAtMs: number, lastRangAtMs: number | null, nowMs: number): boolean {
  if (nowMs < readyAtMs) return false
  if (lastRangAtMs == null) return true
  return nowMs - lastRangAtMs >= ALARM_REPEAT_MIN * 60_000
}
