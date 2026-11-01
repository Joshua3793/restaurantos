import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { atLeast } from '@/lib/roles'
import { ensureInboxSeeded, loadTags, isPaletteColor } from '@/lib/inbox/tags'

export const dynamic = 'force-dynamic'

const OPEN_STATUSES = ['OPEN', 'WAITING', 'SNOOZED'] as const

/**
 * GET — the tag list, shaped by who is asking.
 * STAFF: active, cook-pickable, not manager-only. LEAD: active, not manager-only.
 * MANAGER+: everything (inactive too) with the open-item count per tag.
 */
export async function GET() {
  try {
    const user = await requireSession()
    await ensureInboxSeeded()
    const all = await loadTags()

    if (!atLeast(user.role, 'MANAGER')) {
      const tags = all.filter(t =>
        t.isActive && !t.managerOnly && (atLeast(user.role, 'LEAD') || t.cookCanPick),
      )
      return NextResponse.json({ tags })
    }

    const counts = await prisma.inboxItem.groupBy({
      by: ['tagId'],
      where: { status: { in: [...OPEN_STATUSES] } },
      _count: { _all: true },
    })
    const byTag = new Map(counts.map(c => [c.tagId, c._count._all]))
    return NextResponse.json({
      tags: all.map(t => ({ ...t, openCount: byTag.get(t.id) ?? 0 })),
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/inbox/tags', e)
    return NextResponse.json({ error: 'Failed to load tags' }, { status: 500 })
  }
}

/** POST — a manager adds a tag. Never built-in, never manager-only. */
export async function POST(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const body = (await req.json().catch(() => null)) as
      { name?: unknown; color?: unknown; cookCanPick?: unknown } | null

    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (name.length < 1 || name.length > 24) {
      return NextResponse.json({ error: 'Give the tag a name' }, { status: 400 })
    }
    if (!isPaletteColor(body?.color)) {
      return NextResponse.json({ error: 'Pick a colour' }, { status: 400 })
    }

    await ensureInboxSeeded()
    const all = await loadTags()
    if (all.some(t => t.isActive && t.name.toLowerCase() === name.toLowerCase())) {
      return NextResponse.json({ error: `There’s already a tag called ${name}` }, { status: 409 })
    }

    const tag = await prisma.inboxTag.create({
      data: {
        name,
        color: (body!.color as string).toLowerCase(),
        cookCanPick: body?.cookCanPick === true,
        managerOnly: false,
        sortOrder: all.length, // rows are never removed, so this only grows
      },
      select: {
        id: true, builtIn: true, name: true, color: true,
        cookCanPick: true, managerOnly: true, isActive: true,
      },
    })
    return NextResponse.json({ tag }, { status: 201 })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/inbox/tags', e)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }
}
