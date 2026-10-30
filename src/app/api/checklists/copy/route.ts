import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { requireSession } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { copyName } from '@/lib/checklists/edit-format'
import { caught, fail, notFound, readBody } from '@/lib/checklists/edit-server'

export const dynamic = 'force-dynamic'

/**
 * POST { fromStationId, toStationId, phase } — appends copies of the source
 * station's active categories and jobs for that phase after the target's own.
 * Same kitchen only. The shared list can be copied from, never into.
 * A category name the target already has gets " (copy)".
 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const b = await readBody(req)
    const fromId = typeof b.fromStationId === 'string' ? b.fromStationId : ''
    const toId = typeof b.toStationId === 'string' ? b.toStationId : ''
    const phase = b.phase
    if (phase !== 'OPEN' && phase !== 'CLOSE') return fail(400, 'Pick opening or closing')
    if (!fromId || !toId) return notFound()
    if (fromId === toId) return fail(400, 'Pick another station to copy from')

    const stations = await prisma.checklistStation.findMany({
      where: { id: { in: [fromId, toId] }, isActive: true },
      select: { id: true, revenueCenterId: true, isShared: true },
    })
    const from = stations.find(s => s.id === fromId)
    const to = stations.find(s => s.id === toId)
    if (!from || !to) return notFound()
    if (from.revenueCenterId !== to.revenueCenterId) return fail(400, 'Both stations must be in the same kitchen')
    if (to.isShared) return fail(400, "Can't copy into the whole-kitchen list")
    await assertRcWritable(user, to.revenueCenterId)

    const [source, existing] = await Promise.all([
      prisma.checklistCategory.findMany({
        where: { stationId: from.id, phase, isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: {
          name: true,
          items: {
            where: { isActive: true },
            orderBy: { sortOrder: 'asc' },
            select: {
              title: true, howTo: true, isBlocker: true, answer: true, unit: true,
              safeMin: true, safeMax: true, tempUnitId: true, days: true,
            },
          },
        },
      }),
      prisma.checklistCategory.findMany({
        where: { stationId: to.id, phase },
        select: { name: true, sortOrder: true, isActive: true },
      }),
    ])

    const taken = existing.filter(c => c.isActive).map(c => c.name)
    let next = existing.reduce((m, c) => Math.max(m, c.sortOrder), -1) + 1
    const categories: Prisma.ChecklistCategoryCreateManyInput[] = []
    const items: Prisma.ChecklistItemCreateManyInput[] = []
    for (const c of source) {
      const id = randomUUID()
      categories.push({ id, stationId: to.id, phase, name: copyName(c.name, taken), sortOrder: next++ })
      c.items.forEach((it, i) => items.push({ ...it, id: randomUUID(), categoryId: id, sortOrder: i }))
    }

    if (categories.length > 0) {
      await prisma.$transaction([
        prisma.checklistCategory.createMany({ data: categories }),
        prisma.checklistItem.createMany({ data: items }),
      ])
    }
    return NextResponse.json({ categories: categories.length, items: items.length })
  } catch (e) {
    return caught(e, 'POST /api/checklists/copy')
  }
}
