// Pure and client-safe (no server-only, no I/O): the kitchen's sign-in day.
// Every session ends at 02:00 restaurant time, so each morning starts with a
// fresh sign-in. Read by middleware (pages), requireSession (APIs) and
// UserContext (a page left open overnight).

const RESTAURANT_TZ = 'America/Los_Angeles'

/** The hour (restaurant time) every session ends. */
export const SIGN_OUT_HOUR = 2

/** The 401 message requireSession gives a session from before the last 02:00. */
export const SIGNED_OUT_OVERNIGHT = 'Signed out overnight — sign in to start your day'

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: RESTAURANT_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
})

function wallClock(ms: number) {
  const p: Record<string, number> = {}
  for (const { type, value } of PARTS.formatToParts(new Date(ms))) {
    if (type !== 'literal') p[type] = Number(value)
  }
  return { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute, s: p.second }
}

/** Restaurant-time offset from UTC at `ms` (e.g. −7 h in summer), in ms. */
function offsetAt(ms: number): number {
  const w = wallClock(ms)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(ms / 1000) * 1000
}

/** Epoch ms of SIGN_OUT_HOUR on the restaurant calendar day y-m-d. */
function cutoffOn(y: number, m: number, d: number): number {
  const wall = Date.UTC(y, m - 1, d, SIGN_OUT_HOUR)
  const guess = wall - offsetAt(wall)
  return wall - offsetAt(guess)
}

/** The most recent 02:00 restaurant time at or before `now`, as epoch ms. */
export function lastSignOutCutoff(now: Date): number {
  const ms = now.getTime()
  const { y, m, d } = wallClock(ms)
  const today = cutoffOn(y, m, d)
  if (today <= ms) return today
  // Before 02:00: the cutoff was yesterday's. Date.UTC rolls day 0 back a month.
  const prev = new Date(Date.UTC(y, m - 1, d - 1))
  return cutoffOn(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate())
}

/** The next 02:00 restaurant time strictly after `now`, as epoch ms. */
export function nextSignOutCutoff(now: Date): number {
  // 26 h past the last cutoff always lands on the next restaurant day, after
  // its 02:00, whatever a daylight-saving change does to that day's length.
  return lastSignOutCutoff(new Date(lastSignOutCutoff(now) + 26 * 3600_000))
}

/**
 * When this session was signed in, in epoch ms: the latest `amr` timestamp in
 * the access token (Supabase keeps it across token refreshes, unlike `iat`).
 * Falls back to the user's `last_sign_in_at`; null when neither is readable.
 * The token must already be verified by the caller (getUser) — this only reads it.
 */
export function sessionSignedInAt(
  accessToken: string | null | undefined,
  lastSignInAt?: string | null,
): number | null {
  const payload = accessToken?.split('.')[1]
  if (payload) {
    try {
      const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
      const json = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as { amr?: unknown }
      const stamps = Array.isArray(json.amr)
        ? json.amr
            .map((e) => (e && typeof e === 'object' ? (e as { timestamp?: unknown }).timestamp : undefined))
            .filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
        : []
      if (stamps.length > 0) return Math.max(...stamps) * 1000
    } catch {
      // Unreadable token: fall through to last_sign_in_at.
    }
  }
  const last = lastSignInAt ? Date.parse(lastSignInAt) : NaN
  return Number.isFinite(last) ? last : null
}

/** True when a session signed in at `signedInAt` has passed the last 02:00. */
export function signedInBeforeCutoff(signedInAt: number | null, now: Date): boolean {
  if (signedInAt == null) return false
  return signedInAt < lastSignOutCutoff(now)
}
