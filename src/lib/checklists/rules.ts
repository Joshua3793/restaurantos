// Pure station-checklist rules: dates, weekday applicability, number parsing,
// progress. No Prisma and no React imports, so this is safe on the client.

export type Phase = 'OPEN' | 'CLOSE'

// Same zone as RESTAURANT_TZ in src/lib/eod-close.ts. Copied here (not imported)
// because eod-close.ts pulls in Prisma and this file must stay client-safe.
const TZ = 'America/Los_Angeles'

/** Pacific 'YYYY-MM-DD'. Mirrors businessDateLocal() in src/lib/eod-close.ts. */
export function pacificDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

function pacificHour(d: Date): number {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: 'numeric', hourCycle: 'h23',
  }).formatToParts(d).find(p => p.type === 'hour')?.value
  return Number(h)
}

/** OPEN counts on the Pacific date; CLOSE belongs to the shift that started up to 5h earlier. */
export function shiftBusinessDate(phase: Phase, now: Date = new Date()): string {
  return phase === 'OPEN'
    ? pacificDate(now)
    : pacificDate(new Date(now.getTime() - 5 * 3600_000))
}

/**
 * OPEN from 05:00 to 13:59 Pacific, CLOSE otherwise (14:00 onward, and before
 * 05:00 so a cook closing at 00:30 lands on Closing, matching the 5-hour close shift).
 */
export function defaultPhase(now: Date = new Date()): Phase {
  const h = pacificHour(now)
  return h >= 5 && h < 14 ? 'OPEN' : 'CLOSE'
}

export const DAY_BITS = { MON: 1, TUE: 2, WED: 4, THU: 8, FRI: 16, SAT: 32, SUN: 64 } as const
export const EVERY_DAY = 127

// Index = Date#getUTCDay() (0 = Sunday).
const BIT_BY_UTC_DAY = [
  DAY_BITS.SUN, DAY_BITS.MON, DAY_BITS.TUE, DAY_BITS.WED,
  DAY_BITS.THU, DAY_BITS.FRI, DAY_BITS.SAT,
]

/** Weekday bit of a 'YYYY-MM-DD' string. Read as UTC so the server timezone never matters. */
export function dayBitFor(businessDate: string): number {
  return BIT_BY_UTC_DAY[new Date(businessDate + 'T00:00:00Z').getUTCDay()]
}

export function appliesOn(days: number, businessDate: string): boolean {
  return (days & dayBitFor(businessDate)) !== 0
}

/** Typed reading -> number. Accepts a comma decimal; null when empty or not finite. */
export function parseReading(raw: string): number | null {
  const s = raw.trim().replace(',', '.')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function inRange(value: number, min: number | null, max: number | null): boolean {
  if (min != null && value < min) return false
  if (max != null && value > max) return false
  return true
}

export type LineLike = { status: 'TODO' | 'DONE' | 'FLAGGED'; isBlocker: boolean }

export function runProgress(lines: LineLike[]): {
  handled: number; total: number; done: number; flagged: number; blockersLeft: number
} {
  let done = 0, flagged = 0, blockersLeft = 0
  for (const l of lines) {
    if (l.status === 'DONE') done++
    else if (l.status === 'FLAGGED') flagged++
    else if (l.isBlocker) blockersLeft++
  }
  return { handled: done + flagged, total: lines.length, done, flagged, blockersLeft }
}

/** Sign-off needs at least one line and no untouched blockers (flagged counts as handled). */
export function canSignOff(lines: LineLike[]): boolean {
  return lines.length > 0 && runProgress(lines).blockersLeft === 0
}

/** A shared run is complete when every line is handled. */
export function sharedRunComplete(lines: LineLike[]): boolean {
  return lines.length > 0 && lines.every(l => l.status !== 'TODO')
}

const DAY_ORDER = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const

/** Short badge for which days an item applies: '' for every day. */
export function daysLabel(days: number): string {
  if (days === EVERY_DAY) return ''
  if (days === 31) return 'WEEKDAYS'
  if (days === 96) return 'WEEKENDS'
  const names = DAY_ORDER.filter(d => (days & DAY_BITS[d]) !== 0)
  if (names.length === 0) return ''
  if (names.length === 1) return `${names[0]} ONLY`
  return names.join(' · ')
}

/** Pacific 'HH:MM' (24h), the clock time stored on a TempReading. */
export function pacificHHMM(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return `${get('hour').padStart(2, '0')}:${get('minute').padStart(2, '0')}`
}

/** 'YYYY-MM-DD' minus n days, by calendar arithmetic in UTC (no timezone drift). */
export function minusDays(businessDate: string, n: number): string {
  const d = new Date(businessDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/**
 * A job's "due by" time from the editor: 'HH:MM' (24h) or null for none.
 * Accepts "8:45" and "08:45"; undefined means the text is not a time.
 */
export function parseDueBy(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return undefined
  const s = raw.trim()
  if (s === '') return null
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(s)
  if (!m || Number(m[1]) > 23) return undefined
  return `${m[1].padStart(2, '0')}:${m[2]}`
}

/** Minutes into the shift day, which starts at 05:00: a 00:30 close-down sorts after 23:00. */
export function shiftMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  const mins = h * 60 + m
  return mins < 5 * 60 ? mins + 24 * 60 : mins
}

/** True once the shift clock has passed the job's due time. */
export function isPastDue(dueBy: string | null, nowHHMM: string): boolean {
  return !!dueBy && shiftMinutes(nowHHMM) > shiftMinutes(dueBy)
}

/** "8:45" — the due time as the cook reads it. */
export function dueText(dueBy: string): string {
  return dueBy.replace(/^0(\d)/, '$1')
}
