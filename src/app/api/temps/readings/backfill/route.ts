import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveLocationRcIds } from '@/lib/rc-scope'
import { backfillTempReadings, type TempUnitType } from '@/lib/temps/backfill'

export const dynamic = 'force-dynamic'

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ── POST /api/temps/readings/backfill ─────────────────────────────────────────
// The Temp page's "Read" button. Fills two random readings per active unit per
// day (see src/lib/temps/backfill.ts) from each unit's last logged day through
// today, for the units visible to the active RC / location. Body (all optional):
//   { rcId?, locationId?, from?, to?, recordedBy?, dry? }
// `from` defaults to the earliest "last logged day" across the visible units
// (today for a unit that has never been read); `to` defaults to today.
// Generates synthetic readings — MANAGER+ only.
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const body = await req.json().catch(() => ({}))
    const rcId: string | null = body?.rcId ?? null
    const locationId: string | null = body?.locationId ?? null
    const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null

    const unitRows = await prisma.tempUnit.findMany({
      where: {
        isActive: true,
        ...(locRcIds
          ? { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] }
          : rcId ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, type: true },
    })
    if (!unitRows.length) return NextResponse.json({ error: 'No active temp units in scope' }, { status: 400 })
    const units = unitRows.map(u => ({ id: u.id, name: u.name, type: u.type as TempUnitType }))

    const today = ymd(new Date())
    const to: string = typeof body?.to === 'string' && body.to ? body.to : today

    let from: string | null = typeof body?.from === 'string' && body.from ? body.from : null
    if (!from) {
      const latest = await prisma.tempReading.groupBy({
        by: ['unitId'],
        where: { unitId: { in: units.map(u => u.id) } },
        _max: { logDate: true },
      })
      const byUnit = new Map(latest.map(l => [l.unitId, l._max.logDate]))
      from = to
      for (const u of units) {
        const d = byUnit.get(u.id) ?? to
        if (d < from) from = d
      }
    }
    if (from > to) return NextResponse.json({ error: '`from` is after `to`' }, { status: 400 })

    const recordedBy: string | null =
      typeof body?.recordedBy === 'string' && body.recordedBy ? body.recordedBy : (user.name || user.email || null)

    const result = await backfillTempReadings({ units, from, to, recordedBy, dry: body?.dry === true })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[temps/readings/backfill POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
