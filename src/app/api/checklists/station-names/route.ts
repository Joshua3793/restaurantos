import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'

export const dynamic = 'force-dynamic'

/**
 * GET ?rcId= — the names of a kitchen's active stations, in screen order.
 * Read-only on purpose: no starter stations are seeded and no run is created,
 * so any signed-in person can open a picker (e.g. "Report something" → Where)
 * without changing anything. The whole-kitchen (shared) station is left out.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession()
    const rcId = req.nextUrl.searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    if (!(await isRcInScope(user, rcId))) {
      return NextResponse.json({ error: 'Revenue center is outside your access.' }, { status: 403 })
    }
    const rows = await prisma.checklistStation.findMany({
      where: { revenueCenterId: rcId, isActive: true, isShared: false },
      orderBy: { sortOrder: 'asc' },
      select: { name: true },
    })
    return NextResponse.json({ names: rows.map(r => r.name) })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/checklists/station-names', e)
    return NextResponse.json({ error: 'Failed to load stations' }, { status: 500 })
  }
}
