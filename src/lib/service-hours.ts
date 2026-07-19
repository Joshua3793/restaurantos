// src/lib/service-hours.ts
// Pure helpers — no DB. Resolve the current / next service for a revenue center
// from its configured Service rows. Minute-of-day arithmetic throughout.
//
// This module is the single answer every surface renders. Before it existed the
// prep header and the run sheet each computed "the next service" their own way
// and disagreed on screen.

/** A configured service period. Callers pass ACTIVE services only. */
export interface RcService {
  id: string
  name: string
  timeMinutes: number        // start, minute-of-day (0..1439)
  endMinutes: number | null  // end, minute-of-day; < start ⇒ crosses midnight
}

export type ServiceStatus =
  | { kind: 'upcoming'; service: RcService; minsUntil: number; prepByMin: number | null }
  | { kind: 'underway'; service: RcService }
  | { kind: 'none' }

const byStart = (a: RcService, b: RcService) => a.timeMinutes - b.timeMinutes
const wrap = (min: number) => ((min % 1440) + 1440) % 1440

/** Earliest service starting strictly after `nowMin`. null once all have started. */
export function nextService(services: RcService[], nowMin: number): RcService | null {
  return [...services].sort(byStart).find(s => s.timeMinutes > nowMin) ?? null
}

/** Service in progress (start ≤ now < end). A service with unknown hours is never underway. */
export function currentService(services: RcService[], nowMin: number): RcService | null {
  for (const s of [...services].sort(byStart)) {
    if (s.endMinutes == null) continue
    const crossesMidnight = s.endMinutes < s.timeMinutes
    const inWindow = crossesMidnight
      ? nowMin >= s.timeMinutes || nowMin < s.endMinutes
      : nowMin >= s.timeMinutes && nowMin < s.endMinutes
    if (inWindow) return s
  }
  return null
}

/** Coarse prep deadline: the next service's start minus the RC's lead. */
export function prepDeadlineMinutes(
  services: RcService[], nowMin: number, leadMinutes: number | null,
): number | null {
  const next = nextService(services, nowMin)
  if (!next) return null
  return wrap(next.timeMinutes - (leadMinutes ?? 0))
}

/**
 * The single answer every header renders.
 *
 * Precedence: an UPCOMING service wins over one already underway — prep cares
 * about the next deadline, and this matches the run sheet's `nextSvc` semantics.
 * `underway` is the fallback for the last service of the day.
 */
export function serviceStatus(
  services: RcService[], nowMin: number, leadMinutes: number | null,
): ServiceStatus {
  const next = nextService(services, nowMin)
  if (next) {
    return {
      kind: 'upcoming',
      service: next,
      minsUntil: next.timeMinutes - nowMin,
      prepByMin: prepDeadlineMinutes(services, nowMin, leadMinutes),
    }
  }
  const current = currentService(services, nowMin)
  if (current) return { kind: 'underway', service: current }
  return { kind: 'none' }
}

/** "09:00–16:00", or just the start when the end is unknown. */
export function fmtServiceHours(s: RcService): string {
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  return s.endMinutes == null ? hhmm(s.timeMinutes) : `${hhmm(s.timeMinutes)}–${hhmm(s.endMinutes)}`
}

/** "2h 30m", "45m", "1d 2h". Clamps negatives to "0m". Takes MILLISECONDS. */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return '0m'
  const totalMin = Math.floor(ms / 60_000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
