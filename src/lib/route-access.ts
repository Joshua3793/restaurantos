// The ONE route -> clearance table. Both src/middleware.ts (server-side
// enforcement) and src/components/Navigation.tsx (dim + lock) read it, so the
// menu can never again advertise a page the middleware bounces.
//
// Deliberately has NO `server-only` marker and NO value imports from
// @prisma/client: src/middleware.ts runs in a restricted runtime and must be
// able to import this. `import type` is erased at compile time.
import type { Role } from '@prisma/client'
import { atLeast } from '@/lib/roles'

/**
 * Route prefix -> minimum clearance. A prefix covers the route itself and all
 * of its children. Longest matching prefix wins, so a narrower entry can be
 * appended anywhere in the array to override a broader one.
 *
 * `/cost` is inert in practice — the v2 REDIRECTS table in middleware rewrites
 * /cost -> /reports before the role check runs — but it is kept so this table
 * is a faithful copy of the gates it replaced.
 */
export const ROUTE_CLEARANCE: ReadonlyArray<readonly [string, Role]> = [
  ['/setup', 'ADMIN'],
  ['/settings', 'ADMIN'],
  ['/pass', 'MANAGER'],
  ['/reports', 'MANAGER'],
  ['/cost', 'MANAGER'],
  ['/variance', 'MANAGER'],
  ['/signals', 'MANAGER'],
  ['/end-of-day', 'LEAD'],
] as const

/**
 * Clearance needed to open `pathname`, or null when it is open to STAFF+.
 *
 * `table` is a seam for tests: the live table has no nested prefixes, so the
 * longest-wins rule can only be exercised against a synthetic one. Production
 * callers pass one argument.
 */
export function requiredClearance(
  pathname: string,
  table: ReadonlyArray<readonly [string, Role]> = ROUTE_CLEARANCE,
): Role | null {
  let bestPrefix = ''
  let bestRole: Role | null = null
  for (const [prefix, role] of table) {
    // Segment match, not string match: '/passport' must not inherit '/pass'.
    const hit = pathname === prefix || pathname.startsWith(prefix + '/')
    if (hit && prefix.length > bestPrefix.length) {
      bestPrefix = prefix
      bestRole = role
    }
  }
  return bestRole
}

/**
 * True when `role` may open `pathname`.
 *
 * A null role (clearance not loaded yet) is denied on every gated route — never
 * grant on unknown. Callers that want to avoid a loading flash should check
 * `role != null` themselves rather than treating null as permitted.
 */
export function canAccess(role: Role | null, pathname: string): boolean {
  const need = requiredClearance(pathname)
  if (need === null) return true
  if (role === null) return false
  return atLeast(role, need)
}
