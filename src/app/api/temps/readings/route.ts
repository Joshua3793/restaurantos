import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveLocationRcIds } from '@/lib/rc-scope'
import { pacificDate, pacificHHMM } from '@/lib/checklists/rules'

export const dynamic = 'force-dynamic'

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
// Log a reading. Any signed-in cook. Body:
//   { unitId, temp, time?, logDate?, recordedBy?, takenAt?, clientId? }
// `takenAt` (ISO) is when the cook took the reading — a phone that logged it
// with no signal sends it later from its queue. It is believed only within the
// last 24 h and not in the future: one taken more than 24 h ago is refused
// (422, code TOO_OLD — the phone keeps it for a cook to discard), one from the
// future is stamped now. `clientId` makes the save safe to replay: the phone mints it once, and a
// resend of a save whose answer was lost finds the same row instead of adding a
// second reading. time / logDate default to now, Pacific (never server UTC).
const TAKEN_WINDOW_MS = 24 * 60 * 60 * 1000
const FUTURE_SLACK_MS = 5 * 60 * 1000   // a phone clock a little ahead is not "the future"
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/
const YMD = /^\d{4}-\d{2}-\d{2}$/
const HM = /^\d{2}:\d{2}$/

export async function POST(req: NextRequest) {
  try {
    const user = await requireSession()
    const { unitId, temp, time, logDate, recordedBy, takenAt, clientId } = await req.json()

    if (!unitId) return NextResponse.json({ error: 'unitId is required' }, { status: 400 })
    if (temp == null || temp === '' || Number.isNaN(Number(temp))) {
      return NextResponse.json({ error: 'temp must be a number' }, { status: 400 })
    }
    const unit = await prisma.tempUnit.findUnique({ where: { id: String(unitId) }, select: { id: true } })
    if (!unit) return NextResponse.json({ error: 'That unit no longer exists' }, { status: 404 })

    const now = new Date()
    let fields: { time: string; logDate: string }
    if (takenAt !== undefined && takenAt !== null) {
      const at = new Date(String(takenAt))
      const ms = at.getTime()
      if (!Number.isNaN(ms) && ms < now.getTime() - TAKEN_WINDOW_MS) {
        return NextResponse.json(
          { error: 'Too old to send — this reading was taken more than a day ago', code: 'TOO_OLD' },
          { status: 422 },
        )
      }
      const believable = !Number.isNaN(ms) && ms <= now.getTime() + FUTURE_SLACK_MS && ms >= now.getTime() - TAKEN_WINDOW_MS
      fields = believable
        ? {
            time: typeof time === 'string' && HM.test(time) ? time : pacificHHMM(at),
            logDate: typeof logDate === 'string' && YMD.test(logDate) ? logDate : pacificDate(at),
          }
        : { time: pacificHHMM(now), logDate: pacificDate(now) }
    } else {
      fields = { time: time || pacificHHMM(now), logDate: logDate || pacificDate(now) }
    }

    const data = {
      unitId: unit.id,
      temp: Number(temp),
      ...fields,
      recordedBy: recordedBy || user.name || user.email || null,
    }
    const id = typeof clientId === 'string' && CLIENT_ID.test(clientId) ? clientId : null
    // A replay of a save that already landed returns the row it made, unchanged.
    const reading = id
      ? await prisma.tempReading.upsert({ where: { id }, create: { id, ...data }, update: {} })
      : await prisma.tempReading.create({ data })

    return NextResponse.json(
      { id: reading.id, unitId: reading.unitId, logDate: reading.logDate, time: reading.time, temp: Number(reading.temp) },
      { status: 201 },
    )
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[temps/readings POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
