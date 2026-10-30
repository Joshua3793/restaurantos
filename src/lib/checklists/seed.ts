import 'server-only'
import { prisma } from '@/lib/prisma'
import { buildSeed } from './starter'

/**
 * First open of an RC's stations: seeds the 8 starter stations (FOOD RCs only).
 * Inactive stations count, so a list emptied on purpose stays empty. Seed ids are
 * deterministic and skipDuplicates makes a simultaneous second first-open a no-op.
 */
export async function seedStationsIfEmpty(rcId: string): Promise<void> {
  const existing = await prisma.checklistStation.count({ where: { revenueCenterId: rcId } })
  if (existing > 0) return

  const rc = await prisma.revenueCenter.findUnique({ where: { id: rcId }, select: { type: true } })
  if (rc && (rc.type ?? 'FOOD') !== 'FOOD') return

  const where = { revenueCenterId: rcId, isActive: true }
  const select = { section: true, title: true, meta: true, isBlocker: true, sortOrder: true }
  const orderBy = { sortOrder: 'asc' as const }
  const [oldOpen, oldClose] = await Promise.all([
    prisma.openCheckItem.findMany({ where, select, orderBy }),
    prisma.eodCheckItem.findMany({ where, select, orderBy }),
  ])

  const { stations, categories, items } = buildSeed(rcId, oldOpen, oldClose)
  await prisma.$transaction([
    prisma.checklistStation.createMany({ data: stations, skipDuplicates: true }),
    prisma.checklistCategory.createMany({ data: categories, skipDuplicates: true }),
    prisma.checklistItem.createMany({ data: items, skipDuplicates: true }),
  ])
}
