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
    return NextResponse.json({ error: error?.message ?? 'Failed to re-send invite' }, { status: 400 })
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
