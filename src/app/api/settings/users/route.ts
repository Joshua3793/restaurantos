import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { findAuthUserByEmail, hasAcceptedInvite, isAlreadyRegisteredError } from '@/lib/users'
import { Role } from '@prisma/client'
import { assignableLevels } from '@/lib/roles'
import { recordAccessEvent } from '@/lib/access-audit'
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
  const results: Array<{ email: string; status: string; error?: string; warning?: string }> = []

  for (const email of emails) {
    // Isolate each email's work: a thrown error (transaction failure against
    // the pooler, an audit write failure, …) must not abort the whole request
    // and discard the outcomes of emails already committed earlier in the loop.
    try {
      const inviteMeta = { role, isActive: true, name }

      const sendInvite = async (action: 'INVITED' | 'REINVITED') => {
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
        // the delete isn't visible to the insert, yielding P2002 on email. The
        // audit write rides the same tx — it's part of the same Prisma-side
        // mutation and Supabase has already committed by this point.
        const user = await prisma.$transaction(async (tx) => {
          await tx.user.deleteMany({ where: { email } })
          const created = await tx.user.create({
            data: { id: newId, email, name, role, isActive: false },
          })
          await tx.userScope.createMany({
            data: assignments.map(a => ({ ...a, userId: newId })),
          })
          await recordAccessEvent(tx, {
            actor, target: { id: created.id, email, name },
            action, detail: { to: role },
          })
          return created
        })
        return { user }
      }

      const first = await sendInvite('INVITED')
      if (first.user) {
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

      // The owner's Prisma row is the single-occupancy seat (User_single_owner
      // partial unique index). This loop's "accepted before → reactivate in
      // place" branch below would otherwise happily overwrite that row's role
      // and replace its UserScope rows — and since assignableLevels() never
      // returns OWNER, there is no in-app way back once that happens. Reject
      // before either the re-invite branch (deletes the Supabase user) or the
      // reactivate branch writes anything.
      const existingPrismaUser = await prisma.user.findUnique({
        where: { id: existing.id }, select: { role: true },
      })
      if (existingPrismaUser?.role === 'OWNER') {
        results.push({ email, status: 'failed', error: 'The owner cannot be changed. Transfer ownership first.' })
        continue
      }

      if (!hasAcceptedInvite(existing)) {
        await supabaseAdmin.auth.admin.deleteUser(existing.id)
        const retry = await sendInvite('REINVITED')
        if (retry.user) {
          results.push({ email, status: 'reinvited' })
        } else {
          results.push({ email, status: 'failed', error: retry.error?.message ?? 'Failed to re-invite' })
        }
        continue
      }

      // Accepted before → reactivate in place. Both stores, or neither.
      //
      // Prisma is authoritative for API access (requireSession reads it), so
      // it's written FIRST; Supabase user_metadata (what middleware reads for
      // page access) is written second. If Supabase then fails, we revert the
      // Prisma row + scopes to their prior values rather than leave Prisma
      // saying "reactivated with the new role" while Supabase still has the
      // old metadata — that combination lets requireSession authorize the new
      // role while middleware is still gating on the old one.
      const priorUser = await prisma.user.findUnique({
        where: { id: existing.id },
        select: { name: true, role: true, isActive: true },
      })
      const priorScopes = await prisma.userScope.findMany({
        where: { userId: existing.id },
        select: { locationId: true, revenueCenterId: true, clearance: true },
      })

      await prisma.$transaction(async (tx) => {
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

      // updateUserById can fail two ways: it RETURNS { error }, or it THROWS
      // (network blip, Supabase 5xx). Both leave the same divergence — Prisma
      // already holds the new role/scopes, Supabase still has the old
      // metadata — so both must run the exact same compensation below. If a
      // throw were left to propagate to the outer catch instead, the revert
      // would never run: Prisma would stay committed to the new state, and
      // the caller would just be told 'failed', hiding a real, uncompensated
      // divergence between the two stores.
      let metaError: { message: string } | null = null
      try {
        const { error } = await supabaseAdmin.auth.admin.updateUserById(existing.id, {
          user_metadata: { role, isActive: true, name },
        })
        metaError = error
      } catch (e) {
        metaError = { message: e instanceof Error ? e.message : 'Supabase metadata update threw' }
      }

      if (metaError) {
        // The revert is itself a $transaction against the same pgBouncer
        // transaction-mode pooler documented elsewhere in this repo as an
        // intermittent write-failure source (see CLAUDE.md). If IT throws,
        // Prisma is left holding the new role/scopes while Supabase still has
        // the old metadata, and nothing here will retry it — that's a strictly
        // worse, silently-diverged outcome than "invite failed," so it must be
        // reported as its own loud, distinct result rather than falling into
        // the generic 'failed' message below or the outer catch's generic text.
        try {
          await prisma.$transaction(async (tx) => {
            if (priorUser) {
              await tx.user.update({
                where: { id: existing.id },
                data: { name: priorUser.name, role: priorUser.role, isActive: priorUser.isActive },
              })
            } else {
              await tx.user.deleteMany({ where: { id: existing.id } })
            }
            await tx.userScope.deleteMany({ where: { userId: existing.id } })
            if (priorScopes.length) {
              await tx.userScope.createMany({
                data: priorScopes.map(s => ({ ...s, userId: existing.id })),
              })
            }
          })
          results.push({ email, status: 'failed', error: metaError.message })
        } catch (revertError) {
          const revertMessage = revertError instanceof Error ? revertError.message : 'Unknown error'
          console.error(
            `[settings/users] reactivate revert failed for ${email} (user ${existing.id}): ` +
            `Prisma committed the new role/scopes, the Supabase metadata write failed ` +
            `(${metaError.message}), and the compensating revert transaction also failed ` +
            `(${revertMessage}). The two stores are now permanently diverged until an admin ` +
            `fixes this row by hand.`,
          )
          results.push({
            email,
            status: 'inconsistent',
            error:
              `${email}'s account is now in an inconsistent state: this person's app access ` +
              `and sign-in access disagree, and the automatic recovery failed. An admin must ` +
              `intervene manually.`,
          })
        }
        continue
      }

      // Both stores have now committed: Prisma upsert + Supabase metadata.
      // The audit write is secondary to that — by this point the reactivation
      // has genuinely succeeded, so a failure here must not flip it to
      // 'failed' and must not be swallowed either. Log it loudly and surface
      // it as a non-fatal warning on the result so the caller can see the
      // audit trail is incomplete, without losing the real success.
      let auditWarning: string | undefined
      try {
        await recordAccessEvent(prisma, {
          actor, target: { id: existing.id, email, name },
          action: 'REACTIVATED', detail: { to: role },
        })
      } catch (auditError) {
        const auditMessage = auditError instanceof Error ? auditError.message : 'Unknown error'
        console.error(
          `[settings/users] REACTIVATED audit write failed for ${email} (user ${existing.id}) ` +
          `after both stores already committed the reactivation: ${auditMessage}`,
        )
        auditWarning = 'Reactivated, but the audit log entry failed to write.'
      }

      results.push({
        email, status: 'reactivated',
        ...(auditWarning ? { warning: auditWarning } : {}),
      })
    } catch (e) {
      results.push({
        email,
        status: 'failed',
        error: e instanceof Error ? e.message : 'Unexpected error while processing this invite',
      })
    }
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
