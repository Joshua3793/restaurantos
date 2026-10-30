import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { minusDays, shiftBusinessDate } from '@/lib/checklists/rules'
import type { HandoverNote, HandoversView } from '@/lib/pass'

export const dynamic = 'force-dynamic'

/**
 * GET ?rcId= — LEAD+: each station's closing handover note from the last close,
 * for the Pass's "From last night". Only SIGNED CLOSE runs with a note count.
 * The date is the current close shift's business date once any of its notes
 * exist; until then (all morning) it is the day before. Shared station first,
 * then the stations' own order. No money here.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession('LEAD')
    const rcId = req.nextUrl.searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    if (!(await isRcInScope(user, rcId))) {
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })
    }

    const current = shiftBusinessDate('CLOSE')
    const previous = minusDays(current, 1)
    const runs = await prisma.checklistRun.findMany({
      where: {
        phase: 'CLOSE',
        status: 'SIGNED',
        businessDate: { in: [current, previous] },
        handoverNote: { not: null },
        station: { revenueCenterId: rcId },
      },
      select: {
        businessDate: true,
        signedOffByName: true,
        signedOffAt: true,
        handoverNote: true,
        station: { select: { name: true, color: true, isShared: true, sortOrder: true } },
      },
    })

    const withNote = runs
      .map(r => ({ ...r, note: (r.handoverNote ?? '').trim() }))
      .filter(r => r.note.length > 0)
    const businessDate = withNote.some(r => r.businessDate === current) ? current : previous

    const notes: HandoverNote[] = withNote
      .filter(r => r.businessDate === businessDate)
      .sort((a, b) =>
        Number(b.station.isShared) - Number(a.station.isShared)
        || a.station.sortOrder - b.station.sortOrder
        || a.station.name.localeCompare(b.station.name))
      .map(r => ({
        stationName: r.station.name,
        color: r.station.color,
        isShared: r.station.isShared,
        byName: r.signedOffByName,
        at: r.signedOffAt ? r.signedOffAt.toISOString() : null,
        note: r.note,
      }))

    const body: HandoversView = { businessDate, notes }
    return NextResponse.json(body)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/checklists/handovers', e)
    return NextResponse.json({ error: 'Failed to load the handover notes' }, { status: 500 })
  }
}
