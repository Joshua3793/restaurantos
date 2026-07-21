import 'server-only'
import { prisma } from '@/lib/prisma'
import { User } from '@prisma/client'
import { AuthError } from '@/lib/auth'
import { atLeast } from '@/lib/roles'

/**
 * Resolves the set of leaf RevenueCenter ids a user may read.
 * Returns `null` to mean "NO RESTRICTION" (all revenue centers) — this is the
 * backward-compatible default for ADMINs and any user with zero scope rows, so
 * the app keeps working before any assignments exist. A scope assignment only
 * ever NARROWS access.
 *
 * - OWNER / ADMIN               → null (all)
 * - user with no UserScope rows → null (all)
 * - scope row with locationId   → every RC under that location
 * - scope row with revenueCenterId → that RC
 */
export async function resolveScopedRcIds(user: User): Promise<Set<string> | null> {
  if (atLeast(user.role, 'ADMIN')) return null
  const scopes = await prisma.userScope.findMany({ where: { userId: user.id } })
  if (scopes.length === 0) return null

  const ids = new Set<string>()
  const locationIds = scopes.map(s => s.locationId).filter((x): x is string => !!x)
  if (locationIds.length) {
    const rcs = await prisma.revenueCenter.findMany({
      where: { locationId: { in: locationIds } },
      select: { id: true },
    })
    rcs.forEach(rc => ids.add(rc.id))
  }
  scopes
    .map(s => s.revenueCenterId)
    .filter((x): x is string => !!x)
    .forEach(id => ids.add(id))
  return ids
}

/** True if the user may access rcId. `null` allowed-set means no restriction. */
export async function isRcInScope(user: User, rcId: string): Promise<boolean> {
  const allowed = await resolveScopedRcIds(user)
  return allowed === null || allowed.has(rcId)
}

/**
 * Builds the Prisma `where.revenueCenterId`-style fragment for an RC-scoped list
 * query, merging an explicit selected `rcId` with the caller's resolved scope.
 * Mirrors the app's existing default-RC pattern (default RC also shows null/shared rows).
 *
 * @param allowed   result of resolveScopedRcIds (null = no restriction)
 * @param rcId      the explicitly selected RC (or null = "all in scope")
 * @param isDefault whether the selected RC is the default stock-pool RC.
 *                  ⚠️ Only pass `true` for models whose `revenueCenterId` column
 *                  is NULLABLE (e.g. CountSession, InvoiceSession, Recipe). It emits
 *                  `{ revenueCenterId: null }` to surface shared rows, which Prisma
 *                  REJECTS on a required column (PrismaClientValidationError → 500).
 *                  For NOT NULL models (SalesEntry, WastageLog) pass `false`.
 */
export function scopedRcWhere(
  allowed: Set<string> | null,
  rcId: string | null,
  isDefault: boolean,
): Record<string, unknown> {
  // Fail closed: an explicitly selected RC outside the user's scope matches nothing.
  if (rcId && allowed !== null && !allowed.has(rcId)) {
    return { revenueCenterId: { in: [] } }
  }
  if (rcId && isDefault) {
    // default RC also surfaces shared (null) rows
    return { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
  }
  if (rcId) {
    return { revenueCenterId: rcId }
  }
  // no explicit RC → everything in scope (or all, if unrestricted)
  return allowed === null ? {} : { revenueCenterId: { in: [...allowed] } }
}

/**
 * Resolves a LOCATION to the set of active child RevenueCenter ids the caller
 * may read. Intersects the location's children with the user's resolved scope
 * (null scope = no restriction). Returns [] for an empty / fully out-of-scope
 * location — an empty `{ in: [] }` fails closed (matches nothing).
 */
export async function resolveLocationRcIds(user: User, locationId: string): Promise<string[]> {
  const allowed = await resolveScopedRcIds(user)
  const rcs = await prisma.revenueCenter.findMany({
    where: { locationId, isActive: true },
    select: { id: true },
  })
  const ids = rcs.map(rc => rc.id)
  return allowed === null ? ids : ids.filter(id => allowed.has(id))
}

/**
 * Builds the Prisma `revenueCenterId` where-fragment from a request's scope
 * params, supporting BOTH a single `rcId` and a whole-LOCATION `locationId`.
 *  - locationId present → filter to every active child RC of the location
 *    (intersected with scope). `nullable: true` also surfaces shared null rows.
 *  - else → delegate to scopedRcWhere (single-RC, or all-in-scope when no rcId).
 *
 * @param opts.nullable pass true ONLY for models whose revenueCenterId column is
 *   NULLABLE (CountSession, InvoiceSession, Recipe…). For NOT NULL models
 *   (SalesEntry, WastageLog) pass false — a `{ revenueCenterId: null }` union
 *   throws on a required column.
 */
export async function scopeWhereFromParams(
  user: User,
  searchParams: URLSearchParams,
  opts: { nullable: boolean },
): Promise<Record<string, unknown>> {
  const rcId = searchParams.get('rcId')
  const locationId = searchParams.get('locationId')
  const isDefault = searchParams.get('isDefault') === 'true'
  if (locationId) {
    const ids = await resolveLocationRcIds(user, locationId)
    const base = { revenueCenterId: { in: ids } }
    return opts.nullable ? { OR: [base, { revenueCenterId: null }] } : base
  }
  const allowed = await resolveScopedRcIds(user)
  return scopedRcWhere(allowed, rcId, opts.nullable && isDefault)
}

/**
 * Throws AuthError(403) if the user may not write to `rcId`.
 * Writes MUST target a leaf revenue center — a missing rcId (e.g. a write that
 * named only a location) is rejected. OWNER / ADMIN / unscoped users pass any real rcId.
 */
export async function assertRcWritable(user: User, rcId: string | null | undefined): Promise<void> {
  if (!rcId) {
    throw new AuthError(403, 'A revenue center must be selected (writes cannot target a location).')
  }
  if (!(await isRcInScope(user, rcId))) {
    throw new AuthError(403, 'Revenue center is outside your access.')
  }
}
