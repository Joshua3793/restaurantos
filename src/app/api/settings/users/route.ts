import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { findAuthUserByEmail, hasAcceptedInvite, isAlreadyRegisteredError } from '@/lib/users'
import { Role } from '@prisma/client'
import { assignableLevels } from '@/lib/roles'
import { recordAccessEvent } from '@/lib/access-audit'

export const dynamic = 'force-dynamic'

// GET — everyone plus their assignments, and the location tree the editors need.
export async function GET() {
  try { await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const [users, locations] = await Promise.all([
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
      },
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
  ])

  const shaped = users.map(u => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isActive: u.isActive,
    createdAt: u.createdAt,
    // A Prisma row is created inactive at invite time and flipped active by
    // /auth/callback when the invite is accepted. isActive === false with no
    // name is therefore a genuine pending invite, not a deactivation.
    isPending: !u.isActive && u.name === null,
    assignments: u.scopes.map(s => ({
      id: s.id,
      locationId: s.location?.id ?? s.revenueCenter?.location.id ?? null,
      locationName: s.location?.name ?? s.revenueCenter?.location.name ?? null,
      revenueCenterId: s.revenueCenter?.id ?? null,
      rcName: s.revenueCenter?.name ?? null,
      clearance: s.clearance,
    })),
  }))

  return NextResponse.json({ users: shaped, locations })
}

interface AssignmentInput {
  locationId?: string | null
  revenueCenterId?: string | null
  clearance?: Role | null
}

/** Validates shape + referential integrity. Returns an error string or null. */
async function validateAssignments(rows: AssignmentInput[]): Promise<string | null> {
  if (rows.length === 0) {
    return 'Assign at least one location or revenue center — a person with no assignments has no access.'
  }
  const locationIds = new Set<string>()
  const rcIds = new Set<string>()
  for (const r of rows) {
    const hasLoc = !!r.locationId
    const hasRc = !!r.revenueCenterId
    if (hasLoc === hasRc) {
      return 'Each assignment must target exactly one location or one revenue center.'
    }
    if (hasLoc) locationIds.add(r.locationId as string)
    if (hasRc) rcIds.add(r.revenueCenterId as string)
  }
  if (locationIds.size) {
    const found = await prisma.location.findMany({
      where: { id: { in: [...locationIds] } }, select: { id: true },
    })
    if (found.length !== locationIds.size) return 'One or more referenced locations do not exist.'
  }
  if (rcIds.size) {
    const found = await prisma.revenueCenter.findMany({
      where: { id: { in: [...rcIds] } }, select: { id: true },
    })
    if (found.length !== rcIds.size) return 'One or more referenced revenue centers do not exist.'
  }
  return null
}

/** Dedup by target node; the DB index is NULLS NOT DISTINCT but dedup keeps
 *  createMany from throwing on an obvious double-click. */
function dedupeAssignments(rows: AssignmentInput[]) {
  const seen = new Set<string>()
  return rows
    .map(r => ({
      locationId: r.locationId ?? null,
      revenueCenterId: r.revenueCenterId ?? null,
      clearance: r.clearance ?? null,
    }))
    .filter(r => {
      const key = `${r.locationId ?? ''}|${r.revenueCenterId ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

// POST — invite one or more people (ADMIN only)
// Body: { emails: string[], clearance: Role, assignments: AssignmentInput[], name?: string }
//
// Idempotent per email, exactly as before:
//   - Pending (never accepted): stale Auth user removed, fresh invite sent.
//   - Accepted before: reactivated in place with the new clearance, no email.
export async function POST(req: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || new URL(req.url).origin
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => ({}))
  const {
    emails: rawEmails, email: singleEmail, clearance, assignments: rawAssignments, name: rawName,
  } = body as {
    emails?: string[]; email?: string; clearance?: string
    assignments?: AssignmentInput[]; name?: string
  }

  const emails = [...new Set(
    (Array.isArray(rawEmails) ? rawEmails : singleEmail ? [singleEmail] : [])
      .map(e => e?.trim().toLowerCase())
      .filter((e): e is string => !!e),
  )]
  const name = rawName?.trim() || null

  if (emails.length === 0) {
    return NextResponse.json({ error: 'At least one email is required' }, { status: 400 })
  }
  const allowed = assignableLevels(admin.role)
  if (!clearance || !allowed.includes(clearance as Role)) {
    return NextResponse.json(
      { error: `Clearance must be one of: ${allowed.join(', ')}` }, { status: 400 },
    )
  }
  if (emails.includes(admin.email.toLowerCase())) {
    return NextResponse.json({ error: 'Cannot invite yourself' }, { status: 400 })
  }

  const assignments = dedupeAssignments(Array.isArray(rawAssignments) ? rawAssignments : [])
  const assignmentError = await validateAssignments(assignments)
  if (assignmentError) return NextResponse.json({ error: assignmentError }, { status: 400 })

  const role = clearance as Role
  const supabaseAdmin = createAdminClient()
  const actor = { id: admin.id, email: admin.email, name: admin.name }
  const results: Array<{ email: string; status: string; error?: string }> = []

  for (const email of emails) {
    const inviteMeta = { role, isActive: true, name }

    const sendInvite = async () => {
      const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
        data: inviteMeta,
        redirectTo: `${appUrl}/auth/callback`,
      })
      if (error || !data?.user) return { error }
      const newId = data.user.id
      // A re-invite mints a NEW auth UUID for an unchanged email, so any stale
      // Prisma row must be cleared before inserting the row keyed to the new
      // UUID. Both in ONE interactive transaction: under the pgBouncer
      // transaction-mode pooler two auto-commit statements can land such that
      // the delete isn't visible to the insert, yielding P2002 on email.
      const user = await prisma.$transaction(async (tx) => {
        await tx.user.deleteMany({ where: { email } })
        const created = await tx.user.create({
          data: { id: newId, email, name, role, isActive: false },
        })
        await tx.userScope.createMany({
          data: assignments.map(a => ({ ...a, userId: newId })),
        })
        return created
      })
      return { user }
    }

    const first = await sendInvite()
    if (first.user) {
      await recordAccessEvent(prisma, {
        actor, target: { id: first.user.id, email, name },
        action: 'INVITED', detail: { to: role },
      })
      results.push({ email, status: 'invited' })
      continue
    }
    if (!isAlreadyRegisteredError(first.error)) {
      results.push({ email, status: 'failed', error: first.error?.message ?? 'Failed to send invite' })
      continue
    }

    const existing = await findAuthUserByEmail(supabaseAdmin, email)
    if (!existing) {
      results.push({ email, status: 'failed', error: 'Email already has an unresolvable account.' })
      continue
    }

    if (!hasAcceptedInvite(existing)) {
      await supabaseAdmin.auth.admin.deleteUser(existing.id)
      const retry = await sendInvite()
      if (retry.user) {
        await recordAccessEvent(prisma, {
          actor, target: { id: retry.user.id, email, name },
          action: 'REINVITED', detail: { to: role },
        })
        results.push({ email, status: 'reinvited' })
      } else {
        results.push({ email, status: 'failed', error: retry.error?.message ?? 'Failed to re-invite' })
      }
      continue
    }

    // Accepted before → reactivate in place. Both stores, or neither.
    const { error: metaError } = await supabaseAdmin.auth.admin.updateUserById(existing.id, {
      user_metadata: { role, isActive: true, name },
    })
    if (metaError) {
      results.push({ email, status: 'failed', error: metaError.message })
      continue
    }
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.upsert({
        where: { id: existing.id },
        create: { id: existing.id, email, name, role, isActive: true },
        update: { role, name, isActive: true },
      })
      await tx.userScope.deleteMany({ where: { userId: existing.id } })
      await tx.userScope.createMany({
        data: assignments.map(a => ({ ...a, userId: existing.id })),
      })
      return u
    })
    await recordAccessEvent(prisma, {
      actor, target: { id: user.id, email, name: user.name },
      action: 'REACTIVATED', detail: { to: role },
    })
    results.push({ email, status: 'reactivated' })
  }

  const failed = results.filter(r => r.status === 'failed')
  return NextResponse.json(
    { results, invited: results.length - failed.length, failed: failed.length },
    { status: failed.length === results.length ? 400 : 201 },
  )
}
