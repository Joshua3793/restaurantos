import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { minusDays, shiftBusinessDate } from '@/lib/checklists/rules'
import type { HistoryPeople } from '@/lib/checklists/history-types'

export const dynamic = 'force-dynamic'

const WINDOW_DAYS = 60

/** GET ?rcId= — MANAGER+: who has worked a list here in the last 60 days, for the "Everyone" filter. */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const rcId = req.nextUrl.searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    if (!(await isRcInScope(user, rcId))) {
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })
    }

    const since = minusDays(shiftBusinessDate('OPEN'), WINDOW_DAYS)
    const rows = await prisma.checklistRunCrew.findMany({
      where: { run: { businessDate: { gte: since }, station: { revenueCenterId: rcId } } },
      select: { userId: true, userName: true },
      orderBy: { joinedAt: 'desc' },
    })
    // Newest name wins if someone was renamed; then A-Z.
    const byId = new Map<string, string>()
    for (const r of rows) if (!byId.has(r.userId)) byId.set(r.userId, r.userName)
    const people = [...byId].map(([userId, name]) => ({ userId, name }))
      .sort((a, b) => a.name.localeCompare(b.name))

    const body: HistoryPeople = { people }
    return NextResponse.json(body)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/checklists/history/people', e)
    return NextResponse.json({ error: 'Failed to load people' }, { status: 500 })
  }
}
