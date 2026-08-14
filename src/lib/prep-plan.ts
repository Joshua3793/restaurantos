// Smart Prep v2 — pure planner math. ONE urgency step per item: it carries the
// deadline and the stock meaning; the stock reason is read-only evidence.
// Priority is ALWAYS computed from stock (never trusted from a snapshot): the
// stale-pill bug was the client keeping a server-computed `priority` after a
// completion changed onHand. The app-wide 3-level priority is a collapse of
// this scale (urgencyToPriority in prep-utils).
import {
  computePriority, computeSuggestedQty,
  autoUrgency, normalizeUrgency, urgencyToPriority,
  type PrepPriority, type PrepUrgency,
} from './prep-utils'
import { convertQty, sameDimension } from './uom'

export type { PrepUrgency }
export { urgencyToPriority }
export { URGENCY_ORDER as PLAN_URG_ORDER } from './prep-utils'

export interface PlanFields {
  onHand: number
  parLevel: number
  minThreshold: number
  targetToday: number | null
  manualPriorityOverride: string | null
  unit: string
  shelfLifeDays?: number | null
}

export const PLAN_URG_META: Record<PrepUrgency, {
  label: string; short: string
  /** stock condition this step means (read-only evidence caption) */
  stock: string
  /** deadline meaning */
  when: string
  hex: string
  dotClass: string; softClass: string; textClass: string; barClass: string
}> = {
  PASS:  { label: 'Critical-Start Service', short: 'CRIT',  stock: 'out, or under today’s target',        when: 'ready when doors open',   hex: '#dc2626', dotClass: 'bg-red',   softClass: 'bg-red-soft',   textClass: 'text-red-text',   barClass: 'bg-red' },
  MID:   { label: 'Mid-service',            short: 'MID',   stock: 'enough to open, dies mid-service',    when: 'ready 2h into service',   hex: '#d97706', dotClass: 'bg-gold',  softClass: 'bg-gold-soft',  textClass: 'text-gold-2',     barClass: 'bg-gold' },
  CLOSE: { label: 'Before close',           short: 'CLOSE', stock: 'below par, covers today',             when: 'any time today',          hex: '#2563eb', dotClass: 'bg-blue',  softClass: 'bg-blue-soft',  textClass: 'text-blue-text',  barClass: 'bg-blue' },
  TMRW:  { label: 'Tomorrow',               short: 'TMRW',  stock: 'at par — building ahead',             when: 'for tomorrow’s service',  hex: '#16a34a', dotClass: 'bg-green', softClass: 'bg-green-soft', textClass: 'text-green-text', barClass: 'bg-green' },
}

export const effectiveUrgency = (t: PlanFields): PrepUrgency =>
  normalizeUrgency(t.manualPriorityOverride) ?? autoUrgency(t.onHand, t.parLevel, t.targetToday)

export const autoUrgencyOf = (t: PlanFields): PrepUrgency =>
  autoUrgency(t.onHand, t.parLevel, t.targetToday)

export const autoPriority = (t: PlanFields): PrepPriority =>
  computePriority(t.onHand, t.parLevel, t.minThreshold, t.targetToday, null)

export const effectivePriority = (t: PlanFields): PrepPriority =>
  computePriority(t.onHand, t.parLevel, t.minThreshold, t.targetToday, t.manualPriorityOverride)

/** Sensible stepper increment per unit. */
export function prepStep(unit: string): number {
  const u = (unit || '').toLowerCase()
  if (u === 'kg' || u === 'l') return 0.5
  if (u === 'g' || u === 'ml') return 25
  return 1 // each, ea, batch, loaves, bunch, portion…
}

/** Snap a quantity to the unit's step (float-cleaned). */
export function roundPrepQty(v: number, unit: string): number {
  const step = prepStep(unit)
  return +(Math.round(v / step) * step).toFixed(2)
}

/** Rounded make-suggestion in the item's UOM: 0 at/above par, otherwise ≥ one step. */
export function suggestedDraftQty(t: PlanFields): number {
  const raw = computeSuggestedQty(t.onHand, t.parLevel, t.targetToday)
  if (raw <= 0) return 0
  return Math.max(prepStep(t.unit), roundPrepQty(raw, t.unit))
}

const fmtQ = (q: number, u: string) => `${q % 1 === 0 ? q : +q.toFixed(2)} ${u}`

/** Read-only evidence: why the system put the item at its step. */
export function whyLabel(t: PlanFields): string {
  const oh = t.onHand ?? 0, par = t.parLevel ?? 0
  const override = normalizeUrgency(t.manualPriorityOverride)
  if (override) return `chef moved it to ${PLAN_URG_META[override].label.toLowerCase()}`
  if (par > 0 && oh <= 0) return 'stock out'
  if (t.targetToday != null && oh < t.targetToday) return `under today's target ${fmtQ(t.targetToday, t.unit)}`
  if (par > 0 && oh < par * 0.5) return `${fmtQ(+oh.toFixed(2), t.unit)} of ${fmtQ(par, t.unit)} par — won't last service`
  if (oh < par) return `below par by ${fmtQ(+(par - oh).toFixed(2), t.unit)}`
  return t.shelfLifeDays ? `at par · ${t.shelfLifeDays}d shelf life` : 'at par'
}

const COMPLETE = new Set(['DONE', 'PARTIAL'])

/**
 * Optimistically re-derive an item after a status change: move onHand by the
 * yield delta, clear the override on completion (mirrors the server rule in
 * /api/prep/logs/[id]), and recompute priority + suggestedQty. This is the fix
 * for "done items drop back to Smart Prep still wearing a Critical pill".
 */
export function applyStatusToItem<T extends PlanFields & {
  priority: PrepPriority
  suggestedQty: number
  todayLog?: { status: string; actualPrepQty: number | null } | null
}>(item: T, newStatus: string, actualQty?: number): T {
  const completing = COMPLETE.has(newStatus)
  const prevQty = item.todayLog && COMPLETE.has(item.todayLog.status)
    ? Number(item.todayLog.actualPrepQty ?? 0)
    : 0
  let onHand = item.onHand
  if (completing) onHand += (actualQty ?? prevQty) - prevQty
  else onHand -= prevQty
  const manualPriorityOverride = completing ? null : item.manualPriorityOverride
  return {
    ...item,
    onHand,
    manualPriorityOverride,
    priority: computePriority(onHand, item.parLevel, item.minThreshold, item.targetToday, manualPriorityOverride),
    suggestedQty: computeSuggestedQty(onHand, item.parLevel, item.targetToday),
  }
}

/** Chef's within-bucket order for a draft row (unordered rows sink). */
export const draftListOrder = (t: { todayLog?: { listOrder?: number | null } | null }): number =>
  t.todayLog?.listOrder ?? 9999

/** Planned qty for a draft row: chef-set requiredQty wins, else rounded suggestion. */
export function draftQty(t: PlanFields & { todayLog?: { requiredQty?: number | string | null; status?: string; actualPrepQty?: number | null } | null }): number {
  const rq = t.todayLog?.requiredQty
  if (rq != null && Number(rq) > 0) return Number(rq)
  return suggestedDraftQty(t)
}

// ─── batches ───────────────────────────────────────────────────────────────
// The stored qty is ALWAYS the UOM amount (logs, yields and the To Do read it).
// Batch mode is a display/entry unit on top of the linked recipe's base yield.

export interface BatchFields extends PlanFields {
  linkedRecipe?: { baseYieldQty: number; yieldUnit: string } | null
}

/** The recipe's base yield expressed in the ITEM's unit, or null when batches
 *  don't apply (no recipe, zero yield, cross-dimension, or unit==='batch'). */
export function batchYield(t: BatchFields): number | null {
  const r = t.linkedRecipe
  if (!r || !(Number(r.baseYieldQty) > 0)) return null
  const u = (t.unit || '').toLowerCase()
  if (u === 'batch') return null // qty already counts batches
  if (!sameDimension(t.unit, r.yieldUnit)) return null
  const inItemUnit = convertQty(Number(r.baseYieldQty), r.yieldUnit, t.unit)
  return inItemUnit > 0 ? inItemUnit : null
}

export function batchCount(t: BatchFields, qty: number): number | null {
  const b = batchYield(t)
  return b ? Math.round((qty / b) * 100) / 100 : null
}

export function batchesToQty(t: BatchFields, n: number): number {
  const b = batchYield(t)
  return b ? Math.round(n * b * 100) / 100 : n
}

/** Suggested batches — round UP to the next half batch (you can't make 0.7 of a mix). */
export function suggestedBatches(t: BatchFields): number | null {
  const b = batchYield(t)
  if (!b) return null
  const raw = computeSuggestedQty(t.onHand, t.parLevel, t.targetToday)
  if (raw <= 0) return 0
  return Math.max(0.5, Math.ceil((raw / b) * 2) / 2)
}

export const fmtBatch = (n: number) => `×${n % 1 === 0 ? n : n.toFixed(1)}`

/**
 * The qty a fresh draft row should be seeded with: batch items take the
 * half-batch-CEILED suggestion (their default display mode), everything else
 * the UOM-rounded one. Seeding the plain UOM value on a batch item made every
 * add start "overridden" (×1.24 batch vs SUGG ×1.5).
 */
export function defaultDraftQty(t: BatchFields): number {
  const nb = suggestedBatches(t)
  if (nb != null) return nb > 0 ? batchesToQty(t, nb) : 0
  return suggestedDraftQty(t)
}

/** "×1.5 batch" label for a planned qty, or null when batches don't apply. */
export function batchLabel(t: BatchFields, qty: number): string | null {
  const n = batchCount(t, qty)
  return n ? `${fmtBatch(n)} batch` : null
}

// ─── deadlines + schedule ──────────────────────────────────────────────────

export interface PlanDayContext {
  /** first doors-open of the remaining day, minute-of-day */
  doorsOpen: number
  /** kitchen close, minute-of-day */
  close: number
  /** when prep hands become available — schedule cursors start here */
  shiftStart: number
}

const DEFAULT_CLOSE = 22 * 60

/** Derive the day's anchors from the RC's active services. Null when the RC has
 *  no timed services (on-demand) — schedule/deadlines don't apply. */
export function planDayContext(
  services: Array<{ timeMinutes: number; endMinutes: number | null }>,
  nowMin: number,
): PlanDayContext | null {
  if (!services.length) return null
  const starts = services.map(s => s.timeMinutes).sort((a, b) => a - b)
  // After the day's last doors-open, planning is for TOMORROW — roll the anchor
  // forward instead of deadlining everything against a service already started
  // (which painted every card "WON'T FIT" during evening planning).
  const doorsOpen = starts.find(s => s >= nowMin) ?? starts[0] + 1440
  const ends = services.map(s => {
    if (s.endMinutes == null) return s.timeMinutes + 120
    // an end before its start crosses midnight
    return s.endMinutes < s.timeMinutes ? s.endMinutes + 1440 : s.endMinutes
  })
  let close = Math.max(DEFAULT_CLOSE, ...ends)
  if (close <= nowMin) close += 1440
  return { doorsOpen, close, shiftStart: nowMin }
}

const MID_OFFSET = 120

/** The step's deadline, minute-of-day (≥1440 ⇒ tomorrow). `svcStart` is the
 *  item's own target-service start when it has one. */
export function urgencyDeadline(u: PrepUrgency, ctx: PlanDayContext, svcStart?: number | null): number {
  // An item's own service start also rolls to tomorrow once it has passed —
  // otherwise evening planning deadlines against a service already underway.
  const rawDoors = svcStart ?? ctx.doorsOpen
  const doors = rawDoors >= ctx.shiftStart ? rawDoors : rawDoors + 1440
  if (u === 'PASS') return doors
  if (u === 'MID') return doors + MID_OFFSET
  if (u === 'CLOSE') return ctx.close
  return ctx.doorsOpen >= 1440 ? ctx.doorsOpen : ctx.doorsOpen + 1440
}

export function fmtDeadline(m: number, fmtClock: (min: number) => string): string {
  return m >= 1440 ? `TMRW ${fmtClock(m % 1440)}` : fmtClock(m)
}

export interface PlanSlot {
  start: number
  end: number
  deadline: number
  fits: boolean
  over: number
}

interface SchedulableItem extends PlanFields {
  id: string
  station: string | null
  activeMinutes?: number | null
  passiveMinutes?: number | null
  estimatedPrepTime?: number | null
  service?: { timeMinutes: number } | null
}

const activeMin = (t: SchedulableItem) => t.activeMinutes ?? t.estimatedPrepTime ?? 0
const passiveMin = (t: SchedulableItem) => t.passiveMinutes ?? 0

/**
 * Sequence each station's draft through the crew actually on it: each item gets
 * its own slot; passive time doesn't hold a cook. Deadline-first order.
 */
export function planSchedule<T extends SchedulableItem>(
  draft: T[],
  cooks: Array<{ homeStation: string | null }>,
  ctx: PlanDayContext,
  ord: (t: T) => number = () => 0,
): Map<string, PlanSlot> {
  const map = new Map<string, PlanSlot>()
  const stations = [...new Set(draft.map(t => t.station ?? ''))]
  for (const s of stations) {
    const crew = Math.max(1, cooks.filter(c => (c.homeStation ?? '') === s).length)
    const cursors = Array<number>(crew).fill(ctx.shiftStart)
    draft
      .filter(t => (t.station ?? '') === s)
      .map(t => ({ t, dl: urgencyDeadline(effectiveUrgency(t), ctx, t.service?.timeMinutes ?? null) }))
      .sort((a, b) =>
        a.dl - b.dl ||
        PLAN_URG_ORDER_LOCAL.indexOf(effectiveUrgency(a.t)) - PLAN_URG_ORDER_LOCAL.indexOf(effectiveUrgency(b.t)) ||
        ord(a.t) - ord(b.t))
      .forEach(({ t, dl }) => {
        let i = 0
        cursors.forEach((c, j) => { if (c < cursors[i]) i = j })
        const start = cursors[i]
        cursors[i] = start + activeMin(t)
        const end = start + activeMin(t) + passiveMin(t)
        map.set(t.id, { start, end, deadline: dl, fits: end <= dl, over: Math.max(0, end - dl) })
      })
  }
  return map
}

const PLAN_URG_ORDER_LOCAL: PrepUrgency[] = ['PASS', 'MID', 'CLOSE', 'TMRW']

export interface StationLoad {
  station: string
  crew: number
  /** crew-minutes available before doors open */
  cap: number
  /** hands-on minutes that must land before/into service (PASS + MID) */
  forService: number
  total: number
  n: number
  pct: number
}

/** Station load against the crew-minutes available before doors open. */
export function stationLoad<T extends SchedulableItem>(
  draft: T[],
  cooks: Array<{ homeStation: string | null }>,
  ctx: PlanDayContext,
): StationLoad[] {
  const stations = [...new Set(draft.map(t => t.station ?? ''))]
  return stations
    .map(s => {
      const rows = draft.filter(t => (t.station ?? '') === s)
      const crew = Math.max(1, cooks.filter(c => (c.homeStation ?? '') === s).length)
      const cap = Math.max(0, ctx.doorsOpen - ctx.shiftStart) * crew
      const forService = rows
        .filter(t => { const u = effectiveUrgency(t); return u === 'PASS' || u === 'MID' })
        .reduce((a, t) => a + activeMin(t), 0)
      const total = rows.reduce((a, t) => a + activeMin(t), 0)
      return { station: s || 'Unassigned', crew, cap, forService, total, n: rows.length, pct: cap ? (forService / cap) * 100 : 0 }
    })
    .filter(x => x.n)
}

// ─── grouping (one helper so every pane groups identically) ────────────────

export interface PlanGroup<T> {
  key: string
  label: string
  sub?: string
  urg?: PrepUrgency
  rows: T[]
}

export function planGroups<T extends PlanFields & { station: string | null; category: string }>(
  rows: T[],
  by: 'urgency' | 'station' | 'category',
  opts: { stations?: string[]; crew?: Array<{ homeStation: string | null }>; ord?: (t: T) => number } = {},
): Array<PlanGroup<T>> {
  const ord = opts.ord ?? (() => 0)
  const byUrg = (a: T, b: T) =>
    PLAN_URG_ORDER_LOCAL.indexOf(effectiveUrgency(a)) - PLAN_URG_ORDER_LOCAL.indexOf(effectiveUrgency(b)) || ord(a) - ord(b)
  if (by === 'station') {
    const known = opts.stations ?? []
    const present = [...new Set(rows.map(t => t.station ?? ''))]
    const keys = [...known.filter(s => present.includes(s)), ...present.filter(s => !known.includes(s)).sort()]
    return keys
      .map(s => ({
        key: s || 'Unassigned',
        label: s || 'Unassigned',
        sub: opts.crew ? `${opts.crew.filter(c => (c.homeStation ?? '') === s).length} on station` : undefined,
        rows: rows.filter(t => (t.station ?? '') === s).sort(byUrg),
      }))
      .filter(g => g.rows.length)
  }
  if (by === 'category') {
    return [...new Set(rows.map(t => t.category))].sort()
      .map(c => ({ key: c, label: c, rows: rows.filter(t => t.category === c).sort(byUrg) }))
      .filter(g => g.rows.length)
  }
  return PLAN_URG_ORDER_LOCAL
    .map(u => ({
      key: u,
      label: PLAN_URG_META[u].label,
      sub: PLAN_URG_META[u].stock,
      urg: u,
      rows: rows.filter(t => effectiveUrgency(t) === u).sort((a, b) => ord(a) - ord(b)),
    }))
    .filter(g => g.rows.length)
}
