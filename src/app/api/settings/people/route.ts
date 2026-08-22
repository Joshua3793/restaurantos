import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { PREP_STATIONS } from '@/lib/prep-utils'
import { mergePeople, type PersonLogin, type PersonRoster } from '@/lib/people'

export const dynamic = 'force-dynamic'

/** The Cook columns the hub needs — every one of them, including pay. ADMIN-gated. */
const COOK_SELECT = {
  id: true, name: true, lastName: true, initials: true, homeStation: true,
  isActive: true, sortOrder: true, clockId: true, posPosition: true,
  wage: true, dailyHourCap: true, tipRoleId: true, onTipPool: true,
} as const

type CookRow = {
  id: string; name: string; lastName: string | null; initials: string
  homeStation: string | null; isActive: boolean; sortOrder: number
  clockId: string | null; posPosition: string | null
  wage: unknown; dailyHourCap: unknown; tipRoleId: string | null; onTipPool: boolean
}

/** Prisma Decimal arrives as a string in JSON — normalise at the boundary, never in the UI. */
const num = (v: unknown): number | null => (v == null ? null : Number(v))

const toRoster = (c: CookRow): PersonRoster => ({
  id: c.id, name: c.name, lastName: c.lastName, initials: c.initials,
  homeStation: c.homeStation, isActive: c.isActive, sortOrder: c.sortOrder,
  clockId: c.clockId, posPosition: c.posPosition,
  wage: num(c.wage), dailyHourCap: num(c.dailyHourCap),
  tipRoleId: c.tipRoleId, onTipPool: c.onTipPool,
})

// GET — every person (login, roster, or both) plus the lookups the editors need.
//
// The lookups ride along deliberately: /api/tips/roles is MANAGER-gated, and the
// tip roster is otherwise only reachable through GET /api/tips/periods/[id],
// which requires an OPEN PERIOD to exist. The hub must not depend on that.
export async function GET() {
  try { await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const [users, orphanCooks, locations, tipRoles, prepSettings] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, email: true, name: true, role: true, isActive: true, createdAt: true,
        scopes: {
          select: {
            id: true, clearance: true,
            location: { select: { id: true, name: true } },
            revenueCenter: {
              select: { id: true, name: true, location: { select: { id: true, name: true } } },
            },
          },
        },
        cook: { select: COOK_SELECT },
      },
    }),
    // userId: null is what guarantees a linked cook is not also returned here —
    // mergePeople would otherwise emit it twice.
    prisma.cook.findMany({
      where: { userId: null },
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: COOK_SELECT,
    }),
    prisma.location.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, color: true,
        revenueCenters: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, color: true },
        },
      },
    }),
    prisma.tipRole.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true, multiplier: true, sortOrder: true },
    }),
    // ORM read, not $queryRawUnsafe: the pgBouncer text[] gotcha in CLAUDE.md
    // applies to WRITES via $executeRaw tagged templates, not to reads.
    prisma.prepSettings.findUnique({
      where: { id: 'singleton' }, select: { stations: true },
    }),
  ])

  const linked = users.map(u => {
    const login: PersonLogin = {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      isActive: u.isActive,
      // A Prisma row is created inactive at invite time and flipped active by
      // /auth/callback on accept. Inactive with no name is a genuine pending
      // invite, not a deactivation. Same rule as GET /api/settings/users.
      isPending: !u.isActive && u.name === null,
      createdAt: u.createdAt.toISOString(),
      assignments: u.scopes.map(s => ({
        id: s.id,
        locationId: s.location?.id ?? s.revenueCenter?.location.id ?? null,
        locationName: s.location?.name ?? s.revenueCenter?.location.name ?? null,
        revenueCenterId: s.revenueCenter?.id ?? null,
        rcName: s.revenueCenter?.name ?? null,
        clearance: s.clearance,
      })),
    }
    return { login, roster: u.cook ? toRoster(u.cook as CookRow) : null }
  })

  return NextResponse.json({
    people: mergePeople(linked, orphanCooks.map(c => toRoster(c as CookRow))),
    locations,
    tipRoles: tipRoles.map(r => ({ ...r, multiplier: Number(r.multiplier) })),
    stations: prepSettings?.stations?.filter(Boolean) ?? PREP_STATIONS,
  })
}
