// The page gate's view of a Supabase Auth user. Pure and dependency-light on
// purpose: src/middleware.ts runs in a restricted runtime and imports this.
//
// The gate reads `app_metadata.{role,isActive}` — NEVER `user_metadata`. Any
// signed-in user can rewrite their own user_metadata from the browser
// (`supabase.auth.updateUser({ data: { role: 'OWNER' } })`); app_metadata is
// writable only with the service role. Every writer of a user's role or
// active flag writes `accessAppMetadata(...)` to app_metadata in the same
// step it writes the Prisma User row (CLAUDE.md "Two-store sync invariant").
import type { Role } from '@prisma/client'
import { ROLE_RANK, atLeast } from '@/lib/roles'

export interface PageAccess {
  /** False unless app_metadata.isActive is exactly `true`. */
  active: boolean
  /** app_metadata.role; unknown or missing → STAFF; a PIN login caps at LEAD. */
  role: Role
}

type AuthLike = { app_metadata?: Record<string, unknown> | null } | null | undefined

function isRole(v: unknown): v is Role {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ROLE_RANK, v)
}

/**
 * What the page gate lets this auth user do. A missing isActive is blocked
 * (`!== true`, not `=== false`), and an unknown role falls back to STAFF.
 * A PIN login (`app_metadata.pinCookId`) is capped at LEAD, the same cap
 * requireSession applies to its API calls.
 */
export function pageAccess(user: AuthLike): PageAccess {
  const meta = user?.app_metadata ?? {}
  let role: Role = isRole(meta.role) ? meta.role : 'STAFF'
  const pinCookId = meta.pinCookId
  if (pinCookId !== undefined && pinCookId !== null && atLeast(role, 'MANAGER')) role = 'LEAD'
  return { active: meta.isActive === true, role }
}

/** The app_metadata keys that mirror the Prisma User row's `{role,isActive}`. */
export function accessAppMetadata(user: { role: Role; isActive: boolean }): { role: Role; isActive: boolean } {
  return { role: user.role, isActive: user.isActive }
}

/**
 * True when the auth user's app_metadata already says what the Prisma row
 * says. A missing Prisma row means the login should not open pages at all.
 */
export function accessMetadataInSync(
  appMetadata: Record<string, unknown> | null | undefined,
  row: { role: Role; isActive: boolean } | null,
): boolean {
  const meta = appMetadata ?? {}
  if (!row) return meta.isActive === false
  return meta.role === row.role && meta.isActive === row.isActive
}

/**
 * Whether a verified email link may switch the login ON. Only accepting an
 * invite does: a password-recovery link (or any other) proves the person
 * owns the inbox, not that a manager wants them back in.
 */
export function linkActivatesLogin(type: string | null | undefined): boolean {
  return type === 'invite'
}
