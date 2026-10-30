import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal, computeTempsReady, computeProgress, loadStationsClosed } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

// The old kitchen-wide close checklist. The end-of-day page no longer shows it
// and it no longer gates sign-off (station checklists do); the route stays until
// the tables are dropped, and reports the live gate in `progress`.
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

    const [entries, stations, temps] = await Promise.all([
      prisma.eodCheckEntry.findMany({ where: { closeId: close.id, done: true }, select: { itemId: true } }),
      loadStationsClosed(rcId),
      computeTempsReady(rcId, date),
    ])
    return NextResponse.json({ progress: computeProgress(stations, temps), doneItemIds: entries.map(e => e.itemId) })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('PATCH /api/eod/close/entry', e)
    return NextResponse.json({ error: 'Failed to update entry' }, { status: 500 })
  }
}
