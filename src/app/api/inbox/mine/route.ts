import { NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { loadMine } from '@/lib/inbox/store'

export const dynamic = 'force-dynamic'

/** GET — the caller's own reports from the last 14 days, newest first. Marks nothing seen. */
export async function GET() {
  try {
    const user = await requireSession()
    return NextResponse.json({ items: await loadMine(user) })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/inbox/mine', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}
