import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import type { LastReading } from '@/lib/checklists/history-types'

export const dynamic = 'force-dynamic'

/**
 * GET — what this job read the last time someone logged it ("LAST TIME" on the
 * cook's log sheet): the newest reading of the same list item in a different
 * run on or before this run's day. `null` when there is none. Any signed-in
 * cook may ask, for a line in a kitchen they can see.
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
    if (!line.itemId) return NextResponse.json(null)

    const prev = await prisma.checklistRunLine.findFirst({
      where: {
        itemId: line.itemId,
        runId: { not: line.runId },
        value: { not: null },
        // Postgres sorts NULL first on desc; a reading without a time has nothing to order by.
        doneAt: { not: null },
        run: { businessDate: { lte: line.run.businessDate } },
      },
      orderBy: { doneAt: 'desc' },
      select: { value: true, unit: true, doneByName: true, doneAt: true },
    })
    if (!prev || prev.value == null || !prev.doneAt) return NextResponse.json(null)

    const body: LastReading = {
      value: Number(prev.value),
      unit: prev.unit,
      byName: prev.doneByName,
      at: prev.doneAt.toISOString(),
    }
    return NextResponse.json(body)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/checklists/lines/[id]/last', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
