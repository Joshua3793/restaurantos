import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { shiftBusinessDate, type Phase } from '@/lib/checklists/rules'
import { ensureRun } from '@/lib/checklists/runs'
import { buildCookView, whoOf } from '@/lib/checklists/cook-view'

export const dynamic = 'force-dynamic'

/**
 * POST { rcId, phase, stationIds } — the cook picks one or two stations for
 * this shift. Adds them to each run's crew and drops them from any other
 * station's crew for the same shift. Returns the same body as GET.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession()
    const body = await req.json().catch(() => null)
    const rcId = typeof body?.rcId === 'string' ? body.rcId : ''
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const phase: Phase | null = body?.phase === 'OPEN' || body?.phase === 'CLOSE' ? body.phase : null
    if (!phase) return NextResponse.json({ error: 'Pick opening or closing' }, { status: 400 })

    const ids: string[] = Array.isArray(body?.stationIds)
      ? Array.from(new Set(body.stationIds.filter((x: unknown): x is string => typeof x === 'string' && x !== '')))
      : []
    if (ids.length < 1 || ids.length > 2) {
      return NextResponse.json({ error: 'Pick one or two stations' }, { status: 400 })
    }

    await assertRcWritable(user, rcId)

    const found = await prisma.checklistStation.findMany({
      where: { id: { in: ids }, revenueCenterId: rcId, isActive: true, isShared: false },
      select: { id: true },
    })
    if (found.length !== ids.length) return NextResponse.json({ error: 'Unknown station' }, { status: 400 })

    const businessDate = shiftBusinessDate(phase)
    const who = whoOf(user)
    for (const stationId of ids) {
      const { id: runId } = await ensureRun(stationId, phase, businessDate)
      await prisma.checklistRunCrew.upsert({
        where: { runId_userId: { runId, userId: who.id } },
        create: { runId, userId: who.id, userName: who.name },
        update: { userName: who.name },
      })
    }
    // One shift, one pick: leave any station of this kitchen that is no longer chosen.
    // Only open runs: a signed run keeps its crew, so history still shows who worked it.
    await prisma.checklistRunCrew.deleteMany({
      where: {
        userId: who.id,
        run: { status: 'OPEN', phase, businessDate, station: { revenueCenterId: rcId, id: { notIn: ids } } },
      },
    })

    return NextResponse.json(await buildCookView(user, rcId, phase))
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/checklists/pick', e)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }
}
