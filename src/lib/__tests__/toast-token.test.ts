import { describe, it, expect } from 'vitest'
import {
  tokenExpiryMs,
  waitForFreshTokenMs,
  MIN_TOKEN_LIFE_MS,
  EXPIRY_GRACE_MS,
} from '@/lib/toast/token'

const jwt = (payload: object) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

describe('tokenExpiryMs', () => {
  it('reads exp (seconds) from the token payload as epoch ms', () => {
    expect(tokenExpiryMs(jwt({ exp: 1_763_317_468 }))).toBe(1_763_317_468_000)
  })

  it('returns null for a token it cannot read', () => {
    expect(tokenExpiryMs('not-a-jwt')).toBeNull()
    expect(tokenExpiryMs('h.%%%.sig')).toBeNull()
    expect(tokenExpiryMs(jwt({ sub: 'x' }))).toBeNull()
  })
})

describe('waitForFreshTokenMs', () => {
  const now = 1_000_000_000

  it('does not wait when the token has plenty of life left', () => {
    expect(waitForFreshTokenMs(now + 23 * 3600_000, now)).toBe(0)
    expect(waitForFreshTokenMs(now + MIN_TOKEN_LIFE_MS, now)).toBe(0)
  })

  // The nightly failure: yesterday's run minted the token at ~13:00:32, so at
  // 13:00:31 today Toast hands back a token with about a second to live.
  it('waits out a token that is about to lapse, plus a grace', () => {
    expect(waitForFreshTokenMs(now + 1_000, now)).toBe(1_000 + EXPIRY_GRACE_MS)
  })

  it('waits only the grace for a token that has already lapsed', () => {
    expect(waitForFreshTokenMs(now - 5_000, now)).toBe(EXPIRY_GRACE_MS)
  })

  it('does not wait when the expiry is unknown', () => {
    expect(waitForFreshTokenMs(null, now)).toBe(0)
  })
})
