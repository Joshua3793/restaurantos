import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function validateTimeMinutes(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1439) {
    return 'timeMinutes must be an integer between 0 and 1439'
  }
  return null
}

// ── PATCH /api/services/[id] ───────────────────────────────────────────────
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('ADMIN')

    const existing = await prisma.service.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await req.json().catch(() => ({}))
    const { name, timeMinutes, sortOrder, isActive } = body

    const data: Record<string, unknown> = {}

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      }
      data.name = name.trim()
    }

    if (timeMinutes !== undefined) {
      const timeErr = validateTimeMinutes(timeMinutes)
      if (timeErr) return NextResponse.json({ error: timeErr }, { status: 400 })
      data.timeMinutes = timeMinutes
    }

    if (sortOrder !== undefined) {
      if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder)) {
        return NextResponse.json({ error: 'sortOrder must be an integer' }, { status: 400 })
      }
      data.sortOrder = sortOrder
    }

    if (isActive !== undefined) {
      if (typeof isActive !== 'boolean') {
        return NextResponse.json({ error: 'isActive must be a boolean' }, { status: 400 })
      }
      data.isActive = isActive
    }

    const service = await prisma.service.update({ where: { id: params.id }, data })
    return NextResponse.json(service)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[services/[id] PATCH]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── DELETE /api/services/[id] ──────────────────────────────────────────────
// PrepItem.targetServiceId has an ON DELETE SET NULL FK — no manual unlink needed.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('ADMIN')

    const existing = await prisma.service.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    await prisma.service.delete({ where: { id: params.id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[services/[id] DELETE]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
