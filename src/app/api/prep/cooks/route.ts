import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function normalizeInitials(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value.trim().toUpperCase().slice(0, 3)
}

// Every consumer of this endpoint — the prep run sheet's claim popover/crew
// strip (src/app/prep/page.tsx, components/prep/runsheet/assignee.tsx's Cook
// type) — renders only roster identity: name, initials, home station, active
// flag, sort order. (The People hub at /setup/users does NOT read this route;
// it reads the ADMIN-gated /api/settings/people, which selects the pay columns
// deliberately.) NONE of them use the tip-payroll columns (lastName, clockId,
// wage, dailyHourCap, tipRoleId, onTipPool, posPosition) that also live on
// Cook (see prisma/schema.prisma) — those are for src/lib/tips/* and
// /api/tips/roster only. This endpoint has no minRole (STAFF need it to
// claim prep jobs), so an explicit select is the only thing standing between
// any authenticated user and every colleague's wage + POS employee number.
// Do not widen this select without threading a role check through first.
const COOK_ROSTER_SELECT = {
  id: true,
  name: true,
  initials: true,
  homeStation: true,
  isActive: true,
  sortOrder: true,
} as const

// ── GET /api/prep/cooks ─────────────────────────────────────────────────────
// Default: active cooks only, ordered by sortOrder, name — this is what
// /api/prep/items and every other consumer relies on.
//
// ?includeInactive=true also returns deactivated cooks, sorted active-first.
// It currently has NO caller in the app: the retired kitchen-crew page used it,
// and the People hub that replaced that page reads /api/settings/people
// instead. Kept (and covered by this route's tests) as the supported way to
// list deactivated cooks for reactivation — do not assume it is dead and widen
// the default.
export async function GET(req: NextRequest) {
  try {
    await requireSession()

    const includeInactive = req.nextUrl.searchParams.get('includeInactive') === 'true'

    const cooks = await prisma.cook.findMany({
      where: includeInactive ? {} : { isActive: true },
      select: COOK_ROSTER_SELECT,
      orderBy: includeInactive
        ? [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }]
        : [{ sortOrder: 'asc' }, { name: 'asc' }],
    })

    return NextResponse.json(cooks)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[prep/cooks GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── POST /api/prep/cooks ────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    await requireSession('ADMIN')

    const body = await req.json().catch(() => ({}))
    const { name, initials, homeStation, sortOrder } = body

    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    const normalizedInitials = normalizeInitials(initials)
    if (!normalizedInitials) {
      return NextResponse.json({ error: 'initials is required' }, { status: 400 })
    }

    if (homeStation !== undefined && homeStation !== null && typeof homeStation !== 'string') {
      return NextResponse.json({ error: 'homeStation must be a string' }, { status: 400 })
    }

    const cook = await prisma.cook.create({
      data: {
        name: name.trim(),
        initials: normalizedInitials,
        homeStation: typeof homeStation === 'string' ? homeStation.trim() || null : null,
        sortOrder: typeof sortOrder === 'number' && Number.isInteger(sortOrder) ? sortOrder : 0,
      },
    })

    return NextResponse.json(cook, { status: 201 })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[prep/cooks POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
