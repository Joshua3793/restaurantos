import { describe, it, expect } from 'vitest'
import { PIN_PHONE_NEEDED, PIN_REMOVED_URL, shouldReturnToPin } from '@/lib/pin/session-lost'

const removed = { error: PIN_PHONE_NEEDED }

describe('shouldReturnToPin', () => {
  it('a removed PIN phone on an app page → back to PIN sign-in', () => {
    expect(shouldReturnToPin(401, removed, '/checklist')).toBe(true)
    expect(shouldReturnToPin(401, removed, '/today')).toBe(true)
    expect(PIN_REMOVED_URL).toBe('/auth/pin?reason=removed')
  })

  it('any other 401 keeps today’s behaviour (email users unchanged)', () => {
    expect(shouldReturnToPin(401, { error: 'Unauthorized' }, '/checklist')).toBe(false)
    expect(shouldReturnToPin(401, null, '/checklist')).toBe(false)
    expect(shouldReturnToPin(401, 'oops', '/checklist')).toBe(false)
    expect(shouldReturnToPin(401, { error: `${PIN_PHONE_NEEDED}.` }, '/checklist')).toBe(false)
  })

  it('only a 401 counts', () => {
    expect(shouldReturnToPin(403, removed, '/checklist')).toBe(false)
    expect(shouldReturnToPin(500, removed, '/checklist')).toBe(false)
  })

  it('never redirects from /login or /auth/* (no loops)', () => {
    for (const path of ['/login', '/login/reset', '/auth', '/auth/pin', '/auth/callback', '/auth/set-password']) {
      expect(shouldReturnToPin(401, removed, path)).toBe(false)
    }
  })

  it('does not mistake look-alike paths for the sign-in pages', () => {
    expect(shouldReturnToPin(401, removed, '/authors')).toBe(true)
    expect(shouldReturnToPin(401, removed, '/loginx')).toBe(true)
  })
})
