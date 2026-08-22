import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { Role } from '@prisma/client'
import { assignableLevels } from '@/lib/roles'
import { inviteOne, type InviteResult } from '@/lib/user-invite'
import {
  type AssignmentInput,
  validateAssignmentRows,
  dedupeAssignmentRows,
} from '@/lib/assignment-input'

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

  // Validate BEFORE dedupe: dedupe keeps only the first row for a given node,
  // so if the same node is submitted twice with different `clearance` values,
  // validate-first checks BOTH rows before either is dropped, while
  // dedupe-first would silently discard the second row's clearance unchecked.
  // /api/settings/users/[id]/assignments uses the same two helpers in this
  // order — keep both routes consistent.
  const rawAssignmentRows = Array.isArray(rawAssignments) ? rawAssignments : []
  const assignmentError = await validateAssignmentRows(rawAssignmentRows, admin.role)
  if (assignmentError) return NextResponse.json({ error: assignmentError }, { status: 400 })
  const assignments = dedupeAssignmentRows(rawAssignmentRows)

  const role = clearance as Role
  const supabaseAdmin = createAdminClient()
  const actor = { id: admin.id, email: admin.email, name: admin.name }
  const results: InviteResult[] = []

  for (const email of emails) {
    results.push(await inviteOne({ email, role, name, assignments, actor, appUrl, supabaseAdmin }))
  }

  // 'inconsistent' is not a success either — count it alongside 'failed' for
  // the summary tally even though it's reported with its own distinct status
  // string and message so the caller can tell "invite failed" apart from
  // "the two stores are now diverged and need manual fixing."
  const failed = results.filter(r => r.status === 'failed' || r.status === 'inconsistent')
  return NextResponse.json(
    { results, invited: results.length - failed.length, failed: failed.length },
    { status: failed.length === results.length ? 400 : 201 },
  )
}
