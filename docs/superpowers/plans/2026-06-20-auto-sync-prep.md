# Auto-sync PREP recipes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PREP-recipe sync (inventory cost + prep task-rows) happen automatically on recipe create/edit/delete, and remove the two manual "Sync" buttons (Inventory "Sync PREPD", Prep "Sync from recipes"), keeping the bulk endpoints as headless repair tools.

**Architecture:** Two awaited per-recipe helpers become the single entry points — `resyncPrepRecipe` (cost: sync linked item + cascade to dependents) and `syncPrepItemFromRecipe` (prep task-row + category). They are wired into every recipe-mutation route and reused by the now-headless bulk endpoints. Calls are awaited (so cascades run before the response) but `.catch(log)`-wrapped (so a rare sync failure doesn't 500 a user edit; the headless endpoint is the recovery path).

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase). No unit-test suite — `npm run build` is the type-check gate; behavioral checks use read-only / idempotent scripts run with `ts-node`.

**Spec:** `docs/superpowers/specs/2026-06-20-auto-sync-prep-design.md`

**Environment note:** node/npm are not on the default PATH. Prefix build/script commands with:
`export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"`

---

## Task 1: Add `resyncPrepRecipe` helper + write `itemName` on cost sync

**Files:**
- Modify: `src/lib/recipeCosts.ts` (extend `syncPrepToInventory`; add `resyncPrepRecipe` after `propagatePrepCostChanges`)

- [ ] **Step 1: Make `syncPrepToInventory` write the item name**

In `src/lib/recipeCosts.ts`, inside `syncPrepToInventory`'s `prisma.inventoryItem.update({ ... data: { ... } })`, add `itemName: recipe.name,` to the `data` object (so renaming a PREP recipe renames its linked PREPD item). The block currently begins:

```ts
    data: {
      purchasePrice:      recipe.totalCost,
      baseUnit:           yieldUnit,
```

Change to:

```ts
    data: {
      itemName:           recipe.name,
      purchasePrice:      recipe.totalCost,
      baseUnit:           yieldUnit,
```

- [ ] **Step 2: Add the `resyncPrepRecipe` helper**

Append to `src/lib/recipeCosts.ts` (after the end of `propagatePrepCostChanges`):

```ts
/**
 * Re-sync a PREP recipe's cost to its linked InventoryItem AND cascade to every
 * dependent prep. The single entry point for every recipe-mutation path; no-op for
 * non-PREP or unlinked recipes. Awaited by callers so the cascade completes before
 * the response; callers wrap in .catch() so a rare sync failure never fails the edit.
 */
export async function resyncPrepRecipe(recipeId: string): Promise<void> {
  const recipe = await prisma.recipe.findUnique({
    where: { id: recipeId },
    select: { type: true, inventoryItemId: true },
  })
  if (!recipe || recipe.type !== 'PREP' || !recipe.inventoryItemId) return
  await syncPrepToInventory(recipeId)                      // this recipe's own output item
  await propagatePrepCostChanges([recipe.inventoryItemId]) // cascade to consumers
}
```

- [ ] **Step 3: Type-check**

Run: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -6`
Expected: build completes; route table prints; no TypeScript errors. (If `recipe.name` errors, confirm `fetchRecipeWithCost` selects `name` — it does; the Recipe row includes it.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/recipeCosts.ts
git commit -m "feat(prep-sync): add resyncPrepRecipe helper + sync itemName on cost write"
```

---

## Task 2: Wire `resyncPrepRecipe` into all recipe cost-mutation paths

**Files:**
- Modify: `src/app/api/recipes/[id]/ingredients/route.ts`
- Modify: `src/app/api/recipes/[id]/ingredients/[ingredientId]/route.ts`
- Modify: `src/app/api/recipes/[id]/route.ts`
- Modify: `src/app/api/recipes/route.ts`

- [ ] **Step 1: Ingredient add (POST)**

In `src/app/api/recipes/[id]/ingredients/route.ts`:
- Change the import line 3 from `import { syncPrepToInventory } from '@/lib/recipeCosts'` to:
  `import { resyncPrepRecipe } from '@/lib/recipeCosts'`
- Replace lines 50-51:
  ```ts
    // Fire sync in background — client handles optimistic display
    syncPrepToInventory(params.id).catch(console.error)
  ```
  with:
  ```ts
    // Keep the linked inventory item and dependent preps in sync. Awaited so the cascade
    // runs before responding; caught so a rare sync hiccup doesn't fail the edit (the
    // headless /api/inventory/sync-prepd endpoint is the recovery path).
    await resyncPrepRecipe(params.id).catch(e => console.error('[ingredient POST] resync', e))
  ```

- [ ] **Step 2: Ingredient edit/delete (PATCH/DELETE)**

In `src/app/api/recipes/[id]/ingredients/[ingredientId]/route.ts`:
- Change import line 3 to: `import { resyncPrepRecipe } from '@/lib/recipeCosts'`
- Replace line 40:
  ```ts
    if (costAffecting) syncPrepToInventory(params.id).catch(console.error)
  ```
  with:
  ```ts
    if (costAffecting) await resyncPrepRecipe(params.id).catch(e => console.error('[ingredient PATCH] resync', e))
  ```
- Replace lines 51-52:
  ```ts
    // Fire sync in background — don't block the response.
    syncPrepToInventory(params.id).catch(console.error)
  ```
  with:
  ```ts
    await resyncPrepRecipe(params.id).catch(e => console.error('[ingredient DELETE] resync', e))
  ```

- [ ] **Step 3: Recipe edit (PATCH) — trigger on name too**

In `src/app/api/recipes/[id]/route.ts`:
- Change import line 3 from `import { fetchRecipeWithCost, syncPrepToInventory } from '@/lib/recipeCosts'` to:
  `import { fetchRecipeWithCost, resyncPrepRecipe, propagatePrepCostChanges } from '@/lib/recipeCosts'`
- Replace lines 52-54:
  ```ts
    // Only sync to inventory when fields that affect cost change (yield quantity/unit).
    // name, notes, isActive, categoryId, menuPrice, portionSize/Unit do not affect cost.
    const costAffecting = baseYieldQty !== undefined || yieldUnit !== undefined
    if (costAffecting) await syncPrepToInventory(params.id)
  ```
  with:
  ```ts
    // Re-sync the linked item (and dependents) when cost- or name-affecting fields change.
    // name flows to the PREPD item's itemName; yield qty/unit drive cost.
    const costAffecting = baseYieldQty !== undefined || yieldUnit !== undefined || name !== undefined
    if (costAffecting) await resyncPrepRecipe(params.id).catch(e => console.error('[recipe PATCH] resync', e))
  ```

- [ ] **Step 4: Recipe delete (DELETE) — cascade from the deactivated item**

In `src/app/api/recipes/[id]/route.ts` `DELETE`, capture the deactivated item id and cascade after the transaction. Replace the transaction body's recipe lookup + the post-transaction return. The current block is:

```ts
      const recipe = await tx.recipe.findUnique({ where: { id }, select: { inventoryItemId: true } })
      if (recipe?.inventoryItemId) {
        await tx.inventoryItem.update({ where: { id: recipe.inventoryItemId }, data: { isActive: false } })
      }
      await tx.recipe.delete({ where: { id } })
    })
    return NextResponse.json({ success: true })
```

Replace with:

```ts
      const recipe = await tx.recipe.findUnique({ where: { id }, select: { inventoryItemId: true } })
      if (recipe?.inventoryItemId) {
        deactivatedItemId = recipe.inventoryItemId
        await tx.inventoryItem.update({ where: { id: recipe.inventoryItemId }, data: { isActive: false } })
      }
      await tx.recipe.delete({ where: { id } })
    })
    // A deleted PREP is no longer a priced ingredient — re-cost any prep that used it.
    if (deactivatedItemId) {
      await propagatePrepCostChanges([deactivatedItemId]).catch(e => console.error('[recipe DELETE] propagate', e))
    }
    return NextResponse.json({ success: true })
```

And declare `deactivatedItemId` just before the `await prisma.$transaction(async tx => {` line:

```ts
    let deactivatedItemId: string | null = null
```

- [ ] **Step 5: Recipe create (POST) — initial resync after linking**

In `src/app/api/recipes/route.ts`:
- Add to the recipeCosts import (top of file): `import { resyncPrepRecipe } from '@/lib/recipeCosts'` (create the import if none exists).
- In the `if (type === 'PREP') { ... }` block, immediately before `return NextResponse.json({ ...recipe, inventoryItemId: invItem.id }, { status: 201 })`, add:
  ```ts
    // Initialise the linked item from the recipe (near no-op at create — no ingredients yet —
    // but keeps the create path uniform with edits).
    await resyncPrepRecipe(recipe.id).catch(e => console.error('[recipe POST] resync', e))
  ```

- [ ] **Step 6: Type-check**

Run: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -6`
Expected: build succeeds, no unused-import or type errors. If `syncPrepToInventory` is now reported unused anywhere, remove it from that file's import.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/recipes
git commit -m "feat(prep-sync): await resyncPrepRecipe on every recipe cost mutation"
```

---

## Task 3: Remove the Inventory "Sync PREPD" button

**Files:**
- Modify: `src/app/inventory/page.tsx`

- [ ] **Step 1: Remove the desktop button**

Delete this block (around lines 771-779):

```tsx
          <button
            onClick={syncAllPrepd}
            disabled={syncingPrepd}
            title="Re-sync all PREPD item prices from their recipes"
            className="flex items-center gap-[7px] border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors disabled:opacity-50"
          >
            <span className="text-ink-3 text-[13px]">⟳</span>
            {syncingPrepd ? 'Syncing…' : 'Sync PREPD'}
          </button>
```

- [ ] **Step 2: Remove the mobile button**

Delete this block (around lines 960-969):

```tsx
          <button
            onClick={syncAllPrepd}
            disabled={syncingPrepd}
            title="Re-sync all PREPD item prices from their recipes"
            className="flex items-center gap-1 px-2 py-1.5 rounded-[8px] font-mono text-[11px] uppercase tracking-[0.04em] border border-line bg-paper text-ink-2 transition-colors hover:border-ink-3 disabled:opacity-50"
          >
            {syncingPrepd ? <Loader2 size={11} className="animate-spin" /> : <span className="text-[11px] text-ink-3">⟳</span>}
            PREPD
          </button>
```

- [ ] **Step 3: Remove the handler and state**

- Delete the entire `const syncAllPrepd = async () => { ... }` function (lines 443-466).
- Delete the state line (line 221): `const [syncingPrepd,  setSyncingPrepd]  = useState(false)`
- In the icon import (line 26: `Search, Plus, X, Download, Loader2,`), remove `Loader2,` — it is used only by the removed mobile button. (Build in Step 4 confirms it's now unused.)

- [ ] **Step 4: Type-check (catches any leftover reference / unused import)**

Run: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -6`
Expected: build succeeds. If it errors on `Loader2` still used, leave the import; if it errors on `syncAllPrepd`/`syncingPrepd` undefined, remove the remaining reference it names.

- [ ] **Step 5: Commit**

```bash
git add src/app/inventory/page.tsx
git commit -m "feat(prep-sync): remove manual Sync PREPD button (now automatic)"
```

---

## Task 4: Add `syncPrepItemFromRecipe` helper

**Files:**
- Create: `src/lib/prep-sync.ts`

- [ ] **Step 1: Write the helper**

Create `src/lib/prep-sync.ts`:

```ts
import { prisma } from '@/lib/prisma'
import { PREP_CATEGORIES } from '@/lib/prep-utils'

/**
 * Ensure the PrepItem for a PREP recipe exists and matches the recipe
 * (name / category / unit / linked inventory item), and that the recipe's category is
 * present in PrepSettings.categories (the recipe-managed category list). Single entry
 * point for prep task-row sync — reused by the recipe-mutation hooks and the headless
 * bulk endpoint. No-op for non-PREP or inactive recipes.
 */
export async function syncPrepItemFromRecipe(recipeId: string): Promise<void> {
  const recipe = await prisma.recipe.findUnique({
    where: { id: recipeId },
    select: {
      id: true, name: true, type: true, isActive: true, yieldUnit: true,
      inventoryItemId: true,
      category: { select: { name: true } },
      prepItems: { select: { id: true }, take: 1 },
    },
  })
  if (!recipe || recipe.type !== 'PREP' || !recipe.isActive) return
  const categoryName = recipe.category?.name ?? 'MISC'

  // Upsert the PrepItem keyed by its linked recipe.
  const existing = recipe.prepItems[0]
  if (existing) {
    await prisma.prepItem.update({
      where: { id: existing.id },
      data: {
        name: recipe.name,
        category: categoryName,
        unit: recipe.yieldUnit,
        linkedInventoryItemId: recipe.inventoryItemId ?? null,
      },
    })
  } else {
    await prisma.prepItem.create({
      data: {
        name: recipe.name,
        linkedRecipeId: recipe.id,
        linkedInventoryItemId: recipe.inventoryItemId ?? null,
        unit: recipe.yieldUnit,
        category: categoryName,
        parLevel: 0,
        minThreshold: 0,
        isActive: true,
      },
    })
  }

  // Ensure the category is present in PrepSettings.categories (recipe-managed list).
  // ORM upsert with a text[] value — the same proven path the bulk route uses
  // (NOT $executeRaw tagged templates; see CLAUDE.md pgBouncer note). Gated on a miss
  // so we only write the array when it actually changes.
  const settings = await prisma.prepSettings.findUnique({ where: { id: 'singleton' } })
  const existingCats = settings?.categories ?? PREP_CATEGORIES
  if (!existingCats.includes(categoryName)) {
    const mergedCats = [...new Set([...existingCats, categoryName])].sort()
    await prisma.prepSettings.upsert({
      where: { id: 'singleton' },
      update: { categories: mergedCats },
      create: { id: 'singleton', categories: mergedCats, stations: [] },
    })
  }
}
```

- [ ] **Step 2: Type-check**

Run: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -6`
Expected: build succeeds. (If `recipe.prepItems` or `category` errors, confirm the relation names against `prisma/schema.prisma` — Recipe has `prepItems` and `category` relations.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/prep-sync.ts
git commit -m "feat(prep-sync): add syncPrepItemFromRecipe helper"
```

---

## Task 5: Refactor the bulk `/api/prep/sync-from-recipes` to reuse the helper

**Files:**
- Modify: `src/app/api/prep/sync-from-recipes/route.ts`

- [ ] **Step 1: Replace the handler body**

Replace the whole `export async function POST()` in `src/app/api/prep/sync-from-recipes/route.ts` with:

```ts
export async function POST() {
  const prepRecipes = await prisma.recipe.findMany({
    where: { type: 'PREP', isActive: true },
    select: { id: true, prepItems: { select: { id: true }, take: 1 } },
  })

  let created = 0
  for (const r of prepRecipes) {
    const hadPrepItem = r.prepItems.length > 0
    await syncPrepItemFromRecipe(r.id)
    if (!hadPrepItem) created++
  }

  return NextResponse.json({ created, synced: prepRecipes.length })
}
```

- [ ] **Step 2: Fix imports**

At the top of the file, ensure exactly these imports remain (drop now-unused `PREP_CATEGORIES` and any others the new body doesn't use):

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncPrepItemFromRecipe } from '@/lib/prep-sync'

export const dynamic = 'force-dynamic'
```

(Keep `export const dynamic = 'force-dynamic'` if it was already present; add it if not — this is a mutating route.)

- [ ] **Step 3: Type-check**

Run: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -6`
Expected: build succeeds; the route shows `ƒ (Dynamic)`.

- [ ] **Step 4: Verify the headless endpoint is still idempotent (read-mostly script)**

Create `scripts/_tmp_verify_prep_sync.ts`:

```ts
import { prisma } from '../src/lib/prisma'
import { syncPrepItemFromRecipe } from '../src/lib/prep-sync'
async function main() {
  const recipes = await prisma.recipe.findMany({ where: { type: 'PREP', isActive: true }, select: { id: true, name: true } })
  for (const r of recipes) await syncPrepItemFromRecipe(r.id)
  const items = await prisma.prepItem.count()
  const settings = await prisma.prepSettings.findUnique({ where: { id: 'singleton' } })
  console.log(`synced ${recipes.length} prep recipes; PrepItems now ${items}; categories ${settings?.categories.length ?? 0}`)
  // Second run must change nothing further (idempotent).
  for (const r of recipes) await syncPrepItemFromRecipe(r.id)
  console.log(`PrepItems after 2nd pass ${await prisma.prepItem.count()} (expect unchanged)`)
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
```

Run: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/_tmp_verify_prep_sync.ts 2>&1 | tail -5`
Expected: PrepItem count identical across the two passes (idempotent), no errors. Then delete the temp script: `rm -f scripts/_tmp_verify_prep_sync.ts`

- [ ] **Step 5: Commit**

```bash
git add src/app/api/prep/sync-from-recipes/route.ts
git commit -m "refactor(prep-sync): bulk sync-from-recipes reuses syncPrepItemFromRecipe"
```

---

## Task 6: Wire `syncPrepItemFromRecipe` into recipe create/edit

**Files:**
- Modify: `src/app/api/recipes/route.ts`
- Modify: `src/app/api/recipes/[id]/route.ts`

- [ ] **Step 1: Recipe create (POST)**

In `src/app/api/recipes/route.ts`, add the import `import { syncPrepItemFromRecipe } from '@/lib/prep-sync'`. In the `if (type === 'PREP') { ... }` block, right after the `await resyncPrepRecipe(recipe.id).catch(...)` line added in Task 2 Step 5, add:

```ts
    await syncPrepItemFromRecipe(recipe.id).catch(e => console.error('[recipe POST] prep-item sync', e))
```

- [ ] **Step 2: Recipe edit (PATCH)**

In `src/app/api/recipes/[id]/route.ts`, add the import `import { syncPrepItemFromRecipe } from '@/lib/prep-sync'`. After the `if (costAffecting) await resyncPrepRecipe(...)` line (Task 2 Step 3), add:

```ts
    // Keep the PrepItem task-row in step when its source fields change.
    const prepItemAffecting = name !== undefined || categoryId !== undefined || yieldUnit !== undefined
    if (prepItemAffecting) await syncPrepItemFromRecipe(params.id).catch(e => console.error('[recipe PATCH] prep-item sync', e))
```

- [ ] **Step 3: Type-check**

Run: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -6`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/recipes
git commit -m "feat(prep-sync): auto-sync PrepItem on recipe create/edit"
```

---

## Task 7: Remove the Prep "Sync from recipes" button

**Files:**
- Modify: `src/app/prep/page.tsx`

- [ ] **Step 1: Remove the desktop ⋯-menu item**

Delete this block (around lines 891-895):

```tsx
                    <button onClick={() => { setShowHeaderMenu(false); handleSync() }} disabled={syncing}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-ink-2 active:bg-bg-2 disabled:opacity-50" role="menuitem">
                      <BookOpen size={15} className={`text-gold ${syncing ? 'animate-pulse' : ''}`} />
                      {syncing ? 'Syncing…' : 'Sync from recipes'}
                    </button>
```

- [ ] **Step 2: Remove the toolbar button**

Delete this block (around lines 1023-1027):

```tsx
            <button onClick={handleSync} disabled={syncing}
              className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-[9px] border border-line bg-paper text-ink-2 text-[13px] font-medium hover:border-ink-3 transition-colors disabled:opacity-50 whitespace-nowrap">
              <BookOpen size={13} className={`text-ink-3 ${syncing ? 'animate-pulse' : ''}`} />
              {syncing ? 'Syncing…' : 'Sync from recipes'}
            </button>
```

- [ ] **Step 3: Remove the result banner**

Delete this block (around lines 1070-1080):

```tsx
      {syncResult && (
```
…through its closing `)}`. The banner is the `{syncResult && ( ... )}` JSX expression that renders "Created N new prep item(s)…" with the `setSyncResult(null)` close button. Remove the entire expression.

- [ ] **Step 4: Remove handler and state**

- Delete the `const handleSync = async () => { ... }` function (lines 341-354).
- Delete the two state lines (lines 46-47):
  ```ts
    const [syncing,      setSyncing]      = useState(false)
    const [syncResult,   setSyncResult]   = useState<{ created: number; updated: number; skipped: number } | null>(null)
  ```
- **Do NOT touch** `handleOfflineSync` / the "Sync now" button (line ~1063) / `handleRefresh` / `generating` — those are unrelated (offline queue + manual refresh).
- If the build (Step 5) reports `BookOpen` now unused, remove it from the lucide-react import; if still used elsewhere, leave it.

- [ ] **Step 5: Type-check**

Run: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -6`
Expected: build succeeds with no `syncing` / `syncResult` / `handleSync` undefined errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/prep/page.tsx
git commit -m "feat(prep-sync): remove manual Sync from recipes button (now automatic)"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Clean build**

Run: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build 2>&1 | tail -8`
Expected: build succeeds; `/api/prep/sync-from-recipes` and `/api/inventory/sync-prepd` both show `ƒ (Dynamic)`.

- [ ] **Step 2: Behavioral check — cost cascade through a nested prep**

Create `scripts/_tmp_verify_cascade.ts`:

```ts
import { prisma } from '../src/lib/prisma'
import { resyncPrepRecipe } from '../src/lib/recipeCosts'
import { asChainItem, pricePerBaseUnit, PRICING_SELECT } from '../src/lib/item-model'
async function main() {
  // Pick a PREP recipe that is used as an ingredient by another PREP (a cascade source).
  const consumed = await prisma.recipeIngredient.findFirst({
    where: { linkedRecipeId: { not: null }, recipe: { type: 'PREP' } },
    select: { linkedRecipeId: true, recipeId: true },
  })
  if (!consumed?.linkedRecipeId) { console.log('No nested-prep pair found to test cascade.'); await prisma.$disconnect(); return }
  await resyncPrepRecipe(consumed.linkedRecipeId)   // re-sync the sub-prep; should cascade to its consumer
  const consumer = await prisma.recipe.findUnique({ where: { id: consumed.recipeId }, select: { inventoryItemId: true } })
  if (consumer?.inventoryItemId) {
    const item = await prisma.inventoryItem.findUnique({ where: { id: consumer.inventoryItemId }, select: { itemName: true, ...PRICING_SELECT } })
    console.log(`Cascade OK — consumer "${item?.itemName}" ppb = ${item ? pricePerBaseUnit(asChainItem(item)) : 'n/a'}`)
  }
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
```

Run: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/_tmp_verify_cascade.ts 2>&1 | tail -5`
Expected: prints a consumer ppb with no error (the cascade ran). Then: `rm -f scripts/_tmp_verify_cascade.ts`

- [ ] **Step 3: Manual UI check (dev server)**

Use the preview workflow (preview_start, then navigate). Confirm:
- Inventory page: no "Sync PREPD" button (desktop and mobile widths).
- Prep page: no "Sync from recipes" item in the ⋯ menu or toolbar; the "Sync now" offline button and "Refresh" still present.

- [ ] **Step 4: Confirm no stray references remain**

Run: `grep -rn "syncAllPrepd\|syncingPrepd\|Sync PREPD\|Sync from recipes\|handleSync\b" src/app/inventory/page.tsx src/app/prep/page.tsx`
Expected: no matches.

- [ ] **Step 5: Final commit (if any cleanup was needed)**

```bash
git add -A
git commit -m "chore(prep-sync): verification cleanup" --allow-empty
```

---

## Notes for the implementer

- **Awaited + caught** is intentional everywhere: the await guarantees the inventory/prep state is consistent before the HTTP response; the `.catch(log)` guarantees a sync failure never turns a user's recipe edit into a 500. The two headless bulk endpoints (`/api/inventory/sync-prepd`, `/api/prep/sync-from-recipes`) remain the recovery path for the rare caught failure.
- **Do not delete** either bulk endpoint — they stay as headless repair/cron tools.
- **Out of scope:** the Count session "Sync" button; auto-deactivating orphaned PrepItems on recipe delete (delete still just nulls `linkedRecipeId`).
- The temp `scripts/_tmp_*` files are throwaway — never commit them.
