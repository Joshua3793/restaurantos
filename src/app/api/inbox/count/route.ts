import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { atLeast } from '@/lib/roles'
import { isRcInScope } from '@/lib/rc-scope'
import { syncSystemItems } from '@/lib/inbox/system'
import { leadBadge, staffBadge, assertKitchenExists, InboxError } from '@/lib/inbox/store'

export const dynamic = 'force-dynamic'

/**
 * GET — the bell number. ?rcId= required.
 * LEAD+: open NOW + TODAY items they can see in this kitchen.
 * STAFF: their own reports fixed since they last opened them.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession()
    const rcId = req.nextUrl.searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    if (!(await isRcInScope(user, rcId))) {
      throw new AuthError(403, 'Revenue center is outside your access.')
    }
    if (!atLeast(user.role, 'LEAD')) {
      return NextResponse.json({ count: await staffBadge(user) })
    }
    await assertKitchenExists(rcId) // before the sync: its throttle is keyed on rcId
    await syncSystemItems(rcId)
    return NextResponse.json({ count: await leadBadge(user, rcId) })
  } catch (e) {
    if (e instanceof AuthError || e instanceof InboxError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    console.error('GET /api/inbox/count', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
