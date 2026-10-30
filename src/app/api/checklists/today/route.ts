import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { appliesOn, defaultPhase, runProgress, shiftBusinessDate, type Phase } from '@/lib/checklists/rules'
import { sortStations, stationStatus } from '@/lib/checklists/station-status'
import { minusDays, type TodayFlag, type TodayStation, type TodayView } from '@/lib/checklists/today-types'

export const dynamic = 'force-dynamic'

/**
 * GET ?rcId=&phase=OPEN|CLOSE — every station's progress for today's shift, plus
 * the open flagged problems from the last 7 business dates (both phases).
 * Read-only: a station with no run yet is "not started" (or "nothing today" when
 * no job applies today); nothing is seeded here.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession('LEAD')
    const rcId = req.nextUrl.searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    if (!(await isRcInScope(user, rcId))) {
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })
    }
    const p = req.nextUrl.searchParams.get('phase')
    const phase: Phase = p === 'OPEN' || p === 'CLOSE' ? p : defaultPhase()
    const businessDate = shiftBusinessDate(phase)

    const stations = await prisma.checklistStation.findMany({
      where: { revenueCenterId: rcId, isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true, color: true, isShared: true },
    })

    const [runs, flagRows] = await Promise.all([
      prisma.checklistRun.findMany({
        where: { stationId: { in: stations.map(s => s.id) }, phase, businessDate },
        select: {
          stationId: true, status: true, signedOffByName: true, signedOffAt: true,
          crew: { orderBy: { joinedAt: 'asc' }, select: { userName: true } },
          lines: {
            orderBy: { sortOrder: 'asc' },
            select: { id: true, title: true, status: true, isBlocker: true, doneByName: true, resolvedAt: true },
          },
        },
      }),
      prisma.checklistRunLine.findMany({
        where: {
          status: 'FLAGGED',
          resolvedAt: null,
          run: { businessDate: { gte: minusDays(businessDate, 6) }, station: { revenueCenterId: rcId } },
        },
        orderBy: { doneAt: 'desc' },
        select: {
          id: true, title: true, flagReason: true, flagNote: true, value: true, unit: true,
          doneByName: true, doneAt: true,
          run: { select: { station: { select: { name: true } } } },
        },
      }),
    ])
    const runByStation = new Map(runs.map(r => [r.stationId, r]))

    // Stations with no run: count the jobs that would apply today (one query for
    // all, the same rule as the cook screen's job count).
    const noRun = stations.filter(s => !runByStation.has(s.id)).map(s => s.id)
    const applicable = new Map<string, number>()
    if (noRun.length > 0) {
      const items = await prisma.checklistItem.findMany({
        where: { isActive: true, category: { isActive: true, phase, stationId: { in: noRun } } },
        select: { days: true, category: { select: { stationId: true } } },
      })
      for (const i of items) {
        if (!appliesOn(i.days, businessDate)) continue
        const sid = i.category.stationId
        applicable.set(sid, (applicable.get(sid) ?? 0) + 1)
      }
    }

    const cards: TodayStation[] = stations.map(s => {
      const run = runByStation.get(s.id) ?? null
      // A flagged job a lead has marked fixed counts as handled, not as a live problem.
      const lines = run ? run.lines.map(l => ({
        ...l, effective: l.status === 'FLAGGED' && l.resolvedAt ? ('DONE' as const) : l.status,
      })) : []
      const like = lines.map(l => ({ status: l.effective, isBlocker: l.isBlocker }))
      const prog = runProgress(like)
      return {
        id: s.id,
        name: s.name,
        color: s.color,
        isShared: s.isShared,
        crew: run ? run.crew.map(c => c.userName) : [],
        handled: prog.handled,
        total: prog.total,
        status: stationStatus({
          isShared: s.isShared,
          run: run ? { status: run.status, lines: like } : null,
          phase,
          jobCount: run ? undefined : applicable.get(s.id) ?? 0,
        }),
        signedOffByName: run?.signedOffByName ?? null,
        signedOffAt: run?.signedOffAt ? run.signedOffAt.toISOString() : null,
        lines: lines.map(l => ({
          id: l.id, title: l.title, status: l.status, isBlocker: l.isBlocker,
          byName: l.doneByName, fixed: l.status === 'FLAGGED' && !!l.resolvedAt,
        })),
      }
    })

    const flags: TodayFlag[] = flagRows.map(f => ({
      lineId: f.id,
      stationName: f.run.station.name,
      title: f.title,
      reason: f.flagReason,
      note: f.flagNote,
      value: f.value == null ? null : Number(f.value),
      unit: f.unit,
      byName: f.doneByName,
      at: f.doneAt ? f.doneAt.toISOString() : null,
    }))

    const body: TodayView = { phase, businessDate, stations: sortStations(cards), flags }
    return NextResponse.json(body)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/checklists/today', e)
    return NextResponse.json({ error: 'Failed to load the board' }, { status: 500 })
  }
}
