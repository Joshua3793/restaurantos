# User System & Access — Foundation Slice

**Date:** 2026-07-20
**Source design:** Claude Design project *Controla OS* → `user-system/User System & Auth.html`
**Status:** approved design, ready for implementation planning

---

## Scope

The source design covers four subsystems. This spec implements **two of them**:

| # | Subsystem | In this spec |
|---|---|---|
| 1 | Clearance model — `OWNER`/`LEAD` levels, per-assignment overrides, effective access | **Yes** |
| 2 | Capability-matrix enforcement (13 areas × 5 levels), scope-aware permission checks | **No** — own spec, later |
| 3 | Auth screens — login direction A/B, accept-invite, forgot/reset, expired states | **No** — own spec, later |
| 4 | People & Access page + access audit log | **Yes** |

Subsystem 2 is larger than the other three combined and touches 84 `requireSession` call sites. It is deliberately deferred so that enforcement lands against a populated, real data model rather than an empty one.

**One exception to the deferral:** Shift Lead receives a narrow, explicitly bounded set of capabilities at end-of-day (see *Shift Lead capabilities* below). Without it, promoting someone to Shift Lead would change a badge and nothing else.

### Success criteria

- An admin can assign a five-level clearance together with a location or revenue center, and override that clearance per assignment.
- People & Access shows, for any person, their primary clearance, every assignment, and the resulting effective access per revenue center.
- Every change to anyone's access is recorded with actor, target, before/after, and timestamp — and survives hard-deleting either party.
- A Shift Lead can walk the EOD checklist, log temps, sign off, and write the handover, while seeing no money.
- No user who exists today loses any access at deploy time.

---

## Current state

- `Role` is `ADMIN | MANAGER | STAFF`, global. `requireSession(minRole)` in `src/lib/auth.ts` is called from 84 files.
- `src/middleware.ts` gates by URL prefix, reading `user_metadata.role` with string equality (`role !== 'ADMIN'`).
- `UserScope` already models assignments (`locationId?` / `revenueCenterId?`) but carries **visibility only** — there is no clearance column. `src/lib/rc-scope.ts` already expands a location assignment to its child RCs.
- `resolveScopedRcIds()` returns `null` (= unrestricted) for `ADMIN` **and** for any user with zero `UserScope` rows.
- No audit-log model exists.
- `/setup/users` is 583 lines with a `ScopeModal` defined inside it; clearance and scope are presented as two unrelated concepts.

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Owner seat | Seeded from the oldest active `ADMIN`; single-seat enforced by a partial unique index; non-transferable | Matches the design's "1 seat · non-transferable". Transfer is a clean follow-up. |
| Zero assignments | Fail closed for *new* users; existing users grandfathered with real rows at migration | No existing user loses access; absence of assignments stops meaning "everything" going forward. |
| Audit log | Dedicated `AccessAuditEvent` table, access-changes only, append-only, kept forever (30 days is the default *view*) | Smallest thing that makes the T6 card real; write points are all in routes this slice already rewrites. |
| Shift Lead | Assignable **and** given EOD operational capabilities (B1) | A rung with no teeth reads as a bug the first time a real shift lead can't close the day. |
| Column naming | `User.role` stays `role`; "clearance" is UI vocabulary only | Renaming touches 51 files plus the Supabase `user_metadata.role` key middleware reads, for zero behavioral gain. |
| Enum strategy | Extend `Role`; do **not** add a parallel `Clearance` enum | Two sources of permission truth, in both Prisma and Supabase, is the divergence bug the spine rule exists to prevent. |
| Resolution home | New `src/lib/access.ts`; `rc-scope.ts` delegates and keeps its signatures | `rc-scope.ts` is already 140 lines of subtle null-means-unrestricted logic; this slice would roughly double it. |

---

## Data model

All schema changes are additive.

```prisma
enum Role { OWNER  ADMIN  MANAGER  LEAD  STAFF }   // OWNER, LEAD are new

model UserScope {
  // ...existing fields unchanged
  clearance  Role?      // null = inherit the user's primary clearance
}

model AccessAuditEvent {
  id           String   @id @default(cuid())
  actorId      String?
  actor        User?    @relation("AuditActor",  fields: [actorId],      references: [id], onDelete: SetNull)
  actorEmail   String               // denormalized: survives actor deletion
  actorName    String?
  targetUserId String?
  target       User?    @relation("AuditTarget", fields: [targetUserId], references: [id], onDelete: SetNull)
  targetEmail  String               // denormalized: the point of the log
  targetName   String?
  action       String
  detail       Json                 // { from, to, locationId, locationName, rcId, rcName }
  createdAt    DateTime @default(now())
  @@index([createdAt])
  @@index([targetUserId])
}
```

`User` gains the two back-relations `auditEventsActed AccessAuditEvent[] @relation("AuditActor")` and `auditEventsReceived AccessAuditEvent[] @relation("AuditTarget")`. Both sides are `SetNull`, so hard-deleting either party blanks the id but leaves the row — the denormalized email/name is what keeps the entry readable.

`action` values: `INVITED`, `REINVITED`, `INVITE_REVOKED`, `CLEARANCE_CHANGED`, `ASSIGNMENT_ADDED`, `ASSIGNMENT_REMOVED`, `OVERRIDE_SET`, `OVERRIDE_CLEARED`, `DEACTIVATED`, `REACTIVATED`, `REMOVED`.

`PUT .../assignments` replaces a person's whole assignment set, so it diffs old against new and emits one event per actual change — added, removed, or a changed `clearance` on a surviving row (`OVERRIDE_SET` / `OVERRIDE_CLEARED`). A no-op PUT writes no events.

### Single-owner invariant

Enforced in the schema, using the same partial-index pattern as `isPrimary` on supplier offers:

```sql
CREATE UNIQUE INDEX "User_single_owner" ON "User" ((true)) WHERE role = 'OWNER';
```

Every `OWNER` row collides on the same key, so at most one can exist. Prisma cannot express this, so it lives in raw SQL alongside the existing `UserScope_user_node_unique` index.

The existing `UserScope_user_node_unique` index is unaffected — adding a `clearance` column does not change the `(userId, locationId, revenueCenterId)` tuple it covers.

---

## Migration

Postgres will not let a transaction use an enum value it just added, so adding `OWNER`/`LEAD` and writing them cannot be a single migration. Three phases, in this order:

**Phase 1 — expand (SQL, additive, deployable anytime).**
`ALTER TYPE "Role" ADD VALUE 'OWNER'`, `ALTER TYPE "Role" ADD VALUE 'LEAD'`, `ALTER TABLE "UserScope" ADD COLUMN "clearance"`, `CREATE TABLE "AccessAuditEvent"`, `CREATE UNIQUE INDEX "User_single_owner"`. Nothing reads or writes the new values yet.

Because `prisma migrate dev` fails P3006 against the shadow DB, this goes through the `migrate diff` → `db execute` → `migrate resolve` path over `DIRECT_URL`.

**Phase 2 — deploy the code.** It tolerates both the pre- and post-backfill state: zero assignments still resolves to unrestricted, so nobody is locked out while phase 3 is pending.

**Phase 3 — backfill (`scripts/migrate-clearance.ts`).** Idempotent, `--dry-run` by default. Two actions:

1. Promote the oldest active `ADMIN` — `where: { role: 'ADMIN', isActive: true }, orderBy: { createdAt: 'asc' }, take: 1` — to `OWNER` **in both stores**: Prisma `User.role` and Supabase `user_metadata.role`. If an `OWNER` already exists, this is a no-op.
2. Grandfather every non-Owner/non-Admin user with zero `UserScope` rows: one row per active `Location`, `clearance = null`.

New locations created after the backfill will not auto-grant to grandfathered users. That is intended — it is what makes access fail closed going forward.

Every step is additive and the code ships before any data moves. Until phase 3 runs there is simply no Owner; the ladder's top rung is empty and the app behaves exactly as today.

---

## Access resolution

### `src/lib/roles.ts` — pure, no `server-only`

`auth.ts` declares `import 'server-only'`, so middleware cannot import from it — which is why middleware currently hardcodes `role !== 'ADMIN'`. That comparison would lock the Owner out of `/setup` the moment `OWNER` exists. This module is importable by middleware, server code, and client components alike.

```ts
export const ROLE_RANK = { STAFF: 0, LEAD: 1, MANAGER: 2, ADMIN: 3, OWNER: 4 }
export const atLeast = (role: Role, min: Role) => ROLE_RANK[role] >= ROLE_RANK[min]
export const ROLE_LABELS = { OWNER:'Owner', ADMIN:'Admin', MANAGER:'Manager', LEAD:'Shift Lead', STAFF:'Staff' }
export function assignableLevels(actor: Role): Role[]
// OWNER  → [ADMIN, MANAGER, LEAD, STAFF]
// ADMIN  → [ADMIN, MANAGER, LEAD, STAFF]
// MANAGER→ [LEAD, STAFF]
// LEAD / STAFF → []
// OWNER is never returned by any actor — the seat is non-transferable in this slice.
```

Because `LEAD` ranks **below** `MANAGER`, all 84 existing `requireSession('MANAGER')` / `requireSession('ADMIN')` call sites keep their exact current meaning, and `OWNER` passes every one of them. `requireSession`'s signature does not change. `devBypassUser()` prefers `OWNER`, then `ADMIN`.

### `src/lib/access.ts` — server-only

```ts
effectiveAccess(user): Array<{
  rcId, rcName, locationId, locationName,
  clearance: Role,
  source: 'inherited' | 'override'
}>
clearanceForRc(user, rcId): Role | null
```

`effectiveAccess` returns precisely what the T3 detail card renders. The resolution itself is a **pure** function — `resolveEffective(primaryRole, scopes, rcsByLocation)` — with a thin Prisma-fetching wrapper around it, so it can be unit-tested directly.

`rc-scope.ts` keeps every public signature it has today and delegates here. Nothing downstream of it changes.

### The zero-assignments rule

`resolveScopedRcIds` keeps its current behavior: `OWNER`/`ADMIN` → `null`, zero rows → `null`. This branch is **not** the design's semantics; it is a safety net that lets the code deploy before the backfill.

Fail-closed is achieved from the other end: **the invite and assignment APIs reject a person with zero assignments.** No new user can reach the permissive branch, and the backfill gives every existing user real rows. Post-backfill the branch is dead in practice, and People & Access renders anyone still hitting it as an amber *"No assignments — sees all revenue centers."*

Flipping the branch to hard-closed later is then a one-line change with no migration attached.

### Middleware

String equality is replaced with `atLeast()`. `ADMIN_PREFIXES` requires rank ≥ `ADMIN` (so `OWNER` passes); `MANAGER_PREFIXES` requires rank ≥ `MANAGER`. `/end-of-day` moves out of `MANAGER_PREFIXES` into a new `LEAD_PREFIXES` (rank ≥ `LEAD`).

### `/api/me`

Gains `effectiveAccess` alongside `role`, so client-side gating reads the same resolution the server does instead of re-deriving it.

---

## Shift Lead capabilities

Two of the matrix's three Lead capabilities are already unrestricted today and need no work:

- **Wastage** — both handlers in `src/app/api/wastage/route.ts` use bare `requireSession()`, and `/wastage` is in no middleware prefix list.
- **Read-only invoices** — `exceptions`, `kpis`, and `sessions` GET/POST are all bare `requireSession()`; only `sessions/[id]` PATCH/DELETE and `approve` require `MANAGER`.

(Both are also open to `STAFF`, which contradicts the matrix. Tightening them is enforcement work and belongs to the deferred spec, not here.)

**End-of-day** is the real change, and it carries a money-exposure problem: `/api/eod/summary` returns `netSales`, `foodSales`, `foodCostDollars`, `foodCostPct`, `avgSpend`; `/api/eod/handover` recomputes `netSales`/`covers`/`foodCostPct` live; and `/api/eod/close` GET returns `labourCost`, `grossSales`, `compsVoids`, `discounts`. The ladder states Lead has *"No cost or money."*

Resolution — route-level split, plus one narrowly-scoped field rule:

| Route | Level | Note |
|---|---|---|
| `eod/close` GET | `LEAD` | **omits** `labourCost`, `grossSales`, `compsVoids`, `discounts` for `LEAD` |
| `eod/close` PATCH | `LEAD` | accepts `handoverNote` from `LEAD`; **403s** on the four money fields |
| `eod/close/entry` PATCH | `LEAD` | checklist ticks |
| `eod/close/signoff` POST | `LEAD` | |
| `eod/close/reopen` POST | `MANAGER` | a Lead may close the day, not un-close a signed-off one |
| `eod/summary` GET | `MANAGER` | money |
| `eod/orders` GET | `MANAGER` | |
| `eod/email` POST | `MANAGER` | outward-facing |
| `eod/handover` GET | `MANAGER` | money |
| `eod/checklist*` | `ADMIN` | unchanged — template CRUD is Setup |

The EOD page hides the money inputs for `LEAD` and lets the recap strip fall back to its existing `—` placeholders when `summary` and `handover` 403.

This is four named fields on one route, not a general response-shaping mechanism. Role-shaped API responses are exactly what subsystem 2 will decide on.

---

## People & Access

Route stays `/setup/users`, retitled "People & Access" — the `REDIRECTS` table already points `/settings/users` there.

### Components

`page.tsx` becomes a thin container over `src/components/people/`:

| File | Owns |
|---|---|
| `PeopleList.tsx` | location-grouped list, search, level/location filters |
| `PersonRow.tsx` | avatar, clearance badge, scope chips, ⋯ menu |
| `AssignmentEditor.tsx` | location→RC tree with per-node override picker — shared by invite and detail |
| `InviteModal.tsx` | T2 — emails, primary clearance, assignments |
| `PersonDetailPanel.tsx` | T3 — primary, assignments, effective access, deactivate/remove |
| `AccessAuditPanel.tsx` | T6 |
| `people-utils.ts` | grouping, chip formatting, effective-access summarizing |

`AssignmentEditor` being shared between invite and detail is what keeps those two views from drifting apart.

Also covered: T4 deactivate-vs-remove (existing `PATCH isActive` / `DELETE` behavior, restyled, plus audit and Owner guards) and T5 empty state.

### APIs

Extend the existing namespace rather than forking a parallel one:

| Endpoint | Change |
|---|---|
| `GET /api/settings/users` | returns assignments + pending invites |
| `POST /api/settings/users` | invite gains `clearance` + `assignments[]`; **rejects zero assignments** |
| `PATCH /api/settings/users/[id]` | clearance / `isActive` |
| `DELETE /api/settings/users/[id]` | hard delete (unchanged semantics) |
| `PUT /api/settings/users/[id]/assignments` | **new** — replaces `/api/settings/user-scopes` |
| `/api/settings/user-scopes` (GET + PUT) | **route deleted** — its only caller is the `ScopeModal` in `/setup/users`, which this slice replaces |
| `POST /api/settings/users/[id]/resend` | **new** |
| `GET /api/settings/access-audit?days=30` | **new** |

The invite POST keeps its existing idempotent reconcile logic intact — pending invites deleted and re-sent, previously-accepted accounts reactivated in place — and gains assignment creation plus an audit write.

### Audit writes

One helper, `recordAccessEvent()` in `src/lib/access-audit.ts`, called inside the same transaction as each mutation so a failed clearance change cannot leave an orphan log line.

### Guards

- Owner cannot be deactivated, removed, or demoted through any path; the clearance picker never offers `OWNER`.
- Nobody can change their own clearance or deactivate themselves (precedent: the existing `Cannot invite yourself` check).
- Hard delete keeps working as today — chat history survives via `ChatConversation.userId onDelete: SetNull`, and the audit row survives because target email/name are denormalized.

### Deferred matrix inconsistency

The capability matrix gives Manager `◐` on People & Access — *"Can invite Leads & Staff to it."* But `/setup` is `ADMIN_PREFIXES`, so a Manager cannot reach this page. In this slice People & Access stays `ADMIN`+. `assignableLevels()` expresses the Manager rule now, but nothing calls it with a Manager until subsystem 2 opens the page up.

---

## Error handling

**Two-store sync is the sharpest edge.** Every clearance change writes Supabase `user_metadata.role` (read by middleware) and Prisma `User.role` (read by `requireSession`). A partial write half-locks the account.

Order: Prisma inside a transaction first, then Supabase. If the Supabase write fails, revert the Prisma row and return 500 with an explicit "access unchanged" message. **Never return 200 on a partial write.**

**Single-owner violations** surface as Prisma `P2002` on `User_single_owner`. Map to a 409 *"There is already an owner"* rather than letting a constraint error escape as a 500.

**`AuthError(401|403)`** handling is unchanged — each route catches and returns `NextResponse.json({ error }, { status })`.

---

## Testing

`ROLE_LABELS` and `ROLE_COLORS` are `Record<Role, …>`, so adding `OWNER` and `LEAD` breaks compilation at every exhaustive map over `Role`, across the 51 files referencing role literals. `npm run build` is therefore the discovery tool for those sites — intentional, rather than grepping for them.

**`src/lib/__tests__/access.test.ts`** (pure, against `resolveEffective`):

- inherited clearance from primary
- per-assignment override
- location assignment expanding to all child RCs
- override on a single RC beneath an inherited location assignment
- union across overlapping assignments
- zero assignments
- `assignableLevels` — never returns `OWNER`; `MANAGER` returns only `[LEAD, STAFF]`
- `atLeast()` rank ordering — the thing all 84 call sites silently depend on

`npm run build` after each phase; `npm test` after touching resolution.

**Verified manually, not by tests:** the invite email round-trip through `/auth/callback`, and the Lead EOD flow — sign in as a Lead, confirm the four money fields are absent from `close` GET and the recap strip degrades cleanly.

---

## Out of scope

- The capability matrix as an enforcement layer (subsystem 2).
- Login screen direction A vs B, accept-invite, forgot/reset, expired-link screens (subsystem 3).
- Owner transfer ceremony.
- Tightening Staff's existing access to wastage and read-only invoices.
- Opening People & Access to Managers.
