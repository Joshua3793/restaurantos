import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { isPaletteColor, parseName } from '@/lib/checklists/item-input'
import { caught, fail, notFound, readBody } from '@/lib/checklists/edit-server'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string } }

async function activeStation(id: string) {
  return prisma.checklistStation.findFirst({
    where: { id, isActive: true },
    select: { id: true, revenueCenterId: true, isShared: true },
  })
}

/** PATCH { name?, color? } — rename or recolour. `isShared` is never writable. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const user = await requireSession('MANAGER')
    const s = await activeStation(params.id)
    if (!s) return notFound()
    await assertRcWritable(user, s.revenueCenterId)

    const b = await readBody(req)
    const data: { name?: string; color?: string } = {}
    if (b.name !== undefined) {
      const n = parseName(b.name, 'Give the station a name')
      if (!n.ok) return fail(400, n.error)
      const clash = await prisma.checklistStation.findFirst({
        where: {
          revenueCenterId: s.revenueCenterId, isActive: true, id: { not: s.id },
          name: { equals: n.name, mode: 'insensitive' },
        },
        select: { id: true },
      })
      if (clash) return fail(409, `There's already a station called ${n.name}`)
      data.name = n.name
    }
    if (b.color !== undefined) {
      if (!isPaletteColor(b.color)) return fail(400, 'Pick one of the colours')
      data.color = b.color
    }

    const station = await prisma.checklistStation.update({
      where: { id: s.id },
      data,
      select: { id: true, name: true, color: true, isShared: true, isActive: true },
    })
    return NextResponse.json({ station })
  } catch (e) {
    return caught(e, 'PATCH /api/checklists/stations/[id]')
  }
}

/** DELETE — takes the station off (soft). Its runs and history stay. The shared list can't go. */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const user = await requireSession('MANAGER')
    const s = await activeStation(params.id)
    if (!s) return notFound()
    await assertRcWritable(user, s.revenueCenterId)
    if (s.isShared) return fail(409, "The whole-kitchen list can't be removed")

    await prisma.checklistStation.update({ where: { id: s.id }, data: { isActive: false } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return caught(e, 'DELETE /api/checklists/stations/[id]')
  }
}
