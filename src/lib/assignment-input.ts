import 'server-only'
import type { Role } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { assignableLevels } from '@/lib/roles'

export interface AssignmentInput {
  locationId?: string | null
  revenueCenterId?: string | null
  clearance?: Role | null
}

export const keyOf = (r: { locationId: string | null; revenueCenterId: string | null }) =>
  `${r.locationId ?? ''}|${r.revenueCenterId ?? ''}`

/**
 * Validates incoming assignment rows. Returns an error string, or null when valid.
 *
 * A per-assignment `clearance` is a real authorization grant — it is what
 * resolveEffective() hands back as the winning clearance at that node. So it is
 * bounded by assignableLevels(actorRole) exactly like the primary clearance.
 * Without this, an admin could write clearance:'OWNER' onto a UserScope row and
 * mint owner-level access, bypassing the User_single_owner index (which guards
 * User.role, not UserScope.clearance).
 */
export async function validateAssignmentRows(
  rows: AssignmentInput[],
  actorRole: Role,
): Promise<string | null> {
  if (rows.length === 0) {
    return 'Assign at least one location or revenue center — a person with no assignments has no access.'
  }

  const allowed = assignableLevels(actorRole)
  const locationIds = new Set<string>()
  const rcIds = new Set<string>()

  for (const r of rows) {
    const hasLoc = !!r.locationId
    const hasRc = !!r.revenueCenterId
    if (hasLoc === hasRc) {
      return 'Each assignment must target exactly one location or one revenue center.'
    }
    if (r.clearance != null && !allowed.includes(r.clearance)) {
      return `Assignment clearance must be one of: ${allowed.join(', ')}`
    }
    if (hasLoc) locationIds.add(r.locationId as string)
    if (hasRc) rcIds.add(r.revenueCenterId as string)
  }

  if (locationIds.size) {
    const found = await prisma.location.findMany({
      where: { id: { in: [...locationIds] } }, select: { id: true },
    })
    if (found.length !== locationIds.size) return 'One or more referenced locations do not exist.'
  }
  if (rcIds.size) {
    const found = await prisma.revenueCenter.findMany({
      where: { id: { in: [...rcIds] } }, select: { id: true },
    })
    if (found.length !== rcIds.size) return 'One or more referenced revenue centers do not exist.'
  }
  return null
}

/**
 * Dedup by target node; the DB index is NULLS NOT DISTINCT but dedup keeps
 * createMany from throwing on an obvious double-click.
 *
 * Keeps the FIRST occurrence of each node — if a duplicate row for the same
 * node carries a different `clearance`, that later value is silently dropped
 * in favor of the one already seen.
 */
export function dedupeAssignmentRows(rows: AssignmentInput[]): Array<{
  locationId: string | null; revenueCenterId: string | null; clearance: Role | null
}> {
  const seen = new Set<string>()
  return rows
    .map(r => ({
      locationId: r.locationId ?? null,
      revenueCenterId: r.revenueCenterId ?? null,
      clearance: r.clearance ?? null,
    }))
    .filter(r => {
      const key = keyOf(r)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
