import { describe, it, expect } from 'vitest'
import { requiredClearance, canAccess, ROUTE_CLEARANCE } from '../route-access'
import { ROLE_ORDER } from '../roles'

describe('requiredClearance', () => {
  it('returns null for routes open to STAFF', () => {
    expect(requiredClearance('/prep')).toBeNull()
    expect(requiredClearance('/count')).toBeNull()
    expect(requiredClearance('/today')).toBeNull()
    expect(requiredClearance('/inventory')).toBeNull()
    expect(requiredClearance('/temps')).toBeNull()
    expect(requiredClearance('/wastage')).toBeNull()
  })

  it('gates the manager routes at MANAGER', () => {
    expect(requiredClearance('/pass')).toBe('MANAGER')
    expect(requiredClearance('/reports')).toBe('MANAGER')
    expect(requiredClearance('/cost')).toBe('MANAGER')
    expect(requiredClearance('/variance')).toBe('MANAGER')
    expect(requiredClearance('/signals')).toBe('MANAGER')
    expect(requiredClearance('/tips')).toBe('MANAGER')
  })

  it('gates setup at ADMIN and end-of-day at LEAD', () => {
    expect(requiredClearance('/setup')).toBe('ADMIN')
    expect(requiredClearance('/settings')).toBe('ADMIN')
    expect(requiredClearance('/end-of-day')).toBe('LEAD')
  })

  it('applies a prefix gate to that route’s children', () => {
    expect(requiredClearance('/setup/suppliers')).toBe('ADMIN')
    expect(requiredClearance('/setup/users')).toBe('ADMIN')
    expect(requiredClearance('/reports/waste')).toBe('MANAGER')
  })

  it('matches on path segments, never on a bare string prefix', () => {
    // '/passport' must NOT inherit '/pass'’s MANAGER gate.
    expect(requiredClearance('/passport')).toBeNull()
    expect(requiredClearance('/setup-guide')).toBeNull()
  })

  it('prefers the longest matching prefix regardless of array order', () => {
    // The live table has no nested entries, so longest-prefix is exercised
    // against a synthetic one via the optional `table` parameter. Both orders
    // are checked: the rule must be "longest wins", not "first wins".
    const narrowLast = [
      ['/setup', 'ADMIN'],
      ['/setup/suppliers', 'MANAGER'],
    ] as const
    const narrowFirst = [
      ['/setup/suppliers', 'MANAGER'],
      ['/setup', 'ADMIN'],
    ] as const

    expect(requiredClearance('/setup/suppliers', narrowLast)).toBe('MANAGER')
    expect(requiredClearance('/setup/suppliers', narrowFirst)).toBe('MANAGER')
    expect(requiredClearance('/setup/users', narrowLast)).toBe('ADMIN')
    expect(requiredClearance('/setup/users', narrowFirst)).toBe('ADMIN')
  })
})

describe('canAccess', () => {
  it('lets every role into an ungated route', () => {
    for (const role of ROLE_ORDER) {
      expect(canAccess(role, '/count')).toBe(true)
    }
  })

  it('lets OWNER through every gate in the table', () => {
    for (const [prefix] of ROUTE_CLEARANCE) {
      expect(canAccess('OWNER', prefix)).toBe(true)
    }
  })

  it('keeps STAFF out of every gate in the table', () => {
    for (const [prefix] of ROUTE_CLEARANCE) {
      expect(canAccess('STAFF', prefix)).toBe(false)
    }
  })

  it('places LEAD below MANAGER — end-of-day yes, pass no', () => {
    expect(canAccess('LEAD', '/end-of-day')).toBe(true)
    expect(canAccess('LEAD', '/pass')).toBe(false)
    expect(canAccess('LEAD', '/setup')).toBe(false)
  })

  it('gives MANAGER the manager routes but not setup', () => {
    expect(canAccess('MANAGER', '/pass')).toBe(true)
    expect(canAccess('MANAGER', '/reports')).toBe(true)
    expect(canAccess('MANAGER', '/end-of-day')).toBe(true)
    expect(canAccess('MANAGER', '/setup')).toBe(false)
    expect(canAccess('MANAGER', '/setup/suppliers')).toBe(false)
  })

  it('denies a null role on any gated route — never grant on unknown', () => {
    expect(canAccess(null, '/pass')).toBe(false)
    expect(canAccess(null, '/setup')).toBe(false)
  })

  it('allows a null role on an ungated route so loading never blocks the app', () => {
    expect(canAccess(null, '/count')).toBe(true)
  })
})
