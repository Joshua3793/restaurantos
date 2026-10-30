import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope } from '@/lib/rc-scope'
import { ensureInboxSeeded, loadTags } from '@/lib/inbox/tags'
import { syncSystemItems } from '@/lib/inbox/system'
import { loadItems, loadCounts, visibleTags, InboxError } from '@/lib/inbox/store'

export const dynamic = 'force-dynamic'

/**
 * GET — the Inbox for one kitchen (plus whole-house items), LEAD+.
 * ?rcId= required · ?status=open|done · ?tagId= · ?from=<raisedById> · ?place=
 * Counts ignore the tag / from / place filters so the chips and tabs stay whole.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession('LEAD')
    const sp = req.nextUrl.searchParams
    const rcId = sp.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    if (!(await isRcInScope(user, rcId))) {
      throw new AuthError(403, 'Revenue center is outside your access.')
    }

    await ensureInboxSeeded()
    await syncSystemItems(rcId)
    const now = new Date()
    const allTags = await loadTags()
    const [items, counts] = await Promise.all([
      loadItems(user, {
        rcId,
        status: sp.get('status') === 'done' ? 'done' : 'open',
        tagId: sp.get('tagId'),
        from: sp.get('from'),
        place: sp.get('place'),
      }, now),
      loadCounts(user, rcId, allTags, now),
    ])
    return NextResponse.json({ items, counts, tags: visibleTags(user, allTags) })
  } catch (e) {
    if (e instanceof AuthError || e instanceof InboxError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    console.error('GET /api/inbox', e)
    return NextResponse.json({ error: 'Failed to load the inbox' }, { status: 500 })
  }
}
