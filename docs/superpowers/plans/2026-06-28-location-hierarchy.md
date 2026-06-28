# Location → Revenue Center Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-level Location → Revenue Center hierarchy with scoped per-user access, a read-only Location dashboard, an RC-level write boundary, and type-driven cost vocabulary (food cost % vs pour cost %).

**Architecture:** Existing `RevenueCenter` rows become operational *leaves* (every existing `revenueCenterId` FK is unchanged). A new `Location` parent is added on top and every RC gets a `locationId`. A new `UserScope` join links users to nodes; a resolver in `auth.ts` turns a user into a set of leaf-RC ids that folds into the `where.revenueCenterId` filters the app already uses. `RevenueCenter.type` (`FOOD`/`DRINK`) drives a vocabulary map and per-RC target cost; locations aggregate read-only.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase, pgBouncer transaction-mode pooler) · Tailwind · Supabase Auth.

---

## ⚠️ Repo-specific rules (read before any task)

- **No test suite.** `npm run build` is the only automated check and is also the type-checker. "Verify" steps mean `npm run build` (expect `✓ Compiled successfully`) plus preview verification, never `pytest`/`jest`.
- **Build deadlocks if the preview/dev server is running.** Stop the dev server before `npm run build`.
- **Migrations: `prisma migrate dev` is broken here** (P3006 shadow drift) and the direct DB host is unreachable. Add migrations with the diff/db-execute/resolve workaround over the pooler:
  1. Edit `prisma/schema.prisma`.
  2. `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > /tmp/mig.sql` — review the SQL.
  3. Apply DDL over the pooler with `$executeRawUnsafe` (hand-built literal SQL) — **never `$executeRaw` tagged templates for array/DDL writes** (pgBouncer transaction mode rejects named prepared statements).
  4. Create `prisma/migrations/<timestamp>_<name>/migration.sql` with the same SQL and `npx prisma migrate resolve --applied <name>` so history matches.
  5. `npx prisma generate`.
- **Decimal fields serialize as strings** in JSON. Wrap with `Number()` before arithmetic/`.toFixed()`.
- **Two distinct `isDefault` flags** will coexist: `Location.isDefault` (primary business) and `RevenueCenter.isDefault` (default stock pool / `stockOnHand` owner). Never conflate them in code.
- **Spec:** `docs/superpowers/specs/2026-06-28-location-hierarchy-design.md`.

---

## File structure

**New files:**
- `src/lib/rc-vocab.ts` — `VocabType`, `vocab[type]` label map, `getVocab(type)`.
- `src/lib/rc-scope.ts` — scope resolver: `resolveScopedRcIds(user)`, `assertRcInScope(user, rcId)`, `scopeWhere(user, rcId, isDefault)`.
- `src/app/api/locations/route.ts` — GET (list with nested RCs) / POST (create location).
- `src/app/api/locations/[id]/route.ts` — GET / PATCH / DELETE a location.
- `src/app/api/settings/user-scopes/route.ts` — GET / PUT a user's scope assignments (ADMIN).
- `src/app/api/insights/location-dashboard/route.ts` — aggregated read-only metrics for a location.
- `src/components/locations/LocationDashboard.tsx` — read-only aggregate view.

**Modified files:**
- `prisma/schema.prisma` — `Location` model, `RevenueCenter.{locationId,type,targetCostPct}`, `UserScope` model + `User.scopes` relation.
- `src/lib/auth.ts` — re-export scope helpers / `requireSession` unchanged.
- `src/contexts/RevenueCenterContext.tsx` — carry locations + active-node kind (location vs RC).
- `src/app/api/revenue-centers/route.ts` and `[id]/route.ts` — accept `locationId`/`type`/`targetCostPct`, scope-filter GET.
- The RC-scoped GET/POST/PATCH route handlers (sales, count, inventory, recipes, invoices, prep, wastage) — fold scope into `where`, write-guard mutations.
- The cost-chrome / KPI / report label sites — read labels from `getVocab(type)`.
- `src/components/layout/*` selector (the `useRc()` consumer) — two-tier picker.

---

## Phase 1 — Schema & migration (inert; nothing reads it yet)

### Task 1: Add `Location`, RC columns, and `UserScope` to the schema

**Files:**
- Modify: `prisma/schema.prisma:547-579` (RevenueCenter) and the `User` model (~`:25-34`)
- Create: `prisma/migrations/<timestamp>_location_hierarchy/migration.sql`

- [ ] **Step 1: Add the `Location` model** to `prisma/schema.prisma` (place above `RevenueCenter`):

```prisma
model Location {
  id              String          @id @default(cuid())
  name            String
  color           String
  type            String          @default("restaurant") // restaurant | catering | other
  isDefault       Boolean         @default(false)        // primary business (distinct from RevenueCenter.isDefault)
  description     String?
  isActive        Boolean         @default(true)
  managerName     String?
  notes           String?
  schedulingMode  String          @default("FIXED")
  prepLeadMinutes Int?
  serviceSchedule Json?
  createdAt       DateTime        @default(now())
  revenueCenters  RevenueCenter[]
  userScopes      UserScope[]
}
```

- [ ] **Step 2: Add columns to `RevenueCenter`** (keep all existing fields/relations):

```prisma
  // --- hierarchy additions ---
  locationId    String?   // NOT NULL after backfill; nullable for the expand-contract migration
  location      Location? @relation(fields: [locationId], references: [id])
  type          String    @default("FOOD")  // FOOD | DRINK — drives vocabulary + cost language
  targetCostPct Decimal?                     // per-RC target (food ~28%, pour ~18%)
  userScopes    UserScope[]
```

- [ ] **Step 3: Add the `UserScope` model and `User.scopes` relation:**

```prisma
model UserScope {
  id              String         @id @default(cuid())
  userId          String
  locationId      String?
  revenueCenterId String?
  createdAt       DateTime       @default(now())
  user            User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  location        Location?      @relation(fields: [locationId], references: [id], onDelete: Cascade)
  revenueCenter   RevenueCenter? @relation(fields: [revenueCenterId], references: [id], onDelete: Cascade)

  @@unique([userId, locationId, revenueCenterId])
  @@index([userId])
}
```
Add to `model User`: `scopes UserScope[]`.

- [ ] **Step 4: Generate the migration SQL** (review only — do not let Prisma apply):

Run: `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > /tmp/loc-mig.sql`
Expected: SQL creating `Location`, `UserScope`, and `ALTER TABLE "RevenueCenter" ADD COLUMN "locationId"/"type"/"targetCostPct"`. Confirm `locationId` is nullable and `type` defaults to `'FOOD'`.

- [ ] **Step 5: Apply the DDL over the pooler.** Write a one-off script `scripts/apply-location-ddl.ts` that runs each statement from `/tmp/loc-mig.sql` via `prisma.$executeRawUnsafe(stmt)` (split on `;`, skip blanks). Run it with the project's node toolchain.
Expected: no error; `Location` and `UserScope` tables exist.

- [ ] **Step 6: Record the migration in history** so Prisma stays consistent:

```bash
mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_location_hierarchy
cp /tmp/loc-mig.sql prisma/migrations/*_location_hierarchy/migration.sql
npx prisma migrate resolve --applied $(ls prisma/migrations | grep location_hierarchy)
npx prisma generate
```

- [ ] **Step 7: Verify build.** Stop the dev server, then run `npm run build`.
Expected: `✓ Compiled successfully` (the new Prisma client types resolve).

- [ ] **Step 8: Commit.**
```bash
git add prisma/schema.prisma prisma/migrations scripts/apply-location-ddl.ts
git commit -m "feat(rc): add Location + RevenueCenter hierarchy columns + UserScope (schema)"
```

### Task 2: Auto-wrap backfill — one Location per existing RC

**Files:**
- Create: `scripts/backfill-locations.ts`

- [ ] **Step 1: Write the backfill script.** For each existing `RevenueCenter`: create a `Location` with the same `name`/`color`, copy `type`(→`restaurant`/`catering`/`other` as-is for the location), `isDefault`, `managerName`, `notes`, `description`, `schedulingMode`, `prepLeadMinutes`, `serviceSchedule`; then set the RC's `locationId` to it, set RC `type` to `'FOOD'`, and copy `targetFoodCostPct` → `targetCostPct`. Wrap in a `$transaction`. Mark the Location whose RC was the default-stock-pool RC as `Location.isDefault = true`.

```ts
// scripts/backfill-locations.ts
import { prisma } from '@/lib/prisma'

async function main() {
  const rcs = await prisma.revenueCenter.findMany()
  for (const rc of rcs) {
    if (rc.locationId) continue // idempotent
    await prisma.$transaction(async (tx) => {
      const loc = await tx.location.create({
        data: {
          name: rc.name,
          color: rc.color,
          type: ['restaurant','catering','other'].includes(rc.type) ? rc.type : 'restaurant',
          isDefault: rc.isDefault,            // primary business mirrors the default stock-pool RC
          managerName: rc.managerName,
          notes: rc.notes,
          description: rc.description,
          schedulingMode: rc.schedulingMode,
          prepLeadMinutes: rc.prepLeadMinutes,
          serviceSchedule: rc.serviceSchedule ?? undefined,
        },
      })
      await tx.revenueCenter.update({
        where: { id: rc.id },
        data: { locationId: loc.id, type: 'FOOD', targetCostPct: rc.targetFoodCostPct ?? undefined },
      })
    })
    console.log(`wrapped RC ${rc.name} → Location`)
  }
}
main().then(() => process.exit(0))
```

- [ ] **Step 2: Run it** with the project node toolchain. Expected: one log line per RC, no errors.

- [ ] **Step 3: Verify in data.** `npx prisma studio` (or a quick query script): every `RevenueCenter.locationId` is non-null; exactly one `Location.isDefault = true`; RC count == Location count.

- [ ] **Step 4: Tighten `locationId` to NOT NULL.** Edit schema (`locationId String` + `location Location @relation(...)`), regenerate the diff for just this change, apply `ALTER TABLE "RevenueCenter" ALTER COLUMN "locationId" SET NOT NULL;` via `$executeRawUnsafe`, append to migration history, `npx prisma generate`.

- [ ] **Step 5: Verify build** (`npm run build`) → `✓ Compiled successfully`.

- [ ] **Step 6: Commit.**
```bash
git add scripts/backfill-locations.ts prisma/schema.prisma prisma/migrations
git commit -m "feat(rc): backfill one Location per RevenueCenter; locationId NOT NULL"
```

---

## Phase 2 — Scope resolver (inert until routes use it)

### Task 3: Build the scope resolver

**Files:**
- Create: `src/lib/rc-scope.ts`

- [ ] **Step 1: Write the resolver.** ADMIN or no-scope ⇒ all RC ids (backward-compatible, narrows only). Location scope ⇒ its child RC ids. RC scope ⇒ those ids.

```ts
// src/lib/rc-scope.ts
import 'server-only'
import { prisma } from '@/lib/prisma'
import { User } from '@prisma/client'

const SENTINEL_ALL = null // null = "no restriction" (see callers)

/** Returns the set of leaf RevenueCenter ids the user may read/write, or null = ALL (no restriction). */
export async function resolveScopedRcIds(user: User): Promise<Set<string> | null> {
  if (user.role === 'ADMIN') return SENTINEL_ALL
  const scopes = await prisma.userScope.findMany({ where: { userId: user.id } })
  if (scopes.length === 0) return SENTINEL_ALL // backward compatible: unassigned = see all
  const ids = new Set<string>()
  const locationIds = scopes.map(s => s.locationId).filter(Boolean) as string[]
  if (locationIds.length) {
    const rcs = await prisma.revenueCenter.findMany({
      where: { locationId: { in: locationIds } }, select: { id: true },
    })
    rcs.forEach(rc => ids.add(rc.id))
  }
  scopes.map(s => s.revenueCenterId).filter(Boolean).forEach(id => ids.add(id as string))
  return ids
}

/** Throws nothing — returns true if rcId is allowed for this user. */
export async function isRcInScope(user: User, rcId: string): Promise<boolean> {
  const allowed = await resolveScopedRcIds(user)
  return allowed === null || allowed.has(rcId)
}
```

- [ ] **Step 2: Add a `where`-builder** that merges an explicit `rcId` request with the user's scope, preserving the existing default-RC null-OR pattern:

```ts
/**
 * Produces the Prisma `where.revenueCenterId` fragment for an RC-scoped list query.
 * Mirrors the existing app pattern (default RC also shows null rows) and intersects with scope.
 */
export function scopedRcWhere(
  allowed: Set<string> | null,
  rcId: string | null,
  isDefault: boolean,
): Record<string, unknown> {
  if (rcId && isDefault) {
    // default RC: its rows + shared (null) rows, still intersected with scope below
    const base: Record<string, unknown> = { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
    return allowed === null ? base : { AND: [base, { revenueCenterId: { in: [...allowed, rcId] } }] }
  }
  if (rcId) {
    return { revenueCenterId: rcId }
  }
  // no explicit RC → all in scope
  return allowed === null ? {} : { revenueCenterId: { in: [...allowed] } }
}
```

- [ ] **Step 3: Verify build** (`npm run build`) → `✓ Compiled successfully` (module compiles; not yet imported anywhere).

- [ ] **Step 4: Commit.**
```bash
git add src/lib/rc-scope.ts
git commit -m "feat(rc): scope resolver (user → allowed leaf RC ids) + scoped where-builder"
```

### Task 4: Add a write-guard helper and apply it to one route as the reference pattern

**Files:**
- Modify: `src/lib/rc-scope.ts` (add `assertRcWritable`)
- Modify: `src/app/api/wastage/route.ts` (smallest mutating RC route — reference impl)

- [ ] **Step 1: Add the write-guard** to `rc-scope.ts`:

```ts
import { AuthError } from '@/lib/auth'
/** Throws AuthError(403) if the user may not write to rcId; rejects location-targeted writes. */
export async function assertRcWritable(user: User, rcId: string | null | undefined) {
  if (!rcId) throw new AuthError(403, 'A revenue center must be selected (writes cannot target a location).')
  if (!(await isRcInScope(user, rcId))) throw new AuthError(403, 'Revenue center is outside your access.')
}
```
(Move `AuthError` import order so there's no cycle — `rc-scope.ts` importing from `auth.ts` is fine; ensure `auth.ts` does NOT import `rc-scope.ts` to avoid a cycle. If a re-export is desired, re-export from `auth.ts` after definition.)

- [ ] **Step 2: Apply to wastage POST.** In `src/app/api/wastage/route.ts` POST, after `requireSession`, add `await assertRcWritable(user, body.revenueCenterId)` and wrap with the existing `AuthError` catch pattern. In wastage GET, resolve `allowed = await resolveScopedRcIds(user)` and apply `scopedRcWhere(allowed, rcId, isDefault)`.

- [ ] **Step 3: Verify build** (`npm run build`) → `✓ Compiled successfully`.

- [ ] **Step 4: Verify behavior in preview.** Start preview, log in (or DEV_AUTH_BYPASS). With no UserScope rows, wastage list + create still work for the default RC (backward compatible). Confirm `preview_console_logs`/`preview_network` show 200s.

- [ ] **Step 5: Commit.**
```bash
git add src/lib/rc-scope.ts src/app/api/wastage/route.ts
git commit -m "feat(rc): write-guard helper + apply scope to wastage route (reference pattern)"
```

### Task 5: Roll the scope pattern across remaining RC-scoped routes

**Files (apply the Task 4 pattern to each):**
- Modify: `src/app/api/sales/route.ts`, `src/app/api/count/sessions/route.ts`, `src/app/api/inventory/route.ts`, `src/app/api/recipes/route.ts`, `src/app/api/invoices/sessions/route.ts`, `src/app/api/prep/items/route.ts`, and the invoice-approve route `src/app/api/invoices/sessions/[id]/approve/route.ts`.

- [ ] **Step 1: For each GET** that filters by `rcId`, replace the inline `where.revenueCenterId` construction with `scopedRcWhere(await resolveScopedRcIds(user), rcId, isDefault)`. (Each route already computes `rcId`/`isDefault` from query params — keep that.)

- [ ] **Step 2: For each mutating handler** (POST/PATCH/approve) that writes a `revenueCenterId`, call `await assertRcWritable(user, targetRcId)` before the write. For invoice approve (which can fan out via `rcSplit`), assert every distinct rc id in the split.

- [ ] **Step 3: Verify build** (`npm run build`) → `✓ Compiled successfully`.

- [ ] **Step 4: Verify in preview.** With no scopes set, every page (sales/count/inventory/menu/invoices/prep) still loads and writes succeed (backward compatible). Spot-check `preview_network` for 200s on each page load.

- [ ] **Step 5: Commit.**
```bash
git add src/app/api
git commit -m "feat(rc): apply scope filter + write-guard across all RC-scoped routes"
```

---

## Phase 3 — Locations API, two-tier selector, read-only dashboard

### Task 6: Locations CRUD API

**Files:**
- Create: `src/app/api/locations/route.ts`, `src/app/api/locations/[id]/route.ts`

- [ ] **Step 1: GET `/api/locations`** — list locations the user is scoped to, each with nested `revenueCenters` (id, name, color, type, isActive, targetCostPct). ADMIN/no-scope sees all. `export const dynamic = 'force-dynamic'`.

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveScopedRcIds } from '@/lib/rc-scope'
export const dynamic = 'force-dynamic'

export async function GET() {
  let user; try { user = await requireSession() }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e }
  const allowed = await resolveScopedRcIds(user)
  const locations = await prisma.location.findMany({
    orderBy: { createdAt: 'asc' },
    include: { revenueCenters: { orderBy: { createdAt: 'asc' } } },
  })
  const filtered = allowed === null
    ? locations
    : locations
        .map(l => ({ ...l, revenueCenters: l.revenueCenters.filter(rc => allowed.has(rc.id)) }))
        .filter(l => l.revenueCenters.length > 0)
  return NextResponse.json(filtered)
}
```

- [ ] **Step 2: POST `/api/locations`** (ADMIN) — create a location (validate `name`; resolve color/type; `isDefault` exclusivity transaction like the RC route at `src/app/api/revenue-centers/route.ts:36-39`).

- [ ] **Step 3: `[id]` GET/PATCH/DELETE** (ADMIN for mutate). DELETE blocked if the location has any revenue center (mirror the "cannot delete default / data-linked blocks" pattern in `src/app/api/revenue-centers/[id]/route.ts`). Cannot delete `isDefault` location.

- [ ] **Step 4: Verify build** → `✓ Compiled successfully`. Confirm routes show `ƒ (Dynamic)` in build output (not `○ Static`).

- [ ] **Step 5: Commit.**
```bash
git add src/app/api/locations
git commit -m "feat(rc): locations CRUD API (scoped GET, ADMIN mutate)"
```

### Task 7: Revenue-centers API gains `locationId`/`type`/`targetCostPct` + scoped list

**Files:**
- Modify: `src/app/api/revenue-centers/route.ts`, `src/app/api/revenue-centers/[id]/route.ts`

- [ ] **Step 1: POST/PATCH** — accept and persist `locationId` (required on create), `type` (validate against `['FOOD','DRINK']`, default `FOOD`), `targetCostPct` (parseFloat or null). Keep `targetFoodCostPct` accepted as a deprecated alias mapping to `targetCostPct` for one release.

- [ ] **Step 2: GET** — filter to RCs in scope (`resolveScopedRcIds`), include `locationId`/`type`/`targetCostPct` in the response. Keep the "seed a default RC if none" behaviour but also seed/attach a default Location when bootstrapping an empty DB.

- [ ] **Step 3: Verify build** → `✓ Compiled successfully`.

- [ ] **Step 4: Commit.**
```bash
git add src/app/api/revenue-centers
git commit -m "feat(rc): RC API accepts locationId/type/targetCostPct + scoped list"
```

### Task 8: Two-tier selector context

**Files:**
- Modify: `src/contexts/RevenueCenterContext.tsx`

- [ ] **Step 1: Extend the context** to load locations (with nested RCs) and track the active node's *kind*. Add to the interface: `locations: Location[]`, `activeKind: 'location' | 'rc' | 'all'`, `activeLocationId: string | null`, `setActiveLocation(id)`, `setActiveRc(id)`. Keep `activeRcId`/`activeRc` for existing consumers (null when a location is active). Persist `{kind,id}` to localStorage (migrate the old `activeRcId` string on first load).

```ts
export interface Location {
  id: string; name: string; color: string; type: string; isDefault: boolean
  revenueCenters: RevenueCenter[]
}
```

- [ ] **Step 2: Derivation rules.** When `activeKind === 'rc'`, `activeRcId` = that RC. When `'location'` or `'all'`, `activeRcId = null` (so existing list pages fetch the aggregate / read-only). Expose `isReadOnly = activeKind !== 'rc'` for the UI write-gate.

- [ ] **Step 3: Verify build** → `✓ Compiled successfully` (existing `useRc()` consumers still compile because `activeRcId`/`activeRc` remain).

- [ ] **Step 4: Verify in preview.** App loads; selector data present in `preview_eval` of context (or visible once Task 9 lands). No console errors.

- [ ] **Step 5: Commit.**
```bash
git add src/contexts/RevenueCenterContext.tsx
git commit -m "feat(rc): two-tier selector context (locations + active node kind)"
```

### Task 9: Two-tier picker UI + write-affordance gating

**Files:**
- Modify: the selector component(s) consuming `useRc()` (desktop nav + `MobileRcBar`, under `src/components/layout/`)

- [ ] **Step 1: Render locations as expandable group headers** with their child RCs beneath; keep "All". Picking a location → `setActiveLocation`; picking an RC → `setActiveRc`. Show RC `type` with a small FOOD/DRINK affordance (color or icon).

- [ ] **Step 2: Gate write affordances.** Where pages render add/import/edit buttons, read `isReadOnly` from `useRc()` and hide/disable them with a tooltip "Select a revenue center to make changes." (Inventory add, Sales import, Prep add, Count start, Invoice approve.)

- [ ] **Step 3: Verify in preview.** Selecting a Location hides write buttons and shows read-only lists; selecting an RC restores them. Capture a `preview_screenshot` of both states.

- [ ] **Step 4: Commit.**
```bash
git add src/components/layout src/app
git commit -m "feat(rc): two-tier picker UI + read-only gating at location level"
```

### Task 10: Location read-only dashboard

**Files:**
- Create: `src/app/api/insights/location-dashboard/route.ts`, `src/components/locations/LocationDashboard.tsx`
- Modify: the page shell that renders when `activeKind === 'location'`

- [ ] **Step 1: Aggregation endpoint** `GET /api/insights/location-dashboard?locationId=…&from=…&to=…`. For the location's in-scope child RCs, return per-RC `{ id, name, type, sales, cogs, costPct, targetCostPct }` plus a revenue-weighted blended `costPct` and total sales. Reuse the existing cost-chrome / theoretical-cost helpers per RC (read the spine; do not compute a parallel price). `export const dynamic = 'force-dynamic'`.

- [ ] **Step 2: Dashboard component** renders the per-RC breakdown (each line labeled with its type vocab from Task 11 — e.g. "Food cost % · Kitchen", "Pour cost % · Bar") and the blended total. No editable controls.

- [ ] **Step 3: Wire it in** so selecting a location shows `LocationDashboard` instead of the operational grids.

- [ ] **Step 4: Verify in preview.** Select the Cafe location (after a manual split, or with the single wrapped RC): dashboard shows per-RC lines + blend, no write controls. `preview_screenshot`.

- [ ] **Step 5: Commit.**
```bash
git add src/app/api/insights/location-dashboard src/components/locations src/app
git commit -m "feat(rc): read-only Location dashboard (per-RC breakdown + blended COGS)"
```

---

## Phase 4 — Type-driven vocabulary

### Task 11: Vocabulary map + relabel cost surfaces

**Files:**
- Create: `src/lib/rc-vocab.ts`
- Modify: cost-chrome strip, KPI cards (Pass/Sales/Reports), report tab titles, recipe/menu headings

- [ ] **Step 1: Write the vocab map.**

```ts
// src/lib/rc-vocab.ts
export type VocabType = 'FOOD' | 'DRINK'
interface Vocab {
  costPctLabel: string; targetLabel: string; build: string; menu: string; inputs: string
}
const VOCAB: Record<VocabType, Vocab> = {
  FOOD:  { costPctLabel: 'Food cost %',  targetLabel: 'Target food cost %',  build: 'Recipe',   menu: 'Menu',      inputs: 'Ingredients' },
  DRINK: { costPctLabel: 'Pour cost %',  targetLabel: 'Target pour cost %',  build: 'Cocktail', menu: 'Drink menu', inputs: 'Pours' },
}
export function getVocab(type: string | null | undefined): Vocab {
  return VOCAB[(type as VocabType)] ?? VOCAB.FOOD
}
```

- [ ] **Step 2: Cost-chrome strip** (`src/components/layout/` cost-chrome + `/api/insights/cost-chrome`) — when an RC is active, label the cost-% figure from `getVocab(activeRc.type).costPctLabel`. When a location/all is active, use the generic "COGS %". Math unchanged (still reads `pricePerBaseUnit`).

- [ ] **Step 3: KPI cards & report tab titles** — replace hardcoded "Food cost %" with `getVocab(type).costPctLabel`; "Target food cost %" with `.targetLabel`; menu/recipe headings with `.menu`/`.build` where an RC type is in context.

- [ ] **Step 4: Wire per-RC `targetCostPct`** into the cost-chrome target (replace reads of `targetFoodCostPct`); location view shows the blended target from Task 10.

- [ ] **Step 5: Verify in preview.** Active RC of type DRINK shows "Pour cost %" everywhere; FOOD shows "Food cost %"; numbers identical to before. `preview_screenshot` of both.

- [ ] **Step 6: Commit.**
```bash
git add src/lib/rc-vocab.ts src/components src/app
git commit -m "feat(rc): type-driven cost vocabulary (food cost % ↔ pour cost %)"
```

---

## Phase 5 — Settings UI (manage locations, RCs, assignments)

### Task 12: User-scope assignment API

**Files:**
- Create: `src/app/api/settings/user-scopes/route.ts`

- [ ] **Step 1: GET `?userId=`** (ADMIN) returns that user's `UserScope` rows. **PUT** replaces a user's scope set transactionally (`deleteMany` then `createMany`), validating each row targets exactly one of `locationId`/`revenueCenterId`. `export const dynamic = 'force-dynamic'`. Guard with `requireSession('ADMIN')`.

- [ ] **Step 2: Verify build** → `✓ Compiled successfully`; route shows `ƒ (Dynamic)`.

- [ ] **Step 3: Commit.**
```bash
git add src/app/api/settings/user-scopes
git commit -m "feat(rc): user-scope assignment API (ADMIN)"
```

### Task 13: Settings UI for locations / RCs / assignments

**Files:**
- Modify: `src/app/setup/revenue-centers/page.tsx` (or a new `src/app/settings/locations/page.tsx` following the existing setup page pattern)
- Modify: the users settings page to add a per-user scope editor

- [ ] **Step 1: Locations & RCs editor** — list locations, create/rename, set type/`isDefault`; under each location, manage its RCs (create/rename, set `type` FOOD/DRINK, `targetCostPct`). Reuse the existing setup-page form patterns and `RC_COLORS`.

- [ ] **Step 2: Per-user scope editor** — in the users settings page, for each user a control to assign location(s) and/or RC(s); save via the Task 12 PUT. Show the effective resolved RC set as a preview.

- [ ] **Step 3: Verify in preview.** Create a "Bar" RC (DRINK) under the Cafe location; assign a STAFF user to Bar only; (with that user, or via DEV bypass simulation) confirm they see only Bar and cannot write to Kitchen. `preview_screenshot`.

- [ ] **Step 4: Commit.**
```bash
git add src/app
git commit -m "feat(rc): settings UI for locations, RC types/targets, and user scopes"
```

### Task 14: End-to-end verification of the motivating bug

- [ ] **Step 1:** Split the Cafe location: rename wrapped RC → "Kitchen" (FOOD); add "Bar" (DRINK, target ~18%). Route a Toast `menu:BAR` sentinel → Bar (existing `ToastRevenueCenterMap` mechanism in `src/lib/toast/sales-sync.ts`).
- [ ] **Step 2:** Trigger a sales sync (or manual entry) with both food and drink lines.
- [ ] **Step 3:** Select the **Cafe location** → dashboard shows **Food cost % (Kitchen)** and **Pour cost % (Bar)** as separate lines + blended COGS — no "100% food". Select **Bar** → app says "Pour cost %", not "Food cost %". `preview_screenshot` as proof.
- [ ] **Step 4: Final build** (`npm run build`) → `✓ Compiled successfully`. Commit any fixes.

---

## Self-review notes (author)

- **Spec coverage:** hierarchy (Task 1–2), zero-data-move auto-wrap (Task 2), scope resolver + read/write enforcement (Task 3–5), Location read-only lens + RC write boundary (Task 4 guard, Task 9 UI gate, Task 10 dashboard), two-tier selector (Task 8–9), type vocabulary + per-RC target (Task 11), Toast routing reuse (Task 14), settings/assignments (Task 12–13). All spec sections map to a task.
- **Two `isDefault`** kept distinct (Location vs RC) — Task 1 comments, Task 2 mapping.
- **No new test runner** introduced — verification is `npm run build` + preview, per repo reality.
- **Phasing:** Phases 1–2 are inert (safe to ship behind no UI). Each task ends green and committed.
- **Open items deferred to execution:** blended-COGS weighting confirmed revenue-weighted (Task 10); "labor" omitted from the dashboard (no data source) per spec.
```
