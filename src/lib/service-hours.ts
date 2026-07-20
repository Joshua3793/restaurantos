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

/** The next service plus the derived countdown numbers every header renders. */
export interface NextServiceInfo {
  service: RcService
  minsUntil: number
  prepByMin: number | null
}

export type ServiceStatus =
  // Nothing running yet; `service` starts later today.
  | { kind: 'upcoming'; service: RcService; minsUntil: number; prepByMin: number | null }
  // `service` is being served right now. `next` rides along so a header can render
  // both ("Brunch service underway · Dinner in 5h") — it is null for the last
  // service of the day.
  | { kind: 'underway'; service: RcService; next: NextServiceInfo | null }
  // Services ARE configured, but none is underway and none remains today.
  // Consumers render NOTHING for this — it is not "on-demand".
  | { kind: 'closed' }
  // No services configured at all → genuinely on-demand.
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
 * Precedence: a service that is currently UNDERWAY always wins — a header must
 * never claim "Dinner in 5h" while Brunch is being served. The next upcoming
 * service rides along in `next` so prep can still count down to its deadline.
 *
 * `closed` (services configured, none left today) is deliberately distinct from
 * `none` (no services at all): only `none` means on-demand.
 */
export function serviceStatus(
  services: RcService[], nowMin: number, leadMinutes: number | null,
): ServiceStatus {
  if (services.length === 0) return { kind: 'none' }

  const current = currentService(services, nowMin)
  // A service crossing midnight is, after midnight, both underway AND "starting
  // later today" — so it would otherwise queue itself as its own `next`
  // ("Late service underway · Late in 21h"). Exclude the running one.
  const pool = current ? services.filter(s => s.id !== current.id) : services

  const next = nextService(pool, nowMin)
  const nextInfo: NextServiceInfo | null = next
    ? {
        service: next,
        minsUntil: next.timeMinutes - nowMin,
        prepByMin: prepDeadlineMinutes(pool, nowMin, leadMinutes),
      }
    : null

  if (current) return { kind: 'underway', service: current, next: nextInfo }
  if (nextInfo) return { kind: 'upcoming', ...nextInfo }
  return { kind: 'closed' }
}

/**
 * The next service to count down to, whatever the status kind — the upcoming
 * service itself, or the one riding along behind an underway service.
 * Null for `closed` / `none` / the last service of the day.
 */
export function upcomingInfo(status: ServiceStatus | null): NextServiceInfo | null {
  if (!status) return null
  if (status.kind === 'upcoming') {
    return { service: status.service, minsUntil: status.minsUntil, prepByMin: status.prepByMin }
  }
  if (status.kind === 'underway') return status.next
  return null
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
