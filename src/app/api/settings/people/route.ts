import { NextResponse, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { PREP_STATIONS } from '@/lib/prep-utils'
import { deriveInitials, mergePeople, type PersonLogin, type PersonRoster } from '@/lib/people'
import { Prisma } from '@prisma/client'
import type { Role } from '@prisma/client'
import { assignableLevels } from '@/lib/roles'
import { createAdminClient } from '@/lib/supabase/admin'
import { inviteOne, type InviteResult } from '@/lib/user-invite'
import { loadSettings } from '@/lib/tips/settings'
import {
  type AssignmentInput, validateAssignmentRows, dedupeAssignmentRows,
} from '@/lib/assignment-input'

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

// POST — create one person: a login, a roster row, or both.
//
// ORDER IS DELIBERATE: Cook first → invite → link.
//
// Both partial outcomes are VALID people (roster-only, login-only), so neither
// needs undoing. The invite is the failure-prone half (network, email delivery,
// Supabase) and the retryable one — if it fails, the roster row survives and
// the caller is told, with a retry available on the Identity tab. Inverting the
// order would mean compensating a Supabase invite, a second thing that can fail.
export async function POST(req: NextRequest) {
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => ({})) as {
    name?: string
    login?: { email?: string; clearance?: string; assignments?: AssignmentInput[] }
    roster?: {
      initials?: string; homeStation?: string | null; clockId?: string | null
      tipRoleId?: string | null; onTipPool?: boolean
    }
  }

  const name = String(body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'A name is required' }, { status: 400 })
  if (!body.login && !body.roster) {
    return NextResponse.json(
      { error: 'Give this person an app login, a kitchen roster row, or both.' }, { status: 400 },
    )
  }

  // ── validate EVERYTHING before writing anything ──────────────────────────
  let assignments: Array<{ locationId: string | null; revenueCenterId: string | null; clearance: Role | null }> = []
  let role: Role | null = null
  let email = ''

  if (body.login) {
    email = String(body.login.email ?? '').trim().toLowerCase()
    if (!email) return NextResponse.json({ error: 'An email is required for an app login' }, { status: 400 })
    if (email === admin.email.toLowerCase()) {
      return NextResponse.json({ error: 'Cannot invite yourself' }, { status: 400 })
    }
    const allowed = assignableLevels(admin.role)
    if (!body.login.clearance || !allowed.includes(body.login.clearance as Role)) {
      return NextResponse.json(
        { error: `Clearance must be one of: ${allowed.join(', ')}` }, { status: 400 },
      )
    }
    role = body.login.clearance as Role
    // Validate BEFORE dedupe — dedupe keeps only the first row per node, so
    // validate-first checks both rows when the same node is submitted twice
    // with different clearances. Same order as the other two routes.
    const rows = Array.isArray(body.login.assignments) ? body.login.assignments : []
    const assignmentError = await validateAssignmentRows(rows, admin.role)
    if (assignmentError) return NextResponse.json({ error: assignmentError }, { status: 400 })
    assignments = dedupeAssignmentRows(rows)
  }

  const clockId = body.roster ? String(body.roster.clockId ?? '').trim() : ''
  if (clockId) {
    const clash = await prisma.cook.findUnique({ where: { clockId }, select: { id: true, name: true } })
    if (clash) {
      return NextResponse.json(
        { error: `Clock #${clockId} already belongs to ${clash.name}` }, { status: 409 },
      )
    }
  }

  // ── 1. roster row ────────────────────────────────────────────────────────
  //
  // Cook.name is the SHORT FIRST NAME — it renders on prep run-sheet chips and
  // seeds `initials`; the surname lives in Cook.lastName, which the tip payout
  // CSV exports as its own column. User.name keeps the FULL name; the two are
  // separate fields on purpose and are never synced. Split exactly as
  // POST /api/tips/roster builds a roster row.
  const [firstName, ...restOfName] = name.split(/\s+/)
  const lastName = restOfName.join(' ') || null

  let cookId: string | null = null
  if (body.roster) {
    try {
      const settings = await loadSettings()
      const created = await prisma.cook.create({
        data: {
          name: firstName,
          lastName,
          initials: (body.roster.initials?.trim().toUpperCase().slice(0, 3)) || deriveInitials(name),
          homeStation: body.roster.homeStation?.trim() || null,
          clockId: clockId || null,
          tipRoleId: body.roster.tipRoleId || null,
          onTipPool: body.roster.onTipPool ?? true,
          // Prefilled once, then owned by the person — never re-read from
          // settings. POST /api/prep/cooks omits this; the hub must not.
          dailyHourCap: settings.defaultDailyHourCap,
          sortOrder: await prisma.cook.count(),
        },
      })
      cookId = created.id
    } catch (e) {
      // Losing side of a concurrent create for the same clockId: the pre-check
      // above raced another request past it. Map the unique violation to the
      // same readable 409 that POST /api/tips/roster returns, rather than
      // letting it fall through as a generic 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const holder = clockId
          ? await prisma.cook.findUnique({ where: { clockId }, select: { id: true, name: true } })
          : null
        return NextResponse.json(
          { error: `Clock #${clockId} already belongs to ${holder?.name ?? 'another cook'}` },
          { status: 409 },
        )
      }
      console.error('[settings/people POST] roster create failed', e)
      return NextResponse.json(
        { error: 'Could not create the roster row. Nothing was created.' }, { status: 500 },
      )
    }
  }

  // ── 2. invite ────────────────────────────────────────────────────────────
  let invite: InviteResult | null = null
  if (body.login && role) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || new URL(req.url).origin
    invite = await inviteOne({
      email, role, name, assignments,
      actor: { id: admin.id, email: admin.email, name: admin.name },
      appUrl,
      supabaseAdmin: createAdminClient(),
    })
  }

  // ── 3. link ──────────────────────────────────────────────────────────────
  const userId = invite?.userId ?? null
  let warning: string | undefined
  if (cookId && userId) {
    try {
      await prisma.cook.update({ where: { id: cookId }, data: { userId } })
    } catch (e) {
      // Both halves exist and are individually correct; only the join failed.
      // Report it rather than failing a create that mostly succeeded — the
      // Identity tab can link them in one click.
      console.error('[settings/people POST] link failed', e)
      warning = 'Created both, but could not link the login to the roster row. Link them on the Identity tab.'
    }
  }

  return NextResponse.json(
    { cookId, userId, invite, ...(warning ? { warning } : {}) },
    { status: 201 },
  )
}
