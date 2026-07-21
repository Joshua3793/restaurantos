import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

// Polled by the People & Access panel — must never be cached.
export const dynamic = 'force-dynamic'

// GET /api/settings/access-audit?days=30
// Events are kept forever; `days` is only the default view window.
export async function GET(req: NextRequest) {
  try { await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const raw = Number(req.nextUrl.searchParams.get('days') ?? '30')
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 3650) : 30
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const events = await prisma.accessAuditEvent.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true, actorName: true, actorEmail: true, action: true,
      targetName: true, targetEmail: true, detail: true, createdAt: true,
    },
  })

  return NextResponse.json({ events }, { headers: { 'Cache-Control': 'no-store' } })
}
