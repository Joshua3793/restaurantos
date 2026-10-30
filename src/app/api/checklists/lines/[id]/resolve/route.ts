import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { whoOf } from '@/lib/checklists/who'

export const dynamic = 'force-dynamic'

/**
 * POST — a lead marks a flagged job fixed. The line stays FLAGGED (history keeps
 * the problem); it just stops showing as open. Guarded, so two leads tapping at
 * once can't both win: the second gets 409.
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession('LEAD')
    const line = await prisma.checklistRunLine.findUnique({
      where: { id: params.id },
      select: { id: true, run: { select: { station: { select: { revenueCenterId: true } } } } },
    })
    if (!line) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    await assertRcWritable(user, line.run.station.revenueCenterId)

    const who = await whoOf(user)
    const upd = await prisma.checklistRunLine.updateMany({
      where: { id: line.id, status: 'FLAGGED', resolvedAt: null },
      data: { resolvedById: who.id, resolvedByName: who.name, resolvedAt: new Date() },
    })
    if (upd.count === 0) return NextResponse.json({ error: 'Already handled' }, { status: 409 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/checklists/lines/[id]/resolve', e)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }
}
