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
import { fmtClock } from './prep-runsheet'
import {
  resolveStages, currentStage, nextActiveStage, stageReadyAt, restState, appendStageEvent, remainingChain,
  type RecipeStage, type StageAt, type RestState, type StageEvent,
} from './prep-stages'
import { cadenceNudge, shelfLifeCap, keepableQty, type CadenceStats } from './prep-cadence'

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
  /** A job already in flight (see `pipelineOf`) — evidence, not a stock credit. */
  pipeline?: PipelineInfo | null
  /** The make history (see prep-cadence.ts) — may raise TMRW → CLOSE and cap a suggestion. */
  cadence?: CadenceStats | null
}

// ─── the pipeline: a job in flight is not a stock-out ──────────────────────
// Stock is credited at DONE only, so to the stock maths a curing item is still
// out. To the PLANNER it is in the pipeline: `/api/prep/items` attaches this
// for any live IN_PROGRESS log (staged or not), the suggestion row shows it
// instead of the stock-out triangle, "Add all critical" and the band's
// critical count leave it alone, and the schedule charges only the hands-on
// minutes still to come, from the time the next hands-on stage is due.
// `autoUrgency` itself is untouched — the step still reads the stock.

export interface PipelineInfo {
  /** the planned qty of the job in flight (the chef's requiredQty, else the suggestion) */
  qty: number
  /** when the whole job is expected to be done — ISO; null when the clock is unknown */
  readyAt: string | null
  /** the current stage's name (staged jobs), else null */
  stageName: string | null
  /** hands-on minutes still to come */
  remainingActiveMinutes: number
  /** unattended minutes still to come */
  remainingPassiveMinutes: number
  /** when the next hands-on work can begin — now for a hands-on stage, the rest's ready time otherwise */
  nextActiveAt: string | null
}

const RESTAURANT_TZ = 'America/Los_Angeles'

/** "07:30" today, "Thu 07:30" another day — the restaurant's clock. */
export function fmtPipelineReady(iso: string, nowMs: number = Date.now()): string {
  const d = new Date(iso)
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: RESTAURANT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: RESTAURANT_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
  if (day.format(d) === day.format(new Date(nowMs))) return clock
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: RESTAURANT_TZ, weekday: 'short' }).format(d)
  return `${wd} ${clock}`
}

export function pipelineOf(
  t: PlanFields & {
    activeMinutes?: number | null
    passiveMinutes?: number | null
    estimatedPrepTime?: number | null
    linkedRecipe?: { stages?: RecipeStage[] | null; baseYieldQty?: number; yieldUnit?: string } | null
    todayLog?: (StageLogShape & { requiredQty?: number | string | null; actualPrepQty?: number | null }) | null
  },
  nowMs: number,
): PipelineInfo | null {
  const log = t.todayLog
  if (!log || log.status !== 'IN_PROGRESS') return null
  const qty = draftQty(t) || (t.targetToday ?? t.parLevel)
  const stages = resolveStages(t.linkedRecipe)
  const cur = stages ? currentStage(stages, log) : null
  if (stages && cur) {
    const rem = remainingChain(stages, log, nowMs)!
    const resting = cur.stage.kind === 'PASSIVE'
    const readyAtMs = resting ? stageReadyAt(log, cur.stage) : null
    return {
      qty,
      readyAt: new Date(rem.readyAtMs).toISOString(),
      stageName: cur.stage.name,
      remainingActiveMinutes: rem.active,
      remainingPassiveMinutes: rem.passive,
      nextActiveAt: resting && readyAtMs != null ? new Date(readyAtMs).toISOString() : new Date(nowMs).toISOString(),
    }
  }
  // Unstaged: one hands-on job carrying active + passive from its start.
  const active = t.activeMinutes ?? t.estimatedPrepTime ?? 0
  const passive = t.passiveMinutes ?? 0
  const started = log.startedAt ? new Date(log.startedAt).getTime() : NaN
  const elapsed = Number.isFinite(started) ? Math.max(0, Math.floor((nowMs - started) / 60_000)) : 0
  const remainingActive = Math.max(0, active - elapsed)
  const remainingPassive = Math.max(0, active + passive - Math.max(elapsed, active))
  return {
    qty,
    readyAt: Number.isFinite(started) ? new Date(started + (active + passive) * 60_000).toISOString() : null,
    stageName: null,
    remainingActiveMinutes: remainingActive,
    remainingPassiveMinutes: remainingPassive,
    nextActiveAt: new Date(nowMs).toISOString(),
  }
}

/** Re-derive `pipeline` after an optimistic status / stage change. */
export function withPipeline<T extends Parameters<typeof pipelineOf>[0]>(t: T, nowMs: number = Date.now()): T & { pipeline: PipelineInfo | null } {
  return { ...t, pipeline: pipelineOf(t, nowMs) }
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

// Cadence sits AFTER autoUrgency and only ever raises TMRW → CLOSE (see
// cadenceNudge); a manual override is never nudged. `now` defaults to the wall
// clock so every call site keeps its one-argument shape — pass a fixed instant
// in tests. Without `cadence` on the item every one of these is byte-identical
// to the pre-cadence rule.
const nudged = (t: PlanFields, now: number) =>
  cadenceNudge(autoUrgency(t.onHand, t.parLevel, t.targetToday), t.cadence, new Date(now))

export const autoUrgencyOf = (t: PlanFields, now: number = Date.now()): PrepUrgency =>
  nudged(t, now).urgency

export const effectiveUrgency = (t: PlanFields, now: number = Date.now()): PrepUrgency =>
  normalizeUrgency(t.manualPriorityOverride) ?? autoUrgencyOf(t, now)

/** The cadence sentence when it raised the step (null when it did not, or an override stands). */
export const cadenceReason = (t: PlanFields, now: number = Date.now()): string | null =>
  normalizeUrgency(t.manualPriorityOverride) ? null : nudged(t, now).reason

export const autoPriority = (t: PlanFields, now: number = Date.now()): PrepPriority =>
  urgencyToPriority(autoUrgencyOf(t, now))

export const effectivePriority = (t: PlanFields, now: number = Date.now()): PrepPriority =>
  urgencyToPriority(effectiveUrgency(t, now))

/**
 * The par-gap suggestion, capped at what will keep (usage × shelf life) when
 * the cadence gives a usage estimate — never below one step. Identical to
 * `computeSuggestedQty` without cadence.
 */
export function cappedSuggestedQty(t: PlanFields): number {
  const raw = computeSuggestedQty(t.onHand, t.parLevel, t.targetToday)
  return shelfLifeCap(raw, t.shelfLifeDays, t.cadence?.usagePerDayEst, prepStep(t.unit))
}

export const isShelfCapped = (t: PlanFields): boolean =>
  cappedSuggestedQty(t) < computeSuggestedQty(t.onHand, t.parLevel, t.targetToday) - 1e-9

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
  const raw = cappedSuggestedQty(t)
  if (raw <= 0) return 0
  return Math.max(prepStep(t.unit), roundPrepQty(raw, t.unit))
}

const fmtQ = (q: number, u: string) => `${q % 1 === 0 ? q : +q.toFixed(2)} ${u}`

/** Read-only evidence: why the system put the item at its step. */
export function whyLabel(t: PlanFields, now: number = Date.now()): string {
  const oh = t.onHand ?? 0, par = t.parLevel ?? 0
  if (t.pipeline) {
    const when = t.pipeline.readyAt ? ` · ready ${fmtPipelineReady(t.pipeline.readyAt)}` : ''
    return `in the pipeline${t.pipeline.stageName ? ` (${t.pipeline.stageName.toLowerCase()})` : ''}${when}`
  }
  const override = normalizeUrgency(t.manualPriorityOverride)
  if (override) return `chef moved it to ${PLAN_URG_META[override].label.toLowerCase()}`
  const stock =
    par > 0 && oh <= 0 ? 'stock out'
    : t.targetToday != null && oh < t.targetToday ? `under today's target ${fmtQ(t.targetToday, t.unit)}`
    : par > 0 && oh < par * 0.5 ? `${fmtQ(+oh.toFixed(2), t.unit)} of ${fmtQ(par, t.unit)} par — won't last service`
    : oh < par ? `below par by ${fmtQ(+(par - oh).toFixed(2), t.unit)}`
    : t.shelfLifeDays ? `at par · ${t.shelfLifeDays}d shelf life` : 'at par'
  // Cadence evidence appends: the rhythm that raised the step, and a shelf-life cap.
  const extras: string[] = []
  const rhythm = cadenceReason(t, now)
  if (rhythm) extras.push(rhythm)
  if (isShelfCapped(t)) extras.push(`capped to ${t.shelfLifeDays}d shelf life`)
  return extras.length ? `${stock} · ${extras.join(' · ')}` : stock
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
  // Just made: the cadence's "last made" is now, so it is not due again until
  // one rhythm from now — otherwise a stale `dueByCadenceAt` would raise the
  // item straight back to Before close.
  const cadence = completing && item.cadence
    ? {
        ...item.cadence,
        lastMadeAt: new Date().toISOString(),
        dueByCadenceAt: item.cadence.medianIntervalDays
          ? new Date(Date.now() + item.cadence.medianIntervalDays * 86_400_000).toISOString()
          : null,
      }
    : item.cadence
  const next = { ...item, onHand, manualPriorityOverride, ...(cadence !== undefined ? { cadence } : {}) }
  return {
    ...next,
    priority: effectivePriority(next),
    suggestedQty: cappedSuggestedQty(next),
  }
}

// ─── staged prep — the live log's stage, optimistically ────────────────────
// Stage progress rides the item's ONE live log. These mirror the server rules
// in PUT /api/prep/logs/[id] so the row moves before the request lands.

export interface StageLogShape {
  status?: string
  startedAt?: string | null
  stageIndex?: number | null
  stageEnteredAt?: string | null
  stageHistory?: StageEvent[] | null
}

/** Just the stage columns — never `status`, so a spread cannot widen a typed log. */
export type StageFields = Partial<Pick<StageLogShape, 'stageIndex' | 'stageEnteredAt' | 'stageHistory'>>

/** The log fields a status change writes on a STAGED item (empty for an unstaged one). */
export function stageFieldsForStatus(
  item: { linkedRecipe?: { stages?: RecipeStage[] | null } | null; todayLog?: StageLogShape | null },
  newStatus: string,
  nowIso: string,
): StageFields {
  const stages = resolveStages(item.linkedRecipe)
  if (!stages) return {}
  const log = item.todayLog
  if (newStatus === 'NOT_STARTED') return { stageIndex: null, stageEnteredAt: null }
  if (newStatus === 'IN_PROGRESS' && log?.status !== 'IN_PROGRESS') {
    const index = log?.stageIndex ?? 0
    const stage = stages[index] ?? stages[0]
    return {
      stageIndex: stages[index] ? index : 0,
      stageEnteredAt: nowIso,
      stageHistory: appendStageEvent(log?.stageHistory, { index: stages[index] ? index : 0, key: stage.key, enteredAt: nowIso }),
    }
  }
  return {}
}

/**
 * Move the live log to `stageIndex` (Next / Back): status becomes IN_PROGRESS,
 * the stage clock restarts, and the move is appended to the history. Stock is
 * untouched — only DONE credits it.
 */
export function applyStageToItem<T extends { linkedRecipe?: { stages?: RecipeStage[] | null } | null; todayLog?: (StageLogShape & { id: string }) | null }>(
  item: T,
  stageIndex: number,
  nowIso: string,
): T {
  const stages = resolveStages(item.linkedRecipe)
  if (!stages || !stages[stageIndex] || !item.todayLog) return item
  const log = item.todayLog
  const todayLog = {
    ...log,
    status: 'IN_PROGRESS',
    startedAt: log.startedAt ?? nowIso,
    stageIndex,
    stageEnteredAt: nowIso,
    stageHistory: appendStageEvent(log.stageHistory, { index: stageIndex, key: stages[stageIndex].key, enteredAt: nowIso }),
  } as NonNullable<T['todayLog']>
  return { ...item, todayLog }
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
  const raw = cappedSuggestedQty(t)
  if (raw <= 0) return 0
  return Math.max(0.5, Math.ceil((raw / b) * 2) / 2)
}

/**
 * The qty for a LONG-LEAD job (one that must start today for a later
 * deadline): the most that will keep — usage × shelf life — since the effort
 * is per batch. Falls back to the ordinary suggestion when either is unknown.
 * Batch items round up to the half batch, like every other seed.
 */
export function longLeadQty(t: BatchFields): number {
  const keep = keepableQty(t.shelfLifeDays, t.cadence?.usagePerDayEst)
  if (keep == null) return defaultDraftQty(t)
  const b = batchYield(t)
  if (b) return batchesToQty(t, Math.max(0.5, Math.ceil((keep / b) * 2) / 2))
  return Math.max(prepStep(t.unit), roundPrepQty(keep, t.unit))
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
  /** doors-open the plan is for, minute-of-day (≥1440 ⇒ tomorrow) */
  doorsOpen: number
  /** kitchen close — the last service's end, minute-of-day (≥1440 ⇒ tomorrow) */
  close: number
  /** when prep hands become available — schedule cursors start here */
  shiftStart: number
  /** 0 while the day is still on, 1440 once it has rolled to tomorrow */
  roll: number
  /** the epoch instant `shiftStart` corresponds to — lets the schedule place a
   *  pipeline job's `nextActiveAt` on the minute axis. Absent ⇒ slot from shiftStart. */
  nowMs?: number
}

const DEFAULT_CLOSE = 22 * 60

/**
 * Derive the day's anchors from the RC's active services. Null when the RC has
 * no timed services (on-demand) — schedule/deadlines don't apply.
 *
 * The planning day ROLLS to tomorrow once the last service has ended: at that
 * point the chef is building tomorrow's list, and every anchor — doors, close,
 * an item's own service — moves together. Before that, the day is still on:
 * doors already open are behind us (a Critical item is late, not for tomorrow)
 * and close is tonight. The old rule rolled doors as soon as the last service
 * had STARTED but left close in place, so during evening planning "before
 * close" deadlined tonight while "critical" deadlined tomorrow morning, and the
 * schedule sequenced the close items first.
 *
 * Close is the last service's end, not a fixed 22:00: a kitchen whose only
 * service ends at 16:00 closes at 16:00. The 22:00 floor only applies when no
 * service carries an end time.
 */
export function planDayContext(
  services: Array<{ timeMinutes: number; endMinutes: number | null }>,
  nowMin: number,
  nowMs?: number,
): PlanDayContext | null {
  if (!services.length) return null
  const starts = services.map(s => s.timeMinutes).sort((a, b) => a - b)
  const ends = services.map(s => {
    if (s.endMinutes == null) return s.timeMinutes + 120
    // an end before its start crosses midnight
    return s.endMinutes < s.timeMinutes ? s.endMinutes + 1440 : s.endMinutes
  })
  const hasEnd = services.some(s => s.endMinutes != null)
  let close = hasEnd ? Math.max(...ends) : Math.max(DEFAULT_CLOSE, ...ends)
  const roll = nowMin >= close ? 1440 : 0
  close += roll
  const doorsOpen = roll
    ? starts[0] + roll
    : (starts.find(s => s >= nowMin) ?? starts[0])
  return { doorsOpen, close, shiftStart: nowMin, roll, ...(nowMs != null ? { nowMs } : {}) }
}

const MID_OFFSET = 120

/** The step's deadline, minute-of-day (≥1440 ⇒ tomorrow). Every item counts
 *  back from the RC's doors — there is no per-item service any more. */
export function urgencyDeadline(u: PrepUrgency, ctx: PlanDayContext): number {
  if (u === 'PASS') return ctx.doorsOpen
  if (u === 'MID') return ctx.doorsOpen + MID_OFFSET
  if (u === 'CLOSE') return ctx.close
  // "Tomorrow" is relative to the chef's now: once the day has rolled, tomorrow
  // IS the planned doors — don't double-roll past them.
  return ctx.doorsOpen >= 1440 ? ctx.doorsOpen : ctx.doorsOpen + 1440
}

export function fmtDeadline(m: number, fmtClock: (min: number) => string): string {
  const d = Math.floor(m / 1440)
  if (d <= 0) return fmtClock(m)
  if (d === 1) return `TMRW ${fmtClock(m % 1440)}`
  return `+${d}d ${fmtClock(m % 1440)}`
}

export interface PlanSlot {
  start: number
  end: number
  deadline: number
  fits: boolean
  over: number
}

/** What the ladder needs to time a row — the planner's row shape, minus identity. */
export interface TimedFields extends PlanFields {
  activeMinutes?: number | null
  passiveMinutes?: number | null
  estimatedPrepTime?: number | null
}

// ─── stations: who can make it ─────────────────────────────────────────────
// An item lists the stations that can make it. Empty = any station. The API
// emits `station` as a derived label (`stationLabel`) so display sites read one
// string; filters and crew maths read the list.

export const ANY_STATION = 'Any station'

export interface StationFields { stations: string[] }

/** Grouping key: the joined list; '' for an any-station item. */
export const stationKey = (t: StationFields): string => t.stations.join(' · ')

/** Display label: the joined list, or null for an any-station item. */
export const stationLabel = (t: StationFields): string | null => stationKey(t) || null

/** Does station `s` make this item? An empty list is every station. */
export const onStation = (t: StationFields, s: string): boolean =>
  t.stations.length === 0 || t.stations.includes(s)

/** The cooks who can take an item: everyone for any-station, else those whose home station is listed. */
export function crewFor<C extends { homeStation: string | null }>(cooks: C[], stations: string[]): C[] {
  if (stations.length === 0) return cooks
  return cooks.filter(c => c.homeStation != null && stations.includes(c.homeStation))
}

interface SchedulableItem extends TimedFields, StationFields {
  id: string
}

const activeMin = (t: TimedFields) => t.pipeline ? t.pipeline.remainingActiveMinutes : (t.activeMinutes ?? t.estimatedPrepTime ?? 0)
const passiveMin = (t: TimedFields) => t.pipeline ? t.pipeline.remainingPassiveMinutes : (t.passiveMinutes ?? 0)

/** The earliest minute a job in flight can take a cook again (shift start otherwise). */
function earliestStart(t: SchedulableItem, ctx: PlanDayContext): number {
  const at = t.pipeline?.nextActiveAt
  if (!at || ctx.nowMs == null) return ctx.shiftStart
  return Math.max(ctx.shiftStart, msToLadderMin(new Date(at).getTime(), { nowMs: ctx.nowMs, nowMin: ctx.shiftStart }))
}

/**
 * Sequence each station set's draft through the crew that can take it: each
 * item gets its own slot; passive time doesn't hold a cook. Deadline-first
 * order. A job already in flight is charged only its REMAINING hands-on
 * minutes, from the time its next hands-on stage is due — not from shift start.
 */
export function planSchedule<T extends SchedulableItem>(
  draft: T[],
  cooks: Array<{ homeStation: string | null }>,
  ctx: PlanDayContext,
  ord: (t: T) => number = () => 0,
): Map<string, PlanSlot> {
  const map = new Map<string, PlanSlot>()
  const keys = [...new Set(draft.map(stationKey))]
  for (const key of keys) {
    const rows = draft.filter(t => stationKey(t) === key)
    const crew = Math.max(1, crewFor(cooks, rows[0].stations).length)
    const cursors = Array<number>(crew).fill(ctx.shiftStart)
    rows
      .map(t => ({ t, dl: urgencyDeadline(effectiveUrgency(t), ctx) }))
      .sort((a, b) =>
        a.dl - b.dl ||
        PLAN_URG_ORDER_LOCAL.indexOf(effectiveUrgency(a.t)) - PLAN_URG_ORDER_LOCAL.indexOf(effectiveUrgency(b.t)) ||
        // within a deadline, what can start now goes before a job still resting
        // (every ordinary row ties here at shift start, so their order is unchanged)
        earliestStart(a.t, ctx) - earliestStart(b.t, ctx) ||
        ord(a.t) - ord(b.t))
      .forEach(({ t, dl }) => {
        let i = 0
        cursors.forEach((c, j) => { if (c < cursors[i]) i = j })
        const start = Math.max(cursors[i], earliestStart(t, ctx))
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

/** Load per station set against the crew-minutes available before doors open. */
export function stationLoad<T extends SchedulableItem>(
  draft: T[],
  cooks: Array<{ homeStation: string | null }>,
  ctx: PlanDayContext,
): StationLoad[] {
  const keys = [...new Set(draft.map(stationKey))]
  return keys
    .map(key => {
      const rows = draft.filter(t => stationKey(t) === key)
      const crew = Math.max(1, crewFor(cooks, rows[0].stations).length)
      const cap = Math.max(0, ctx.doorsOpen - ctx.shiftStart) * crew
      const forService = rows
        .filter(t => { const u = effectiveUrgency(t); return u === 'PASS' || u === 'MID' })
        .reduce((a, t) => a + activeMin(t), 0)
      const total = rows.reduce((a, t) => a + activeMin(t), 0)
      return { station: key || ANY_STATION, crew, cap, forService, total, n: rows.length, pct: cap ? (forService / cap) * 100 : 0 }
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

// ─── lead-time promotion (Layer C(1)) ──────────────────────────────────────
// An item whose FULL lead (Σ stages, or active + passive) exceeds the runway
// to its step deadline must start today, whatever its stock: a 3-day cure for
// Thursday is a today job. The item's own step deadline is the anchor — for a
// TMRW item that is tomorrow's doors — so one test covers both spec cases.
// A job already in flight is not promoted, and a step whose deadline has
// already passed is simply late (the ladder says so), not "start today for".

export function mustStartToday(t: TimedFields, ctx: PlanDayContext | null, nowMin: number): boolean {
  if (!ctx || t.pipeline) return false
  const lead = activeMin(t) + passiveMin(t)
  if (lead <= 0) return false
  const { deadline, startBy } = ladderTimes(t, ctx)
  return deadline != null && startBy != null && deadline > nowMin && startBy < nowMin
}

export const START_TODAY_KEY = 'START'

export function planGroups<T extends PlanFields & StationFields & { category: string }>(
  rows: T[],
  by: 'urgency' | 'station' | 'category',
  opts: {
    stations?: string[]
    crew?: Array<{ homeStation: string | null }>
    ord?: (t: T) => number
    /** urgency grouping only: lift the long-lead items into a "Start today for …" group above the steps */
    startToday?: { ctx: PlanDayContext | null; nowMin: number }
  } = {},
): Array<PlanGroup<T>> {
  const ord = opts.ord ?? (() => 0)
  const byUrg = (a: T, b: T) =>
    PLAN_URG_ORDER_LOCAL.indexOf(effectiveUrgency(a)) - PLAN_URG_ORDER_LOCAL.indexOf(effectiveUrgency(b)) || ord(a) - ord(b)
  if (by === 'station') {
    // Known single stations in the settings order, then multi-station sets
    // alphabetically, then the any-station group last.
    const known = opts.stations ?? []
    const present = [...new Set(rows.map(stationKey))]
    const keys = [
      ...known.filter(s => present.includes(s)),
      ...present.filter(s => s !== '' && !known.includes(s)).sort(),
      ...(present.includes('') ? [''] : []),
    ]
    return keys
      .map(key => {
        const grp = rows.filter(t => stationKey(t) === key)
        return {
          key: key || ANY_STATION,
          label: key || ANY_STATION,
          sub: opts.crew ? `${crewFor(opts.crew, grp[0].stations).length} on station` : undefined,
          rows: grp.sort(byUrg),
        }
      })
      .filter(g => g.rows.length)
  }
  if (by === 'category') {
    return [...new Set(rows.map(t => t.category))].sort()
      .map(c => ({ key: c, label: c, rows: rows.filter(t => t.category === c).sort(byUrg) }))
      .filter(g => g.rows.length)
  }
  const groups: Array<PlanGroup<T>> = []
  let pool = rows
  if (opts.startToday) {
    const { ctx, nowMin } = opts.startToday
    const must = rows
      .filter(t => mustStartToday(t as unknown as TimedFields, ctx, nowMin))
      .map(t => ({ t, dl: ladderTimes(t as unknown as TimedFields, ctx).deadline ?? Infinity }))
      .sort((a, b) => a.dl - b.dl || ord(a.t) - ord(b.t))
    if (must.length) {
      const first = must[0].dl
      const same = must.every(m => m.dl === first)
      groups.push({
        key: START_TODAY_KEY,
        label: 'Start today for …',
        sub: Number.isFinite(first) ? `lead time runs past the runway · by ${fmtDeadline(first, fmtClock)}${same ? '' : ' and later'}` : undefined,
        rows: must.map(m => m.t),
      })
      const lifted = new Set(must.map(m => m.t))
      pool = rows.filter(t => !lifted.has(t))
    }
  }
  return [
    ...groups,
    ...PLAN_URG_ORDER_LOCAL
      .map(u => ({
        key: u,
        label: PLAN_URG_META[u].label,
        sub: PLAN_URG_META[u].stock,
        urg: u,
        rows: pool.filter(t => effectiveUrgency(t) === u).sort((a, b) => ord(a) - ord(b)),
      }))
      .filter(g => g.rows.length),
  ]
}

// ─── the unified ladder (the To Do reads the plan the chef posted) ─────────
// One number per item, derived from its STEP: the step's deadline for this day,
// and start-by = deadline − hands-on − unattended. The planner and the run
// sheet both read these, so a Before-close smoke counts back from close, not
// from doors, and an evening-posted list is not "late" until the day is.

export interface LadderTimes { deadline: number | null; startBy: number | null }

export function ladderTimes(t: TimedFields, ctx: PlanDayContext | null): LadderTimes {
  if (!ctx) return { deadline: null, startBy: null }
  const deadline = urgencyDeadline(effectiveUrgency(t), ctx)
  return { deadline, startBy: deadline - activeMin(t) - passiveMin(t) }
}

export interface LadderItem extends SchedulableItem {
  name: string
  startByMinutes: number | null
  deadlineMinutes?: number | null
  todayLog?: { listOrder?: number | null; status?: string; stageIndex?: number | null; stageEnteredAt?: string | null } | null
  linkedRecipe?: { stages?: RecipeStage[] | null } | null
  /** Attached by `withLadderTimes` when the job is resting in a PASSIVE stage. */
  rest?: RestInfo | null
}

// ─── rest rows ─────────────────────────────────────────────────────────────
// A staged job whose CURRENT stage is unattended leaves Working On and sits in
// the ladder at the time its next hands-on stage is due. The clock is EPOCH
// MS (a proof entered last evening is ready this morning); `readyAtMin` is
// that instant on the run sheet's minute-of-day axis, so it sorts against
// ordinary start-by values and formats through fmtStartBy with a day offset.

export interface RestInfo {
  index: number
  stage: RecipeStage
  total: number
  /** the stage the cook advances to (null only for a malformed chain) */
  next: StageAt | null
  readyAtMs: number
  readyAtMin: number
  state: RestState
}

/** The run sheet's "now" — both bases, so epoch instants can sit on the minute axis. */
export interface LadderNow { nowMs: number; nowMin: number }

export const msToLadderMin = (ms: number, now: LadderNow): number =>
  Math.round(now.nowMin + (ms - now.nowMs) / 60_000)

export function restInfo(t: LadderItem, now: LadderNow): RestInfo | null {
  const log = t.todayLog
  if (!log || log.status !== 'IN_PROGRESS') return null
  const stages = resolveStages(t.linkedRecipe)
  if (!stages) return null
  const cur = currentStage(stages, log)
  if (!cur || cur.stage.kind !== 'PASSIVE') return null
  const readyAtMs = stageReadyAt(log, cur.stage)
  if (readyAtMs == null) return null
  return {
    index: cur.index,
    stage: cur.stage,
    total: stages.length,
    next: nextActiveStage(stages, cur.index),
    readyAtMs,
    readyAtMin: msToLadderMin(readyAtMs, now),
    state: restState(readyAtMs, now.nowMs),
  }
}

/**
 * Overwrite `startByMinutes` with the step-aware value (and attach the deadline)
 * so every row, strip and count on the run sheet reads ONE number. Without a
 * day context (on-demand RC) the API's own value is kept.
 *
 * With `now`, a resting job gets `rest` attached and its `startByMinutes`
 * becomes the rest's ready time, so `ladderOrder` places it without a second
 * rule. Callers that pass no `now` get the pre-stages behaviour exactly.
 */
export function withLadderTimes<T extends LadderItem>(
  items: T[],
  ctx: PlanDayContext | null,
  now?: LadderNow,
): Array<T & { deadlineMinutes: number | null; rest?: RestInfo | null }> {
  return items.map(t => {
    const { deadline, startBy } = ladderTimes(t, ctx)
    const base = { ...t, startByMinutes: ctx ? startBy : t.startByMinutes, deadlineMinutes: deadline }
    if (!now) return base
    const rest = restInfo(t, now)
    return rest ? { ...base, startByMinutes: rest.readyAtMin, rest } : { ...base, rest: null }
  })
}

/**
 * Late to start — the ONE test the ladder's section, the status band and the
 * crew strip share. A rest row is late only once it is `overdue` (past
 * readyAt + REST_GRACE_MINUTES); merely ready is not late.
 */
export function lateToStart(t: LadderItem, nowMin: number): boolean {
  if (t.rest) return t.rest.state === 'overdue'
  return t.startByMinutes != null && t.startByMinutes < nowMin
}

/** `lateToStart` gated on a day context — without one there is no "Late to start" section. */
export function isLateToStart(t: LadderItem, nowMin: number, ctx: PlanDayContext | null): boolean {
  return ctx != null && lateToStart(t, nowMin)
}

const orInf = (v: number | null | undefined) => (v == null ? Infinity : v)
const cmpNum = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1)

/** Deadline → start-by → the chef's listOrder → name. Nulls sink. */
export function ladderOrder(a: LadderItem, b: LadderItem): number {
  return cmpNum(orInf(a.deadlineMinutes), orInf(b.deadlineMinutes))
    || cmpNum(orInf(a.startByMinutes), orInf(b.startByMinutes))
    || cmpNum(draftListOrder(a), draftListOrder(b))
    || a.name.localeCompare(b.name)
}

export interface LadderGroup<T> extends PlanGroup<T> { late?: boolean }

/**
 * The run sheet's sections: rows already late to start (any step) lifted above
 * the NOW line, then the four steps in order, each captioned with its deadline
 * for the day. Rows inside a section follow `ladderOrder`.
 */
export function runSheetGroups<T extends LadderItem>(
  rows: T[],
  ctx: PlanDayContext | null,
  nowMin: number,
): Array<LadderGroup<T>> {
  const isLate = (t: T) => isLateToStart(t, nowMin, ctx)
  const late = rows.filter(isLate).sort(ladderOrder)
  const rest = rows.filter(t => !isLate(t))
  const groups: Array<LadderGroup<T>> = []
  if (late.length) groups.push({ key: 'LATE', label: 'Late to start', late: true, rows: late })
  for (const u of PLAN_URG_ORDER_LOCAL) {
    const g = rest.filter(t => effectiveUrgency(t) === u).sort(ladderOrder)
    if (!g.length) continue
    groups.push({
      key: u,
      label: PLAN_URG_META[u].label,
      sub: ctx ? `by ${fmtDeadline(urgencyDeadline(u, ctx), fmtClock)}` : undefined,
      urg: u,
      rows: g,
    })
  }
  return groups
}

// ── The live prep log ──────────────────────────────────────────────────────
// The To Do is a STANDING list, not a daily one. The kitchen posts the next
// day's list at the end of a shift, and unfinished jobs carry forward until
// they are done or taken off — nothing drops off because a date changed.
//
// So an item's LIVE log is: today's log if it has one, otherwise the newest
// earlier log still open. Exactly ONE live log per item is an invariant — a
// second open row would resurface the item on the To Do after the first was
// completed — so every path that needs "the item's log" resolves it this way
// instead of creating a fresh row per calendar day (see ensureLiveLogs in
// src/lib/prep-plan-server.ts).

/** Statuses that leave a prep still to do. */
export const OPEN_PREP_STATUSES = ['NOT_STARTED', 'IN_PROGRESS'] as const

export const isOpenPrepStatus = (status: string): boolean =>
  (OPEN_PREP_STATUSES as readonly string[]).includes(status)

export interface LiveLogRow {
  id: string
  prepItemId: string
  logDate: Date | string
  status: string
  postedAt: Date | string | null
}

/**
 * True when `log` is today's log, or an earlier one that was posted to the
 * kitchen and is still open.
 *
 * An earlier log must be POSTED to carry. Without that test the To Do also
 * inherits every stale artifact the tables hold — abandoned IN_PROGRESS timers
 * from months back, and unposted draft rows — because those are "open" too. The
 * cost is that a draft edit made last night and never posted starts from the
 * suggested qty again; the item itself still sits on the draft (`isOnList`).
 */
export function isLiveLog(log: LiveLogRow, dayStartMs: number): boolean {
  const d = new Date(log.logDate).getTime()
  if (d >= dayStartMs && d < dayStartMs + 86_400_000) return true
  return isOpenPrepStatus(log.status) && log.postedAt != null
}

/**
 * The live log per item, from that item's rows — ONLY the newest row can be
 * live, and it is live only if `isLiveLog` says so.
 *
 * Testing the newest row rather than "the newest row that happens to be open"
 * is what stops a completed job coming back: an item made this morning still
 * has last night's open posted row underneath it, and picking the newest OPEN
 * row would put the item back on tomorrow's list as if it were never made.
 */
export function pickLiveLogs<T extends LiveLogRow>(logs: T[], dayStartMs: number): Map<string, T> {
  const newest = new Map<string, T>()
  for (const log of logs) {
    const held = newest.get(log.prepItemId)
    if (!held || new Date(log.logDate).getTime() > new Date(held.logDate).getTime()) newest.set(log.prepItemId, log)
  }
  for (const [prepItemId, log] of newest) {
    if (!isLiveLog(log, dayStartMs)) newest.delete(prepItemId)
  }
  return newest
}

/**
 * The draft flag an Undo of "remove from the To Do" should write.
 *
 * `isOnList` is the Smart Prep DRAFT flag, not "is on the kitchen's To Do"
 * (that is `PrepLog.postedAt`). A removal clears both, so the Undo has to put
 * back whatever the draft flag actually was — asserting `true` puts items on a
 * draft they were never on.
 *
 * But the chef can act inside the toast's window, and the Undo's arguments are
 * frozen at removal time (the toast stores its onClick verbatim). Two facts make
 * this decidable rather than a race:
 *
 *   · the removal ALWAYS writes `false`, and
 *   · the only move available afterwards is re-adding to the draft (false ->
 *     true) — removing is already a no-op on an item that is off it.
 *
 * So a live `true` can only mean the chef re-added it, and the Undo must not
 * clobber that; a live `false` means untouched, and the Undo restores `prior`.
 *
 * `prior` undefined falls back to `true`, matching the default
 * `POST /api/prep/plan/remove-item` applies to an omitted `isOnList`.
 */
export function undoDraftFlag(live: boolean, prior: boolean | undefined): boolean {
  return live || (prior ?? true)
}
