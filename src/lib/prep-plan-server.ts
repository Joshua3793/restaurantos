import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { prepDayStart, prepDayRange } from '@/lib/prep-day'
import { OPEN_PREP_STATUSES, pickLiveLogs } from '@/lib/prep-plan'

// The day convention lives in src/lib/prep-day.ts (restaurant-local day, stored
// as UTC midnight) so the client can share it. Re-exported here because the plan
// routes already import their day helpers from this module.
export { prepDayStart, prepDayRange, prepDayFrom, prepDayKey } from '@/lib/prep-day'

// ── The live prep log ──────────────────────────────────────────────────────
// The To Do is a STANDING list. The kitchen posts the next day's list at the end
// of a shift and unfinished jobs carry forward until they are done or taken off —
// nothing drops off because a date changed. `isLiveLog` in src/lib/prep-plan.ts
// is the rule (and its tests); these are its Prisma shapes.

/**
 * Include fragment for an item's NEWEST log. Deliberately unfiltered: the rule
 * (`isLiveLog`) is applied to that newest row afterwards, because a filter would
 * happily reach past a completed row to an older open one and resurrect a job
 * that was already made. Callers must run `isLiveLog` on what comes back.
 */
export const NEWEST_LOG = { orderBy: { logDate: 'desc' }, take: 1 } as const

/** Fields `isLiveLog` needs — add to any explicit select of a candidate log. */
export const LIVE_LOG_SELECT = {
  id: true, prepItemId: true, logDate: true, status: true, postedAt: true,
} as const

/** `where` for logs that still hold a place on a kitchen's To Do (any day). */
export const postedOpenWhere: Prisma.PrepLogWhereInput = {
  postedAt: { not: null },
  status: { in: [...OPEN_PREP_STATUSES] },
}

/**
 * The live log id per item, creating today's log for items that have none.
 *
 * Every path that needs "this item's log" goes through here. Creating a fresh
 * row per calendar day instead would leave a carried, still-open row behind it,
 * and that row resurfaces the item on the To Do the moment the newer one is
 * completed — one live log per item is the invariant that prevents it.
 */
export async function ensureLiveLogs(
  prepItemIds: string[],
  revenueCenterId: string,
): Promise<Map<string, string>> {
  const byItem = new Map<string, string>()
  if (prepItemIds.length === 0) return byItem

  const day = prepDayRange()
  // Newest row per item, then the live test — see NEWEST_LOG on why the query
  // must not pre-filter by status or date. Done as a DB-side max + an equality
  // lookup on the (prepItemId, logDate) unique index: Prisma's `distinct` is
  // applied in memory, so it would drag every historical row of every item
  // across the wire on each post.
  const maxes = await prisma.prepLog.groupBy({
    by: ['prepItemId'],
    where: { prepItemId: { in: prepItemIds } },
    _max: { logDate: true },
  })
  const pairs = maxes
    .filter(m => m._max.logDate != null)
    .map(m => ({ prepItemId: m.prepItemId, logDate: m._max.logDate as Date }))
  if (pairs.length > 0) {
    const newest = await prisma.prepLog.findMany({ where: { OR: pairs }, select: LIVE_LOG_SELECT })
    for (const [prepItemId, log] of pickLiveLogs(newest, day.gte.getTime())) {
      byItem.set(prepItemId, log.id)
    }
  }

  const missing = prepItemIds.filter(id => !byItem.has(id))
  if (missing.length > 0) {
    await prisma.prepLog.createMany({
      data: missing.map(prepItemId => ({
        prepItemId, revenueCenterId, logDate: day.gte, status: 'NOT_STARTED',
      })),
      // A row can already exist for today with a resolved status (done earlier,
      // then re-added) — skipDuplicates keeps it rather than failing the batch.
      skipDuplicates: true,
    })
    const created = await prisma.prepLog.findMany({
      where: { prepItemId: { in: missing }, logDate: day },
      select: { id: true, prepItemId: true },
    })
    for (const l of created) byItem.set(l.prepItemId, l.id)
  }
  return byItem
}

/**
 * The RC's live posted list — the most recent post up to today, NOT strictly
 * today's. A list posted last night after service is still the list the kitchen
 * is working from this morning.
 */
export async function livePost(revenueCenterId: string) {
  return prisma.prepPost.findFirst({
    where: { revenueCenterId, listDate: { lte: prepDayStart() } },
    orderBy: { listDate: 'desc' },
  })
}

/**
 * Ids of the live post for one RC, or for every RC when `rcId` is null.
 *
 * The null fan-out is the Shared-item rule: an item with no RC of its own sits
 * on every center's plan, so anything that describes it (dirty flag, header
 * counters) has to move on every center's header at once.
 */
export async function livePostIds(rcId: string | null): Promise<string[]> {
  if (rcId) {
    const post = await livePost(rcId)
    return post ? [post.id] : []
  }
  const rows = await prisma.prepPost.findMany({
    where: { listDate: { lte: prepDayStart() } },
    orderBy: [{ revenueCenterId: 'asc' }, { listDate: 'desc' }],
    select: { id: true, revenueCenterId: true },
  })
  const first = new Map<string, string>()
  for (const r of rows) if (!first.has(r.revenueCenterId)) first.set(r.revenueCenterId, r.id)
  return [...first.values()]
}

/**
 * A draft edit after posting means the kitchen is looking at a stale list —
 * flag the live post so both surfaces can say "CHEF HAS UNPOSTED CHANGES".
 * rcId null (a Shared item) can sit on any RC's plan → flag them all.
 */
export async function markPlanDirty(rcId: string | null): Promise<void> {
  const ids = await livePostIds(rcId)
  if (ids.length === 0) return
  await prisma.prepPost.updateMany({ where: { id: { in: ids } }, data: { dirty: true } })
}
