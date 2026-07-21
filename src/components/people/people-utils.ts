import type { Role } from '@prisma/client'
import { ROLE_LABELS } from '@/lib/roles'

export interface Assignment {
  id: string
  locationId: string | null
  locationName: string | null
  revenueCenterId: string | null
  rcName: string | null
  clearance: Role | null
}

export interface Person {
  id: string
  email: string
  name: string | null
  role: Role
  isActive: boolean
  createdAt: string
  isPending: boolean
  assignments: Assignment[]
}

export interface LocationNode {
  id: string
  name: string
  color: string
  revenueCenters: Array<{ id: string; name: string; color: string }>
}

/**
 * Group people under every location they touch. Somebody assigned to two
 * locations appears under both — the list is a map of who is where, not a
 * partition. People with no assignments land in the trailing `null` group.
 */
export function groupByLocation(
  people: Person[],
  locations: LocationNode[],
): Array<{ location: LocationNode | null; people: Person[] }> {
  const groups = locations.map(location => ({
    location: location as LocationNode | null,
    people: people.filter(p => p.assignments.some(a => a.locationId === location.id)),
  }))
  const unassigned = people.filter(p => p.assignments.length === 0)
  if (unassigned.length) groups.push({ location: null, people: unassigned })
  return groups.filter(g => g.people.length > 0)
}

/** "Downtown · whole location" / "Rooftop Bar" */
export function assignmentLabel(a: Assignment): string {
  if (a.revenueCenterId) return a.rcName ?? 'Revenue center'
  return `${a.locationName ?? 'Location'} · whole location`
}

/** One-line access summary for a person row. */
export function summarizeAccess(p: Person): string {
  if (p.role === 'OWNER' || p.role === 'ADMIN') return 'All locations'
  if (p.assignments.length === 0) return 'No assignments'
  const overrides = p.assignments.filter(a => a.clearance).length
  const base = p.assignments.length === 1
    ? assignmentLabel(p.assignments[0])
    : `${p.assignments.length} places`
  return overrides > 0 ? `${base} · ${overrides} override${overrides > 1 ? 's' : ''}` : base
}

/** Effective clearance shown on a chip for one assignment. */
export function chipClearance(p: Person, a: Assignment): Role {
  return a.clearance ?? p.role
}

export function chipLabel(p: Person, a: Assignment): string {
  const node = a.revenueCenterId ? a.rcName ?? 'RC' : a.locationName ?? 'Location'
  return `${node} · ${ROLE_LABELS[chipClearance(p, a)]}`
}

export function initials(nameOrEmail: string): string {
  const trimmed = nameOrEmail.trim()
  if (!trimmed) return '?'
  const parts = trimmed.split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return trimmed.slice(0, 2).toUpperCase()
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}
