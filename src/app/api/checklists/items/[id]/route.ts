import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { parseItemInput } from '@/lib/checklists/item-input'
import { ITEM_SELECT, caught, fail, notFound, readBody, tempUnitAllowed, toEditItem } from '@/lib/checklists/edit-server'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string } }

/** An active job in an active category on an active station. */
async function activeItem(id: string) {
  return prisma.checklistItem.findFirst({
    where: { id, isActive: true, category: { isActive: true, station: { isActive: true } } },
    select: {
      id: true, categoryId: true, linkId: true,
      category: { select: { stationId: true, phase: true, station: { select: { revenueCenterId: true } } } },
    },
  })
}

/**
 * PATCH — replaces the job's fields (body: see parseItemInput). It may move to
 * another category of the same station, landing at the end. Lists already
 * started keep their snapshot; the change starts on the next shift.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const user = await requireSession('MANAGER')
    const item = await activeItem(params.id)
    if (!item) return notFound()
    const rcId = item.category.station.revenueCenterId
    await assertRcWritable(user, rcId)

    const parsed = parseItemInput(await readBody(req))
    if (!parsed.ok) return fail(400, parsed.error)
    const d = parsed.data

    let sortOrder: number | undefined
    // Moved to the other half of the day: no longer the same job as its copies on other lists.
    let unlink = false
    if (d.categoryId !== item.categoryId) {
      const target = await prisma.checklistCategory.findFirst({
        where: { id: d.categoryId, isActive: true },
        select: { id: true, stationId: true, phase: true },
      })
      if (!target || target.stationId !== item.category.stationId) {
        return fail(400, 'Move it to a category on the same station')
      }
      const max = await prisma.checklistItem.aggregate({ where: { categoryId: target.id }, _max: { sortOrder: true } })
      sortOrder = (max._max.sortOrder ?? -1) + 1
      unlink = !!item.linkId && target.phase !== item.category.phase
    }

    if (d.tempUnitId && !(await tempUnitAllowed(d.tempUnitId, rcId))) return fail(400, 'Pick a fridge or unit')

    // One job on several lists: every copy takes the same job fields; each keeps its own category and place.
    const { categoryId: _c, ...job } = d
    const [row] = await prisma.$transaction([
      prisma.checklistItem.update({
        where: { id: item.id },
        data: { ...d, ...(sortOrder !== undefined ? { sortOrder } : {}), ...(unlink ? { linkId: null } : {}) },
        select: ITEM_SELECT,
      }),
      ...(item.linkId && !unlink
        ? [prisma.checklistItem.updateMany({ where: { linkId: item.linkId, isActive: true, NOT: { id: item.id } }, data: job })]
        : []),
    ])
    return NextResponse.json({ item: toEditItem(row) })
  } catch (e) {
    return caught(e, 'PATCH /api/checklists/items/[id]')
  }
}

/** DELETE — takes the job off this list (soft). Copies on other lists stay. Past lists keep their snapshot of it. */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const user = await requireSession('MANAGER')
    const item = await activeItem(params.id)
    if (!item) return notFound()
    await assertRcWritable(user, item.category.station.revenueCenterId)

    await prisma.checklistItem.update({ where: { id: item.id }, data: { isActive: false } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return caught(e, 'DELETE /api/checklists/items/[id]')
  }
}
