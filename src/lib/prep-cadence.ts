// Cadence-aware suggestions (Layer A) — pure, vitest-covered.
//
// Smart Prep reads the MAKE HISTORY, not only on-hand vs par: "usually every
// 3 days, last made 4 days ago" is evidence the stock maths cannot see. This
// layer never touches `autoUrgency`; `cadenceNudge` is applied AFTER it and
// only ever raises TMRW → CLOSE. `shelfLifeCap` keeps a suggestion inside what
// will keep. Days of cover (Layer B) waits for live sales.
//
// Design: docs/superpowers/specs/2026-09-06-staged-prep-and-cadence-suggestions-design.md §3.1
import type { PrepUrgency } from './prep-utils'

export interface CadenceStats {
  /** completed logs (DONE / PARTIAL with a yield) in the window */
  makes: number
  medianIntervalDays: number | null
  medianQty: number | null
  lastMadeAt: string | null
  /** lastMadeAt + medianInterval — when the kitchen would normally make it again */
  dueByCadenceAt: string | null
  /** medianQty / medianIntervalDays — a usage proxy until Layer B */
  usagePerDayEst: number | null
}

/** The window the API scans, in days. */
export const CADENCE_WINDOW_DAYS = 60
/** Fewer makes than this and there is no cadence to speak of — stats stay null. */
export const CADENCE_MIN_MAKES = 3

const DAY_MS = 86_400_000

const EMPTY: CadenceStats = {
  makes: 0, medianIntervalDays: null, medianQty: null, lastMadeAt: null, dueByCadenceAt: null, usagePerDayEst: null,
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Stats over an item's completed logs. `logs` is whatever the caller scanned
 * (the API passes the last CADENCE_WINDOW_DAYS days); rows with no yield are
 * ignored. Below CADENCE_MIN_MAKES the medians are null and nothing downstream
 * changes.
 */
export function cadenceStats(
  logs: Array<{ logDate: string | Date; actualPrepQty: number | string | null }>,
  _now: Date,
): CadenceStats {
  const rows = logs
    .map(l => ({ ms: new Date(l.logDate).getTime(), qty: Number(l.actualPrepQty) }))
    .filter(r => Number.isFinite(r.ms) && Number.isFinite(r.qty) && r.qty > 0)
    .sort((a, b) => a.ms - b.ms)
  if (rows.length === 0) return EMPTY
  const lastMs = rows[rows.length - 1].ms
  const lastMadeAt = new Date(lastMs).toISOString()
  if (rows.length < CADENCE_MIN_MAKES) return { ...EMPTY, makes: rows.length, lastMadeAt }
  const intervals: number[] = []
  for (let i = 1; i < rows.length; i++) intervals.push((rows[i].ms - rows[i - 1].ms) / DAY_MS)
  const medianIntervalDays = median(intervals)
  const medianQty = median(rows.map(r => r.qty))
  const usable = medianIntervalDays != null && medianIntervalDays > 0
  return {
    makes: rows.length,
    medianIntervalDays: medianIntervalDays == null ? null : round2(medianIntervalDays),
    medianQty: medianQty == null ? null : round2(medianQty),
    lastMadeAt,
    dueByCadenceAt: usable ? new Date(lastMs + medianIntervalDays * DAY_MS).toISOString() : null,
    usagePerDayEst: usable && medianQty != null ? round2(medianQty / medianIntervalDays) : null,
  }
}

const fmtDays = (d: number) => `${d % 1 === 0 ? d : +d.toFixed(1)}d`

/**
 * The one thing cadence may do to the step: raise TMRW → CLOSE when the item is
 * due by its own rhythm. Never touches PASS / MID / CLOSE, never lowers, and the
 * caller applies a manual override BEFORE asking (an override is never nudged).
 */
export function cadenceNudge(
  auto: PrepUrgency,
  stats: CadenceStats | null | undefined,
  now: Date,
): { urgency: PrepUrgency; reason: string | null } {
  if (auto !== 'TMRW' || !stats?.dueByCadenceAt || stats.medianIntervalDays == null || !stats.lastMadeAt) {
    return { urgency: auto, reason: null }
  }
  const due = Date.parse(stats.dueByCadenceAt)
  if (!Number.isFinite(due) || due > now.getTime()) return { urgency: auto, reason: null }
  const ago = Math.floor((now.getTime() - Date.parse(stats.lastMadeAt)) / DAY_MS)
  return { urgency: 'CLOSE', reason: `usually every ${fmtDays(stats.medianIntervalDays)} · last made ${ago}d ago` }
}

/**
 * Cap a suggested qty at what will keep: usagePerDay × shelfLifeDays. No-op
 * unless BOTH are known. `minQty` (one prep step) is the floor so a cap never
 * suggests nothing.
 */
export function shelfLifeCap(
  suggested: number,
  shelfLifeDays: number | null | undefined,
  usagePerDay: number | null | undefined,
  minQty: number = 0,
): number {
  if (!(suggested > 0)) return suggested
  if (!shelfLifeDays || !(shelfLifeDays > 0) || !usagePerDay || !(usagePerDay > 0)) return suggested
  const cap = usagePerDay * shelfLifeDays
  return Math.max(minQty, Math.min(suggested, cap))
}

/** The most that will keep — for a long-lead job made in one batch. Null when unknown. */
export function keepableQty(shelfLifeDays: number | null | undefined, usagePerDay: number | null | undefined): number | null {
  if (!shelfLifeDays || !(shelfLifeDays > 0) || !usagePerDay || !(usagePerDay > 0)) return null
  return usagePerDay * shelfLifeDays
}
