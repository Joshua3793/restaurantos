import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { ensureInboxSeeded, ROUTE_REASONS, type RouteReason } from '@/lib/inbox/tags'

export const dynamic = 'force-dynamic'

/** GET — which tag each checklist flag reason lands in (tag ids). */
export async function GET() {
  try {
    await requireSession('MANAGER')
    await ensureInboxSeeded()
    const rows = await prisma.inboxFlagRoute.findMany({ select: { reason: true, tagId: true } })
    const routes: Record<RouteReason, string | null> = { BROKEN: null, RAN_OUT: null, OTHER: null }
    for (const r of rows) {
      if ((ROUTE_REASONS as readonly string[]).includes(r.reason)) routes[r.reason as RouteReason] = r.tagId
    }
    return NextResponse.json({ routes })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/inbox/flag-routes', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}

/** PUT — point one flag reason at an active tag. */
export async function PUT(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const body = (await req.json().catch(() => null)) as { reason?: unknown; tagId?: unknown } | null
    const reason = body?.reason
    if (typeof reason !== 'string' || !(ROUTE_REASONS as readonly string[]).includes(reason)) {
      return NextResponse.json({ error: 'Pick a reason' }, { status: 400 })
    }
    await ensureInboxSeeded()
    const tag = typeof body?.tagId === 'string'
      ? await prisma.inboxTag.findUnique({ where: { id: body.tagId }, select: { id: true, isActive: true } })
      : null
    if (!tag || !tag.isActive) {
      return NextResponse.json({ error: 'Pick an active tag' }, { status: 400 })
    }
    await prisma.inboxFlagRoute.upsert({
      where: { reason: reason as RouteReason },
      create: { reason: reason as RouteReason, tagId: tag.id },
      update: { tagId: tag.id },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PUT /api/inbox/flag-routes', e)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }
}
