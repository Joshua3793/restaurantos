import { describe, it, expect } from 'vitest'
import { mergePeople, type Person, type PersonLogin, type PersonRoster } from '@/lib/people'
import { applyFilter, groupPeople, reorderPatches } from '@/components/people/hub/hub-utils'
import type { LocationNode } from '@/components/people/people-utils'

const login = (over: Partial<PersonLogin> = {}): PersonLogin => ({
  id: 'u1', email: 'mia@fergies.test', name: 'Mia Chen', role: 'STAFF',
  isActive: true, isPending: false, createdAt: '2026-01-01T00:00:00.000Z',
  assignments: [], ...over,
})
const roster = (over: Partial<PersonRoster> = {}): PersonRoster => ({
  id: 'c1', name: 'Mia', lastName: 'Chen', initials: 'MC', homeStation: 'Hot',
  isActive: true, sortOrder: 0, clockId: '1204', posPosition: null,
  wage: null, dailyHourCap: null, tipRoleId: null, onTipPool: true, ...over,
})
const scope = (locationId: string) => ({
  id: 's1', locationId, locationName: 'Downtown',
  revenueCenterId: null, rcName: null, clearance: null,
})
const locations: LocationNode[] = [
  { id: 'loc1', name: 'Downtown', color: '#000', revenueCenters: [{ id: 'rc1', name: 'Cafe', color: '#000' }] },
]

describe('applyFilter', () => {
  const people = mergePeople(
    [
      { login: login({ id: 'u1' }), roster: roster() },
      { login: login({ id: 'u2', email: 'book@fergies.test', name: 'Book Keeper' }), roster: null },
      { login: login({ id: 'u3', email: 'new@fergies.test', name: null, isActive: false, isPending: true }), roster: null },
      { login: login({ id: 'u4', email: 'old@fergies.test', name: 'Old Hand', isActive: false }), roster: null },
    ],
    [roster({ id: 'c9', name: 'Ana' })],
  )

  it('returns everyone under "all"', () => {
    expect(applyFilter(people, 'all', '')).toHaveLength(5)
  })
  it('"logins" keeps only people with an account', () => {
    expect(applyFilter(people, 'logins', '').every(p => p.login)).toBe(true)
  })
  it('"roster" keeps only people with a roster row', () => {
    const out = applyFilter(people, 'roster', '')
    expect(out.every(p => p.roster)).toBe(true)
    expect(out).toHaveLength(2)
  })
  it('"roster" sorts by run-sheet order, not by name', () => {
    const out = applyFilter(
      mergePeople([], [roster({ id: 'cA', name: 'Zoe', sortOrder: 1 }), roster({ id: 'cB', name: 'Ana', sortOrder: 0 })]),
      'roster', '',
    )
    expect(out.map(p => p.roster!.name)).toEqual(['Ana', 'Zoe'])
  })
  it('"pending" keeps only unaccepted invites', () => {
    const out = applyFilter(people, 'pending', '')
    expect(out.map(p => p.key)).toEqual(['u3'])
  })
  it('"inactive" excludes pending invites — an unaccepted invite is not a deactivation', () => {
    const out = applyFilter(people, 'inactive', '')
    expect(out.map(p => p.key)).toEqual(['u4'])
  })
  it('applies the query on top of the filter', () => {
    expect(applyFilter(people, 'all', 'ana').map(p => p.key)).toEqual(['cook:c9'])
  })
})

describe('groupPeople', () => {
  it('groups an assigned person under their location', () => {
    const people = mergePeople([{ login: login({ assignments: [scope('loc1')] }), roster: null }], [])
    const groups = groupPeople(people, locations)
    expect(groups[0]).toMatchObject({ kind: 'location', label: 'Downtown' })
  })

  it('puts a roster-only person in their own bucket, NOT the unassigned warning bucket', () => {
    const groups = groupPeople(mergePeople([], [roster({ id: 'c9' })]), locations)
    const kinds = groups.map(g => g.kind)
    expect(kinds).toContain('roster-only')
    expect(kinds).not.toContain('unassigned')
  })

  it('puts an unassigned ADMIN in the global bucket', () => {
    const people = mergePeople([{ login: login({ role: 'ADMIN', assignments: [] }), roster: null }], [])
    expect(groupPeople(people, locations).map(g => g.kind)).toContain('global')
  })

  it('puts an unassigned STAFF in the unassigned warning bucket', () => {
    const people = mergePeople([{ login: login({ role: 'STAFF', assignments: [] }), roster: null }], [])
    expect(groupPeople(people, locations).map(g => g.kind)).toContain('unassigned')
  })

  it('lists a person under every location they touch', () => {
    const two: LocationNode[] = [
      ...locations,
      { id: 'loc2', name: 'Rooftop', color: '#000', revenueCenters: [] },
    ]
    const people = mergePeople(
      [{ login: login({ assignments: [scope('loc1'), { ...scope('loc2'), id: 's2' }] }), roster: null }],
      [],
    )
    const groups = groupPeople(people, two).filter(g => g.kind === 'location')
    expect(groups).toHaveLength(2)
  })

  it('drops empty groups', () => {
    expect(groupPeople([], locations)).toEqual([])
  })
})

describe('reorderPatches', () => {
  // Five cooks in run-sheet order: Ana(0) Bo(1) Cy(2) Dee(3) Eve(4).
  const crew = (): Person[] => mergePeople([], [
    roster({ id: 'cA', name: 'Ana', sortOrder: 0 }),
    roster({ id: 'cB', name: 'Bo', sortOrder: 1 }),
    roster({ id: 'cC', name: 'Cy', sortOrder: 2 }),
    roster({ id: 'cD', name: 'Dee', sortOrder: 3 }),
    roster({ id: 'cE', name: 'Eve', sortOrder: 4 }),
  ])
  const find = (people: Person[], id: string) => people.find(p => p.roster!.id === id)!

  it('moving a middle cook up patches exactly the two swapped rows', () => {
    const people = crew()
    expect(reorderPatches(people, find(people, 'cC'), 'up')).toEqual([
      { cookId: 'cC', sortOrder: 1 },
      { cookId: 'cB', sortOrder: 2 },
    ])
  })

  it('moving a middle cook down patches exactly the two swapped rows', () => {
    const people = crew()
    expect(reorderPatches(people, find(people, 'cC'), 'down')).toEqual([
      { cookId: 'cD', sortOrder: 2 },
      { cookId: 'cC', sortOrder: 3 },
    ])
  })

  // THE REGRESSION. A search for "e" on the Roster tab shows only Dee and Eve.
  // Renumbering that 2-item slice would emit Eve→0 / Dee→1, colliding head-on
  // with Ana(0) and Bo(1), who are not even on screen. Computing over the full
  // roster must leave every other cook's slot alone.
  it('indexes against the full roster even when the visible subset is smaller', () => {
    const people = crew()
    const visibleSubset = [find(people, 'cD'), find(people, 'cE')]
    const wrong = reorderPatches(visibleSubset, find(people, 'cE'), 'up')
    expect(wrong.map(r => r.sortOrder)).toEqual([0, 1]) // what the old code did

    const right = reorderPatches(people, find(people, 'cE'), 'up')
    expect(right).toEqual([
      { cookId: 'cE', sortOrder: 3 },
      { cookId: 'cD', sortOrder: 4 },
    ])
    // No patch may land on a slot already held by an untouched cook.
    const untouched = [0, 1, 2] // Ana, Bo, Cy
    expect(right.some(r => untouched.includes(r.sortOrder))).toBe(false)
  })

  it('returns [] when the first cook moves up', () => {
    const people = crew()
    expect(reorderPatches(people, find(people, 'cA'), 'up')).toEqual([])
  })

  it('returns [] when the last cook moves down', () => {
    const people = crew()
    expect(reorderPatches(people, find(people, 'cE'), 'down')).toEqual([])
  })

  it('returns [] for a person with no roster row', () => {
    const people = crew()
    const bookkeeper = mergePeople([{ login: login({ id: 'u2' }), roster: null }], [])[0]
    expect(reorderPatches([...people, bookkeeper], bookkeeper, 'up')).toEqual([])
  })

  it('omits rows whose sortOrder is already correct', () => {
    const people = crew()
    const out = reorderPatches(people, find(people, 'cB'), 'down')
    expect(out.map(r => r.cookId).sort()).toEqual(['cB', 'cC'])
    expect(out.some(r => ['cA', 'cD', 'cE'].includes(r.cookId))).toBe(false)
  })

  it('renumbers non-contiguous stored sortOrders contiguously', () => {
    const people = mergePeople([], [
      roster({ id: 'cA', name: 'Ana', sortOrder: 0 }),
      roster({ id: 'cB', name: 'Bo', sortOrder: 5 }),
      roster({ id: 'cC', name: 'Cy', sortOrder: 9 }),
    ])
    expect(reorderPatches(people, find(people, 'cC'), 'up')).toEqual([
      { cookId: 'cC', sortOrder: 1 },
      { cookId: 'cB', sortOrder: 2 },
    ])
  })
})
