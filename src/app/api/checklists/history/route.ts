import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { minusDays, shiftBusinessDate } from '@/lib/checklists/rules'
import { toRunView } from '@/lib/checklists/runs'
import type { HistoryRun } from '@/lib/checklists/history-csv'
import type { HistoryDay, HistoryView } from '@/lib/checklists/history-types'

export const dynamic = 'force-dynamic'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar day: '2026-13-45' and '2026-02-30' are not. */
function isRealDate(raw: string): boolean {
  const t = Date.parse(raw + 'T00:00:00Z')
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === raw
}

/**
 * GET ?rcId=&date=YYYY-MM-DD&userId=&stationId= — MANAGER+ review of one day's
 * opening and closing lists, with a 7-day strip of how each day went.
 * `date` defaults to the last finished night. Read-only.
 *
 * The strip ignores the filters (it is the calendar). `userId` keeps a run when
 * that person is on its crew or did, fixed or signed off any of its lines, and
 * then keeps every line of the run: the surrounding jobs are the context.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const q = req.nextUrl.searchParams
    const rcId = q.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    if (!(await isRcInScope(user, rcId))) {
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })
    }
    const rawDate = q.get('date')
    const date = rawDate && DATE_RE.test(rawDate) && isRealDate(rawDate) ? rawDate : shiftBusinessDate('CLOSE')
    const userId = q.get('userId') || null
    const stationId = q.get('stationId') || null

    const [stations, week, dayRuns] = await Promise.all([
      prisma.checklistStation.findMany({
        where: { revenueCenterId: rcId, isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true },
      }),
      // One light query over the 7 dates for the strip.
      prisma.checklistRun.findMany({
        where: { station: { revenueCenterId: rcId }, businessDate: { gte: minusDays(date, 6), lte: date } },
        select: { businessDate: true, status: true, station: { select: { isShared: true } } },
      }),
      prisma.checklistRun.findMany({
        where: {
          businessDate: date,
          station: { revenueCenterId: rcId },
          ...(stationId ? { stationId } : {}),
        },
        include: {
          lines: { orderBy: { sortOrder: 'asc' } },
          crew: { orderBy: { joinedAt: 'asc' } },
          station: { select: { name: true, color: true, isShared: true, sortOrder: true } },
        },
      }),
    ])

    const days: HistoryDay[] = []
    for (let i = 6; i >= 0; i--) {
      const d = minusDays(date, i)
      const mine = week.filter(r => r.businessDate === d && !r.station.isShared)
      days.push({
        date: d,
        state: mine.length === 0 ? 'none' : mine.every(r => r.status === 'SIGNED') ? 'ok' : 'miss',
      })
    }

    const kept = userId
      ? dayRuns.filter(r =>
        r.crew.some(c => c.userId === userId)
        || r.signedOffById === userId
        || r.lines.some(l => l.doneById === userId || l.resolvedById === userId))
      : dayRuns

    // Closing first (as the board reads), then the order the stations are set up in.
    const phaseRank = { CLOSE: 0, OPEN: 1 } as const
    const runs: HistoryRun[] = [...kept]
      .sort((a, b) => phaseRank[a.phase] - phaseRank[b.phase] || a.station.sortOrder - b.station.sortOrder)
      .map(r => ({
        ...toRunView(r),
        stationName: r.station.name,
        color: r.station.color,
        isShared: r.station.isShared,
      }))

    const body: HistoryView = { date, days, runs, stations }
    return NextResponse.json(body)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/checklists/history', e)
    return NextResponse.json({ error: 'Failed to load history' }, { status: 500 })
  }
}
