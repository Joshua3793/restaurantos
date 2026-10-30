import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { loadRunView } from '@/lib/checklists/runs'

export const dynamic = 'force-dynamic'

/** POST — a lead reopens a signed-off run. The signer is cleared; the handover note stays. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession('LEAD')
    const run = await prisma.checklistRun.findUnique({
      where: { id: params.id },
      include: { station: { select: { revenueCenterId: true } } },
    })
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
    await assertRcWritable(user, run.station.revenueCenterId)
    if (run.status !== 'SIGNED') return NextResponse.json({ error: 'Not signed off' }, { status: 409 })

    const { count } = await prisma.checklistRun.updateMany({
      where: { id: run.id, status: 'SIGNED' },
      data: { status: 'OPEN', signedOffById: null, signedOffByName: null, signedOffAt: null },
    })
    if (count === 0) return NextResponse.json({ error: 'Not signed off' }, { status: 409 })
    return NextResponse.json({ run: await loadRunView(run.id) })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/checklists/runs/[id]/reopen', e)
    return NextResponse.json({ error: 'Failed to reopen' }, { status: 500 })
  }
}
