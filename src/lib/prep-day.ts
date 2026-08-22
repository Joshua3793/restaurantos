// The prep day — ONE convention, shared by every prep surface (client included).
//
// The day is the RESTAURANT'S calendar day (Pacific), and it is STORED as UTC
// midnight of that date: `PrepLog.logDate` / `PrepPost.listDate` / `PrepTaskLog.logDate`
// are date-only markers, not instants. Two rules follow from that:
//   • never derive a prep day from server or browser wall-clock;
//   • markers are always exactly 24h apart, so range math needs no DST handling.
//
// What this replaced: `new Date().setHours(0,0,0,0)`. On Vercel the server runs
// UTC, so the prep day rolled over at 5pm Pacific — a list posted during evening
// service landed on TOMORROW's list, and evening prep logs opened a second row
// for the next day instead of merging into the day the cook was working. A
// Pacific-local dev server had the mirror problem: it computed 07:00Z and matched
// none of the UTC-midnight rows production had written ("Nothing posted yet" on a
// day with a live post).
//
// Same restaurant-local day as `businessDateLocal` in src/lib/eod-close.ts and the
// Toast sync; that one returns the 'YYYY-MM-DD' string those subsystems store,
// this one also returns the Date marker the prep tables store.

const RESTAURANT_TZ = 'America/Los_Angeles'
const DAY_MS = 86_400_000
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** 'YYYY-MM-DD' for the restaurant's calendar day containing `d`. */
export function prepDayKey(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: RESTAURANT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

/**
 * 'YYYY-MM-DD' to SHOW for a stored date that may be either kind of value.
 *
 * Business-date columns in this app are day markers written at UTC midnight
 * (`PrepLog.logDate`, `SalesEntry.date`, `WastageLog.date`, `CountSession.sessionDate`,
 * a parsed `invoiceDate`), while a few carry real instants (`StockTransfer.createdAt`,
 * a quick count's `sessionDate`). Formatting a marker through a Pacific clock walks
 * it back a day — a prep logged on the 17th rendered as "Aug 16", and a count session
 * dated the 1st as "Jul 31".
 *
 * Exact UTC midnight is the marker's signature, so it identifies itself: read a
 * marker in UTC, and an instant through the restaurant's clock.
 */
export function displayDayKey(d: Date): string {
  return d.getTime() % DAY_MS === 0 ? d.toISOString().slice(0, 10) : prepDayKey(d)
}

/** The stored marker (UTC midnight) for the restaurant's day containing `d`. */
export function prepDayStart(d: Date = new Date()): Date {
  return new Date(`${prepDayKey(d)}T00:00:00.000Z`)
}

/**
 * Normalize whatever a caller supplied into the stored marker.
 *
 * A bare 'YYYY-MM-DD' is taken as the day itself — `new Date('2026-08-14')` is
 * UTC midnight, i.e. 5pm Pacific on the 13th, so re-deriving a Pacific day from
 * it would move a history query back one day. Anything else is an instant and
 * resolves through the restaurant's clock. Unparseable / missing → today.
 */
export function prepDayFrom(input: string | Date | null | undefined): Date {
  if (input == null || input === '') return prepDayStart()
  if (input instanceof Date) return prepDayStart(input)
  const s = String(input).trim()
  if (DATE_ONLY.test(s)) return new Date(`${s}T00:00:00.000Z`)
  const parsed = new Date(s)
  return Number.isNaN(parsed.getTime()) ? prepDayStart() : prepDayStart(parsed)
}

/** Half-open [start, next day) range for a Prisma `logDate` filter. */
export function prepDayRange(input?: string | Date | null): { gte: Date; lt: Date } {
  const gte = prepDayFrom(input)
  return { gte, lt: new Date(gte.getTime() + DAY_MS) }
}

/** Marker `days` prep-days before the day containing `from` (7 → a week ago). */
export function prepDaysAgo(days: number, from: Date = new Date()): Date {
  return new Date(prepDayStart(from).getTime() - days * DAY_MS)
}
