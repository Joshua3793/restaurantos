import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * The crew member the caller's login is linked to (Cook.userId — set by a
 * manager on the tip roster, never guessed from a name or email). The cook's
 * start page uses it to show "my jobs". `{ cook: null }` is normal: most of the
 * crew share the kitchen iPad login, which then shows every posted job.
 */
export async function GET() {
  try {
    const user = await requireSession()
    const cook = await prisma.cook.findUnique({
      where: { userId: user.id },
      select: { id: true, name: true, initials: true, homeStation: true, isActive: true },
    })
    return NextResponse.json(
      { cook: cook?.isActive ? { id: cook.id, name: cook.name, initials: cook.initials, homeStation: cook.homeStation } : null },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/prep/me', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
