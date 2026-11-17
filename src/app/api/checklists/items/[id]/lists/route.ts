import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { caught, fail, notFound, readBody } from '@/lib/checklists/edit-server'
import { JOB_FIELDS, matchCategory, planListChange } from '@/lib/checklists/links'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string } }

/**
 * PUT { stationIds } — the lists this job sits on, for its phase. A newly ticked
 * station gets a copy in its category of the same name (made at the end when it
 * has none); an unticked one has its copy taken off. Every copy shares one
 * linkId, so on the day it is one job, ticked once. The job's own list stays.
 */
export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const user = await requireSession('MANAGER')
    const item = await prisma.checklistItem.findFirst({
      where: { id: params.id, isActive: true, category: { isActive: true, station: { isActive: true } } },
      select: {
        id: true, linkId: true, title: true, howTo: true, isBlocker: true, answer: true, unit: true,
        safeMin: true, safeMax: true, tempUnitId: true, days: true, dueBy: true,
        category: { select: { name: true, phase: true, stationId: true, station: { select: { revenueCenterId: true } } } },
      },
    })
    if (!item) return notFound()
    const rcId = item.category.station.revenueCenterId
    await assertRcWritable(user, rcId)

    const b = await readBody(req)
    const raw = Array.isArray(b.stationIds) ? b.stationIds : null
    if (!raw || !raw.every(s => typeof s === 'string')) return fail(400, 'Pick the lists')
    const targets = Array.from(new Set(raw as string[]))

    const stations = await prisma.checklistStation.findMany({
      where: { id: { in: targets }, revenueCenterId: rcId, isActive: true },
      select: { id: true },
    })
    if (stations.length !== targets.length) return fail(400, 'Pick lists from this kitchen')

    const phase = item.category.phase
    const linkId = item.linkId ?? randomUUID()
    const copies = item.linkId
      ? await prisma.checklistItem.findMany({
          where: { linkId: item.linkId, isActive: true, category: { isActive: true, phase, station: { isActive: true } } },
          select: { id: true, category: { select: { stationId: true } } },
        })
      : [{ id: item.id, category: { stationId: item.category.stationId } }]
    const plan = planListChange(
      copies.map(c => ({ id: c.id, stationId: c.category.stationId })),
      targets,
      item.category.stationId,
    )

    const job = Object.fromEntries(JOB_FIELDS.map(k => [k, item[k]])) as Record<(typeof JOB_FIELDS)[number], never>
    const kept = copies.length - plan.remove.length + plan.add.length

    await prisma.$transaction(async tx => {
      for (const stationId of plan.add) {
        const cats = await tx.checklistCategory.findMany({
          where: { stationId, phase, isActive: true },
          select: { id: true, name: true },
        })
        let cat = matchCategory(cats, item.category.name)
        if (!cat) {
          const max = await tx.checklistCategory.aggregate({ where: { stationId, phase }, _max: { sortOrder: true } })
          cat = await tx.checklistCategory.create({
            data: { stationId, phase, name: item.category.name, sortOrder: (max._max.sortOrder ?? -1) + 1 },
            select: { id: true, name: true },
          })
        }
        const max = await tx.checklistItem.aggregate({ where: { categoryId: cat.id }, _max: { sortOrder: true } })
        await tx.checklistItem.create({
          data: { ...job, categoryId: cat.id, linkId, sortOrder: (max._max.sortOrder ?? -1) + 1 },
        })
      }
      if (plan.remove.length) {
        await tx.checklistItem.updateMany({ where: { id: { in: plan.remove } }, data: { isActive: false } })
      }
      // Alone again: no link left to keep.
      await tx.checklistItem.updateMany({
        where: { linkId, isActive: true },
        data: { linkId: kept > 1 ? linkId : null },
      })
      if (kept > 1 && !item.linkId) {
        await tx.checklistItem.update({ where: { id: item.id }, data: { linkId } })
      }
    })
    return NextResponse.json({ ok: true, lists: kept })
  } catch (e) {
    return caught(e, 'PUT /api/checklists/items/[id]/lists')
  }
}
