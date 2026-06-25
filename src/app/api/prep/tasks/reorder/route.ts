import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest) {
  try {
    await requireSession()
    const body = await req.json()
    const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : []
    if (!ids.length) return NextResponse.json({ error: 'ids required' }, { status: 400 })
    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.prepTask.update({ where: { id }, data: { sortOrder: index } }),
      ),
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/prep/tasks/reorder', e)
    return NextResponse.json({ error: 'Failed to reorder tasks' }, { status: 500 })
  }
}
