// One Method, with waits — pure, vitest-covered.
//
// A PREP recipe's method is ONE ordered list. Any step can carry hands-on
// minutes and a WAIT (an unattended span after it). The run-sheet chain the
// prep page reads (`RecipeStage[]`) is DERIVED from that list by
// `methodToChain`, never authored: consecutive steps up to and including a step
// with a wait form a hands-on block, the wait is the unattended stage after it,
// and the steps after the final wait form the last block, which ends with the
// yield log. Everything downstream (rest rows, the pipeline, start-by, the
// stage history) reads the derived chain through `resolveStages` unchanged.
//
// Design: docs/superpowers/specs/2026-09-06-recipe-method-with-waits-design.md
import type { RecipeStage } from './prep-stages'

export interface MethodWait {
  /** integer ≥ 1 — the expected unattended span, not a hard limit */
  minutes: number
  /** "uncovered in the walk-in", "in the cooler" */
  note?: string
}

export interface MethodStep {
  /** stable id; the derived chain's keys come from it, so the log history stays stable */
  key: string
  /** the instruction — required */
  text: string
  /** free-text label grouping this step and the ones after it until the next label */
  phase?: string
  /** hands-on minutes for THIS step; absent = untimed (0) */
  minutes?: number
  /** an unattended span AFTER this step */
  wait?: MethodWait
}

export const LAST_STEP_WAIT_ERROR =
  "A wait can't be the last thing — add the step that finishes the job (it ends with the yield log)."

const NAME_MAX = 40

export function newStepKey(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Tolerant reader for the Json column: the steps when the value is a
 * well-formed array, else null. Never throws — a pre-upgrade or hand-edited
 * value degrades to "no method", not to a broken recipe page.
 */
export function parseMethod(raw: unknown): MethodStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: MethodStep[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object') return null
    const o = s as Record<string, unknown>
    if (typeof o.key !== 'string' || !o.key) return null
    if (typeof o.text !== 'string' || !o.text.trim()) return null
    const step: MethodStep = { key: o.key, text: o.text }
    if (typeof o.phase === 'string' && o.phase.trim()) step.phase = o.phase
    if (o.minutes != null) {
      const m = Number(o.minutes)
      if (!Number.isFinite(m) || m < 0) return null
      step.minutes = m
    }
    if (o.wait != null) {
      if (typeof o.wait !== 'object') return null
      const w = o.wait as Record<string, unknown>
      const m = Number(w.minutes)
      if (!Number.isFinite(m) || m < 1) return null
      step.wait = { minutes: m }
      if (typeof w.note === 'string' && w.note.trim()) step.wait.note = w.note
    }
    out.push(step)
  }
  return out
}

export type MethodValidation =
  | { ok: true; method: MethodStep[] }
  | { ok: false; error: string }

/**
 * Validate an authored method (the recipe routes apply this). Names are
 * trimmed, a missing key is assigned, an empty phase becomes absent. The one
 * structural rule a chef can trip is a wait on the LAST step — the job has to
 * end with the step that logs the yield — and the message says so in those
 * words. An empty list is valid and means "no method".
 */
export function validateMethod(input: unknown): MethodValidation {
  if (input == null) return { ok: true, method: [] }
  if (!Array.isArray(input)) return { ok: false, error: 'method must be a list of steps' }
  const method: MethodStep[] = []
  const keys = new Set<string>()
  for (let i = 0; i < input.length; i++) {
    const s = input[i]
    if (!s || typeof s !== 'object') return { ok: false, error: `Step ${i + 1} is not an object` }
    const o = s as Record<string, unknown>
    const text = typeof o.text === 'string' ? o.text.trim() : ''
    if (!text) return { ok: false, error: `Step ${i + 1} needs an instruction` }
    const key = typeof o.key === 'string' && o.key ? o.key : newStepKey()
    if (keys.has(key)) return { ok: false, error: `Step key "${key}" is used twice` }
    keys.add(key)
    const step: MethodStep = { key, text }
    const phase = typeof o.phase === 'string' ? o.phase.trim() : ''
    if (phase) step.phase = phase
    if (o.minutes != null && o.minutes !== '') {
      const m = Number(o.minutes)
      if (!Number.isInteger(m) || m < 0) return { ok: false, error: `Step ${i + 1}: hands-on minutes must be a whole number ≥ 0` }
      if (m > 0) step.minutes = m
    }
    if (o.wait != null) {
      if (typeof o.wait !== 'object') return { ok: false, error: `Step ${i + 1}: wait must be an object` }
      const w = o.wait as Record<string, unknown>
      const m = Number(w.minutes)
      if (!Number.isInteger(m) || m < 1) return { ok: false, error: `Step ${i + 1}: a wait needs whole minutes ≥ 1` }
      step.wait = { minutes: m }
      const note = typeof w.note === 'string' ? w.note.trim() : ''
      if (note) step.wait.note = note
    }
    method.push(step)
  }
  if (method.length && method[method.length - 1].wait) return { ok: false, error: LAST_STEP_WAIT_ERROR }
  return { ok: true, method }
}

/** True when any step carries hands-on minutes or a wait — the method drives timing. */
export function isTimedMethod(method: MethodStep[] | null | undefined): boolean {
  return !!method?.some(s => (s.minutes ?? 0) > 0 || s.wait != null)
}

/** A long first instruction is cut at a word boundary — it becomes a button label ("Next: …"). */
function shortName(text: string): string {
  const t = text.trim().split('\n')[0]
  if (t.length <= NAME_MAX) return t
  const head = t.slice(0, NAME_MAX)
  const cut = head.lastIndexOf(' ')
  return `${(cut > NAME_MAX / 2 ? head.slice(0, cut) : head).trimEnd()}…`
}

const blockName = (phase: string | undefined, first: MethodStep): string => phase ?? shortName(first.text)

/** Per chain index, the step keys it covers — what the cook-along lights. */
export interface ChainBlock {
  /** index into the derived chain */
  index: number
  kind: 'ACTIVE' | 'PASSIVE'
  stepKeys: string[]
}

interface Derived { chain: RecipeStage[]; blocks: ChainBlock[] }

function derive(method: MethodStep[] | null | undefined): Derived | null {
  if (!method || method.length === 0 || !isTimedMethod(method)) return null
  const chain: RecipeStage[] = []
  const blocks: ChainBlock[] = []
  let phase: string | undefined
  let pending: MethodStep[] = []
  let pendingPhase: string | undefined
  const flushBlock = () => {
    if (pending.length === 0) return
    const first = pending[0]
    chain.push({
      key: first.key,
      name: blockName(pendingPhase, first),
      kind: 'ACTIVE',
      minutes: pending.reduce((a, s) => a + (s.minutes ?? 0), 0),
    })
    blocks.push({ index: chain.length - 1, kind: 'ACTIVE', stepKeys: pending.map(s => s.key) })
    pending = []
  }
  for (const step of method) {
    if (step.phase) phase = step.phase
    // A block is NAMED by a phase only when the label is set on its own first
    // step; otherwise its first instruction names it ("Next: Wrap in butcher
    // paper…" tells a cook more than "Next: Smoking" would). The phase in
    // effect still names the waits ("Smoking · wait").
    if (pending.length === 0) pendingPhase = step.phase
    const last = chain[chain.length - 1]
    // A wait straight after a wait, with no hands-on work between: one merged
    // wait, so the chef is never told to restructure their method.
    if (step.wait && pending.length === 0 && last && last.kind === 'PASSIVE' && !(step.minutes && step.minutes > 0)) {
      last.minutes += step.wait.minutes
      if (step.wait.note) last.note = last.note ? `${last.note} · ${step.wait.note}` : step.wait.note
      blocks[blocks.length - 1].stepKeys.push(step.key)
      continue
    }
    pending.push(step)
    if (step.wait) {
      flushBlock()
      const stage: RecipeStage = {
        key: `${step.key}:wait`,
        name: phase ? `${phase} · wait` : 'Wait',
        kind: 'PASSIVE',
        minutes: step.wait.minutes,
      }
      if (step.wait.note) stage.note = step.wait.note
      chain.push(stage)
      blocks.push({ index: chain.length - 1, kind: 'PASSIVE', stepKeys: [step.key] })
    }
  }
  flushBlock()
  // A method that validated never ends on a wait; a hand-edited one might.
  // Refuse to hand the run sheet a chain it cannot walk.
  if (chain.length === 0 || chain[chain.length - 1].kind !== 'ACTIVE') return null
  return { chain, blocks }
}

/**
 * The run-sheet chain for a method — the same `RecipeStage[]` shape the stage
 * machinery reads — or null when the method is untimed (plain instructions).
 */
export function methodToChain(method: MethodStep[] | null | undefined): RecipeStage[] | null {
  return derive(method)?.chain ?? null
}

/** Which steps each chain index covers (a wait covers the step that carries it). */
export function chainBlocks(method: MethodStep[] | null | undefined): ChainBlock[] {
  return derive(method)?.blocks ?? []
}

/** Σ hands-on / Σ unattended minutes of the method (0/0 when untimed). */
export function methodTotals(method: MethodStep[] | null | undefined): { active: number; passive: number } {
  let active = 0, passive = 0
  for (const s of method ?? []) {
    active += s.minutes ?? 0
    passive += s.wait?.minutes ?? 0
  }
  return { active, passive }
}

/** The plain instruction lines, for readers that only want text. */
export function methodTexts(method: MethodStep[] | null | undefined): string[] {
  return (method ?? []).map(s => s.text)
}

/**
 * The method a legacy recipe implies: one row per ACTIVE stage (its note, where
 * chefs put instructions, becomes a second line), each PASSIVE stage a wait on
 * the row before it, then the free-text steps as untimed rows. Used by the data
 * migration; returns null when the recipe carries neither.
 */
export function legacyToMethod(
  stages: RecipeStage[] | null,
  steps: string[] | null | undefined,
): MethodStep[] | null {
  const out: MethodStep[] = []
  if (stages && stages.length) {
    for (const st of stages) {
      if (st.kind === 'ACTIVE') {
        const step: MethodStep = { key: st.key, text: st.note ? `${st.name}\n${st.note}` : st.name }
        if (st.minutes > 0) step.minutes = st.minutes
        out.push(step)
      } else {
        const prev = out[out.length - 1]
        const wait: MethodWait = { minutes: Math.max(1, st.minutes) }
        if (st.note) wait.note = st.note
        if (!prev) out.push({ key: st.key, text: st.name, wait })
        else if (prev.wait) out.push({ key: st.key, text: st.name, wait })
        else prev.wait = wait
      }
    }
  }
  const seen = new Set(out.map(s => s.text.split('\n')[0].trim().toLowerCase()))
  for (const t of steps ?? []) {
    const text = String(t).trim()
    if (!text || seen.has(text.toLowerCase())) continue
    out.push({ key: newStepKey(), text })
  }
  return out.length ? out : null
}
