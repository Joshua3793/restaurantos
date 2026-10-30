// Pure display helpers for the checklist screens. No Prisma, no React.
import { minusDays, pacificDate, pacificHHMM } from './rules'

const PACIFIC = 'America/Los_Angeles'

/**
 * When a past reading was taken, in Pacific time: "22:31" today, "yesterday 22:31"
 * the day before, "Mon 27 Oct 22:31" earlier. Compares Pacific calendar dates, so
 * 22:31 seen at 00:30 the next morning reads "yesterday".
 */
export function lastTimeLabel(at: string, now: Date = new Date()): string {
  const d = new Date(at)
  const clock = pacificHHMM(d)
  const day = pacificDate(d)
  const today = pacificDate(now)
  if (day === today) return clock
  if (day === minusDays(today, 1)) return `yesterday ${clock}`
  const p = new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(d)
  const get = (t: string) => p.find(x => x.type === t)?.value ?? ''
  return `${get('weekday')} ${get('day')} ${get('month')} ${clock}`
}
