import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { businessDateLocal } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

/**
 * PUT { done } — tick or untick an opening item for today's business day.
 * Any cook may tick (it is their list) within revenue centers they can write to.
 * Idempotent both ways: ticking twice keeps the first tick's name and time.
 */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSession()
    const { done } = await req.json()
    const item = await prisma.openCheckItem.findUnique({
      where: { id: params.id },
      select: { revenueCenterId: true, isActive: true },
    })
    if (!item || !item.isActive) return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    await assertRcWritable(user, item.revenueCenterId)

    const businessDate = businessDateLocal()
    if (done) {
      await prisma.openCheckTick.upsert({
        where: { itemId_businessDate: { itemId: params.id, businessDate } },
        create: { itemId: params.id, businessDate, doneByName: user.name ?? user.email ?? null },
        update: {},
      })
    } else {
      await prisma.openCheckTick.deleteMany({ where: { itemId: params.id, businessDate } })
    }
    return NextResponse.json({ ok: true, businessDate })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PUT /api/open-checklist/[id]/tick', e)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }
}
