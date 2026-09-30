import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { finalizeCountSession } from '@/lib/count-finalize'
import { invalidateTheoreticalCache } from '@/lib/theoretical-cache'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { seesCountMoney, redactSummaryMoney } from '@/lib/count-redact'

export const dynamic = 'force-dynamic'

// POST /api/count/sessions/:id/finalize
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const existing = await prisma.countSession.findUnique({ where: { id: params.id }, select: { revenueCenterId: true } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // RC scope: mirrors the write guard on /api/count/sessions/[id] PATCH/DELETE —
  // a session with no RC (legacy "all items") is left unguarded.
  if (existing.revenueCenterId) {
    try { await assertRcWritable(user, existing.revenueCenterId) }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  }

  const result = await finalizeCountSession(params.id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  // A finalized count resets stock baselines — drop the theoretical-stock cache so the
  // prep list / cost strip reflect the new counts immediately (within this instance).
  invalidateTheoreticalCache()
  // Below MANAGER: the summary keeps its counts but loses its $ value and $ variance.
  const summary = seesCountMoney(user.role) ? result.summary : redactSummaryMoney(result.summary)
  return NextResponse.json({ ok: true, summary })
}
