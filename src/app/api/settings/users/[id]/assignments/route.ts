import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { recordAccessEvent, type AccessAction } from '@/lib/access-audit'
import {
  validateAssignmentRows,
  dedupeAssignmentRows,
  keyOf,
  type AssignmentInput,
} from '@/lib/assignment-input'

export const dynamic = 'force-dynamic'

/**
 * PUT — replace a person's whole assignment set.
 *
 * The set is diffed against what is stored so the audit log records what
 * actually changed rather than "everything was replaced". A no-op PUT writes
 * no events.
 */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const target = await prisma.user.findUnique({ where: { id: params.id } })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (target.role === 'OWNER') {
    return NextResponse.json(
      { error: 'The owner has access everywhere; assignments do not apply.' }, { status: 400 },
    )
  }

  const body = await req.json().catch(() => null)
  const incoming = Array.isArray(body?.assignments) ? (body.assignments as AssignmentInput[]) : []

  if (incoming.length === 0) {
    return NextResponse.json(
      { error: 'Assign at least one location or revenue center — a person with no assignments has no access.' },
      { status: 400 },
    )
  }

  // Shape + referential integrity + per-row clearance bounds. Uses the SAME
  // validator as the invite route: a per-assignment `clearance` is a real
  // authorization grant, so it must be bounded by assignableLevels(actor) just
  // like the primary clearance. Without that check an admin could write
  // `clearance: 'OWNER'` onto an assignment row and mint owner-level access at
  // that node, bypassing the User_single_owner index entirely (that index
  // guards User.role, not UserScope.clearance).
  const validationError = await validateAssignmentRows(incoming, admin.role)
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 })
  }
  const next = dedupeAssignmentRows(incoming)

  const before = await prisma.userScope.findMany({
    where: { userId: params.id },
    select: { locationId: true, revenueCenterId: true, clearance: true },
  })

  // Collect location/RC ids from both before and after: removed assignments are
  // keyed by rows present only in before, so their names must resolve from the
  // union. Audit events need readable names for both additions and removals.
  const allRows = [...next, ...before]
  const locationIds = new Set(allRows.map(r => r.locationId).filter((x): x is string => !!x))
  const rcIds = new Set(allRows.map(r => r.revenueCenterId).filter((x): x is string => !!x))

  await prisma.$transaction([
    prisma.userScope.deleteMany({ where: { userId: params.id } }),
    prisma.userScope.createMany({
      data: next.map(r => ({ ...r, userId: params.id })),
    }),
  ])

  // Names for readable audit entries.
  const [locs, rcs] = await Promise.all([
    prisma.location.findMany({ where: { id: { in: [...locationIds] } }, select: { id: true, name: true } }),
    prisma.revenueCenter.findMany({ where: { id: { in: [...rcIds] } }, select: { id: true, name: true } }),
  ])
  const locName = new Map(locs.map(l => [l.id, l.name]))
  const rcName = new Map(rcs.map(r => [r.id, r.name]))

  const beforeMap = new Map(before.map(r => [keyOf(r), r]))
  const afterMap = new Map(next.map(r => [keyOf(r), r]))
  const actor = { id: admin.id, email: admin.email, name: admin.name }
  const targetParty = { id: target.id, email: target.email, name: target.name }

  const events: Array<{ action: AccessAction; row: typeof next[number]; from?: string | null }> = []
  for (const [k, row] of afterMap) {
    const prev = beforeMap.get(k)
    if (!prev) { events.push({ action: 'ASSIGNMENT_ADDED', row }); continue }
    if (prev.clearance !== row.clearance) {
      events.push({
        action: row.clearance ? 'OVERRIDE_SET' : 'OVERRIDE_CLEARED',
        row, from: prev.clearance,
      })
    }
  }
  for (const [k, row] of beforeMap) {
    if (!afterMap.has(k)) events.push({ action: 'ASSIGNMENT_REMOVED', row })
  }

  // The assignment replacement above has already genuinely committed — a
  // failure writing the audit trail must not flip that into a reported
  // failure. Log it loudly and surface it as a non-fatal warning on the
  // response instead, matching the pattern in
  // src/app/api/settings/users/route.ts and .../[id]/route.ts.
  let auditWarning: string | undefined
  try {
    for (const e of events) {
      await recordAccessEvent(prisma, {
        actor, target: targetParty, action: e.action,
        detail: {
          from: e.from ?? null,
          to: e.row.clearance ?? null,
          locationId: e.row.locationId,
          locationName: e.row.locationId ? locName.get(e.row.locationId) ?? null : null,
          rcId: e.row.revenueCenterId,
          rcName: e.row.revenueCenterId ? rcName.get(e.row.revenueCenterId) ?? null : null,
        },
      })
    }
  } catch (auditError) {
    const auditMessage = auditError instanceof Error ? auditError.message : 'Unknown error'
    console.error(
      `[settings/users/${params.id}/assignments] audit write failed after the assignment ` +
      `replacement already committed: ${auditMessage}`,
    )
    auditWarning = 'Saved, but the audit log entry failed to write.'
  }

  const assignments = await prisma.userScope.findMany({
    where: { userId: params.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, clearance: true,
      location: { select: { id: true, name: true } },
      revenueCenter: { select: { id: true, name: true, location: { select: { id: true, name: true } } } },
    },
  })

  return NextResponse.json({
    assignments: assignments.map(s => ({
      id: s.id,
      locationId: s.location?.id ?? s.revenueCenter?.location.id ?? null,
      locationName: s.location?.name ?? s.revenueCenter?.location.name ?? null,
      revenueCenterId: s.revenueCenter?.id ?? null,
      rcName: s.revenueCenter?.name ?? null,
      clearance: s.clearance,
    })),
    ...(auditWarning ? { warning: auditWarning } : {}),
  })
}
