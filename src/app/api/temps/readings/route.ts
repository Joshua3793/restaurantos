import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveLocationRcIds } from '@/lib/rc-scope'

export const dynamic = 'force-dynamic'

const hm = (d: Date) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ── GET /api/temps/readings?rcId=&from=&to=&unitId= ───────────────────────────
// Flat reading list (newest day first) for the History view + Excel export.
// Each reading carries its unit's name/type/range so the client can judge
// safe/out-of-range and group by day without extra lookups.
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession()
    const { searchParams } = new URL(req.url)
    const rcId = searchParams.get('rcId')
    const from = searchParams.get('from') // 'YYYY-MM-DD' inclusive
    const to = searchParams.get('to') // 'YYYY-MM-DD' inclusive
    const unitId = searchParams.get('unitId')
    const locationId = searchParams.get('locationId')
    const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null

    const readings = await prisma.tempReading.findMany({
      where: {
        ...(unitId ? { unitId } : {}),
        ...(from || to
          ? { logDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
        unit: locRcIds
          ? { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] }
          : rcId
            ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
            : undefined,
      },
      orderBy: [{ logDate: 'desc' }, { time: 'asc' }],
      include: {
        unit: { select: { id: true, name: true, type: true, safeMin: true, safeMax: true } },
      },
    })

    return NextResponse.json(
      readings.map(r => ({
        id: r.id,
        unitId: r.unitId,
        logDate: r.logDate,
        time: r.time,
        temp: Number(r.temp),
        recordedBy: r.recordedBy,
        unit: {
          id: r.unit.id,
          name: r.unit.name,
          type: r.unit.type,
          safeMin: r.unit.safeMin == null ? null : Number(r.unit.safeMin),
          safeMax: r.unit.safeMax == null ? null : Number(r.unit.safeMax),
        },
      })),
    )
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[temps/readings GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── POST /api/temps/readings ──────────────────────────────────────────────────
// Log a reading. time/logDate default to now (server local).
export async function POST(req: NextRequest) {
  try {
    const { unitId, temp, time, logDate, recordedBy } = await req.json()

    if (!unitId) return NextResponse.json({ error: 'unitId is required' }, { status: 400 })
    if (temp == null || temp === '' || Number.isNaN(Number(temp))) {
      return NextResponse.json({ error: 'temp must be a number' }, { status: 400 })
    }

    const now = new Date()
    const reading = await prisma.tempReading.create({
      data: {
        unitId,
        temp: Number(temp),
        time: time || hm(now),
        logDate: logDate || ymd(now),
        recordedBy: recordedBy || null,
      },
    })

    return NextResponse.json(
      { id: reading.id, unitId: reading.unitId, logDate: reading.logDate, time: reading.time, temp: Number(reading.temp) },
      { status: 201 },
    )
  } catch (err) {
    console.error('[temps/readings POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
