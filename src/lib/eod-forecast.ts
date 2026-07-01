import { prisma } from '@/lib/prisma'

export interface NetSalesForecast {
  forecast: number | null   // null when too little history
  basis: number             // how many same-weekday dates averaged
}

// Naive baseline: average net sales of the last up-to-4 SAME-WEEKDAY business days
// strictly before `date`, for one revenue center. `date` is the EOD business day
// as 'YYYY-MM-DD' (restaurant-local). SalesEntry.date is stored at UTC midnight, so
// we bracket/compare using UTC and read the weekday in UTC to stay consistent.
export async function netSalesForecast(revenueCenterId: string, date: string): Promise<NetSalesForecast> {
  const target = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(target.getTime())) return { forecast: null, basis: 0 }
  const weekday = target.getUTCDay()

  // Pull recent daily entries for this RC before the target day, newest first.
  // 140 rows (~20 weeks) is plenty to find 4 matching weekdays even with gaps.
  const rows = await prisma.salesEntry.findMany({
    where: { revenueCenterId, periodType: 'day', date: { lt: target } },
    orderBy: { date: 'desc' },
    take: 140,
    select: { date: true, totalRevenue: true, source: true },
  })

  // Dedupe per calendar date (toast wins over manual), preserving newest-first order.
  const byDate = new Map<string, { revenue: number; source: string }>()
  for (const r of rows) {
    const key = r.date.toISOString().slice(0, 10)
    const existing = byDate.get(key)
    if (!existing) { byDate.set(key, { revenue: Number(r.totalRevenue), source: r.source }); continue }
    if (existing.source !== 'toast' && r.source === 'toast') byDate.set(key, { revenue: Number(r.totalRevenue), source: r.source })
  }

  // Same-weekday dates, newest first, take up to 4.
  const sameWeekday: number[] = []
  for (const [key, v] of byDate) {
    if (new Date(`${key}T00:00:00.000Z`).getUTCDay() === weekday) sameWeekday.push(v.revenue)
    if (sameWeekday.length >= 4) break
  }

  if (sameWeekday.length < 2) return { forecast: null, basis: sameWeekday.length }
  const avg = sameWeekday.reduce((s, n) => s + n, 0) / sameWeekday.length
  return { forecast: avg, basis: sameWeekday.length }
}
