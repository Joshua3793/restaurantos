// Pure rules for PIN sign-in on a cook's own phone. Server-side only
// (node:crypto) — never import this from a client component.
import { createHash, randomBytes } from 'node:crypto'

/** 32 random bytes as base64url (43 chars). Stored only as a hash. */
export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Four characters shown on the cook's phone AND beside the request on the
 * manager's screen, so the manager can tell which phone is whose. Not a
 * secret; derived from the stored hash, never from the raw token.
 */
export function pairCode(tokenHash: string): string {
  return createHash('sha256').update('pair:' + tokenHash).digest('hex').slice(0, 4).toUpperCase()
}

export const LOCK_LIMIT = 5
export const LOCK_WINDOW_MS = 15 * 60_000

/** Confirms ("yes, that's me") allowed per IP inside the window. */
export const CONFIRM_LIMIT = 20

/** A PENDING request older than this can't be approved; a confirm refreshes it. */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60_000

/** Locked once `limit` (default LOCK_LIMIT) tries fall inside the trailing window. */
export function isLocked(failedAt: Date[], now: Date, limit: number = LOCK_LIMIT): boolean {
  const since = now.getTime() - LOCK_WINDOW_MS
  return failedAt.filter((d) => d.getTime() > since).length >= limit
}

/** "Sam L." — first name + last initial; a lone first name stays as is. */
export function pinDisplayName(cook: { name: string; lastName: string | null }): string {
  const parts = cook.name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0] ?? ''
  const last = cook.lastName?.trim() || (parts.length > 1 ? parts[parts.length - 1] : '')
  return last ? `${first} ${last[0].toUpperCase()}.` : first
}

/** "Sam Lee" — the full name a manager sees; no doubled surname if `name` already ends with it. */
export function pinFullName(cook: { name: string; lastName: string | null }): string {
  const first = cook.name.trim()
  const last = cook.lastName?.trim()
  return last && !first.toLowerCase().endsWith(last.toLowerCase()) ? `${first} ${last}` : first
}

/** Synthetic login email for a cook's PIN account (never mailed). */
export function pinEmail(cookId: string): string {
  return `pin.${cookId}@crew.controlaos.vercel.app`
}

export function deviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? ''
  if (/iPad/i.test(ua)) return 'iPad'
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/Android/i.test(ua)) return 'Android phone'
  return 'Browser'
}
