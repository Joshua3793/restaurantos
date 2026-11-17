import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { caught, fail, notFound, readBody } from '@/lib/checklists/edit-server'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string } }

/**
 * POST { intoId } — folds this category into another on the same list (same
 * station and phase): its jobs move to the end of `intoId`, in order, and this
 * one comes off. History keeps its snapshots.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const user = await requireSession('MANAGER')
    const intoId = (await readBody(req)).intoId
    if (typeof intoId !== 'string' || intoId === params.id) return fail(400, 'Pick the category to merge into')

    const cats = await prisma.checklistCategory.findMany({
      where: { id: { in: [params.id, intoId] }, isActive: true, station: { isActive: true } },
      select: { id: true, stationId: true, phase: true, station: { select: { revenueCenterId: true } } },
    })
    const from = cats.find(c => c.id === params.id)
    const into = cats.find(c => c.id === intoId)
    if (!from || !into) return notFound()
    if (from.stationId !== into.stationId || from.phase !== into.phase) return fail(400, 'Both must be on the same list')
    await assertRcWritable(user, from.station.revenueCenterId)

    const [items, max] = await Promise.all([
      prisma.checklistItem.findMany({ where: { categoryId: from.id, isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } }),
      prisma.checklistItem.aggregate({ where: { categoryId: into.id }, _max: { sortOrder: true } }),
    ])
    const start = (max._max.sortOrder ?? -1) + 1
    await prisma.$transaction([
      ...items.map((it, i) => prisma.checklistItem.update({ where: { id: it.id }, data: { categoryId: into.id, sortOrder: start + i } })),
      prisma.checklistCategory.update({ where: { id: from.id }, data: { isActive: false } }),
    ])
    return NextResponse.json({ ok: true, moved: items.length })
  } catch (e) {
    return caught(e, 'POST /api/checklists/categories/[id]/merge')
  }
}
