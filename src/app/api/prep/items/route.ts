import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveScopedRcIds, resolveLocationRcIds } from '@/lib/rc-scope'
import { loadPrepItems } from '@/lib/prep-items-server'

// GET reads req.url so it is dynamic by usage; declare it so a refactor can never prerender it.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const activeOnly = searchParams.get('active') !== 'false'
  // Items switched off the prep list (prepEnabled=false) stay out of every
  // consumer's view — Pass, Pre-shift, Today, the run sheet — unless the caller
  // asks for them (the prep page does, to offer the switch back on).
  const includeHidden = searchParams.get('includeHidden') === 'true'

  // Scope to the active RC (or a location's child RCs) when passed — matching the
  // /prep page and the RC-scoped Pass cards — else fall back to all the user's RCs.
  // Shared (revenueCenterId null) prep ALWAYS shows: it belongs to every RC.
  // allowed===null (ADMIN / unscoped) with no rc/location param → no filter.
  const rcId = searchParams.get('rcId')
  const locationId = searchParams.get('locationId')
  const allowed = await resolveScopedRcIds(user)
  let rcIn: string[] | null // null = no concrete-RC restriction (shared prep still shows)
  if (locationId) {
    rcIn = await resolveLocationRcIds(user, locationId)
  } else if (rcId) {
    // Honor an rcId only inside the caller's scope; out-of-scope → shared prep only.
    rcIn = allowed === null || allowed.has(rcId) ? [rcId] : []
  } else {
    rcIn = allowed === null ? null : [...allowed]
  }
  const enriched = await loadPrepItems({ rcIn, activeOnly, includeHidden })

  // This list is mutated constantly (add to list, status, priority) and the client
  // updates optimistically then refetches. A cached/SWR response makes load() return
  // the pre-mutation snapshot, reverting optimistic adds — so never cache it.
  return NextResponse.json(enriched, {
    headers: { 'Cache-Control': 'no-store' },
  })
  } catch (err) {
    console.error('[prep/items GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
