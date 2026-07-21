// Pure effective-access model. Deliberately NO `server-only` and no Prisma
// runtime import: both the server resolver (src/lib/access.ts) and the client
// PersonDetailPanel import resolveEffective from here, so the conflict rules
// are defined exactly once.
import type { Role } from '@prisma/client'
import { ROLE_RANK } from '@/lib/roles'

export interface ScopeRow {
  locationId: string | null
  revenueCenterId: string | null
  clearance: Role | null
}

export interface RcNode {
  id: string
  name: string
  locationId: string
  locationName: string
}

export interface EffectiveEntry {
  rcId: string
  rcName: string
  locationId: string
  locationName: string
  clearance: Role
  /** 'override' when the winning assignment carried its own clearance. */
  source: 'inherited' | 'override'
}

type Candidate = { clearance: Role; source: 'inherited' | 'override'; specificity: 0 | 1 }

/**
 * Pure resolution: fold a user's assignments into one entry per reachable RC.
 *
 * Conflict rules, in order:
 *   1. More specific wins — an RC-level row beats a location-level row.
 *   2. At equal specificity, the higher clearance wins.
 *
 * A row whose `clearance` is null inherits `primary` and is reported as
 * 'inherited'. Rows pointing at RCs not present in `rcs` (deleted or inactive)
 * are skipped, so an empty result genuinely means "no access".
 */
export function resolveEffective(primary: Role, scopes: ScopeRow[], rcs: RcNode[]): EffectiveEntry[] {
  const byId = new Map(rcs.map(rc => [rc.id, rc]))
  const byLocation = new Map<string, RcNode[]>()
  for (const rc of rcs) {
    const list = byLocation.get(rc.locationId)
    if (list) list.push(rc)
    else byLocation.set(rc.locationId, [rc])
  }

  const best = new Map<string, Candidate>()

  const offer = (rcId: string, c: Candidate) => {
    const current = best.get(rcId)
    if (!current) { best.set(rcId, c); return }
    if (c.specificity > current.specificity) { best.set(rcId, c); return }
    if (c.specificity === current.specificity && ROLE_RANK[c.clearance] > ROLE_RANK[current.clearance]) {
      best.set(rcId, c)
    }
  }

  for (const s of scopes) {
    const clearance = s.clearance ?? primary
    const source: 'inherited' | 'override' = s.clearance ? 'override' : 'inherited'

    if (s.revenueCenterId) {
      if (byId.has(s.revenueCenterId)) offer(s.revenueCenterId, { clearance, source, specificity: 1 })
      continue
    }
    if (s.locationId) {
      for (const rc of byLocation.get(s.locationId) ?? []) {
        offer(rc.id, { clearance, source, specificity: 0 })
      }
    }
  }

  return [...best.entries()].map(([rcId, c]) => {
    const rc = byId.get(rcId)!
    return {
      rcId,
      rcName: rc.name,
      locationId: rc.locationId,
      locationName: rc.locationName,
      clearance: c.clearance,
      source: c.source,
    }
  })
}
