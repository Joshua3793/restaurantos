import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { parseName } from '@/lib/checklists/item-input'
import { caught, fail, notFound, readBody } from '@/lib/checklists/edit-server'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string } }

/** An active category on an active station, with the station's kitchen. */
async function activeCategory(id: string) {
  return prisma.checklistCategory.findFirst({
    where: { id, isActive: true, station: { isActive: true } },
    select: { id: true, station: { select: { revenueCenterId: true } } },
  })
}

/** PATCH { name } — rename. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const user = await requireSession('MANAGER')
    const c = await activeCategory(params.id)
    if (!c) return notFound()
    await assertRcWritable(user, c.station.revenueCenterId)

    const n = parseName((await readBody(req)).name, 'Give the category a name')
    if (!n.ok) return fail(400, n.error)
    const category = await prisma.checklistCategory.update({
      where: { id: c.id }, data: { name: n.name }, select: { id: true, name: true },
    })
    return NextResponse.json({ category })
  } catch (e) {
    return caught(e, 'PATCH /api/checklists/categories/[id]')
  }
}

/** DELETE — takes the category off (soft); its jobs go with it. History keeps its snapshots. */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const user = await requireSession('MANAGER')
    const c = await activeCategory(params.id)
    if (!c) return notFound()
    await assertRcWritable(user, c.station.revenueCenterId)

    await prisma.checklistCategory.update({ where: { id: c.id }, data: { isActive: false } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return caught(e, 'DELETE /api/checklists/categories/[id]')
  }
}
