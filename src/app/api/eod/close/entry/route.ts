import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal, computeTempsReady, computeProgress } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireSession('LEAD')
    const body = await req.json()
    const rcId = String(body.rcId ?? '')
    const itemId = String(body.itemId ?? '')
    const done = Boolean(body.done)
    if (!rcId || !itemId) return NextResponse.json({ error: 'rcId and itemId required' }, { status: 400 })
    const date = businessDateLocal()

    const close = await prisma.eodClose.upsert({
      where: { revenueCenterId_businessDate: { revenueCenterId: rcId, businessDate: date } },
      create: { revenueCenterId: rcId, businessDate: date },
      update: {},
      select: { id: true },
    })
    await prisma.eodCheckEntry.upsert({
      where: { closeId_itemId: { closeId: close.id, itemId } },
      create: { closeId: close.id, itemId, done, updatedByName: user.name ?? user.email ?? null },
      update: { done, updatedByName: user.name ?? user.email ?? null },
    })

    const [items, entries, temps] = await Promise.all([
      prisma.eodCheckItem.findMany({ where: { revenueCenterId: rcId, isActive: true }, select: { id: true, isBlocker: true } }),
      prisma.eodCheckEntry.findMany({ where: { closeId: close.id, done: true }, select: { itemId: true } }),
      computeTempsReady(rcId, date),
    ])
    const doneIds = new Set(entries.map(e => e.itemId))
    return NextResponse.json({ progress: computeProgress(items, doneIds, temps), doneItemIds: [...doneIds] })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/eod/close/entry', e)
    return NextResponse.json({ error: 'Failed to update entry' }, { status: 500 })
  }
}
