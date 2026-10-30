import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { parseName } from '@/lib/checklists/item-input'
import type { CategoryTree } from '@/lib/checklists/edit-format'
import { caught, fail, notFound, readBody } from '@/lib/checklists/edit-server'

export const dynamic = 'force-dynamic'

/** POST { stationId, phase, name } — a new category at the end of that station's phase. */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const b = await readBody(req)
    const stationId = typeof b.stationId === 'string' ? b.stationId : ''
    if (!stationId) return notFound()
    const phase = b.phase
    if (phase !== 'OPEN' && phase !== 'CLOSE') return fail(400, 'Pick opening or closing')

    const station = await prisma.checklistStation.findFirst({
      where: { id: stationId, isActive: true },
      select: { id: true, revenueCenterId: true },
    })
    if (!station) return notFound()
    await assertRcWritable(user, station.revenueCenterId)

    const n = parseName(b.name, 'Give the category a name')
    if (!n.ok) return fail(400, n.error)

    const max = await prisma.checklistCategory.aggregate({ where: { stationId, phase }, _max: { sortOrder: true } })
    const c = await prisma.checklistCategory.create({
      data: { stationId, phase, name: n.name, sortOrder: (max._max.sortOrder ?? -1) + 1 },
      select: { id: true, name: true },
    })
    const category: CategoryTree = { ...c, items: [] }
    return NextResponse.json({ category }, { status: 201 })
  } catch (e) {
    return caught(e, 'POST /api/checklists/categories')
  }
}
