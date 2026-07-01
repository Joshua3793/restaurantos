import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveLocationRcIds } from '@/lib/rc-scope'

export const dynamic = 'force-dynamic'

const num = (v: unknown) => (v == null ? null : Number(v))

// Serialize a unit (+ optional readings) with Decimal → number coercion.
function serializeUnit(u: {
  id: string; name: string; type: string
  safeMin: unknown; safeMax: unknown
  revenueCenterId: string | null; sortOrder: number
  readings?: { id: string; time: string; temp: unknown }[]
}) {
  return {
    id: u.id,
    name: u.name,
    type: u.type,
    safeMin: num(u.safeMin),
    safeMax: num(u.safeMax),
    revenueCenterId: u.revenueCenterId,
    sortOrder: u.sortOrder,
    ...(u.readings
      ? { readings: u.readings.map(r => ({ id: r.id, time: r.time, temp: Number(r.temp) })) }
      : {}),
  }
}

// ── GET /api/temps/units?rcId=&date=YYYY-MM-DD ────────────────────────────────
// Returns active units visible to the revenue center (its own + shared/null).
// When `date` is supplied, bundles that day's readings on each unit so the
// Today view can load in a single request.
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession()
    const { searchParams } = new URL(req.url)
    const rcId = searchParams.get('rcId')
    const date = searchParams.get('date')
    const locationId = searchParams.get('locationId')
    const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null

    const units = await prisma.tempUnit.findMany({
      where: {
        isActive: true,
        ...(locRcIds
          ? { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] }
          : rcId ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: date
        ? { readings: { where: { logDate: date }, orderBy: { time: 'asc' } } }
        : undefined,
    })

    return NextResponse.json(units.map(serializeUnit), {
      headers: { 'Cache-Control': 'private, max-age=5, stale-while-revalidate=30' },
    })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[temps/units GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── POST /api/temps/units ─────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const { name, type, safeMin, safeMax, revenueCenterId, sortOrder } = await req.json()

    if (!name || !String(name).trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    if (!['FRIDGE', 'FREEZER', 'HOT'].includes(type)) {
      return NextResponse.json({ error: 'type must be FRIDGE, FREEZER or HOT' }, { status: 400 })
    }

    const unit = await prisma.tempUnit.create({
      data: {
        name: String(name).trim(),
        type,
        safeMin: safeMin == null || safeMin === '' ? null : Number(safeMin),
        safeMax: safeMax == null || safeMax === '' ? null : Number(safeMax),
        revenueCenterId: revenueCenterId || null,
        sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
      },
    })

    return NextResponse.json(serializeUnit(unit), { status: 201 })
  } catch (err) {
    console.error('[temps/units POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
