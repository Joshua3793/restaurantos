import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function normalizeInitials(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value.trim().toUpperCase().slice(0, 3)
}

// ── PATCH /api/prep/cooks/[id] ──────────────────────────────────────────────
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('ADMIN')

    const existing = await prisma.cook.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await req.json().catch(() => ({}))
    const { name, initials, homeStation, isActive, sortOrder } = body

    const data: Record<string, unknown> = {}

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      }
      data.name = name.trim()
    }

    if (initials !== undefined) {
      const normalizedInitials = normalizeInitials(initials)
      if (!normalizedInitials) {
        return NextResponse.json({ error: 'initials cannot be empty' }, { status: 400 })
      }
      data.initials = normalizedInitials
    }

    if (homeStation !== undefined) {
      if (homeStation !== null && typeof homeStation !== 'string') {
        return NextResponse.json({ error: 'homeStation must be a string' }, { status: 400 })
      }
      data.homeStation = typeof homeStation === 'string' ? homeStation.trim() || null : null
    }

    if (isActive !== undefined) {
      if (typeof isActive !== 'boolean') {
        return NextResponse.json({ error: 'isActive must be a boolean' }, { status: 400 })
      }
      data.isActive = isActive
    }

    if (sortOrder !== undefined) {
      if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder)) {
        return NextResponse.json({ error: 'sortOrder must be an integer' }, { status: 400 })
      }
      data.sortOrder = sortOrder
    }

    const cook = await prisma.cook.update({ where: { id: params.id }, data })
    return NextResponse.json(cook)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[prep/cooks/[id] PATCH]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── DELETE /api/prep/cooks/[id] ─────────────────────────────────────────────
// Hard delete. Existing PrepLog.assignedTo strings referencing this cook
// simply stop resolving (no FK, no cascade needed).
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('ADMIN')

    const existing = await prisma.cook.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    await prisma.cook.delete({ where: { id: params.id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[prep/cooks/[id] DELETE]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
