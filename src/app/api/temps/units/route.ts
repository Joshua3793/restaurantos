import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveLocationRcIds } from '@/lib/rc-scope'
import { loadTempUnits, serializeUnit } from '@/lib/temps/units'

export const dynamic = 'force-dynamic'

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

    // rcId alone and a location both mean "these RCs + shared"; neither = every unit.
    const units = await loadTempUnits(locRcIds ?? (rcId ? [rcId] : null), date)

    return NextResponse.json(units, {
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
