import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { Role, Prisma } from '@prisma/client'
import { assignableLevels } from '@/lib/roles'
import { recordAccessEvent } from '@/lib/access-audit'

export const dynamic = 'force-dynamic'

// PATCH — update clearance, name, and/or active status (ADMIN only)
// Body: { clearance?: Role, name?: string, isActive?: boolean }
//
// Both stores are written or neither is:
//   - Prisma User row        → read by requireSession() (API auth)
//   - Supabase user_metadata → read by middleware (page auth)
// A half-written pair is a half-locked-out account, so a failed Supabase write
// rolls the Prisma row back and returns 500.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  if (admin.id === params.id) {
    return NextResponse.json({ error: 'Cannot modify your own account' }, { status: 400 })
  }

  const target = await prisma.user.findUnique({ where: { id: params.id } })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  if (target.role === 'OWNER') {
    return NextResponse.json(
      { error: 'The owner cannot be changed. Transfer ownership first.' }, { status: 403 },
    )
  }

  const body = await req.json().catch(() => ({}))
  const { clearance, name, isActive } = body as {
    clearance?: string; name?: string; isActive?: boolean
  }

  const allowed = assignableLevels(admin.role)
  if (clearance && !allowed.includes(clearance as Role)) {
    return NextResponse.json(
      { error: `Clearance must be one of: ${allowed.join(', ')}` }, { status: 400 },
    )
  }

  const updateData: { role?: Role; name?: string | null; isActive?: boolean } = {}
  if (clearance) updateData.role = clearance as Role
  if (name !== undefined) updateData.name = name.trim() || null
  if (typeof isActive === 'boolean') updateData.isActive = isActive

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const previous = { role: target.role, name: target.name, isActive: target.isActive }

  // Defence-in-depth: assignableLevels() above already never returns OWNER,
  // so this can only fire from a future writer that skips that check. Map it
  // to a 409 rather than letting a raw P2002 on the partial unique index
  // (User_single_owner) escape as an unhandled 500.
  let user
  try {
    user = await prisma.user.update({ where: { id: params.id }, data: updateData })
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002' &&
      String(e.meta?.target ?? '').includes('User_single_owner')
    ) {
      return NextResponse.json({ error: 'There is already an owner.' }, { status: 409 })
    }
    throw e
  }

  // Sync the gating fields to Supabase. Only send keys that actually changed.
  const metadata: { role?: string; isActive?: boolean } = {}
  if (clearance) metadata.role = clearance
  if (typeof isActive === 'boolean') metadata.isActive = isActive
  if (Object.keys(metadata).length > 0) {
    const supabaseAdmin = createAdminClient()
    // updateUserById can fail two ways: it RETURNS { error }, or it THROWS
    // (network blip, Supabase 5xx). Both leave the same divergence — Prisma
    // already holds the new role/isActive, Supabase still has the old
    // metadata — so both must run the exact same compensation below. If a
    // throw were left to propagate uncaught, the revert would never run and
    // the two stores would silently diverge.
    let metaError: { message: string } | null = null
    try {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(params.id, {
        user_metadata: metadata,
      })
      metaError = error
    } catch (e) {
      metaError = { message: e instanceof Error ? e.message : 'Supabase metadata update threw' }
    }

    if (metaError) {
      // Roll the Prisma row back so the two stores stay identical.
      await prisma.user.update({ where: { id: params.id }, data: previous }).catch(() => null)
      return NextResponse.json(
        { error: `Could not update sign-in access — nothing was changed. ${metaError.message}` },
        { status: 500 },
      )
    }
  }

  const actor = { id: admin.id, email: admin.email, name: admin.name }
  const targetParty = { id: user.id, email: user.email, name: user.name }

  // Both stores have now committed. The audit write is secondary to that —
  // by this point the mutation has genuinely succeeded, so a failure here
  // must not flip it to an error response and must not be swallowed either.
  // Log it loudly and surface it as a non-fatal warning on the response.
  let auditWarning: string | undefined
  try {
    if (clearance && previous.role !== user.role) {
      await recordAccessEvent(prisma, {
        actor, target: targetParty, action: 'CLEARANCE_CHANGED',
        detail: { from: previous.role, to: user.role },
      })
    }
    if (typeof isActive === 'boolean' && previous.isActive !== user.isActive) {
      await recordAccessEvent(prisma, {
        actor, target: targetParty,
        action: user.isActive ? 'REACTIVATED' : 'DEACTIVATED',
      })
    }
  } catch (auditError) {
    const auditMessage = auditError instanceof Error ? auditError.message : 'Unknown error'
    console.error(
      `[settings/users/${params.id}] audit write failed after the mutation already ` +
      `committed to both stores: ${auditMessage}`,
    )
    auditWarning = 'Saved, but the audit log entry failed to write.'
  }

  return NextResponse.json({
    id: user.id, email: user.email, name: user.name, role: user.role, isActive: user.isActive,
    ...(auditWarning ? { warning: auditWarning } : {}),
  })
}

// DELETE — permanently remove a user (ADMIN only)
// Hard-deletes the Supabase Auth account AND the Prisma row. Chat history is
// preserved: ChatConversation.userId is onDelete: SetNull. This is irreversible —
// to merely revoke access, PATCH { isActive: false } instead.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  if (admin.id === params.id) {
    return NextResponse.json({ error: 'Cannot remove your own account' }, { status: 400 })
  }

  const target = await prisma.user.findUnique({ where: { id: params.id } })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (target.role === 'OWNER') {
    return NextResponse.json(
      { error: 'The owner cannot be removed. Transfer ownership first.' }, { status: 403 },
    )
  }

  // Delete the Supabase Auth account first so the email is freed for future
  // invites even if the Prisma delete is a no-op (row already gone).
  const supabaseAdmin = createAdminClient()
  const { error } = await supabaseAdmin.auth.admin.deleteUser(params.id)
  // "user not found" is fine — we still want the Prisma row gone.
  if (error && !/not found/i.test(error.message)) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  await prisma.user.delete({ where: { id: params.id } }).catch(() => null)

  // Same pending rule as GET /api/settings/users' `isPending` shaping: a row
  // created inactive at invite time and never activated (name still null) is
  // a still-pending invite, not an established colleague. Cancelling one of
  // those is a materially different action from deleting an accepted account
  // — keep the two rules in lockstep so the list and the audit log never
  // disagree about what counts as "pending".
  const wasPending = !target.isActive && target.name === null
  const action = wasPending ? 'INVITE_REVOKED' : 'REMOVED'

  // Written AFTER the delete: actorId survives, targetUserId is nulled by the
  // FK, and the denormalized email/name is what keeps the entry readable.
  // The delete has already genuinely succeeded, so a failure here must not
  // flip it into an error response — log it and surface a non-fatal warning.
  let auditWarning: string | undefined
  try {
    await recordAccessEvent(prisma, {
      actor: { id: admin.id, email: admin.email, name: admin.name },
      target: { id: null, email: target.email, name: target.name },
      action,
    })
  } catch (auditError) {
    const auditMessage = auditError instanceof Error ? auditError.message : 'Unknown error'
    console.error(
      `[settings/users/${params.id}] ${action} audit write failed after the delete already ` +
      `committed: ${auditMessage}`,
    )
    auditWarning = 'Removed, but the audit log entry failed to write.'
  }

  return NextResponse.json({ ok: true, ...(auditWarning ? { warning: auditWarning } : {}) })
}
