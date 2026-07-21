# User System & Access — Foundation Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a five-level clearance ladder with per-assignment overrides, rebuild `/setup/users` as "People & Access", record every access change in an audit log, and give Shift Leads the operational end-of-day capabilities.

**Architecture:** Extend the existing `Role` enum with `OWNER` and `LEAD` rather than introducing a parallel `Clearance` concept. A new pure module `src/lib/roles.ts` holds rank/labels and is importable from middleware (which cannot import `server-only` code). A new `src/lib/access.ts` owns effective-access resolution around a pure, unit-tested `resolveEffective()`; `rc-scope.ts` keeps every public signature and delegates to it. All schema changes are additive and the code deploys before any data migration runs.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Supabase Auth · Tailwind · Lucide · vitest

**Spec:** `docs/superpowers/specs/2026-07-20-user-system-auth-design.md`

## Global Constraints

- **Tailwind tokens are flat, not numbered.** Use `bg-red`, `text-red-text`, `bg-gold-soft`, `text-gold-2`. Numbered classes (`bg-red-500`) are BROKEN in this project.
- **Prisma singleton only.** Always `import { prisma } from '@/lib/prisma'`. Never instantiate `PrismaClient`.
- **Route handlers that mutate must be dynamic.** Any route file with a non-GET handler needs `export const dynamic = 'force-dynamic'`, or every non-GET method returns 405.
- **Client sub-components at module scope.** A component defined inside another component's body remounts every render and loses focus/state.
- **`import type { Role } from '@prisma/client'`** in `src/lib/roles.ts` — a type-only import is erased at compile time, which is what makes the module safe for the middleware runtime. A value import would break middleware.
- **Prisma `Decimal` serializes as a string** in JSON responses. Wrap with `Number()` before arithmetic.
- **`prisma migrate dev` fails P3006** against this project's shadow DB. Use `migrate diff` → `db execute` → `migrate resolve` over `DIRECT_URL`.
- **Never `$executeRaw` tagged templates for `text[]` writes** — pgBouncer transaction mode rejects named prepared statements. Use `$executeRawUnsafe`.
- Role rank is fixed: `STAFF 0 · LEAD 1 · MANAGER 2 · ADMIN 3 · OWNER 4`.
- Every clearance change writes **both** Prisma `User.role` and Supabase `user_metadata.role`. Never return 200 on a partial write.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `src/lib/roles.ts` | Pure rank table, labels, colors, `atLeast()`, `assignableLevels()`. No `server-only`. |
| `src/lib/access-model.ts` | **Pure**, no `server-only`. Types + `resolveEffective()`. Imported by both the server resolver and the client detail panel — the single definition of the conflict rules. |
| `src/lib/access.ts` | Server-only. `effectiveAccess()` / `clearanceForRc()` Prisma wrappers around `resolveEffective`. |
| `src/lib/access-audit.ts` | `recordAccessEvent()` — the single audit write point. |
| `src/lib/__tests__/roles.test.ts` | Rank ordering, `assignableLevels`. |
| `src/lib/__tests__/access.test.ts` | `resolveEffective` resolution rules. |
| `src/app/api/settings/users/[id]/assignments/route.ts` | PUT — replace assignment set, diff, audit. |
| `src/app/api/settings/users/[id]/resend/route.ts` | POST — resend invite. |
| `src/app/api/settings/access-audit/route.ts` | GET — audit feed. |
| `src/components/people/people-utils.ts` | Grouping, chip formatting, effective-access summarizing. |
| `src/components/people/PersonRow.tsx` | One person row. |
| `src/components/people/PeopleList.tsx` | Location-grouped list, search, filters, pending invites. |
| `src/components/people/AssignmentEditor.tsx` | Location→RC tree with per-node override picker. Shared. |
| `src/components/people/InviteModal.tsx` | T2. |
| `src/components/people/PersonDetailPanel.tsx` | T3 + T4. |
| `src/components/people/AccessAuditPanel.tsx` | T6. |
| `scripts/migrate-clearance.ts` | Idempotent backfill: promote Owner, grandfather assignments. |
| `prisma/migrations/<ts>_clearance_expand/migration.sql` | Additive schema expand. |

**Modified:**

| Path | Change |
|---|---|
| `tailwind.config.ts` | Add `teal`, `teal-soft`, `teal-text` tokens. |
| `prisma/schema.prisma` | `Role` +2 values; `UserScope.clearance`; `AccessAuditEvent`; `User` back-relations. |
| `src/lib/auth.ts` | Import `ROLE_RANK` from `roles.ts`; `devBypassUser` prefers `OWNER`. |
| `src/lib/rc-scope.ts` | `resolveScopedRcIds` treats `OWNER` like `ADMIN`; delegates to `access.ts`. |
| `src/middleware.ts` | `atLeast()` instead of string equality; new `LEAD_PREFIXES`. |
| `src/contexts/UserContext.tsx` | `UserRole` gains `OWNER`/`LEAD`; expose `effectiveAccess`. |
| `src/app/api/me/route.ts` | Return `effectiveAccess`. |
| `src/app/api/settings/users/route.ts` | GET returns assignments + pending; POST takes clearance + assignments, rejects zero. |
| `src/app/api/settings/users/[id]/route.ts` | Owner guards, new roles, audit writes, sync-failure rollback. |
| `src/app/api/eod/close/route.ts` | `LEAD` allowed; money fields stripped/rejected for `LEAD`. |
| `src/app/api/eod/close/entry/route.ts` | `LEAD`. |
| `src/app/api/eod/close/signoff/route.ts` | `LEAD`. |
| `src/app/end-of-day/page.tsx` | Hide money for `LEAD`; degrade on 403. |
| `src/app/setup/users/page.tsx` | Becomes a thin container over `src/components/people/`. |

**Deleted:**

| Path | Reason |
|---|---|
| `src/app/api/settings/user-scopes/route.ts` | Replaced by `users/[id]/assignments`. Only caller is the `ScopeModal` this slice removes. |

---

# Phase 1 — Foundation

### Task 1: `roles.ts` — rank table, labels, assignable levels

**Files:**
- Create: `src/lib/roles.ts`
- Create: `src/lib/__tests__/roles.test.ts`
- Modify: `tailwind.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ROLE_RANK: Record<Role, number>`, `atLeast(role: Role, min: Role): boolean`, `ROLE_LABELS: Record<Role, string>`, `ROLE_COLORS: Record<Role, string>`, `ROLE_DOT: Record<Role, string>`, `ROLE_ORDER: Role[]`, `assignableLevels(actor: Role): Role[]`.

- [ ] **Step 1: Add teal tokens to Tailwind**

In `tailwind.config.ts`, directly after the `blue-text` line inside `colors`:

```ts
        teal:          '#0d9488',  // teal-600  — Shift Lead
        'teal-soft':   '#ccfbf1',  // teal-100
        'teal-text':   '#0f766e',  // teal-700
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/__tests__/roles.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ROLE_RANK, atLeast, assignableLevels, ROLE_LABELS, ROLE_ORDER } from '../roles'

describe('ROLE_RANK', () => {
  it('orders STAFF < LEAD < MANAGER < ADMIN < OWNER', () => {
    expect(ROLE_RANK.STAFF).toBeLessThan(ROLE_RANK.LEAD)
    expect(ROLE_RANK.LEAD).toBeLessThan(ROLE_RANK.MANAGER)
    expect(ROLE_RANK.MANAGER).toBeLessThan(ROLE_RANK.ADMIN)
    expect(ROLE_RANK.ADMIN).toBeLessThan(ROLE_RANK.OWNER)
  })
})

describe('atLeast', () => {
  it('lets OWNER pass every existing gate', () => {
    expect(atLeast('OWNER', 'ADMIN')).toBe(true)
    expect(atLeast('OWNER', 'MANAGER')).toBe(true)
  })
  it('keeps LEAD below MANAGER so existing manager gates are unchanged', () => {
    expect(atLeast('LEAD', 'MANAGER')).toBe(false)
    expect(atLeast('LEAD', 'ADMIN')).toBe(false)
  })
  it('lets LEAD pass a LEAD gate but not STAFF pass it', () => {
    expect(atLeast('LEAD', 'LEAD')).toBe(true)
    expect(atLeast('STAFF', 'LEAD')).toBe(false)
  })
  it('is reflexive', () => {
    for (const r of ROLE_ORDER) expect(atLeast(r, r)).toBe(true)
  })
})

describe('assignableLevels', () => {
  it('never offers OWNER to anyone', () => {
    for (const r of ROLE_ORDER) expect(assignableLevels(r)).not.toContain('OWNER')
  })
  it('lets OWNER and ADMIN assign every non-owner level', () => {
    expect(assignableLevels('OWNER')).toEqual(['ADMIN', 'MANAGER', 'LEAD', 'STAFF'])
    expect(assignableLevels('ADMIN')).toEqual(['ADMIN', 'MANAGER', 'LEAD', 'STAFF'])
  })
  it('limits MANAGER to LEAD and STAFF', () => {
    expect(assignableLevels('MANAGER')).toEqual(['LEAD', 'STAFF'])
  })
  it('gives LEAD and STAFF nothing', () => {
    expect(assignableLevels('LEAD')).toEqual([])
    expect(assignableLevels('STAFF')).toEqual([])
  })
})

describe('ROLE_LABELS', () => {
  it('calls LEAD "Shift Lead"', () => {
    expect(ROLE_LABELS.LEAD).toBe('Shift Lead')
  })
})
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npm test -- roles`
Expected: FAIL — `Cannot find module '../roles'`

- [ ] **Step 4: Implement `roles.ts`**

Create `src/lib/roles.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- roles`
Expected: PASS — all 9 tests.

Note: these tests pass before the Prisma enum is widened because `Role` is a type-only import; the runtime objects are plain literals.

- [ ] **Step 6: Commit**

```bash
git add src/lib/roles.ts src/lib/__tests__/roles.test.ts tailwind.config.ts
git commit -m "feat(access): add roles.ts clearance vocabulary + teal token"
```

---

### Task 2: Schema + expand migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_clearance_expand/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `Role` values `OWNER`/`LEAD`; `UserScope.clearance: Role | null`; Prisma model `AccessAuditEvent` with fields `id, actorId, actorEmail, actorName, targetUserId, targetEmail, targetName, action, detail, createdAt`.

- [ ] **Step 1: Widen the `Role` enum**

In `prisma/schema.prisma`, replace the `Role` enum:

```prisma
enum Role {
  OWNER
  ADMIN
  MANAGER
  LEAD
  STAFF
}
```

- [ ] **Step 2: Add `clearance` to `UserScope`**

Add this field to `model UserScope`, directly after `revenueCenterId`. Leave the existing `@@unique` and the `UserScope_user_node_unique` comment block untouched — adding a column does not change the tuple they cover.

```prisma
  clearance       Role?          // null = inherit the user's primary clearance
```

- [ ] **Step 3: Add the audit model and `User` back-relations**

Add to `model User`:

```prisma
  auditEventsActed    AccessAuditEvent[] @relation("AuditActor")
  auditEventsReceived AccessAuditEvent[] @relation("AuditTarget")
```

Add a new model:

```prisma
// Append-only log of access changes. Actor and target ids are SetNull so a
// hard-deleted user blanks the id but leaves the row; the denormalized
// email/name columns are what keep the entry readable afterwards.
model AccessAuditEvent {
  id           String   @id @default(cuid())
  actorId      String?
  actor        User?    @relation("AuditActor",  fields: [actorId],      references: [id], onDelete: SetNull)
  actorEmail   String
  actorName    String?
  targetUserId String?
  target       User?    @relation("AuditTarget", fields: [targetUserId], references: [id], onDelete: SetNull)
  targetEmail  String
  targetName   String?
  action       String
  detail       Json     @default("{}")
  createdAt    DateTime @default(now())

  @@index([createdAt])
  @@index([targetUserId])
}
```

- [ ] **Step 4: Generate the client and confirm the types compile**

Run: `npx prisma generate`
Expected: "Generated Prisma Client".

Run: `npm test -- roles`
Expected: PASS — `Record<Role, …>` in `roles.ts` now type-checks against a 5-value enum. **If this fails with "missing OWNER/LEAD", the schema edit did not take.**

- [ ] **Step 5: Write the migration SQL by hand**

Create `prisma/migrations/20260720120000_clearance_expand/migration.sql`. Two enum statements come first and are committed separately from everything that uses them — Postgres forbids using an enum value in the same transaction that added it.

```sql
-- Phase 1a: widen the enum. These MUST be applied before any statement below
-- references 'OWNER' or 'LEAD'.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'OWNER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'LEAD';
```

Create a second file `prisma/migrations/20260720120100_clearance_tables/migration.sql`:

```sql
-- Phase 1b: additive columns, tables and indexes.
ALTER TABLE "UserScope" ADD COLUMN IF NOT EXISTS "clearance" "Role";

CREATE TABLE IF NOT EXISTS "AccessAuditEvent" (
  "id"           TEXT NOT NULL,
  "actorId"      TEXT,
  "actorEmail"   TEXT NOT NULL,
  "actorName"    TEXT,
  "targetUserId" TEXT,
  "targetEmail"  TEXT NOT NULL,
  "targetName"   TEXT,
  "action"       TEXT NOT NULL,
  "detail"       JSONB NOT NULL DEFAULT '{}',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccessAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AccessAuditEvent_createdAt_idx"    ON "AccessAuditEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "AccessAuditEvent_targetUserId_idx" ON "AccessAuditEvent"("targetUserId");

ALTER TABLE "AccessAuditEvent"
  ADD CONSTRAINT "AccessAuditEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AccessAuditEvent"
  ADD CONSTRAINT "AccessAuditEvent_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most one OWNER. The index only covers rows where role = 'OWNER', and every
-- such row has the identical key 'OWNER', so a second one collides.
CREATE UNIQUE INDEX IF NOT EXISTS "User_single_owner" ON "User" ("role") WHERE "role" = 'OWNER';
```

- [ ] **Step 6: Apply both migrations over DIRECT_URL**

`prisma migrate dev` fails P3006 here; apply directly, enum file first.

```bash
npx prisma db execute --url "$DIRECT_URL" --file prisma/migrations/20260720120000_clearance_expand/migration.sql
npx prisma db execute --url "$DIRECT_URL" --file prisma/migrations/20260720120100_clearance_tables/migration.sql
npx prisma migrate resolve --applied 20260720120000_clearance_expand
npx prisma migrate resolve --applied 20260720120100_clearance_tables
```

Expected: each `db execute` prints "Script executed successfully."

- [ ] **Step 7: Verify against the database**

```bash
npx prisma db execute --url "$DIRECT_URL" --stdin <<'SQL'
SELECT unnest(enum_range(NULL::"Role")) AS role;
SQL
```

Expected: five rows including `OWNER` and `LEAD`.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(access): expand Role enum, UserScope.clearance, AccessAuditEvent"
```

---

### Task 3: `access-model.ts` + `access.ts` — effective-access resolution

**Files:**
- Create: `src/lib/access-model.ts`
- Create: `src/lib/access.ts`
- Create: `src/lib/__tests__/access.test.ts`

**Interfaces:**
- Consumes: `ROLE_RANK` from `src/lib/roles.ts`.
- Produces, from `src/lib/access-model.ts` (**pure — no `server-only`**, so client components can import it):
  - `interface ScopeRow { locationId: string | null; revenueCenterId: string | null; clearance: Role | null }`
  - `interface RcNode { id: string; name: string; locationId: string; locationName: string }`
  - `interface EffectiveEntry { rcId: string; rcName: string; locationId: string; locationName: string; clearance: Role; source: 'inherited' | 'override' }`
  - `resolveEffective(primary: Role, scopes: ScopeRow[], rcs: RcNode[]): EffectiveEntry[]`
- Produces, from `src/lib/access.ts` (server-only):
  - `effectiveAccess(user: User): Promise<EffectiveEntry[]>`
  - `clearanceForRc(user: User, rcId: string): Promise<Role | null>`
  - re-exports the `access-model` types for server callers

**Why two files:** the conflict rules must be defined exactly once. `PersonDetailPanel` (Task 18) previews effective access in the browser as the admin edits assignments, and `access.ts` carries `server-only`, so a client component cannot import it. The pure half lives in `access-model.ts` and both sides import that.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/access.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveEffective, type RcNode, type ScopeRow } from '../access-model'

// Downtown has two RCs, Uptown has one.
const RCS: RcNode[] = [
  { id: 'rc-kitchen', name: 'Kitchen',       locationId: 'loc-dt', locationName: 'Downtown' },
  { id: 'rc-dtbar',   name: 'Downtown Bar',  locationId: 'loc-dt', locationName: 'Downtown' },
  { id: 'rc-rooftop', name: 'Rooftop Bar',   locationId: 'loc-up', locationName: 'Uptown'   },
]

const byRc = (out: ReturnType<typeof resolveEffective>) =>
  Object.fromEntries(out.map(e => [e.rcId, e.clearance]))

describe('resolveEffective', () => {
  it('returns nothing when there are no assignments', () => {
    expect(resolveEffective('MANAGER', [], RCS)).toEqual([])
  })

  it('expands a location assignment to every child RC at the inherited clearance', () => {
    const scopes: ScopeRow[] = [{ locationId: 'loc-dt', revenueCenterId: null, clearance: null }]
    const out = resolveEffective('MANAGER', scopes, RCS)
    expect(out).toHaveLength(2)
    expect(byRc(out)).toEqual({ 'rc-kitchen': 'MANAGER', 'rc-dtbar': 'MANAGER' })
    expect(out.every(e => e.source === 'inherited')).toBe(true)
  })

  it('marks a location assignment carrying its own clearance as an override', () => {
    const scopes: ScopeRow[] = [{ locationId: 'loc-dt', revenueCenterId: null, clearance: 'STAFF' }]
    const out = resolveEffective('MANAGER', scopes, RCS)
    expect(byRc(out)).toEqual({ 'rc-kitchen': 'STAFF', 'rc-dtbar': 'STAFF' })
    expect(out.every(e => e.source === 'override')).toBe(true)
  })

  it('resolves a single-RC assignment', () => {
    const scopes: ScopeRow[] = [{ locationId: null, revenueCenterId: 'rc-kitchen', clearance: null }]
    const out = resolveEffective('LEAD', scopes, RCS)
    expect(byRc(out)).toEqual({ 'rc-kitchen': 'LEAD' })
  })

  it('lets an RC-level override beat the location assignment above it', () => {
    // The T3 example: Manager at Downtown, Staff override at Rooftop (Uptown).
    const scopes: ScopeRow[] = [
      { locationId: 'loc-dt', revenueCenterId: null,        clearance: null },
      { locationId: null,     revenueCenterId: 'rc-rooftop', clearance: 'STAFF' },
    ]
    const out = resolveEffective('MANAGER', scopes, RCS)
    expect(byRc(out)).toEqual({
      'rc-kitchen': 'MANAGER', 'rc-dtbar': 'MANAGER', 'rc-rooftop': 'STAFF',
    })
    expect(out.find(e => e.rcId === 'rc-rooftop')!.source).toBe('override')
  })

  it('prefers the RC-level row even when it is weaker than the location row', () => {
    const scopes: ScopeRow[] = [
      { locationId: 'loc-dt', revenueCenterId: null,         clearance: null },
      { locationId: null,     revenueCenterId: 'rc-kitchen', clearance: 'STAFF' },
    ]
    expect(byRc(resolveEffective('MANAGER', scopes, RCS))['rc-kitchen']).toBe('STAFF')
  })

  it('takes the higher clearance when two rows of equal specificity overlap', () => {
    const scopes: ScopeRow[] = [
      { locationId: 'loc-dt', revenueCenterId: null, clearance: 'STAFF'   },
      { locationId: 'loc-dt', revenueCenterId: null, clearance: 'MANAGER' },
    ]
    expect(byRc(resolveEffective('LEAD', scopes, RCS))['rc-kitchen']).toBe('MANAGER')
  })

  it('ignores assignments pointing at unknown or inactive nodes', () => {
    const scopes: ScopeRow[] = [
      { locationId: 'loc-gone', revenueCenterId: null,      clearance: null },
      { locationId: null,       revenueCenterId: 'rc-gone', clearance: null },
    ]
    expect(resolveEffective('MANAGER', scopes, RCS)).toEqual([])
  })

  it('carries location naming through for display', () => {
    const scopes: ScopeRow[] = [{ locationId: null, revenueCenterId: 'rc-rooftop', clearance: null }]
    const [entry] = resolveEffective('STAFF', scopes, RCS)
    expect(entry).toMatchObject({
      rcId: 'rc-rooftop', rcName: 'Rooftop Bar',
      locationId: 'loc-up', locationName: 'Uptown',
    })
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- access`
Expected: FAIL — `Cannot find module '../access'`

- [ ] **Step 3: Implement the pure half — `access-model.ts`**

Create `src/lib/access-model.ts`. No `server-only` marker: `PersonDetailPanel` imports `resolveEffective` from here to preview effective access in the browser, so the conflict rules exist in exactly one place.

```ts
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
```

- [ ] **Step 4: Implement the server half — `access.ts`**

Create `src/lib/access.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- access`
Expected: PASS — all 9 tests.

- [ ] **Step 6: Run the whole suite for regressions**

Run: `npm test`
Expected: PASS — the pre-existing suites plus the new ones.

- [ ] **Step 7: Commit**

```bash
git add src/lib/access-model.ts src/lib/access.ts src/lib/__tests__/access.test.ts
git commit -m "feat(access): effective-access resolution with per-assignment overrides"
```

---

### Task 4: Wire `auth.ts` and `rc-scope.ts` to the new ladder

**Files:**
- Modify: `src/lib/auth.ts`
- Modify: `src/lib/rc-scope.ts`

**Interfaces:**
- Consumes: `ROLE_RANK`, `atLeast` from `roles.ts`.
- Produces: no signature changes. `requireSession(minRole?)` and every `rc-scope.ts` export keep their exact shapes.

- [ ] **Step 1: Replace the local rank table in `auth.ts`**

Delete these lines from `src/lib/auth.ts`:

```ts
// Role strength: ADMIN > MANAGER > STAFF
const ROLE_RANK: Record<Role, number> = {
  STAFF: 0,
  MANAGER: 1,
  ADMIN: 2,
}
```

Add to the imports at the top:

```ts
import { ROLE_RANK } from '@/lib/roles'
```

- [ ] **Step 2: Prefer an OWNER for the dev bypass**

Replace the body of `devBypassUser` in `src/lib/auth.ts`:

```ts
async function devBypassUser(): Promise<User | null> {
  return (
    (await prisma.user.findFirst({ where: { role: 'OWNER', isActive: true } })) ??
    (await prisma.user.findFirst({ where: { role: 'ADMIN', isActive: true } })) ??
    (await prisma.user.findFirst({ where: { isActive: true } }))
  )
}
```

- [ ] **Step 3: Treat OWNER as unrestricted in `rc-scope.ts`**

In `src/lib/rc-scope.ts`, change the first line of `resolveScopedRcIds`:

```ts
  if (user.role === 'OWNER' || user.role === 'ADMIN') return null
```

Update the doc comment above it — replace the `- ADMIN → null (all)` bullet with:

```
 * - OWNER / ADMIN              → null (all)
```

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: compiles. Any error naming `ROLE_LABELS`, `ROLE_COLORS`, or an exhaustive `Record<Role, …>` is Task 8's work — note the file and move on **only if** it is in `src/app/setup/users/page.tsx` or `src/contexts/UserContext.tsx`. Anything else must be fixed now.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth.ts src/lib/rc-scope.ts
git commit -m "feat(access): rank-based auth + OWNER unrestricted in rc-scope"
```

---

### Task 5: Middleware — rank gating and `LEAD_PREFIXES`

**Files:**
- Modify: `src/middleware.ts`

**Interfaces:**
- Consumes: `atLeast`, `ROLE_RANK` from `roles.ts`.
- Produces: `/end-of-day` reachable at rank ≥ LEAD; `/setup` reachable by OWNER.

- [ ] **Step 1: Import the rank helper and add the prefix list**

At the top of `src/middleware.ts`, after the existing imports:

```ts
import type { Role } from '@prisma/client'
import { atLeast, ROLE_RANK } from '@/lib/roles'
```

Replace the `MANAGER_PREFIXES` declaration with:

```ts
// Routes that require MANAGER or above
const MANAGER_PREFIXES = ['/reports', '/pass', '/cost', '/variance', '/signals']

// Routes a Shift Lead may reach. /end-of-day moved out of MANAGER_PREFIXES:
// a Lead runs the operational close (checklist, temps, sign-off, handover).
// The money endpoints behind that page stay MANAGER — see src/app/api/eod/*.
const LEAD_PREFIXES = ['/end-of-day']
```

- [ ] **Step 2: Replace the string comparisons with rank checks**

Replace this block:

```ts
  const role = (user.user_metadata?.role as string | undefined) ?? 'STAFF'

  if (ADMIN_PREFIXES.some((p) => pathname.startsWith(p)) && role !== 'ADMIN') {
    return NextResponse.redirect(new URL('/', request.url))
  }

  if (
    MANAGER_PREFIXES.some((p) => pathname.startsWith(p)) &&
    role !== 'MANAGER' &&
    role !== 'ADMIN'
  ) {
    return NextResponse.redirect(new URL('/', request.url))
  }
```

with:

```ts
  // Unknown / missing metadata falls back to STAFF, the least privileged level.
  const rawRole = user.user_metadata?.role as string | undefined
  const role: Role = rawRole && rawRole in ROLE_RANK ? (rawRole as Role) : 'STAFF'

  const needs = (prefixes: string[]) => prefixes.some((p) => pathname.startsWith(p))

  if (needs(ADMIN_PREFIXES) && !atLeast(role, 'ADMIN')) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  if (needs(MANAGER_PREFIXES) && !atLeast(role, 'MANAGER')) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  if (needs(LEAD_PREFIXES) && !atLeast(role, 'LEAD')) {
    return NextResponse.redirect(new URL('/', request.url))
  }
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles. Confirm the middleware chunk builds — a value import from `@prisma/client` here would fail; only `import type` is used.

- [ ] **Step 4: Commit**

```bash
git add src/middleware.ts
git commit -m "feat(access): rank-based middleware gating, /end-of-day open to LEAD"
```

---

# Phase 2 — Backend APIs

### Task 6: `access-audit.ts` — the single audit write point

**Files:**
- Create: `src/lib/access-audit.ts`

**Interfaces:**
- Consumes: `prisma`.
- Produces:
  - `type AccessAction = 'INVITED' | 'REINVITED' | 'INVITE_REVOKED' | 'CLEARANCE_CHANGED' | 'ASSIGNMENT_ADDED' | 'ASSIGNMENT_REMOVED' | 'OVERRIDE_SET' | 'OVERRIDE_CLEARED' | 'DEACTIVATED' | 'REACTIVATED' | 'REMOVED'`
  - `interface AuditParty { id: string | null; email: string; name: string | null }`
  - `recordAccessEvent(client, { actor, target, action, detail? }): Promise<void>`
  - `type AuditClient = PrismaClient | Prisma.TransactionClient`

- [ ] **Step 1: Implement**

Create `src/lib/access-audit.ts`:

```ts
import 'server-only'
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'

export type AccessAction =
  | 'INVITED'
  | 'REINVITED'
  | 'INVITE_REVOKED'
  | 'CLEARANCE_CHANGED'
  | 'ASSIGNMENT_ADDED'
  | 'ASSIGNMENT_REMOVED'
  | 'OVERRIDE_SET'
  | 'OVERRIDE_CLEARED'
  | 'DEACTIVATED'
  | 'REACTIVATED'
  | 'REMOVED'

export interface AuditParty {
  /** null when the row is gone (hard delete) — email/name still identify them. */
  id: string | null
  email: string
  name: string | null
}

export interface AuditDetail {
  from?: string | null
  to?: string | null
  locationId?: string | null
  locationName?: string | null
  rcId?: string | null
  rcName?: string | null
  [k: string]: unknown
}

/** Accepts either the singleton or a transaction client, so audit writes can
 *  ride inside the same transaction as the mutation they describe. */
export type AuditClient = PrismaClient | Prisma.TransactionClient

export async function recordAccessEvent(
  client: AuditClient,
  args: {
    actor: AuditParty
    target: AuditParty
    action: AccessAction
    detail?: AuditDetail
  },
): Promise<void> {
  await client.accessAuditEvent.create({
    data: {
      actorId: args.actor.id,
      actorEmail: args.actor.email,
      actorName: args.actor.name,
      targetUserId: args.target.id,
      targetEmail: args.target.email,
      targetName: args.target.name,
      action: args.action,
      detail: (args.detail ?? {}) as Prisma.InputJsonValue,
    },
  })
}

/** Convenience for routes that are not already inside a transaction. */
export const recordAccessEventStandalone = (
  args: Parameters<typeof recordAccessEvent>[1],
) => recordAccessEvent(prisma, args)
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/lib/access-audit.ts
git commit -m "feat(access): access-audit write helper"
```

---

### Task 7: Users list + invite with clearance and assignments

**Files:**
- Modify: `src/app/api/settings/users/route.ts`

**Interfaces:**
- Consumes: `recordAccessEvent`, `assignableLevels`, `atLeast`, `effectiveAccess`.
- Produces: `GET /api/settings/users` → `{ users: PersonDTO[], locations: LocationDTO[] }`; `POST` body `{ emails: string[], clearance: Role, assignments: AssignmentInput[], name?: string }`.
  - `interface AssignmentInput { locationId?: string | null; revenueCenterId?: string | null; clearance?: Role | null }`
  - `interface PersonDTO { id, email, name, role: Role, isActive: boolean, createdAt: string, isPending: boolean, assignments: Array<{ id, locationId, locationName, revenueCenterId, rcName, clearance: Role | null }> }`
  - `interface LocationDTO { id, name, color, revenueCenters: Array<{ id, name, color }> }`

- [ ] **Step 1: Replace the GET handler**

In `src/app/api/settings/users/route.ts`, add near the top:

```ts
export const dynamic = 'force-dynamic'
```

and replace the whole `GET` function with:

```ts
// GET — everyone plus their assignments, and the location tree the editors need.
export async function GET() {
  try { await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const [users, locations] = await Promise.all([
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
      },
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
  ])

  const shaped = users.map(u => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isActive: u.isActive,
    createdAt: u.createdAt,
    // A Prisma row is created inactive at invite time and flipped active by
    // /auth/callback when the invite is accepted. isActive === false with no
    // name is therefore a genuine pending invite, not a deactivation.
    isPending: !u.isActive && u.name === null,
    assignments: u.scopes.map(s => ({
      id: s.id,
      locationId: s.location?.id ?? s.revenueCenter?.location.id ?? null,
      locationName: s.location?.name ?? s.revenueCenter?.location.name ?? null,
      revenueCenterId: s.revenueCenter?.id ?? null,
      rcName: s.revenueCenter?.name ?? null,
      clearance: s.clearance,
    })),
  }))

  return NextResponse.json({ users: shaped, locations })
}
```

- [ ] **Step 2: Replace `VALID_ROLES` with rank-aware validation**

Replace the `VALID_ROLES` const at the top of the file:

```ts
import { assignableLevels } from '@/lib/roles'
import { recordAccessEvent } from '@/lib/access-audit'
```

and delete `const VALID_ROLES: Role[] = ['ADMIN', 'MANAGER', 'STAFF']`.

- [ ] **Step 3: Rewrite the POST handler**

Replace the whole `POST` function. The existing idempotent reconcile behaviour is preserved verbatim; what is new is multi-email support, assignment creation, the zero-assignment rejection, and audit writes.

```ts
interface AssignmentInput {
  locationId?: string | null
  revenueCenterId?: string | null
  clearance?: Role | null
}

/** Validates shape + referential integrity. Returns an error string or null. */
async function validateAssignments(rows: AssignmentInput[]): Promise<string | null> {
  if (rows.length === 0) {
    return 'Assign at least one location or revenue center — a person with no assignments has no access.'
  }
  const locationIds = new Set<string>()
  const rcIds = new Set<string>()
  for (const r of rows) {
    const hasLoc = !!r.locationId
    const hasRc = !!r.revenueCenterId
    if (hasLoc === hasRc) {
      return 'Each assignment must target exactly one location or one revenue center.'
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

/** Dedup by target node; the DB index is NULLS NOT DISTINCT but dedup keeps
 *  createMany from throwing on an obvious double-click. */
function dedupeAssignments(rows: AssignmentInput[]) {
  const seen = new Set<string>()
  return rows
    .map(r => ({
      locationId: r.locationId ?? null,
      revenueCenterId: r.revenueCenterId ?? null,
      clearance: r.clearance ?? null,
    }))
    .filter(r => {
      const key = `${r.locationId ?? ''}|${r.revenueCenterId ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

// POST — invite one or more people (ADMIN only)
// Body: { emails: string[], clearance: Role, assignments: AssignmentInput[], name?: string }
//
// Idempotent per email, exactly as before:
//   - Pending (never accepted): stale Auth user removed, fresh invite sent.
//   - Accepted before: reactivated in place with the new clearance, no email.
export async function POST(req: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || new URL(req.url).origin
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => ({}))
  const {
    emails: rawEmails, email: singleEmail, clearance, assignments: rawAssignments, name: rawName,
  } = body as {
    emails?: string[]; email?: string; clearance?: string
    assignments?: AssignmentInput[]; name?: string
  }

  const emails = [...new Set(
    (Array.isArray(rawEmails) ? rawEmails : singleEmail ? [singleEmail] : [])
      .map(e => e?.trim().toLowerCase())
      .filter((e): e is string => !!e),
  )]
  const name = rawName?.trim() || null

  if (emails.length === 0) {
    return NextResponse.json({ error: 'At least one email is required' }, { status: 400 })
  }
  const allowed = assignableLevels(admin.role)
  if (!clearance || !allowed.includes(clearance as Role)) {
    return NextResponse.json(
      { error: `Clearance must be one of: ${allowed.join(', ')}` }, { status: 400 },
    )
  }
  if (emails.includes(admin.email.toLowerCase())) {
    return NextResponse.json({ error: 'Cannot invite yourself' }, { status: 400 })
  }

  const assignments = dedupeAssignments(Array.isArray(rawAssignments) ? rawAssignments : [])
  const assignmentError = await validateAssignments(assignments)
  if (assignmentError) return NextResponse.json({ error: assignmentError }, { status: 400 })

  const role = clearance as Role
  const supabaseAdmin = createAdminClient()
  const actor = { id: admin.id, email: admin.email, name: admin.name }
  const results: Array<{ email: string; status: string; error?: string }> = []

  for (const email of emails) {
    const inviteMeta = { role, isActive: true, name }

    const sendInvite = async () => {
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
      // the delete isn't visible to the insert, yielding P2002 on email.
      const user = await prisma.$transaction(async (tx) => {
        await tx.user.deleteMany({ where: { email } })
        const created = await tx.user.create({
          data: { id: newId, email, name, role, isActive: false },
        })
        await tx.userScope.createMany({
          data: assignments.map(a => ({ ...a, userId: newId })),
        })
        return created
      })
      return { user }
    }

    const first = await sendInvite()
    if (first.user) {
      await recordAccessEvent(prisma, {
        actor, target: { id: first.user.id, email, name },
        action: 'INVITED', detail: { to: role },
      })
      results.push({ email, status: 'invited' })
      continue
    }
    if (!isAlreadyRegisteredError(first.error)) {
      results.push({ email, status: 'failed', error: first.error?.message ?? 'Failed to send invite' })
      continue
    }

    const existing = await findAuthUserByEmail(supabaseAdmin, email)
    if (!existing) {
      results.push({ email, status: 'failed', error: 'Email already has an unresolvable account.' })
      continue
    }

    if (!hasAcceptedInvite(existing)) {
      await supabaseAdmin.auth.admin.deleteUser(existing.id)
      const retry = await sendInvite()
      if (retry.user) {
        await recordAccessEvent(prisma, {
          actor, target: { id: retry.user.id, email, name },
          action: 'REINVITED', detail: { to: role },
        })
        results.push({ email, status: 'reinvited' })
      } else {
        results.push({ email, status: 'failed', error: retry.error?.message ?? 'Failed to re-invite' })
      }
      continue
    }

    // Accepted before → reactivate in place. Both stores, or neither.
    const { error: metaError } = await supabaseAdmin.auth.admin.updateUserById(existing.id, {
      user_metadata: { role, isActive: true, name },
    })
    if (metaError) {
      results.push({ email, status: 'failed', error: metaError.message })
      continue
    }
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.upsert({
        where: { id: existing.id },
        create: { id: existing.id, email, name, role, isActive: true },
        update: { role, name, isActive: true },
      })
      await tx.userScope.deleteMany({ where: { userId: existing.id } })
      await tx.userScope.createMany({
        data: assignments.map(a => ({ ...a, userId: existing.id })),
      })
      return u
    })
    await recordAccessEvent(prisma, {
      actor, target: { id: user.id, email, name: user.name },
      action: 'REACTIVATED', detail: { to: role },
    })
    results.push({ email, status: 'reactivated' })
  }

  const failed = results.filter(r => r.status === 'failed')
  return NextResponse.json(
    { results, invited: results.length - failed.length, failed: failed.length },
    { status: failed.length === results.length ? 400 : 201 },
  )
}
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles. `src/app/setup/users/page.tsx` will now be type-broken against the new GET shape — that is expected and is Task 14–20's work. If the build fails *only* in that file, continue; note the error for Task 20.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/settings/users/route.ts
git commit -m "feat(access): invite with clearance + assignments, reject zero assignments"
```

---

### Task 8: Person mutations — clearance, activation, delete

**Files:**
- Modify: `src/app/api/settings/users/[id]/route.ts`

**Interfaces:**
- Consumes: `assignableLevels`, `recordAccessEvent`.
- Produces: `PATCH` body `{ clearance?: Role, name?: string, isActive?: boolean }`; `DELETE` unchanged externally.

- [ ] **Step 1: Rewrite PATCH with owner guards, rollback and audit**

Replace the whole `PATCH` function in `src/app/api/settings/users/[id]/route.ts`, and add these imports at the top:

```ts
import { assignableLevels } from '@/lib/roles'
import { recordAccessEvent } from '@/lib/access-audit'
```

Delete `const VALID_ROLES: Role[] = ['ADMIN', 'MANAGER', 'STAFF']`.

```ts
export const dynamic = 'force-dynamic'

// PATCH — update clearance, name, and/or active status (ADMIN only)
// Body: { clearance?: Role, name?: string, isActive?: boolean }
//
// Both stores are written or neither is:
//   - Prisma User row        → read by requireSession() (API auth)
//   - Supabase user_metadata → read by middleware (page auth)
// A half-written pair is a half-locked-out account, so a failed Supabase write
// rolls the Prisma row back and returns 500.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  if (admin.id === params.id) {
    return NextResponse.json({ error: 'Cannot modify your own account' }, { status: 400 })
  }

  const target = await prisma.user.findUnique({ where: { id: params.id } })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  if (target.role === 'OWNER') {
    return NextResponse.json(
      { error: 'The owner cannot be changed. Transfer ownership first.' }, { status: 403 },
    )
  }

  const body = await req.json().catch(() => ({}))
  const { clearance, name, isActive } = body as {
    clearance?: string; name?: string; isActive?: boolean
  }

  const allowed = assignableLevels(admin.role)
  if (clearance && !allowed.includes(clearance as Role)) {
    return NextResponse.json(
      { error: `Clearance must be one of: ${allowed.join(', ')}` }, { status: 400 },
    )
  }

  const updateData: { role?: Role; name?: string | null; isActive?: boolean } = {}
  if (clearance) updateData.role = clearance as Role
  if (name !== undefined) updateData.name = name.trim() || null
  if (typeof isActive === 'boolean') updateData.isActive = isActive

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const previous = { role: target.role, name: target.name, isActive: target.isActive }

  const user = await prisma.user.update({ where: { id: params.id }, data: updateData })

  // Sync the gating fields to Supabase. Only send keys that actually changed.
  const metadata: { role?: string; isActive?: boolean } = {}
  if (clearance) metadata.role = clearance
  if (typeof isActive === 'boolean') metadata.isActive = isActive
  if (Object.keys(metadata).length > 0) {
    const supabaseAdmin = createAdminClient()
    const { error } = await supabaseAdmin.auth.admin.updateUserById(params.id, {
      user_metadata: metadata,
    })
    if (error) {
      // Roll the Prisma row back so the two stores stay identical.
      await prisma.user.update({ where: { id: params.id }, data: previous }).catch(() => null)
      return NextResponse.json(
        { error: `Could not update sign-in access — nothing was changed. ${error.message}` },
        { status: 500 },
      )
    }
  }

  const actor = { id: admin.id, email: admin.email, name: admin.name }
  const targetParty = { id: user.id, email: user.email, name: user.name }

  if (clearance && previous.role !== user.role) {
    await recordAccessEvent(prisma, {
      actor, target: targetParty, action: 'CLEARANCE_CHANGED',
      detail: { from: previous.role, to: user.role },
    })
  }
  if (typeof isActive === 'boolean' && previous.isActive !== user.isActive) {
    await recordAccessEvent(prisma, {
      actor, target: targetParty,
      action: user.isActive ? 'REACTIVATED' : 'DEACTIVATED',
    })
  }

  return NextResponse.json({
    id: user.id, email: user.email, name: user.name, role: user.role, isActive: user.isActive,
  })
}
```

- [ ] **Step 2: Add owner guard + audit to DELETE**

In the `DELETE` handler, insert immediately after the `admin.id === params.id` check:

```ts
  const target = await prisma.user.findUnique({ where: { id: params.id } })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (target.role === 'OWNER') {
    return NextResponse.json(
      { error: 'The owner cannot be removed. Transfer ownership first.' }, { status: 403 },
    )
  }
```

and immediately before the final `return NextResponse.json({ ok: true })`:

```ts
  // Written AFTER the delete: actorId survives, targetUserId is nulled by the
  // FK, and the denormalized email/name is what keeps the entry readable.
  await recordAccessEvent(prisma, {
    actor: { id: admin.id, email: admin.email, name: admin.name },
    target: { id: null, email: target.email, name: target.name },
    action: 'REMOVED',
  })
```

- [ ] **Step 3: Map the single-owner constraint to a 409**

`assignableLevels()` never returns `OWNER`, so the validation above already refuses to promote a second owner. This is the belt-and-braces layer for any future writer: a raw `P2002` on `User_single_owner` must not escape as a 500.

Add the import at the top of the file:

```ts
import { Prisma } from '@prisma/client'
```

and replace the `prisma.user.update` call in PATCH with a guarded version:

```ts
  let user
  try {
    user = await prisma.user.update({ where: { id: params.id }, data: updateData })
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002' &&
      String(e.meta?.target ?? '').includes('User_single_owner')
    ) {
      return NextResponse.json({ error: 'There is already an owner.' }, { status: 409 })
    }
    throw e
  }
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles (setup/users page errors still expected).

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/settings/users/[id]/route.ts'
git commit -m "feat(access): owner guards, two-store rollback and audit on user mutations"
```

---

### Task 9: Assignments endpoint, replacing `user-scopes`

**Files:**
- Create: `src/app/api/settings/users/[id]/assignments/route.ts`
- Delete: `src/app/api/settings/user-scopes/route.ts`

**Interfaces:**
- Consumes: `recordAccessEvent`.
- Produces: `PUT /api/settings/users/[id]/assignments` body `{ assignments: AssignmentInput[] }` → `{ assignments: [...] }`.

- [ ] **Step 1: Create the route**

Create `src/app/api/settings/users/[id]/assignments/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { recordAccessEvent, type AccessAction } from '@/lib/access-audit'
import { Role } from '@prisma/client'

export const dynamic = 'force-dynamic'

interface AssignmentInput {
  locationId?: string | null
  revenueCenterId?: string | null
  clearance?: Role | null
}

const keyOf = (r: { locationId: string | null; revenueCenterId: string | null }) =>
  `${r.locationId ?? ''}|${r.revenueCenterId ?? ''}`

/**
 * PUT — replace a person's whole assignment set.
 *
 * The set is diffed against what is stored so the audit log records what
 * actually changed rather than "everything was replaced". A no-op PUT writes
 * no events.
 */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const target = await prisma.user.findUnique({ where: { id: params.id } })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (target.role === 'OWNER') {
    return NextResponse.json(
      { error: 'The owner has access everywhere; assignments do not apply.' }, { status: 400 },
    )
  }

  const body = await req.json().catch(() => null)
  const incoming = Array.isArray(body?.assignments) ? (body.assignments as AssignmentInput[]) : []

  if (incoming.length === 0) {
    return NextResponse.json(
      { error: 'Assign at least one location or revenue center — a person with no assignments has no access.' },
      { status: 400 },
    )
  }

  const locationIds = new Set<string>()
  const rcIds = new Set<string>()
  for (const r of incoming) {
    const hasLoc = !!r.locationId
    const hasRc = !!r.revenueCenterId
    if (hasLoc === hasRc) {
      return NextResponse.json(
        { error: 'Each assignment must target exactly one location or one revenue center.' },
        { status: 400 },
      )
    }
    if (hasLoc) locationIds.add(r.locationId as string)
    if (hasRc) rcIds.add(r.revenueCenterId as string)
  }
  if (locationIds.size) {
    const found = await prisma.location.findMany({
      where: { id: { in: [...locationIds] } }, select: { id: true },
    })
    if (found.length !== locationIds.size) {
      return NextResponse.json({ error: 'One or more referenced locations do not exist.' }, { status: 400 })
    }
  }
  if (rcIds.size) {
    const found = await prisma.revenueCenter.findMany({
      where: { id: { in: [...rcIds] } }, select: { id: true },
    })
    if (found.length !== rcIds.size) {
      return NextResponse.json({ error: 'One or more referenced revenue centers do not exist.' }, { status: 400 })
    }
  }

  const seen = new Set<string>()
  const next = incoming
    .map(r => ({
      locationId: r.locationId ?? null,
      revenueCenterId: r.revenueCenterId ?? null,
      clearance: r.clearance ?? null,
    }))
    .filter(r => {
      const k = keyOf(r)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

  const before = await prisma.userScope.findMany({
    where: { userId: params.id },
    select: { locationId: true, revenueCenterId: true, clearance: true },
  })

  await prisma.$transaction([
    prisma.userScope.deleteMany({ where: { userId: params.id } }),
    prisma.userScope.createMany({
      data: next.map(r => ({ ...r, userId: params.id })),
    }),
  ])

  // Names for readable audit entries.
  const [locs, rcs] = await Promise.all([
    prisma.location.findMany({ where: { id: { in: [...locationIds] } }, select: { id: true, name: true } }),
    prisma.revenueCenter.findMany({ where: { id: { in: [...rcIds] } }, select: { id: true, name: true } }),
  ])
  const locName = new Map(locs.map(l => [l.id, l.name]))
  const rcName = new Map(rcs.map(r => [r.id, r.name]))

  const beforeMap = new Map(before.map(r => [keyOf(r), r]))
  const afterMap = new Map(next.map(r => [keyOf(r), r]))
  const actor = { id: admin.id, email: admin.email, name: admin.name }
  const targetParty = { id: target.id, email: target.email, name: target.name }

  const events: Array<{ action: AccessAction; row: typeof next[number]; from?: string | null }> = []
  for (const [k, row] of afterMap) {
    const prev = beforeMap.get(k)
    if (!prev) { events.push({ action: 'ASSIGNMENT_ADDED', row }); continue }
    if (prev.clearance !== row.clearance) {
      events.push({
        action: row.clearance ? 'OVERRIDE_SET' : 'OVERRIDE_CLEARED',
        row, from: prev.clearance,
      })
    }
  }
  for (const [k, row] of beforeMap) {
    if (!afterMap.has(k)) events.push({ action: 'ASSIGNMENT_REMOVED', row })
  }

  for (const e of events) {
    await recordAccessEvent(prisma, {
      actor, target: targetParty, action: e.action,
      detail: {
        from: e.from ?? null,
        to: e.row.clearance ?? null,
        locationId: e.row.locationId,
        locationName: e.row.locationId ? locName.get(e.row.locationId) ?? null : null,
        rcId: e.row.revenueCenterId,
        rcName: e.row.revenueCenterId ? rcName.get(e.row.revenueCenterId) ?? null : null,
      },
    })
  }

  const assignments = await prisma.userScope.findMany({
    where: { userId: params.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, clearance: true,
      location: { select: { id: true, name: true } },
      revenueCenter: { select: { id: true, name: true, location: { select: { id: true, name: true } } } },
    },
  })

  return NextResponse.json({
    assignments: assignments.map(s => ({
      id: s.id,
      locationId: s.location?.id ?? s.revenueCenter?.location.id ?? null,
      locationName: s.location?.name ?? s.revenueCenter?.location.name ?? null,
      revenueCenterId: s.revenueCenter?.id ?? null,
      rcName: s.revenueCenter?.name ?? null,
      clearance: s.clearance,
    })),
  })
}
```

- [ ] **Step 2: Delete the superseded route**

```bash
git rm src/app/api/settings/user-scopes/route.ts
```

- [ ] **Step 3: Confirm nothing else referenced it**

Run: `grep -rn "user-scopes" src/`
Expected: only hits inside `src/app/setup/users/page.tsx`, which Task 20 replaces. **Any other hit must be fixed before continuing.**

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles (setup/users page errors still expected).

- [ ] **Step 5: Commit**

```bash
git add -A src/app/api/settings
git commit -m "feat(access): assignments endpoint with diffed audit; drop user-scopes route"
```

---

### Task 10: Resend invite + audit feed

**Files:**
- Create: `src/app/api/settings/users/[id]/resend/route.ts`
- Create: `src/app/api/settings/access-audit/route.ts`

**Interfaces:**
- Produces: `POST /api/settings/users/[id]/resend` → `{ ok: true }`; `GET /api/settings/access-audit?days=30` → `{ events: AuditDTO[] }` where `AuditDTO = { id, actorName, actorEmail, action, targetName, targetEmail, detail, createdAt }`.

- [ ] **Step 1: Create the resend route**

Create `src/app/api/settings/users/[id]/resend/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { findAuthUserByEmail, hasAcceptedInvite } from '@/lib/users'
import { recordAccessEvent } from '@/lib/access-audit'

export const dynamic = 'force-dynamic'

// POST — re-send a pending invite. Rejects accounts that already accepted:
// those users have a password and should use "Forgot password" instead.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || new URL(req.url).origin
  let admin
  try { admin = await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const target = await prisma.user.findUnique({ where: { id: params.id } })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const supabaseAdmin = createAdminClient()
  const existing = await findAuthUserByEmail(supabaseAdmin, target.email)
  if (existing && hasAcceptedInvite(existing)) {
    return NextResponse.json(
      { error: 'This person already has an account. Ask them to use "Forgot password".' },
      { status: 400 },
    )
  }

  // A re-invite mints a new auth UUID, so move the Prisma row and its
  // assignments onto it inside one transaction.
  if (existing) await supabaseAdmin.auth.admin.deleteUser(existing.id)

  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(target.email, {
    data: { role: target.role, isActive: true, name: target.name },
    redirectTo: `${appUrl}/auth/callback`,
  })
  if (error || !data?.user) {
    return NextResponse.json({ error: error?.message ?? 'Failed to re-send invite' }, { status: 400 })
  }

  const newId = data.user.id
  const scopes = await prisma.userScope.findMany({
    where: { userId: target.id },
    select: { locationId: true, revenueCenterId: true, clearance: true },
  })
  await prisma.$transaction(async (tx) => {
    await tx.user.deleteMany({ where: { email: target.email } })
    await tx.user.create({
      data: {
        id: newId, email: target.email, name: target.name,
        role: target.role, isActive: false,
      },
    })
    await tx.userScope.createMany({ data: scopes.map(s => ({ ...s, userId: newId })) })
  })

  await recordAccessEvent(prisma, {
    actor: { id: admin.id, email: admin.email, name: admin.name },
    target: { id: newId, email: target.email, name: target.name },
    action: 'REINVITED', detail: { to: target.role },
  })

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Create the audit feed route**

Create `src/app/api/settings/access-audit/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

// Polled by the People & Access panel — must never be cached.
export const dynamic = 'force-dynamic'

// GET /api/settings/access-audit?days=30
// Events are kept forever; `days` is only the default view window.
export async function GET(req: NextRequest) {
  try { await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const raw = Number(req.nextUrl.searchParams.get('days') ?? '30')
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 3650) : 30
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const events = await prisma.accessAuditEvent.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true, actorName: true, actorEmail: true, action: true,
      targetName: true, targetEmail: true, detail: true, createdAt: true,
    },
  })

  return NextResponse.json({ events }, { headers: { 'Cache-Control': 'no-store' } })
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles. Verify in the route table that both new routes show `ƒ (Dynamic)`, not `○ (Static)`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/settings
git commit -m "feat(access): resend-invite and access-audit endpoints"
```

---

### Task 11: `/api/me` + `UserContext` carry effective access

**Files:**
- Modify: `src/app/api/me/route.ts`
- Modify: `src/contexts/UserContext.tsx`

**Interfaces:**
- Consumes: `effectiveAccess` from `access.ts`.
- Produces: `/api/me` → `{ id, email, name, role, effectiveAccess: EffectiveEntry[] }`; `useUser()` → `{ user, role, effectiveAccess, clearanceAt(rcId), loading, reload }`.

- [ ] **Step 1: Extend `/api/me`**

Replace `src/app/api/me/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { effectiveAccess } from '@/lib/access'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await requireSession()
    // Returned so client gating reads the SAME resolution the server does
    // rather than re-deriving it from role alone.
    const access = await effectiveAccess(user)
    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      effectiveAccess: access,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
```

- [ ] **Step 2: Widen `UserContext`**

In `src/contexts/UserContext.tsx`, replace the type block and the provider value:

```ts
export type UserRole = 'OWNER' | 'ADMIN' | 'MANAGER' | 'LEAD' | 'STAFF'

export interface EffectiveEntry {
  rcId: string
  rcName: string
  locationId: string
  locationName: string
  clearance: UserRole
  source: 'inherited' | 'override'
}

export interface CurrentUser {
  id: string
  email: string
  name: string | null
  role: UserRole
  effectiveAccess?: EffectiveEntry[]
}

interface UserContextValue {
  user: CurrentUser | null
  role: UserRole | null
  effectiveAccess: EffectiveEntry[]
  /** Clearance that applies at one RC, or null when out of reach. */
  clearanceAt: (rcId: string) => UserRole | null
  loading: boolean
  reload: () => Promise<void>
}

const UserContext = createContext<UserContextValue>({
  user: null,
  role: null,
  effectiveAccess: [],
  clearanceAt: () => null,
  loading: true,
  reload: async () => {},
})
```

and replace the `return` in `UserProvider`:

```tsx
  const effectiveAccess = user?.effectiveAccess ?? []
  const clearanceAt = useCallback(
    (rcId: string) => effectiveAccess.find(e => e.rcId === rcId)?.clearance ?? null,
    [effectiveAccess],
  )

  return (
    <UserContext.Provider
      value={{ user, role: user?.role ?? null, effectiveAccess, clearanceAt, loading, reload: load }}
    >
      {children}
    </UserContext.Provider>
  )
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles (setup/users page errors still expected).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/me/route.ts src/contexts/UserContext.tsx
git commit -m "feat(access): expose effective access via /api/me and UserContext"
```

---

# Phase 3 — Shift Lead end-of-day

### Task 12: EOD route levels and the money-field rule

**Files:**
- Modify: `src/app/api/eod/close/route.ts`
- Modify: `src/app/api/eod/close/entry/route.ts`
- Modify: `src/app/api/eod/close/signoff/route.ts`

**Interfaces:**
- Consumes: `requireSession`.
- Produces: `close` GET response omits `labourCost`/`grossSales`/`compsVoids`/`discounts` for LEAD; `close` PATCH 403s on those four for LEAD.

`eod/close/reopen`, `eod/summary`, `eod/orders`, `eod/email`, `eod/handover` are **left at MANAGER** and are not touched by this task. `eod/checklist*` stays ADMIN.

- [ ] **Step 1: Lower the two pure-operational routes to LEAD**

In `src/app/api/eod/close/entry/route.ts` line 10, change:

```ts
    const user = await requireSession('LEAD')
```

In `src/app/api/eod/close/signoff/route.ts` line 10, change:

```ts
    const user = await requireSession('LEAD')
```

- [ ] **Step 2: Strip money from `close` GET for a Lead**

In `src/app/api/eod/close/route.ts`, change the GET guard to capture the user and lower it to LEAD:

```ts
    const user = await requireSession('LEAD')
```

Then, in the `NextResponse.json({...})` return, replace the four money lines:

```ts
        labourCost: close.labourCost == null ? null : Number(close.labourCost),
        grossSales: close.grossSales == null ? null : Number(close.grossSales),
        compsVoids: close.compsVoids == null ? null : Number(close.compsVoids),
        discounts: close.discounts == null ? null : Number(close.discounts),
```

with a conditional spread. A Shift Lead runs the close but never sees money — the ladder is explicit about this.

```ts
        // Shift Leads run the close but never see money (see the clearance
        // ladder: "No cost or money"). Omitted entirely rather than nulled, so
        // the client cannot mistake "hidden" for "not yet entered".
        ...(user.role === 'LEAD' ? {} : {
          labourCost: close.labourCost == null ? null : Number(close.labourCost),
          grossSales: close.grossSales == null ? null : Number(close.grossSales),
          compsVoids: close.compsVoids == null ? null : Number(close.compsVoids),
          discounts: close.discounts == null ? null : Number(close.discounts),
        }),
```

- [ ] **Step 3: Reject money writes from a Lead in `close` PATCH**

In the same file, change the PATCH guard:

```ts
    const user = await requireSession('LEAD')
```

and insert immediately after the body is parsed and the four numbers are read, before the update object is built:

```ts
    // A Lead may write the handover note, nothing else on this route.
    if (user.role === 'LEAD') {
      const attempted = [labourCost, grossSales, compsVoids, discounts]
        .some(v => v !== undefined)
      if (attempted) {
        return NextResponse.json(
          { error: 'Shift Leads cannot record labour, sales, comps or discounts.' },
          { status: 403 },
        )
      }
    }
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/eod
git commit -m "feat(access): Shift Leads run the EOD close without seeing money"
```

---

### Task 13: EOD page degrades cleanly for a Lead

**Files:**
- Modify: `src/app/end-of-day/page.tsx`

**Interfaces:**
- Consumes: `useUser()` from `UserContext`.
- Produces: no exported changes.

- [ ] **Step 1: Read the current fetch + render blocks**

Run: `sed -n '75,115p;215,265p' src/app/end-of-day/page.tsx`

Identify: the `fetch('/api/eod/summary…')` call, the `fetch('/api/eod/close…')` call, the recap strip that renders "Food cost · today" and "Net sales", and `saveCloseFields`.

- [ ] **Step 2: Gate on role**

Add to the imports:

```ts
import { useUser } from '@/contexts/UserContext'
```

Inside the component, near the other hooks:

```ts
  const { role } = useUser()
  // A Lead runs the operational close; /api/eod/summary and /api/eod/handover
  // are MANAGER-only and will 403 for them. Skip the calls rather than fire
  // requests we know are refused.
  const canSeeMoney = role !== 'LEAD' && role !== 'STAFF'
```

- [ ] **Step 3: Skip the money fetches for a Lead**

Wrap the `summary` and `handover` fetches so they are not issued when `canSeeMoney` is false, leaving `data` as `null`. The existing render already falls back to `—` for every money figure when `data` is null, so no render change is needed for the strip itself.

```ts
    canSeeMoney
      ? fetch(`/api/eod/summary${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
      : Promise.resolve(null),
```

- [ ] **Step 4: Hide the money inputs**

Wrap the block that renders the labour cost / gross sales / comps / discounts inputs (the fields written by `saveCloseFields`) in:

```tsx
  {canSeeMoney && (
    /* …existing money input block… */
  )}
```

and replace the recap strip's money row for Leads with a short explanatory line:

```tsx
  {!canSeeMoney && (
    <p className="text-xs text-ink-4">
      Sales and cost figures are managed by your manager.
    </p>
  )}
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 6: Commit**

```bash
git add src/app/end-of-day/page.tsx
git commit -m "feat(access): EOD page hides money and skips 403 calls for Shift Leads"
```

---

# Phase 4 — People & Access UI

### Task 14: `people-utils.ts`

**Files:**
- Create: `src/components/people/people-utils.ts`

**Interfaces:**
- Produces:
  - `interface Assignment { id: string; locationId: string | null; locationName: string | null; revenueCenterId: string | null; rcName: string | null; clearance: Role | null }`
  - `interface Person { id, email, name, role: Role, isActive: boolean, createdAt: string, isPending: boolean, assignments: Assignment[] }`
  - `interface LocationNode { id, name, color, revenueCenters: Array<{ id, name, color }> }`
  - `groupByLocation(people: Person[], locations: LocationNode[]): Array<{ location: LocationNode | null; people: Person[] }>`
  - `assignmentLabel(a: Assignment): string`
  - `summarizeAccess(p: Person): string`
  - `initials(nameOrEmail: string): string`
  - `relativeTime(iso: string): string`

- [ ] **Step 1: Implement**

Create `src/components/people/people-utils.ts`:

```ts
import type { Role } from '@prisma/client'
import { ROLE_LABELS } from '@/lib/roles'

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

/**
 * Group people under every location they touch. Somebody assigned to two
 * locations appears under both — the list is a map of who is where, not a
 * partition. People with no assignments land in the trailing `null` group.
 */
export function groupByLocation(
  people: Person[],
  locations: LocationNode[],
): Array<{ location: LocationNode | null; people: Person[] }> {
  const groups = locations.map(location => ({
    location: location as LocationNode | null,
    people: people.filter(p => p.assignments.some(a => a.locationId === location.id)),
  }))
  const unassigned = people.filter(p => p.assignments.length === 0)
  if (unassigned.length) groups.push({ location: null, people: unassigned })
  return groups.filter(g => g.people.length > 0)
}

/** "Downtown · whole location" / "Rooftop Bar" */
export function assignmentLabel(a: Assignment): string {
  if (a.revenueCenterId) return a.rcName ?? 'Revenue center'
  return `${a.locationName ?? 'Location'} · whole location`
}

/** One-line access summary for a person row. */
export function summarizeAccess(p: Person): string {
  if (p.role === 'OWNER' || p.role === 'ADMIN') return 'All locations'
  if (p.assignments.length === 0) return 'No assignments'
  const overrides = p.assignments.filter(a => a.clearance).length
  const base = p.assignments.length === 1
    ? assignmentLabel(p.assignments[0])
    : `${p.assignments.length} places`
  return overrides > 0 ? `${base} · ${overrides} override${overrides > 1 ? 's' : ''}` : base
}

/** Effective clearance shown on a chip for one assignment. */
export function chipClearance(p: Person, a: Assignment): Role {
  return a.clearance ?? p.role
}

export function chipLabel(p: Person, a: Assignment): string {
  const node = a.revenueCenterId ? a.rcName ?? 'RC' : a.locationName ?? 'Location'
  return `${node} · ${ROLE_LABELS[chipClearance(p, a)]}`
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
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/components/people/people-utils.ts
git commit -m "feat(people): grouping and formatting helpers"
```

---

### Task 15: `AssignmentEditor`

**Files:**
- Create: `src/components/people/AssignmentEditor.tsx`

**Interfaces:**
- Consumes: `LocationNode`, `ROLE_LABELS`, `ROLE_DOT`, `assignableLevels`.
- Produces: default export `AssignmentEditor`, props:
  ```ts
  interface AssignmentDraft { locationId: string | null; revenueCenterId: string | null; clearance: Role | null }
  interface Props {
    locations: LocationNode[]
    value: AssignmentDraft[]
    primaryClearance: Role
    actorRole: Role
    onChange: (next: AssignmentDraft[]) => void
  }
  ```

This component is shared by `InviteModal` and `PersonDetailPanel` — that sharing is what keeps the two views from drifting.

- [ ] **Step 1: Implement**

Create `src/components/people/AssignmentEditor.tsx`:

```tsx
'use client'
import type { Role } from '@prisma/client'
import { Check } from 'lucide-react'
import { ROLE_LABELS, assignableLevels } from '@/lib/roles'
import type { LocationNode } from './people-utils'

export interface AssignmentDraft {
  locationId: string | null
  revenueCenterId: string | null
  clearance: Role | null
}

interface Props {
  locations: LocationNode[]
  value: AssignmentDraft[]
  primaryClearance: Role
  actorRole: Role
  onChange: (next: AssignmentDraft[]) => void
}

const keyOf = (d: { locationId: string | null; revenueCenterId: string | null }) =>
  `${d.locationId ?? ''}|${d.revenueCenterId ?? ''}`

/** Per-node override picker. Rendered inline on a selected row. */
function OverridePicker({
  current, primary, actorRole, onPick,
}: {
  current: Role | null
  primary: Role
  actorRole: Role
  onPick: (r: Role | null) => void
}) {
  const options = assignableLevels(actorRole)
  return (
    <select
      value={current ?? ''}
      onChange={e => onPick(e.target.value ? (e.target.value as Role) : null)}
      onClick={e => e.stopPropagation()}
      className="ml-auto text-[10px] font-mono rounded-full border border-line bg-paper px-2 py-1 text-ink-3 focus:outline-none focus:ring-2 focus:ring-gold"
    >
      <option value="">inherit · {ROLE_LABELS[primary]}</option>
      {options.map(r => (
        <option key={r} value={r}>override: {ROLE_LABELS[r]}</option>
      ))}
    </select>
  )
}

export default function AssignmentEditor({
  locations, value, primaryClearance, actorRole, onChange,
}: Props) {
  const selected = new Map(value.map(d => [keyOf(d), d]))

  const toggle = (draft: AssignmentDraft) => {
    const k = keyOf(draft)
    if (selected.has(k)) {
      onChange(value.filter(d => keyOf(d) !== k))
    } else {
      onChange([...value, draft])
    }
  }

  const setClearance = (draft: AssignmentDraft, clearance: Role | null) => {
    const k = keyOf(draft)
    onChange(value.map(d => (keyOf(d) === k ? { ...d, clearance } : d)))
  }

  return (
    <div className="space-y-2">
      {locations.map(loc => {
        const locDraft: AssignmentDraft = {
          locationId: loc.id, revenueCenterId: null, clearance: null,
        }
        const locSelected = selected.get(keyOf(locDraft))

        return (
          <div key={loc.id} className="border border-line rounded-lg overflow-hidden">
            {/* whole-location row */}
            <label className="flex items-center gap-2.5 px-3 py-2.5 border-b border-bg-2 cursor-pointer hover:bg-bg">
              <span
                className={`w-[17px] h-[17px] rounded-sm grid place-items-center shrink-0 ${
                  locSelected ? 'bg-gold text-white' : 'border border-line-2'
                }`}
              >
                {locSelected && <Check size={11} strokeWidth={3} />}
              </span>
              <span
                className="w-5 h-5 rounded grid place-items-center text-[10px] text-white shrink-0"
                style={{ backgroundColor: loc.color }}
              >
                ⌂
              </span>
              <input
                type="checkbox"
                className="sr-only"
                checked={!!locSelected}
                onChange={() => toggle(locDraft)}
              />
              <span className="text-sm font-medium text-ink">
                {loc.name} <span className="text-ink-4 font-normal">· whole location</span>
              </span>
              {locSelected && (
                <OverridePicker
                  current={locSelected.clearance}
                  primary={primaryClearance}
                  actorRole={actorRole}
                  onPick={r => setClearance(locDraft, r)}
                />
              )}
            </label>

            {/* individual RCs */}
            <div className="px-3 pb-2 pt-1 pl-10 space-y-0.5">
              {loc.revenueCenters.length === 0 && (
                <p className="text-xs text-ink-4 py-1">No revenue centers yet.</p>
              )}
              {loc.revenueCenters.map(rc => {
                const rcDraft: AssignmentDraft = {
                  locationId: null, revenueCenterId: rc.id, clearance: null,
                }
                const rcSelected = selected.get(keyOf(rcDraft))
                return (
                  <label
                    key={rc.id}
                    className="flex items-center gap-2.5 py-1.5 cursor-pointer group"
                  >
                    <span
                      className={`w-[15px] h-[15px] rounded-sm grid place-items-center shrink-0 ${
                        rcSelected ? 'bg-gold text-white' : 'border border-line-2'
                      }`}
                    >
                      {rcSelected && <Check size={10} strokeWidth={3} />}
                    </span>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={!!rcSelected}
                      onChange={() => toggle(rcDraft)}
                    />
                    <span
                      className="w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ backgroundColor: rc.color }}
                    />
                    <span className="text-[12.5px] text-ink-2">{rc.name}</span>
                    {rcSelected && (
                      <OverridePicker
                        current={rcSelected.clearance}
                        primary={primaryClearance}
                        actorRole={actorRole}
                        onPick={r => setClearance(rcDraft, r)}
                      />
                    )}
                  </label>
                )
              })}
            </div>
          </div>
        )
      })}

      {locations.length === 0 && (
        <p className="text-xs text-ink-4">
          No locations yet — set one up before assigning people.
        </p>
      )}

      <p className="text-[11.5px] text-ink-4 leading-relaxed">
        Each place inherits the primary clearance. Set a per-place override where it should differ.
      </p>
    </div>
  )
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/components/people/AssignmentEditor.tsx
git commit -m "feat(people): shared assignment editor with per-node overrides"
```

---

### Task 16: `PersonRow` and `PeopleList`

**Files:**
- Create: `src/components/people/PersonRow.tsx`
- Create: `src/components/people/PeopleList.tsx`

**Interfaces:**
- Consumes: `Person`, `LocationNode`, `groupByLocation`, `chipLabel`, `chipClearance`, `initials`, `ROLE_COLORS`, `ROLE_LABELS`, `ROLE_DOT`.
- Produces: default exports `PersonRow` (props `{ person, isMe, onOpen }`) and `PeopleList` (props `{ people, locations, currentUserId, onOpenPerson, onResend, onRevoke }`).

- [ ] **Step 1: Create `PersonRow.tsx`**

```tsx
'use client'
import type { Person } from './people-utils'
import { ROLE_COLORS, ROLE_LABELS } from '@/lib/roles'
import { initials, chipLabel, chipClearance } from './people-utils'

interface Props {
  person: Person
  isMe: boolean
  onOpen: (p: Person) => void
}

export default function PersonRow({ person, isMe, onOpen }: Props) {
  const unassigned = person.assignments.length === 0
    && person.role !== 'OWNER' && person.role !== 'ADMIN'

  return (
    <button
      onClick={() => onOpen(person)}
      className={`w-full flex items-center gap-3 px-5 py-3 border-t border-bg-2 text-left hover:bg-bg transition-colors ${
        !person.isActive ? 'opacity-50' : ''
      }`}
    >
      <span className="shrink-0 w-9 h-9 rounded-full bg-gradient-to-br from-gold to-gold-2 grid place-items-center text-white text-xs font-semibold">
        {initials(person.name ?? person.email)}
      </span>

      <span className="shrink-0 w-[150px]">
        <span className="flex items-center gap-1.5">
          <span className="text-[13.5px] font-medium text-ink truncate">
            {person.name ?? person.email}
          </span>
          {isMe && (
            <span className="text-[9px] font-semibold bg-bg-2 text-ink-3 px-1.5 py-0.5 rounded-full">
              You
            </span>
          )}
        </span>
        <span className="block text-[11px] text-ink-4 truncate">{person.email}</span>
      </span>

      <span
        className={`shrink-0 w-24 text-center text-xs font-semibold px-2.5 py-1 rounded-full ${ROLE_COLORS[person.role]}`}
      >
        {ROLE_LABELS[person.role]}
      </span>

      <span className="flex-1 flex flex-wrap gap-1.5">
        {unassigned ? (
          <span className="text-[11px] bg-gold-soft text-gold-2 px-2 py-0.5 rounded-full">
            No assignments — sees all revenue centers
          </span>
        ) : person.role === 'OWNER' || person.role === 'ADMIN' ? (
          <span className="text-[11px] bg-bg-2 text-ink-3 px-2 py-0.5 rounded-full">
            All locations
          </span>
        ) : (
          person.assignments.map(a => (
            <span
              key={a.id}
              className={`text-[11px] px-2 py-0.5 rounded-full ${
                a.clearance ? 'bg-gold-soft text-gold-2' : 'bg-bg-2 text-ink-3'
              }`}
              title={a.clearance ? `Override: ${ROLE_LABELS[chipClearance(person, a)]}` : 'Inherited'}
            >
              {chipLabel(person, a)}
            </span>
          ))
        )}
      </span>

      <span className="text-ink-4 text-[15px] px-1">⋯</span>
    </button>
  )
}
```

- [ ] **Step 2: Create `PeopleList.tsx`**

```tsx
'use client'
import { useMemo, useState } from 'react'
import type { Role } from '@prisma/client'
import { Search, Mail, X } from 'lucide-react'
import { ROLE_LABELS, ROLE_ORDER } from '@/lib/roles'
import PersonRow from './PersonRow'
import { groupByLocation, relativeTime, type LocationNode, type Person } from './people-utils'

interface Props {
  people: Person[]
  locations: LocationNode[]
  currentUserId: string | null
  onOpenPerson: (p: Person) => void
  onResend: (p: Person) => void
  onRevoke: (p: Person) => void
}

export default function PeopleList({
  people, locations, currentUserId, onOpenPerson, onResend, onRevoke,
}: Props) {
  const [query, setQuery] = useState('')
  const [locationFilter, setLocationFilter] = useState<string>('')
  const [levelFilter, setLevelFilter] = useState<string>('')

  const active = people.filter(p => !p.isPending)
  const pending = people.filter(p => p.isPending)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return active.filter(p => {
      if (q && !(p.name ?? '').toLowerCase().includes(q) && !p.email.toLowerCase().includes(q)) {
        return false
      }
      if (levelFilter && p.role !== levelFilter) return false
      if (locationFilter && !p.assignments.some(a => a.locationId === locationFilter)) return false
      return true
    })
  }, [active, query, levelFilter, locationFilter])

  const groups = useMemo(
    () => groupByLocation(filtered, locations),
    [filtered, locations],
  )

  return (
    <>
      {/* filters */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-bg-2 bg-bg">
        <div className="flex-1 flex items-center gap-2 bg-paper border border-line rounded-[9px] px-3 py-1.5">
          <Search size={13} className="text-ink-4" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search people…"
            className="flex-1 text-[13px] bg-transparent outline-none placeholder:text-ink-4"
          />
        </div>
        <select
          value={locationFilter}
          onChange={e => setLocationFilter(e.target.value)}
          className="text-[11px] font-mono px-3 py-1.5 border border-line rounded-[9px] bg-paper text-ink-2"
        >
          <option value="">All locations</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select
          value={levelFilter}
          onChange={e => setLevelFilter(e.target.value)}
          className="text-[11px] font-mono px-3 py-1.5 border border-line rounded-[9px] bg-paper text-ink-2"
        >
          <option value="">All levels</option>
          {ROLE_ORDER.map(r => <option key={r} value={r}>{ROLE_LABELS[r as Role]}</option>)}
        </select>
      </div>

      {/* grouped people */}
      {groups.map(({ location, people: rows }) => (
        <div key={location?.id ?? 'unassigned'}>
          <div className="flex items-center gap-2.5 px-5 pt-3 pb-2 bg-bg">
            <span
              className="w-5 h-5 rounded grid place-items-center text-white text-[11px]"
              style={{ backgroundColor: location?.color ?? '#a1a1aa' }}
            >
              ⌂
            </span>
            <span className="font-semibold text-[13px] text-ink">
              {location?.name ?? 'No location assigned'}
            </span>
            <span className="text-[10.5px] font-mono text-ink-4">
              {location ? `${location.revenueCenters.length} RCs · ` : ''}
              {rows.length} {rows.length === 1 ? 'person' : 'people'}
            </span>
          </div>
          {rows.map(p => (
            <PersonRow
              key={`${location?.id ?? 'none'}-${p.id}`}
              person={p}
              isMe={p.id === currentUserId}
              onOpen={onOpenPerson}
            />
          ))}
        </div>
      ))}

      {groups.length === 0 && (
        <p className="px-5 py-8 text-center text-[13px] text-ink-4">
          No one matches those filters.
        </p>
      )}

      {/* pending invites */}
      {pending.length > 0 && (
        <>
          <div className="px-5 pt-4 pb-2 bg-bg border-t border-bg-2">
            <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-ink-4">
              Pending invites
            </span>
          </div>
          {pending.map(p => {
            const stale = Date.now() - new Date(p.createdAt).getTime() > 7 * 864e5
            return (
              <div key={p.id} className="flex items-center gap-3 px-5 py-3 border-t border-bg-2">
                <span
                  className={`shrink-0 w-[34px] h-[34px] rounded-full border-[1.5px] border-dashed grid place-items-center ${
                    stale ? 'border-red text-red' : 'border-line-2 text-ink-4'
                  }`}
                >
                  <Mail size={14} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13.5px] font-medium text-ink truncate">{p.email}</span>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        stale ? 'bg-red-soft text-red-text' : 'bg-gold-soft text-gold-2'
                      }`}
                    >
                      {stale ? 'Expired' : 'Pending'}
                    </span>
                  </div>
                  <div className="text-[11.5px] text-ink-4">
                    {ROLE_LABELS[p.role]} · invited {relativeTime(p.createdAt)}
                  </div>
                </div>
                <button
                  onClick={() => onResend(p)}
                  className={`text-[11px] font-mono px-2.5 py-1 rounded-lg ${
                    stale ? 'bg-ink text-white' : 'border border-line text-ink-3 hover:bg-bg'
                  }`}
                >
                  {stale ? 'Re-invite' : 'Resend'}
                </button>
                <button
                  onClick={() => onRevoke(p)}
                  title="Revoke invite"
                  className="text-ink-4 hover:text-red p-1"
                >
                  <X size={14} />
                </button>
              </div>
            )
          })}
        </>
      )}
    </>
  )
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add src/components/people/PersonRow.tsx src/components/people/PeopleList.tsx
git commit -m "feat(people): location-grouped people list with pending invites"
```

---

### Task 17: `InviteModal`

**Files:**
- Create: `src/components/people/InviteModal.tsx`

**Interfaces:**
- Consumes: `AssignmentEditor`, `AssignmentDraft`, `LocationNode`, `assignableLevels`, `ROLE_LABELS`, `ROLE_DOT`, `ROLE_DESCRIPTIONS`.
- Produces: default export `InviteModal`, props `{ locations, actorRole, onClose, onInvited }`.

- [ ] **Step 1: Implement**

```tsx
'use client'
import { useState } from 'react'
import type { Role } from '@prisma/client'
import { X, Loader2 } from 'lucide-react'
import { assignableLevels, ROLE_LABELS, ROLE_DOT, ROLE_DESCRIPTIONS } from '@/lib/roles'
import AssignmentEditor, { type AssignmentDraft } from './AssignmentEditor'
import type { LocationNode } from './people-utils'

interface Props {
  locations: LocationNode[]
  actorRole: Role
  onClose: () => void
  onInvited: () => void
}

export default function InviteModal({ locations, actorRole, onClose, onInvited }: Props) {
  const levels = assignableLevels(actorRole)
  const [emails, setEmails] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [clearance, setClearance] = useState<Role>(levels.includes('STAFF') ? 'STAFF' : levels[0])
  const [assignments, setAssignments] = useState<AssignmentDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const commitDraft = () => {
    const value = draft.trim().toLowerCase()
    if (value && !emails.includes(value)) setEmails([...emails, value])
    setDraft('')
  }

  const submit = async () => {
    setError('')
    const all = draft.trim() ? [...emails, draft.trim().toLowerCase()] : emails
    if (all.length === 0) { setError('Add at least one email address.'); return }
    if (assignments.length === 0) {
      setError('Assign at least one location or revenue center — a person with no assignments has no access.')
      return
    }
    setSaving(true)
    const res = await fetch('/api/settings/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: all, clearance, assignments }),
    })
    const body = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) { setError(body.error ?? 'Failed to send invite'); return }
    const failed = (body.results ?? []).filter((r: { status: string }) => r.status === 'failed')
    if (failed.length) {
      setError(failed.map((f: { email: string; error: string }) => `${f.email}: ${f.error}`).join('; '))
      return
    }
    onInvited()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-ink/40" onClick={onClose} />
      <div className="relative bg-paper rounded-xl border border-line shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 className="font-fraunces text-[17px] font-semibold text-ink">Invite people</h2>
          <button onClick={onClose} className="text-ink-4 hover:text-ink-2"><X size={16} /></button>
        </div>

        <div className="px-5 py-5 space-y-5">
          {/* emails */}
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-[0.12em] text-ink-4 mb-1.5">
              Email addresses
            </label>
            <div className="flex flex-wrap gap-1.5 p-2 border border-line rounded-[10px]">
              {emails.map(e => (
                <span key={e} className="inline-flex items-center gap-1.5 bg-bg-2 rounded-sm px-2 py-1 text-[12.5px]">
                  {e}
                  <button onClick={() => setEmails(emails.filter(x => x !== e))} className="text-ink-4 hover:text-red">
                    <X size={11} />
                  </button>
                </span>
              ))}
              <input
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitDraft() }
                }}
                onBlur={commitDraft}
                placeholder={emails.length ? 'add another…' : 'name@restaurant.com'}
                className="flex-1 min-w-[140px] text-[13px] px-1 py-1 outline-none placeholder:text-ink-4"
              />
            </div>
          </div>

          {/* clearance */}
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-[0.12em] text-ink-4 mb-2">
              Primary clearance
            </label>
            <div className="grid grid-cols-4 gap-1.5">
              {levels.map(r => (
                <button
                  key={r}
                  onClick={() => setClearance(r)}
                  className={`text-center py-2.5 px-1 rounded-[9px] border transition-colors ${
                    clearance === r
                      ? 'border-[1.5px] border-gold bg-gold-soft/40'
                      : 'border-line hover:bg-bg'
                  }`}
                >
                  <span className={`block w-4 h-4 rounded-sm mx-auto mb-1.5 ${ROLE_DOT[r]}`} />
                  <span className={`text-[10.5px] ${clearance === r ? 'text-gold-2 font-semibold' : 'text-ink-3'}`}>
                    {ROLE_LABELS[r]}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11.5px] text-ink-4 leading-relaxed">{ROLE_DESCRIPTIONS[clearance]}</p>
          </div>

          {/* assignments */}
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-[0.12em] text-ink-4 mb-2">
              Where do they work?
            </label>
            <AssignmentEditor
              locations={locations}
              value={assignments}
              primaryClearance={clearance}
              actorRole={actorRole}
              onChange={setAssignments}
            />
          </div>

          {error && (
            <div className="flex gap-2 px-3 py-2.5 bg-red-soft border border-red/20 rounded-[10px]">
              <span className="text-red-text">⚠</span>
              <p className="text-[12.5px] text-red-text leading-relaxed">{error}</p>
            </div>
          )}

          <button
            onClick={submit}
            disabled={saving}
            className="w-full py-3 rounded-[10px] bg-ink text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Send invite →
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/components/people/InviteModal.tsx
git commit -m "feat(people): invite modal — clearance + assignments in one step"
```

---

### Task 18: `PersonDetailPanel`

**Files:**
- Create: `src/components/people/PersonDetailPanel.tsx`

**Interfaces:**
- Consumes: `AssignmentEditor`, `Person`, `LocationNode`, `assignableLevels`, `ROLE_*`.
- Produces: default export `PersonDetailPanel`, props `{ person, locations, actorRole, isMe, onClose, onChanged }`.

Covers T3 (primary + assignments + effective access) and T4 (deactivate vs remove).

- [ ] **Step 1: Implement**

```tsx
'use client'
import { useState } from 'react'
import type { Role } from '@prisma/client'
import { X, Loader2, Pause, Trash2 } from 'lucide-react'
import { assignableLevels, ROLE_LABELS, ROLE_COLORS, ROLE_DOT } from '@/lib/roles'
import { resolveEffective, type EffectiveEntry, type RcNode } from '@/lib/access-model'
import AssignmentEditor, { type AssignmentDraft } from './AssignmentEditor'
import { initials, type LocationNode, type Person } from './people-utils'

interface Props {
  person: Person
  locations: LocationNode[]
  actorRole: Role
  isMe: boolean
  onClose: () => void
  onChanged: () => void
}

/**
 * Live preview of effective access as the admin edits.
 *
 * Calls the SAME resolveEffective() the server uses (src/lib/access-model.ts is
 * the pure half, importable from a client component) so the preview can never
 * disagree with what actually gets enforced.
 */
function effectivePreview(
  drafts: AssignmentDraft[], primary: Role, locations: LocationNode[],
): EffectiveEntry[] {
  const rcs: RcNode[] = locations.flatMap(l =>
    l.revenueCenters.map(rc => ({
      id: rc.id, name: rc.name, locationId: l.id, locationName: l.name,
    })),
  )
  return resolveEffective(primary, drafts, rcs)
}

export default function PersonDetailPanel({
  person, locations, actorRole, isMe, onClose, onChanged,
}: Props) {
  const isOwner = person.role === 'OWNER'
  const [clearance, setClearance] = useState<Role>(person.role)
  const [drafts, setDrafts] = useState<AssignmentDraft[]>(
    person.assignments.map(a => ({
      locationId: a.revenueCenterId ? null : a.locationId,
      revenueCenterId: a.revenueCenterId,
      clearance: a.clearance,
    })),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)

  const locked = isOwner || isMe
  const preview = effectivePreview(drafts, clearance, locations)

  const call = async (fn: () => Promise<Response>, ok?: () => void) => {
    setError(''); setBusy(true)
    const res = await fn()
    const body = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setError(body.error ?? 'Something went wrong'); return }
    ok?.(); onChanged()
  }

  const save = () =>
    call(async () => {
      if (clearance !== person.role) {
        const r = await fetch(`/api/settings/users/${person.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clearance }),
        })
        if (!r.ok) return r
      }
      return fetch(`/api/settings/users/${person.id}/assignments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments: drafts }),
      })
    }, onClose)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-ink/40" onClick={onClose} />
      <div className="relative bg-paper rounded-xl border border-line shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        {/* header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
          <span className="shrink-0 w-11 h-11 rounded-full bg-gradient-to-br from-gold to-gold-2 grid place-items-center text-white font-semibold">
            {initials(person.name ?? person.email)}
          </span>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[15px] text-ink truncate">
              {person.name ?? person.email}
            </div>
            <div className="text-xs text-ink-4 truncate">{person.email}</div>
          </div>
          <span
            className={`text-[10px] font-semibold px-2.5 py-1 rounded-full ${
              person.isActive ? 'bg-green-soft text-green-text' : 'bg-bg-2 text-ink-3'
            }`}
          >
            {person.isActive ? 'Active' : 'Inactive'}
          </span>
          <button onClick={onClose} className="text-ink-4 hover:text-ink-2 ml-1"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {isOwner && (
            <p className="text-[12.5px] text-ink-3 bg-bg-2 rounded-[10px] px-3 py-2.5 leading-relaxed">
              The owner has access everywhere and cannot be changed, deactivated, or removed.
            </p>
          )}

          {/* primary clearance */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-ink-4">
              Primary clearance
            </span>
            {locked ? (
              <span className={`text-[12.5px] font-semibold px-3 py-1 rounded-full ${ROLE_COLORS[person.role]}`}>
                {ROLE_LABELS[person.role]}
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

          {/* assignments */}
          {!isOwner && (
            <div>
              <span className="block text-[10px] font-mono uppercase tracking-[0.1em] text-ink-4 mb-2">
                Assignments
              </span>
              <AssignmentEditor
                locations={locations}
                value={drafts}
                primaryClearance={clearance}
                actorRole={actorRole}
                onChange={setDrafts}
              />
            </div>
          )}

          {/* effective access */}
          {!isOwner && (
            <div className="px-4 py-3.5 bg-bg border border-line rounded-lg">
              <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-ink-4 mb-2.5">
                Effective access
              </div>
              {preview.length === 0 ? (
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
                      {e.source === 'override' && (
                        <span className="text-[10px] font-mono text-gold-2">override</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex gap-2 px-3 py-2.5 bg-red-soft border border-red/20 rounded-[10px]">
              <span className="text-red-text">⚠</span>
              <p className="text-[12.5px] text-red-text leading-relaxed">{error}</p>
            </div>
          )}

          {!locked && (
            <button
              onClick={save}
              disabled={busy}
              className="w-full py-3 rounded-[10px] bg-ink text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              Save changes
            </button>
          )}

          {/* T4 — deactivate vs remove */}
          {!locked && (
            <div className="pt-2 border-t border-bg-2 space-y-2">
              <p className="text-[11px] text-ink-4 pt-3">
                Two ways to revoke access — pick by whether they might return.
              </p>

              <button
                onClick={() =>
                  call(() =>
                    fetch(`/api/settings/users/${person.id}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ isActive: !person.isActive }),
                    }),
                  )
                }
                disabled={busy}
                className="w-full flex items-start gap-3 text-left border border-line rounded-lg px-3.5 py-3 hover:bg-bg disabled:opacity-50"
              >
                <Pause size={15} className="text-gold-2 mt-0.5 shrink-0" />
                <span className="flex-1">
                  <span className="flex items-center justify-between">
                    <b className="text-[13px] text-ink">
                      {person.isActive ? 'Deactivate' : 'Reactivate'}
                    </b>
                    <span className="text-[10px] font-mono text-green-text bg-green-soft px-2 py-0.5 rounded-full">
                      reversible
                    </span>
                  </span>
                  <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
                    {person.isActive
                      ? 'Loses access immediately. Account, assignments & history kept — reactivate anytime.'
                      : 'Restores access with their existing assignments.'}
                  </span>
                </span>
              </button>

              <button
                onClick={() =>
                  confirmRemove
                    ? call(() => fetch(`/api/settings/users/${person.id}`, { method: 'DELETE' }), onClose)
                    : setConfirmRemove(true)
                }
                disabled={busy}
                className={`w-full flex items-start gap-3 text-left border rounded-lg px-3.5 py-3 disabled:opacity-50 ${
                  confirmRemove ? 'border-red bg-red-soft' : 'border-red/30 hover:bg-red-soft/40'
                }`}
              >
                <Trash2 size={15} className="text-red-text mt-0.5 shrink-0" />
                <span className="flex-1">
                  <span className="flex items-center justify-between">
                    <b className="text-[13px] text-red-text">
                      {confirmRemove ? 'Tap again to permanently remove' : 'Remove permanently'}
                    </b>
                    <span className="text-[10px] font-mono text-red-text bg-red-soft px-2 py-0.5 rounded-full">
                      cannot undo
                    </span>
                  </span>
                  <span className="block text-[12px] text-ink-3 leading-relaxed mt-0.5">
                    Deletes the account and all assignments. Activity stays in the audit log.
                  </span>
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/components/people/PersonDetailPanel.tsx
git commit -m "feat(people): person detail — primary, assignments, effective access, lifecycle"
```

---

### Task 19: `AccessAuditPanel`

**Files:**
- Create: `src/components/people/AccessAuditPanel.tsx`

**Interfaces:**
- Consumes: `relativeTime`, `initials`.
- Produces: default export `AccessAuditPanel`, props `{ refreshKey: number }`.

- [ ] **Step 1: Implement**

```tsx
'use client'
import { useEffect, useState } from 'react'
import { initials, relativeTime } from './people-utils'

interface AuditEvent {
  id: string
  actorName: string | null
  actorEmail: string
  action: string
  targetName: string | null
  targetEmail: string
  detail: Record<string, unknown> | null
  createdAt: string
}

const VERB: Record<string, string> = {
  INVITED: 'invited',
  REINVITED: 're-invited',
  INVITE_REVOKED: 'revoked the invite for',
  CLEARANCE_CHANGED: 'changed',
  ASSIGNMENT_ADDED: 'gave access to',
  ASSIGNMENT_REMOVED: 'removed access from',
  OVERRIDE_SET: 'added an override for',
  OVERRIDE_CLEARED: 'cleared an override for',
  DEACTIVATED: 'deactivated',
  REACTIVATED: 'reactivated',
  REMOVED: 'permanently removed',
}

function describe(e: AuditEvent): string {
  const d = (e.detail ?? {}) as Record<string, string | null>
  const place = d.rcName ?? d.locationName ?? null
  switch (e.action) {
    case 'CLEARANCE_CHANGED': return `from ${d.from} → ${d.to}`
    case 'INVITED':
    case 'REINVITED': return d.to ? `as ${d.to}` : ''
    case 'OVERRIDE_SET': return place ? `${d.to} at ${place}` : `${d.to}`
    case 'OVERRIDE_CLEARED': return place ? `back to inherited at ${place}` : 'back to inherited'
    case 'ASSIGNMENT_ADDED':
    case 'ASSIGNMENT_REMOVED': return place ?? ''
    case 'DEACTIVATED': return 'revoked all access'
    default: return ''
  }
}

export default function AccessAuditPanel({ refreshKey }: { refreshKey: number }) {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/settings/access-audit?days=${days}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : { events: [] }))
      .then(d => { if (!cancelled) setEvents(d.events ?? []) })
      .catch(() => { if (!cancelled) setEvents([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days, refreshKey])

  return (
    <div className="bg-paper border border-line rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-line">
        <h2 className="font-fraunces text-base font-semibold text-ink">Access audit</h2>
        <select
          value={days}
          onChange={e => setDays(Number(e.target.value))}
          className="text-[11px] font-mono text-ink-3 border border-line rounded-lg px-2.5 py-1 bg-paper"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={3650}>All time</option>
        </select>
      </div>

      {loading && <p className="px-5 py-6 text-[13px] text-ink-4">Loading…</p>}

      {!loading && events.length === 0 && (
        <p className="px-5 py-6 text-[13px] text-ink-4">
          No access changes in this window.
        </p>
      )}

      {events.map(e => (
        <div key={e.id} className="flex items-start gap-3 px-5 py-3 border-t border-bg-2">
          <span className="shrink-0 w-7 h-7 rounded-full bg-bg-2 grid place-items-center text-[10.5px] font-semibold text-ink-2 mt-0.5">
            {initials(e.actorName ?? e.actorEmail)}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[12.5px] leading-relaxed text-ink-2">
              <b className="text-ink">{e.actorName ?? e.actorEmail}</b>{' '}
              <span className="text-ink-3">{VERB[e.action] ?? e.action}</span>{' '}
              <b className="text-ink">{e.targetName ?? e.targetEmail}</b>
            </p>
            {describe(e) && <p className="text-[11.5px] text-ink-4 mt-0.5">{describe(e)}</p>}
          </div>
          <span className="shrink-0 text-[11px] text-ink-4 whitespace-nowrap">
            {relativeTime(e.createdAt)}
          </span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/components/people/AccessAuditPanel.tsx
git commit -m "feat(people): access audit panel"
```

---

### Task 20: Rebuild `/setup/users` as the People & Access container

**Files:**
- Modify: `src/app/setup/users/page.tsx` (full replacement)

**Interfaces:**
- Consumes: every component from Tasks 14–19, `useUser`.
- Produces: the page. No exports beyond the default.

- [ ] **Step 1: Replace the file wholesale**

```tsx
'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { UserPlus, Loader2, Smile } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'
import PeopleList from '@/components/people/PeopleList'
import InviteModal from '@/components/people/InviteModal'
import PersonDetailPanel from '@/components/people/PersonDetailPanel'
import AccessAuditPanel from '@/components/people/AccessAuditPanel'
import type { LocationNode, Person } from '@/components/people/people-utils'

export default function PeopleAndAccessPage() {
  const { user } = useUser()
  const [people, setPeople] = useState<Person[]>([])
  const [locations, setLocations] = useState<LocationNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [inviting, setInviting] = useState(false)
  const [selected, setSelected] = useState<Person | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/api/settings/users', { cache: 'no-store' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Failed (${res.status})`)
      const data = await res.json()
      setPeople(data.users ?? [])
      setLocations(data.locations ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load people')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const refresh = () => { load(); setRefreshKey(k => k + 1) }

  const resend = async (p: Person) => {
    await fetch(`/api/settings/users/${p.id}/resend`, { method: 'POST' })
    refresh()
  }
  const revoke = async (p: Person) => {
    await fetch(`/api/settings/users/${p.id}`, { method: 'DELETE' })
    refresh()
  }

  const pendingCount = people.filter(p => p.isPending).length
  const actorRole = user?.role ?? 'STAFF'

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-ink-4">
        <Loader2 size={15} className="animate-spin" /> Loading people…
      </div>
    )
  }

  // T5 — empty state
  const isEmpty = people.filter(p => p.id !== user?.id).length === 0

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="bg-paper border border-line rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-5 border-b border-line">
          <div>
            <h1 className="font-fraunces text-xl font-semibold text-ink">People &amp; Access</h1>
            <p className="text-[12.5px] text-ink-3 mt-0.5">
              {people.length} {people.length === 1 ? 'person' : 'people'} · {locations.length}{' '}
              {locations.length === 1 ? 'location' : 'locations'}
              {pendingCount > 0 && ` · ${pendingCount} pending invite${pendingCount > 1 ? 's' : ''}`}
            </p>
          </div>
          <button
            onClick={() => setInviting(true)}
            className="flex items-center gap-2 bg-ink text-white px-4 py-2.5 rounded-[10px] text-[13px] font-medium hover:bg-ink-2"
          >
            <UserPlus size={14} className="text-gold" /> Invite people
          </button>
        </div>

        {error && (
          <div className="px-5 py-3 bg-red-soft border-b border-line">
            <p className="text-[12.5px] text-red-text">{error}</p>
          </div>
        )}

        {isEmpty ? (
          <div className="px-8 py-12 text-center">
            <div className="w-[60px] h-[60px] rounded-2xl bg-bg border border-line grid place-items-center mx-auto mb-5 text-ink-4">
              <Smile size={26} />
            </div>
            <h2 className="font-fraunces text-[19px] font-semibold text-ink mb-1.5">
              It&apos;s just you so far
            </h2>
            <p className="text-[13px] text-ink-3 leading-relaxed max-w-[300px] mx-auto mb-5">
              You&apos;re the <b>{actorRole === 'OWNER' ? 'Owner' : 'Admin'}</b>. Invite your managers
              and staff, and assign each of them to a location or revenue center.
            </p>
            <button
              onClick={() => setInviting(true)}
              className="px-5 py-2.5 rounded-[10px] bg-ink text-white font-semibold text-[13.5px]"
            >
              <span className="text-gold">+</span> Invite your first teammate
            </button>
            {locations.length === 0 && (
              <p className="mt-4 text-[11.5px] text-ink-4">
                No locations yet?{' '}
                <Link href="/setup/revenue-centers" className="text-gold-2 font-medium">
                  Set up a location first →
                </Link>
              </p>
            )}
          </div>
        ) : (
          <PeopleList
            people={people}
            locations={locations}
            currentUserId={user?.id ?? null}
            onOpenPerson={setSelected}
            onResend={resend}
            onRevoke={revoke}
          />
        )}
      </div>

      <AccessAuditPanel refreshKey={refreshKey} />

      {inviting && (
        <InviteModal
          locations={locations}
          actorRole={actorRole}
          onClose={() => setInviting(false)}
          onInvited={refresh}
        />
      )}

      {selected && (
        <PersonDetailPanel
          person={selected}
          locations={locations}
          actorRole={actorRole}
          isMe={selected.id === user?.id}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Confirm the old scope route is fully gone**

Run: `grep -rn "user-scopes\|ScopeModal" src/`
Expected: no output.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles cleanly — **all** the type errors deferred from Tasks 4, 7, 8, 9 and 11 must now be gone. If any remain, fix them here.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/setup/users/page.tsx
git commit -m "feat(people): rebuild /setup/users as People & Access"
```

---

# Phase 5 — Migration and verification

### Task 21: The backfill script

**Files:**
- Create: `scripts/migrate-clearance.ts`

**Interfaces:**
- Consumes: `prisma`, `createAdminClient`.
- Produces: a CLI. `--dry-run` (default) prints the plan; `--apply` performs it.

- [ ] **Step 1: Implement**

```ts
/**
 * One-time, idempotent clearance backfill. Run AFTER the code is deployed.
 *
 *   npx tsx scripts/migrate-clearance.ts            # dry run (default)
 *   npx tsx scripts/migrate-clearance.ts --apply    # perform it
 *
 * 1. Promote the oldest active ADMIN to OWNER in BOTH stores (Prisma +
 *    Supabase user_metadata). No-op when an OWNER already exists.
 * 2. Grandfather every non-Owner/non-Admin user with zero UserScope rows:
 *    one row per active Location, clearance = null (inherit).
 *
 * Re-running is safe: both steps check current state first.
 */
import { PrismaClient } from '@prisma/client'
import { createClient } from '@supabase/supabase-js'

const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')
const log = (...a: unknown[]) => console.log(APPLY ? '[apply]' : '[dry-run]', ...a)

async function main() {
  // ── 1. Owner ────────────────────────────────────────────────────────────
  const existingOwner = await prisma.user.findFirst({ where: { role: 'OWNER' } })
  if (existingOwner) {
    log(`Owner already set: ${existingOwner.email} — skipping promotion.`)
  } else {
    const candidate = await prisma.user.findFirst({
      where: { role: 'ADMIN', isActive: true },
      orderBy: { createdAt: 'asc' },
    })
    if (!candidate) {
      log('No active ADMIN found — no owner to promote.')
    } else {
      log(`Promote to OWNER: ${candidate.email} (created ${candidate.createdAt.toISOString()})`)
      if (APPLY) {
        const supabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { autoRefreshToken: false, persistSession: false } },
        )
        // Supabase first: if it fails we have not yet touched Prisma, so the
        // two stores cannot diverge.
        const { error } = await supabase.auth.admin.updateUserById(candidate.id, {
          user_metadata: { role: 'OWNER', isActive: true, name: candidate.name },
        })
        if (error) throw new Error(`Supabase metadata update failed: ${error.message}`)
        await prisma.user.update({ where: { id: candidate.id }, data: { role: 'OWNER' } })
        log('Owner promoted in both stores.')
      }
    }
  }

  // ── 2. Grandfather assignments ──────────────────────────────────────────
  const locations = await prisma.location.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  })
  if (locations.length === 0) {
    log('No active locations — nothing to grandfather.')
  } else {
    const unassigned = await prisma.user.findMany({
      where: {
        role: { in: ['MANAGER', 'LEAD', 'STAFF'] },
        scopes: { none: {} },
      },
      select: { id: true, email: true, role: true },
    })
    log(
      `${unassigned.length} user(s) with no assignments → ` +
      `${unassigned.length * locations.length} row(s) across ${locations.length} location(s).`,
    )
    for (const u of unassigned) log(`  · ${u.email} (${u.role})`)

    if (APPLY && unassigned.length > 0) {
      await prisma.userScope.createMany({
        data: unassigned.flatMap(u =>
          locations.map(l => ({ userId: u.id, locationId: l.id, clearance: null })),
        ),
        skipDuplicates: true,
      })
      log('Grandfather rows written.')
    }
  }

  if (!APPLY) log('\nNothing was changed. Re-run with --apply to perform it.')
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Dry-run it**

Run: `npx tsx scripts/migrate-clearance.ts`
Expected: prints the promotion candidate and the grandfather counts, ending with "Nothing was changed."

**Do not run `--apply` yet.** It is the deploy checklist's final step (Task 22).

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-clearance.ts
git commit -m "feat(access): idempotent clearance backfill script"
```

---

### Task 22: Full verification

**Files:** none — this task only runs and observes.

- [ ] **Step 1: Full type-check and test**

Run: `npm run build && npm test`
Expected: build succeeds with no errors; all tests pass.

- [ ] **Step 2: Confirm the new routes are dynamic**

In the `npm run build` route table, confirm each of these shows `ƒ (Dynamic)`, never `○ (Static)`:

```
/api/settings/users
/api/settings/users/[id]
/api/settings/users/[id]/assignments
/api/settings/users/[id]/resend
/api/settings/access-audit
/api/me
```

A static one makes every non-GET method return 405.

- [ ] **Step 3: Confirm no stale references remain**

Run: `grep -rn "user-scopes\|VALID_ROLES\|ScopeModal" src/`
Expected: no output.

Run: `grep -rn "role !== 'ADMIN'\|role === 'ADMIN'" src/middleware.ts`
Expected: no output — middleware is fully rank-based.

- [ ] **Step 4: Exercise the app**

Start the dev server via the preview tool (never `npm run dev` in a shell) and verify:

1. `/setup/users` renders People & Access, grouped by location, with the audit panel below.
2. "Invite people" with **no** assignment selected shows the zero-assignment error and does not send.
3. Invite with one location assignment succeeds and appears under Pending invites.
4. Opening a person, setting an RC-level override, and saving updates the Effective access list and writes `OVERRIDE_SET` into the audit panel.
5. Deactivate → the row dims and an audit entry appears; reactivate restores it.
6. The Owner's detail panel shows the "cannot be changed" notice with no Save button.

- [ ] **Step 5: Run the backfill**

Only after steps 1–4 pass:

```bash
npx tsx scripts/migrate-clearance.ts            # confirm the plan
npx tsx scripts/migrate-clearance.ts --apply
```

Expected: owner promoted, grandfather rows written. Re-run once more and confirm it reports the owner is already set and there are zero unassigned users — proving idempotency.

- [ ] **Step 6: Verify the Lead EOD path**

With a `LEAD` user (change one test account's clearance through the UI):

1. `/end-of-day` loads rather than redirecting to `/`.
2. No "Food cost · today" or "Net sales" figures render.
3. Checklist items tick, temps gate works, sign-off completes.
4. `curl` the close endpoint as that user and confirm `labourCost` etc. are **absent** from the JSON, not null.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore(access): verification pass for user system & access slice"
```

---

## Notes for the implementer

- **Deferred type errors are expected** during Tasks 4–11. `src/app/setup/users/page.tsx` and `src/contexts/UserContext.tsx` are rewritten in Tasks 11 and 20; errors confined to those two files may be carried forward. Errors anywhere else must be fixed in the task that caused them.
- **`npm run build` is the discovery tool.** `Record<Role, …>` maps break at compile time for every site that enumerates roles — that is deliberate.
- **Never start the dev server with `npm run dev` in a shell.** Use the preview tooling.
- **The backfill is the only step that touches live data.** Everything before it is additive and reversible.
