import 'server-only'
import type { Role, User } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { resolveEffective, type EffectiveEntry, type RcNode } from '@/lib/access-model'

export type { ScopeRow, RcNode, EffectiveEntry } from '@/lib/access-model'
export { resolveEffective } from '@/lib/access-model'

/** Every active RC in the business, shaped for `resolveEffective`. */
async function allRcNodes(): Promise<RcNode[]> {
  const rows = await prisma.revenueCenter.findMany({
    where: { isActive: true },
    select: { id: true, name: true, locationId: true, location: { select: { name: true } } },
    orderBy: { name: 'asc' },
  })
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    locationId: r.locationId,
    locationName: r.location.name,
  }))
}

/**
 * The user's access, one entry per revenue center.
 *
 * OWNER and ADMIN are unrestricted by design and resolve to every active RC at
 * their primary clearance, matching resolveScopedRcIds()'s `null` fast-path.
 */
export async function effectiveAccess(user: User): Promise<EffectiveEntry[]> {
  const rcs = await allRcNodes()

  if (user.role === 'OWNER' || user.role === 'ADMIN') {
    return rcs.map(rc => ({
      rcId: rc.id,
      rcName: rc.name,
      locationId: rc.locationId,
      locationName: rc.locationName,
      clearance: user.role,
      source: 'inherited' as const,
    }))
  }

  const scopes = await prisma.userScope.findMany({
    where: { userId: user.id },
    select: { locationId: true, revenueCenterId: true, clearance: true },
  })
  return resolveEffective(user.role, scopes, rcs)
}

/** The clearance that applies at one RC, or null when the RC is out of reach. */
export async function clearanceForRc(user: User, rcId: string): Promise<Role | null> {
  const all = await effectiveAccess(user)
  return all.find(e => e.rcId === rcId)?.clearance ?? null
}
