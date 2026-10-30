import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { parseItemInput } from '@/lib/checklists/item-input'
import { ITEM_SELECT, caught, fail, notFound, readBody, tempUnitAllowed, toEditItem } from '@/lib/checklists/edit-server'

export const dynamic = 'force-dynamic'

/** POST — a new job at the end of its category. Body: see parseItemInput. */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const parsed = parseItemInput(await readBody(req))
    if (!parsed.ok) return fail(400, parsed.error)
    const d = parsed.data

    const cat = await prisma.checklistCategory.findFirst({
      where: { id: d.categoryId, isActive: true, station: { isActive: true } },
      select: { id: true, station: { select: { revenueCenterId: true } } },
    })
    if (!cat) return notFound()
    const rcId = cat.station.revenueCenterId
    await assertRcWritable(user, rcId)

    if (d.tempUnitId && !(await tempUnitAllowed(d.tempUnitId, rcId))) return fail(400, 'Pick a fridge or unit')

    const max = await prisma.checklistItem.aggregate({ where: { categoryId: cat.id }, _max: { sortOrder: true } })
    const row = await prisma.checklistItem.create({
      data: { ...d, sortOrder: (max._max.sortOrder ?? -1) + 1 },
      select: ITEM_SELECT,
    })
    return NextResponse.json({ item: toEditItem(row) }, { status: 201 })
  } catch (e) {
    return caught(e, 'POST /api/checklists/items')
  }
}
