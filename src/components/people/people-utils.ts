// What the access editors share: the location tree they render, and the
// relative-time formatter the audit panel uses.
//
// The person-shaped types that used to live here (Person, Assignment,
// LocationGroup) and `assignmentLabel` were removed with the People hub: the
// hub projects over User ⟕ Cook and its Person type lives in @/lib/people. Two
// different `Person` types under two import paths was an active trap. Initials
// moved to `deriveInitials` in @/lib/people — ONE rule, shared with the server.

export interface LocationNode {
  id: string
  name: string
  color: string
  revenueCenters: Array<{ id: string; name: string; color: string }>
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
