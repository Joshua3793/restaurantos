import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { atLeast } from '@/lib/roles'
import { isRcInScope } from '@/lib/rc-scope'
import { pinBlocked } from '@/lib/pin/crew-status'

export const dynamic = 'force-dynamic'

/** Inbox alerts that mean "a station is behind": not started, or left unsigned. */
const BEHIND_PREFIXES = ['station-open:', 'close-unsigned:']

/**
 * GET ?rcId= — the numbers on the Open & close tabs. LEAD+. Reads only.
 * `behind`: open Inbox alerts for stations not started / closing lists left
 *   unsigned in this kitchen — the same alerts the Inbox shows, so they agree.
 * `phones`: phones waiting for an OK (MANAGER+, else null), counted the way
 *   the Sign-ins page counts them (a manager's or email login's phone waits on no one).
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession('LEAD')
    const rcId = req.nextUrl.searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    if (!(await isRcInScope(user, rcId))) {
      throw new AuthError(403, 'Revenue center is outside your access.')
    }

    const behindQ = prisma.inboxItem.count({
      where: {
        revenueCenterId: rcId,
        status: 'OPEN',
        OR: BEHIND_PREFIXES.map(p => ({ sourceKey: { startsWith: p } })),
      },
    })
    const phonesQ = atLeast(user.role, 'MANAGER')
      ? prisma.pinDevice.findMany({
          where: { status: 'PENDING', cook: { isActive: true } },
          select: { cookId: true, cook: { select: { user: { select: { role: true, isActive: true, email: true } } } } },
        })
      : null

    const [behind, devices] = await Promise.all([behindQ, phonesQ])
    const phones = devices ? devices.filter(d => !pinBlocked(d.cookId, d.cook.user)).length : null
    return NextResponse.json({ behind, phones })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/checklists/tab-counts', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
