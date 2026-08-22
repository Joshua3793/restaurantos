# Fix: `GET /api/prep/cooks` leaked tip-payroll fields to any authenticated user

## The bug

`src/app/api/prep/cooks/route.ts` GET handler called `requireSession()` with no
`minRole`, then ran `prisma.cook.findMany({ where, orderBy })` with **no `select`**
and returned the rows verbatim. `Cook` (`prisma/schema.prisma:729-750`) carries
tip-payroll columns alongside roster identity:

```
id, name, initials, homeStation, isActive, sortOrder   <- identity
lastName, clockId, wage, dailyHourCap, tipRoleId, onTipPool, posPosition  <- payroll
```

Any authenticated user — including STAFF, who legitimately need this endpoint
to claim prep jobs off the run sheet — could `fetch('/api/prep/cooks')` and
read every colleague's hourly wage (`wage`) and POS employee number
(`clockId`), plus `dailyHourCap`, `tipRoleId`, `onTipPool`, `posPosition`,
`lastName`. This is the same class of field `src/lib/tips/me.ts` deliberately
strips even from a staff member's view of their *own* pay.

One correction to the brief: it mentioned a recently-added `userId` column
linking a Cook row to an app login. **I checked `prisma/schema.prisma` and no
such column exists on `Cook`** in this worktree (grep for `userId` only hits
`UserScope` and another unrelated model). I did not invent a select field for
it — the fix below is scoped to the fields that actually exist on the model.
Flagging this in case the `userId` column landed on a branch not yet merged
to `main`, so it isn't missed when it does land.

## Consumers read before choosing the field set

- `src/app/prep/page.tsx:271` — `fetch('/api/prep/cooks')`, feeds `cooks`
  state into `RunSheet`, `RunSheetMobile`, `PlannerDesktop`, `PlannerMobile`
  (props typed `Cook[]` from `assignee.tsx`), which thread it into
  `CrewStrip`, `InProgressRail`, `AssignPill`, `PostDialog`, `DraftRow`. Every
  one of these renders/reads only `id`, `name`, `initials`, `homeStation`
  (confirmed by grep across `src/components/prep/runsheet/*.tsx` and
  `src/components/prep/planner/*.tsx` — none reference `wage`, `clockId`, or
  any other payroll field).
- `src/components/prep/runsheet/assignee.tsx:9` — the `Cook` type consumers
  are built against: `{ id, name, initials, homeStation }`. Comment on the
  type explicitly says it "matches the shape returned by GET
  /api/prep/cooks."
- `src/app/setup/kitchen-crew/page.tsx:212` (`?includeInactive=true`) — the
  ADMIN-gated roster admin page. Its local `Cook` interface
  (`src/app/setup/kitchen-crew/page.tsx:6-13`) is
  `{ id, name, initials, homeStation, isActive, sortOrder }`. Grepped the
  whole file for `wage|clockId|dailyHourCap|tipRole|onTipPool|posPosition|userId|lastName`
  — zero hits. The admin page does not render or need any payroll field
  either; it only adds `isActive` (reactivate toggle) and `sortOrder` (manual
  ordering) on top of what the prep page needs.
- `src/app/api/prep/items/route.ts:101` — queries `prisma.cook.findMany`
  **directly**, not through this endpoint. It already narrowed its own
  output to `{ id, initials, name, homeStation }` in the `assignedCook`
  object it builds (line ~205), so it wasn't leaking to its own callers —
  but it was pulling every column (including payroll) into server memory
  needlessly. Tightened its query with an explicit `select` matching what it
  actually uses, for consistency and defense in depth (not a fix to an
  external leak — this route never returned the extra fields).

## Fix

`src/app/api/prep/cooks/route.ts` GET: added an explicit, named
`COOK_ROSTER_SELECT`:

```ts
{ id: true, name: true, initials: true, homeStation: true, isActive: true, sortOrder: true }
```

No role gating was added to the handler. **Neither consumer — including the
ADMIN Kitchen Crew page — needs any payroll field from this endpoint at
all**, so the smallest fix is a single unconditional `select` shared by both
call shapes (default and `?includeInactive=true`). The Kitchen Crew page's
ADMIN gate is enforced by middleware on the *page* route
(`/setup` → `ADMIN_PREFIXES` in `src/middleware.ts` / `route-access.ts`), not
by this API route, so the API had to be safe at every role regardless — this
fix makes it safe unconditionally rather than conditionally, which is both
simpler and more robust (no role check to get wrong or bypass).

`src/app/api/prep/items/route.ts`: added `select: { id, initials, name, homeStation }`
to its direct `prisma.cook.findMany` call (same rationale, no behavior
change — its output shape was already this narrow).

## What I left alone

- **`POST /api/prep/cooks`** and **`PATCH`/`DELETE /api/prep/cooks/[id]`**
  already call `requireSession('ADMIN')` — correct clearance, unchanged.
  They do return the full `Cook` row (all payroll columns) from
  `prisma.cook.create`/`.update` with no `select`, to a caller who is already
  ADMIN. This is not the STAFF-facing leak in scope here, and I did not
  change it — flagging it only because it's the same *pattern* (missing
  `select`) even though the caller is already privileged enough that it's
  not a clearance defect. If someone wants defense-in-depth there too, the
  same `COOK_ROSTER_SELECT`-style narrowing could be applied, but the
  Kitchen Crew page doesn't use the extra fields from those responses either
  (it discards the response body and calls `refetch()`), so it's pure
  hardening, not a bug fix. Left out of this branch to keep the change
  minimal and on-target.
- Did not touch anything under `src/lib/tips/` or `src/app/api/tips/` per
  constraints.
- Did not change any route's clearance (`requireSession` calls are
  unmodified everywhere).

## Tests

Added `src/app/api/prep/cooks/__tests__/route.test.ts`, following the
`vi.mock`-of-Prisma pattern from
`src/app/api/tips/roster/__tests__/route.test.ts`. The mock `cook.findMany`
implementation actually applies the `select` argument it's called with (down
from a "full" fake payroll row), so the tests exercise the real behavior
rather than just asserting call arguments:

1. Non-privileged (STAFF) caller: response item matches the run sheet's
   `{ id, name, initials, homeStation }` shape and does **not** have `wage`,
   `clockId`, `userId`, `dailyHourCap`, `tipRoleId`, `onTipPool`,
   `posPosition`, or `lastName`.
2. `findMany` is called with an explicit `select` (not `undefined`)
   containing exactly the six roster-identity fields and not `wage`/`clockId`.
3. `?includeInactive=true` (Kitchen Crew page shape, tested with an ADMIN
   session) still returns `id, name, initials, isActive, sortOrder` for both
   active and inactive rows, still without payroll fields.
4. `requireSession` rejecting with `AuthError(401)` propagates as a 401 and
   `findMany` is never called.

### Results

- `npx vitest run src/app/api/prep/cooks/__tests__/route.test.ts` — 4/4 pass.
- `npm test` — **48 files / 716 tests, all passing** (0 failures). Note: the
  task brief cited a baseline of "751 passing across 49 files" on `main`;
  this worktree's `main` tip is `81ade82` (two commits ahead of the `cce6de0`
  listed as HEAD in the calling session's git status — both are docs-only
  commits per `git log`), and it already has only 47 pre-existing test files
  before my addition (48 with mine). I did not delete or skip any test file;
  the discrepancy predates this change and is not something this branch
  caused — flagging rather than silently absorbing it.
- `npx tsc --noEmit` — clean, no errors.

## Files changed

- `src/app/api/prep/cooks/route.ts` — added `COOK_ROSTER_SELECT`, applied to
  the GET `findMany` call.
- `src/app/api/prep/items/route.ts` — added `select` to its direct
  `prisma.cook.findMany` call.
- `src/app/api/prep/cooks/__tests__/route.test.ts` — new test file (above).
