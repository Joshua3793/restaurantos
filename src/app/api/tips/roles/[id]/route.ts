import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { toRoleDto } from '@/lib/tips/roles'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('MANAGER')
    const existing = await prisma.tipRole.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await req.json().catch(() => ({}))
    const data: Record<string, unknown> = {}
    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      data.name = name
    }
    if (body.multiplier !== undefined) {
      const v = Number(body.multiplier)
      if (!isFinite(v) || v < 0 || v > 5) return NextResponse.json({ error: 'multiplier must be between 0 and 5' }, { status: 400 })
      data.multiplier = v
    }
    if (body.sortOrder !== undefined) {
      const v = Number(body.sortOrder)
      if (!Number.isInteger(v)) return NextResponse.json({ error: 'sortOrder must be an integer' }, { status: 400 })
      data.sortOrder = v
    }

    const role = await prisma.tipRole.update({ where: { id: params.id }, data })
    return NextResponse.json(toRoleDto(role))
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/roles/[id] PATCH]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * Deactivates the role and moves everyone on it to `fallbackRoleId`.
 * Soft delete, because a PAID period's frozen snapshot still names the role.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('MANAGER')
    const existing = await prisma.tipRole.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const remaining = await prisma.tipRole.count({ where: { isActive: true, id: { not: params.id } } })
    if (remaining === 0) return NextResponse.json({ error: 'The last role cannot be deleted' }, { status: 400 })

    const fallbackId = req.nextUrl.searchParams.get('fallbackRoleId')
    const fallback = fallbackId
      ? await prisma.tipRole.findFirst({ where: { id: fallbackId, isActive: true, NOT: { id: params.id } } })
      : await prisma.tipRole.findFirst({ where: { isActive: true, id: { not: params.id } }, orderBy: { sortOrder: 'asc' } })
    if (!fallback) return NextResponse.json({ error: 'fallbackRoleId is not a live role' }, { status: 400 })

    await prisma.$transaction([
      prisma.cook.updateMany({ where: { tipRoleId: params.id }, data: { tipRoleId: fallback.id } }),
      prisma.tipRole.update({ where: { id: params.id }, data: { isActive: false } }),
    ])
    return NextResponse.json({ ok: true, movedTo: fallback.id })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[tips/roles/[id] DELETE]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
