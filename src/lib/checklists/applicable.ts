// Server-only: how many jobs would land on each station's run for a phase and
// day — one query for all of them, the same rule as the cook screen's job
// count. Shared by GET /api/checklists/today and the Inbox system sync.
import 'server-only'
import { prisma } from '@/lib/prisma'
import { appliesOn, type Phase } from './rules'

/** stationId → applicable job count. Stations with none are absent (read as 0). */
export async function applicableJobCounts(
  stationIds: string[],
  phase: Phase,
  businessDate: string,
): Promise<Map<string, number>> {
  const applicable = new Map<string, number>()
  if (stationIds.length === 0) return applicable
  const items = await prisma.checklistItem.findMany({
    where: { isActive: true, category: { isActive: true, phase, stationId: { in: stationIds } } },
    select: { days: true, category: { select: { stationId: true } } },
  })
  for (const i of items) {
    if (!appliesOn(i.days, businessDate)) continue
    const sid = i.category.stationId
    applicable.set(sid, (applicable.get(sid) ?? 0) + 1)
  }
  return applicable
}
