import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal } from '@/lib/eod-close'
import { DEFAULT_OPENING_ITEMS, seedItemId, type OpenCheckRow } from '@/lib/open-checklist'

export const dynamic = 'force-dynamic'

const itemSelect = {
  id: true, revenueCenterId: true, section: true, title: true,
  meta: true, sortOrder: true, isBlocker: true,
} as const

/**
 * GET /api/open-checklist?rcId= — today's opening checklist for one revenue
 * center, each item with whether it is ticked for today's (Pacific) business day.
 * Any signed-in user: cooks tick this list on their start page. No money here.
 *
 * The first time a FOOD revenue center's list is opened it is seeded with
 * DEFAULT_OPENING_ITEMS. "Has ever had items" counts deleted (inactive) ones, so
 * a list a manager emptied on purpose stays empty.
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession()
    const rcId = new URL(req.url).searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })

    const ever = await prisma.openCheckItem.count({ where: { revenueCenterId: rcId } })
    if (ever === 0) {
      const rc = await prisma.revenueCenter.findUnique({ where: { id: rcId }, select: { type: true } })
      if (rc && (rc.type ?? 'FOOD') === 'FOOD') {
        await prisma.openCheckItem.createMany({
          data: DEFAULT_OPENING_ITEMS.map((d, i) => ({ id: seedItemId(rcId, i), revenueCenterId: rcId, sortOrder: i, ...d })),
          skipDuplicates: true,
        })
      }
    }

    const businessDate = businessDateLocal()
    const items = await prisma.openCheckItem.findMany({
      where: { revenueCenterId: rcId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
      select: { ...itemSelect, ticks: { where: { businessDate }, select: { doneByName: true, doneAt: true } } },
    })
    const rows: OpenCheckRow[] = items.map(({ ticks, ...i }) => ({
      ...i,
      done: ticks.length > 0,
      doneByName: ticks[0]?.doneByName ?? null,
      doneAt: ticks[0]?.doneAt.toISOString() ?? null,
    }))
    return NextResponse.json({ businessDate, items: rows }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/open-checklist', e)
    return NextResponse.json({ error: 'Failed to load the opening checklist' }, { status: 500 })
  }
}

/** POST — add an item (Setup, ADMIN). */
export async function POST(req: NextRequest) {
  try {
    await requireSession('ADMIN')
    const body = await req.json()
    const revenueCenterId = String(body.revenueCenterId ?? '')
    const section = String(body.section ?? '').trim()
    const title = String(body.title ?? '').trim()
    if (!revenueCenterId) return NextResponse.json({ error: 'revenueCenterId required' }, { status: 400 })
    if (!section) return NextResponse.json({ error: 'section required' }, { status: 400 })
    if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 })
    const max = await prisma.openCheckItem.aggregate({ where: { revenueCenterId }, _max: { sortOrder: true } })
    const item = await prisma.openCheckItem.create({
      data: {
        revenueCenterId, section, title,
        meta: body.meta ? String(body.meta) : null,
        isBlocker: Boolean(body.isBlocker),
        sortOrder: (max._max.sortOrder ?? -1) + 1,
      },
      select: itemSelect,
    })
    return NextResponse.json(item, { status: 201 })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/open-checklist', e)
    return NextResponse.json({ error: 'Failed to create item' }, { status: 500 })
  }
}
