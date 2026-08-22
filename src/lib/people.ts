// The Person projection: one row per human, over User ⟕ Cook.
//
// User and Cook are deliberately NOT 1:1 — most cooks have no login, and some
// logins (the bookkeeper) have no roster row. Both halves are optional; at
// least one is always present.
//
// Pure and client-safe: NO `server-only` marker and no value imports from
// @prisma/client, so both the API route and the hub's client components can
// import it.
import type { Role } from '@prisma/client'
import { atLeast } from '@/lib/roles'

export interface PersonScope {
  id: string
  locationId: string | null
  locationName: string | null
  revenueCenterId: string | null
  rcName: string | null
  clearance: Role | null
}

/** The app-login half. */
export interface PersonLogin {
  id: string
  email: string
  name: string | null
  role: Role
  isActive: boolean
  /** Created inactive at invite time and never accepted — not a deactivation. */
  isPending: boolean
  createdAt: string
  assignments: PersonScope[]
}

/** The roster half. Decimals are already Number()'d at the API boundary. */
export interface PersonRoster {
  id: string
  name: string
  lastName: string | null
  initials: string
  homeStation: string | null
  isActive: boolean
  sortOrder: number
  clockId: string | null
  posPosition: string | null
  wage: number | null
  dailyHourCap: number | null
  tipRoleId: string | null
  onTipPool: boolean
}

export interface Person {
  /** `userId`, or `cook:<cookId>` for a roster row with no login. */
  key: string
  login: PersonLogin | null
  roster: PersonRoster | null
}

export type PersonWarningCode = 'POOL_NO_CLOCK' | 'NAME_DIVERGENCE' | 'NO_ASSIGNMENTS'

export interface PersonWarning {
  code: PersonWarningCode
  message: string
}

/** "Mia Chen" — no trailing space when there is no last name. */
export function rosterFullName(r: PersonRoster): string {
  return [r.name, r.lastName].filter(Boolean).join(' ').trim()
}

/**
 * Build the person list. `linked` is every User with its Cook relation (which
 * may be null); `orphanRosters` is every Cook with userId IS NULL. A cook that
 * IS linked arrives inside `linked` and must not also appear in
 * `orphanRosters` — the caller's `where: { userId: null }` guarantees that.
 *
 * Logins first, then orphan roster rows, so the list order is stable regardless
 * of how the two queries resolve.
 */
export function mergePeople(
  linked: Array<{ login: PersonLogin; roster: PersonRoster | null }>,
  orphanRosters: PersonRoster[],
): Person[] {
  return [
    ...linked.map(({ login, roster }) => ({ key: login.id, login, roster })),
    ...orphanRosters.map(roster => ({ key: `cook:${roster.id}`, login: null, roster })),
  ]
}

/**
 * Account name wins, then the roster name, then the email.
 *
 * NOTE: this is display-only. The two names are never written to each other —
 * Cook.name is the short first name on run-sheet chips.
 */
export function displayName(p: Person): string {
  if (p.login?.name) return p.login.name
  if (p.roster) {
    const full = rosterFullName(p.roster)
    if (full) return full
  }
  return p.login?.email ?? 'Unnamed'
}

export function personWarnings(p: Person): PersonWarning[] {
  const out: PersonWarning[] = []

  // Hours match on clockId and NOTHING else (Cook.clockId). An on-pool person
  // without one is a silent zero that nobody discovers until payday.
  if (p.roster && p.roster.isActive && p.roster.onTipPool && !p.roster.clockId) {
    out.push({
      code: 'POOL_NO_CLOCK',
      message: 'On the tip pool but has no clock ID — no hours will match, so this person earns nothing.',
    })
  }

  if (p.login?.name && p.roster) {
    const full = rosterFullName(p.roster)
    if (full && full !== p.login.name) {
      out.push({
        code: 'NAME_DIVERGENCE',
        message: `Account name "${p.login.name}" differs from roster name "${full}". Both are kept — the roster name is what shows on prep chips.`,
      })
    }
  }

  // A non-global clearance with zero assignments has no access at all. ADMIN
  // and OWNER reach every revenue center by role, so it is not a warning there.
  if (p.login && p.login.assignments.length === 0 && !atLeast(p.login.role, 'ADMIN')) {
    out.push({
      code: 'NO_ASSIGNMENTS',
      message: 'No assignments — this person currently sees all revenue centers.',
    })
  }

  return out
}

/** Search over display name, roster name, email and clock #. */
export function matchesQuery(p: Person, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    displayName(p),
    p.roster ? rosterFullName(p.roster) : '',
    p.login?.email ?? '',
    p.roster?.clockId ?? '',
  ]
  return haystack.some(h => h.toLowerCase().includes(q))
}
