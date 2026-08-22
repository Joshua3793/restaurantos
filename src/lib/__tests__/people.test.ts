import { describe, it, expect } from 'vitest'
import {
  mergePeople, displayName, personWarnings, matchesQuery, rosterFullName,
  type PersonLogin, type PersonRoster,
} from '@/lib/people'

const login = (over: Partial<PersonLogin> = {}): PersonLogin => ({
  id: 'u1', email: 'mia@fergies.test', name: 'Mia Chen', role: 'STAFF',
  isActive: true, isPending: false, createdAt: '2026-01-01T00:00:00.000Z',
  assignments: [], ...over,
})

const roster = (over: Partial<PersonRoster> = {}): PersonRoster => ({
  id: 'c1', name: 'Mia', lastName: 'Chen', initials: 'MC', homeStation: 'Hot',
  isActive: true, sortOrder: 0, clockId: '1204', posPosition: 'Line Cook',
  wage: 22.5, dailyHourCap: 8, tipRoleId: 'r1', onTipPool: true, ...over,
})

describe('mergePeople', () => {
  it('keys a linked person by their user id', () => {
    const [p] = mergePeople([{ login: login(), roster: roster() }], [])
    expect(p.key).toBe('u1')
    expect(p.login?.id).toBe('u1')
    expect(p.roster?.id).toBe('c1')
  })

  it('keys a roster-only person by a cook-prefixed id so it cannot collide with a user id', () => {
    const [p] = mergePeople([], [roster({ id: 'c9' })])
    expect(p.key).toBe('cook:c9')
    expect(p.login).toBeNull()
  })

  it('keeps a login with no roster row', () => {
    const [p] = mergePeople([{ login: login(), roster: null }], [])
    expect(p.roster).toBeNull()
  })

  it('lists logins before orphan roster rows', () => {
    const out = mergePeople([{ login: login(), roster: null }], [roster({ id: 'c9' })])
    expect(out.map(p => p.key)).toEqual(['u1', 'cook:c9'])
  })

  it('includes an orphan roster row exactly once', () => {
    const out = mergePeople([{ login: login(), roster: roster() }], [roster({ id: 'c9' })])
    expect(out.filter(p => p.roster?.id === 'c9')).toHaveLength(1)
  })
})

describe('displayName', () => {
  it('prefers the account name', () => {
    const [p] = mergePeople([{ login: login({ name: 'Mia Chen' }), roster: roster({ name: 'Mia' }) }], [])
    expect(displayName(p)).toBe('Mia Chen')
  })

  it('falls back to the roster name when the account has none', () => {
    const [p] = mergePeople([{ login: login({ name: null }), roster: roster() }], [])
    expect(displayName(p)).toBe('Mia Chen')
  })

  it('falls back to the email when there is no name anywhere', () => {
    const [p] = mergePeople([{ login: login({ name: null }), roster: null }], [])
    expect(displayName(p)).toBe('mia@fergies.test')
  })

  it('uses the roster name for a roster-only person', () => {
    const [p] = mergePeople([], [roster({ lastName: null })])
    expect(displayName(p)).toBe('Mia')
  })
})

describe('rosterFullName', () => {
  it('joins first and last', () => {
    expect(rosterFullName(roster())).toBe('Mia Chen')
  })
  it('omits a null last name without a trailing space', () => {
    expect(rosterFullName(roster({ lastName: null }))).toBe('Mia')
  })
})

describe('personWarnings', () => {
  it('flags an on-pool person with no clock id — hours match on clockId alone, so they earn nothing', () => {
    const [p] = mergePeople([], [roster({ clockId: null, onTipPool: true })])
    expect(personWarnings(p).map(w => w.code)).toContain('POOL_NO_CLOCK')
  })

  it('does not flag an off-pool person with no clock id', () => {
    const [p] = mergePeople([], [roster({ clockId: null, onTipPool: false })])
    expect(personWarnings(p).map(w => w.code)).not.toContain('POOL_NO_CLOCK')
  })

  it('does not flag an inactive roster row', () => {
    const [p] = mergePeople([], [roster({ clockId: null, onTipPool: true, isActive: false })])
    expect(personWarnings(p).map(w => w.code)).not.toContain('POOL_NO_CLOCK')
  })

  it('flags account/roster name divergence', () => {
    const [p] = mergePeople([{ login: login({ name: 'Mia Chen' }), roster: roster({ name: 'Amelia', lastName: 'Chen' }) }], [])
    expect(personWarnings(p).map(w => w.code)).toContain('NAME_DIVERGENCE')
  })

  it('does not flag matching names', () => {
    const [p] = mergePeople([{ login: login({ name: 'Mia Chen' }), roster: roster() }], [])
    expect(personWarnings(p).map(w => w.code)).not.toContain('NAME_DIVERGENCE')
  })

  it('flags a non-global login with zero assignments', () => {
    const [p] = mergePeople([{ login: login({ role: 'STAFF', assignments: [] }), roster: null }], [])
    expect(personWarnings(p).map(w => w.code)).toContain('NO_ASSIGNMENTS')
  })

  it('does not flag an ADMIN with zero assignments — clearance reaches every RC regardless', () => {
    const [p] = mergePeople([{ login: login({ role: 'ADMIN', assignments: [] }), roster: null }], [])
    expect(personWarnings(p).map(w => w.code)).not.toContain('NO_ASSIGNMENTS')
  })

  it('never flags NO_ASSIGNMENTS on a roster-only person — a cook with no login is normal', () => {
    const [p] = mergePeople([], [roster()])
    expect(personWarnings(p).map(w => w.code)).not.toContain('NO_ASSIGNMENTS')
  })
})

describe('matchesQuery', () => {
  const [linked] = mergePeople([{ login: login(), roster: roster() }], [])

  it('matches on display name, case-insensitively', () => {
    expect(matchesQuery(linked, 'mia')).toBe(true)
  })
  it('matches on email', () => {
    expect(matchesQuery(linked, 'fergies.test')).toBe(true)
  })
  it('matches on clock id', () => {
    expect(matchesQuery(linked, '1204')).toBe(true)
  })
  it('matches on the roster name even when the account name differs', () => {
    const [p] = mergePeople([{ login: login({ name: 'Amelia Chen' }), roster: roster({ name: 'Mia' }) }], [])
    expect(matchesQuery(p, 'mia')).toBe(true)
  })
  it('returns true for an empty query', () => {
    expect(matchesQuery(linked, '  ')).toBe(true)
  })
  it('returns false for a miss', () => {
    expect(matchesQuery(linked, 'zzz')).toBe(false)
  })
})
