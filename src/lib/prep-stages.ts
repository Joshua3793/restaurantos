// Staged prep — pure stage-chain math. A job whose method spans days (cure,
// proof, rest, hang) is a chain of stages authored on the RECIPE
// (`Recipe.stages`, a Json array). The cook advances the item's ONE live log
// stage by stage; nothing here ever moves a stage on its own, and nothing here
// touches stock — DONE stays the only point that credits it.
//
// A recipe without stages resolves to `null` and every existing code path runs
// unchanged. Do NOT synthesize a two-stage chain from `passiveMinutes`: that
// would change the behaviour of every item that has a passive note today.
//
// Design: docs/superpowers/specs/2026-09-06-staged-prep-and-cadence-suggestions-design.md

export type StageKind = 'ACTIVE' | 'PASSIVE'

export interface RecipeStage {
  /** Stable id within the recipe; used in the log's stage history. */
  key: string
  /** "Mix", "Bulk rest", "Shape", "Proof", "Bake", "Cure", "Rinse & hang" */
  name: string
  kind: StageKind
  /** ≥ 0. PASSIVE minutes are the EXPECTED rest, not a hard limit. */
  minutes: number
  /** "overnight in the walk-in" */
  note?: string
}

/** One entry of `PrepLog.stageHistory`. */
export interface StageEvent {
  index: number
  key: string
  enteredAt: string
  byCookId?: string | null
}

/**
 * A rest row reads "ready" from `readyAt` on; it is only "overdue" once this
 * many minutes past `readyAt` have gone by. A proof that runs a little long
 * is not a late job.
 */
export const REST_GRACE_MINUTES = 60

/** Index / key the log's history uses for the terminal (Done) event. */
export const STAGE_DONE_KEY = '__done'

const KINDS: readonly StageKind[] = ['ACTIVE', 'PASSIVE']

export function newStageKey(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Tolerant reader for the Json column: returns the stages when the value is a
 * well-formed array, else null. Never throws — a hand-edited or pre-upgrade
 * value must degrade to "unstaged", not take the prep page down.
 */
export function parseStages(raw: unknown): RecipeStage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: RecipeStage[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object') return null
    const o = s as Record<string, unknown>
    const minutes = Number(o.minutes)
    if (typeof o.key !== 'string' || !o.key) return null
    if (typeof o.name !== 'string' || !o.name.trim()) return null
    if (!KINDS.includes(o.kind as StageKind)) return null
    if (!Number.isFinite(minutes) || minutes < 0) return null
    const stage: RecipeStage = { key: o.key, name: o.name, kind: o.kind as StageKind, minutes }
    if (typeof o.note === 'string' && o.note.trim()) stage.note = o.note
    out.push(stage)
  }
  return out
}

export type StagesValidation =
  | { ok: true; stages: RecipeStage[] }
  | { ok: false; error: string }

/**
 * Validate an authored chain (the recipe PATCH applies this). Rules: ≥ 1 stage;
 * the LAST stage is ACTIVE (a job ends with hands-on work and the yield log);
 * no two consecutive PASSIVE stages (merge them); minutes integer ≥ 0; keys
 * unique. Names are trimmed; a missing key is assigned so an editor can send
 * new rows without inventing ids.
 */
export function validateStages(input: unknown): StagesValidation {
  if (!Array.isArray(input)) return { ok: false, error: 'stages must be a list' }
  if (input.length === 0) return { ok: false, error: 'A staged recipe needs at least one stage' }
  const stages: RecipeStage[] = []
  const keys = new Set<string>()
  for (let i = 0; i < input.length; i++) {
    const s = input[i]
    if (!s || typeof s !== 'object') return { ok: false, error: `Stage ${i + 1} is not an object` }
    const o = s as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!name) return { ok: false, error: `Stage ${i + 1} needs a name` }
    if (!KINDS.includes(o.kind as StageKind)) return { ok: false, error: `${name}: kind must be ACTIVE or PASSIVE` }
    const minutes = Number(o.minutes)
    if (!Number.isInteger(minutes) || minutes < 0) return { ok: false, error: `${name}: minutes must be a whole number ≥ 0` }
    const key = typeof o.key === 'string' && o.key ? o.key : newStageKey()
    if (keys.has(key)) return { ok: false, error: `Stage key "${key}" is used twice` }
    keys.add(key)
    const kind = o.kind as StageKind
    if (kind === 'PASSIVE' && stages[i - 1]?.kind === 'PASSIVE') {
      return { ok: false, error: `${stages[i - 1].name} and ${name} are both unattended — merge them into one stage` }
    }
    const stage: RecipeStage = { key, name, kind, minutes }
    if (typeof o.note === 'string' && o.note.trim()) stage.note = o.note.trim()
    stages.push(stage)
  }
  if (stages[stages.length - 1].kind !== 'ACTIVE') {
    return { ok: false, error: 'The last stage must be hands-on — the job ends with work and the yield log' }
  }
  return { ok: true, stages }
}

/**
 * The chain for an item, or null when it is UNSTAGED. Only the recipe carries
 * stages in this pass (no per-PrepItem override) — `_item` is accepted so the
 * call shape is ready for one.
 */
export function resolveStages(
  recipe: { stages?: unknown } | null | undefined,
  _item?: unknown,
): RecipeStage[] | null {
  return parseStages(recipe?.stages)
}

/** Σ ACTIVE and Σ PASSIVE minutes — what `resolveActive`/`resolvePassive` derive. */
export function stageTotals(stages: RecipeStage[]): { active: number; passive: number } {
  let active = 0, passive = 0
  for (const s of stages) {
    if (s.kind === 'ACTIVE') active += s.minutes
    else passive += s.minutes
  }
  return { active, passive }
}

/** The stage fields a live log carries. */
export interface StageLogFields {
  status?: string
  stageIndex?: number | null
  stageEnteredAt?: string | Date | null
}

export interface StageAt { index: number; stage: RecipeStage }

/** The stage a log is in, or null when the log carries no (valid) stage index. */
export function currentStage(stages: RecipeStage[], log: StageLogFields | null | undefined): StageAt | null {
  const i = log?.stageIndex
  if (i == null || !Number.isInteger(i) || i < 0 || i >= stages.length) return null
  return { index: i, stage: stages[i] }
}

const toMs = (v: string | Date | null | undefined): number | null => {
  if (v == null) return null
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime()
  return Number.isFinite(ms) ? ms : null
}

/** When the current stage's timer runs out — EPOCH MS, never minute-of-day. */
export function stageReadyAt(log: StageLogFields | null | undefined, stage: RecipeStage): number | null {
  const entered = toMs(log?.stageEnteredAt)
  return entered == null ? null : entered + stage.minutes * 60_000
}

/** The first ACTIVE stage after `fromIndex`, or null when none is left. */
export function nextActiveStage(stages: RecipeStage[], fromIndex: number): StageAt | null {
  for (let i = fromIndex + 1; i < stages.length; i++) {
    if (stages[i].kind === 'ACTIVE') return { index: i, stage: stages[i] }
  }
  return null
}

/** A job in flight whose CURRENT stage is unattended — it belongs in the ladder, not Working On. */
export function isResting(stages: RecipeStage[] | null, log: StageLogFields | null | undefined): boolean {
  if (!stages || !log) return false
  if (log.status !== undefined && log.status !== 'IN_PROGRESS') return false
  const cur = currentStage(stages, log)
  return cur != null && cur.stage.kind === 'PASSIVE'
}

export type RestState = 'resting' | 'ready' | 'overdue'

/** resting until readyAt · ready after it · overdue only past readyAt + grace. */
export function restState(readyAtMs: number, nowMs: number, graceMinutes: number = REST_GRACE_MINUTES): RestState {
  if (nowMs < readyAtMs) return 'resting'
  if (nowMs < readyAtMs + graceMinutes * 60_000) return 'ready'
  return 'overdue'
}

/** "Mix · 1/5" */
export function stageLabel(index: number, total: number, stage: RecipeStage): string {
  return `${stage.name} · ${index + 1}/${total}`
}

/** Whole minutes since the current stage began (0 when unknown or in the future). */
export function stageElapsed(log: StageLogFields | null | undefined, nowMs: number): number {
  const entered = toMs(log?.stageEnteredAt)
  if (entered == null) return 0
  return Math.max(0, Math.floor((nowMs - entered) / 60_000))
}

export interface RemainingChain {
  /** hands-on minutes still to come, including the rest of an ACTIVE current stage */
  active: number
  /** unattended minutes still to come, including the rest of a PASSIVE current stage */
  passive: number
  /** when the whole chain ends if every stage runs to time — epoch ms */
  readyAtMs: number
}

/**
 * What is left of the chain from the log's current stage, with the current
 * stage's own timer taken into account. Null when the log carries no stage.
 */
export function remainingChain(stages: RecipeStage[], log: StageLogFields | null | undefined, nowMs: number): RemainingChain | null {
  const cur = currentStage(stages, log)
  if (!cur) return null
  const left = Math.max(0, cur.stage.minutes - stageElapsed(log, nowMs))
  let active = cur.stage.kind === 'ACTIVE' ? left : 0
  let passive = cur.stage.kind === 'PASSIVE' ? left : 0
  for (let i = cur.index + 1; i < stages.length; i++) {
    if (stages[i].kind === 'ACTIVE') active += stages[i].minutes
    else passive += stages[i].minutes
  }
  return { active, passive, readyAtMs: nowMs + (active + passive) * 60_000 }
}

/** Tolerant reader for `PrepLog.stageHistory`. */
export function parseStageHistory(raw: unknown): StageEvent[] {
  if (!Array.isArray(raw)) return []
  const out: StageEvent[] = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    if (typeof o.index !== 'number' || typeof o.key !== 'string' || typeof o.enteredAt !== 'string') continue
    const ev: StageEvent = { index: o.index, key: o.key, enteredAt: o.enteredAt }
    if (typeof o.byCookId === 'string') ev.byCookId = o.byCookId
    out.push(ev)
  }
  return out
}

/** History with one more event on the end (a correction is recorded, never erased). */
export function appendStageEvent(raw: unknown, event: StageEvent): StageEvent[] {
  return [...parseStageHistory(raw), event]
}
