import { NextRequest, NextResponse } from 'next/server'
import { finalizeCountSession } from '@/lib/count-finalize'
import { invalidateTheoreticalCache } from '@/lib/theoretical-cache'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { seesCountMoney, redactSummaryMoney } from '@/lib/count-redact'

// Mutating handlers must never be statically prerendered — a prerendered
// route serves GET only and returns 405 for everything else.
export const dynamic = 'force-dynamic'

// POST /api/count/sessions/:id/finalize
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  // Finalizing is part of the count flow, which STAFF run — no minRole.
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const existing = await prisma.countSession.findUnique({ where: { id: params.id }, select: { revenueCenterId: true } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // RC scope: same write guard as PATCH /api/count/sessions/:id — a legacy
  // unscoped session (no RC) is left unguarded.
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
