// Pure and client-safe (no server-only, no I/O): shared by requireSession,
// which says why a PIN session was refused, and UserContext, which acts on it.

/** The 401 message requireSession gives a PIN login whose phone isn't OK'd (RULING P9). */
export const PIN_PHONE_NEEDED = 'Sign in again with your PIN on an OK’d phone'

/** Where a PIN user goes once their phone is removed. */
export const PIN_REMOVED_URL = '/auth/pin?reason=removed'

/** The one-line notice /auth/pin shows for `?reason=removed`. */
export const PIN_REMOVED_NOTICE = 'This phone isn’t OK’d any more. Sign in with your PIN to ask again.'

/**
 * True when a `/api/me` reply means "this PIN phone was removed": a 401 whose
 * `error` is exactly PIN_PHONE_NEEDED, seen on a page outside `/login` and
 * `/auth/*` (never redirect from those, so this can't loop). Any other 401 —
 * an email user with no session — keeps today's behaviour.
 */
export function shouldReturnToPin(status: number, body: unknown, pathname: string): boolean {
  if (status !== 401) return false
  if (pathname === '/login' || pathname.startsWith('/login/')) return false
  if (pathname === '/auth' || pathname.startsWith('/auth/')) return false
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  return error === PIN_PHONE_NEEDED
}
