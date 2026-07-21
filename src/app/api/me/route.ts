import { NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { effectiveAccess } from '@/lib/access'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await requireSession()
    // Returned so client gating reads the SAME resolution the server does
    // rather than re-deriving it from role alone.
    const access = await effectiveAccess(user)
    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      effectiveAccess: access,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
