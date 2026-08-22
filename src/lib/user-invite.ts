// The invite/re-invite/reactivate flow for ONE email, extracted verbatim from
// POST /api/settings/users so the People hub's create endpoint can reuse it
// rather than growing a second copy. Behaviour is unchanged.
import 'server-only'
import type { Role } from '@prisma/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { prisma } from '@/lib/prisma'
import { recordAccessEvent } from '@/lib/access-audit'
import { findAuthUserByEmail, hasAcceptedInvite, isAlreadyRegisteredError } from '@/lib/users'

export interface InviteOptions {
  email: string
  role: Role
  name: string | null
  /** Already validated and deduped by the caller. */
  assignments: Array<{ locationId: string | null; revenueCenterId: string | null; clearance: Role | null }>
  actor: { id: string; email: string; name: string | null }
  appUrl: string
  supabaseAdmin: SupabaseClient
}

export interface InviteResult {
  email: string
  status: 'invited' | 'reinvited' | 'reactivated' | 'failed' | 'inconsistent'
  /** The auth user id, present on every non-failure. The hub needs it to link a Cook. */
  userId?: string
  error?: string
  warning?: string
}

export async function inviteOne(opts: InviteOptions): Promise<InviteResult> {
  const { email, role, name, assignments, actor, appUrl, supabaseAdmin } = opts

  // Isolate this email's work: a thrown error (transaction failure against the
  // pooler, an audit write failure, …) must be reported as this email's own
  // outcome, never abort a caller's wider loop.
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
      // audit write rides the same tx.
      const user = await prisma.$transaction(async (tx) => {
        await tx.user.deleteMany({ where: { email } })
        const created = await tx.user.create({
          data: { id: newId, email, name, role, isActive: false },
        })
        await tx.userScope.createMany({ data: assignments.map(a => ({ ...a, userId: newId })) })
        await recordAccessEvent(tx, {
          actor, target: { id: created.id, email, name }, action, detail: { to: role },
        })
        return created
      })
      return { user }
    }

    const first = await sendInvite('INVITED')
    if (first.user) return { email, status: 'invited', userId: first.user.id }
    if (!isAlreadyRegisteredError(first.error)) {
      return { email, status: 'failed', error: first.error?.message ?? 'Failed to send invite' }
    }

    const existing = await findAuthUserByEmail(supabaseAdmin, email)
    if (!existing) {
      return { email, status: 'failed', error: 'Email already has an unresolvable account.' }
    }

    // The owner's Prisma row is the single-occupancy seat (User_single_owner
    // partial unique index). The reactivate branch below would otherwise
    // overwrite its role and replace its UserScope rows — and since
    // assignableLevels() never returns OWNER, there is no in-app way back.
    // Reject before either branch writes anything.
    const existingPrismaUser = await prisma.user.findUnique({
      where: { id: existing.id }, select: { role: true },
    })
    if (existingPrismaUser?.role === 'OWNER') {
      return { email, status: 'failed', error: 'The owner cannot be changed. Transfer ownership first.' }
    }

    if (!hasAcceptedInvite(existing)) {
      await supabaseAdmin.auth.admin.deleteUser(existing.id)
      const retry = await sendInvite('REINVITED')
      if (retry.user) return { email, status: 'reinvited', userId: retry.user.id }
      return { email, status: 'failed', error: retry.error?.message ?? 'Failed to re-invite' }
    }

    // Accepted before → reactivate in place. Both stores, or neither.
    //
    // Prisma is authoritative for API access (requireSession reads it), so it's
    // written FIRST; Supabase user_metadata (what middleware reads for page
    // access) is written second. If Supabase then fails, we revert the Prisma
    // row + scopes rather than leave requireSession authorizing the new role
    // while middleware still gates on the old one.
    const priorUser = await prisma.user.findUnique({
      where: { id: existing.id }, select: { name: true, role: true, isActive: true },
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
      await tx.userScope.createMany({ data: assignments.map(a => ({ ...a, userId: existing.id })) })
      return u
    })

    // updateUserById can fail two ways: it RETURNS { error }, or it THROWS
    // (network blip, Supabase 5xx). Both leave the same divergence — Prisma
    // already holds the new role/scopes, Supabase still has the old metadata —
    // so both must run the exact same compensation below. If a throw were left
    // to propagate to the outer catch instead, the revert would never run:
    // Prisma would stay committed to the new state, and the caller would just
    // be told 'failed', hiding a real, uncompensated divergence between the
    // two stores.
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
      // intermittent write-failure source (see CLAUDE.md). If IT throws, Prisma
      // is left holding the new role/scopes while Supabase still has the old
      // metadata, and nothing here will retry it — that's a strictly worse,
      // silently-diverged outcome than "invite failed," so it must be reported
      // as its own loud, distinct result rather than falling into the generic
      // 'failed' message below or the outer catch's generic text.
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
            await tx.userScope.createMany({ data: priorScopes.map(s => ({ ...s, userId: existing.id })) })
          }
        })
        return { email, status: 'failed', error: metaError.message }
      } catch (revertError) {
        const revertMessage = revertError instanceof Error ? revertError.message : 'Unknown error'
        console.error(
          `[user-invite] reactivate revert failed for ${email} (user ${existing.id}): ` +
          `Prisma committed the new role/scopes, the Supabase metadata write failed ` +
          `(${metaError.message}), and the compensating revert transaction also failed ` +
          `(${revertMessage}). The two stores are now permanently diverged until an admin ` +
          `fixes this row by hand.`,
        )
        return {
          email,
          status: 'inconsistent',
          error:
            `${email}'s account is now in an inconsistent state: this person's app access ` +
            `and sign-in access disagree, and the automatic recovery failed. An admin must ` +
            `intervene manually.`,
        }
      }
    }

    // Both stores have now committed: Prisma upsert + Supabase metadata. The
    // audit write is secondary to that — by this point the reactivation has
    // genuinely succeeded, so a failure here must not flip it to 'failed' and
    // must not be swallowed either. Log it loudly and surface it as a non-fatal
    // warning on the result so the caller can see the audit trail is
    // incomplete, without losing the real success.
    let auditWarning: string | undefined
    try {
      await recordAccessEvent(prisma, {
        actor, target: { id: existing.id, email, name },
        action: 'REACTIVATED', detail: { to: role },
      })
    } catch (auditError) {
      const auditMessage = auditError instanceof Error ? auditError.message : 'Unknown error'
      console.error(
        `[user-invite] REACTIVATED audit write failed for ${email} (user ${existing.id}) ` +
        `after both stores already committed the reactivation: ${auditMessage}`,
      )
      auditWarning = 'Reactivated, but the audit log entry failed to write.'
    }

    return { email, status: 'reactivated', userId: existing.id, ...(auditWarning ? { warning: auditWarning } : {}) }
  } catch (e) {
    return {
      email,
      status: 'failed',
      error: e instanceof Error ? e.message : 'Unexpected error while processing this invite',
    }
  }
}
