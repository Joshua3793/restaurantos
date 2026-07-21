import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { findAuthUserByEmail, hasAcceptedInvite } from '@/lib/users'
import { recordAccessEvent } from '@/lib/access-audit'

export const dynamic = 'force-dynamic'

// POST — re-send a pending invite. Rejects accounts that already accepted:
// those users have a password and should use "Forgot password" instead.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || new URL(req.url).origin
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const target = await prisma.user.findUnique({ where: { id: params.id } })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const supabaseAdmin = createAdminClient()
  const existing = await findAuthUserByEmail(supabaseAdmin, target.email)
  if (existing && hasAcceptedInvite(existing)) {
    return NextResponse.json(
      { error: 'This person already has an account. Ask them to use "Forgot password".' },
      { status: 400 },
    )
  }

  // A re-invite mints a new auth UUID, so move the Prisma row and its
  // assignments onto it inside one transaction.
  if (existing) await supabaseAdmin.auth.admin.deleteUser(existing.id)

  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(target.email, {
    data: { role: target.role, isActive: true, name: target.name },
    redirectTo: `${appUrl}/auth/callback`,
  })
  if (error || !data?.user) {
    // The stale auth user (if any) was already deleted above, so this person
    // now has NO auth account at all — a bare "failed to re-send" reads like
    // a harmless no-op when it is not: someone must retry, or they can never
    // sign in.
    return NextResponse.json(
      {
        error: error?.message
          ? `The previous invite was removed, and the new invite failed to send: ${error.message}. Retry the resend — this person currently has no sign-in account.`
          : 'The previous invite was removed, but the new invite failed to send. Retry the resend — this person currently has no sign-in account.',
      },
      { status: 400 },
    )
  }

  const newId = data.user.id
  const scopes = await prisma.userScope.findMany({
    where: { userId: target.id },
    select: { locationId: true, revenueCenterId: true, clearance: true },
  })
  // Under the pgBouncer transaction-mode pooler, two separate auto-commit
  // statements (delete old row, then insert new row keyed to the new UUID)
  // can interleave such that the delete isn't visible to the insert, causing
  // a P2002 unique violation on email. Delete + create + recreate scopes ride
  // inside one interactive transaction to avoid that.
  //
  // If this transaction throws, the new auth UUID above already exists and
  // has an invite sitting in it, but there is no Prisma row for it: the
  // person could set a password and pass middleware, then 403 on every API
  // call (requireSession reads Prisma), and a retry of this endpoint would
  // hit the "already has an account" branch above instead of repairing it.
  // Surface that explicitly rather than letting it fall through as a bare 500.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.deleteMany({ where: { email: target.email } })
      await tx.user.create({
        data: {
          id: newId, email: target.email, name: target.name,
          role: target.role, isActive: false,
        },
      })
      await tx.userScope.createMany({ data: scopes.map(s => ({ ...s, userId: newId })) })
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    console.error(
      `[settings/users/${params.id}/resend] Prisma re-key failed for ${target.email} after ` +
      `the Supabase invite already sent to auth user ${newId}: ${message}`,
    )
    return NextResponse.json(
      {
        error:
          `The invite email was sent, but this person's account record could not be updated ` +
          `(${message}). They may be able to sign in but nothing in the app will work for them ` +
          `yet. An admin should retry this resend, or fix the account manually before they log in.`,
      },
      { status: 500 },
    )
  }

  // Both stores have now committed: Supabase invite + Prisma re-key. The
  // audit write is secondary to that — by this point the re-invite has
  // genuinely succeeded, so a failure here must not flip it to an error
  // response and must not be swallowed either. Log it loudly and surface it
  // as a non-fatal warning on the response.
  let auditWarning: string | undefined
  try {
    await recordAccessEvent(prisma, {
      actor: { id: admin.id, email: admin.email, name: admin.name },
      target: { id: newId, email: target.email, name: target.name },
      action: 'REINVITED', detail: { to: target.role },
    })
  } catch (auditError) {
    const auditMessage = auditError instanceof Error ? auditError.message : 'Unknown error'
    console.error(
      `[settings/users/${params.id}/resend] REINVITED audit write failed after the re-invite ` +
      `already committed to both stores: ${auditMessage}`,
    )
    auditWarning = 'Invite re-sent, but the audit log entry failed to write.'
  }

  return NextResponse.json({ ok: true, ...(auditWarning ? { warning: auditWarning } : {}) })
}
