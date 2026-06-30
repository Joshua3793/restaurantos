import 'server-only'
import type { SupabaseClient, User as AuthUser } from '@supabase/supabase-js'

/**
 * The Users system spans two stores that must stay in sync:
 *   - Supabase Auth  — the real account; `user_metadata.{role,isActive}` is what
 *     `src/middleware.ts` reads to gate every page request.
 *   - Prisma `User`  — `id` = the Supabase UUID; `requireSession()` reads its
 *     `{role,isActive}` to gate API routes.
 *
 * Helpers here keep the Supabase side resolvable by email and let the routes
 * write both stores together. Never let the two diverge: a user who is active in
 * one store and inactive in the other is a half-locked-out account.
 */

/** True when an invite failed only because the email already has an Auth account. */
export function isAlreadyRegisteredError(error: {
  code?: string
  status?: number
  message?: string
} | null): boolean {
  if (!error) return false
  return (
    error.code === 'email_exists' ||
    error.status === 422 ||
    /already.*(registered|exists)|email.*exists/i.test(error.message ?? '')
  )
}

/**
 * Find a Supabase Auth user by email. supabase-js v2 has no getUserByEmail, so
 * we page through admin.listUsers (case-insensitive match). Returns null if none.
 */
export async function findAuthUserByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<AuthUser | null> {
  const target = email.trim().toLowerCase()
  const perPage = 1000
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) throw error
    const match = data.users.find((u) => u.email?.toLowerCase() === target)
    if (match) return match
    if (data.users.length < perPage) break // last page reached
  }
  return null
}

/**
 * Whether an Auth user has ever completed sign-up (accepted their invite and set
 * a password). A pending invite has neither a confirmed email nor a sign-in.
 */
export function hasAcceptedInvite(user: AuthUser): boolean {
  return Boolean(user.email_confirmed_at || user.last_sign_in_at)
}
