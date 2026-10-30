import 'server-only'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import type { NextRequest } from 'next/server'
import type { Role } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { createAdminClient } from '@/lib/supabase/admin'
import { findAuthUserByEmail, isAlreadyRegisteredError } from '@/lib/users'
import { atLeast } from '@/lib/roles'
import { pinEmail } from '@/lib/pin/rules'
import { PinError } from '@/lib/pin/errors'

export { PinError } from '@/lib/pin/errors'

export type CookieToSet = { name: string; value: string; options: CookieOptions }

export interface PinCook {
  id: string
  name: string
  lastName: string | null
  userId: string | null
}

const SWITCHED_OFF = 'This login is switched off'
const MANAGERS_USE_EMAIL = 'Managers sign in with email and password'
const NEEDS_A_MANAGER = 'This PIN account needs a manager to fix it'
const SIGN_IN_FAILED = 'Could not sign in — try again'

/** The exact columns every PIN-path read of a User takes. */
const PIN_USER_SELECT = { id: true, email: true, name: true, role: true, isActive: true } as const
type PinUserRow = { id: string; email: string; name: string | null; role: Role; isActive: boolean }

/** Thrown inside the link transaction when the cook was linked by someone else. */
class LinkLost extends Error {}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002'
}

/**
 * The gate every PIN sign-in passes: the login must be on, and must not be a
 * manager's (MANAGER and above sign in with email and password — RULING P3).
 */
function admit(user: PinUserRow): { userId: string; email: string } {
  if (!user.isActive) throw new PinError(403, SWITCHED_OFF)
  if (atLeast(user.role, 'MANAGER')) throw new PinError(403, MANAGERS_USE_EMAIL)
  return { userId: user.id, email: user.email }
}

/** The linked login for `userId`, through `admit`; null when there is no row. */
async function linkedUser(userId: string): Promise<{ userId: string; email: string } | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: PIN_USER_SELECT })
  if (!user) return null
  return admit(user)
}

/**
 * The early gate on the PIN screen, run before any phone is queued for
 * approval: a cook whose linked login is a manager's (RULING P3) or switched
 * off is refused with the same 403 `ensurePinUser` would give. A cook with no
 * login yet, or a link to a missing row, passes — `ensurePinUser` makes one.
 */
export async function assertPinLoginAllowed(cook: Pick<PinCook, 'userId'>): Promise<void> {
  if (!cook.userId) return
  await linkedUser(cook.userId)
}

/**
 * Returns the login a cook signs in as, creating a STAFF login on first use.
 *
 * A new login is written to BOTH stores (CLAUDE.md "Two-store sync invariant"):
 * Supabase Auth first (it mints the id), stamped `app_metadata.pinCookId` so a
 * later retry can prove this flow made it (users cannot write app_metadata,
 * but anyone with the anon key can sign up an email); then the Prisma User + the
 * cook link in one transaction. If that transaction fails, the auth user this
 * call created is deleted so the next try starts clean.
 */
export async function ensurePinUser(cook: PinCook): Promise<{ userId: string; email: string }> {
  if (cook.userId) {
    const linked = await linkedUser(cook.userId)
    if (linked) return linked
    console.warn(`[pin] cook ${cook.id} links to missing user ${cook.userId}; creating a fresh PIN login`)
  }

  const email = pinEmail(cook.id)
  const fullName = [cook.name, cook.lastName].map((s) => s?.trim()).filter(Boolean).join(' ')
  const admin = createAdminClient()
  const createAuthUser = () =>
    admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { role: 'STAFF', isActive: true, name: fullName },
      app_metadata: { pinCookId: cook.id },
    })

  // Supabase first. `createdId` is set only when THIS call made the auth user —
  // only that one is ours to delete on rollback. `adopted` = an earlier run of
  // this flow made it (stamped); its user_metadata is re-synced after linking.
  let authId: string
  let createdId: string | null = null
  let adopted = false

  const first = await createAuthUser()
  if (first.data?.user && !first.error) {
    authId = createdId = first.data.user.id
  } else if (isAlreadyRegisteredError(first.error)) {
    const existing = await findAuthUserByEmail(admin, email)
    if (!existing) throw new Error(`[pin] auth user for cook ${cook.id} is registered but not found`)

    if (existing.app_metadata?.pinCookId === cook.id) {
      // (a) Made by this flow on an earlier, half-failed run: adopt it.
      authId = existing.id
      adopted = true
    } else {
      const prismaRow = await prisma.user.findUnique({ where: { id: existing.id }, select: { id: true } })
      if (!existing.email_confirmed_at && !prismaRow) {
        // (b) Unconfirmed, unknown to the app, not stamped: planted by a public
        // signUp. Remove it and create the real one.
        console.warn(`[pin] deleting unstamped unconfirmed auth user ${existing.id} holding the PIN email of cook ${cook.id}`)
        const { error: delError } = await admin.auth.admin.deleteUser(existing.id)
        if (delError) throw new Error(`[pin] could not remove auth user ${existing.id}: ${delError.message}`)
        const retry = await createAuthUser()
        if (!retry.data?.user || retry.error) {
          throw new Error(`[pin] could not create a login for cook ${cook.id}: ${retry.error?.message ?? 'no user returned'}`)
        }
        authId = createdId = retry.data.user.id
      } else {
        // (c) Confirmed or known to the app, but not ours: never sign into it.
        throw new PinError(409, NEEDS_A_MANAGER)
      }
    }
  } else {
    throw new Error(`[pin] could not create a login for cook ${cook.id}: ${first.error?.message ?? 'no user returned'}`)
  }

  let user: PinUserRow
  try {
    user = await prisma.$transaction(async (tx) => {
      // Upsert by id so a retry after a half-failure works. An existing row
      // keeps its role and active flag (`update: {}`) — a PIN sign-in never
      // re-enables or re-roles a login someone else changed.
      const row = await tx.user.upsert({
        where: { id: authId },
        create: { id: authId, email, name: fullName, role: 'STAFF', isActive: true },
        update: {},
        select: PIN_USER_SELECT,
      })
      admit(row)
      // Compare-and-set on the link we read: never overwrite someone else's.
      const { count } = await tx.cook.updateMany({
        where: { id: cook.id, userId: cook.userId },
        data: { userId: authId },
      })
      if (count === 0) throw new LinkLost()
      return row
    })
  } catch (e) {
    if (e instanceof LinkLost || isUniqueViolation(e)) {
      // Another sign-in (or an admin) linked this cook meanwhile.
      const now = await prisma.cook.findUnique({ where: { id: cook.id }, select: { userId: true } })
      if (now?.userId) {
        // Never delete the auth user the winner linked the cook to.
        if (createdId && createdId !== now.userId) await rollbackAuthUser(admin, createdId)
        const winner = await linkedUser(now.userId)
        if (winner) return winner
        throw new PinError(409, NEEDS_A_MANAGER)
      }
    }
    if (createdId) await rollbackAuthUser(admin, createdId)
    throw e
  }

  if (adopted) {
    // Middleware reads user_metadata; make it say what the APIs read.
    const { error: syncError } = await admin.auth.admin.updateUserById(authId, {
      user_metadata: { role: user.role, isActive: user.isActive, name: user.name },
    })
    if (syncError) {
      // Undo the link so the next try re-runs this adopt + sync.
      await prisma.cook
        .updateMany({ where: { id: cook.id, userId: authId }, data: { userId: cook.userId } })
        .catch(() => console.error(`[pin] could not unlink cook ${cook.id} after a failed metadata sync`))
      throw new Error(`[pin] could not sync login metadata for user ${authId}: ${syncError.message}`)
    }
  }

  return admit(user)
}

async function rollbackAuthUser(admin: ReturnType<typeof createAdminClient>, id: string) {
  try {
    const { error } = await admin.auth.admin.deleteUser(id)
    if (error) console.error(`[pin] rollback: could not delete auth user ${id}: ${error.message}`)
  } catch (e) {
    console.error(`[pin] rollback: could not delete auth user ${id}: ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * Mints a normal Supabase session for `email` and returns the session cookies
 * for the caller to set on its response. Same verifyOtp + cookie buffering as
 * /auth/callback, so middleware and requireSession treat it like any sign-in.
 * Never logs the link, its token or the hashed token.
 */
export async function mintSession(req: NextRequest, email: string): Promise<CookieToSet[]> {
  const pending: CookieToSet[] = []
  try {
    const { data, error } = await createAdminClient().auth.admin.generateLink({
      type: 'magiclink',
      email,
    })
    const tokenHash = data?.properties?.hashed_token
    if (error || !tokenHash) {
      console.error(`[pin] generateLink failed${error?.status ? ` (${error.status})` : ''}`)
      throw new PinError(401, SIGN_IN_FAILED)
    }

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => req.cookies.getAll(),
          setAll: (cookiesToSet) => { pending.push(...cookiesToSet) },
        },
      },
    )
    const { error: verifyError } = await supabase.auth.verifyOtp({
      type: 'magiclink',
      token_hash: tokenHash,
    })
    if (verifyError) {
      console.error(`[pin] verifyOtp failed${verifyError.status ? ` (${verifyError.status})` : ''}`)
      throw new PinError(401, SIGN_IN_FAILED)
    }
  } catch (e) {
    if (e instanceof PinError) throw e
    console.error('[pin] session mint threw')
    throw new PinError(401, SIGN_IN_FAILED)
  }
  return pending
}
