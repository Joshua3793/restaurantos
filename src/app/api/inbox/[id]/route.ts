import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { getItem, act, parseAction, InboxError } from '@/lib/inbox/store'

export const dynamic = 'force-dynamic'

/**
 * GET — one item with its history; the first open writes SEEN.
 * LEAD+ for anything they can see; any signed-in cook for their own report.
 * Anything else is a 404 so it never leaks that the item exists.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession()
    return NextResponse.json(await getItem(user, params.id))
  } catch (e) {
    if (e instanceof AuthError || e instanceof InboxError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    console.error('GET /api/inbox/[id]', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}

/** PATCH — note / snooze / wait / done / reopen / retag (LEAD+). */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession('LEAD')
    const action = parseAction(await req.json().catch(() => null))
    if (!action) return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    const item = await act(user, params.id, action)
    return NextResponse.json({ item })
  } catch (e) {
    if (e instanceof AuthError || e instanceof InboxError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    console.error('PATCH /api/inbox/[id]', e)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }
}
