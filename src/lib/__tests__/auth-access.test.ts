import { describe, it, expect } from 'vitest'
import {
  pageAccess,
  accessAppMetadata,
  accessMetadataInSync,
  linkActivatesLogin,
} from '@/lib/auth-access'

// The page gate reads app_metadata (service role only), never user_metadata
// (anyone signed in can rewrite their own from the browser).

describe('pageAccess', () => {
  it('reads role and isActive from app_metadata', () => {
    expect(pageAccess({ app_metadata: { role: 'MANAGER', isActive: true } })).toEqual({ active: true, role: 'MANAGER' })
  })

  it('ignores a forged OWNER in user_metadata', () => {
    const forged = {
      app_metadata: { role: 'STAFF', isActive: true },
      user_metadata: { role: 'OWNER', isActive: true },
    }
    expect(pageAccess(forged)).toEqual({ active: true, role: 'STAFF' })
  })

  it('a switched-off login cannot switch itself back on through user_metadata', () => {
    const forged = { app_metadata: { role: 'STAFF', isActive: false }, user_metadata: { isActive: true } }
    expect(pageAccess(forged).active).toBe(false)
  })

  it('blocks a login with no isActive stamped yet, and anything but exactly true', () => {
    expect(pageAccess({ app_metadata: { provider: 'email' } }).active).toBe(false)
    expect(pageAccess({ app_metadata: { isActive: 'true' } }).active).toBe(false)
    expect(pageAccess({}).active).toBe(false)
    expect(pageAccess(null).active).toBe(false)
  })

  it('falls back to STAFF for a missing or unknown role', () => {
    expect(pageAccess({ app_metadata: { isActive: true } }).role).toBe('STAFF')
    expect(pageAccess({ app_metadata: { isActive: true, role: 'SUPERUSER' } }).role).toBe('STAFF')
    expect(pageAccess({ app_metadata: { isActive: true, role: 'toString' } }).role).toBe('STAFF')
  })

  it('caps a PIN login at LEAD, like requireSession', () => {
    expect(pageAccess({ app_metadata: { pinCookId: 'c1', role: 'ADMIN', isActive: true } }).role).toBe('LEAD')
    expect(pageAccess({ app_metadata: { pinCookId: 'c1', role: 'STAFF', isActive: true } }).role).toBe('STAFF')
    expect(pageAccess({ app_metadata: { pinCookId: null, role: 'MANAGER', isActive: true } }).role).toBe('MANAGER')
  })
})

describe('accessAppMetadata', () => {
  it('copies only role and isActive from the User row', () => {
    expect(accessAppMetadata({ role: 'LEAD', isActive: false, name: 'Sam' } as never)).toEqual({ role: 'LEAD', isActive: false })
  })
})

describe('accessMetadataInSync', () => {
  it('true when app_metadata matches the row, extra keys ignored', () => {
    expect(accessMetadataInSync({ provider: 'email', role: 'STAFF', isActive: true }, { role: 'STAFF', isActive: true })).toBe(true)
  })
  it('false when a key is missing or differs', () => {
    expect(accessMetadataInSync({ provider: 'email' }, { role: 'STAFF', isActive: true })).toBe(false)
    expect(accessMetadataInSync({ role: 'STAFF', isActive: true }, { role: 'STAFF', isActive: false })).toBe(false)
    expect(accessMetadataInSync({ role: 'STAFF', isActive: true }, { role: 'LEAD', isActive: true })).toBe(false)
  })
  it('a login with no User row is in sync only when marked inactive', () => {
    expect(accessMetadataInSync({ isActive: false }, null)).toBe(true)
    expect(accessMetadataInSync({}, null)).toBe(false)
    expect(accessMetadataInSync(null, null)).toBe(false)
  })
})

describe('linkActivatesLogin', () => {
  it('only an invite link switches a login on', () => {
    expect(linkActivatesLogin('invite')).toBe(true)
    expect(linkActivatesLogin('recovery')).toBe(false)
    expect(linkActivatesLogin('magiclink')).toBe(false)
    expect(linkActivatesLogin('email')).toBe(false)
    expect(linkActivatesLogin(null)).toBe(false)
  })
})
