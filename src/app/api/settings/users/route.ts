import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { findAuthUserByEmail, hasAcceptedInvite, isAlreadyRegisteredError } from '@/lib/users'
import { Role } from '@prisma/client'

const VALID_ROLES: Role[] = ['ADMIN', 'MANAGER', 'STAFF']

// GET — list all users (ADMIN only)
export async function GET() {
  try { await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
  })
  return NextResponse.json(users)
}

// POST — invite a new user (ADMIN only)
// Body: { email: string, role: 'ADMIN' | 'MANAGER' | 'STAFF', name?: string }
//
// Idempotent: if the email already has a Supabase Auth account, this does NOT
// fail. Instead it reconciles that account to the requested role and re-grants
// access — covering the "I deleted/deactivated this person and want them back"
// case. Two sub-cases:
//   - Pending (never accepted their original invite): the stale Auth user is
//     removed and a fresh invite email is sent.
//   - Accepted before (has a password): the account is reactivated in place with
//     the new role; no email is sent — they keep their existing credentials.
export async function POST(req: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || new URL(req.url).origin
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => ({}))
  const { email: rawEmail, role, name: rawName } = body as { email?: string; role?: string; name?: string }

  const email = rawEmail?.trim().toLowerCase()
  const name = rawName?.trim() || null

  if (!email) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 })
  }
  if (!role || !VALID_ROLES.includes(role as Role)) {
    return NextResponse.json({ error: 'role must be ADMIN, MANAGER, or STAFF' }, { status: 400 })
  }
  if (admin.email.toLowerCase() === email) {
    return NextResponse.json({ error: 'Cannot invite yourself' }, { status: 400 })
  }

  const supabaseAdmin = createAdminClient()
  const inviteMeta = { role, isActive: true, name }

  // Helper: send a fresh invite + create the matching (inactive) Prisma row.
  const sendInvite = async () => {
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: inviteMeta,
      redirectTo: `${appUrl}/auth/callback`,
    })
    if (error || !data?.user) return { error }
    const newId = data.user.id
    // A re-invite mints a NEW auth UUID while the email is unchanged, so any stale
    // Prisma row (old UUID, same unique email) must be cleared before inserting the
    // row keyed to the new UUID. Do BOTH in one interactive transaction: under the
    // pgBouncer transaction-mode pooler two separate auto-commit statements can land
    // such that the delete isn't visible to the insert, yielding a P2002 on email.
    const user = await prisma.$transaction(async (tx) => {
      await tx.user.deleteMany({ where: { email } })
      return tx.user.create({
        data: { id: newId, email, name, role: role as Role, isActive: false },
      })
    })
    return { user }
  }

  // First attempt: a normal invite for a brand-new email.
  const first = await sendInvite()
  if (first.user) {
    return NextResponse.json({ ...first.user, status: 'invited' }, { status: 201 })
  }
  if (!isAlreadyRegisteredError(first.error)) {
    return NextResponse.json({ error: first.error?.message ?? 'Failed to send invite' }, { status: 400 })
  }

  // Email already exists in Supabase Auth — reconcile instead of failing.
  const existing = await findAuthUserByEmail(supabaseAdmin, email)
  if (!existing) {
    // Registered but unresolvable — surface a clear message rather than a raw error.
    return NextResponse.json(
      { error: 'This email already has an account that could not be resolved. Contact support.' },
      { status: 409 },
    )
  }

  if (!hasAcceptedInvite(existing)) {
    // Stale pending invite → delete the unaccepted Auth user and invite fresh.
    await supabaseAdmin.auth.admin.deleteUser(existing.id)
    const retry = await sendInvite()
    if (retry.user) {
      return NextResponse.json({ ...retry.user, status: 'reinvited' }, { status: 201 })
    }
    return NextResponse.json({ error: retry.error?.message ?? 'Failed to re-invite user' }, { status: 400 })
  }

  // Accepted before → reactivate in place with the new role. Keep both stores in
  // sync: metadata (middleware) AND the Prisma row (requireSession).
  const { error: metaError } = await supabaseAdmin.auth.admin.updateUserById(existing.id, {
    user_metadata: { role, isActive: true, name },
  })
  if (metaError) {
    return NextResponse.json({ error: metaError.message }, { status: 400 })
  }
  const user = await prisma.user.upsert({
    where: { id: existing.id },
    create: { id: existing.id, email, name, role: role as Role, isActive: true },
    update: { role: role as Role, name, isActive: true },
  })
  return NextResponse.json({ ...user, status: 'reactivated' }, { status: 200 })
}
