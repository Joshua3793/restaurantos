import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { prisma } from '@/lib/prisma'
import { Role, User } from '@prisma/client'

export class AuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

// Role strength: ADMIN > MANAGER > STAFF
const ROLE_RANK: Record<Role, number> = {
  STAFF: 0,
  MANAGER: 1,
  ADMIN: 2,
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
