import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { Role } from '@prisma/client'

const VALID_ROLES: Role[] = ['ADMIN', 'MANAGER', 'STAFF']

// PATCH — update role, name, and/or active status (ADMIN only)
// Body: { role?: Role, name?: string, isActive?: boolean }
//
// Every change is written to BOTH stores so they never diverge:
//   - Prisma User row  → read by requireSession() (API auth)
//   - Supabase user_metadata → read by middleware (page auth)
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

  const body = await req.json().catch(() => ({}))
  const { role, name, isActive } = body as { role?: string; name?: string; isActive?: boolean }

  if (role && !VALID_ROLES.includes(role as Role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
  }

  const updateData: { role?: Role; name?: string | null; isActive?: boolean } = {}
  if (role) updateData.role = role as Role
  if (name !== undefined) updateData.name = name.trim() || null
  if (typeof isActive === 'boolean') updateData.isActive = isActive

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const user = await prisma.user.update({
    where: { id: params.id },
    data: updateData,
  }).catch(() => null)

  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Sync the gating fields to Supabase user_metadata so middleware picks them up
  // on the user's next request. Only send keys that changed.
  const metadata: { role?: string; isActive?: boolean } = {}
  if (role) metadata.role = role
  if (typeof isActive === 'boolean') metadata.isActive = isActive
  if (Object.keys(metadata).length > 0) {
    const supabaseAdmin = createAdminClient()
    const { error } = await supabaseAdmin.auth.admin.updateUserById(params.id, {
      user_metadata: metadata,
    })
    if (error) {
      return NextResponse.json({ error: `Saved, but failed to sync auth: ${error.message}` }, { status: 502 })
    }
  }

  return NextResponse.json({
    id: user.id, email: user.email, name: user.name, role: user.role, isActive: user.isActive,
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

  // Delete the Supabase Auth account first so the email is freed for future
  // invites even if the Prisma delete is a no-op (row already gone).
  const supabaseAdmin = createAdminClient()
  const { error } = await supabaseAdmin.auth.admin.deleteUser(params.id)
  // "user not found" is fine — we still want the Prisma row gone.
  if (error && !/not found/i.test(error.message)) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  await prisma.user.delete({ where: { id: params.id } }).catch(() => null)

  return NextResponse.json({ ok: true })
}
