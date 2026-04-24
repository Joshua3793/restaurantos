import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { Role } from '@prisma/client'

const VALID_ROLES: Role[] = ['ADMIN', 'MANAGER', 'STAFF']

// PATCH — update role or name (ADMIN only)
// Body: { role?: Role, name?: string }
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
  const { role, name } = body as { role?: string; name?: string }

  if (role && !VALID_ROLES.includes(role as Role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
  }

  const updateData: { role?: Role; name?: string | null } = {}
  if (role) updateData.role = role as Role
  if (name !== undefined) updateData.name = name.trim() || null

  const user = await prisma.user.update({
    where: { id: params.id },
    data: updateData,
  }).catch(() => null)

  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Sync role to Supabase user_metadata so middleware picks it up immediately
  if (role) {
    const supabaseAdmin = createAdminClient()
    await supabaseAdmin.auth.admin.updateUserById(params.id, {
      user_metadata: { role },
    })
  }

  return NextResponse.json({ id: user.id, email: user.email, name: user.name, role: user.role })
}

// DELETE — deactivate a user (ADMIN only)
// Sets isActive: false in Prisma and user_metadata.isActive: false in Supabase.
// Middleware will redirect them to /login on their next request.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  if (admin.id === params.id) {
    return NextResponse.json({ error: 'Cannot deactivate your own account' }, { status: 400 })
  }

  await prisma.user.update({
    where: { id: params.id },
    data: { isActive: false },
  }).catch(() => null)

  // Mark isActive: false in Supabase user_metadata — middleware checks this on every request
  const supabaseAdmin = createAdminClient()
  await supabaseAdmin.auth.admin.updateUserById(params.id, {
    user_metadata: { isActive: false },
  })

  return NextResponse.json({ ok: true })
}
