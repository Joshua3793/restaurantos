import { prisma } from '@/lib/prisma'

// Sales dates are stored/queried at UTC-day granularity (a 'YYYY-MM-DD' string parses
// to UTC midnight), so the overlap window is day-floored at both ends.
function dayStart(d: Date): Date { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x }
function dayEnd(d: Date): Date { const x = new Date(d); x.setUTCHours(23, 59, 59, 999); return x }

/**
 * The days (YYYY-MM-DD) within [start, end] for this revenue center that a Toast entry
 * already covers. Reports sum every `SalesEntry` with NO source dedup, so a manual entry
 * whose range overlaps Toast-covered days double-counts that revenue — this is exactly
 * what inflated June to $421K (should have been $217,863). A manual write that hits any
 * of these days must be blocked. Returns [] when the range is clear.
 *
 * `excludeId` skips a row (the entry being edited) from the check.
 */
export async function toastCoveredDays(
  revenueCenterId: string,
  start: Date,
  end: Date | null,
  excludeId?: string,
): Promise<string[]> {
  const rows = await prisma.salesEntry.findMany({
    where: {
      source: 'toast',
      revenueCenterId,
      date: { gte: dayStart(start), lte: dayEnd(end ?? start) },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { date: true },
    orderBy: { date: 'asc' },
    take: 40,
  })
  return rows.map(r => r.date.toISOString().slice(0, 10))
}

/** Human-readable 409 message for a manual entry that collides with Toast coverage. */
export function toastOverlapMessage(days: string[]): string {
  const span = days.length === 1 ? days[0] : `${days[0]} → ${days[days.length - 1]} (${days.length} day${days.length === 1 ? '' : 's'})`
  return `Toast already has sales for ${span} in this revenue center. A manual entry over Toast-covered days would double-count revenue — edit the Toast day(s) instead, or choose a range Toast doesn't cover.`
}
