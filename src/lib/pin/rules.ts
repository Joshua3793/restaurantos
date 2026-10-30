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

export const LOCK_LIMIT = 5
export const LOCK_WINDOW_MS = 15 * 60_000

/** Locked once LOCK_LIMIT failures fall inside the trailing window. */
export function isLocked(failedAt: Date[], now: Date): boolean {
  const since = now.getTime() - LOCK_WINDOW_MS
  return failedAt.filter((d) => d.getTime() > since).length >= LOCK_LIMIT
}

/** "Sam L." — first name + last initial; a lone first name stays as is. */
export function pinDisplayName(cook: { name: string; lastName: string | null }): string {
  const parts = cook.name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0] ?? ''
  const last = cook.lastName?.trim() || (parts.length > 1 ? parts[parts.length - 1] : '')
  return last ? `${first} ${last[0].toUpperCase()}.` : first
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
