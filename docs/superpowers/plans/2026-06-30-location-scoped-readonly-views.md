# Location-Scoped Read-Only Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make selecting a Location a read-only *lens worn across the whole app* (every page filters to that location's revenue centers, writes disabled) instead of forcibly redirecting to a single dedicated `/location` dashboard.

**Architecture:** Add one server helper (`scopeWhereFromParams` / `resolveLocationRcIds` in `src/lib/rc-scope.ts`) that expands a `?locationId` query param into "all active child RCs of the location, intersected with the caller's scope," and one client helper (`setScopeParams` in `src/lib/scope-params.ts`) that writes the active scope (`rcId` | `locationId` | nothing) onto a fetch's query string. Every page swaps its hand-rolled `rcId` param block for `setScopeParams`; every list API route swaps its hand-rolled RC filter for the location-aware builder. The forced `router.push('/location')` is removed, the standalone `/location` page is retired, and its blended-COGS summary is folded into the `/reports` page as a location overview.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL · React Context (`RevenueCenterContext`) · Tailwind.

> **Testing note:** This repo has **no test suite** — `npm run build` is the only automated correctness check (per CLAUDE.md). Each task is verified by `npm run build` plus targeted manual checks in the dev server preview. There is no TDD red/green loop; "verify" steps run the build and exercise the behavior in-browser.

> **Scope model recap (do not break these invariants):**
> - `RevenueCenter.revenueCenterId` columns: **NULLABLE** on `CountSession`, `InvoiceSession`, `Recipe`, `RecipeCategory`, `TempUnit`. **NOT NULL** on `SalesEntry`, `WastageLog`, `PrepLog`, `PrepTask`. `InventoryItem` has **no** RC column (RC lives in `StockAllocation` / `ItemRevenueCenter`). `StockTransfer` uses `fromRcId`/`toRcId` (both NOT NULL).
> - For NULLABLE models, the default RC also surfaces shared `null` rows (`{ OR: [{revenueCenterId: rcId}, {revenueCenterId: null}] }`). For NOT NULL models a `null` union throws (Prisma validation → 500) — never emit it.
> - Writes always target a concrete leaf RC; Location/All remain read-only. `isReadOnly = activeKind !== 'rc'` is already wired through every page's write buttons — this plan does NOT change write gating.

---

## File Structure

**New files**
- `src/lib/scope-params.ts` — client helper `setScopeParams(params, scope)`. One responsibility: serialize active scope → query string.

**Modified — foundation**
- `src/lib/rc-scope.ts` — add `resolveLocationRcIds()` + `scopeWhereFromParams()`.

**Modified — navigation / retirement**
- `src/components/navigation/RcSelector.tsx` — drop `router.push('/location')`.
- `src/components/navigation/MobileRcBar.tsx` — drop `router.push('/location')`.
- `src/app/reports/page.tsx` — mount `LocationDashboard` as a location overview when `activeKind === 'location'`.

**Deleted**
- `src/app/location/page.tsx` — standalone location page retired.

**Modified — `scopedRcWhere` list routes** (swap to `scopeWhereFromParams`)
- `src/app/api/sales/route.ts`, `src/app/api/wastage/route.ts`, `src/app/api/count/sessions/route.ts`, `src/app/api/invoices/sessions/route.ts`, `src/app/api/recipes/route.ts`

**Modified — inline-filter list routes** (add `locationId` branch via `resolveLocationRcIds`)
- `src/app/api/invoices/kpis/route.ts`, `src/app/api/count/areas/route.ts`, `src/app/api/prep/tasks/route.ts`, `src/app/api/temps/units/route.ts`, `src/app/api/temps/readings/route.ts`, `src/app/api/recipes/categories/route.ts`, `src/app/api/stock-transfers/route.ts`, `src/app/api/inventory/route.ts`
- `src/app/api/reports/prep/route.ts`, `src/app/api/reports/dashboard/route.ts`, `src/app/api/reports/cogs/route.ts`, `src/app/api/reports/analytics/route.ts`, `src/app/api/insights/cost-chrome/route.ts`

**Modified — pages** (swap param block to `setScopeParams`, add deps)
- `src/app/sales/page.tsx`, `src/app/wastage/page.tsx`, `src/app/count/page.tsx`, `src/app/invoices/page.tsx`, `src/app/inventory/page.tsx`, `src/app/recipes/page.tsx`, `src/app/menu/page.tsx`, `src/app/reports/page.tsx`, `src/app/reports/tabs/CogsTab.tsx`, `src/app/reports/tabs/SalesTab.tsx`, `src/app/reports/tabs/PrepTab.tsx`, `src/app/reports/signals/page.tsx`

---

## Phase 1 — Foundation helpers

### Task 1: Server helper — `resolveLocationRcIds` + `scopeWhereFromParams`

**Files:**
- Modify: `src/lib/rc-scope.ts` (append after `scopedRcWhere`, before `assertRcWritable` at line 79)

- [ ] **Step 1: Add the two helpers**

Insert immediately after the closing `}` of `scopedRcWhere` (currently line 77) in `src/lib/rc-scope.ts`:

```typescript
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
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: build succeeds (no TS errors). `rc-scope.ts` already imports `prisma` (line 2) and `User` (line 3), so no new imports are needed.

- [ ] **Step 3: Commit**

```bash
git add src/lib/rc-scope.ts
git commit -m "feat(scope): add location-aware where builder (resolveLocationRcIds, scopeWhereFromParams)"
```

---

### Task 2: Client helper — `setScopeParams`

**Files:**
- Create: `src/lib/scope-params.ts`

- [ ] **Step 1: Create the file**

```typescript
/**
 * Writes the active scope onto a URLSearchParams for an API list fetch.
 *  - RC active       → ?rcId (+ ?isDefault for the default stock-pool RC)
 *  - Location active → ?locationId (server expands to the location's child RCs)
 *  - All active      → nothing (unscoped — unchanged behavior)
 *
 * Mirrors the server-side scopeWhereFromParams contract in src/lib/rc-scope.ts.
 */
export function setScopeParams(
  params: URLSearchParams,
  scope: {
    activeKind: 'all' | 'location' | 'rc'
    activeRcId: string | null
    activeRc: { isDefault?: boolean } | null
    activeLocationId: string | null
  },
): void {
  if (scope.activeKind === 'rc' && scope.activeRcId) {
    params.set('rcId', scope.activeRcId)
    if (scope.activeRc?.isDefault) params.set('isDefault', 'true')
  } else if (scope.activeKind === 'location' && scope.activeLocationId) {
    params.set('locationId', scope.activeLocationId)
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/lib/scope-params.ts
git commit -m "feat(scope): add client setScopeParams helper for rc/location query params"
```

---

## Phase 2 — Retire forced navigation & fold the location summary into Reports

### Task 3: Stop forcing navigation to `/location`

**Files:**
- Modify: `src/components/navigation/RcSelector.tsx:61`
- Modify: `src/components/navigation/MobileRcBar.tsx:17-18`

- [ ] **Step 1: RcSelector — drop the redirect**

In `src/components/navigation/RcSelector.tsx`, the `RcMenu` `onPickLocation` prop currently reads (line 61):

```typescript
      onPickLocation={(id) => { setActiveLocation(id); setOpen(false); router.push('/location') }}
```

Replace with (stay on the current page; location is now a lens):

```typescript
      onPickLocation={(id) => { setActiveLocation(id); setOpen(false) }}
```

`router` is still used elsewhere? Check: after this edit, `useRouter`/`router` may become unused in this file. If `npm run build` reports `router` is unused, remove the `const router = useRouter()` line (line ~32) and the `import { useRouter } from 'next/navigation'` line (line 4). If still used, leave them.

- [ ] **Step 2: MobileRcBar — drop the redirect**

In `src/components/navigation/MobileRcBar.tsx`, line 17-18 currently read:

```typescript
  // Picking a location shows its read-only aggregate dashboard.
  const pickLocation = (id: string) => { setActiveLocation(id); router.push('/location') }
```

Replace with:

```typescript
  // Picking a location applies a read-only location lens to the current page.
  const pickLocation = (id: string) => { setActiveLocation(id) }
```

Then, as in Step 1, if `npm run build` reports `router` / `useRouter` unused, remove `const router = useRouter()` and the `import { useRouter } from 'next/navigation'` (line 3).

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: succeeds. Fix any "declared but never read" errors for `router`/`useRouter` per Steps 1–2.

- [ ] **Step 4: Commit**

```bash
git add src/components/navigation/RcSelector.tsx src/components/navigation/MobileRcBar.tsx
git commit -m "feat(scope): selecting a location no longer redirects — stays on current page as a lens"
```

---

### Task 4: Fold the blended-COGS location summary into `/reports`

The `LocationDashboard` component and `/api/insights/location-dashboard` endpoint are kept; only their mounting point moves (from the deleted `/location` page into `/reports`).

**Files:**
- Modify: `src/app/reports/page.tsx` (destructure at line 45; render tree)

- [ ] **Step 1: Import LocationDashboard**

At the top of `src/app/reports/page.tsx`, add to the existing imports:

```typescript
import { LocationDashboard } from '@/components/locations/LocationDashboard'
```

- [ ] **Step 2: Pull `activeLocationId` from context**

The destructure at line 45 currently reads:

```typescript
  const { activeRcId, activeRc, activeKind } = useRc()
```

Replace with:

```typescript
  const { activeRcId, activeRc, activeKind, activeLocationId } = useRc()
```

- [ ] **Step 3: Render the location overview when a location is active**

Find the top of the page's returned JSX (the outermost wrapper that holds the report content). Immediately inside it — above the existing KPI/dashboard content — insert a location overview block:

```tsx
      {activeKind === 'location' && activeLocationId && (
        <div className="mb-6">
          <LocationDashboard locationId={activeLocationId} />
        </div>
      )}
```

This shows the per-RC cost cards + revenue-weighted blended COGS % as the manager's broad-scope business-health view, in-place on `/reports`, with the rest of the reports content below it scoped to the location (wired in Phase 4).

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app/reports/page.tsx
git commit -m "feat(reports): show location blended-COGS overview when a location is active"
```

---

### Task 5: Retire the standalone `/location` page

**Files:**
- Delete: `src/app/location/page.tsx`

- [ ] **Step 1: Delete the page**

```bash
git rm src/app/location/page.tsx
```

(The `LocationDashboard` component and `/api/insights/location-dashboard` route remain — they're now used by `/reports`.)

- [ ] **Step 2: Confirm no remaining references to the route**

Run: `grep -rn "'/location'\|\"/location\"\|push('/location')\|replace('/location')" src`
Expected: **no matches** (Tasks 3 removed the two pushes; nothing else links to `/location`).

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: succeeds; `/location` no longer appears in the route list.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(scope): retire standalone /location page (summary now lives in /reports)"
```

---

## Phase 3 — `scopedRcWhere` list routes → location-aware

Each route below already computes `allowed` and calls `scopedRcWhere(...)`. Swap that single call for `await scopeWhereFromParams(user, searchParams, { nullable })`. The `nullable` flag follows the model's RC column.

### Task 6: `/api/sales` GET (NOT NULL → nullable:false)

**Files:**
- Modify: `src/app/api/sales/route.ts:25-37`

- [ ] **Step 1: Add the import**

Ensure the top-of-file import from `@/lib/rc-scope` includes `scopeWhereFromParams`. It currently imports `resolveScopedRcIds, scopedRcWhere` (and possibly `assertRcWritable`). Add `scopeWhereFromParams`:

```typescript
import { resolveScopedRcIds, scopedRcWhere, scopeWhereFromParams, assertRcWritable } from '@/lib/rc-scope'
```
(Keep whatever subset the file already imports; just add `scopeWhereFromParams`. `resolveScopedRcIds` may become unused in GET — see Step 3.)

- [ ] **Step 2: Replace the filter call**

Lines 25-37 currently read:

```typescript
  const rcId      = searchParams.get('rcId')

  const allowed = await resolveScopedRcIds(user)

  const dateWhere: Record<string, unknown> = {}
  if (startDate) dateWhere.gte = new Date(startDate)
  if (endDate)   dateWhere.lte = new Date(endDate + 'T23:59:59.999Z')

  const sales = await prisma.salesEntry.findMany({
    where: {
      AND: [
        Object.keys(dateWhere).length ? { date: dateWhere } : {},
        scopedRcWhere(allowed, rcId, false),
```

Replace with:

```typescript
  const scopeWhere = await scopeWhereFromParams(user, searchParams, { nullable: false })

  const dateWhere: Record<string, unknown> = {}
  if (startDate) dateWhere.gte = new Date(startDate)
  if (endDate)   dateWhere.lte = new Date(endDate + 'T23:59:59.999Z')

  const sales = await prisma.salesEntry.findMany({
    where: {
      AND: [
        Object.keys(dateWhere).length ? { date: dateWhere } : {},
        scopeWhere,
```

(Delete the now-unused `const rcId = searchParams.get('rcId')` and `const allowed = ...` lines from the GET handler. Leave the POST handler untouched — it still uses `assertRcWritable`.)

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: succeeds. If `resolveScopedRcIds` / `scopedRcWhere` are no longer referenced anywhere in the file, drop them from the import to clear the unused warning.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sales/route.ts
git commit -m "feat(sales): location-aware scope filter on GET /api/sales"
```

---

### Task 7: `/api/wastage` GET (NOT NULL → nullable:false)

**Files:**
- Modify: `src/app/api/wastage/route.ts:21-32`

- [ ] **Step 1: Add import** — add `scopeWhereFromParams` to the `@/lib/rc-scope` import.

- [ ] **Step 2: Replace the filter**

Lines 21-32 currently read:

```typescript
  const rcId      = searchParams.get('rcId')

  const allowed = await resolveScopedRcIds(user)

  const logs = await prisma.wastageLog.findMany({
    where: {
      AND: [
        startDate ? { date: { gte: new Date(startDate) } } : {},
        endDate   ? { date: { lte: new Date(endDate) } }  : {},
        itemId    ? { inventoryItemId: itemId }            : {},
        reason    ? { reason }                             : {},
        scopedRcWhere(allowed, rcId, false),
```

Replace with:

```typescript
  const scopeWhere = await scopeWhereFromParams(user, searchParams, { nullable: false })

  const logs = await prisma.wastageLog.findMany({
    where: {
      AND: [
        startDate ? { date: { gte: new Date(startDate) } } : {},
        endDate   ? { date: { lte: new Date(endDate) } }  : {},
        itemId    ? { inventoryItemId: itemId }            : {},
        reason    ? { reason }                             : {},
        scopeWhere,
```

(Remove the now-unused `rcId` / `allowed` lines from GET.)

- [ ] **Step 3: Verify build** — `npm run build` succeeds; trim unused imports.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wastage/route.ts
git commit -m "feat(wastage): location-aware scope filter on GET /api/wastage"
```

---

### Task 8: `/api/count/sessions` GET (NULLABLE → nullable:true)

**Files:**
- Modify: `src/app/api/count/sessions/route.ts:18-27`

- [ ] **Step 1: Add import** — add `scopeWhereFromParams` to the `@/lib/rc-scope` import.

- [ ] **Step 2: Replace the filter**

Lines 18-27 currently read:

```typescript
  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'

  const allowed = await resolveScopedRcIds(user)

  const sessions = await prisma.countSession.findMany({
    where: {
      AND: [
        { type: { not: 'QUICK' } },
        scopedRcWhere(allowed, rcId, isDefault),
```

Replace with:

```typescript
  const scopeWhere = await scopeWhereFromParams(user, searchParams, { nullable: true })

  const sessions = await prisma.countSession.findMany({
    where: {
      AND: [
        { type: { not: 'QUICK' } },
        scopeWhere,
```

(Remove the now-unused `rcId` / `isDefault` / `allowed` lines from GET. Leave POST untouched.)

- [ ] **Step 3: Verify build** — `npm run build` succeeds; trim unused imports.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/count/sessions/route.ts
git commit -m "feat(count): location-aware scope filter on GET /api/count/sessions"
```

---

### Task 9: `/api/invoices/sessions` GET (NULLABLE → nullable:true)

**Files:**
- Modify: `src/app/api/invoices/sessions/route.ts:16-20`

- [ ] **Step 1: Add import** — add `scopeWhereFromParams` to the `@/lib/rc-scope` import.

- [ ] **Step 2: Replace the filter**

Lines 16-20 currently read:

```typescript
  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'

  const allowed = await resolveScopedRcIds(user)
  const scopeWhere = scopedRcWhere(allowed, rcId, isDefault)
```

Replace with:

```typescript
  const scopeWhere = await scopeWhereFromParams(user, searchParams, { nullable: true })
```

(The existing `scopeWhere` variable is reused downstream unchanged. Remove the now-unused `rcId` / `isDefault` / `allowed` if they aren't referenced later in GET — verify via the build.)

- [ ] **Step 3: Verify build** — `npm run build` succeeds; trim unused imports.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/invoices/sessions/route.ts
git commit -m "feat(invoices): location-aware scope filter on GET /api/invoices/sessions"
```

---

### Task 10: `/api/recipes` GET (conditional — MENU not-null, PREP nullable)

This route branches by recipe `type`. Keep the branch shape; add a `locationId` path.

**Files:**
- Modify: `src/app/api/recipes/route.ts:23-38`

- [ ] **Step 1: Add import** — add `resolveLocationRcIds` to the `@/lib/rc-scope` import (keep `resolveScopedRcIds`, `scopedRcWhere`).

- [ ] **Step 2: Replace the rcFilter block**

Lines 23-38 currently read:

```typescript
  const rcId = searchParams.get('rcId') || ''

  const allowed = await resolveScopedRcIds(user)

  let rcFilter: Record<string, unknown>
  if (type === 'MENU') {
    rcFilter = scopedRcWhere(allowed, rcId || null, false)
  } else if (type === 'PREP') {
    rcFilter = rcId
      ? scopedRcWhere(allowed, rcId, true)
      : (allowed === null
          ? {}
          : { OR: [{ revenueCenterId: null }, { revenueCenterId: { in: [...allowed] } }] })
  } else {
    rcFilter = scopedRcWhere(allowed, rcId || null, false)
  }
```

Replace with:

```typescript
  const rcId = searchParams.get('rcId') || ''
  const locationId = searchParams.get('locationId')

  const allowed = await resolveScopedRcIds(user)

  let rcFilter: Record<string, unknown>
  if (locationId) {
    // Location lens: every active child RC of the location, intersected with scope.
    // PREP also surfaces shared (null) recipes; MENU is strict per-RC.
    const ids = await resolveLocationRcIds(user, locationId)
    const base = { revenueCenterId: { in: ids } }
    rcFilter = type === 'PREP' ? { OR: [base, { revenueCenterId: null }] } : base
  } else if (type === 'MENU') {
    rcFilter = scopedRcWhere(allowed, rcId || null, false)
  } else if (type === 'PREP') {
    rcFilter = rcId
      ? scopedRcWhere(allowed, rcId, true)
      : (allowed === null
          ? {}
          : { OR: [{ revenueCenterId: null }, { revenueCenterId: { in: [...allowed] } }] })
  } else {
    rcFilter = scopedRcWhere(allowed, rcId || null, false)
  }
```

- [ ] **Step 3: Verify build** — `npm run build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/recipes/route.ts
git commit -m "feat(recipes): location-aware rc filter on GET /api/recipes (MENU strict, PREP +shared)"
```

---

## Phase 4 — Reports & insights inline routes → location-aware

These build RC filters inline (no `scopedRcWhere`). Add a `locationId` branch using `resolveLocationRcIds`. Pattern: read `locationId`, resolve `locRcIds` once, and make each per-model filter prefer the location set when present.

### Task 11: `/api/reports/dashboard` GET

**Files:**
- Modify: `src/app/api/reports/dashboard/route.ts:16-55`

- [ ] **Step 1: Add import** — `import { resolveLocationRcIds } from '@/lib/rc-scope'` (add if not present; the route already requires a session).

- [ ] **Step 2: Resolve the location RC set near the top**

After line 17 (`const isDefault = searchParams.get('isDefault') === 'true'`), add:

```typescript
  const locationId = searchParams.get('locationId')
  const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null
```

(If the handler's session variable is not named `user`, match the existing name — most routes use `const user = await requireSession()`. If this route doesn't yet resolve a user, add `const user = await requireSession()` at the top, matching sibling routes.)

- [ ] **Step 3: Make the rcFilter location-aware**

Line 55 currently reads:

```typescript
  const rcFilter = rcId ? { revenueCenterId: rcId } : {}
```

Replace with:

```typescript
  const rcFilter = locRcIds
    ? { revenueCenterId: { in: locRcIds } }
    : rcId ? { revenueCenterId: rcId } : {}
```

If any other RC-scoped where-fragment exists below line 55 (e.g. for invoice sessions / counts), apply the same `locRcIds ? { revenueCenterId: { in: locRcIds } } : <existing>` wrapper, adding `{ revenueCenterId: null }` to the `in` via `{ OR: [...] }` ONLY for NULLABLE models (InvoiceSession, CountSession).

- [ ] **Step 4: Verify build** — `npm run build` succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/reports/dashboard/route.ts
git commit -m "feat(reports): location-aware dashboard aggregation"
```

---

### Task 12: `/api/reports/analytics` GET

**Files:**
- Modify: `src/app/api/reports/analytics/route.ts:63-74`

- [ ] **Step 1: Add import** — `resolveLocationRcIds` from `@/lib/rc-scope`.

- [ ] **Step 2: Resolve the location RC set and build the ctx filters from it**

Lines 63-74 currently read:

```typescript
  const rcId      = searchParams.get('rcId') || null
  const isDefault = searchParams.get('isDefault') === 'true'

  const ctx: Ctx = {
    since, until, days,
    win:     { gte: since, lte: until },
    prevWin: { gte: prevSince, lt: since },
    rcId, isDefault,
    rcEq:      rcId ? { revenueCenterId: rcId } : {},
    sessionRc: rcId ? (isDefault ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] } : { revenueCenterId: rcId }) : {},
    countRc:   rcId && !isDefault ? { revenueCenterId: rcId } : { revenueCenterId: null },
  }
```

Replace with:

```typescript
  const rcId      = searchParams.get('rcId') || null
  const isDefault = searchParams.get('isDefault') === 'true'
  const locationId = searchParams.get('locationId')
  const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null

  const ctx: Ctx = locRcIds
    ? {
        since, until, days,
        win:     { gte: since, lte: until },
        prevWin: { gte: prevSince, lt: since },
        rcId: null, isDefault: false,
        // Location lens: aggregate across all child RCs. NOT NULL models use a
        // plain `in`; NULLABLE models (sessions) also surface shared null rows.
        rcEq:      { revenueCenterId: { in: locRcIds } },
        sessionRc: { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] },
        countRc:   { revenueCenterId: { in: locRcIds } },
      }
    : {
        since, until, days,
        win:     { gte: since, lte: until },
        prevWin: { gte: prevSince, lt: since },
        rcId, isDefault,
        rcEq:      rcId ? { revenueCenterId: rcId } : {},
        sessionRc: rcId ? (isDefault ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] } : { revenueCenterId: rcId }) : {},
        countRc:   rcId && !isDefault ? { revenueCenterId: rcId } : { revenueCenterId: null },
      }
```

(Match the existing session variable name — if it's not `user`, use the route's actual name.)

- [ ] **Step 3: Verify build** — `npm run build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/reports/analytics/route.ts
git commit -m "feat(reports): location-aware analytics ctx filters"
```

---

### Task 13: `/api/reports/cogs` GET

**Files:**
- Modify: `src/app/api/reports/cogs/route.ts:76-77` and the `rcWhere`/`periodPurchases` usage downstream.

- [ ] **Step 1: Add import** — `resolveLocationRcIds` from `@/lib/rc-scope`.

- [ ] **Step 2: Resolve and apply**

After line 77 (`const isDefault = searchParams.get('isDefault') === 'true'`), add:

```typescript
  const locationId = searchParams.get('locationId')
  const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null
```

Then locate where this route builds its sales filter and its purchases filter (the `rcId`/`isDefault` consumers — e.g. a `salesWhere` and the `periodPurchases(...)` / invoice-session where). For each, prefer the location set:
- **Sales (NOT NULL):** `locRcIds ? { revenueCenterId: { in: locRcIds } } : <existing rcId filter>`
- **Purchases / InvoiceSession (NULLABLE):** `locRcIds ? { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] } : <existing rcId/isDefault filter>`

Read the surrounding code to apply the wrapper at each RC-filter site (there are two: sales and purchases).

- [ ] **Step 3: Verify build** — `npm run build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/reports/cogs/route.ts
git commit -m "feat(reports): location-aware COGS aggregation"
```

---

### Task 14: `/api/reports/prep` GET (PrepLog NOT NULL)

**Files:**
- Modify: `src/app/api/reports/prep/route.ts:8-21`

- [ ] **Step 1: Add import** — `resolveLocationRcIds` from `@/lib/rc-scope`. Ensure a `user` session is available (add `const user = await requireSession()` if the route doesn't already; match siblings).

- [ ] **Step 2: Apply location set**

Line 8 + lines 19-21 currently read:

```typescript
  const rcId     = searchParams.get('rcId') || null
  ...
  // PrepLog.revenueCenterId is NOT NULL — scope to the active RC, or all when omitted.
  const logs = await prisma.prepLog.findMany({
    where: { logDate: { gte: start, lte: end }, ...(rcId ? { revenueCenterId: rcId } : {}) },
```

Replace the `rcId` line and the `where` to:

```typescript
  const rcId     = searchParams.get('rcId') || null
  const locationId = searchParams.get('locationId')
  const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null
  ...
  // PrepLog.revenueCenterId is NOT NULL — scope to the location's RCs, the active RC, or all.
  const rcWhere = locRcIds
    ? { revenueCenterId: { in: locRcIds } }
    : rcId ? { revenueCenterId: rcId } : {}
  const logs = await prisma.prepLog.findMany({
    where: { logDate: { gte: start, lte: end }, ...rcWhere },
```

- [ ] **Step 3: Verify build** — `npm run build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/reports/prep/route.ts
git commit -m "feat(reports): location-aware prep report aggregation"
```

---

### Task 15: `/api/insights/cost-chrome` GET

**Files:**
- Modify: `src/app/api/insights/cost-chrome/route.ts:30-38`

- [ ] **Step 1: Add import** — `resolveLocationRcIds` from `@/lib/rc-scope`. Ensure a `user` session exists (match siblings).

- [ ] **Step 2: Apply location set to both filters**

Lines 30-38 currently read:

```typescript
  const rcId = searchParams.get('rcId') || undefined
  ...
  const salesFilter = rcId ? { revenueCenterId: rcId } : {}
  const purchaseSessionFilter = rcId ? { revenueCenterId: rcId } : {}
```

Replace with:

```typescript
  const rcId = searchParams.get('rcId') || undefined
  const locationId = searchParams.get('locationId') || undefined
  const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null
  ...
  // SalesEntry NOT NULL → plain `in`. InvoiceSession NULLABLE → also surface null rows.
  const salesFilter = locRcIds
    ? { revenueCenterId: { in: locRcIds } }
    : rcId ? { revenueCenterId: rcId } : {}
  const purchaseSessionFilter = locRcIds
    ? { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] }
    : rcId ? { revenueCenterId: rcId } : {}
```

- [ ] **Step 3: Verify build** — `npm run build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/insights/cost-chrome/route.ts
git commit -m "feat(insights): location-aware cost-chrome aggregation"
```

---

## Phase 5 — Operational & niche inline routes → location-aware

### Task 16: `/api/invoices/kpis` GET (InvoiceSession NULLABLE)

**Files:**
- Modify: `src/app/api/invoices/kpis/route.ts:9-18`

- [ ] **Step 1: Add import** — `resolveLocationRcIds` from `@/lib/rc-scope`; ensure `user` session.

- [ ] **Step 2: Apply location set**

Lines 9-18 currently read:

```typescript
  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'

  const rcWhere = rcId
    ? (isDefault
        ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
        : { revenueCenterId: rcId })
    : {}
```

Replace with:

```typescript
  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'
  const locationId = searchParams.get('locationId')
  const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null

  const rcWhere = locRcIds
    ? { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] }
    : rcId
      ? (isDefault
          ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
          : { revenueCenterId: rcId })
      : {}
```

- [ ] **Step 3: Verify build** — `npm run build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/invoices/kpis/route.ts
git commit -m "feat(invoices): location-aware KPI aggregation"
```

---

### Task 17: `/api/count/areas` GET (CountSession NULLABLE)

**Files:**
- Modify: `src/app/api/count/areas/route.ts:13-14, 83-85`

- [ ] **Step 1: Add import** — `resolveLocationRcIds`; ensure `user` session.

- [ ] **Step 2: Resolve location set after the param reads (after line 14)**

```typescript
  const locationId = searchParams.get('locationId')
  const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null
```

- [ ] **Step 3: Apply to the sessions where (lines 83-85)**

Currently:

```typescript
      ...(rcId
        ? (isDefault ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] } : { revenueCenterId: rcId })
        : {}),
```

Replace with:

```typescript
      ...(locRcIds
        ? { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] }
        : rcId
          ? (isDefault ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] } : { revenueCenterId: rcId })
          : {}),
```

- [ ] **Step 4: Verify build** — `npm run build` succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/count/areas/route.ts
git commit -m "feat(count): location-aware count-areas aggregation"
```

---

### Task 18: `/api/prep/tasks` GET (PrepTask NOT NULL; currently requires rcId)

**Files:**
- Modify: `src/app/api/prep/tasks/route.ts:26-33`

- [ ] **Step 1: Add import** — `resolveLocationRcIds`; ensure `user` session (the route already authenticates — match its variable).

- [ ] **Step 2: Accept locationId as an alternative to rcId**

Lines 26-33 currently read:

```typescript
    const { searchParams } = new URL(req.url)
    const rcId = searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const { start, end } = dayBounds(searchParams.get('date'))

    const library = await prisma.prepTask.findMany({
      where: { revenueCenterId: rcId, isActive: true },
      select: taskSelect,
```

Replace with:

```typescript
    const { searchParams } = new URL(req.url)
    const rcId = searchParams.get('rcId')
    const locationId = searchParams.get('locationId')
    const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null
    if (!rcId && !locRcIds) return NextResponse.json({ error: 'rcId or locationId required' }, { status: 400 })
    const { start, end } = dayBounds(searchParams.get('date'))

    const rcWhere = locRcIds ? { revenueCenterId: { in: locRcIds } } : { revenueCenterId: rcId! }
    const library = await prisma.prepTask.findMany({
      where: { ...rcWhere, isActive: true },
      select: taskSelect,
```

If the handler reads `revenueCenterId: rcId` again further down (e.g. for today's logs), apply the same `rcWhere` substitution there.

- [ ] **Step 3: Verify build** — `npm run build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/prep/tasks/route.ts
git commit -m "feat(prep): GET /api/prep/tasks accepts locationId for read-only roll-up"
```

---

### Task 19: `/api/temps/units` and `/api/temps/readings` GET (TempUnit NULLABLE)

**Files:**
- Modify: `src/app/api/temps/units/route.ts:36-42`
- Modify: `src/app/api/temps/readings/route.ts:17-30`

- [ ] **Step 1: temps/units — add import + location branch**

Add `resolveLocationRcIds` import; ensure `user` session. Lines 36-42 currently:

```typescript
    const rcId = searchParams.get('rcId')
    const date = searchParams.get('date')

    const units = await prisma.tempUnit.findMany({
      where: {
        isActive: true,
        ...(rcId ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] } : {}),
```

Replace with:

```typescript
    const rcId = searchParams.get('rcId')
    const date = searchParams.get('date')
    const locationId = searchParams.get('locationId')
    const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null

    const units = await prisma.tempUnit.findMany({
      where: {
        isActive: true,
        ...(locRcIds
          ? { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] }
          : rcId ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] } : {}),
```

- [ ] **Step 2: temps/readings — add import + location branch**

Add `resolveLocationRcIds` import; ensure `user` session. Lines 17-30 currently filter via the `unit` relation:

```typescript
    const rcId = searchParams.get('rcId')
    ...
        unit: rcId
          ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
          : undefined,
```

Replace the `rcId` read + `unit` filter with:

```typescript
    const rcId = searchParams.get('rcId')
    const locationId = searchParams.get('locationId')
    const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null
    ...
        unit: locRcIds
          ? { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] }
          : rcId
            ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
            : undefined,
```

- [ ] **Step 3: Verify build** — `npm run build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/temps/units/route.ts src/app/api/temps/readings/route.ts
git commit -m "feat(temps): location-aware temp units & readings"
```

---

### Task 20: `/api/recipes/categories` GET (RecipeCategory NULLABLE; type-conditional)

**Files:**
- Modify: `src/app/api/recipes/categories/route.ts:4-13`

- [ ] **Step 1: Add import** — `resolveLocationRcIds`; ensure `user` session.

- [ ] **Step 2: Add location branch**

Lines 4-13 currently:

```typescript
  const { searchParams } = new URL(req.url)
  const type  = searchParams.get('type') || ''
  const rcId  = searchParams.get('rcId') || ''

  // MENU: strict per-RC. PREP: shared (null) + active RC shown together. No rcId = All RCs.
  const rcFilter = !rcId
    ? {}
    : type === 'MENU'
      ? { revenueCenterId: rcId }
      : { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] } // PREP
```

Replace with:

```typescript
  const { searchParams } = new URL(req.url)
  const type  = searchParams.get('type') || ''
  const rcId  = searchParams.get('rcId') || ''
  const locationId = searchParams.get('locationId')
  const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null

  // MENU: strict per-RC. PREP: shared (null) + RC shown together. Location = all child RCs.
  const rcFilter = locRcIds
    ? (type === 'MENU'
        ? { revenueCenterId: { in: locRcIds } }
        : { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] })
    : !rcId
      ? {}
      : type === 'MENU'
        ? { revenueCenterId: rcId }
        : { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] } // PREP
```

- [ ] **Step 3: Verify build** — `npm run build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/recipes/categories/route.ts
git commit -m "feat(recipes): location-aware category filter"
```

---

### Task 21: `/api/stock-transfers` GET (fromRcId/toRcId NOT NULL)

**Files:**
- Modify: `src/app/api/stock-transfers/route.ts:5-13`

- [ ] **Step 1: Add import** — `resolveLocationRcIds`; ensure `user` session.

- [ ] **Step 2: Add location branch**

Lines 5-13 currently:

```typescript
  const { searchParams } = new URL(req.url)
  const itemId = searchParams.get('itemId')
  const rcId   = searchParams.get('rcId')

  const transfers = await prisma.stockTransfer.findMany({
    where: {
      ...(itemId ? { inventoryItemId: itemId } : {}),
      ...(rcId ? { OR: [{ fromRcId: rcId }, { toRcId: rcId }] } : {}),
```

Replace with:

```typescript
  const { searchParams } = new URL(req.url)
  const itemId = searchParams.get('itemId')
  const rcId   = searchParams.get('rcId')
  const locationId = searchParams.get('locationId')
  const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null

  const transfers = await prisma.stockTransfer.findMany({
    where: {
      ...(itemId ? { inventoryItemId: itemId } : {}),
      ...(locRcIds
        ? { OR: [{ fromRcId: { in: locRcIds } }, { toRcId: { in: locRcIds } }] }
        : rcId ? { OR: [{ fromRcId: rcId }, { toRcId: rcId }] } : {}),
```

- [ ] **Step 3: Verify build** — `npm run build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/stock-transfers/route.ts
git commit -m "feat(stock-transfers): location-aware transfer list"
```

---

### Task 22: `/api/inventory` GET (no RC column — location = global catalog)

`InventoryItem` has no `revenueCenterId`; per-RC stock lives in `StockAllocation`. Aggregating allocations across a location's RCs is out of scope for v1. For a location lens, show the **global catalog** (same as "All"). The route already fails closed on out-of-scope `rcId`; it just needs to not choke on `locationId`.

**Files:**
- Modify: `src/app/api/inventory/route.ts:54-63`

- [ ] **Step 1: Read and ignore locationId for allocation filtering, but keep the fail-closed RC guard**

Lines 54-63 currently:

```typescript
  const rcId        = searchParams.get('rcId') || ''
  const isDefault   = searchParams.get('isDefault') === 'true'

  // Inventory items carry no revenueCenterId column ...
  const allowed = await resolveScopedRcIds(user)
  if (rcId && allowed !== null && !allowed.has(rcId)) {
    return NextResponse.json([], { headers: { 'Cache-Control': 'no-store' } })
  }
```

Add a comment-documented no-op for `locationId` (the existing global-catalog path already serves it correctly because `rcId` stays `''`):

```typescript
  const rcId        = searchParams.get('rcId') || ''
  const isDefault   = searchParams.get('isDefault') === 'true'
  // Location lens: InventoryItem has no RC column and per-RC stock lives in
  // StockAllocation. v1 shows the global catalog for a location (rcId stays '').
  // (locationId is accepted but does not narrow the catalog — documented simplification.)

  // Inventory items carry no revenueCenterId column ...
  const allowed = await resolveScopedRcIds(user)
  if (rcId && allowed !== null && !allowed.has(rcId)) {
    return NextResponse.json([], { headers: { 'Cache-Control': 'no-store' } })
  }
```

(No functional change needed — this task documents the deliberate behavior so the page wiring in Phase 6 doesn't pass `rcId`. Verify the page does not send `rcId` under a location lens; `setScopeParams` already sends only `locationId`, so the catalog path is taken.)

- [ ] **Step 2: Verify build** — `npm run build` succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/inventory/route.ts
git commit -m "docs(inventory): document location lens shows global catalog (no per-RC roll-up v1)"
```

---

## Phase 6 — Page wiring: swap param blocks to `setScopeParams`

Each page: (a) add `activeKind, activeLocationId` to the `useRc()` destructure, (b) replace the hand-rolled `rcId` param block with `setScopeParams(...)`, (c) add `activeKind, activeLocationId` to the fetch hook's dependency array, (d) `import { setScopeParams } from '@/lib/scope-params'`.

### Task 23: `src/app/sales/page.tsx`

**Files:** Modify `src/app/sales/page.tsx:877, 884-888, 910`

- [ ] **Step 1: Import** — add `import { setScopeParams } from '@/lib/scope-params'`.

- [ ] **Step 2: Destructure (line 877)**

```typescript
  const { activeRcId, activeRc, revenueCenters, isReadOnly, activeKind, activeLocationId } = useRc()
```

- [ ] **Step 3: Param block (lines 884-888)** — replace:

```typescript
    const params = new URLSearchParams({ startDate, endDate })
    if (activeRcId) {
      params.set('rcId', activeRcId)
      if (activeRc?.isDefault) params.set('isDefault', 'true')
    }
```

with:

```typescript
    const params = new URLSearchParams({ startDate, endDate })
    setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })
```

- [ ] **Step 4: Deps (line 910)** — change `[startDate, endDate, activeRcId, activeRc]` to `[startDate, endDate, activeRcId, activeRc, activeKind, activeLocationId]`.

- [ ] **Step 5: Verify build** — `npm run build` succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/app/sales/page.tsx
git commit -m "feat(sales): page sends locationId under a location lens"
```

---

### Task 24: `src/app/wastage/page.tsx`

**Files:** Modify `src/app/wastage/page.tsx:45, 69-72, 74`

- [ ] **Step 1: Import** `setScopeParams`.
- [ ] **Step 2: Destructure (line 45)**: `const { activeRcId, activeRc, activeKind, activeLocationId } = useRc()`
- [ ] **Step 3: Param block (lines 69-72)** — replace:

```typescript
  if (activeRcId) {
    params.set('rcId', activeRcId)
    if (activeRc?.isDefault) params.set('isDefault', 'true')
  }
```

with:

```typescript
  setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })
```

- [ ] **Step 4: Deps (line 74)**: add `activeKind, activeLocationId` → `[reasonFilter, startDate, endDate, activeRcId, activeRc, activeKind, activeLocationId]`.
- [ ] **Step 5: Verify build** — `npm run build` succeeds.
- [ ] **Step 6: Commit**

```bash
git add src/app/wastage/page.tsx
git commit -m "feat(wastage): page sends locationId under a location lens"
```

---

### Task 25: `src/app/count/page.tsx`

**Files:** Modify `src/app/count/page.tsx:324, 337-343, 345`

- [ ] **Step 1: Import** `setScopeParams`.
- [ ] **Step 2: Destructure (line 324)**: `const { revenueCenters, activeRcId, activeRc, isReadOnly, activeKind, activeLocationId } = useRc()`
- [ ] **Step 3: Param block (lines 337-343)** — replace:

```typescript
    const params = new URLSearchParams()
    if (activeRcId) {
      params.set('rcId', activeRcId)
      if (activeRc?.isDefault) params.set('isDefault', 'true')
    }
```

with:

```typescript
    const params = new URLSearchParams()
    setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })
```

- [ ] **Step 4: Deps (line 345)**: `[activeRcId, activeRc, activeKind, activeLocationId]`.
- [ ] **Step 5:** If `loadCountAreas` also builds a `rcId` param block, apply the same `setScopeParams` swap there (it hits `/api/count/areas`). Search the file for a second `params.set('rcId'` and replace identically, adding the deps.
- [ ] **Step 6: Verify build** — `npm run build` succeeds.
- [ ] **Step 7: Commit**

```bash
git add src/app/count/page.tsx
git commit -m "feat(count): page sends locationId under a location lens"
```

---

### Task 26: `src/app/invoices/page.tsx`

**Files:** Modify `src/app/invoices/page.tsx:36, 62-68, 112`

- [ ] **Step 1: Import** `setScopeParams`.
- [ ] **Step 2: Destructure (line 36)**: `const { activeRcId, activeRc, isReadOnly, activeKind, activeLocationId } = useRc()`
- [ ] **Step 3: Param block (lines 64-67)** — replace:

```typescript
    const p = new URLSearchParams()
    if (activeRcId) {
      p.set('rcId', activeRcId)
      if (activeRc?.isDefault) p.set('isDefault', 'true')
    }
```

with:

```typescript
    const p = new URLSearchParams()
    setScopeParams(p, { activeKind, activeRcId, activeRc, activeLocationId })
```

- [ ] **Step 4: Deps (line 112)**: `[activeRcId, activeRc, push, activeKind, activeLocationId]`.
- [ ] **Step 5:** The invoices page also reads KPIs (`/api/invoices/kpis`). If a separate fetch builds an `rcId` param, apply the same swap. Search for other `set('rcId'` occurrences in the file.
- [ ] **Step 6: Verify build** — `npm run build` succeeds.
- [ ] **Step 7: Commit**

```bash
git add src/app/invoices/page.tsx
git commit -m "feat(invoices): page sends locationId under a location lens"
```

---

### Task 27: `src/app/inventory/page.tsx`

**Files:** Modify `src/app/inventory/page.tsx:191, 250, 253`

- [ ] **Step 1: Import** `setScopeParams`.
- [ ] **Step 2: Destructure (line 191)**: `const { revenueCenters, activeRcId, activeRc, isReadOnly, activeKind, activeLocationId } = useRc()`
- [ ] **Step 3: Param block (line 250)** — replace:

```typescript
    if (activeRcId)     { p.set('rcId', activeRcId); if (activeRc?.isDefault) p.set('isDefault', 'true') }
```

with:

```typescript
    setScopeParams(p, { activeKind, activeRcId, activeRc, activeLocationId })
```

- [ ] **Step 4: Deps (line 253)**: add `activeKind, activeLocationId` → `[search, catFilter, supplierFilter, areaFilter, activeRcId, activeRc, showNonStocked, activeKind, activeLocationId]`.
- [ ] **Step 5: Verify build** — `npm run build` succeeds. (Under a location lens, `setScopeParams` sends only `locationId`; the inventory route shows the global catalog per Task 22.)
- [ ] **Step 6: Commit**

```bash
git add src/app/inventory/page.tsx
git commit -m "feat(inventory): page sends locationId under a location lens"
```

---

### Task 28: `src/app/recipes/page.tsx` and `src/app/menu/page.tsx`

**Files:** Modify `src/app/recipes/page.tsx:22, 55, 58` and `src/app/menu/page.tsx:22, 65, 71`

- [ ] **Step 1: recipes — import** `setScopeParams`.
- [ ] **Step 2: recipes destructure (line 22)**: `const { revenueCenters, activeRcId, activeRc, activeKind, activeLocationId } = useRc()`
- [ ] **Step 3: recipes param (line 55)** — replace `if (activeRcId) params.set('rcId', activeRcId)` with `setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })`
- [ ] **Step 4: recipes deps (line 58)**: `[showInactive, search, activeRcId, activeKind, activeLocationId]`
- [ ] **Step 5: menu — import** `setScopeParams`.
- [ ] **Step 6: menu destructure (line 22)**: add `activeLocationId` → `const { revenueCenters, activeRcId, activeRc, activeKind, activeLocationId } = useRc()`
- [ ] **Step 7: menu param (line 65)** — replace `if (activeRcId) params.set('rcId', activeRcId)` with `setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })`
- [ ] **Step 8: menu deps (line 71)**: `[showInactive, search, searchParams, activeRcId, activeKind, activeLocationId]`
- [ ] **Step 9: Verify build** — `npm run build` succeeds.
- [ ] **Step 10: Commit**

```bash
git add src/app/recipes/page.tsx src/app/menu/page.tsx
git commit -m "feat(recipes,menu): pages send locationId under a location lens"
```

---

### Task 29: Reports pages — `reports/page.tsx`, `CogsTab`, `SalesTab`, `PrepTab`, `signals`

`SalesTab` builds params via an `analyticsParams(range, activeRcId, activeRc)` helper — extend that helper instead of each tab.

**Files:** Modify `src/app/reports/page.tsx:53-58, 67-74`; `src/app/reports/tabs/CogsTab.tsx:48, 61-66, 71`; `src/app/reports/tabs/PrepTab.tsx:59, 69-71, 76`; the `analyticsParams` helper used by `SalesTab.tsx`; `src/app/reports/signals/page.tsx:9, 59-61`.

- [ ] **Step 1: reports/page.tsx — cost-chrome fetch (line ~53)**

The cost-chrome fetch uses an inline string. It currently reads:

```typescript
    fetch(`/api/insights/cost-chrome${activeRcId ? `?rcId=${activeRcId}` : ''}`, { cache: 'no-store' })
```

Replace with a `setScopeParams`-built query (import `setScopeParams`; `activeKind`/`activeLocationId` already added in Task 4 Step 2):

```typescript
    const chromeParams = new URLSearchParams()
    setScopeParams(chromeParams, { activeKind, activeRcId, activeRc, activeLocationId })
    const chromeQs = chromeParams.toString()
    fetch(`/api/insights/cost-chrome${chromeQs ? `?${chromeQs}` : ''}`, { cache: 'no-store' })
```

Add `activeKind, activeLocationId` to that effect's deps (line ~60), currently `[activeRcId]` → `[activeRcId, activeKind, activeLocationId]`.

- [ ] **Step 2: reports/page.tsx — dashboard fetch (lines 67-74)**

Replace:

```typescript
    if (activeRcId) { params.set('rcId', activeRcId); params.set('isDefault', String(activeRc?.isDefault ?? false)) }
```

with:

```typescript
    setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })
```

Add `activeKind, activeLocationId` to that effect's deps (line ~74): `[activeRcId, activeRc, range, activeKind, activeLocationId]`.

- [ ] **Step 3: CogsTab.tsx** — import `setScopeParams`; destructure adds `activeLocationId` (line 48: `const { activeRcId, activeRc, activeKind, activeLocationId } = useRc()`); replace the param block (lines 62-65):

```typescript
  if (activeRcId) {
    params.set('rcId', activeRcId)
    if (activeRc?.isDefault) params.set('isDefault', 'true')
  }
```

with `setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })`; deps (line 71) → `[range, activeRcId, activeRc, activeKind, activeLocationId]`.

- [ ] **Step 4: PrepTab.tsx** — import `setScopeParams`; destructure adds `activeKind, activeLocationId` (line 59); replace `if (activeRcId) params.set('rcId', activeRcId)` (line 70) with `setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })`; deps (line 76) → `[range, activeRcId, activeRc, activeKind, activeLocationId]`.

- [ ] **Step 5: SalesTab.tsx + analyticsParams helper** — `SalesTab` calls `analyticsParams(range, activeRcId, activeRc)` (line 27). Locate `analyticsParams` (search `grep -rn "function analyticsParams\|const analyticsParams" src`). Extend its signature to also take the location context and call `setScopeParams` internally. Concretely, change the helper to accept a `scope` object:

```typescript
export function analyticsParams(
  range: { from: Date; to: Date },
  scope: { activeKind: 'all' | 'location' | 'rc'; activeRcId: string | null; activeRc: { isDefault?: boolean } | null; activeLocationId: string | null },
): URLSearchParams {
  const params = new URLSearchParams({ from: ymd(range.from), to: ymd(range.to) })
  setScopeParams(params, scope)
  return params
}
```

Then update `SalesTab.tsx` line 27 to pass the scope object and add `activeKind, activeLocationId` to its destructure (line 14) and deps (line 33):

```typescript
  const { activeRcId, activeRc, activeKind, activeLocationId } = useRc()
  ...
  const params = analyticsParams(range, { activeKind, activeRcId, activeRc, activeLocationId }); params.set('section', 'sales')
  ...
  }, [range, activeRcId, activeRc, activeKind, activeLocationId])
```

Update **every** caller of `analyticsParams` the same way (search `grep -rn "analyticsParams(" src` — other tabs may use it). If the helper previously kept the old `(range, activeRcId, activeRc)` signature elsewhere, migrate all call sites to the new object form so the build stays green.

- [ ] **Step 6: signals/page.tsx** — import `setScopeParams`; destructure (line 9) → `const { activeRcId, activeKind, activeLocationId, activeRc } = useRc()`; replace param block (lines 60-61):

```typescript
  const params = new URLSearchParams()
  if (activeRcId) params.set('rcId', activeRcId)
```

with:

```typescript
  const params = new URLSearchParams()
  setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })
```

Add `activeKind, activeLocationId` to its fetch hook deps. **Note:** `/api/reports/signals` is not in the Phase 4 route list — if signals should stay global (it's price-volatility/global per the memory `Report tabs range + RC`), SKIP this step and leave signals reading only `activeRcId`. Confirm by reading `src/app/api/reports/signals/route.ts`: if it ignores `rcId` or is documented GLOBAL, do not change the page. Otherwise apply the swap and add a Phase-4-style `locationId` branch to that route.

- [ ] **Step 7: Verify build** — `npm run build` succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/app/reports
git commit -m "feat(reports): tabs & signals send locationId under a location lens"
```

---

## Phase 7 — Verification

### Task 30: Full build + manual location-lens walkthrough

**Files:** none (verification only)

- [ ] **Step 1: Production build**

Run: `npm run build`
Expected: succeeds with no type errors. Confirm `/location` is **absent** from the route list and all touched API routes still show `ƒ (Dynamic)` (not `○ (Static)`) — a mutating/scope route must stay dynamic (CLAUDE.md infra gotcha).

- [ ] **Step 2: Start dev server**

Use `preview_start` (or `npm run dev`). Log in.

- [ ] **Step 3: Lens persistence across pages**

Pick a Location in the switcher. Verify you **stay on the current page** (no redirect to `/location`). Navigate to `/sales`, `/wastage`, `/reports` — each stays on its own page, data filtered to the location's RCs, and write buttons disabled with the "Select a revenue center to make changes" tooltip (`isReadOnly`).

- [ ] **Step 4: Reports location overview**

On `/reports` with a Location active, confirm the `LocationDashboard` per-RC cost cards + blended COGS % render at the top, and the report content below is location-scoped.

- [ ] **Step 5: Aggregation correctness (spot check)**

For a location with ≥2 RCs, compare `/sales` totals under the Location lens against the sum of the same window under each child RC selected individually. They should match. Repeat for `/wastage`.

- [ ] **Step 6: RC drill-in still writes**

Pick a single RC. Confirm write buttons re-enable and a create (e.g. add a sales day) succeeds — the lens→drill-in→act flow works end to end.

- [ ] **Step 7: "All" unchanged**

Pick "All Revenue Centers". Confirm behavior is unchanged (unscoped, read-only) — `setScopeParams` emits no params for `activeKind === 'all'`.

- [ ] **Step 8: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "fix(scope): verification adjustments for location lens"
```

---

## Self-Review checklist (completed during planning)

- **Spec coverage:** ✅ (1) forced redirect removed (Task 3); (2) `/location` retired + summary folded into reports (Tasks 4–5); (3) server-side `?locationId` resolution (Task 1); read-only roll-up across reports/sales/wastage (Phases 3–4) and op pages count/prep/invoices (Phase 5); writes still RC-gated via existing `isReadOnly` (unchanged).
- **Known v1 simplifications (documented, not gaps):** inventory location lens shows the global catalog rather than aggregating per-RC `StockAllocation` (Task 22); `/api/reports/signals` may remain global (Task 29 Step 6, conditional).
- **Type consistency:** `setScopeParams(params, scope)` signature is identical at every call site; `scopeWhereFromParams(user, searchParams, { nullable })` and `resolveLocationRcIds(user, locationId)` are used consistently; `nullable` flags match each model's RC column (NOT NULL → false; NULLABLE → true).
- **Placeholder scan:** every code step contains concrete before/after code; route-specific "read the surrounding code" notes (Tasks 13, 25 Step 5, 26 Step 5, 29 Step 5) are bounded follow-the-pattern instructions, each with the exact wrapper to apply.
