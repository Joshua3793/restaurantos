import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { caught, fail, readBody } from '@/lib/checklists/edit-server'
import { JOB_FIELDS } from '@/lib/checklists/links'

export const dynamic = 'force-dynamic'

/**
 * POST { ids } — makes separate copies of a job (on different lists of one
 * kitchen, same phase) into one shared job. The first id's settings win; every
 * copy keeps its own category and place.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const b = await readBody(req)
    const ids = Array.isArray(b.ids) ? Array.from(new Set(b.ids.filter((x): x is string => typeof x === 'string'))) : []
    if (ids.length < 2) return fail(400, 'Pick at least two jobs')

    const rows = await prisma.checklistItem.findMany({
      where: { id: { in: ids }, isActive: true, category: { isActive: true, station: { isActive: true } } },
      select: {
        id: true, linkId: true, title: true, howTo: true, isBlocker: true, answer: true, unit: true,
        safeMin: true, safeMax: true, tempUnitId: true, days: true, dueBy: true,
        category: { select: { phase: true, stationId: true, station: { select: { revenueCenterId: true } } } },
      },
    })
    if (rows.length !== ids.length) return fail(404, 'A job was changed or removed — reload and try again')
    const rcs = new Set(rows.map(r => r.category.station.revenueCenterId))
    const phases = new Set(rows.map(r => r.category.phase))
    const stations = new Set(rows.map(r => r.category.stationId))
    if (rcs.size !== 1 || phases.size !== 1) return fail(400, 'Jobs must be in one kitchen, all opening or all closing')
    if (stations.size !== rows.length) return fail(400, 'Each job must be on a different list')
    await assertRcWritable(user, rows[0].category.station.revenueCenterId)

    const lead = rows.find(r => r.id === ids[0])!
    const job = Object.fromEntries(JOB_FIELDS.map(k => [k, lead[k]])) as Record<(typeof JOB_FIELDS)[number], never>
    const linkId = rows.find(r => r.linkId)?.linkId ?? randomUUID()
    const oldLinks = Array.from(new Set(rows.map(r => r.linkId).filter((x): x is string => !!x && x !== linkId)))

    await prisma.$transaction([
      // Copies already linked elsewhere join the same job.
      ...(oldLinks.length ? [prisma.checklistItem.updateMany({ where: { linkId: { in: oldLinks } }, data: { linkId } })] : []),
      prisma.checklistItem.updateMany({ where: { id: { in: ids } }, data: { ...job, linkId } }),
    ])
    return NextResponse.json({ ok: true })
  } catch (e) {
    return caught(e, 'POST /api/checklists/items/link')
  }
}
