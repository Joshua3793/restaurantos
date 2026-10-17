// Recipe Scan — the review screen's pure rules: what a pick, a confirm or an
// amount edit does to a line, the method edits (reorder, split, merge, delete,
// phases), the cost/time summaries and the Create item body. No React, no
// database: the page calls these and autosaves the result.
import { DIMENSION_BASE, dimensionOf, type Dimension, type PackLink } from '@/lib/item-model'
import { UNIT_FACTORS, canonicalUom } from '@/lib/uom'
import type { MethodStep } from '@/lib/recipe-method'
import { newStepKey } from '@/lib/recipe-method'
import { resolveAmount, type AmountItem } from './amount'
import { readQtyText } from './build-draft'
import type { DraftData, DraftLine } from './types'

/** What the screen knows about a linked item / prep recipe (from the draft GET or the picker). */
export interface LinkInfo {
  baseUnit: string | null
  boughtAs: string
  supplier: string | null
  amount: AmountItem | null
}

/** A candidate as GET /api/recipe-scans/candidates returns it. */
export interface PickCandidate {
  kind: 'item' | 'recipe'
  id: string
  name: string
  usedInRecipes: number
  boughtAs: string
  supplier: string | null
  baseUnit: string | null
  amount: AmountItem | null
}

export type LineCost = { lineCost: number | null; unpriced: boolean }
export type LineCosts = Record<string, LineCost>

export const linkKey = (l: { kind: string; id: string }) => `${l.kind}:${l.id}`

const validQty = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

function mapLine(d: DraftData, key: string, fn: (l: DraftLine) => DraftLine): DraftData {
  return { ...d, lines: d.lines.map(l => (l.key === key ? fn(l) : l)) }
}

/** An item we only know the base unit of: no each-measure, no density. */
export function amountFromBase(baseUnit: string | null | undefined): AmountItem | null {
  const u = canonicalUom(baseUnit ?? '')
  if (!u || !UNIT_FACTORS[u]) return null
  return { dimension: dimensionOf(u), baseUnit: u, eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
}

/**
 * Link a line to what the chef picked. The amount is worked out again from the
 * words on the page, into the picked thing's own unit (Joshua's rule) — a
 * count word with no known weight comes back as a CHECK asking how much.
 * A pick is the chef's own choice, so it is never a "close guess".
 */
export function applyPick(
  d: DraftData,
  key: string,
  pick: { kind: 'item' | 'recipe'; id: string; name: string; amount: AmountItem | null; baseUnit?: string | null },
  opts: { createdItem?: boolean } = {},
): DraftData {
  const next = mapLine(d, key, line => {
    const { qty, unit } = readQtyText(line.qtyText ?? '')
    const item = pick.amount ?? amountFromBase(pick.baseUnit)
    const r = item
      ? resolveAmount({ raw: line.raw, name: line.name, qty, unit }, item, null)
      : { qty: null, unit: null, status: 'CHECK' as const, reason: 'Unit unknown — check' }
    const out: DraftLine = {
      ...line,
      link: { kind: pick.kind, id: pick.id, name: pick.name },
      qty: r.qty, unit: r.unit, status: r.status, reason: r.reason,
      allergens: null,
    }
    if (opts.createdItem) out.createdItem = true
    else delete out.createdItem
    return out
  })
  const siblingHints = { ...next.siblingHints }
  delete siblingHints[key]
  return { ...next, siblingHints }
}

/** "Keep uncosted": a text-only line. Its allergens still have to be chosen. */
export function keepUncosted(d: DraftData, key: string): DraftData {
  return mapLine(d, key, line => {
    const out: DraftLine = { ...line, link: null, qty: null, unit: null, status: 'NO_MATCH', reason: null }
    delete out.createdItem
    return out
  })
}

/** A CHECK line can be confirmed once it has an amount. */
export function canConfirm(line: DraftLine): boolean {
  return line.status === 'CHECK' && !!line.link && validQty(line.qty) && !!line.unit
}

export function confirmLine(d: DraftData, key: string): DraftData {
  return mapLine(d, key, line => (canConfirm(line) ? { ...line, status: 'MATCHED', reason: null } : line))
}

/**
 * The chef's amount on a linked line. A real amount turns "no amount" into a
 * normal line; clearing it makes the line "no amount" (saved linked, $0, so
 * it still carries the item's allergens). A CHECK stays a CHECK until confirmed.
 */
export function setLineAmount(d: DraftData, key: string, qty: number | null, unit: string | null): DraftData {
  return mapLine(d, key, line => {
    if (!line.link) return line
    if (validQty(qty)) {
      return { ...line, qty, unit: unit || line.unit, status: line.status === 'NO_AMOUNT' ? 'MATCHED' : line.status }
    }
    return {
      ...line, qty: 0, unit: unit || line.unit,
      status: line.status === 'CHECK' ? 'CHECK' : 'NO_AMOUNT',
    }
  })
}

/** An unlinked line keeps its amount as written; the chef can still correct the words. */
export function setQtyText(d: DraftData, key: string, qtyText: string): DraftData {
  return mapLine(d, key, line => (line.link ? line : { ...line, qtyText }))
}

export function setAllergens(d: DraftData, key: string, allergens: string[] | null): DraftData {
  return mapLine(d, key, line => (line.link ? line : { ...line, allergens }))
}

/** Lines the chef still has to act on: a CHECK, or an unlinked line with no allergen choice. */
export function needsYou(line: DraftLine): boolean {
  return line.status === 'CHECK' || (line.link === null && line.allergens === null)
}

// ─── Cost + time ─────────────────────────────────────────────────────────────

export interface CostSummary {
  total: number
  costed: number
  matched: number
  check: number
  noMatch: number
  kept: number
  noAmount: number
  /** Sum of every line cost known so far. */
  batch: number
  /** Lines that should cost something but are not in the batch yet. */
  missing: number
  /** Linked to an item with no price yet. */
  unpriced: number
  /** True once every line is costed, no amount, or deliberately uncosted. */
  complete: boolean
  perYield: number | null
}

export function costSummary(d: DraftData, costs: LineCosts): CostSummary {
  const s: CostSummary = {
    total: d.lines.length, costed: 0, matched: 0, check: 0, noMatch: 0, kept: 0, noAmount: 0,
    batch: 0, missing: 0, unpriced: 0, complete: false, perYield: null,
  }
  for (const l of d.lines) {
    const c = costs[l.key]
    if (!l.link) {
      if (l.allergens === null) { s.noMatch++; s.missing++ } else s.kept++
      continue
    }
    if (l.status === 'CHECK') s.check++
    else if (l.status === 'NO_AMOUNT') s.noAmount++
    else s.matched++
    if (c && c.lineCost !== null && Number.isFinite(c.lineCost)) s.batch += c.lineCost
    if (c?.unpriced) s.unpriced++
    if (l.status === 'NO_AMOUNT') continue
    if (c && c.lineCost !== null && !c.unpriced) s.costed++
    else s.missing++
  }
  s.complete = s.missing === 0 && s.check === 0
  if (validQty(d.yieldQty)) s.perYield = s.batch / d.yieldQty
  return s
}

export interface TimeSummary { handsOn: number; wait: number; guessed: number }

export function timeSummary(method: MethodStep[], guessed: DraftData['guessed']): TimeSummary {
  let handsOn = 0
  let wait = 0
  let g = 0
  for (const s of method) {
    handsOn += s.minutes ?? 0
    wait += s.wait?.minutes ?? 0
    const f = guessed?.[s.key]
    if (f?.minutes) g++
    if (f?.wait) g++
  }
  return { handsOn, wait, guessed: g }
}

/** 40 → "40 min", 765 → "12h 45m", 720 → "12 h". */
export function formatMinutes(m: number): string {
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h}h ${r}m` : `${h} h`
}

// ─── Method edits ────────────────────────────────────────────────────────────
// A step's `phase` labels it and every step after it until the next label
// (recipe-method.ts). Edits work on each step's EFFECTIVE phase and write the
// labels back only where the phase changes, so the saved method stays the
// shape the recipe editor shows.

export interface PhaseRun { phase: string; start: number; end: number }

function effectivePhases(method: MethodStep[]): string[] {
  let cur = ''
  return method.map(s => {
    if (s.phase && s.phase.trim()) cur = s.phase.trim()
    return cur
  })
}

function withPhases(method: MethodStep[], phases: string[]): MethodStep[] {
  let prev = ''
  return method.map((s, i) => {
    const p = phases[i] ?? ''
    const out: MethodStep = { ...s }
    if (p && p !== prev) out.phase = p
    else delete out.phase
    prev = p || prev
    return out
  })
}

/** The method's phases in order: name ('' = no phase) and the steps [start, end). */
export function phaseRuns(method: MethodStep[]): PhaseRun[] {
  const eff = effectivePhases(method)
  const runs: PhaseRun[] = []
  eff.forEach((p, i) => {
    const last = runs[runs.length - 1]
    if (last && last.phase === p) last.end = i + 1
    else runs.push({ phase: p, start: i, end: i + 1 })
  })
  return runs
}

export interface MethodState { method: MethodStep[]; guessed: DraftData['guessed'] }

/** Edit one step. Changing its hands-on or wait time clears that GUESSED flag. */
export function patchStep(st: MethodState, i: number, p: Partial<Pick<MethodStep, 'text' | 'minutes' | 'wait'>>): MethodState {
  const s = st.method[i]
  if (!s) return st
  const next: MethodStep = { ...s, ...p }
  ;(Object.keys(next) as (keyof MethodStep)[]).forEach(k => { if (next[k] === undefined) delete next[k] })
  if (next.minutes !== undefined && !(next.minutes > 0)) delete next.minutes
  const guessed = { ...st.guessed }
  const g = { ...(guessed[s.key] ?? {}) }
  if ('minutes' in p && p.minutes !== s.minutes) delete g.minutes
  if ('wait' in p && (p.wait?.minutes !== s.wait?.minutes || !p.wait)) delete g.wait
  if (g.minutes || g.wait) guessed[s.key] = g
  else delete guessed[s.key]
  return { method: st.method.map((x, j) => (j === i ? next : x)), guessed }
}

/**
 * Move a step one place. Inside a phase it swaps with its neighbour; at a
 * phase edge it crosses into the next phase instead (it joins it), so a phase
 * is never cut in two.
 */
export function moveStep(st: MethodState, i: number, dir: -1 | 1): MethodState {
  const j = i + dir
  if (i < 0 || i >= st.method.length || j < 0 || j >= st.method.length) return st
  const eff = effectivePhases(st.method)
  if (eff[i] !== eff[j]) {
    const phases = [...eff]
    phases[i] = eff[j]
    return { ...st, method: withPhases(st.method, phases) }
  }
  const m = [...st.method]
  ;[m[i], m[j]] = [m[j], m[i]]
  const phases = [...eff]
  return { ...st, method: withPhases(m, phases) }
}

/** Where to split a step's text when the chef didn't put the cursor anywhere: the sentence break nearest the middle. */
export function defaultSplitAt(text: string): number | null {
  const t = text.trim()
  const mid = t.length / 2
  let best: number | null = null
  const consider = (at: number) => {
    if (at <= 0 || at >= t.length) return
    if (best === null || Math.abs(at - mid) < Math.abs(best - mid)) best = at
  }
  const sentence = /[.!?;]\s+/g
  let m: RegExpExecArray | null
  while ((m = sentence.exec(t))) consider(m.index + m[0].length)
  if (best !== null) return best
  const comma = /,\s+|\s+(?:then|and)\s+/g
  while ((m = comma.exec(t))) consider(m.index + (m[0].startsWith(',') ? m[0].length : 0))
  if (best !== null) return best
  const space = /\s+/g
  while ((m = space.exec(t))) consider(m.index)
  return best
}

/** Split one step in two at `at` (a character index into its text). Hands-on stays on the first, the wait moves to the second. */
export function splitStep(st: MethodState, i: number, at?: number | null): MethodState {
  const s = st.method[i]
  if (!s) return st
  const text = s.text
  const cut = at != null && at > 0 && at < text.length ? at : defaultSplitAt(text)
  if (cut == null) return st
  const a = text.slice(0, cut).trim()
  const b = text.slice(cut).trim()
  if (!a || !b) return st
  const keys = new Set(st.method.map(x => x.key))
  let key = newStepKey()
  while (keys.has(key)) key = newStepKey()
  const first: MethodStep = { ...s, text: a }
  delete first.wait
  const second: MethodStep = { key, text: b.charAt(0).toUpperCase() + b.slice(1) }
  if (s.wait) second.wait = s.wait
  const guessed = { ...st.guessed }
  const g = guessed[s.key]
  if (g) {
    if (g.minutes) guessed[s.key] = { minutes: true }
    else delete guessed[s.key]
    if (g.wait) guessed[key] = { wait: true }
  }
  const method = [...st.method.slice(0, i), first, second, ...st.method.slice(i + 1)]
  return { method, guessed }
}

/** Merge a step with the one after it: texts joined, hands-on added, the later wait kept. */
export function mergeWithNext(st: MethodState, i: number): MethodState {
  const s = st.method[i]
  const n = st.method[i + 1]
  if (!s || !n) return st
  const eff = effectivePhases(st.method)
  const merged: MethodStep = { key: s.key, text: `${s.text.trim()} ${n.text.trim()}`.trim() }
  const minutes = (s.minutes ?? 0) + (n.minutes ?? 0)
  if (minutes > 0) merged.minutes = minutes
  const wait = n.wait ?? s.wait
  if (wait) merged.wait = wait
  const gs = st.guessed[s.key] ?? {}
  const gn = st.guessed[n.key] ?? {}
  const g: { minutes?: true; wait?: true } = {}
  if (gs.minutes || gn.minutes) g.minutes = true
  if ((n.wait ? gn.wait : gs.wait)) g.wait = true
  const guessed = { ...st.guessed }
  delete guessed[n.key]
  if (g.minutes || g.wait) guessed[s.key] = g
  else delete guessed[s.key]
  const m = [...st.method.slice(0, i), merged, ...st.method.slice(i + 2)]
  const phases = [...eff.slice(0, i), eff[i], ...eff.slice(i + 2)]
  return { method: withPhases(m, phases), guessed }
}

export function deleteStep(st: MethodState, i: number): MethodState {
  if (!st.method[i]) return st
  const eff = effectivePhases(st.method)
  const m = st.method.filter((_, j) => j !== i)
  const phases = eff.filter((_, j) => j !== i)
  const guessed = { ...st.guessed }
  delete guessed[st.method[i].key]
  return { method: withPhases(m, phases), guessed }
}

/** Rename the phase that starts at step `start` (every step in that run). */
export function renamePhase(st: MethodState, start: number, name: string): MethodState {
  const runs = phaseRuns(st.method)
  const run = runs.find(r => r.start === start)
  if (!run) return st
  const eff = effectivePhases(st.method)
  const phases = eff.map((p, j) => (j >= run.start && j < run.end ? name.trim() : p))
  return { ...st, method: withPhases(st.method, phases) }
}

/** Start a new phase at step `i`: it and the rest of its current phase move into it. */
export function startPhaseAt(st: MethodState, i: number, name: string): MethodState {
  const runs = phaseRuns(st.method)
  const run = runs.find(r => i >= r.start && i < r.end)
  if (!run || !name.trim()) return st
  const eff = effectivePhases(st.method)
  const phases = eff.map((p, j) => (j >= i && j < run.end ? name.trim() : p))
  return { ...st, method: withPhases(st.method, phases) }
}

/** Add a closing step after the last one (the method can't end on a wait). */
export function addStepAtEnd(st: MethodState, text: string): MethodState {
  const keys = new Set(st.method.map(x => x.key))
  let key = newStepKey()
  while (keys.has(key)) key = newStepKey()
  return { ...st, method: [...st.method, { key, text }] }
}

// ─── Create item ─────────────────────────────────────────────────────────────

export interface CreateItemBody {
  itemName: string
  dimension: Dimension
  packChain: PackLink[]
  countUnit: string
  isStocked: true
  revenueCenterId?: string
}

/**
 * The POST /api/inventory body for "Create item" (name now, price later): a
 * one-level chain in the unit the chef chose — `[{ unit: 'kg', per: 1000 }]`,
 * the bare-measure chain the invoice create-new path gives a by-weight item —
 * counted in that unit, pricing left to the database default ($0), stocked.
 */
export function createItemBody(name: string, unit: string, revenueCenterId?: string | null): CreateItemBody {
  const u = canonicalUom(unit)
  const f = UNIT_FACTORS[u]
  if (!f) throw new Error(`"${unit}" is not a unit the app knows.`)
  const body: CreateItemBody = {
    itemName: name.trim(),
    dimension: dimensionOf(u),
    packChain: [{ unit: u, per: f.toBase }],
    countUnit: u,
    isStocked: true,
  }
  if (revenueCenterId) body.revenueCenterId = revenueCenterId
  return body
}

/** The amount model of an item just made by `createItemBody`. */
export function createdItemAmount(body: CreateItemBody): AmountItem {
  return {
    dimension: body.dimension, baseUnit: DIMENSION_BASE[body.dimension],
    eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  }
}

/** The unit Create item starts on: the page's own measure family, else kg. */
export function defaultCreateUnit(qtyText: string): string {
  const { unit } = readQtyText(qtyText ?? '')
  const u = canonicalUom(unit ?? '')
  const f = UNIT_FACTORS[u] ?? UNIT_FACTORS[canonicalUom((unit ?? '').replace(/s$/, ''))]
  if (!f) return 'kg'
  return f.dim === 'weight' ? 'kg' : f.dim === 'volume' ? 'l' : 'each'
}
