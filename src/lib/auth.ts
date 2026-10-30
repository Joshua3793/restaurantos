import 'server-only'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { prisma } from '@/lib/prisma'
import { Role, User } from '@prisma/client'
import { ROLE_RANK, atLeast } from '@/lib/roles'
import { PIN_DEVICE_COOKIE, isDeviceToken } from '@/lib/pin/http'
import { hashToken } from '@/lib/pin/rules'

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
 * first OWNER user, or falls back to the first ADMIN user if no OWNER exists,
 * so it can be used without logging in. This can never run in production
 * because the NODE_ENV gate fails there.
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

const PIN_PHONE_NEEDED = 'Sign in again with your PIN on an OK’d phone'

/**
 * RULING P9 (a): a PIN account (auth `app_metadata.pinCookId`, which only the
 * service role can write) is only good on a phone a manager OK'd for that
 * cook. Without this, a PIN session could set itself a password and sign in
 * anywhere. One indexed lookup on the (tokenHash, cookId) unique key; Remove
 * phone (REVOKED) therefore takes effect on the very next request.
 */
async function assertApprovedPinPhone(pinCookId: unknown): Promise<void> {
  if (typeof pinCookId !== 'string' || !pinCookId) throw new AuthError(401, PIN_PHONE_NEEDED)
  const token = cookies().get(PIN_DEVICE_COOKIE)?.value
  if (!isDeviceToken(token)) throw new AuthError(401, PIN_PHONE_NEEDED)
  const device = await prisma.pinDevice.findUnique({
    where: { tokenHash_cookId: { tokenHash: hashToken(token), cookId: pinCookId } },
    select: { status: true },
  })
  if (device?.status !== 'APPROVED') throw new AuthError(401, PIN_PHONE_NEEDED)
}

/**
 * Verifies the current request has a valid Supabase session and returns
 * the corresponding Prisma User.
 *
 * Throws AuthError(401) if no session.
 * Throws AuthError(403) if user is inactive or below minRole.
 *
 * PIN accounts (RULING P9): the request must carry the `pin_device` cookie
 * of a phone APPROVED for that cook (else 401), and the returned user's role
 * is capped at LEAD — a PIN is printed on clock reports, so it never opens a
 * manager-level session even if the login was promoted. Nothing is written.
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

  // Local-dev bypass: no real session → try OWNER, then ADMIN, then any active user.
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

  let effective: User = user
  const pinCookId: unknown = authUser.app_metadata?.pinCookId
  if (pinCookId !== undefined && pinCookId !== null) {
    await assertApprovedPinPhone(pinCookId)
    if (atLeast(user.role, 'MANAGER')) effective = { ...user, role: 'LEAD' }
  }

  if (minRole !== undefined && ROLE_RANK[effective.role] < ROLE_RANK[minRole]) {
    throw new AuthError(403, 'Insufficient permissions')
  }

  return effective
}
