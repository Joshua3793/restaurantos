import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest) {
  try {
    await requireSession('ADMIN')
    const body = await req.json()
    const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : []
    if (!ids.length) return NextResponse.json({ error: 'ids required' }, { status: 400 })
    await prisma.$transaction(ids.map((id, i) => prisma.eodCheckItem.update({ where: { id }, data: { sortOrder: i } })))
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/eod/checklist/reorder', e)
    return NextResponse.json({ error: 'Failed to reorder' }, { status: 500 })
  }
}
