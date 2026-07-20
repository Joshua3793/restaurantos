import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { validateTimeMinutes, validateSpan } from '@/lib/service-validation'

export const dynamic = 'force-dynamic'

// ── PATCH /api/services/[id] ───────────────────────────────────────────────
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession('ADMIN')

    const existing = await prisma.service.findUnique({ where: { id: params.id } })
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await req.json().catch(() => ({}))
    const { name, timeMinutes, endMinutes, sortOrder, isActive } = body

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

    if (endMinutes !== undefined && endMinutes !== null) {
      const endErr = validateTimeMinutes(endMinutes, 'endMinutes')
      if (endErr) return NextResponse.json({ error: endErr }, { status: 400 })
    }
    if (endMinutes !== undefined) {
      data.endMinutes = endMinutes === null ? null : endMinutes
    }

    // Check the span against the values the row will actually END UP with — a PATCH
    // may move only one edge onto the other's existing value.
    const effStart = timeMinutes !== undefined ? timeMinutes : existing.timeMinutes
    const effEnd = endMinutes !== undefined ? endMinutes : existing.endMinutes
    const spanErr = validateSpan(effStart, effEnd)
    if (spanErr) return NextResponse.json({ error: spanErr }, { status: 400 })

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
