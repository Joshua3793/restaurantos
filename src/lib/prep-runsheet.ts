// Pure time + batch-scaling math for the prep run sheet.
export type RunItemTimes = {
  activeMinutesOverride: number | null
  passiveMinutesOverride: number | null
  passiveNoteOverride: string | null
  linkedRecipe: { activeMinutes: number | null; passiveMinutes: number | null; passiveNote: string | null } | null
}

export function resolveActive(i: RunItemTimes): number | null {
  return i.activeMinutesOverride ?? i.linkedRecipe?.activeMinutes ?? null
}
export function resolvePassive(i: RunItemTimes): number | null {
  return i.passiveMinutesOverride ?? i.linkedRecipe?.passiveMinutes ?? null
}
export function resolvePassiveNote(i: RunItemTimes): string | null {
  return i.passiveNoteOverride ?? i.linkedRecipe?.passiveNote ?? null
}

export function startByMinutes(serviceTimeMinutes: number | null, activeMin: number | null, passiveMin: number | null): number | null {
  if (serviceTimeMinutes == null) return null
  return serviceTimeMinutes - (activeMin ?? 0) - (passiveMin ?? 0)
}

export type RunState = 'blocked' | 'overdue' | 'soon' | 'later'
export function runState(a: { startBy: number | null; blockedReason: string | null }, nowMin: number): RunState {
  if (a.blockedReason) return 'blocked'
  if (a.startBy == null) return 'later'
  if (a.startBy < nowMin) return 'overdue'
  if (a.startBy - nowMin <= 60) return 'soon'
  return 'later'
}

export const minutesBetween = (fromMs: number, toMs: number): number => Math.max(0, Math.floor((toMs - fromMs) / 60000))

/**
 * Wall-clock label for a minute-of-day.
 *
 * Wraps ANY value into 0..1439. `startByMinutes` is legitimately out of range —
 * a 48h brisket counted back from a 09:00 service starts two days earlier, i.e.
 * at minute −2340 — and the naive formatter rendered that as the nonsense string
 * "-39:00". Wrapping keeps the clock face honest; `dayOffset` carries the
 * which-day part, so callers showing a start-by must render both.
 */
export const fmtClock = (min: number): string => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Whole days a minute-of-day sits outside today. −1 = yesterday, +1 = tomorrow. */
export const dayOffset = (min: number): number => Math.floor(min / 1440)

/**
 * Start-by label including the day when it isn't today, e.g. "18:00 −2d".
 * Prep that takes longer than the runway to service genuinely had to start on an
 * earlier day; hiding that reads as "start at 18:00 tonight", which is backwards.
 */
export function fmtStartBy(min: number): string {
  const d = dayOffset(min)
  return d === 0 ? fmtClock(min) : `${fmtClock(min)} ${d < 0 ? '−' : '+'}${Math.abs(d)}d`
}

/**
 * "45m", "1h20", "2h". Takes MINUTES.
 *
 * Deliberately NOT named `fmtDuration`: `service-hours.ts` exports a
 * `fmtDuration(ms)` that takes MILLISECONDS, and both are live in the same
 * render tree (`/prep` imports the ms one, the run-sheet components import this
 * one). Both are `(n: number) => string`, so a same-name collision is invisible
 * to TypeScript — moving one line between parent and child would silently turn
 * "5h" into "0m". The names must stay distinct.
 */
export function fmtMins(min: number): string {
  min = Math.max(0, Math.round(min))
  const h = Math.floor(min / 60), r = min % 60
  return h ? (r ? `${h}h${String(r).padStart(2, '0')}` : `${h}h`) : `${min}m`
}

export const stepFor = (unit: string): number =>
  unit === 'kg' || unit === 'L' ? 0.5 : unit === 'ea' || unit === 'loaves' ? 5 : 50

export function scaleRound(v: number, unit: string): number {
  if (unit === 'kg' || unit === 'L') return v >= 10 ? Math.round(v * 2) / 2 : Math.round(v * 100) / 100
  if (unit === 'ea' || unit === 'loaves') return Math.round(v)
  return v >= 100 ? Math.round(v / 5) * 5 : Math.round(v)
}

export function scaleQtyLabel(qty: number, scale: number, unit: string): string {
  const v = scaleRound(qty * scale, unit)
  const s = (unit === 'kg' || unit === 'L')
    ? (v % 1 === 0 ? String(v) : v.toFixed(v < 10 ? 2 : 1).replace(/0$/, ''))
    : String(v)
  return `${s} ${unit}`
}

/**
 * Quantity for a run-sheet row: kg/L show one decimal only when fractional,
 * every other unit rounds to a whole number.
 *
 * Distinct from `formatQtyUnit` in prep-utils.ts, which up-converts g→kg — a
 * run-sheet row must show the qty in the unit the cook will actually measure.
 * This lived as seven byte-identical local copies across the runsheet
 * components before it was hoisted here.
 */
/**
 * Next/previous 0.25 step for a batch scale factor, clamped to [min, max].
 *
 * Two things this has to survive:
 *
 *  · A genuinely off-grid factor. Callers derive it (makeQty / baseInUnit), so
 *    1.13 is ordinary. `+` must land on the NEIGHBOURING quarter (1.25), not
 *    add 0.25 to an off-grid value and stay off-grid forever. Hence floor/ceil
 *    onto the grid rather than round-then-step, which would skip to 1.5.
 *
 *  · Float noise from that same derivation. multiply-then-divide by baseInUnit
 *    does not invert exactly in IEEE-754: a factor of exactly 0.75 comes back as
 *    0.7500000000000001 for ~40% of real recipe yields. Un-snapped, floor/ceil
 *    reads that as already past the grid point and returns the SAME step — the
 *    button goes dead while still looking enabled. Snap first, then step.
 */
export function stepFactor(factor: number, dir: 1 | -1, min: number, max: number): number {
  const raw = factor * 4
  const nearest = Math.round(raw)
  const q = Math.abs(raw - nearest) < 1e-6 ? nearest : raw
  const next = dir === 1 ? Math.floor(q + 1) : Math.ceil(q - 1)
  return Math.min(max, Math.max(min, next / 4))
}

export function fmtQty(q: number, u: string): string {
  const v = (u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)
  return `${v} ${u}`
}
