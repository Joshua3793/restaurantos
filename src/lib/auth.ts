import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { prisma } from '@/lib/prisma'
import { Role, User } from '@prisma/client'
import { ROLE_RANK } from '@/lib/roles'

export class AuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * LOCAL-DEV ONLY auth bypass. Active only when BOTH:
 *   - NODE_ENV !== 'production'  (never true on a deployed Vercel build), and
 *   - DEV_AUTH_BYPASS === 'true' (opt-in via local .env)
 * When active and there is no real Supabase session, the app behaves as the
 * first ADMIN user so it can be used without logging in. This can never run in
 * production because the NODE_ENV gate fails there.
 */
const DEV_AUTH_BYPASS =
  process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH_BYPASS === 'true'

async function devBypassUser(): Promise<User | null> {
  return (
    (await prisma.user.findFirst({ where: { role: 'OWNER', isActive: true } })) ??
    (await prisma.user.findFirst({ where: { role: 'ADMIN', isActive: true } })) ??
    (await prisma.user.findFirst({ where: { isActive: true } }))
  )
}

/**
 * Verifies the current request has a valid Supabase session and returns
 * the corresponding Prisma User.
 *
 * Throws AuthError(401) if no session.
 * Throws AuthError(403) if user is inactive or below minRole.
 *
 * Usage in a Route Handler:
 *   import { requireSession, AuthError } from '@/lib/auth'
 *
 *   export async function POST(req: NextRequest) {
 *     let user: User
 *     try { user = await requireSession('MANAGER') }
 *     catch (e) {
 *       if (e instanceof AuthError)
 *         return NextResponse.json({ error: e.message }, { status: e.status })
 *       throw e
 *     }
 *     // ... handler logic
 *   }
 */
export async function requireSession(minRole?: Role): Promise<User> {
  const supabase = createClient()

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()

  // Local-dev bypass: no real session → fall back to the first ADMIN user.
  if (!authUser && DEV_AUTH_BYPASS) {
    const devUser = await devBypassUser()
    if (devUser) return devUser
  }

  if (!authUser) {
    throw new AuthError(401, 'Unauthorized')
  }

  const user = await prisma.user.findUnique({ where: { id: authUser.id } })

  if (!user || !user.isActive) {
    throw new AuthError(403, 'Account is inactive or not found')
  }

  if (minRole !== undefined && ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
    throw new AuthError(403, 'Insufficient permissions')
  }

  return user
}
