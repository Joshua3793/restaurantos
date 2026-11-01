import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import type { RecentEntry } from '@/lib/checklists/history-types'

export const dynamic = 'force-dynamic'

const DAYS = 7

/**
 * GET — the same list item on its last 7 earlier runs, newest first, for the
 * desktop job panel: who did it, when, and the reading. A day the job was left
 * undone comes back as TODO. `[]` for a line with no item. Any signed-in cook
 * may ask, for a line in a kitchen they can see.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession()
    const line = await prisma.checklistRunLine.findUnique({
      where: { id: params.id },
      select: {
        itemId: true, runId: true,
        run: { select: { businessDate: true, station: { select: { revenueCenterId: true } } } },
      },
    })
    if (!line) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    if (!(await isRcInScope(user, line.run.station.revenueCenterId))) {
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })
    }
    if (!line.itemId) return NextResponse.json({ entries: [] })

    const rows = await prisma.checklistRunLine.findMany({
      where: {
        itemId: line.itemId,
        runId: { not: line.runId },
        run: { businessDate: { lte: line.run.businessDate } },
      },
      orderBy: { run: { businessDate: 'desc' } },
      take: DAYS,
      select: {
        status: true, value: true, unit: true, doneByName: true, doneAt: true, flagReason: true,
        run: { select: { businessDate: true } },
      },
    })
    const entries: RecentEntry[] = rows.map(r => ({
      date: r.run.businessDate,
      status: r.status,
      value: r.value == null ? null : Number(r.value),
      unit: r.unit,
      byName: r.doneByName,
      at: r.doneAt ? r.doneAt.toISOString() : null,
      flagReason: r.flagReason,
    }))
    return NextResponse.json({ entries })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/checklists/lines/[id]/recent', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
