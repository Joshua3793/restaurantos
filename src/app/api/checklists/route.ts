import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { defaultPhase, type Phase } from '@/lib/checklists/rules'
import { buildCookView } from '@/lib/checklists/cook-view'

export const dynamic = 'force-dynamic'

/**
 * GET ?rcId=&phase=OPEN|CLOSE — the cook's checklist screen: station cards,
 * the runs this cook has picked, the whole-kitchen run and last night's notes.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession()
    const rcId = req.nextUrl.searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const p = req.nextUrl.searchParams.get('phase')
    const phase: Phase = p === 'OPEN' || p === 'CLOSE' ? p : defaultPhase()
    return NextResponse.json(await buildCookView(user, rcId, phase))
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/checklists', e)
    return NextResponse.json({ error: 'Failed to load checklist' }, { status: 500 })
  }
}
