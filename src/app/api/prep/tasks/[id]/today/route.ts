import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function dayStart(dateStr: string | null): Date {
  const d = dateStr ? new Date(dateStr) : new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

// Activate: idempotent create of today's membership log.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession()
    const body = await req.json().catch(() => ({}))
    const logDate = dayStart(body.date ?? null)
    const log = await prisma.prepTaskLog.upsert({
      where: { prepTaskId_logDate: { prepTaskId: params.id, logDate } },
      create: { prepTaskId: params.id, logDate },
      update: {},
      select: { id: true, prepTaskId: true, logDate: true },
    })
    return NextResponse.json(log, { status: 201 })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/prep/tasks/[id]/today', e)
    return NextResponse.json({ error: 'Failed to activate task' }, { status: 500 })
  }
}

// Done / remove: clear today's membership log (vanish + reset).
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSession()
    const { searchParams } = new URL(req.url)
    const logDate = dayStart(searchParams.get('date'))
    await prisma.prepTaskLog.deleteMany({ where: { prepTaskId: params.id, logDate } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('DELETE /api/prep/tasks/[id]/today', e)
    return NextResponse.json({ error: 'Failed to clear task' }, { status: 500 })
  }
}
