/**
 * Tip period window maths.
 *
 * A period is a run of N consecutive local business days identified by a
 * 'YYYY-MM-DD' start date. All arithmetic stays inside `Date.UTC` /
 * `getUTC*` / `toISOString()` — none of which know about daylight saving —
 * so a DST transition can never shift a day index by one. Dates are pinned
 * to 12:00 UTC as a defensive convention (it keeps any future `new
 * Date(iso)` misuse from straddling a day boundary), not because the noon
 * anchor itself provides the DST safety.
 */

const DAY_MS = 86_400_000
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'YYYY-MM-DD' → a Date pinned to 12:00 UTC on that calendar day. */
export function toUtcNoon(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0))
}

/** A UTC-noon Date → 'YYYY-MM-DD'. */
export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Shift an ISO date by whole days. */
export function addDays(iso: string, n: number): string {
  return toIso(new Date(toUtcNoon(iso).getTime() + n * DAY_MS))
}

/** The `count` consecutive ISO dates that make up the period. */
export function periodDays(startDate: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(startDate, i))
}

/** Column labels for the day strip — "Sun 12", "Mon 13", … */
export function dayLabels(startDate: string, count: number): string[] {
  return periodDays(startDate, count).map(iso => {
    const d = toUtcNoon(iso)
    return `${DOW[d.getUTCDay()]} ${d.getUTCDate()}`
  })
}

/**
 * Index of `iso` within the window. Deliberately unclamped: callers use
 * `< 0 || >= count` to detect a punch dated outside the period.
 */
export function dayIndexOf(startDate: string, iso: string): number {
  return Math.round((toUtcNoon(iso).getTime() - toUtcNoon(startDate).getTime()) / DAY_MS)
}

/**
 * The number of days in a period's OWN stored window — derived from its
 * persisted `startDate`/`endDate`, never from the live, admin-editable
 * `TipSettings.periodDays`. `TipSettings.periodDays` only decides how long a
 * *new* period is when it is opened (`/api/tips/periods` POST); once a period
 * exists, its window is frozen in its own two columns.
 *
 * Rejects (throws) rather than tolerating a malformed or inverted window —
 * `endDate` missing/unparsable or before `startDate`. Silently coercing that
 * into a zero/negative-length window would cascade into an empty day strip
 * and, worse, into `resolveRoster`'s `dayIndex >= dayCount` bound check
 * dropping every punch for the period without any error surfacing. A corrupt
 * period should fail loudly (the route/build callers already have a
 * catch-all try/catch that turns this into a 500) rather than quietly pay out
 * a wrong, empty-looking period.
 */
export function periodDayCount(startDate: string, endDate: string): number {
  const count = dayIndexOf(startDate, endDate) + 1
  if (!Number.isFinite(count) || count < 1) {
    throw new Error(`TipPeriod has an invalid window: endDate ${endDate} is not on/after startDate ${startDate}`)
  }
  return count
}

export function previousPeriodStart(startDate: string, count: number): string {
  return addDays(startDate, -count)
}

export function nextPeriodStart(startDate: string, count: number): string {
  return addDays(startDate, count)
}

/**
 * The start of the period containing `today`, anchored so period boundaries
 * always land on `startDow` (0 = Sunday) and repeat every `count` days from
 * the most recent such weekday. Stays in UTC throughout (see module header);
 * the noon anchor is defensive, not what makes this DST-safe.
 *
 * `count` is expected to be a whole number of weeks (7, 14, 28, …): the
 * tiling below (`span = round(count / 7)`) is anchored in whole weeks from
 * the epoch, so a non-multiple-of-7 `count` silently collapses to `span = 1`
 * (the most recent `startDow`, ignoring `count`). Callers must validate
 * `count` before calling this — the settings API already does.
 */
export function defaultPeriodStart(today: string, startDow: number, count: number): string {
  const d = toUtcNoon(today)
  const back = (d.getUTCDay() - startDow + 7) % 7
  const weekStart = addDays(today, -back)
  // Anchor the repeating window on the ISO epoch so consecutive periods tile.
  const weeks = Math.round(toUtcNoon(weekStart).getTime() / DAY_MS / 7)
  const span = Math.max(1, Math.round(count / 7))
  const offset = ((weeks % span) + span) % span
  return addDays(weekStart, -offset * 7)
}

/** "Sun Jul 12 → Sat Jul 25 · 2026" */
export function periodLabel(startDate: string, count: number): string {
  const a = toUtcNoon(startDate)
  const b = toUtcNoon(addDays(startDate, count - 1))
  const fmt = (d: Date) => `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`
  return `${fmt(a)} → ${fmt(b)} · ${b.getUTCFullYear()}`
}
