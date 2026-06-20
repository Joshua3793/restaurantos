# Auto-sync PREP recipes → remove manual "Sync" buttons

**Date:** 2026-06-20
**Status:** Approved (brainstorming) — ready for implementation plan
**Scope this pass:** Inventory "Sync PREPD" button + Prep "Sync from recipes" button.
The Count session "Sync" button is explicitly **out of scope** for now.

## Problem

The app exposes manual "Sync" buttons that the user must remember to press to keep
derived data consistent with PREP recipes. We want syncing to happen automatically
on the events that actually change things, and to remove the buttons.

Two distinct concerns are conflated under "sync":

1. **Inventory cost** — a PREP recipe's computed cost is written back to its linked
   `InventoryItem` (the spine `pricing`/`packChain`) by `syncPrepToInventory`, so the
   prep can be used as a priced ingredient elsewhere. Button: Inventory **"Sync PREPD"**
   → `POST /api/inventory/sync-prepd`.
2. **Prep task rows** — a `PrepItem` (prep list / station row) exists per active PREP
   recipe, with category mirrored from the recipe and the recipe's category merged into
   `PrepSettings.categories`. Button: Prep **"Sync from recipes"** →
   `POST /api/prep/sync-from-recipes`.

### What's already automatic (verified)

`syncPrepToInventory` already fires on: ingredient add/edit/delete, recipe yield
change, invoice approval, manual inventory edits, supplier-primary switch. So the
Inventory button is **not the primary sync path** — it's a drift-repair + backfill
safety net. Its real value: (a) link legacy unlinked PREP recipes, (b) force a full
recompute to recover from syncs that silently failed.

### Why drift still happens today

- The per-edit ingredient syncs are **fire-and-forget** (`syncPrepToInventory(id).catch(console.error)`),
  not awaited — a transient failure leaves the inventory cost silently stale.
- The per-edit paths call only `syncPrepToInventory` (the recipe's OWN item) and
  **never cascade** — editing a sub-prep (e.g. Adobo) leaves preps that consume it
  (e.g. Pulled Pork) stale until a bulk sync. `propagatePrepCostChanges` exists but is
  only wired into invoice-approve / inventory-edit, not recipe edits.
- Recipe **CREATE** writes only a zero-cost placeholder (no sync; benign today since a
  new recipe has no ingredients).
- Renaming a recipe does **not** rename its linked PREPD item (`syncPrepToInventory`
  writes cost/units/allergens but never `itemName`) → stale name + duplicate-item risk
  on backfill.
- Prep task-rows: only the button keeps `PrepItem` category and `PrepSettings.categories`
  in step; a recipe rename/re-category never flows to its `PrepItem` automatically.

## Approach (chosen)

**Harden the events so drift can't accumulate; keep the bulk endpoints as headless
repair/cron tools; remove the UI buttons.** Each concern gets one awaited per-recipe
helper that is the single entry point, reused by both the event hooks and the (now
headless) bulk endpoint.

## Part A — Inventory cost auto-sync

New helper in `src/lib/recipeCosts.ts`:

```ts
/** Re-sync a PREP recipe's cost to its linked item AND cascade to dependents.
 *  Single entry point for every recipe-mutation path. No-op for non-PREP / unlinked. */
export async function resyncPrepRecipe(recipeId: string): Promise<void> {
  const recipe = await prisma.recipe.findUnique({
    where: { id: recipeId }, select: { type: true, inventoryItemId: true },
  })
  if (!recipe || recipe.type !== 'PREP' || !recipe.inventoryItemId) return
  await syncPrepToInventory(recipeId)                      // this recipe's own item
  await propagatePrepCostChanges([recipe.inventoryItemId]) // cascade to consumers
}
```

`syncPrepToInventory` is extended to also write `itemName: recipe.name` so a recipe
rename renames its PREPD item.

**Call sites** — replace today's fire-and-forget `syncPrepToInventory(id).catch()`
with `await resyncPrepRecipe(id)`:
- `api/recipes/[id]/ingredients/route.ts` POST (add)
- `api/recipes/[id]/ingredients/[ingredientId]/route.ts` PATCH (when cost-affecting) + DELETE
- `api/recipes/[id]/route.ts` PATCH — trigger when `baseYieldQty`, `yieldUnit`, **or `name`** changes
- `api/recipes/route.ts` POST — after linking the new PREP recipe (near no-op today, kept for uniformity)
- `api/recipes/[id]/route.ts` DELETE — after deactivating the linked item, cascade from
  it so consumers re-cost: `await propagatePrepCostChanges([inventoryItemId])`

**Error handling:** the call is awaited (so the cascade runs and inventory is consistent
before the response returns) but wrapped `.catch(log)` so a rare sync hiccup does not make
the user's edit return 500. The headless endpoint is the recovery path for those rare misses.

## Part B — Remove Inventory button, keep endpoint

- Delete desktop + mobile **"Sync PREPD"** buttons, the `syncAllPrepd` handler, and the
  `syncingPrepd` state from `src/app/inventory/page.tsx`.
- Keep `POST /api/inventory/sync-prepd` exactly as-is — now reachable only headlessly
  (repair / cron), not from the UI.

## Part C — Prep task-row auto-sync

New helper `src/lib/prep-sync.ts`:

```ts
/** Ensure the PrepItem for a PREP recipe exists and matches it (name/category/unit/link),
 *  and that the recipe's category is present in PrepSettings.categories.
 *  Single entry point; reused by event hooks and the bulk endpoint. No-op for non-PREP. */
export async function syncPrepItemFromRecipe(recipeId: string): Promise<void>
```

Behavior for one recipe:
- Load recipe (type, name, category name, yieldUnit, inventoryItemId, existing prepItem).
- No-op if not PREP or inactive.
- Upsert the `PrepItem` keyed by `linkedRecipeId`: create with the bulk route's defaults
  (parLevel 0, minThreshold 0, isActive true) if missing; else update
  `name` / `category` / `unit` / `linkedInventoryItemId` to match the recipe.
- Merge the recipe's category into `PrepSettings.categories` via ORM upsert (the existing
  proven path — NOT `$executeRaw` tagged templates; see CLAUDE.md pgBouncer note).

**Triggers:**
- `api/recipes/route.ts` POST (PREP) → `await syncPrepItemFromRecipe(id)` after linking.
- `api/recipes/[id]/route.ts` PATCH → call when `name`, `categoryId`, or `yieldUnit` changes.
- DELETE → unchanged (already nulls `linkedRecipeId` on prep items). Orphaned PrepItems are
  left active deliberately (auto-deactivating could surprise) — **known edge**, not handled.

**Bulk endpoint refactor:** `POST /api/prep/sync-from-recipes` is refactored to loop over
`syncPrepItemFromRecipe` so the helper is the single source of truth. It still also does the
legacy backfill of unlinked recipes. Kept headless (button removed). Per-recipe settings
merge in a loop is acceptable for a rare headless call.

## Part D — Remove Prep button, keep endpoint

- Delete desktop + mobile **"Sync from recipes"** buttons + handler/state from
  `src/app/prep/page.tsx`.
- Keep `POST /api/prep/sync-from-recipes` headless.

## Out of scope

- Count session "Sync" button.
- Auto-deactivating orphaned PrepItems on recipe delete.
- Any cron wiring for the headless endpoints (kept callable; scheduling is a later choice).

## Testing / verification

No automated test suite — `npm run build` is the type-check gate. Manual/scripted checks:
1. Build passes.
2. Add/edit/remove an ingredient on a PREP recipe → linked InventoryItem cost updates, and a
   prep that consumes it re-costs (cascade) — verify via a read-only script reading the spine.
3. Rename a PREP recipe → PREPD InventoryItem name and PrepItem name both update.
4. Re-categorize a PREP recipe → PrepItem.category and PrepSettings.categories update.
5. Create a PREP recipe → PrepItem created, category present in PrepSettings.
6. Headless `sync-prepd` and `sync-from-recipes` still run and are idempotent.
7. Confirm both buttons are gone from desktop and mobile renderers.
