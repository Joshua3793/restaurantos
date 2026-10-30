import 'server-only'
import type { User } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { appliesOn, shiftBusinessDate, type Phase } from './rules'
import { seedStationsIfEmpty } from './seed'
import { ensureRun, loadRunView, lastHandover, type RunView } from './runs'

export type StationCard = {
  id: string
  name: string
  color: string
  isShared: boolean
  crew: string[]
  jobCount: number
  picked: boolean
}

export type Handover = { note: string; byName: string | null; businessDate: string }

export type CookView = {
  phase: Phase
  businessDate: string
  stations: StationCard[]
  mine: RunView[]
  shared: RunView | null
  handover: Record<string, Handover>
}

/** The display name stored on lines and crew rows. */
export const whoOf = (user: User): { id: string; name: string } => ({
  id: user.id,
  name: user.name ?? user.email,
})

/**
 * Everything the cook screen needs for one revenue center and phase: the
 * station cards, the runs this cook has picked, the whole-kitchen run, and the
 * last closing notes. Shared by GET /api/checklists and POST .../pick.
 *
 * Throws AuthError(403) when the RC is outside the caller's access. That check
 * runs before seeding, so a cook cannot trigger a first-open seed elsewhere.
 */
export async function buildCookView(user: User, rcId: string, phase: Phase): Promise<CookView> {
  if (!(await isRcInScope(user, rcId))) {
    throw new AuthError(403, 'Revenue center is outside your access.')
  }
  await seedStationsIfEmpty(rcId)

  const businessDate = shiftBusinessDate(phase)
  const stations = await prisma.checklistStation.findMany({
    where: { revenueCenterId: rcId, isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, name: true, color: true, isShared: true },
  })
  const stationIds = stations.map(s => s.id)

  const runRows = await prisma.checklistRun.findMany({
    where: { stationId: { in: stationIds }, phase, businessDate },
    select: {
      id: true, stationId: true,
      crew: { orderBy: { joinedAt: 'asc' }, select: { userId: true, userName: true } },
      _count: { select: { lines: true } },
    },
  })
  const runByStation = new Map(runRows.map(r => [r.stationId, r]))

  const mineRows = runRows.filter(r => r.crew.some(c => c.userId === user.id))
  const mine = await Promise.all(mineRows.map(r => loadRunView(r.id)))

  // The whole-kitchen list shows for anyone who has picked a station.
  let shared: RunView | null = null
  const sharedStation = stations.find(s => s.isShared)
  if (mine.length > 0 && sharedStation) {
    const { id } = await ensureRun(sharedStation.id, phase, businessDate)
    shared = await loadRunView(id)
    runByStation.set(sharedStation.id, {
      id, stationId: sharedStation.id, crew: [], _count: { lines: shared.lines.length },
    })
  }

  // Stations with no run yet: count what would be copied in (one query for all).
  const needCount = stations.filter(s => !runByStation.has(s.id)).map(s => s.id)
  const applicable = new Map<string, number>()
  if (needCount.length > 0) {
    const items = await prisma.checklistItem.findMany({
      where: {
        isActive: true,
        category: { isActive: true, phase, stationId: { in: needCount } },
      },
      select: { days: true, category: { select: { stationId: true } } },
    })
    for (const i of items) {
      if (!appliesOn(i.days, businessDate)) continue
      const sid = i.category.stationId
      applicable.set(sid, (applicable.get(sid) ?? 0) + 1)
    }
  }

  const cards: StationCard[] = stations.map(s => {
    const run = runByStation.get(s.id)
    const crew = run ? run.crew.map(c => c.userName) : []
    return {
      id: s.id,
      name: s.name,
      color: s.color,
      isShared: s.isShared,
      crew,
      jobCount: run ? run._count.lines : applicable.get(s.id) ?? 0,
      picked: run ? run.crew.some(c => c.userId === user.id) : false,
    }
  })

  const handover: Record<string, Handover> = {}
  if (phase === 'OPEN') {
    await Promise.all(mine.map(async r => {
      const h = await lastHandover(r.stationId, businessDate)
      if (h) handover[r.stationId] = h
    }))
  }

  return { phase, businessDate, stations: cards, mine, shared, handover }
}
