import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function dayStart(dateStr: string | null): Date {
  const d = dateStr ? new Date(dateStr) : new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

// Activate: put the task on the list. Membership persists across days until the
// task is checked off or removed, so at most one log per task — reuse it if present.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession()
    const existing = await prisma.prepTaskLog.findFirst({
      where: { prepTaskId: params.id },
      select: { id: true, prepTaskId: true, logDate: true },
    })
    if (existing) return NextResponse.json(existing, { status: 200 })
    const body = await req.json().catch(() => ({}))
    const logDate = dayStart(body.date ?? null)
    const log = await prisma.prepTaskLog.create({
      data: { prepTaskId: params.id, logDate },
      select: { id: true, prepTaskId: true, logDate: true },
    })
    return NextResponse.json(log, { status: 201 })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/prep/tasks/[id]/today', e)
    return NextResponse.json({ error: 'Failed to activate task' }, { status: 500 })
  }
}

// Done / remove: take the task off the list. Clears every log for the task
// regardless of which day it was added, so a persisted task always clears.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession()
    await prisma.prepTaskLog.deleteMany({ where: { prepTaskId: params.id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('DELETE /api/prep/tasks/[id]/today', e)
    return NextResponse.json({ error: 'Failed to clear task' }, { status: 500 })
  }
}
