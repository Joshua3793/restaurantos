# RC-dependent Recipe Book (PREP) — Design

**Date:** 2026-06-11
**Status:** Approved (pending implementation plan)

## Problem

Different Revenue Centers (RCs) run different prep operations — RC-A's "Marinara" can be a genuinely different recipe, with different ingredients and a different cost, than RC-B's. Today the **Recipe Book (PREP) page ignores the active RC entirely**: every PREP recipe is shared (`revenueCenterId = null`) and shown regardless of which RC is selected. This prevents per-RC prep costing and makes the book a single global list.

The **Menu page is already RC-dependent** (it filters MENU recipes/categories by `activeRcId` and shows all in "All RC" mode). This feature brings the Recipe Book to parity, using the same proven pattern.

## Scope

**In scope:** Recipe Book (PREP) page becomes RC-aware — filtering, creation defaults, and an RC selector on the prep recipe form. Existing PREP recipes and categories migrated to the default RC.

**Out of scope:**
- The **Menu page** (already RC-dependent — left untouched, including its strict `revenueCenterId = rcId` filter).
- The global **`InventoryItem`** model and the **`pricePerBaseUnit` spine** — unchanged.
- The **cost report's** own aggregation (already RC-aware at the sales/menu level).
- The **`/prep` execution page** and its `PrepSettings.categories` — a separate category system, not `RecipeCategory`.

## Chosen model: hybrid (shared OR RC-specific)

A PREP recipe is either:
- **Shared** (`revenueCenterId = null`) — visible in every RC's book, and in "All RC".
- **RC-specific** (`revenueCenterId = <rcId>`) — visible only when that RC (or "All RC") is active.

This mirrors exactly how MENU recipes and categories already work, so the data model and API plumbing are half-built.

### Viewing rule (shared + RC-specific shown together)

- **Active RC = X** → show recipes where `revenueCenterId IN (X, null)` — i.e. shared prep **plus** X's own prep, in one list. Same for categories.
- **All RC** (`activeRcId === null`) → no RC filter; show everything.

> Note: PREP uses `IN (rcId, null)` (shared + specific). MENU keeps its existing strict `= rcId` filter. This intentional difference is left as-is to avoid scope creep on the working Menu page.

### Why this doesn't touch the cost spine

A PREP recipe links to exactly one global `InventoryItem` (`Recipe.inventoryItemId @unique`). RC-specific prep recipes simply get their own linked inventory item, so their costs stay separate and flow into the cost report through normal ingredient costing. `syncPrepToInventory` keeps writing each prep's computed cost to its one linked inventory item, unchanged. The RC tag on a prep recipe controls **only its visibility in the Recipe Book** — not its usability as an ingredient (menu recipes reference inventory items by id, globally) and not any cost.

## Migration

Assign **all existing PREP `Recipe` rows and PREP `RecipeCategory` rows** to the **default RC** (`RevenueCenter.isDefault = true`).

Implemented as a one-off data script (the `prisma migrate dev` shadow DB is broken in this project — use the documented diff/db-execute/resolve workaround or a plain Prisma script run against `DIRECT_URL`). No schema change is required: `Recipe.revenueCenterId` and `RecipeCategory.revenueCenterId` already exist as nullable columns.

### Accepted consequence

On ship day, the **default RC's Recipe Book looks exactly as today** (all existing prep), while **every other RC's book starts empty** — nothing is tagged "shared" yet. Operators populate other RCs by creating new prep there, or by flipping specific recipes to "Shared." This is deliberate. It breaks nothing: existing menu recipes in any RC continue to reference the (global) prep inventory items as before; only Recipe Book visibility is affected.

## Changes

### 1. Schema
None. Existing nullable `revenueCenterId` columns on `Recipe` and `RecipeCategory` are reused.

### 2. Data migration script
- Look up the default RC id (`isDefault = true`; fall back to first RC if none flagged).
- `UPDATE Recipe SET revenueCenterId = <default> WHERE type = 'PREP' AND revenueCenterId IS NULL`.
- `UPDATE RecipeCategory SET revenueCenterId = <default> WHERE type = 'PREP' AND revenueCenterId IS NULL`.

### 3. API — `src/app/api/recipes/route.ts`
- **GET**: replace the MENU-only RC filter with type-aware logic:
  - `type === 'MENU' && rcId` → `{ revenueCenterId: rcId }` (unchanged).
  - `type === 'PREP' && rcId` → `{ OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }` (shared + specific).
  - no `rcId` (All RC) → no RC filter.
- **POST**: change `revenueCenterId: type === 'MENU' ? (revenueCenterId || null) : null` to assign for PREP as well — `revenueCenterId: revenueCenterId || null` for both MENU and PREP (caller passes the active RC, or null for Shared).

### 4. API — `src/app/api/recipes/categories/route.ts`
- **GET**: extend the filter so PREP behaves like MENU:
  - `rcId` set → `{ OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }` for PREP (and keep `{ revenueCenterId: rcId }` for MENU).
  - no `rcId` → no RC filter (return all of that type).
- **POST**: assign `revenueCenterId` for PREP categories too (currently forced to `null`). Mirror the recipe POST change.

### 5. Recipe Book page — `src/app/recipes/page.tsx`
Mirror the Menu page (`src/app/menu/page.tsx:40–67`):
- Import and call `useRc()`; read `activeRcId` / `activeRc`.
- Add `rcId` to the category fetch and the recipe fetch (`if (activeRcId) params.set('rcId', activeRcId)`), and add `activeRcId` to the relevant `useCallback` deps.
- Pre-fill the new-recipe form's `revenueCenterId` with `activeRcId` when it changes (default to Shared/null when on "All RC").
- Show the active-RC context in the page header, consistent with the Menu page.

### 6. Prep recipe form — `src/components/recipes/shared.tsx`
- Surface the **RC / "Shared" selector** on the prep recipe create/edit form (reuse the existing Menu RC control). Options: each RC + a "Shared (all RCs)" choice mapping to `revenueCenterId = null`.
- Optionally show a small RC / "Shared" badge on the recipe card so operators can see a prep's scope at a glance.

## Verification

- `npm run build` passes (the project's only correctness gate).
- Manual: with RC-A active, Recipe Book shows shared + RC-A prep; switching to RC-B (post-migration, empty) shows only shared (none initially); "All RC" shows everything.
- Creating a prep recipe while RC-A is active tags it to RC-A; setting it to "Shared" makes it visible in all RCs.
- A menu recipe in any RC can still add an existing prep's inventory item as an ingredient (cost unchanged), proving visibility-only scoping.
