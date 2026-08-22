# People Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three scattered people-editing surfaces with one ADMIN hub at `/setup/users` where a row is a *Person* (a projection over `User` ⟕ `Cook`) with four tabs — Identity, Access, Prep, Tips.

**Architecture:** No schema change. One new read endpoint (`GET /api/settings/people`) composes users, orphan cooks, and the three lookup sets the editors need. One new create-only orchestrator (`POST /api/settings/people`). Every *edit* routes through the handlers that already exist, so `clockId`/`userId` uniqueness, the P2002 race handling, the access-audit writes and the two-store Supabase↔Prisma sync are never reimplemented. The merge/warning rules live in a pure lib under vitest.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Tailwind (flat color tokens) · lucide-react · vitest

**Spec:** `docs/superpowers/specs/2026-08-21-people-hub-design.md`

**Branch base:** `main`, **after** PR #101 (`feat/staff-tip-payouts`) and PR #102
(`fix/prep-cooks-payroll-leak`) have both merged. PR #101 is a hard prerequisite —
`Cook.userId` and `PATCH /api/tips/roster/[id] { userId }` do not exist on main
without it, and the entire Identity tab rests on them. PR #102 supersedes Task 5.

## Global Constraints

- **Never sync `User.name` ↔ `Cook.name`.** `Cook.name` is the short first name that renders on run-sheet chips and seeds `initials`.
- **Never infer the login↔roster link** from a name or email. It is always set deliberately (`prisma/schema.prisma:759`).
- **Tailwind numbered color classes are broken in this repo.** Use flat tokens only: `bg-red`, `text-red-text`, `bg-red-soft`, `bg-gold`, `text-gold-2`, `bg-gold-soft`, `bg-green-soft`, `text-green-text`, `bg-teal-soft`, `text-teal-text`, `bg-blue-soft`, `text-blue-text`, `bg-ink`, `text-ink`, `text-ink-2`, `text-ink-3`, `text-ink-4`, `bg-bg`, `bg-bg-2`, `bg-paper`, `border-line`.
- **Every new route file must `export const dynamic = 'force-dynamic'`.** A GET handler without it is statically prerendered and every non-GET method on the route returns 405.
- **Prisma `Decimal` serializes to a string in JSON.** `wage` and `dailyHourCap` must be passed through `Number()` at the API boundary, not in the component.
- **Prisma singleton only:** `import { prisma } from '@/lib/prisma'`. Never `new PrismaClient()`.
- **Auth in API routes:** `await requireSession('ADMIN')` from `@/lib/auth`, catching `AuthError` and returning `{ error }` with `err.status`.
- **Mobile split is `md:`**, not `sm:` — matching the newer prep/count/today renderers.
- Sub-components must be defined at module scope. A helper defined inside a client component body remounts every render and loses focus.
- `npm test` must pass after every task that touches `src/lib` or an API route. `npm run build` is the type check — run it from an isolated worktree, since a main-checkout build fails spuriously while the dev server is running.

---

### Task 1: The pure Person projection lib

**Files:**
- Create: `src/lib/people.ts`
- Test: `src/lib/__tests__/people.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PersonScope`, `PersonLogin`, `PersonRoster`, `Person`, `mergePeople(linked, orphanRosters): Person[]`, `displayName(p): string`, `personWarnings(p): PersonWarning[]`, `matchesQuery(p, q): boolean`, `rosterFullName(r): string`. Tasks 3, 4, 6, 7, 8, 9 and 10 all import from here.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/people.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  mergePeople, displayName, personWarnings, matchesQuery, rosterFullName,
  type PersonLogin, type PersonRoster,
} from '@/lib/people'

const login = (over: Partial<PersonLogin> = {}): PersonLogin => ({
  id: 'u1', email: 'mia@fergies.test', name: 'Mia Chen', role: 'STAFF',
  isActive: true, isPending: false, createdAt: '2026-01-01T00:00:00.000Z',
  assignments: [], ...over,
})

const roster = (over: Partial<PersonRoster> = {}): PersonRoster => ({
  id: 'c1', name: 'Mia', lastName: 'Chen', initials: 'MC', homeStation: 'Hot',
  isActive: true, sortOrder: 0, clockId: '1204', posPosition: 'Line Cook',
  wage: 22.5, dailyHourCap: 8, tipRoleId: 'r1', onTipPool: true, ...over,
})

describe('mergePeople', () => {
  it('keys a linked person by their user id', () => {
    const [p] = mergePeople([{ login: login(), roster: roster() }], [])
    expect(p.key).toBe('u1')
    expect(p.login?.id).toBe('u1')
    expect(p.roster?.id).toBe('c1')
  })

  it('keys a roster-only person by a cook-prefixed id so it cannot collide with a user id', () => {
    const [p] = mergePeople([], [roster({ id: 'c9' })])
    expect(p.key).toBe('cook:c9')
    expect(p.login).toBeNull()
  })

  it('keeps a login with no roster row', () => {
    const [p] = mergePeople([{ login: login(), roster: null }], [])
    expect(p.roster).toBeNull()
  })

  it('lists logins before orphan roster rows', () => {
    const out = mergePeople([{ login: login(), roster: null }], [roster({ id: 'c9' })])
    expect(out.map(p => p.key)).toEqual(['u1', 'cook:c9'])
  })

  it('includes an orphan roster row exactly once', () => {
    const out = mergePeople([{ login: login(), roster: roster() }], [roster({ id: 'c9' })])
    expect(out.filter(p => p.roster?.id === 'c9')).toHaveLength(1)
  })
})

describe('displayName', () => {
  it('prefers the account name', () => {
    const [p] = mergePeople([{ login: login({ name: 'Mia Chen' }), roster: roster({ name: 'Mia' }) }], [])
    expect(displayName(p)).toBe('Mia Chen')
  })

  it('falls back to the roster name when the account has none', () => {
    const [p] = mergePeople([{ login: login({ name: null }), roster: roster() }], [])
    expect(displayName(p)).toBe('Mia Chen')
  })

  it('falls back to the email when there is no name anywhere', () => {
    const [p] = mergePeople([{ login: login({ name: null }), roster: null }], [])
    expect(displayName(p)).toBe('mia@fergies.test')
  })

  it('uses the roster name for a roster-only person', () => {
    const [p] = mergePeople([], [roster({ lastName: null })])
    expect(displayName(p)).toBe('Mia')
  })
})

describe('rosterFullName', () => {
  it('joins first and last', () => {
    expect(rosterFullName(roster())).toBe('Mia Chen')
  })
  it('omits a null last name without a trailing space', () => {
    expect(rosterFullName(roster({ lastName: null }))).toBe('Mia')
  })
})

describe('personWarnings', () => {
  it('flags an on-pool person with no clock id — hours match on clockId alone, so they earn nothing', () => {
    const [p] = mergePeople([], [roster({ clockId: null, onTipPool: true })])
    expect(personWarnings(p).map(w => w.code)).toContain('POOL_NO_CLOCK')
  })

  it('does not flag an off-pool person with no clock id', () => {
    const [p] = mergePeople([], [roster({ clockId: null, onTipPool: false })])
    expect(personWarnings(p).map(w => w.code)).not.toContain('POOL_NO_CLOCK')
  })

  it('does not flag an inactive roster row', () => {
    const [p] = mergePeople([], [roster({ clockId: null, onTipPool: true, isActive: false })])
    expect(personWarnings(p).map(w => w.code)).not.toContain('POOL_NO_CLOCK')
  })

  it('flags account/roster name divergence', () => {
    const [p] = mergePeople([{ login: login({ name: 'Mia Chen' }), roster: roster({ name: 'Amelia', lastName: 'Chen' }) }], [])
    expect(personWarnings(p).map(w => w.code)).toContain('NAME_DIVERGENCE')
  })

  it('does not flag matching names', () => {
    const [p] = mergePeople([{ login: login({ name: 'Mia Chen' }), roster: roster() }], [])
    expect(personWarnings(p).map(w => w.code)).not.toContain('NAME_DIVERGENCE')
  })

  it('flags a non-global login with zero assignments', () => {
    const [p] = mergePeople([{ login: login({ role: 'STAFF', assignments: [] }), roster: null }], [])
    expect(personWarnings(p).map(w => w.code)).toContain('NO_ASSIGNMENTS')
  })

  it('does not flag an ADMIN with zero assignments — clearance reaches every RC regardless', () => {
    const [p] = mergePeople([{ login: login({ role: 'ADMIN', assignments: [] }), roster: null }], [])
    expect(personWarnings(p).map(w => w.code)).not.toContain('NO_ASSIGNMENTS')
  })

  it('never flags NO_ASSIGNMENTS on a roster-only person — a cook with no login is normal', () => {
    const [p] = mergePeople([], [roster()])
    expect(personWarnings(p).map(w => w.code)).not.toContain('NO_ASSIGNMENTS')
  })
})

describe('matchesQuery', () => {
  const [linked] = mergePeople([{ login: login(), roster: roster() }], [])

  it('matches on display name, case-insensitively', () => {
    expect(matchesQuery(linked, 'mia')).toBe(true)
  })
  it('matches on email', () => {
    expect(matchesQuery(linked, 'fergies.test')).toBe(true)
  })
  it('matches on clock id', () => {
    expect(matchesQuery(linked, '1204')).toBe(true)
  })
  it('matches on the roster name even when the account name differs', () => {
    const [p] = mergePeople([{ login: login({ name: 'Amelia Chen' }), roster: roster({ name: 'Mia' }) }], [])
    expect(matchesQuery(p, 'mia')).toBe(true)
  })
  it('returns true for an empty query', () => {
    expect(matchesQuery(linked, '  ')).toBe(true)
  })
  it('returns false for a miss', () => {
    expect(matchesQuery(linked, 'zzz')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/lib/__tests__/people.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/people"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/people.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/lib/__tests__/people.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Run the whole suite to confirm nothing regressed**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/people.ts src/lib/__tests__/people.test.ts
git commit -m "feat(people): pure Person projection over User + Cook"
```

---

### Task 2: Extract the invite logic into a reusable lib

`POST /api/settings/users` currently inlines ~200 lines of invite logic in a `for` loop. Task 4's create endpoint needs exactly that logic for a single email. Extract it *first*, unchanged in behaviour, so there is one implementation rather than two.

**Files:**
- Create: `src/lib/user-invite.ts`
- Create: `src/app/api/settings/users/__tests__/invite.test.ts`
- Modify: `src/app/api/settings/users/route.ts` (replace the loop body with a call)

**Interfaces:**
- Consumes: `AssignmentInput`, `dedupeAssignmentRows` from `@/lib/assignment-input`; `recordAccessEvent` from `@/lib/access-audit`; `isAlreadyRegisteredError`, `findAuthUserByEmail`, `hasAcceptedInvite` from `@/lib/users`.
- Produces: `inviteOne(opts: InviteOptions): Promise<InviteResult>` and `interface InviteResult { email; status: 'invited'|'reinvited'|'reactivated'|'failed'|'inconsistent'; userId?: string; error?: string; warning?: string }`. Task 4 calls `inviteOne`.

- [ ] **Step 1: Write the characterization test**

There are no tests on this route today, so the extraction has no safety net. Write one first. Create `src/app/api/settings/users/__tests__/invite.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same vi.mock-of-Prisma pattern as src/app/api/tips/roster/__tests__/route.test.ts.
const userDeleteMany = vi.fn(async () => ({ count: 0 }))
const userCreate = vi.fn(async (args: { data: { id: string; email: string } }) => args.data)
const userFindUnique = vi.fn(async () => null as { role?: string; name?: string | null; isActive?: boolean } | null)
const userUpsert = vi.fn(async () => ({ id: 'auth-1' }))
const userUpdate = vi.fn(async () => ({ id: 'auth-1' }))
const userScopeCreateMany = vi.fn(async () => ({ count: 0 }))
const userScopeDeleteMany = vi.fn(async () => ({ count: 0 }))
const userScopeFindMany = vi.fn(async () => [] as unknown[])
const recordAccessEvent = vi.fn(async () => undefined)

const inviteUserByEmail = vi.fn(async () => ({ data: { user: { id: 'auth-1' } }, error: null as { message: string } | null }))
const updateUserById = vi.fn(async () => ({ error: null as { message: string } | null }))
const deleteUser = vi.fn(async () => ({ error: null }))

const tx = {
  user: {
    deleteMany: (...a: unknown[]) => userDeleteMany(...(a as [])),
    create: (...a: unknown[]) => userCreate(...(a as [{ data: { id: string; email: string } }])),
    upsert: (...a: unknown[]) => userUpsert(...(a as [])),
    update: (...a: unknown[]) => userUpdate(...(a as [])),
  },
  userScope: {
    createMany: (...a: unknown[]) => userScopeCreateMany(...(a as [])),
    deleteMany: (...a: unknown[]) => userScopeDeleteMany(...(a as [])),
  },
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...(a as [])),
    },
    userScope: {
      findMany: (...a: unknown[]) => userScopeFindMany(...(a as [])),
    },
  },
}))
vi.mock('@/lib/access-audit', () => ({
  recordAccessEvent: (...a: unknown[]) => recordAccessEvent(...(a as [])),
}))
vi.mock('@/lib/users', () => ({
  isAlreadyRegisteredError: (e: { message?: string } | null) => !!e && /already registered/i.test(e.message ?? ''),
  findAuthUserByEmail: async () => ({ id: 'auth-1', email_confirmed_at: '2026-01-01T00:00:00Z' }),
  hasAcceptedInvite: (u: { email_confirmed_at?: string | null }) => !!u.email_confirmed_at,
}))

const { inviteOne } = await import('@/lib/user-invite')

const supabaseAdmin = {
  auth: { admin: { inviteUserByEmail, updateUserById, deleteUser } },
} as unknown as Parameters<typeof inviteOne>[0]['supabaseAdmin']

const opts = () => ({
  email: 'sam@fergies.test',
  role: 'STAFF' as const,
  name: 'Sam Lee',
  assignments: [{ locationId: 'loc1', revenueCenterId: null, clearance: null }],
  actor: { id: 'u9', email: 'admin@fergies.test', name: 'Admin' },
  appUrl: 'https://app.test',
  supabaseAdmin,
})

beforeEach(() => {
  vi.clearAllMocks()
  inviteUserByEmail.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null })
  updateUserById.mockResolvedValue({ error: null })
  userFindUnique.mockResolvedValue(null)
  userScopeFindMany.mockResolvedValue([])
  userCreate.mockImplementation(async (args) => args.data)
})

describe('inviteOne', () => {
  it('sends a fresh invite and returns the new auth user id', async () => {
    const res = await inviteOne(opts())
    expect(res.status).toBe('invited')
    expect(res.userId).toBe('auth-1')
    expect(inviteUserByEmail).toHaveBeenCalledTimes(1)
  })

  it('creates the Prisma row inactive — it is activated by /auth/callback on accept', async () => {
    await inviteOne(opts())
    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isActive: false }) }),
    )
  })

  it('writes the scope rows in the same transaction as the user row', async () => {
    await inviteOne(opts())
    expect(userScopeCreateMany).toHaveBeenCalledTimes(1)
  })

  it('reports a plain invite failure without touching Prisma', async () => {
    inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: { message: 'SMTP down' } })
    const res = await inviteOne(opts())
    expect(res.status).toBe('failed')
    expect(res.error).toBe('SMTP down')
    expect(userCreate).not.toHaveBeenCalled()
  })

  it('refuses to touch the owner seat', async () => {
    inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: { message: 'User already registered' } })
    userFindUnique.mockResolvedValueOnce({ role: 'OWNER' })
    const res = await inviteOne(opts())
    expect(res.status).toBe('failed')
    expect(res.error).toContain('owner')
    expect(userUpsert).not.toHaveBeenCalled()
  })

  it('reactivates an already-accepted account in place and returns its id', async () => {
    inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: { message: 'User already registered' } })
    userFindUnique
      .mockResolvedValueOnce({ role: 'STAFF' })                                   // owner pre-check
      .mockResolvedValueOnce({ name: 'Sam Lee', role: 'STAFF', isActive: false }) // prior snapshot
    const res = await inviteOne(opts())
    expect(res.status).toBe('reactivated')
    expect(res.userId).toBe('auth-1')
    expect(userUpsert).toHaveBeenCalledTimes(1)
  })

  it('reverts Prisma when the Supabase metadata write fails, so the two stores cannot diverge', async () => {
    inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: { message: 'User already registered' } })
    userFindUnique
      .mockResolvedValueOnce({ role: 'STAFF' })
      .mockResolvedValueOnce({ name: 'Sam Lee', role: 'STAFF', isActive: false })
    updateUserById.mockResolvedValueOnce({ error: { message: 'supabase 503' } })
    const res = await inviteOne(opts())
    expect(res.status).toBe('failed')
    expect(res.error).toContain('supabase 503')
    expect(userUpdate).toHaveBeenCalled() // the compensating revert
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/app/api/settings/users/__tests__/invite.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/user-invite"`.

- [ ] **Step 3: Create the lib by moving the loop body verbatim**

Create `src/lib/user-invite.ts`. This is a **pure move** — copy the body of the `for (const email of emails)` loop from `src/app/api/settings/users/route.ts:139-346` unchanged, including every comment, and re-shape only its inputs and outputs. Do not "improve" any of it: the transaction boundaries, the revert compensation and the audit-failure handling are all load-bearing.

```ts
// The invite/re-invite/reactivate flow for ONE email, extracted verbatim from
// POST /api/settings/users so the People hub's create endpoint can reuse it
// rather than growing a second copy. Behaviour is unchanged.
import 'server-only'
import type { Role } from '@prisma/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { prisma } from '@/lib/prisma'
import { recordAccessEvent } from '@/lib/access-audit'
import { findAuthUserByEmail, hasAcceptedInvite, isAlreadyRegisteredError } from '@/lib/users'

export interface InviteOptions {
  email: string
  role: Role
  name: string | null
  /** Already validated and deduped by the caller. */
  assignments: Array<{ locationId: string | null; revenueCenterId: string | null; clearance: Role | null }>
  actor: { id: string; email: string; name: string | null }
  appUrl: string
  supabaseAdmin: SupabaseClient
}

export interface InviteResult {
  email: string
  status: 'invited' | 'reinvited' | 'reactivated' | 'failed' | 'inconsistent'
  /** The auth user id, present on every non-failure. The hub needs it to link a Cook. */
  userId?: string
  error?: string
  warning?: string
}

export async function inviteOne(opts: InviteOptions): Promise<InviteResult> {
  const { email, role, name, assignments, actor, appUrl, supabaseAdmin } = opts

  // Isolate this email's work: a thrown error (transaction failure against the
  // pooler, an audit write failure, …) must be reported as this email's own
  // outcome, never abort a caller's wider loop.
  try {
    const inviteMeta = { role, isActive: true, name }

    const sendInvite = async (action: 'INVITED' | 'REINVITED') => {
      const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
        data: inviteMeta,
        redirectTo: `${appUrl}/auth/callback`,
      })
      if (error || !data?.user) return { error }
      const newId = data.user.id
      // A re-invite mints a NEW auth UUID for an unchanged email, so any stale
      // Prisma row must be cleared before inserting the row keyed to the new
      // UUID. Both in ONE interactive transaction: under the pgBouncer
      // transaction-mode pooler two auto-commit statements can land such that
      // the delete isn't visible to the insert, yielding P2002 on email. The
      // audit write rides the same tx.
      const user = await prisma.$transaction(async (tx) => {
        await tx.user.deleteMany({ where: { email } })
        const created = await tx.user.create({
          data: { id: newId, email, name, role, isActive: false },
        })
        await tx.userScope.createMany({ data: assignments.map(a => ({ ...a, userId: newId })) })
        await recordAccessEvent(tx, {
          actor, target: { id: created.id, email, name }, action, detail: { to: role },
        })
        return created
      })
      return { user }
    }

    const first = await sendInvite('INVITED')
    if (first.user) return { email, status: 'invited', userId: first.user.id }
    if (!isAlreadyRegisteredError(first.error)) {
      return { email, status: 'failed', error: first.error?.message ?? 'Failed to send invite' }
    }

    const existing = await findAuthUserByEmail(supabaseAdmin, email)
    if (!existing) {
      return { email, status: 'failed', error: 'Email already has an unresolvable account.' }
    }

    // The owner's Prisma row is the single-occupancy seat (User_single_owner
    // partial unique index). The reactivate branch below would otherwise
    // overwrite its role and replace its UserScope rows — and since
    // assignableLevels() never returns OWNER, there is no in-app way back.
    // Reject before either branch writes anything.
    const existingPrismaUser = await prisma.user.findUnique({
      where: { id: existing.id }, select: { role: true },
    })
    if (existingPrismaUser?.role === 'OWNER') {
      return { email, status: 'failed', error: 'The owner cannot be changed. Transfer ownership first.' }
    }

    if (!hasAcceptedInvite(existing)) {
      await supabaseAdmin.auth.admin.deleteUser(existing.id)
      const retry = await sendInvite('REINVITED')
      if (retry.user) return { email, status: 'reinvited', userId: retry.user.id }
      return { email, status: 'failed', error: retry.error?.message ?? 'Failed to re-invite' }
    }

    // Accepted before → reactivate in place. Both stores, or neither.
    //
    // Prisma is authoritative for API access (requireSession reads it), so it's
    // written FIRST; Supabase user_metadata (what middleware reads for page
    // access) is written second. If Supabase then fails, we revert the Prisma
    // row + scopes rather than leave requireSession authorizing the new role
    // while middleware still gates on the old one.
    const priorUser = await prisma.user.findUnique({
      where: { id: existing.id }, select: { name: true, role: true, isActive: true },
    })
    const priorScopes = await prisma.userScope.findMany({
      where: { userId: existing.id },
      select: { locationId: true, revenueCenterId: true, clearance: true },
    })

    await prisma.$transaction(async (tx) => {
      const u = await tx.user.upsert({
        where: { id: existing.id },
        create: { id: existing.id, email, name, role, isActive: true },
        update: { role, name, isActive: true },
      })
      await tx.userScope.deleteMany({ where: { userId: existing.id } })
      await tx.userScope.createMany({ data: assignments.map(a => ({ ...a, userId: existing.id })) })
      return u
    })

    // updateUserById can fail two ways: it RETURNS { error }, or it THROWS
    // (network blip, Supabase 5xx). Both leave the same divergence, so both
    // must run the exact same compensation below.
    let metaError: { message: string } | null = null
    try {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(existing.id, {
        user_metadata: { role, isActive: true, name },
      })
      metaError = error
    } catch (e) {
      metaError = { message: e instanceof Error ? e.message : 'Supabase metadata update threw' }
    }

    if (metaError) {
      // The revert is itself a $transaction against the same pgBouncer
      // transaction-mode pooler. If IT throws, Prisma holds the new role/scopes
      // while Supabase has the old metadata and nothing will retry — a strictly
      // worse, silently-diverged outcome that must be reported distinctly.
      try {
        await prisma.$transaction(async (tx) => {
          if (priorUser) {
            await tx.user.update({
              where: { id: existing.id },
              data: { name: priorUser.name, role: priorUser.role, isActive: priorUser.isActive },
            })
          } else {
            await tx.user.deleteMany({ where: { id: existing.id } })
          }
          await tx.userScope.deleteMany({ where: { userId: existing.id } })
          if (priorScopes.length) {
            await tx.userScope.createMany({ data: priorScopes.map(s => ({ ...s, userId: existing.id })) })
          }
        })
        return { email, status: 'failed', error: metaError.message }
      } catch (revertError) {
        const revertMessage = revertError instanceof Error ? revertError.message : 'Unknown error'
        console.error(
          `[user-invite] reactivate revert failed for ${email} (user ${existing.id}): ` +
          `Prisma committed the new role/scopes, the Supabase metadata write failed ` +
          `(${metaError.message}), and the compensating revert transaction also failed ` +
          `(${revertMessage}). The two stores are now permanently diverged until an admin ` +
          `fixes this row by hand.`,
        )
        return {
          email,
          status: 'inconsistent',
          error:
            `${email}'s account is now in an inconsistent state: this person's app access ` +
            `and sign-in access disagree, and the automatic recovery failed. An admin must ` +
            `intervene manually.`,
        }
      }
    }

    // Both stores have committed. The audit write is secondary — a failure here
    // must not flip a real success to 'failed', and must not be swallowed.
    let auditWarning: string | undefined
    try {
      await recordAccessEvent(prisma, {
        actor, target: { id: existing.id, email, name },
        action: 'REACTIVATED', detail: { to: role },
      })
    } catch (auditError) {
      const auditMessage = auditError instanceof Error ? auditError.message : 'Unknown error'
      console.error(
        `[user-invite] REACTIVATED audit write failed for ${email} (user ${existing.id}) ` +
        `after both stores already committed the reactivation: ${auditMessage}`,
      )
      auditWarning = 'Reactivated, but the audit log entry failed to write.'
    }

    return { email, status: 'reactivated', userId: existing.id, ...(auditWarning ? { warning: auditWarning } : {}) }
  } catch (e) {
    return {
      email,
      status: 'failed',
      error: e instanceof Error ? e.message : 'Unexpected error while processing this invite',
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/app/api/settings/users/__tests__/invite.test.ts
```

Expected: PASS.

- [ ] **Step 5: Replace the loop body in the route**

In `src/app/api/settings/users/route.ts`, delete the entire `for (const email of emails) { … }` block (from `for (const email of emails) {` through its closing `}`) and replace it with:

```ts
  for (const email of emails) {
    results.push(await inviteOne({ email, role, name, assignments, actor, appUrl, supabaseAdmin }))
  }
```

Add the import at the top:

```ts
import { inviteOne, type InviteResult } from '@/lib/user-invite'
```

Change the `results` declaration from its inline object-literal type to:

```ts
  const results: InviteResult[] = []
```

Then remove any imports the route no longer uses — check each of `recordAccessEvent`, `findAuthUserByEmail`, `hasAcceptedInvite`, `isAlreadyRegisteredError` and remove only those with no remaining reference in the file. Leave `createAdminClient`, `prisma`, `validateAssignmentRows`, `dedupeAssignmentRows`, `assignableLevels`, `Role` — all are still used elsewhere in the file.

- [ ] **Step 6: Verify the extraction changed no behaviour**

```bash
npm test && npm run lint
```

Expected: PASS, with no unused-import warnings from `src/app/api/settings/users/route.ts`.

- [ ] **Step 7: Type-check**

```bash
npm run build
```

Expected: build succeeds. Confirm `/api/settings/users` still shows `ƒ (Dynamic)` in the route table.

- [ ] **Step 8: Commit**

```bash
git add src/lib/user-invite.ts src/app/api/settings/users/route.ts src/app/api/settings/users/__tests__/invite.test.ts
git commit -m "refactor(users): extract inviteOne into a reusable lib, with tests"
```

---

### Task 3: `GET /api/settings/people`

**Files:**
- Create: `src/app/api/settings/people/route.ts`
- Create: `src/app/api/settings/people/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `mergePeople`, `PersonLogin`, `PersonRoster`, `Person` from `@/lib/people`; `PREP_STATIONS` from `@/lib/prep-utils`.
- Produces: `GET` returning `{ people: Person[], locations: LocationNode[], tipRoles: TipRoleOption[], stations: string[] }`, where `LocationNode` is `{ id, name, color, revenueCenters: Array<{ id, name, color }> }` (identical to `GET /api/settings/users`) and `TipRoleOption` is `{ id: string; name: string; multiplier: number; sortOrder: number }`. Tasks 6–10 consume this.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/settings/people/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const userFindMany = vi.fn(async () => [] as unknown[])
const cookFindMany = vi.fn(async () => [] as unknown[])
const locationFindMany = vi.fn(async () => [] as unknown[])
const tipRoleFindMany = vi.fn(async () => [] as unknown[])
const prepSettingsFindUnique = vi.fn(async () => null as { stations: string[] } | null)
const requireSession = vi.fn(async () => ({ id: 'u9', role: 'ADMIN', isActive: true }))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findMany: (...a: unknown[]) => userFindMany(...(a as [])) },
    cook: { findMany: (...a: unknown[]) => cookFindMany(...(a as [])) },
    location: { findMany: (...a: unknown[]) => locationFindMany(...(a as [])) },
    tipRole: { findMany: (...a: unknown[]) => tipRoleFindMany(...(a as [])) },
    prepSettings: { findUnique: (...a: unknown[]) => prepSettingsFindUnique(...(a as [])) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))

const { GET } = await import('@/app/api/settings/people/route')
const { AuthError } = await import('@/lib/auth')

const dbCook = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'Mia', lastName: 'Chen', initials: 'MC', homeStation: 'Hot',
  isActive: true, sortOrder: 0, clockId: '1204', posPosition: 'Line Cook',
  wage: '22.5', dailyHourCap: '8', tipRoleId: 'r1', onTipPool: true, ...over,
})

const dbUser = (over: Record<string, unknown> = {}) => ({
  id: 'u1', email: 'mia@fergies.test', name: 'Mia Chen', role: 'STAFF',
  isActive: true, createdAt: new Date('2026-01-01T00:00:00Z'),
  scopes: [], cook: null, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  requireSession.mockResolvedValue({ id: 'u9', role: 'ADMIN', isActive: true })
  userFindMany.mockResolvedValue([])
  cookFindMany.mockResolvedValue([])
  locationFindMany.mockResolvedValue([])
  tipRoleFindMany.mockResolvedValue([])
  prepSettingsFindUnique.mockResolvedValue(null)
})

describe('GET /api/settings/people', () => {
  it('requires ADMIN', async () => {
    await GET()
    expect(requireSession).toHaveBeenCalledWith('ADMIN')
  })

  it('returns 403 for a MANAGER without touching the database', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(403, 'Forbidden'))
    const res = await GET()
    expect(res.status).toBe(403)
    expect(userFindMany).not.toHaveBeenCalled()
  })

  it('returns a linked person with both halves', async () => {
    userFindMany.mockResolvedValueOnce([dbUser({ cook: dbCook() })])
    const body = await (await GET()).json()
    expect(body.people).toHaveLength(1)
    expect(body.people[0].key).toBe('u1')
    expect(body.people[0].roster.id).toBe('c1')
  })

  it('returns a login-only person with a null roster', async () => {
    userFindMany.mockResolvedValueOnce([dbUser({ cook: null })])
    const body = await (await GET()).json()
    expect(body.people[0].roster).toBeNull()
  })

  it('queries only unlinked cooks, so a linked cook cannot appear twice', async () => {
    userFindMany.mockResolvedValueOnce([dbUser({ cook: dbCook() })])
    cookFindMany.mockResolvedValueOnce([])
    await GET()
    expect(cookFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: null },
    }))
  })

  it('includes orphan roster rows as roster-only people', async () => {
    cookFindMany.mockResolvedValueOnce([dbCook({ id: 'c9' })])
    const body = await (await GET()).json()
    expect(body.people[0].key).toBe('cook:c9')
    expect(body.people[0].login).toBeNull()
  })

  it('converts Decimal wage and cap to numbers, not strings', async () => {
    cookFindMany.mockResolvedValueOnce([dbCook({ wage: '22.5', dailyHourCap: '8' })])
    const body = await (await GET()).json()
    expect(body.people[0].roster.wage).toBe(22.5)
    expect(body.people[0].roster.dailyHourCap).toBe(8)
  })

  it('keeps a null wage null rather than coercing it to 0', async () => {
    cookFindMany.mockResolvedValueOnce([dbCook({ wage: null, dailyHourCap: null })])
    const body = await (await GET()).json()
    expect(body.people[0].roster.wage).toBeNull()
    expect(body.people[0].roster.dailyHourCap).toBeNull()
  })

  it('marks an invited-but-never-accepted account as pending', async () => {
    userFindMany.mockResolvedValueOnce([dbUser({ isActive: false, name: null })])
    const body = await (await GET()).json()
    expect(body.people[0].login.isPending).toBe(true)
  })

  it('does not mark a deactivated named account as pending', async () => {
    userFindMany.mockResolvedValueOnce([dbUser({ isActive: false, name: 'Mia Chen' })])
    const body = await (await GET()).json()
    expect(body.people[0].login.isPending).toBe(false)
  })

  it('flattens a revenue-center scope to both its RC and its parent location', async () => {
    userFindMany.mockResolvedValueOnce([dbUser({
      scopes: [{
        id: 's1', clearance: null, location: null,
        revenueCenter: { id: 'rc1', name: 'Cafe', location: { id: 'loc1', name: 'Downtown' } },
      }],
    })])
    const body = await (await GET()).json()
    expect(body.people[0].login.assignments[0]).toMatchObject({
      revenueCenterId: 'rc1', rcName: 'Cafe', locationId: 'loc1', locationName: 'Downtown',
    })
  })

  it('returns tip roles with numeric multipliers', async () => {
    tipRoleFindMany.mockResolvedValueOnce([{ id: 'r1', name: 'Line Cook', multiplier: '1.5', sortOrder: 0 }])
    const body = await (await GET()).json()
    expect(body.tipRoles[0].multiplier).toBe(1.5)
  })

  it('falls back to the default stations when the PrepSettings singleton is missing', async () => {
    prepSettingsFindUnique.mockResolvedValueOnce(null)
    const body = await (await GET()).json()
    expect(body.stations).toContain('Hot')
  })

  it('uses the configured stations when the singleton exists', async () => {
    prepSettingsFindUnique.mockResolvedValueOnce({ stations: ['Grill', 'Fry'] })
    const body = await (await GET()).json()
    expect(body.stations).toEqual(['Grill', 'Fry'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/app/api/settings/people/__tests__/route.test.ts
```

Expected: FAIL — `Failed to resolve import "@/app/api/settings/people/route"`.

- [ ] **Step 3: Write the route**

Create `src/app/api/settings/people/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { PREP_STATIONS } from '@/lib/prep-utils'
import { mergePeople, type PersonLogin, type PersonRoster } from '@/lib/people'

export const dynamic = 'force-dynamic'

/** The Cook columns the hub needs — every one of them, including pay. ADMIN-gated. */
const COOK_SELECT = {
  id: true, name: true, lastName: true, initials: true, homeStation: true,
  isActive: true, sortOrder: true, clockId: true, posPosition: true,
  wage: true, dailyHourCap: true, tipRoleId: true, onTipPool: true,
} as const

type CookRow = {
  id: string; name: string; lastName: string | null; initials: string
  homeStation: string | null; isActive: boolean; sortOrder: number
  clockId: string | null; posPosition: string | null
  wage: unknown; dailyHourCap: unknown; tipRoleId: string | null; onTipPool: boolean
}

/** Prisma Decimal arrives as a string in JSON — normalise at the boundary, never in the UI. */
const num = (v: unknown): number | null => (v == null ? null : Number(v))

const toRoster = (c: CookRow): PersonRoster => ({
  id: c.id, name: c.name, lastName: c.lastName, initials: c.initials,
  homeStation: c.homeStation, isActive: c.isActive, sortOrder: c.sortOrder,
  clockId: c.clockId, posPosition: c.posPosition,
  wage: num(c.wage), dailyHourCap: num(c.dailyHourCap),
  tipRoleId: c.tipRoleId, onTipPool: c.onTipPool,
})

// GET — every person (login, roster, or both) plus the lookups the editors need.
//
// The lookups ride along deliberately: /api/tips/roles is MANAGER-gated, and the
// tip roster is otherwise only reachable through GET /api/tips/periods/[id],
// which requires an OPEN PERIOD to exist. The hub must not depend on that.
export async function GET() {
  try { await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const [users, orphanCooks, locations, tipRoles, prepSettings] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, email: true, name: true, role: true, isActive: true, createdAt: true,
        scopes: {
          select: {
            id: true, clearance: true,
            location: { select: { id: true, name: true } },
            revenueCenter: {
              select: { id: true, name: true, location: { select: { id: true, name: true } } },
            },
          },
        },
        cook: { select: COOK_SELECT },
      },
    }),
    // userId: null is what guarantees a linked cook is not also returned here —
    // mergePeople would otherwise emit it twice.
    prisma.cook.findMany({
      where: { userId: null },
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: COOK_SELECT,
    }),
    prisma.location.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, color: true,
        revenueCenters: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, color: true },
        },
      },
    }),
    prisma.tipRole.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true, multiplier: true, sortOrder: true },
    }),
    // ORM read, not $queryRawUnsafe: the pgBouncer text[] gotcha in CLAUDE.md
    // applies to WRITES via $executeRaw tagged templates, not to reads.
    prisma.prepSettings.findUnique({
      where: { id: 'singleton' }, select: { stations: true },
    }),
  ])

  const linked = users.map(u => {
    const login: PersonLogin = {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      isActive: u.isActive,
      // A Prisma row is created inactive at invite time and flipped active by
      // /auth/callback on accept. Inactive with no name is a genuine pending
      // invite, not a deactivation. Same rule as GET /api/settings/users.
      isPending: !u.isActive && u.name === null,
      createdAt: u.createdAt.toISOString(),
      assignments: u.scopes.map(s => ({
        id: s.id,
        locationId: s.location?.id ?? s.revenueCenter?.location.id ?? null,
        locationName: s.location?.name ?? s.revenueCenter?.location.name ?? null,
        revenueCenterId: s.revenueCenter?.id ?? null,
        rcName: s.revenueCenter?.name ?? null,
        clearance: s.clearance,
      })),
    }
    return { login, roster: u.cook ? toRoster(u.cook as CookRow) : null }
  })

  return NextResponse.json({
    people: mergePeople(linked, orphanCooks.map(c => toRoster(c as CookRow))),
    locations,
    tipRoles: tipRoles.map(r => ({ ...r, multiplier: Number(r.multiplier) })),
    stations: prepSettings?.stations?.filter(Boolean) ?? PREP_STATIONS,
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/app/api/settings/people/__tests__/route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Type-check and confirm the route is dynamic**

```bash
npm run build
```

Expected: build succeeds and `/api/settings/people` shows `ƒ (Dynamic)` in the route table, not `○ (Static)`.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/settings/people
git commit -m "feat(people): GET /api/settings/people — merged person list + editor lookups"
```

---

### Task 4: `POST /api/settings/people`

**Files:**
- Modify: `src/app/api/settings/people/route.ts` (add `POST`)
- Modify: `src/app/api/settings/people/__tests__/route.test.ts` (add a `POST` describe block)

**Interfaces:**
- Consumes: `inviteOne`, `InviteResult` from `@/lib/user-invite`; `validateAssignmentRows`, `dedupeAssignmentRows`, `AssignmentInput` from `@/lib/assignment-input`; `assignableLevels` from `@/lib/roles`; `createAdminClient` from `@/lib/supabase/admin`.
- Produces: `POST` accepting `{ name: string, login?: { email: string, clearance: Role, assignments: AssignmentInput[] }, roster?: { initials?: string, homeStation?: string|null, clockId?: string|null, tipRoleId?: string|null, onTipPool?: boolean } }` and returning `{ cookId: string|null, userId: string|null, invite: InviteResult|null, warning?: string }`. Task 10's modal calls this.

- [ ] **Step 1: Write the failing test**

Append to `src/app/api/settings/people/__tests__/route.test.ts`. Add these mocks **above** the existing `const { GET } = await import(...)` line, alongside the mocks already there:

```ts
const cookCreate = vi.fn(async () => ({ id: 'c-new' }))
const cookUpdate = vi.fn(async () => ({ id: 'c-new' }))
const cookCount = vi.fn(async () => 3)
const cookFindUnique = vi.fn(async () => null as { id: string; name: string } | null)
const inviteOne = vi.fn(async () => ({ email: 'sam@fergies.test', status: 'invited', userId: 'u-new' }))
const validateAssignmentRows = vi.fn(async () => null as string | null)
const loadSettings = vi.fn(async () => ({ defaultDailyHourCap: 8 }))
```

Extend the `@/lib/prisma` mock's `cook` entry to:

```ts
    cook: {
      findMany: (...a: unknown[]) => cookFindMany(...(a as [])),
      findUnique: (...a: unknown[]) => cookFindUnique(...(a as [])),
      create: (...a: unknown[]) => cookCreate(...(a as [])),
      update: (...a: unknown[]) => cookUpdate(...(a as [])),
      count: (...a: unknown[]) => cookCount(...(a as [])),
    },
```

Add these module mocks next to the existing ones:

```ts
vi.mock('@/lib/user-invite', () => ({ inviteOne: (...a: unknown[]) => inviteOne(...(a as [])) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/tips/settings', () => ({ loadSettings: (...a: unknown[]) => loadSettings(...(a as [])) }))
vi.mock('@/lib/assignment-input', () => ({
  validateAssignmentRows: (...a: unknown[]) => validateAssignmentRows(...(a as [])),
  dedupeAssignmentRows: (rows: unknown[]) => rows,
}))
```

Change the route import line to pull in both handlers:

```ts
const { GET, POST } = await import('@/app/api/settings/people/route')
```

Then append this describe block at the end of the file:

```ts
import type { NextRequest } from 'next/server'

const postReq = (body: Record<string, unknown>) =>
  ({ json: async () => body, url: 'https://app.test/api/settings/people' }) as unknown as NextRequest

const loginBody = {
  name: 'Sam Lee',
  login: { email: 'sam@fergies.test', clearance: 'STAFF', assignments: [{ locationId: 'loc1', revenueCenterId: null, clearance: null }] },
}
const rosterBody = {
  name: 'Sam',
  roster: { initials: 'SL', homeStation: 'Hot', clockId: '4521', tipRoleId: 'r1', onTipPool: true },
}

describe('POST /api/settings/people', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireSession.mockResolvedValue({ id: 'u9', email: 'admin@fergies.test', name: 'Admin', role: 'ADMIN', isActive: true })
    cookCreate.mockResolvedValue({ id: 'c-new' })
    cookCount.mockResolvedValue(3)
    cookFindUnique.mockResolvedValue(null)
    validateAssignmentRows.mockResolvedValue(null)
    loadSettings.mockResolvedValue({ defaultDailyHourCap: 8 })
    inviteOne.mockResolvedValue({ email: 'sam@fergies.test', status: 'invited', userId: 'u-new' })
  })

  it('requires ADMIN', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(403, 'Forbidden'))
    const res = await POST(postReq(loginBody))
    expect(res.status).toBe(403)
    expect(cookCreate).not.toHaveBeenCalled()
    expect(inviteOne).not.toHaveBeenCalled()
  })

  it('rejects a body with neither half', async () => {
    const res = await POST(postReq({ name: 'Sam' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/login|roster/i)
  })

  it('rejects a blank name', async () => {
    const res = await POST(postReq({ ...rosterBody, name: '  ' }))
    expect(res.status).toBe(400)
  })

  it('creates a roster-only person', async () => {
    const res = await POST(postReq(rosterBody))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.cookId).toBe('c-new')
    expect(body.userId).toBeNull()
    expect(inviteOne).not.toHaveBeenCalled()
  })

  it('creates a login-only person', async () => {
    const res = await POST(postReq(loginBody))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.cookId).toBeNull()
    expect(body.userId).toBe('u-new')
    expect(cookCreate).not.toHaveBeenCalled()
  })

  it('prefills dailyHourCap from TipSettings — /api/prep/cooks does not, and the hub must not inherit that', async () => {
    await POST(postReq(rosterBody))
    expect(cookCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dailyHourCap: 8 }) }),
    )
  })

  it('appends the new roster row to the end of the run-sheet order', async () => {
    cookCount.mockResolvedValueOnce(3)
    await POST(postReq(rosterBody))
    expect(cookCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sortOrder: 3 }) }),
    )
  })

  it('derives initials from the name when none are supplied', async () => {
    await POST(postReq({ name: 'Sam', roster: { onTipPool: true } }))
    expect(cookCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ initials: 'SA' }) }),
    )
  })

  it('creates the roster row BEFORE inviting, and links the two', async () => {
    const res = await POST(postReq({ ...loginBody, roster: rosterBody.roster }))
    expect(res.status).toBe(201)
    expect(cookCreate.mock.invocationCallOrder[0]).toBeLessThan(inviteOne.mock.invocationCallOrder[0])
    expect(cookUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c-new' }, data: { userId: 'u-new' } }),
    )
  })

  it('keeps the roster row and reports the failure when the invite fails', async () => {
    inviteOne.mockResolvedValueOnce({ email: 'sam@fergies.test', status: 'failed', error: 'SMTP down' })
    const res = await POST(postReq({ ...loginBody, roster: rosterBody.roster }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.cookId).toBe('c-new')
    expect(body.userId).toBeNull()
    expect(body.invite.status).toBe('failed')
    expect(cookUpdate).not.toHaveBeenCalled()
  })

  it('does not attempt the invite when the roster create fails', async () => {
    cookCreate.mockRejectedValueOnce(new Error('db down'))
    const res = await POST(postReq({ ...loginBody, roster: rosterBody.roster }))
    expect(res.status).toBe(500)
    expect(inviteOne).not.toHaveBeenCalled()
  })

  it('returns a readable 409 when the clock id is taken, before creating anything', async () => {
    cookFindUnique.mockResolvedValueOnce({ id: 'other', name: 'Alex Kim' })
    const res = await POST(postReq(rosterBody))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('Alex Kim')
    expect(cookCreate).not.toHaveBeenCalled()
  })

  it('rejects a clearance the actor may not hand out', async () => {
    const res = await POST(postReq({ ...loginBody, login: { ...loginBody.login, clearance: 'OWNER' } }))
    expect(res.status).toBe(400)
    expect(inviteOne).not.toHaveBeenCalled()
  })

  it('rejects invalid assignment rows before anything is created', async () => {
    validateAssignmentRows.mockResolvedValueOnce('Unknown revenue center')
    const res = await POST(postReq({ ...loginBody, roster: rosterBody.roster }))
    expect(res.status).toBe(400)
    expect(cookCreate).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/app/api/settings/people/__tests__/route.test.ts
```

Expected: FAIL — `POST is not a function`.

- [ ] **Step 3: Write the POST handler**

Append to `src/app/api/settings/people/route.ts`. First widen the existing
`next/server` import — do NOT add a second import line from the same module:

```ts
import { NextResponse, type NextRequest } from 'next/server'
```

Then add the rest of the new imports at the top of the file:

```ts
import { Role } from '@prisma/client'
import { assignableLevels } from '@/lib/roles'
import { createAdminClient } from '@/lib/supabase/admin'
import { inviteOne, type InviteResult } from '@/lib/user-invite'
import { loadSettings } from '@/lib/tips/settings'
import {
  type AssignmentInput, validateAssignmentRows, dedupeAssignmentRows,
} from '@/lib/assignment-input'
```

```ts
/** First two letters of the name, matching the ADMIN cook form's normalisation. */
function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  const raw = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.trim().slice(0, 2)
  return raw.toUpperCase().slice(0, 3)
}

// POST — create one person: a login, a roster row, or both.
//
// ORDER IS DELIBERATE: Cook first → invite → link.
//
// Both partial outcomes are VALID people (roster-only, login-only), so neither
// needs undoing. The invite is the failure-prone half (network, email delivery,
// Supabase) and the retryable one — if it fails, the roster row survives and
// the caller is told, with a retry available on the Identity tab. Inverting the
// order would mean compensating a Supabase invite, a second thing that can fail.
export async function POST(req: NextRequest) {
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => ({})) as {
    name?: string
    login?: { email?: string; clearance?: string; assignments?: AssignmentInput[] }
    roster?: {
      initials?: string; homeStation?: string | null; clockId?: string | null
      tipRoleId?: string | null; onTipPool?: boolean
    }
  }

  const name = String(body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'A name is required' }, { status: 400 })
  if (!body.login && !body.roster) {
    return NextResponse.json(
      { error: 'Give this person an app login, a kitchen roster row, or both.' }, { status: 400 },
    )
  }

  // ── validate EVERYTHING before writing anything ──────────────────────────
  let assignments: Array<{ locationId: string | null; revenueCenterId: string | null; clearance: Role | null }> = []
  let role: Role | null = null
  let email = ''

  if (body.login) {
    email = String(body.login.email ?? '').trim().toLowerCase()
    if (!email) return NextResponse.json({ error: 'An email is required for an app login' }, { status: 400 })
    if (email === admin.email.toLowerCase()) {
      return NextResponse.json({ error: 'Cannot invite yourself' }, { status: 400 })
    }
    const allowed = assignableLevels(admin.role)
    if (!body.login.clearance || !allowed.includes(body.login.clearance as Role)) {
      return NextResponse.json(
        { error: `Clearance must be one of: ${allowed.join(', ')}` }, { status: 400 },
      )
    }
    role = body.login.clearance as Role
    // Validate BEFORE dedupe — dedupe keeps only the first row per node, so
    // validate-first checks both rows when the same node is submitted twice
    // with different clearances. Same order as the other two routes.
    const rows = Array.isArray(body.login.assignments) ? body.login.assignments : []
    const assignmentError = await validateAssignmentRows(rows, admin.role)
    if (assignmentError) return NextResponse.json({ error: assignmentError }, { status: 400 })
    assignments = dedupeAssignmentRows(rows)
  }

  const clockId = body.roster ? String(body.roster.clockId ?? '').trim() : ''
  if (clockId) {
    const clash = await prisma.cook.findUnique({ where: { clockId }, select: { id: true, name: true } })
    if (clash) {
      return NextResponse.json(
        { error: `Clock #${clockId} already belongs to ${clash.name}` }, { status: 409 },
      )
    }
  }

  // ── 1. roster row ────────────────────────────────────────────────────────
  let cookId: string | null = null
  if (body.roster) {
    try {
      const settings = await loadSettings()
      const created = await prisma.cook.create({
        data: {
          name,
          initials: (body.roster.initials?.trim().toUpperCase().slice(0, 3)) || deriveInitials(name),
          homeStation: body.roster.homeStation?.trim() || null,
          clockId: clockId || null,
          tipRoleId: body.roster.tipRoleId || null,
          onTipPool: body.roster.onTipPool ?? true,
          // Prefilled once, then owned by the person — never re-read from
          // settings. POST /api/prep/cooks omits this; the hub must not.
          dailyHourCap: settings.defaultDailyHourCap,
          sortOrder: await prisma.cook.count(),
        },
      })
      cookId = created.id
    } catch (e) {
      console.error('[settings/people POST] roster create failed', e)
      return NextResponse.json(
        { error: 'Could not create the roster row. Nothing was created.' }, { status: 500 },
      )
    }
  }

  // ── 2. invite ────────────────────────────────────────────────────────────
  let invite: InviteResult | null = null
  if (body.login && role) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || new URL(req.url).origin
    invite = await inviteOne({
      email, role, name, assignments,
      actor: { id: admin.id, email: admin.email, name: admin.name },
      appUrl,
      supabaseAdmin: createAdminClient(),
    })
  }

  // ── 3. link ──────────────────────────────────────────────────────────────
  const userId = invite?.userId ?? null
  let warning: string | undefined
  if (cookId && userId) {
    try {
      await prisma.cook.update({ where: { id: cookId }, data: { userId } })
    } catch (e) {
      // Both halves exist and are individually correct; only the join failed.
      // Report it rather than failing a create that mostly succeeded — the
      // Identity tab can link them in one click.
      console.error('[settings/people POST] link failed', e)
      warning = 'Created both, but could not link the login to the roster row. Link them on the Identity tab.'
    }
  }

  return NextResponse.json(
    { cookId, userId, invite, ...(warning ? { warning } : {}) },
    { status: 201 },
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/app/api/settings/people/__tests__/route.test.ts
```

Expected: PASS — both the GET and POST describe blocks.

- [ ] **Step 5: Type-check**

```bash
npm run build
```

Expected: build succeeds; `/api/settings/people` still `ƒ (Dynamic)`.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/settings/people
git commit -m "feat(people): POST /api/settings/people — create login, roster, or both"
```

---

### Task 5: Close the wage leak on `GET /api/prep/cooks` — ~~SUPERSEDED, DO NOT IMPLEMENT~~

**Status: already shipped elsewhere. Skip this task entirely.**

PR #102 (`fix/prep-cooks-payroll-leak`, branched off main) implements exactly
this fix: the same six-column select on `GET /api/prep/cooks`, the same route
test file, plus the `/api/prep/items/route.ts:101` hardening this plan listed as
optional. Re-implementing it here would only create a merge conflict.

The task numbering is left intact so `scripts/task-brief PLAN_FILE N` keeps
matching. Execution order is **1, 2, 3, 4, 6, 7, 8, 9, 10, 11** — ten tasks.

Consequence for the rest of the plan: nothing. No later task reads
`/api/prep/cooks`'s response shape — the hub reads cook data from
`GET /api/settings/people` (Task 3), and Task 11's browser check of `/prep`
still applies, it just verifies unchanged code rather than a change made here.

---

### Task 6: The hub list pane

Replaces the page body at `/setup/users`. `PeopleList`/`PersonRow` are wide-table components built for a full-width list; the hub's left pane is ~320px, so this is a new component rather than an adaptation. Leave the old files in place for now — Task 11 removes what is genuinely dead.

**Files:**
- Create: `src/components/people/hub/hub-utils.ts`
- Create: `src/components/people/hub/PersonListRow.tsx`
- Create: `src/components/people/hub/PeopleHubList.tsx`
- Modify: `src/app/setup/users/page.tsx` (replace the whole file)

**Interfaces:**
- Consumes: `Person`, `PersonLogin`, `PersonRoster`, `displayName`, `matchesQuery`, `personWarnings` from `@/lib/people`; `LocationNode` from `@/components/people/people-utils`.
- Produces: `type HubFilter = 'all' | 'logins' | 'roster' | 'pending' | 'inactive'`; `applyFilter(people, filter, query): Person[]`; `groupPeople(people, locations): HubGroup[]` where `HubGroup = { id: string; label: string; kind: 'location' | 'global' | 'roster-only' | 'unassigned'; people: Person[] }`; `initialsFor(p: Person): string`; `PeopleHubList` and `PersonListRow` components; and `PeopleHubPayload = { people, locations, tipRoles, stations }`. Tasks 7–10 mount inside this page.

- [ ] **Step 1: Write the failing test for the grouping/filter rules**

Create `src/lib/__tests__/people-hub.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mergePeople, type PersonLogin, type PersonRoster } from '@/lib/people'
import { applyFilter, groupPeople } from '@/components/people/hub/hub-utils'
import type { LocationNode } from '@/components/people/people-utils'

const login = (over: Partial<PersonLogin> = {}): PersonLogin => ({
  id: 'u1', email: 'mia@fergies.test', name: 'Mia Chen', role: 'STAFF',
  isActive: true, isPending: false, createdAt: '2026-01-01T00:00:00.000Z',
  assignments: [], ...over,
})
const roster = (over: Partial<PersonRoster> = {}): PersonRoster => ({
  id: 'c1', name: 'Mia', lastName: 'Chen', initials: 'MC', homeStation: 'Hot',
  isActive: true, sortOrder: 0, clockId: '1204', posPosition: null,
  wage: null, dailyHourCap: null, tipRoleId: null, onTipPool: true, ...over,
})
const scope = (locationId: string) => ({
  id: 's1', locationId, locationName: 'Downtown',
  revenueCenterId: null, rcName: null, clearance: null,
})
const locations: LocationNode[] = [
  { id: 'loc1', name: 'Downtown', color: '#000', revenueCenters: [{ id: 'rc1', name: 'Cafe', color: '#000' }] },
]

describe('applyFilter', () => {
  const people = mergePeople(
    [
      { login: login({ id: 'u1' }), roster: roster() },
      { login: login({ id: 'u2', email: 'book@fergies.test', name: 'Book Keeper' }), roster: null },
      { login: login({ id: 'u3', email: 'new@fergies.test', name: null, isActive: false, isPending: true }), roster: null },
      { login: login({ id: 'u4', email: 'old@fergies.test', name: 'Old Hand', isActive: false }), roster: null },
    ],
    [roster({ id: 'c9', name: 'Ana' })],
  )

  it('returns everyone under "all"', () => {
    expect(applyFilter(people, 'all', '')).toHaveLength(5)
  })
  it('"logins" keeps only people with an account', () => {
    expect(applyFilter(people, 'logins', '').every(p => p.login)).toBe(true)
  })
  it('"roster" keeps only people with a roster row', () => {
    const out = applyFilter(people, 'roster', '')
    expect(out.every(p => p.roster)).toBe(true)
    expect(out).toHaveLength(2)
  })
  it('"roster" sorts by run-sheet order, not by name', () => {
    const out = applyFilter(
      mergePeople([], [roster({ id: 'cA', name: 'Zoe', sortOrder: 1 }), roster({ id: 'cB', name: 'Ana', sortOrder: 0 })]),
      'roster', '',
    )
    expect(out.map(p => p.roster!.name)).toEqual(['Ana', 'Zoe'])
  })
  it('"pending" keeps only unaccepted invites', () => {
    const out = applyFilter(people, 'pending', '')
    expect(out.map(p => p.key)).toEqual(['u3'])
  })
  it('"inactive" excludes pending invites — an unaccepted invite is not a deactivation', () => {
    const out = applyFilter(people, 'inactive', '')
    expect(out.map(p => p.key)).toEqual(['u4'])
  })
  it('applies the query on top of the filter', () => {
    expect(applyFilter(people, 'all', 'ana').map(p => p.key)).toEqual(['cook:c9'])
  })
})

describe('groupPeople', () => {
  it('groups an assigned person under their location', () => {
    const people = mergePeople([{ login: login({ assignments: [scope('loc1')] }), roster: null }], [])
    const groups = groupPeople(people, locations)
    expect(groups[0]).toMatchObject({ kind: 'location', label: 'Downtown' })
  })

  it('puts a roster-only person in their own bucket, NOT the unassigned warning bucket', () => {
    const groups = groupPeople(mergePeople([], [roster({ id: 'c9' })]), locations)
    const kinds = groups.map(g => g.kind)
    expect(kinds).toContain('roster-only')
    expect(kinds).not.toContain('unassigned')
  })

  it('puts an unassigned ADMIN in the global bucket', () => {
    const people = mergePeople([{ login: login({ role: 'ADMIN', assignments: [] }), roster: null }], [])
    expect(groupPeople(people, locations).map(g => g.kind)).toContain('global')
  })

  it('puts an unassigned STAFF in the unassigned warning bucket', () => {
    const people = mergePeople([{ login: login({ role: 'STAFF', assignments: [] }), roster: null }], [])
    expect(groupPeople(people, locations).map(g => g.kind)).toContain('unassigned')
  })

  it('lists a person under every location they touch', () => {
    const two: LocationNode[] = [
      ...locations,
      { id: 'loc2', name: 'Rooftop', color: '#000', revenueCenters: [] },
    ]
    const people = mergePeople(
      [{ login: login({ assignments: [scope('loc1'), { ...scope('loc2'), id: 's2' }] }), roster: null }],
      [],
    )
    const groups = groupPeople(people, two).filter(g => g.kind === 'location')
    expect(groups).toHaveLength(2)
  })

  it('drops empty groups', () => {
    expect(groupPeople([], locations)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/lib/__tests__/people-hub.test.ts
```

Expected: FAIL — `Failed to resolve import "@/components/people/hub/hub-utils"`.

- [ ] **Step 3: Write the utils**

Create `src/components/people/hub/hub-utils.ts`:

```ts
// List-shaping rules for the People hub's left pane. Pure and unit-tested —
// see src/lib/__tests__/people-hub.test.ts.
import { atLeast } from '@/lib/roles'
import { displayName, matchesQuery, type Person } from '@/lib/people'
import type { LocationNode } from '@/components/people/people-utils'

export type HubFilter = 'all' | 'logins' | 'roster' | 'pending' | 'inactive'

export const HUB_FILTERS: Array<{ id: HubFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'logins', label: 'Logins' },
  { id: 'roster', label: 'Roster' },
  { id: 'pending', label: 'Pending' },
  { id: 'inactive', label: 'Inactive' },
]

export interface HubGroup {
  id: string
  label: string
  kind: 'location' | 'global' | 'roster-only' | 'unassigned'
  people: Person[]
}

/**
 * Filter, then search. The `roster` view sorts by Cook.sortOrder because that
 * IS the prep run-sheet order — this is where the reorder affordance from
 * /setup/kitchen-crew lives.
 */
export function applyFilter(people: Person[], filter: HubFilter, query: string): Person[] {
  let out = people.filter(p => {
    switch (filter) {
      case 'logins': return !!p.login
      case 'roster': return !!p.roster
      case 'pending': return !!p.login?.isPending
      // An unaccepted invite is inactive in the database but is NOT a
      // deactivation — it belongs under Pending, not here.
      case 'inactive': return (!!p.login && !p.login.isActive && !p.login.isPending)
        || (!p.login && !!p.roster && !p.roster.isActive)
      default: return true
    }
  })
  if (filter === 'roster') {
    out = [...out].sort((a, b) =>
      (a.roster!.sortOrder - b.roster!.sortOrder) || a.roster!.name.localeCompare(b.roster!.name))
  }
  return out.filter(p => matchesQuery(p, query))
}

const isGlobal = (p: Person) => !!p.login && atLeast(p.login.role, 'ADMIN')

/**
 * Group under every location a person touches — somebody assigned to two
 * locations appears under both. Three trailing buckets:
 *
 *  - roster-only  → a cook with no login. NORMAL, not a warning.
 *  - global       → OWNER/ADMIN with no assignments. They reach every RC by
 *                   role, so no assignment is needed.
 *  - unassigned   → a non-global clearance with zero assignments. A REAL
 *                   warning: this person sees all revenue centers.
 */
export function groupPeople(people: Person[], locations: LocationNode[]): HubGroup[] {
  const groups: HubGroup[] = locations.map(l => ({
    id: l.id,
    label: l.name,
    kind: 'location' as const,
    people: people.filter(p => p.login?.assignments.some(a => a.locationId === l.id)),
  }))

  const rosterOnly = people.filter(p => !p.login && p.roster)
  if (rosterOnly.length) {
    groups.push({ id: '__roster', label: 'Kitchen roster · no login', kind: 'roster-only', people: rosterOnly })
  }

  const global = people.filter(p => isGlobal(p) && p.login!.assignments.length === 0)
  if (global.length) {
    groups.push({ id: '__global', label: 'All locations', kind: 'global', people: global })
  }

  const unassigned = people.filter(
    p => p.login && !isGlobal(p) && p.login.assignments.length === 0,
  )
  if (unassigned.length) {
    groups.push({ id: '__unassigned', label: 'No assignments', kind: 'unassigned', people: unassigned })
  }

  return groups.filter(g => g.people.length > 0)
}

/** Two-letter avatar token. Prefers the roster's own initials when there is one. */
export function initialsFor(p: Person): string {
  if (p.roster?.initials) return p.roster.initials
  const source = displayName(p).trim()
  const parts = source.split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return source.slice(0, 2).toUpperCase() || '?'
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/lib/__tests__/people-hub.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the row component**

Create `src/components/people/hub/PersonListRow.tsx`:

```tsx
'use client'
import { ChefHat, ChevronUp, ChevronDown, AlertTriangle } from 'lucide-react'
import { ROLE_COLORS, ROLE_LABELS } from '@/lib/roles'
import { displayName, personWarnings, type Person } from '@/lib/people'
import { initialsFor } from './hub-utils'

interface Props {
  person: Person
  selected: boolean
  isMe: boolean
  /** Reorder handles appear only in the Roster view, where sortOrder is meaningful. */
  showReorder: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onSelect: (p: Person) => void
  onMove: (p: Person, direction: 'up' | 'down') => void
}

export default function PersonListRow({
  person, selected, isMe, showReorder, canMoveUp, canMoveDown, onSelect, onMove,
}: Props) {
  const dimmed =
    (person.login && !person.login.isActive && !person.login.isPending) ||
    (!person.login && person.roster && !person.roster.isActive)
  const warnings = personWarnings(person)
  const secondary = person.login?.email
    ?? [person.roster?.clockId ? `Clock #${person.roster.clockId}` : null, person.roster?.homeStation]
      .filter(Boolean).join(' · ')

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 border-b border-bg-2 last:border-b-0 ${
        selected ? 'bg-gold-soft' : 'hover:bg-bg'
      } ${dimmed ? 'opacity-50' : ''}`}
    >
      <button onClick={() => onSelect(person)} className="flex-1 min-w-0 flex items-center gap-2.5 text-left">
        <span className="shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-gold to-gold-2 grid place-items-center text-white text-[11px] font-semibold">
          {initialsFor(person)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium text-ink truncate">{displayName(person)}</span>
            {isMe && (
              <span className="shrink-0 text-[9px] font-semibold bg-bg-2 text-ink-3 px-1.5 py-0.5 rounded-full">You</span>
            )}
            {person.roster && <ChefHat size={11} className="shrink-0 text-ink-4" />}
          </span>
          <span className="block text-[11px] text-ink-4 truncate">{secondary}</span>
        </span>
        <span className="shrink-0 flex flex-col items-end gap-1">
          {person.login?.isPending ? (
            <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full bg-gold-soft text-gold-2">Pending</span>
          ) : person.login ? (
            <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-full ${ROLE_COLORS[person.login.role]}`}>
              {ROLE_LABELS[person.login.role]}
            </span>
          ) : null}
          {person.roster && !person.roster.onTipPool && (
            <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-bg-2 text-ink-3">off pool</span>
          )}
          {warnings.length > 0 && <AlertTriangle size={11} className="text-gold-2" />}
        </span>
      </button>

      {showReorder && (
        <span className="shrink-0 flex flex-col">
          <button
            onClick={() => onMove(person, 'up')}
            disabled={!canMoveUp}
            aria-label={`Move ${displayName(person)} earlier in the run sheet`}
            className="text-ink-4 hover:text-ink-2 disabled:opacity-25"
          >
            <ChevronUp size={13} />
          </button>
          <button
            onClick={() => onMove(person, 'down')}
            disabled={!canMoveDown}
            aria-label={`Move ${displayName(person)} later in the run sheet`}
            className="text-ink-4 hover:text-ink-2 disabled:opacity-25"
          >
            <ChevronDown size={13} />
          </button>
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Write the list pane**

Create `src/components/people/hub/PeopleHubList.tsx`:

```tsx
'use client'
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { Person } from '@/lib/people'
import type { LocationNode } from '@/components/people/people-utils'
import PersonListRow from './PersonListRow'
import { applyFilter, groupPeople, HUB_FILTERS, type HubFilter } from './hub-utils'

interface Props {
  people: Person[]
  locations: LocationNode[]
  selectedKey: string | null
  currentUserId: string | null
  onSelect: (p: Person) => void
  onReorder: (ordered: Person[], moved: Person, direction: 'up' | 'down') => void
}

export default function PeopleHubList({
  people, locations, selectedKey, currentUserId, onSelect, onReorder,
}: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<HubFilter>('all')

  const visible = useMemo(() => applyFilter(people, filter, query), [people, filter, query])
  const groups = useMemo(
    () => (filter === 'roster' ? null : groupPeople(visible, locations)),
    [visible, locations, filter],
  )

  const move = (p: Person, direction: 'up' | 'down') => onReorder(visible, p, direction)

  const row = (p: Person, index: number, list: Person[]) => (
    <PersonListRow
      key={p.key}
      person={p}
      selected={p.key === selectedKey}
      isMe={!!currentUserId && p.login?.id === currentUserId}
      showReorder={filter === 'roster'}
      canMoveUp={index > 0}
      canMoveDown={index < list.length - 1}
      onSelect={onSelect}
      onMove={move}
    />
  )

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2.5 border-b border-line space-y-2">
        <div className="flex items-center gap-2 bg-bg border border-line rounded-[9px] px-2.5 py-1.5">
          <Search size={13} className="text-ink-4" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search name, email, clock #…"
            className="flex-1 min-w-0 text-[12.5px] bg-transparent outline-none placeholder:text-ink-4"
          />
        </div>
        <div className="flex gap-1 overflow-x-auto">
          {HUB_FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`shrink-0 text-[11px] font-medium px-2.5 py-1 rounded-full ${
                filter === f.id ? 'bg-ink text-white' : 'bg-bg-2 text-ink-3 hover:bg-line'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {visible.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12.5px] text-ink-4">Nobody matches that.</p>
        ) : groups ? (
          groups.map(g => (
            <div key={g.id}>
              <div className="px-3 py-1.5 bg-bg border-b border-bg-2 flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-ink-4">{g.label}</span>
                {g.kind === 'unassigned' && (
                  <span className="text-[9px] text-gold-2">sees all RCs</span>
                )}
              </div>
              {g.people.map((p, i) => row(p, i, g.people))}
            </div>
          ))
        ) : (
          visible.map((p, i) => row(p, i, visible))
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Rewrite the page as a master–detail shell**

Replace the entire contents of `src/app/setup/users/page.tsx`:

```tsx
'use client'
import { useCallback, useEffect, useState } from 'react'
import { UserPlus, Loader2, ArrowLeft } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'
import type { Person } from '@/lib/people'
import type { LocationNode } from '@/components/people/people-utils'
import PeopleHubList from '@/components/people/hub/PeopleHubList'
import AccessAuditPanel from '@/components/people/AccessAuditPanel'

export interface TipRoleOption {
  id: string
  name: string
  multiplier: number
  sortOrder: number
}

export interface PeopleHubPayload {
  people: Person[]
  locations: LocationNode[]
  tipRoles: TipRoleOption[]
  stations: string[]
}

export default function PeopleHubPage() {
  const { user } = useUser()
  const [data, setData] = useState<PeopleHubPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const load = useCallback(async (): Promise<PeopleHubPayload | null> => {
    setError('')
    try {
      const res = await fetch('/api/settings/people', { cache: 'no-store' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Failed (${res.status})`)
      const body: PeopleHubPayload = await res.json()
      setData(body)
      return body
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load people')
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const refresh = useCallback(async () => {
    const body = await load()
    setRefreshKey(k => k + 1)
    // Clear the selection if that person is gone (removed), otherwise the
    // detail pane keeps rendering a row that no longer exists.
    if (body) setSelectedKey(prev => (prev && body.people.some(p => p.key === prev) ? prev : null))
  }, [load])

  /**
   * Run-sheet reorder. Normalises sortOrder to 0..n-1 over the CURRENTLY VISIBLE
   * roster list and persists only the rows whose value actually changed.
   */
  const reorder = async (visible: Person[], moved: Person, direction: 'up' | 'down') => {
    const idx = visible.findIndex(p => p.key === moved.key)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (idx < 0 || swapIdx < 0 || swapIdx >= visible.length) return
    const swapped = [...visible]
    ;[swapped[idx], swapped[swapIdx]] = [swapped[swapIdx], swapped[idx]]

    const patches = swapped
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => p.roster && p.roster.sortOrder !== i)

    const results = await Promise.all(patches.map(({ p, i }) =>
      fetch(`/api/prep/cooks/${p.roster!.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sortOrder: i }),
      }),
    ))
    if (results.some(r => !r.ok)) setError('Failed to reorder')
    refresh()
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-ink-4">
        <Loader2 size={15} className="animate-spin" /> Loading people…
      </div>
    )
  }

  const people = data?.people ?? []
  const selected = people.find(p => p.key === selectedKey) ?? null
  const rosterCount = people.filter(p => p.roster).length
  const loginCount = people.filter(p => p.login).length

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-fraunces text-xl font-semibold text-ink">People</h1>
          <p className="text-[12.5px] text-ink-3 mt-0.5">
            {people.length} {people.length === 1 ? 'person' : 'people'} · {loginCount} with a login · {rosterCount} on the roster
          </p>
        </div>
        <button
          onClick={() => { /* wired in Task 10 */ }}
          className="flex items-center gap-2 bg-ink text-white px-4 py-2.5 rounded-[10px] text-[13px] font-medium hover:bg-ink-2"
        >
          <UserPlus size={14} className="text-gold" /> Add person
        </button>
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-soft border border-line rounded-[10px] flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-red-text">{error}</p>
          <button onClick={() => load()} className="shrink-0 text-[11.5px] font-semibold text-red-text underline hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {/* Master–detail. Below md: the list IS the page and selecting swaps to
          the detail — both panes are mounted, CSS decides which is visible. */}
      <div className="bg-paper border border-line rounded-xl overflow-hidden md:flex md:h-[calc(100vh-260px)] md:min-h-[420px]">
        <div className={`md:w-[320px] md:shrink-0 md:border-r md:border-line ${selected ? 'hidden md:block' : 'block'}`}>
          <PeopleHubList
            people={people}
            locations={data?.locations ?? []}
            selectedKey={selectedKey}
            currentUserId={user?.id ?? null}
            onSelect={p => setSelectedKey(p.key)}
            onReorder={reorder}
          />
        </div>

        <div className={`flex-1 min-w-0 ${selected ? 'block' : 'hidden md:block'}`}>
          {selected ? (
            <div className="h-full flex flex-col min-h-0">
              <button
                onClick={() => setSelectedKey(null)}
                className="md:hidden flex items-center gap-1.5 px-4 py-3 border-b border-line text-[12.5px] text-ink-3"
              >
                <ArrowLeft size={14} /> All people
              </button>
              {/* PersonDetail mounts here in Task 7 */}
              <div className="p-6 text-[12.5px] text-ink-4">Detail pane — Task 7.</div>
            </div>
          ) : (
            <div className="hidden md:grid h-full place-items-center px-8 text-center">
              <p className="text-[13px] text-ink-4 max-w-[280px] leading-relaxed">
                Select someone to manage their login, access, prep roster and tip payout.
              </p>
            </div>
          )}
        </div>
      </div>

      <AccessAuditPanel refreshKey={refreshKey} />
    </div>
  )
}
```

- [ ] **Step 8: Run the tests and type-check**

```bash
npm test && npm run build
```

Expected: PASS, build succeeds.

- [ ] **Step 9: Verify in the browser**

Start the dev server with `mcp__Claude_Browser__preview_start`, open `/setup/users`. Confirm: the list renders with groups; the search box filters; each of the five filter chips changes the list; the Roster chip shows ↑/↓ handles and clicking one reorders and persists across a reload; selecting a person highlights the row. Resize to mobile (`resize_window` preset `mobile`) and confirm the list fills the page and selecting swaps to the detail pane with a back arrow. Check `read_console_messages` for errors.

- [ ] **Step 10: Commit**

```bash
git add src/components/people/hub src/lib/__tests__/people-hub.test.ts src/app/setup/users/page.tsx
git commit -m "feat(people): hub list pane with filters, grouping and run-sheet reorder"
```

---

### Task 7: Detail shell + Identity tab

**Files:**
- Create: `src/components/people/hub/PersonDetail.tsx`
- Create: `src/components/people/hub/IdentityTab.tsx`
- Create: `src/components/people/hub/kit.tsx`
- Modify: `src/app/setup/users/page.tsx` (mount `PersonDetail`)

**Interfaces:**
- Consumes: `Person`, `displayName`, `rosterFullName`, `personWarnings` from `@/lib/people`; `PeopleHubPayload` from `@/app/setup/users/page`; `initialsFor` from `./hub-utils`.
- Produces: `PersonDetail` with props `{ person, payload, actorRole, isMe, onBack, onChanged }`; `type TabId = 'identity' | 'access' | 'prep' | 'tips'`; and from `kit.tsx`: `Field`, `SectionLabel`, `WarningNote`, `EmptyTab`, `useSave`. Tasks 8, 9 and 10 import from `kit.tsx`.

- [ ] **Step 1: Write the shared kit**

Create `src/components/people/hub/kit.tsx`:

```tsx
'use client'
import { useState, type ReactNode } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="block text-[10px] font-mono uppercase tracking-[0.1em] text-ink-4 mb-1.5">
      {children}
    </span>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <SectionLabel>{label}</SectionLabel>
      {children}
      {hint && <span className="block mt-1 text-[11px] text-ink-4 leading-relaxed">{hint}</span>}
    </label>
  )
}

export const inputClass =
  'w-full border border-line rounded-lg px-3 py-2 text-[13px] bg-paper text-ink focus:outline-none focus:ring-2 focus:ring-gold'

export function WarningNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 px-3 py-2.5 bg-gold-soft rounded-[10px]">
      <AlertTriangle size={14} className="shrink-0 text-gold-2 mt-0.5" />
      <p className="text-[12px] text-ink-2 leading-relaxed">{children}</p>
    </div>
  )
}

export function EmptyTab({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="px-8 py-12 text-center">
      <h3 className="text-[14px] font-semibold text-ink mb-1.5">{title}</h3>
      <p className="text-[12.5px] text-ink-3 leading-relaxed max-w-[300px] mx-auto mb-4">{body}</p>
      {action}
    </div>
  )
}

/**
 * Shared save wrapper. Surfaces the non-fatal `warning` some routes return when
 * the audit write fails AFTER the mutation already committed — dropping it
 * (as PersonDetailPanel.call() does today) hides an incomplete audit trail
 * behind an apparent clean success.
 */
export function useSave(onChanged: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')

  const save = async (fn: () => Promise<Response>, after?: () => void) => {
    setError(''); setWarning(''); setBusy(true)
    try {
      const res = await fn()
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error ?? 'Something went wrong'); return false }
      if (body.warning) setWarning(body.warning)
      after?.(); onChanged()
      return true
    } catch (e) {
      // A network rejection throws before any response exists — without this,
      // `busy` stays true forever with no escape.
      setError(e instanceof Error ? e.message : 'Network error — could not reach the server')
      return false
    } finally {
      setBusy(false)
    }
  }

  return { busy, error, warning, setError, save, Spinner: busy ? <Loader2 size={14} className="animate-spin" /> : null }
}
```

- [ ] **Step 2: Write the Identity tab**

Create `src/components/people/hub/IdentityTab.tsx`:

```tsx
'use client'
import { useState } from 'react'
import type { Role } from '@prisma/client'
import { Pause, Trash2, Link2, ChefHat, Mail } from 'lucide-react'
import type { Person } from '@/lib/people'
import { personWarnings, rosterFullName } from '@/lib/people'
import type { PeopleHubPayload } from '@/app/setup/users/page'
import { Field, SectionLabel, WarningNote, inputClass, useSave } from './kit'

interface Props {
  person: Person
  payload: PeopleHubPayload
  actorRole: Role
  isMe: boolean
  onChanged: () => void
  onCleared: () => void
}

export default function IdentityTab({ person, payload, isMe, onChanged, onCleared }: Props) {
  const { busy, error, warning, save, Spinner } = useSave(onChanged)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [linkTarget, setLinkTarget] = useState('')

  const isOwner = person.login?.role === 'OWNER'
  const locked = isOwner || isMe
  const warnings = personWarnings(person)

  // Active logins with no roster row of their own — the only valid link targets.
  const linkable = payload.people
    .filter(p => p.login && p.login.isActive && !p.login.isPending && !p.roster)
    .map(p => p.login!)

  const patchUser = (patch: Record<string, unknown>) =>
    save(() => fetch(`/api/settings/users/${person.login!.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }))

  const patchCook = (patch: Record<string, unknown>) =>
    save(() => fetch(`/api/prep/cooks/${person.roster!.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }))

  const linkLogin = (userId: string) =>
    save(() => fetch(`/api/tips/roster/${person.roster!.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userId || null }),
    }))

  const addRoster = () =>
    save(async () => {
      const res = await fetch('/api/prep/cooks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: (person.login!.name ?? person.login!.email).split(/\s+/)[0],
          initials: (person.login!.name ?? person.login!.email).slice(0, 2).toUpperCase(),
        }),
      })
      if (!res.ok) return res
      const cook = await res.json()
      // The link is a separate, deliberate step — /api/prep/cooks never sets it.
      return fetch(`/api/tips/roster/${cook.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: person.login!.id }),
      })
    })

  return (
    <div className="px-5 py-5 space-y-5">
      {isOwner && (
        <p className="text-[12.5px] text-ink-3 bg-bg-2 rounded-[10px] px-3 py-2.5 leading-relaxed">
          The owner has access everywhere and cannot be changed, deactivated, or removed.
        </p>
      )}
      {isMe && !isOwner && (
        <p className="text-[12.5px] text-ink-3 bg-bg-2 rounded-[10px] px-3 py-2.5 leading-relaxed">
          This is your own account. Ask another admin to change your clearance or status.
        </p>
      )}

      {warnings.map(w => <WarningNote key={w.code}>{w.message}</WarningNote>)}

      {/* names — shown side by side, never synced to each other */}
      <div className="grid gap-4 sm:grid-cols-2">
        {person.login && (
          <Field label="Account name" hint="Shown across the app and on the sign-in record.">
            <input
              defaultValue={person.login.name ?? ''}
              disabled={locked || busy}
              onBlur={e => e.target.value !== (person.login!.name ?? '') && patchUser({ name: e.target.value })}
              className={inputClass}
            />
          </Field>
        )}
        {person.roster && (
          <>
            <Field label="Roster name" hint="First name only — this is what shows on prep run-sheet chips.">
              <input
                defaultValue={person.roster.name}
                disabled={busy}
                onBlur={e => e.target.value.trim() && e.target.value !== person.roster!.name && patchCook({ name: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="Last name">
              <input
                defaultValue={person.roster.lastName ?? ''}
                disabled={busy}
                onBlur={e => e.target.value !== (person.roster!.lastName ?? '') &&
                  save(() => fetch(`/api/tips/roster/${person.roster!.id}`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lastName: e.target.value }),
                  }))}
                className={inputClass}
              />
            </Field>
            <Field label="Initials" hint="Avatar token on prep chips. Up to 3 characters.">
              <input
                defaultValue={person.roster.initials}
                disabled={busy}
                onBlur={e => e.target.value.trim() && e.target.value.toUpperCase() !== person.roster!.initials &&
                  patchCook({ initials: e.target.value })}
                className={`${inputClass} uppercase`}
              />
            </Field>
          </>
        )}
        {person.login && (
          <Field label="Email" hint="Read-only — this is the sign-in key.">
            <input value={person.login.email} readOnly className={`${inputClass} bg-bg text-ink-3`} />
          </Field>
        )}
      </div>

      {/* the link control — the point of the hub */}
      <div className="border border-line rounded-[10px] px-4 py-3.5 space-y-2.5">
        <SectionLabel>App login ↔ kitchen roster</SectionLabel>
        {person.login && person.roster ? (
          <p className="flex items-center gap-2 text-[12.5px] text-ink-2">
            <Link2 size={14} className="text-green-text" />
            Linked — <b>{person.login.email}</b> is <b>{rosterFullName(person.roster)}</b> on the roster.
          </p>
        ) : person.roster ? (
          <>
            <p className="text-[12.5px] text-ink-3 leading-relaxed">
              On the roster, but has no app login. Link an existing account — never guessed from a name.
            </p>
            <div className="flex gap-2">
              <select
                value={linkTarget}
                onChange={e => setLinkTarget(e.target.value)}
                disabled={busy}
                className={`${inputClass} flex-1`}
              >
                <option value="">Choose an account…</option>
                {linkable.map(u => (
                  <option key={u.id} value={u.id}>{u.name ?? u.email} — {u.email}</option>
                ))}
              </select>
              <button
                onClick={() => linkTarget && linkLogin(linkTarget)}
                disabled={busy || !linkTarget}
                className="px-3.5 py-2 rounded-lg bg-ink text-white text-[12.5px] font-semibold disabled:opacity-50"
              >
                Link
              </button>
            </div>
            {linkable.length === 0 && (
              <p className="flex items-center gap-1.5 text-[11.5px] text-ink-4">
                <Mail size={12} /> No unlinked accounts. Invite one with “Add person”.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-[12.5px] text-ink-3 leading-relaxed">
              Has a login but is not on the kitchen roster — they cannot be assigned prep or paid tips.
            </p>
            <button
              onClick={addRoster}
              disabled={busy}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-line text-[12.5px] font-medium text-ink-2 hover:bg-bg disabled:opacity-50"
            >
              <ChefHat size={14} className="text-gold-2" /> Put them on the kitchen roster
            </button>
          </>
        )}
        {person.login && person.roster && (
          <button
            onClick={() => linkLogin('')}
            disabled={busy}
            className="text-[11.5px] text-ink-4 underline hover:no-underline disabled:opacity-50"
          >
            Unlink
          </button>
        )}
      </div>

      {error && (
        <div className="flex gap-2 px-3 py-2.5 bg-red-soft border border-line rounded-[10px]">
          <span className="text-red-text">⚠</span>
          <p className="text-[12.5px] text-red-text leading-relaxed">{error}</p>
        </div>
      )}
      {warning && <WarningNote>{warning}</WarningNote>}

      {/* revoke access */}
      {!locked && (
        <div className="pt-2 border-t border-bg-2 space-y-2">
          <p className="text-[11px] text-ink-4 pt-3">Two ways to revoke access — pick by whether they might return.</p>

          {person.login && (
            <button
              onClick={() => patchUser({ isActive: !person.login!.isActive })}
              disabled={busy}
              className="w-full flex items-start gap-3 text-left border border-line rounded-lg px-3.5 py-3 hover:bg-bg disabled:opacity-50"
            >
              <Pause size={15} className="text-gold-2 mt-0.5 shrink-0" />
              <span className="flex-1">
                <span className="flex items-center justify-between">
                  <b className="text-[13px] text-ink">{person.login.isActive ? 'Deactivate login' : 'Reactivate login'}</b>
                  <span className="text-[10px] font-mono text-green-text bg-green-soft px-2 py-0.5 rounded-full">reversible</span>
                </span>
                <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
                  {person.login.isActive
                    ? 'Loses access immediately. Account, assignments & history kept.'
                    : 'Restores access with their existing assignments.'}
                </span>
              </span>
            </button>
          )}

          {person.roster && (
            <button
              onClick={() => patchCook({ isActive: !person.roster!.isActive })}
              disabled={busy}
              className="w-full flex items-start gap-3 text-left border border-line rounded-lg px-3.5 py-3 hover:bg-bg disabled:opacity-50"
            >
              <ChefHat size={15} className="text-gold-2 mt-0.5 shrink-0" />
              <span className="flex-1">
                <span className="flex items-center justify-between">
                  <b className="text-[13px] text-ink">
                    {person.roster.isActive ? 'Take off the kitchen roster' : 'Put back on the kitchen roster'}
                  </b>
                  <span className="text-[10px] font-mono text-green-text bg-green-soft px-2 py-0.5 rounded-full">reversible</span>
                </span>
                <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
                  {person.roster.isActive
                    ? 'Disappears from prep assignment lists. Tip history is kept.'
                    : 'Reappears on prep assignment lists.'}
                </span>
              </span>
            </button>
          )}

          {confirmRemove ? (
            <div className="border border-red bg-red-soft rounded-lg px-3.5 py-3 space-y-2.5">
              <div className="flex items-start gap-3">
                <Trash2 size={15} className="text-red-text mt-0.5 shrink-0" />
                <span className="flex-1">
                  <b className="block text-[13px] text-red-text">Remove permanently?</b>
                  <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
                    {person.login
                      ? 'Deletes the account and all assignments. Activity stays in the audit log.'
                      : 'Deletes the roster row. Past prep assignments stop resolving to a name.'}
                  </span>
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmRemove(false)}
                  disabled={busy}
                  className="flex-1 py-2 rounded-lg border border-line text-[12.5px] font-medium text-ink-2 hover:bg-bg disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => save(
                    () => person.login
                      ? fetch(`/api/settings/users/${person.login.id}`, { method: 'DELETE' })
                      : fetch(`/api/prep/cooks/${person.roster!.id}`, { method: 'DELETE' }),
                    onCleared,
                  )}
                  disabled={busy}
                  className="flex-1 py-2 rounded-lg bg-red text-white text-[12.5px] font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {Spinner} Confirm remove
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmRemove(true)}
              disabled={busy}
              className="w-full flex items-center justify-between gap-3 border border-red/30 rounded-lg px-3.5 py-3 hover:bg-red-soft/40 disabled:opacity-50"
            >
              <span className="flex items-center gap-3">
                <Trash2 size={15} className="text-red-text" />
                <b className="text-[13px] text-red-text">Remove permanently</b>
              </span>
              <span className="text-[10px] font-mono text-red-text bg-red-soft px-2 py-0.5 rounded-full">cannot undo</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Write the detail shell**

Create `src/components/people/hub/PersonDetail.tsx`:

```tsx
'use client'
import { useState } from 'react'
import type { Role } from '@prisma/client'
import type { Person } from '@/lib/people'
import { displayName } from '@/lib/people'
import type { PeopleHubPayload } from '@/app/setup/users/page'
import { initialsFor } from './hub-utils'
import IdentityTab from './IdentityTab'
import { EmptyTab } from './kit'

export type TabId = 'identity' | 'access' | 'prep' | 'tips'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'identity', label: 'Identity' },
  { id: 'access', label: 'Access' },
  { id: 'prep', label: 'Prep' },
  { id: 'tips', label: 'Tips' },
]

interface Props {
  person: Person
  payload: PeopleHubPayload
  actorRole: Role
  isMe: boolean
  onChanged: () => void
  onCleared: () => void
}

export default function PersonDetail({ person, payload, actorRole, isMe, onChanged, onCleared }: Props) {
  const [tab, setTab] = useState<TabId>('identity')

  // A tab that does not apply stays VISIBLE but dimmed, with an empty state
  // inside — hiding it would reshuffle the strip as you arrow down the list.
  const applies: Record<TabId, boolean> = {
    identity: true,
    access: !!person.login,
    prep: !!person.roster,
    tips: !!person.roster,
  }

  const status = person.login?.isPending
    ? { label: 'Pending invite', cls: 'bg-gold-soft text-gold-2' }
    : person.login && !person.login.isActive
      ? { label: 'Inactive', cls: 'bg-bg-2 text-ink-3' }
      : !person.login && person.roster && !person.roster.isActive
        ? { label: 'Off roster', cls: 'bg-bg-2 text-ink-3' }
        : { label: 'Active', cls: 'bg-green-soft text-green-text' }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
        <span className="shrink-0 w-11 h-11 rounded-full bg-gradient-to-br from-gold to-gold-2 grid place-items-center text-white font-semibold">
          {initialsFor(person)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[15px] text-ink truncate">{displayName(person)}</div>
          <div className="text-xs text-ink-4 truncate">
            {person.login?.email ?? (person.roster?.clockId ? `Clock #${person.roster.clockId}` : 'No app login')}
          </div>
        </div>
        <span className={`shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-full ${status.cls}`}>
          {status.label}
        </span>
      </div>

      <div className="flex gap-1 px-3 pt-2 border-b border-line">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-[12.5px] font-medium border-b-2 -mb-px ${
              tab === t.id
                ? 'border-gold text-ink'
                : `border-transparent hover:text-ink-2 ${applies[t.id] ? 'text-ink-3' : 'text-ink-4'}`
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'identity' && (
          <IdentityTab
            person={person}
            payload={payload}
            actorRole={actorRole}
            isMe={isMe}
            onChanged={onChanged}
            onCleared={onCleared}
          />
        )}
        {tab === 'access' && (
          <EmptyTab title="Access" body="Access tab — Task 8." />
        )}
        {tab === 'prep' && (
          <EmptyTab title="Prep" body="Prep tab — Task 9." />
        )}
        {tab === 'tips' && (
          <EmptyTab title="Tips" body="Tips tab — Task 9." />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Mount it in the page**

In `src/app/setup/users/page.tsx`, add the import:

```tsx
import PersonDetail from '@/components/people/hub/PersonDetail'
```

and replace the placeholder `<div className="p-6 text-[12.5px] text-ink-4">Detail pane — Task 7.</div>` with:

```tsx
              <PersonDetail
                person={selected}
                payload={data!}
                actorRole={user?.role ?? 'STAFF'}
                isMe={!!user?.id && selected.login?.id === user.id}
                onChanged={refresh}
                onCleared={() => setSelectedKey(null)}
              />
```

- [ ] **Step 5: Type-check**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 6: Verify in the browser**

Open `/setup/users`. Confirm for each of the three person shapes: (a) a **linked** person shows both name fields and "Linked — …"; (b) a **roster-only** person shows the account picker and no Access-tab content; (c) a **login-only** person shows "Put them on the kitchen roster". Edit an account name and a roster name and confirm the other does not change after a reload. Confirm your own row and any OWNER row render the locked explanation and hide the destructive buttons. Check `read_console_messages`.

- [ ] **Step 7: Commit**

```bash
git add src/components/people/hub src/app/setup/users/page.tsx
git commit -m "feat(people): person detail shell + Identity tab with the login/roster link"
```

---

### Task 8: Access tab

**Files:**
- Create: `src/components/people/hub/AccessTab.tsx`
- Modify: `src/components/people/hub/PersonDetail.tsx` (mount it)

**Interfaces:**
- Consumes: `AssignmentEditor`, `AssignmentDraft` from `@/components/people/AssignmentEditor`; `resolveEffective`, `EffectiveEntry`, `RcNode` from `@/lib/access-model`; `assignableLevels`, `atLeast`, `ROLE_LABELS`, `ROLE_COLORS`, `ROLE_DOT`, `ROLE_DESCRIPTIONS` from `@/lib/roles`; `useSave` from `./kit`.
- Produces: `AccessTab` with props `{ person, payload, actorRole, isMe, onChanged }`.

- [ ] **Step 1: Write the tab**

Create `src/components/people/hub/AccessTab.tsx`. The effective-access preview is lifted from `PersonDetailPanel.tsx:26-40` and must keep calling the **same** `resolveEffective` the server enforces with, so the preview can never disagree with what is actually enforced.

```tsx
'use client'
import { useState } from 'react'
import type { Role } from '@prisma/client'
import { assignableLevels, atLeast, ROLE_COLORS, ROLE_DESCRIPTIONS, ROLE_DOT, ROLE_LABELS } from '@/lib/roles'
import { resolveEffective, type EffectiveEntry, type RcNode } from '@/lib/access-model'
import AssignmentEditor, { type AssignmentDraft } from '@/components/people/AssignmentEditor'
import type { LocationNode } from '@/components/people/people-utils'
import type { Person } from '@/lib/people'
import type { PeopleHubPayload } from '@/app/setup/users/page'
import { EmptyTab, SectionLabel, WarningNote, useSave } from './kit'

/**
 * Live preview of effective access as the admin edits. Calls the SAME
 * resolveEffective() the server uses (src/lib/access-model.ts is the pure half,
 * importable from a client component) so the preview can never disagree with
 * what actually gets enforced.
 */
function effectivePreview(
  drafts: AssignmentDraft[], primary: Role, locations: LocationNode[],
): EffectiveEntry[] {
  const rcs: RcNode[] = locations.flatMap(l =>
    l.revenueCenters.map(rc => ({ id: rc.id, name: rc.name, locationId: l.id, locationName: l.name })),
  )
  return resolveEffective(primary, drafts, rcs)
}

interface Props {
  person: Person
  payload: PeopleHubPayload
  actorRole: Role
  isMe: boolean
  onChanged: () => void
}

export default function AccessTab({ person, payload, actorRole, isMe, onChanged }: Props) {
  const login = person.login
  const [clearance, setClearance] = useState<Role>(login?.role ?? 'STAFF')
  const [drafts, setDrafts] = useState<AssignmentDraft[]>(
    (login?.assignments ?? []).map(a => ({
      locationId: a.revenueCenterId ? null : a.locationId,
      revenueCenterId: a.revenueCenterId,
      clearance: a.clearance,
    })),
  )
  const { busy, error, warning, save, Spinner } = useSave(onChanged)

  if (!login) {
    return (
      <EmptyTab
        title="No app login"
        body="This person is on the kitchen roster but cannot sign in. Link or invite an account on the Identity tab to give them access."
      />
    )
  }

  const isOwner = login.role === 'OWNER'
  const locked = isOwner || isMe
  const preview = effectivePreview(drafts, clearance, payload.locations)
  // src/lib/access.ts short-circuits OWNER/ADMIN to every revenue center
  // regardless of assignments — mirror that here, keyed off the SELECTED
  // clearance so the preview updates live as an admin edits.
  const previewIsGlobal = atLeast(clearance, 'ADMIN')

  const submit = () => save(async () => {
    if (clearance !== login.role) {
      const r = await fetch(`/api/settings/users/${login.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearance }),
      })
      if (!r.ok) return r
    }
    return fetch(`/api/settings/users/${login.id}/assignments`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments: drafts }),
    })
  })

  return (
    <div className="px-5 py-5 space-y-5">
      <div>
        <div className="flex items-center justify-between">
          <SectionLabel>Primary clearance</SectionLabel>
          {locked ? (
            <span className={`text-[12.5px] font-semibold px-3 py-1 rounded-full ${ROLE_COLORS[login.role]}`}>
              {ROLE_LABELS[login.role]}
            </span>
          ) : (
            <select
              value={clearance}
              onChange={e => setClearance(e.target.value as Role)}
              className={`text-[12.5px] font-semibold px-3 py-1 rounded-full border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-gold ${ROLE_COLORS[clearance]}`}
            >
              {assignableLevels(actorRole).map(r => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          )}
        </div>
        <p className="mt-2 text-[11.5px] text-ink-4 leading-relaxed">
          {ROLE_DESCRIPTIONS[locked ? login.role : clearance]}
        </p>
      </div>

      {!isOwner && (
        <div>
          <SectionLabel>Assignments</SectionLabel>
          <AssignmentEditor
            locations={payload.locations}
            value={drafts}
            primaryClearance={clearance}
            actorRole={actorRole}
            onChange={setDrafts}
          />
        </div>
      )}

      {!isOwner && (
        <div className="px-4 py-3.5 bg-bg border border-line rounded-lg">
          <SectionLabel>Effective access</SectionLabel>
          {previewIsGlobal ? (
            <p className="text-[12px] text-gold-2">
              {ROLE_LABELS[clearance]} clearance reaches every revenue center regardless of assignments.
            </p>
          ) : preview.length === 0 ? (
            <p className="text-[12px] text-gold-2">
              No assignments — this person currently sees all revenue centers.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {preview.map(e => (
                <div key={e.rcId} className="flex items-center gap-2 text-[12px]">
                  <span className={`w-2 h-2 rounded-full ${ROLE_DOT[e.clearance]}`} />
                  <span className="text-ink-2">{e.rcName}</span>
                  <span className="text-ink-4">·</span>
                  <b className="text-ink">{ROLE_LABELS[e.clearance]}</b>
                  {e.source === 'override' && <span className="text-[10px] font-mono text-gold-2">override</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="flex gap-2 px-3 py-2.5 bg-red-soft border border-line rounded-[10px]">
          <span className="text-red-text">⚠</span>
          <p className="text-[12.5px] text-red-text leading-relaxed">{error}</p>
        </div>
      )}
      {warning && <WarningNote>{warning}</WarningNote>}

      {!locked && (
        <button
          onClick={submit}
          disabled={busy}
          className="w-full py-3 rounded-[10px] bg-ink text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {Spinner} Save access
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Mount it**

In `src/components/people/hub/PersonDetail.tsx`, add `import AccessTab from './AccessTab'` and replace the `tab === 'access'` branch with:

```tsx
        {tab === 'access' && (
          <AccessTab
            person={person}
            payload={payload}
            actorRole={actorRole}
            isMe={isMe}
            onChanged={onChanged}
          />
        )}
```

- [ ] **Step 3: Type-check**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 4: Verify in the browser**

Open `/setup/users` → pick a STAFF person → Access tab. Confirm: changing the clearance dropdown updates the "Effective access" list live; selecting ADMIN switches the preview to the "reaches every revenue center" line; adding an assignment adds an RC row; Save persists across a reload. Confirm a roster-only person shows the "No app login" empty state. Check `read_console_messages`.

- [ ] **Step 5: Commit**

```bash
git add src/components/people/hub
git commit -m "feat(people): Access tab with the live effective-access preview"
```

---

### Task 9: Prep and Tips tabs

**Files:**
- Create: `src/components/people/hub/PrepTab.tsx`
- Create: `src/components/people/hub/TipsTab.tsx`
- Modify: `src/components/people/hub/PersonDetail.tsx` (mount both)

**Interfaces:**
- Consumes: `Person` from `@/lib/people`; `PeopleHubPayload` from `@/app/setup/users/page`; `Field`, `SectionLabel`, `WarningNote`, `EmptyTab`, `inputClass`, `useSave` from `./kit`.
- Produces: `PrepTab` and `TipsTab`, both with props `{ person, payload, onChanged }`.

- [ ] **Step 1: Write the Prep tab**

Create `src/components/people/hub/PrepTab.tsx`:

```tsx
'use client'
import type { Person } from '@/lib/people'
import type { PeopleHubPayload } from '@/app/setup/users/page'
import { EmptyTab, Field, WarningNote, inputClass, useSave } from './kit'

interface Props {
  person: Person
  payload: PeopleHubPayload
  onChanged: () => void
}

export default function PrepTab({ person, payload, onChanged }: Props) {
  const { busy, error, warning, save } = useSave(onChanged)
  const roster = person.roster

  if (!roster) {
    return (
      <EmptyTab
        title="Not on the kitchen roster"
        body="Add them to the roster on the Identity tab to assign prep work and include them in the tip pool."
      />
    )
  }

  const patch = (body: Record<string, unknown>) =>
    save(() => fetch(`/api/prep/cooks/${roster.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }))

  return (
    <div className="px-5 py-5 space-y-5">
      <Field label="Home station" hint="Where the run sheet defaults their work. Stations are edited in Prep settings.">
        <select
          value={roster.homeStation ?? ''}
          disabled={busy}
          onChange={e => patch({ homeStation: e.target.value || null })}
          className={inputClass}
        >
          <option value="">No station</option>
          {payload.stations.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>

      <Field
        label="Run-sheet position"
        hint="Order this person appears in prep assignment lists. Reorder with the ↑/↓ handles in the Roster view of the list."
      >
        <input value={roster.sortOrder + 1} readOnly className={`${inputClass} bg-bg text-ink-3 w-24`} />
      </Field>

      <div className="flex items-center justify-between border border-line rounded-[10px] px-4 py-3">
        <span>
          <b className="block text-[13px] text-ink">On the kitchen roster</b>
          <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
            {roster.isActive
              ? 'Appears in prep assignment lists.'
              : 'Hidden from prep assignment lists. Tip history is kept.'}
          </span>
        </span>
        <button
          onClick={() => patch({ isActive: !roster.isActive })}
          disabled={busy}
          className={`shrink-0 px-3.5 py-1.5 rounded-full text-[12px] font-semibold disabled:opacity-50 ${
            roster.isActive ? 'bg-green-soft text-green-text' : 'bg-bg-2 text-ink-3'
          }`}
        >
          {roster.isActive ? 'On' : 'Off'}
        </button>
      </div>

      {error && (
        <div className="flex gap-2 px-3 py-2.5 bg-red-soft border border-line rounded-[10px]">
          <span className="text-red-text">⚠</span>
          <p className="text-[12.5px] text-red-text leading-relaxed">{error}</p>
        </div>
      )}
      {warning && <WarningNote>{warning}</WarningNote>}
    </div>
  )
}
```

- [ ] **Step 2: Write the Tips tab**

Create `src/components/people/hub/TipsTab.tsx`:

```tsx
'use client'
import type { Person } from '@/lib/people'
import { personWarnings } from '@/lib/people'
import type { PeopleHubPayload } from '@/app/setup/users/page'
import { EmptyTab, Field, WarningNote, inputClass, useSave } from './kit'

interface Props {
  person: Person
  payload: PeopleHubPayload
  onChanged: () => void
}

export default function TipsTab({ person, payload, onChanged }: Props) {
  const { busy, error, warning, save } = useSave(onChanged)
  const roster = person.roster

  if (!roster) {
    return (
      <EmptyTab
        title="Not on the kitchen roster"
        body="Tip payouts are driven by the roster. Add them on the Identity tab first."
      />
    )
  }

  const patch = (body: Record<string, unknown>) =>
    save(() => fetch(`/api/tips/roster/${roster.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }))

  const poolWarning = personWarnings(person).find(w => w.code === 'POOL_NO_CLOCK')

  return (
    <div className="px-5 py-5 space-y-5">
      <div className="flex items-center justify-between border border-line rounded-[10px] px-4 py-3">
        <span>
          <b className="block text-[13px] text-ink">On the tip pool</b>
          <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
            Turn off to keep someone on the roster but out of the payout.
          </span>
        </span>
        <button
          onClick={() => patch({ onTipPool: !roster.onTipPool })}
          disabled={busy}
          className={`shrink-0 px-3.5 py-1.5 rounded-full text-[12px] font-semibold disabled:opacity-50 ${
            roster.onTipPool ? 'bg-green-soft text-green-text' : 'bg-bg-2 text-ink-3'
          }`}
        >
          {roster.onTipPool ? 'On pool' : 'Off pool'}
        </button>
      </div>

      {poolWarning && <WarningNote>{poolWarning.message}</WarningNote>}

      <Field
        label="Clock ID"
        hint="The POS employee number. Hours match on this and nothing else — never on a name."
      >
        <input
          defaultValue={roster.clockId ?? ''}
          disabled={busy}
          placeholder="—"
          onBlur={e => e.target.value !== (roster.clockId ?? '') && patch({ clockId: e.target.value })}
          className={inputClass}
        />
      </Field>

      <Field label="Tip role" hint="The multiplier applied to this person's hours in the split.">
        <select
          value={roster.tipRoleId ?? ''}
          disabled={busy}
          onChange={e => patch({ tipRoleId: e.target.value || null })}
          className={inputClass}
        >
          <option value="">No role</option>
          {payload.tipRoles.map(r => (
            <option key={r.id} value={r.id}>{r.name} — ×{r.multiplier}</option>
          ))}
        </select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Daily hour cap"
          hint="Contracted shift length. Hours above this on any single day are not paid tips. Blank = uncapped."
        >
          <input
            type="number" step="0.25" min="0" max="24"
            defaultValue={roster.dailyHourCap ?? ''}
            disabled={busy}
            placeholder="uncapped"
            onBlur={e => {
              const next = e.target.value === '' ? null : e.target.value
              if (String(next ?? '') !== String(roster.dailyHourCap ?? '')) patch({ dailyHourCap: next })
            }}
            className={inputClass}
          />
        </Field>

        <Field label="Wage" hint="Reference only — never affects the split.">
          <input
            type="number" step="0.25" min="0"
            defaultValue={roster.wage ?? ''}
            disabled={busy}
            placeholder="—"
            onBlur={e => {
              const next = e.target.value === '' ? null : e.target.value
              if (String(next ?? '') !== String(roster.wage ?? '')) patch({ wage: next })
            }}
            className={inputClass}
          />
        </Field>
      </div>

      <p className="text-[11px] text-ink-4 leading-relaxed">
        The house-wide default cap in Tip settings is a prefill for new roster rows only — the cap
        that actually applies is the one on this page.
      </p>

      {error && (
        <div className="flex gap-2 px-3 py-2.5 bg-red-soft border border-line rounded-[10px]">
          <span className="text-red-text">⚠</span>
          <p className="text-[12.5px] text-red-text leading-relaxed">{error}</p>
        </div>
      )}
      {warning && <WarningNote>{warning}</WarningNote>}
    </div>
  )
}
```

- [ ] **Step 3: Mount both tabs**

In `src/components/people/hub/PersonDetail.tsx`, add the imports and replace the two placeholder branches:

```tsx
import PrepTab from './PrepTab'
import TipsTab from './TipsTab'
```

```tsx
        {tab === 'prep' && <PrepTab person={person} payload={payload} onChanged={onChanged} />}
        {tab === 'tips' && <TipsTab person={person} payload={payload} onChanged={onChanged} />}
```

Then remove the now-unused `EmptyTab` import from `PersonDetail.tsx` if nothing else in the file references it.

- [ ] **Step 4: Type-check**

```bash
npm run build
```

Expected: build succeeds with no unused-import warnings.

- [ ] **Step 5: Verify in the browser**

Open `/setup/users` → pick a roster person. On **Prep**: change the home station and confirm it persists across a reload; toggle roster active and confirm the person dims in the list. On **Tips**: clear the clock ID while On pool is set and confirm the amber "silent zero" warning appears, and that the same person now shows a ⚠ in the list row; set a clock ID that already belongs to someone else and confirm the readable 409 naming the holder appears inline; change the tip role and the cap and confirm both persist. Confirm a login-only person shows the "Not on the kitchen roster" empty state on both tabs. Check `read_console_messages`.

- [ ] **Step 6: Commit**

```bash
git add src/components/people/hub
git commit -m "feat(people): Prep and Tips tabs, with the on-pool-without-clock-ID check"
```

---

### Task 10: Add-person modal

**Files:**
- Create: `src/components/people/hub/AddPersonModal.tsx`
- Modify: `src/app/setup/users/page.tsx` (wire the button, add the bulk-invite link)

**Interfaces:**
- Consumes: `POST /api/settings/people` from Task 4; `AssignmentEditor`, `AssignmentDraft`; `assignableLevels`, `ROLE_LABELS`, `ROLE_DESCRIPTIONS` from `@/lib/roles`; `PeopleHubPayload`.
- Produces: `AddPersonModal` with props `{ payload, actorRole, onClose, onCreated }`.

- [ ] **Step 1: Write the modal**

Create `src/components/people/hub/AddPersonModal.tsx`:

```tsx
'use client'
import { useState } from 'react'
import type { Role } from '@prisma/client'
import { X, Loader2 } from 'lucide-react'
import { assignableLevels, ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/roles'
import AssignmentEditor, { type AssignmentDraft } from '@/components/people/AssignmentEditor'
import type { PeopleHubPayload } from '@/app/setup/users/page'
import { Field, SectionLabel, WarningNote, inputClass } from './kit'

interface Props {
  payload: PeopleHubPayload
  actorRole: Role
  onClose: () => void
  onCreated: () => void
}

const ZERO_ASSIGNMENT_ERROR =
  'Assign at least one location or revenue center — a person with no assignments has no access.'

export default function AddPersonModal({ payload, actorRole, onClose, onCreated }: Props) {
  const levels = assignableLevels(actorRole)
  const [name, setName] = useState('')
  const [wantsLogin, setWantsLogin] = useState(true)
  const [wantsRoster, setWantsRoster] = useState(false)
  const [email, setEmail] = useState('')
  const [clearance, setClearance] = useState<Role>(levels.includes('STAFF') ? 'STAFF' : levels[0])
  const [assignments, setAssignments] = useState<AssignmentDraft[]>([])
  const [initials, setInitials] = useState('')
  const [homeStation, setHomeStation] = useState('')
  const [clockId, setClockId] = useState('')
  const [tipRoleId, setTipRoleId] = useState('')
  const [onTipPool, setOnTipPool] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')

  const derivedInitials = (() => {
    const parts = name.trim().split(/\s+/)
    const raw = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.trim().slice(0, 2)
    return raw.toUpperCase().slice(0, 3)
  })()

  const submit = async () => {
    setError(''); setWarning('')
    if (!name.trim()) { setError('Give this person a name.'); return }
    if (!wantsLogin && !wantsRoster) {
      setError('Give this person an app login, a kitchen roster row, or both.'); return
    }
    if (wantsLogin) {
      if (!email.trim()) { setError('Add an email address for the app login.'); return }
      if (assignments.length === 0) { setError(ZERO_ASSIGNMENT_ERROR); return }
    }
    setSaving(true)
    try {
      const res = await fetch('/api/settings/people', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          ...(wantsLogin ? { login: { email: email.trim().toLowerCase(), clearance, assignments } } : {}),
          ...(wantsRoster ? {
            roster: {
              initials: initials.trim() || derivedInitials,
              homeStation: homeStation || null,
              clockId: clockId.trim() || null,
              tipRoleId: tipRoleId || null,
              onTipPool,
            },
          } : {}),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error ?? 'Could not create this person'); return }

      // A partial create is a REAL, valid outcome: the roster row is committed
      // and only the invite failed. Report it and keep the modal open so the
      // admin sees what happened rather than a silent half-success.
      if (body.invite && body.invite.status !== 'invited'
        && body.invite.status !== 'reinvited' && body.invite.status !== 'reactivated') {
        onCreated()
        setWarning(
          body.cookId
            ? `Added to the kitchen roster, but the invite failed: ${body.invite.error}. Retry from their Identity tab.`
            : `The invite failed: ${body.invite.error}`,
        )
        return
      }
      if (body.warning) { onCreated(); setWarning(body.warning); return }

      onCreated()
      onClose()
    } catch (e) {
      // A network rejection throws before any response exists — without this,
      // `saving` stays true forever with no escape short of reopening.
      setError(e instanceof Error ? e.message : 'Network error — could not reach the server')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-ink/40" onClick={onClose} />
      <div className="relative bg-paper rounded-xl border border-line shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 className="font-fraunces text-[17px] font-semibold text-ink">Add person</h2>
          <button onClick={onClose} aria-label="Close" className="text-ink-4 hover:text-ink-2"><X size={16} /></button>
        </div>

        <div className="px-5 py-5 space-y-5">
          <Field label="Name" hint="Their first name is what shows on prep run-sheet chips.">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Mia Chen"
              className={inputClass}
            />
          </Field>

          {/* login half */}
          <div className="border border-line rounded-[10px] overflow-hidden">
            <label className="flex items-center gap-2.5 px-4 py-3 cursor-pointer">
              <input type="checkbox" checked={wantsLogin} onChange={e => setWantsLogin(e.target.checked)} className="accent-gold" />
              <span>
                <b className="block text-[13px] text-ink">Give them an app login</b>
                <span className="block text-[11.5px] text-ink-3">Sends an invite email. They set their own password.</span>
              </span>
            </label>
            {wantsLogin && (
              <div className="px-4 pb-4 space-y-4 border-t border-bg-2 pt-4">
                <Field label="Email">
                  <input
                    type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="name@example.com" className={inputClass}
                  />
                </Field>
                <Field label="Clearance" hint={ROLE_DESCRIPTIONS[clearance]}>
                  <select value={clearance} onChange={e => setClearance(e.target.value as Role)} className={inputClass}>
                    {levels.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                </Field>
                <div>
                  <SectionLabel>Assignments</SectionLabel>
                  <AssignmentEditor
                    locations={payload.locations}
                    value={assignments}
                    primaryClearance={clearance}
                    actorRole={actorRole}
                    onChange={setAssignments}
                  />
                </div>
              </div>
            )}
          </div>

          {/* roster half */}
          <div className="border border-line rounded-[10px] overflow-hidden">
            <label className="flex items-center gap-2.5 px-4 py-3 cursor-pointer">
              <input type="checkbox" checked={wantsRoster} onChange={e => setWantsRoster(e.target.checked)} className="accent-gold" />
              <span>
                <b className="block text-[13px] text-ink">Put them on the kitchen roster</b>
                <span className="block text-[11.5px] text-ink-3">Prep assignments and tip payouts.</span>
              </span>
            </label>
            {wantsRoster && (
              <div className="px-4 pb-4 space-y-4 border-t border-bg-2 pt-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Initials">
                    <input
                      value={initials} onChange={e => setInitials(e.target.value.toUpperCase().slice(0, 3))}
                      placeholder={derivedInitials || 'MC'} className={`${inputClass} uppercase`}
                    />
                  </Field>
                  <Field label="Home station">
                    <select value={homeStation} onChange={e => setHomeStation(e.target.value)} className={inputClass}>
                      <option value="">No station</option>
                      {payload.stations.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </Field>
                  <Field label="Clock ID" hint="POS employee number. Hours match on this alone.">
                    <input value={clockId} onChange={e => setClockId(e.target.value)} placeholder="—" className={inputClass} />
                  </Field>
                  <Field label="Tip role">
                    <select value={tipRoleId} onChange={e => setTipRoleId(e.target.value)} className={inputClass}>
                      <option value="">No role</option>
                      {payload.tipRoles.map(r => <option key={r.id} value={r.id}>{r.name} — ×{r.multiplier}</option>)}
                    </select>
                  </Field>
                </div>
                <label className="flex items-center gap-2.5 text-[12.5px] text-ink-2 cursor-pointer">
                  <input type="checkbox" checked={onTipPool} onChange={e => setOnTipPool(e.target.checked)} className="accent-gold" />
                  On the tip pool
                </label>
              </div>
            )}
          </div>

          {error && (
            <div className="flex gap-2 px-3 py-2.5 bg-red-soft border border-line rounded-[10px]">
              <span className="text-red-text">⚠</span>
              <p className="text-[12.5px] text-red-text leading-relaxed">{error}</p>
            </div>
          )}
          {warning && <WarningNote>{warning}</WarningNote>}

          <button
            onClick={submit}
            disabled={saving}
            className="w-full py-3 rounded-[10px] bg-ink text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Add person
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire it into the page**

In `src/app/setup/users/page.tsx`, add the imports:

```tsx
import AddPersonModal from '@/components/people/hub/AddPersonModal'
import InviteModal from '@/components/people/InviteModal'
```

Add the state:

```tsx
  const [adding, setAdding] = useState(false)
  const [bulkInviting, setBulkInviting] = useState(false)
```

Replace the header button block with a button plus the secondary bulk link:

```tsx
        <div className="flex items-center gap-3">
          <button
            onClick={() => setBulkInviting(true)}
            className="text-[12px] text-ink-3 underline hover:no-underline"
          >
            Invite several people
          </button>
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-2 bg-ink text-white px-4 py-2.5 rounded-[10px] text-[13px] font-medium hover:bg-ink-2"
          >
            <UserPlus size={14} className="text-gold" /> Add person
          </button>
        </div>
```

And mount both modals just before the closing `</div>` of the page:

```tsx
      {adding && data && (
        <AddPersonModal
          payload={data}
          actorRole={user?.role ?? 'STAFF'}
          onClose={() => setAdding(false)}
          onCreated={refresh}
        />
      )}

      {bulkInviting && data && (
        <InviteModal
          locations={data.locations}
          actorRole={user?.role ?? 'STAFF'}
          onClose={() => setBulkInviting(false)}
          onInvited={refresh}
        />
      )}
```

- [ ] **Step 3: Type-check**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 4: Verify in the browser**

Open `/setup/users` → **Add person**. Confirm all four paths: (a) roster only — appears in the "Kitchen roster · no login" group with no email; (b) login only — appears under its assigned location with a Pending pill; (c) both — one row, Identity shows "Linked"; (d) neither box ticked — inline error, nothing created. Also confirm a duplicate clock ID returns the readable 409 naming the holder, and that "Invite several people" still opens the original multi-email modal and works. Check `read_console_messages`.

- [ ] **Step 5: Commit**

```bash
git add src/components/people/hub/AddPersonModal.tsx src/app/setup/users/page.tsx
git commit -m "feat(people): add-person modal creating a login, a roster row, or both"
```

---

### Task 11: Retire `/setup/kitchen-crew`

**Files:**
- Modify: `src/middleware.ts:12-24` (add a `REDIRECTS` entry)
- Modify: `src/lib/__tests__/route-access.test.ts` — only if it asserts on the redirect table; check first
- Delete: `src/app/setup/kitchen-crew/page.tsx`
- Modify: `src/app/setup/page.tsx` (drop one card, retitle another)
- Delete (only if unreferenced): `src/components/people/PeopleList.tsx`, `src/components/people/PersonRow.tsx`, `src/components/people/PersonDetailPanel.tsx`

**Interfaces:**
- Consumes: everything from Tasks 6–10.
- Produces: nothing new.

- [ ] **Step 1: Add the redirect**

In `src/middleware.ts`, add to the `REDIRECTS` array (the table is ordered longest-match-first and returns on the first hit; `/setup/kitchen-crew` collides with nothing, so position is not critical — put it beside the other `/setup` entries):

```ts
  ['/setup/kitchen-crew',      '/setup/users'],
```

- [ ] **Step 2: Delete the page**

```bash
git rm src/app/setup/kitchen-crew/page.tsx
```

- [ ] **Step 3: Update the setup hub**

In `src/app/setup/page.tsx`, delete the entire `{ href: '/setup/kitchen-crew', … }` card line, and replace the `/setup/users` card line with:

```ts
  { href: '/setup/users',           label: 'People',           icon: Users,    description: 'Logins, clearance & assignments, kitchen roster, tip payout setup.',  built: true },
```

Then remove `ChefHat` from the `lucide-react` import at the top of that file **only if** no remaining card uses it.

- [ ] **Step 4: Check whether the old components are now dead**

```bash
grep -rn "PeopleList\|PersonRow\|PersonDetailPanel" src/ --include=*.tsx --include=*.ts
```

Delete each file that has no remaining importer. `PersonDetailPanel` imports `AssignmentEditor` and `people-utils`, both of which the hub still uses — **do not** delete those two. Expected: all three are unreferenced after Tasks 6–10 and can go:

```bash
git rm src/components/people/PeopleList.tsx src/components/people/PersonRow.tsx src/components/people/PersonDetailPanel.tsx
```

`people-utils.ts` stays: `LocationNode` and `Person`-adjacent helpers are still imported by `AssignmentEditor`, `InviteModal` and the hub. If `groupByLocation`, `summarizeAccess`, `chipLabel` or `chipClearance` are now unreferenced, delete just those functions and leave the file.

- [ ] **Step 5: Verify nothing dangles**

```bash
npm test && npm run lint && npm run build
```

Expected: PASS with no unused-import warnings and no unresolved imports.

- [ ] **Step 6: Verify the redirect in the browser**

Navigate to `/setup/kitchen-crew` and confirm it lands on `/setup/users` with the hub rendered. Open `/setup` and confirm the card grid shows **People** and no longer shows **Kitchen crew**. Open `/prep` and confirm the run sheet and assignee chips still work — they read `/api/prep/cooks`, which Task 5 narrowed. Check `read_console_messages`.

- [ ] **Step 7: Commit**

```bash
git add -A src/middleware.ts src/app/setup src/components/people
git commit -m "refactor(setup): retire /setup/kitchen-crew in favour of the People hub"
```

---

## Self-review notes

**Spec coverage** — every spec section maps to a task: model → 1; endpoints → 3, 4; edit-route reuse → 7, 8, 9; list pane incl. the roster-only bucket and reorder → 6; four tabs → 7, 8, 9; create → 4, 10; locked self/OWNER states → 7, 8; permissions → 3, 4 (`requireSession('ADMIN')`), unchanged elsewhere; wage leak → superseded by PR #102 (Task 5 skipped); retirement → 11; failure modes → 4 (partial create), 7/9 (409s inline), kit's `useSave` (audit `warning`); testing → 1, 2, 3, 4, 6.

**Known deviations from the spec, deliberate:**
- The spec says "one new write endpoint". Task 7's *"Put them on the kitchen roster"* button calls `POST /api/prep/cooks` then `PATCH /api/tips/roster/[id]` from the client rather than adding a second orchestrator. Both are existing routes; a `Cook` created this way gets `dailyHourCap: null`, which the Tips tab shows as "uncapped" and the admin can set. If that proves confusing in review, promote it to `POST /api/settings/people` with an existing-user id.
- `AccessAuditPanel` is retained at the bottom of the page (the spec's non-goals exclude a per-person Audit *tab*, not the existing global panel).
