import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/signals — list signals.
 * Default: status=OPEN, plus SNOOZED that have expired (treated as OPEN).
 *
 * PATCH /api/signals — bulk action.
 *   body: { ids: string[], action: 'apply' | 'snooze' | 'dismiss', snoozeHours?: number }
 */

export async function GET(_req: NextRequest) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  // Auto-re-open snoozed signals whose snooze has expired
  await prisma.signal.updateMany({
    where: { status: 'SNOOZED', snoozeUntil: { lte: new Date() } },
    data: { status: 'OPEN', snoozeUntil: null },
  })

  const signals = await prisma.signal.findMany({
    where: { status: { in: ['OPEN', 'APPLIED'] } },
    orderBy: [
      { severity: 'asc' }, // critical first alphabetically
      { impactValue: 'desc' },
      { createdAt: 'desc' },
    ],
  })

  return NextResponse.json({
    signals: signals.map(s => ({ ...s, impactValue: s.impactValue !== null ? Number(s.impactValue) : null })),
    counts: {
      open:     signals.filter(s => s.status === 'OPEN').length,
      applied:  signals.filter(s => s.status === 'APPLIED').length,
      critical: signals.filter(s => s.severity === 'critical').length,
    },
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function PATCH(req: NextRequest) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { ids, action, snoozeHours = 24 } = await req.json() as {
    ids: string[]; action: 'apply' | 'snooze' | 'dismiss'; snoozeHours?: number
  }
  if (!Array.isArray(ids) || ids.length === 0) return NextResponse.json({ error: 'ids required' }, { status: 400 })

  if (action === 'apply') {
    await prisma.signal.updateMany({ where: { id: { in: ids } }, data: { status: 'APPLIED' } })
  } else if (action === 'snooze') {
    const until = new Date(Date.now() + snoozeHours * 3_600_000)
    await prisma.signal.updateMany({ where: { id: { in: ids } }, data: { status: 'SNOOZED', snoozeUntil: until } })
  } else if (action === 'dismiss') {
    await prisma.signal.updateMany({ where: { id: { in: ids } }, data: { status: 'DISMISSED' } })
  } else {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }

  return NextResponse.json({ ok: true, count: ids.length })
}
