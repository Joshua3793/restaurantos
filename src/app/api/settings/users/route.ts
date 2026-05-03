import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
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
export async function POST(req: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || new URL(req.url).origin
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => ({}))
  const { email, role, name } = body as { email?: string; role?: string; name?: string }

  if (!email?.trim()) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 })
  }
  if (!role || !VALID_ROLES.includes(role as Role)) {
    return NextResponse.json({ error: 'role must be ADMIN, MANAGER, or STAFF' }, { status: 400 })
  }
  if (admin.email === email.trim().toLowerCase()) {
    return NextResponse.json({ error: 'Cannot invite yourself' }, { status: 400 })
  }

  const supabaseAdmin = createAdminClient()

  // Send invite via Supabase — creates Auth user + sends email
  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email.trim(), {
    data: { role, isActive: true, name: name?.trim() ?? null },
    redirectTo: `${appUrl}/auth/callback`,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  // Create the Prisma User row using the Supabase Auth UUID
  const user = await prisma.user.upsert({
    where: { id: data.user.id },
    create: {
      id: data.user.id,
      email: email.trim().toLowerCase(),
      name: name?.trim() ?? null,
      role: role as Role,
      isActive: false, // activated when they accept the invite
    },
    update: {
      role: role as Role,
      name: name?.trim() ?? null,
      isActive: false,
    },
  })

  return NextResponse.json(user, { status: 201 })
}
