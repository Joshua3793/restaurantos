import 'server-only'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { createAdminClient } from '@/lib/supabase/admin'
import { findAuthUserByEmail, isAlreadyRegisteredError } from '@/lib/users'
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
const SIGN_IN_FAILED = 'Could not sign in — try again'

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002'
}

/**
 * The linked login for `userId`: active → returned; inactive → 403; no row → null.
 */
async function linkedUser(userId: string): Promise<{ userId: string; email: string } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, isActive: true },
  })
  if (!user) return null
  if (!user.isActive) throw new PinError(403, SWITCHED_OFF)
  return { userId: user.id, email: user.email }
}

/**
 * Returns the login a cook signs in as, creating a STAFF login on first use.
 *
 * A new login is written to BOTH stores (CLAUDE.md "Two-store sync invariant"):
 * Supabase Auth first (it mints the id), then the Prisma User + the cook link in
 * one transaction. If that transaction fails, the auth user we just created is
 * deleted so the next try starts clean.
 */
export async function ensurePinUser(cook: PinCook): Promise<{ userId: string; email: string }> {
  if (cook.userId) {
    const linked = await linkedUser(cook.userId)
    if (linked) return linked
    console.warn(`[pin] cook ${cook.id} links to a missing user; creating a fresh PIN login`)
  }

  const email = pinEmail(cook.id)
  const fullName = [cook.name, cook.lastName].map((s) => s?.trim()).filter(Boolean).join(' ')
  const admin = createAdminClient()

  // Supabase first. `createdId` is set only when THIS call made the auth user —
  // only that one is ours to delete on rollback.
  let authId: string
  let createdId: string | null = null
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { role: 'STAFF', isActive: true, name: fullName },
  })
  if (data?.user && !error) {
    authId = data.user.id
    createdId = authId
  } else if (isAlreadyRegisteredError(error)) {
    // A retry after a half-failure, or a concurrent first sign-in: reuse it.
    const existing = await findAuthUserByEmail(admin, email)
    if (!existing) throw new Error(`[pin] auth user for cook ${cook.id} is registered but not found`)
    authId = existing.id
  } else {
    throw new Error(`[pin] could not create a login for cook ${cook.id}: ${error?.message ?? 'no user returned'}`)
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Upsert by id so a retry after a half-failure works. An existing row
      // keeps its role and active flag — a PIN sign-in never re-enables or
      // re-roles a login someone else changed.
      const user = await tx.user.upsert({
        where: { id: authId },
        create: { id: authId, email, name: fullName, role: 'STAFF', isActive: true },
        update: {},
        select: { isActive: true },
      })
      if (!user.isActive) throw new PinError(403, SWITCHED_OFF)
      await tx.cook.update({ where: { id: cook.id }, data: { userId: authId } })
    })
  } catch (e) {
    if (isUniqueViolation(e)) {
      // Two first sign-ins at once: the other one may have linked the cook.
      const now = await prisma.cook.findUnique({ where: { id: cook.id }, select: { userId: true } })
      if (now?.userId) {
        // Never delete the auth user the winner linked the cook to.
        if (createdId === now.userId) createdId = null
        if (createdId) {
          await rollbackAuthUser(admin, createdId)
          createdId = null
        }
        const linked = await linkedUser(now.userId)
        if (linked) return linked
      }
    }
    if (createdId) await rollbackAuthUser(admin, createdId)
    throw e
  }

  return { userId: authId, email }
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
