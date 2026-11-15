/**
 * Pure helpers for the Toast access token lifecycle.
 *
 * What Toast actually does (verified live, 2026-11-15): a machine client's token
 * lives exactly 24 h, and every login inside that 24 h returns the SAME token with
 * `expiresIn` counting down. A fresh token is minted only once the old one has
 * expired.
 *
 * Why that matters: the nightly cron fires at the same second every day, so the
 * token minted by yesterday's run dies at the very moment today's run uses it.
 * Toast hands back the dying token, the data call is refused (401), and a quick
 * re-login just returns the same dying token again. That failed 13 of 15 nights in
 * Nov 2026. The fix is to read the token's real expiry and, when it is about to
 * lapse, wait it out and log in again for a fresh one.
 */

/** Epoch ms at which a JWT access token expires, or null if it can't be read. */
export function tokenExpiryMs(accessToken: string): number | null {
  const payload = accessToken.split('.')[1]
  if (!payload) return null
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof json.exp === 'number' && Number.isFinite(json.exp) ? json.exp * 1000 : null
  } catch {
    return null
  }
}

/** A token with less life than this left is treated as already dead. */
export const MIN_TOKEN_LIFE_MS = 2 * 60 * 1000
/** Pause after the old token's expiry before asking for a new one. */
export const EXPIRY_GRACE_MS = 3 * 1000

/**
 * How long to wait before logging in again to get a usable token: 0 when the
 * token has plenty of life (or its expiry is unknown), otherwise the time until it
 * expires plus a short grace.
 */
export function waitForFreshTokenMs(expiresAtMs: number | null, nowMs: number): number {
  if (expiresAtMs == null) return 0
  const left = expiresAtMs - nowMs
  if (left >= MIN_TOKEN_LIFE_MS) return 0
  return Math.max(0, left) + EXPIRY_GRACE_MS
}

/** Back-off before each retry of a request Toast refused with 401. */
export const UNAUTHORIZED_RETRY_DELAYS_MS = [2_000, 5_000, 15_000]
