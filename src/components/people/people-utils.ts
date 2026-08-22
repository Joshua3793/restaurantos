import type { Role } from '@prisma/client'

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

export interface LocationGroup {
  location: LocationNode | null
  people: Person[]
  /**
   * true for the synthetic "global access" bucket — OWNER/ADMIN people with
   * no location-specific assignment. `location` is null here too, but unlike
   * the genuinely-unassigned group this is NOT a warning state: OWNER/ADMIN
   * reach every revenue center by role, regardless of assignments.
   */
  isGlobal?: boolean
}

/** "Downtown · whole location" / "Rooftop Bar" */
export function assignmentLabel(a: Assignment): string {
  if (a.revenueCenterId) return a.rcName ?? 'Revenue center'
  return `${a.locationName ?? 'Location'} · whole location`
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
