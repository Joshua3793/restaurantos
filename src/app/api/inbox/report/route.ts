import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { createReport, InboxError } from '@/lib/inbox/store'

export const dynamic = 'force-dynamic'

/** POST — "Report something". Any signed-in cook. { rcId, tagId, text, place?, urgent? } */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession()
    const item = await createReport(user, await req.json().catch(() => null))
    return NextResponse.json({ item }, { status: 201 })
  } catch (e) {
    if (e instanceof AuthError || e instanceof InboxError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    console.error('POST /api/inbox/report', e)
    return NextResponse.json({ error: 'Failed to send' }, { status: 500 })
  }
}
