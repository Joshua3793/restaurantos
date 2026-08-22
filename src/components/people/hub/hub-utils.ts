// List-shaping rules for the People hub's left pane. Pure and unit-tested —
// see src/lib/__tests__/people-hub.test.ts.
import { atLeast } from '@/lib/roles'
import { displayName, matchesQuery, type Person } from '@/lib/people'
import type { LocationNode } from '@/components/people/people-utils'

export type HubFilter = 'all' | 'logins' | 'roster' | 'pending' | 'inactive'

export const HUB_FILTERS: Array<{ id: HubFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'logins', label: 'Logins' },
  { id: 'roster', label: 'Roster' },
  { id: 'pending', label: 'Pending' },
  { id: 'inactive', label: 'Inactive' },
]

export interface HubGroup {
  id: string
  label: string
  kind: 'location' | 'global' | 'roster-only' | 'unassigned'
  people: Person[]
}

/**
 * Filter, then search. The `roster` view sorts by Cook.sortOrder because that
 * IS the prep run-sheet order — this is where the reorder affordance from
 * /setup/kitchen-crew lives.
 */
export function applyFilter(people: Person[], filter: HubFilter, query: string): Person[] {
  let out = people.filter(p => {
    switch (filter) {
      case 'logins': return !!p.login
      case 'roster': return !!p.roster
      case 'pending': return !!p.login?.isPending
      // An unaccepted invite is inactive in the database but is NOT a
      // deactivation — it belongs under Pending, not here.
      case 'inactive': return (!!p.login && !p.login.isActive && !p.login.isPending)
        || (!p.login && !!p.roster && !p.roster.isActive)
      default: return true
    }
  })
  if (filter === 'roster') {
    out = [...out].sort((a, b) =>
      (a.roster!.sortOrder - b.roster!.sortOrder) || a.roster!.name.localeCompare(b.roster!.name))
  }
  return out.filter(p => matchesQuery(p, query))
}

const isGlobal = (p: Person) => !!p.login && atLeast(p.login.role, 'ADMIN')

/**
 * Group under every location a person touches — somebody assigned to two
 * locations appears under both. Three trailing buckets:
 *
 *  - roster-only  → a cook with no login. NORMAL, not a warning.
 *  - global       → OWNER/ADMIN with no assignments. They reach every RC by
 *                   role, so no assignment is needed.
 *  - unassigned   → a non-global clearance with zero assignments. A REAL
 *                   warning: this person sees all revenue centers.
 */
export function groupPeople(people: Person[], locations: LocationNode[]): HubGroup[] {
  const groups: HubGroup[] = locations.map(l => ({
    id: l.id,
    label: l.name,
    kind: 'location' as const,
    people: people.filter(p => p.login?.assignments.some(a => a.locationId === l.id)),
  }))

  const rosterOnly = people.filter(p => !p.login && p.roster)
  if (rosterOnly.length) {
    groups.push({ id: '__roster', label: 'Kitchen roster · no login', kind: 'roster-only', people: rosterOnly })
  }

  const global = people.filter(p => isGlobal(p) && p.login!.assignments.length === 0)
  if (global.length) {
    groups.push({ id: '__global', label: 'All locations', kind: 'global', people: global })
  }

  const unassigned = people.filter(
    p => p.login && !isGlobal(p) && p.login.assignments.length === 0,
  )
  if (unassigned.length) {
    groups.push({ id: '__unassigned', label: 'No assignments', kind: 'unassigned', people: unassigned })
  }

  return groups.filter(g => g.people.length > 0)
}

/** Two-letter avatar token. Prefers the roster's own initials when there is one. */
export function initialsFor(p: Person): string {
  if (p.roster?.initials) return p.roster.initials
  const source = displayName(p).trim()
  const parts = source.split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return source.slice(0, 2).toUpperCase() || '?'
}
