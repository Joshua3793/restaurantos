// Pure clearance vocabulary. Deliberately has NO `server-only` marker and NO
// value imports from @prisma/client: src/middleware.ts runs in a restricted
// runtime and must be able to import this. `import type` is erased at compile
// time, so the Prisma Role union costs nothing at runtime.
import type { Role } from '@prisma/client'

/**
 * Clearance strength. LEAD sits BELOW MANAGER on purpose: every pre-existing
 * requireSession('MANAGER') / requireSession('ADMIN') call site keeps its exact
 * meaning, and OWNER passes all of them.
 */
export const ROLE_RANK: Record<Role, number> = {
  STAFF: 0,
  LEAD: 1,
  MANAGER: 2,
  ADMIN: 3,
  OWNER: 4,
}

/** Highest clearance first — the order the ladder and pickers render in. */
export const ROLE_ORDER: Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'LEAD', 'STAFF']

export function atLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min]
}

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  LEAD: 'Shift Lead',
  STAFF: 'Staff',
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  OWNER: 'The business. Everything, everywhere — plus billing and managing admins.',
  ADMIN: 'Full operations + setup across assigned locations. Invites and manages users.',
  MANAGER: 'Prep, count, invoices, sales, cost & reports for their scope.',
  LEAD: 'Everything Staff can do plus wastage, EOD close, and read-only invoices.',
  STAFF: 'Count, prep to-do, temps for their assigned RC. Never sees cost or money.',
}

/** Pill classes. Flat tokens only — numbered Tailwind colors are broken here. */
export const ROLE_COLORS: Record<Role, string> = {
  OWNER: 'bg-ink text-white',
  ADMIN: 'bg-blue-soft text-blue-text',
  MANAGER: 'bg-gold-soft text-gold-2',
  LEAD: 'bg-teal-soft text-teal-text',
  STAFF: 'bg-bg-2 text-ink-3',
}

/** Solid swatch, for dots and level-picker chips. */
export const ROLE_DOT: Record<Role, string> = {
  OWNER: 'bg-ink',
  ADMIN: 'bg-blue',
  MANAGER: 'bg-gold',
  LEAD: 'bg-teal',
  STAFF: 'bg-ink-4',
}

/**
 * Levels `actor` may hand out. OWNER is never returned: the seat is
 * single-occupancy (enforced by the User_single_owner partial index) and
 * non-transferable in this slice.
 *
 * MANAGER's entry is written now but is not reachable yet — /setup is still
 * ADMIN-gated in middleware. It becomes live with the enforcement spec.
 */
export function assignableLevels(actor: Role): Role[] {
  switch (actor) {
    case 'OWNER':
    case 'ADMIN':
      return ['ADMIN', 'MANAGER', 'LEAD', 'STAFF']
    case 'MANAGER':
      return ['LEAD', 'STAFF']
    default:
      return []
  }
}
