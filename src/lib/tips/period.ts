/**
 * Tip period window maths.
 *
 * A period is a run of N consecutive local business days identified by a
 * 'YYYY-MM-DD' start date. All arithmetic happens on UTC-noon Date objects so
 * a daylight-saving transition can never shift a day index by one — the same
 * trick the EOD business-date code uses.
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

export function previousPeriodStart(startDate: string, count: number): string {
  return addDays(startDate, -count)
}

export function nextPeriodStart(startDate: string, count: number): string {
  return addDays(startDate, count)
}

/**
 * The start of the period containing `today`, anchored so period boundaries
 * always land on `startDow` (0 = Sunday) and repeat every `count` days from
 * the most recent such weekday.
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
