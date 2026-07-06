/**
 * De-duplicates SalesEntry rows across the manual/Toast source split.
 *
 * The `@@unique([date, revenueCenterId, source, periodType])` constraint permits
 * BOTH a 'manual' and a 'toast' row for the same day / RC / period. Toast is the
 * source of truth and supersedes manual: the write-time guard blocks NEW manual
 * entries overlapping Toast days, but any pre-existing overlap still leaves two
 * rows in the table. Any report that SUMS SalesEntry must dedupe first or it
 * double-counts revenue (this has historically inflated a month's revenue ~2×).
 *
 * This keeps the 'toast' row whenever both a manual and a toast row share the
 * same (date, revenueCenterId, periodType) key.
 *
 * KNOWN LIMITATION: a *multi-day* manual entry (periodType !== 'day', spanning
 * an endDate) carries a single start `date`, so it does not share a key with the
 * per-day Toast rows inside its span and cannot be deduped here. Those rare rows
 * are surfaced as conflicts by the Toast sync for manual resolution.
 */
export function dedupeSalesEntries<T extends {
  date: Date
  revenueCenterId: string
  periodType: string
  source: string
}>(rows: T[]): T[] {
  const groups = new Map<string, T[]>()
  for (const r of rows) {
    const key = `${r.date.toISOString().slice(0, 10)}|${r.revenueCenterId}|${r.periodType}`
    const g = groups.get(key)
    if (g) g.push(r)
    else groups.set(key, [r])
  }
  const out: T[] = []
  for (const group of groups.values()) {
    const hasToast = group.some(r => r.source === 'toast')
    for (const r of group) if (!hasToast || r.source === 'toast') out.push(r)
  }
  return out
}
