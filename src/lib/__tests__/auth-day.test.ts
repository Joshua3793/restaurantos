import { describe, expect, it } from 'vitest'
import {
  lastSignOutCutoff,
  nextSignOutCutoff,
  sessionSignedInAt,
  signedInBeforeCutoff,
} from '@/lib/auth-day'

const iso = (ms: number) => new Date(ms).toISOString()
const token = (payload: object) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

describe('lastSignOutCutoff — 02:00 restaurant time', () => {
  it('after 2am: today at 2am (winter, PST = UTC−8)', () => {
    // Tue 17 Nov 2026, 07:30 PST
    expect(iso(lastSignOutCutoff(new Date('2026-11-17T15:30:00Z')))).toBe('2026-11-17T10:00:00.000Z')
  })
  it('before 2am: yesterday at 2am (a late close at 1:30am)', () => {
    // Tue 17 Nov 2026, 01:30 PST
    expect(iso(lastSignOutCutoff(new Date('2026-11-17T09:30:00Z')))).toBe('2026-11-16T10:00:00.000Z')
  })
  it('summer (PDT = UTC−7)', () => {
    expect(iso(lastSignOutCutoff(new Date('2026-07-01T18:00:00Z')))).toBe('2026-07-01T09:00:00.000Z')
  })
  it('exactly 2am is the cutoff itself', () => {
    expect(iso(lastSignOutCutoff(new Date('2026-11-17T10:00:00Z')))).toBe('2026-11-17T10:00:00.000Z')
  })
  it('first of the month before 2am rolls back to the last day of the previous month', () => {
    expect(iso(lastSignOutCutoff(new Date('2026-12-01T09:00:00Z')))).toBe('2026-11-30T10:00:00.000Z')
  })
  it('fall-back day (1 Nov 2026): 2am PST', () => {
    expect(iso(lastSignOutCutoff(new Date('2026-11-01T18:00:00Z')))).toBe('2026-11-01T10:00:00.000Z')
  })
})

describe('nextSignOutCutoff', () => {
  it('the coming 2am', () => {
    expect(iso(nextSignOutCutoff(new Date('2026-11-17T15:30:00Z')))).toBe('2026-11-18T10:00:00.000Z')
    expect(iso(nextSignOutCutoff(new Date('2026-11-17T09:30:00Z')))).toBe('2026-11-17T10:00:00.000Z')
  })
  it('across the spring-forward night it is still one cutoff ahead', () => {
    const next = nextSignOutCutoff(new Date('2026-03-07T20:00:00Z'))
    expect(next).toBeGreaterThan(Date.parse('2026-03-07T20:00:00Z'))
    expect(next).toBeLessThan(Date.parse('2026-03-08T12:00:00Z'))
  })
})

describe('sessionSignedInAt', () => {
  it('reads the latest amr timestamp', () => {
    const t = token({ amr: [{ method: 'password', timestamp: 1_700_000_000 }, { method: 'otp', timestamp: 1_700_000_500 }] })
    expect(sessionSignedInAt(t)).toBe(1_700_000_500_000)
  })
  it('falls back to last_sign_in_at when the token has no amr', () => {
    expect(sessionSignedInAt(token({ iat: 1 }), '2026-11-17T15:00:00Z')).toBe(Date.parse('2026-11-17T15:00:00Z'))
  })
  it('null when nothing is readable', () => {
    expect(sessionSignedInAt('garbage', null)).toBeNull()
    expect(sessionSignedInAt(undefined)).toBeNull()
  })
})

describe('signedInBeforeCutoff', () => {
  const now = new Date('2026-11-17T15:30:00Z') // 07:30 PST
  it('signed in last night → out', () => {
    expect(signedInBeforeCutoff(Date.parse('2026-11-17T05:00:00Z'), now)).toBe(true) // 9pm PST
  })
  it('signed in this morning → stays in', () => {
    expect(signedInBeforeCutoff(Date.parse('2026-11-17T14:00:00Z'), now)).toBe(false) // 6am PST
  })
  it('unknown sign-in time → left alone', () => {
    expect(signedInBeforeCutoff(null, now)).toBe(false)
  })
})
