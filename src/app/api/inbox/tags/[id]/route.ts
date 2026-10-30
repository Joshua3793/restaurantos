import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { ensureInboxSeeded, loadTags, isPaletteColor } from '@/lib/inbox/tags'

export const dynamic = 'force-dynamic'

const TAG_SELECT = {
  id: true, builtIn: true, name: true, color: true,
  cookCanPick: true, managerOnly: true, isActive: true,
} as const

/**
 * PATCH — rename, recolour, or change who can pick a tag.
 * Built-in tags take name + colour only; their other settings are fixed.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('MANAGER')
    const body = (await req.json().catch(() => null)) as
      { name?: unknown; color?: unknown; cookCanPick?: unknown } | null
    await ensureInboxSeeded()

    const all = await loadTags()
    const tag = all.find(t => t.id === params.id)
    if (!tag) return NextResponse.json({ error: 'Tag not found' }, { status: 404 })

    if (tag.builtIn && body?.cookCanPick !== undefined) {
      return NextResponse.json({ error: 'Built-in tags keep their settings' }, { status: 400 })
    }

    const data: { name?: string; color?: string; cookCanPick?: boolean } = {}

    if (body?.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name.length < 1 || name.length > 24) {
        return NextResponse.json({ error: 'Give the tag a name' }, { status: 400 })
      }
      if (all.some(t => t.isActive && t.id !== tag.id && t.name.toLowerCase() === name.toLowerCase())) {
        return NextResponse.json({ error: `There’s already a tag called ${name}` }, { status: 409 })
      }
      data.name = name
    }

    if (body?.color !== undefined) {
      const keepsCurrent = typeof body.color === 'string' && body.color.toLowerCase() === tag.color.toLowerCase()
      if (!keepsCurrent && !isPaletteColor(body.color)) {
        return NextResponse.json({ error: 'Pick a colour' }, { status: 400 })
      }
      data.color = (body.color as string).toLowerCase()
    }

    if (body?.cookCanPick !== undefined) {
      if (typeof body.cookCanPick !== 'boolean') {
        return NextResponse.json({ error: 'Failed to save' }, { status: 400 })
      }
      data.cookCanPick = body.cookCanPick
    }

    const updated = await prisma.inboxTag.update({
      where: { id: tag.id },
      data,
      select: TAG_SELECT,
    })
    return NextResponse.json({ tag: updated })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/inbox/tags/[id]', e)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }
}

/**
 * DELETE — never a hard delete: the tag is switched off (isActive=false) and any
 * open items keep it. Built-ins stay; a tag a flag route points at must be moved first.
 */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('MANAGER')
    await ensureInboxSeeded()

    const tag = await prisma.inboxTag.findUnique({
      where: { id: params.id },
      select: { id: true, builtIn: true },
    })
    if (!tag) return NextResponse.json({ error: 'Tag not found' }, { status: 404 })
    if (tag.builtIn) {
      return NextResponse.json({ error: 'Built-in tags can’t be removed' }, { status: 409 })
    }

    const routed = await prisma.inboxFlagRoute.findFirst({
      where: { tagId: tag.id },
      select: { reason: true },
    })
    if (routed) {
      return NextResponse.json({ error: 'Move the flag route off this tag first' }, { status: 409 })
    }

    await prisma.inboxTag.update({ where: { id: tag.id }, data: { isActive: false } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('DELETE /api/inbox/tags/[id]', e)
    return NextResponse.json({ error: 'Failed to remove' }, { status: 500 })
  }
}
