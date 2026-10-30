import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { caught, fail, readBody } from '@/lib/checklists/edit-server'

export const dynamic = 'force-dynamic'

const MIXED = "Can't reorder those together"

/**
 * POST { kind: 'category' | 'item', ids } — sortOrder becomes each id's index.
 * Every id must exist, be active and share one parent (the same station and
 * phase for categories, the same category for items). Stations don't reorder.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const b = await readBody(req)
    const kind = b.kind
    const ids = b.ids
    if ((kind !== 'category' && kind !== 'item') || !Array.isArray(ids) || ids.length === 0
      || !ids.every((x): x is string => typeof x === 'string' && x.length > 0)
      || new Set(ids).size !== ids.length) {
      return fail(400, MIXED)
    }

    let rcId: string
    if (kind === 'category') {
      const rows = await prisma.checklistCategory.findMany({
        where: { id: { in: ids }, isActive: true, station: { isActive: true } },
        select: { stationId: true, phase: true, station: { select: { revenueCenterId: true } } },
      })
      if (rows.length !== ids.length) return fail(400, MIXED)
      const first = rows[0]
      if (!rows.every(r => r.stationId === first.stationId && r.phase === first.phase)) return fail(400, MIXED)
      rcId = first.station.revenueCenterId
    } else {
      const rows = await prisma.checklistItem.findMany({
        where: { id: { in: ids }, isActive: true, category: { isActive: true, station: { isActive: true } } },
        select: { categoryId: true, category: { select: { station: { select: { revenueCenterId: true } } } } },
      })
      if (rows.length !== ids.length) return fail(400, MIXED)
      const first = rows[0]
      if (!rows.every(r => r.categoryId === first.categoryId)) return fail(400, MIXED)
      rcId = first.category.station.revenueCenterId
    }
    await assertRcWritable(user, rcId)

    if (kind === 'category') {
      await prisma.$transaction(ids.map((id, i) => prisma.checklistCategory.update({ where: { id }, data: { sortOrder: i } })))
    } else {
      await prisma.$transaction(ids.map((id, i) => prisma.checklistItem.update({ where: { id }, data: { sortOrder: i } })))
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    return caught(e, 'POST /api/checklists/reorder')
  }
}
