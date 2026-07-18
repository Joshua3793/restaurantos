# Custom (uncosted) recipe ingredients — design

**Date:** 2026-07-17
**Status:** Approved, ready for implementation plan

## Problem

Every ingredient in a recipe or menu item today **must** resolve to an `InventoryItem` or a
linked PREP `Recipe`. This is enforced in three places:

- the POST route rejects a line unless exactly one of `inventoryItemId` / `linkedRecipeId` is set
  ([src/app/api/recipes/[id]/ingredients/route.ts](../../../src/app/api/recipes/%5Bid%5D/ingredients/route.ts));
- the cost engine only names/costs a line if it has an `inventoryItem` or `linkedRecipe`
  ([src/lib/recipeCosts.ts:107](../../../src/lib/recipeCosts.ts));
- the ingredient search only lets you add things that came back from `/api/recipes/search-ingredients`.

But real recipes contain elements that don't need to be costed and aren't (or shouldn't be) in
inventory — garnishes, "to taste" seasonings, plating notes-as-ingredients. There's no way to record
them. The user wants: when a typed ingredient doesn't match inventory, an **"Add anyway"** option that
adds the line **exactly as typed**, uncosted, affecting nothing else, but visible as part of the recipe.

## Solution overview

Introduce a **third kind** of `RecipeIngredient` row — a **custom** line: a free-text name, an optional
quantity, and a **free-form unit**, that costs `$0` and is skipped by every cost calculation. It exists
purely for visibility on the recipe.

A row's kind is determined by which fields are set:

| Kind | `inventoryItemId` | `linkedRecipeId` | `customName` |
|------|------------------|------------------|--------------|
| inventory | set | null | null |
| recipe | null | set | null |
| **custom** | null | null | **set** |

## 1. Data model

Add one nullable column to `RecipeIngredient` ([prisma/schema.prisma:200](../../../prisma/schema.prisma)):

```prisma
customName  String?
```

No other schema change. Existing rows are unaffected (`customName` defaults to null → still
inventory/recipe lines).

**Migration:** `migrate dev` is broken against this project's pooler shadow DB (P3006). Apply the
column with the established workaround — hand-write the `ALTER TABLE "RecipeIngredient" ADD COLUMN
"customName" TEXT;` migration SQL, run it with `prisma db execute --file … --url $DIRECT_URL`, then
`prisma migrate resolve --applied <migration>` and `prisma generate`. (This is a pure additive nullable
column, so it is safe.)

## 2. Cost engine — `computeRecipeCost`

In the `.map` over ingredients ([src/lib/recipeCosts.ts:93](../../../src/lib/recipeCosts.ts)), add a
third branch after the `inventoryItem` / `linkedRecipe` branches:

```ts
} else if (ing.customName) {
  ingredientName     = ing.customName
  ingredientType     = 'custom'
  pricePerBaseUnit   = 0
  lineCostQty        = 0
  ingredientBaseUnit = ing.unit
  // dimensionConflict stays false; allergens stays []
}
```

Result: `lineCost = 0`, contributes nothing to `totalCost`, `foodCostPct`, `dimensionConflicts`, or the
recipe allergen set. Add `customName` to the Prisma `select` in `fetchRecipeWithCost` so the field is
loaded. The `linkedRecipeUnitCost` / allergen-aggregation paths need no change (custom lines have no
allergens and no linked cost).

## 3. Types

`ingredientType` widens from `'inventory' | 'recipe'` to `'inventory' | 'recipe' | 'custom'` in both:

- `IngredientWithCost` in [src/components/recipes/shared.tsx:80](../../../src/components/recipes/shared.tsx)
- `IngredientWithCost` in [src/lib/recipeCosts.ts:21](../../../src/lib/recipeCosts.ts)

## 4. API routes

**POST** `/api/recipes/[id]/ingredients` — relax the "exactly one of inventoryItemId/linkedRecipeId"
guard to also accept a custom line: `{ customName, qtyBase?, unit? }` with both IDs null. For a custom
line:

- **skip `assertKnownUnit`** — store the `unit` string exactly as typed (may be empty, `"sprig"`,
  `"to taste"`, etc.);
- store `customName` (trimmed); reject if a custom line has an empty `customName`;
- default `qtyBase` to `0` when omitted.

**PATCH** `/api/recipes/[id]/ingredients/[ingredientId]` — detect whether the target row is custom
(fetch the row, or infer from the payload) and:

- when custom, **skip `assertKnownUnit`** on unit changes (store raw), and allow editing `customName`;
- when a substitute payload arrives (`inventoryItemId` or `linkedRecipeId` set), **null `customName`**
  so the line is promoted to a normal costed line (see §6).

`resyncPrepRecipe` continues to run on both routes — a `$0` custom line changes nothing downstream.

## 5. Search UI — "Add anyway"

Shared `RecipePanel` search box ([src/components/recipes/shared.tsx:1515](../../../src/components/recipes/shared.tsx))
— used by **both** Recipe Book and Menu — plus the nested `PrepRecipeModal` search box
([src/components/recipes/shared.tsx:1752](../../../src/components/recipes/shared.tsx)).

Today the dropdown only renders when `searchResults.length > 0`, so a no-match query shows nothing.
Change both to render whenever there is a non-empty query, and append a persistent action row at the
bottom of the list:

> `+ Add "<query>" as a custom ingredient` — no cost

- appears **alongside** real matches (lets you override a weak match), and
- is the **sole** row when nothing matches.

Clicking it calls a new `addCustomIngredient(name)` that mirrors the existing optimistic `addIngredient`
pattern: insert a temp-id row with `ingredientType: 'custom'`, `qtyBase: 0`, `unit: ''`,
`pricePerBaseUnit: 0`, `lineCost: 0`, `ingredientName: name`; POST
`{ customName: name, qtyBase: 0, unit: '' }`; reconcile the real id on success, remove on failure.

## 6. Row rendering — custom lines

**`IngredientRow`** ([src/components/recipes/shared.tsx:645](../../../src/components/recipes/shared.tsx)):
when `ing.ingredientType === 'custom'`, render a **dimmed / italic** row —

- name shown plainly in muted text (no inventory link, no "Recipe" pill);
- quantity cell stays inline-editable (existing qty editor);
- unit cell becomes a **free-text `<input>`** (placeholder `unit`) instead of the UOM `<select>`, so any
  string can be typed and PATCHed;
- **cost column empty** — no `$`, no dimension-conflict pill;
- baker's-% column shows `—`; no allergen pills; no "Needs qty" tag;
- delete control stays;
- **substitute pencil stays** — picking a real inventory/recipe match nulls `customName` and promotes
  the line in place to a costed ingredient (§4 PATCH).

**`PrepIngredientRow`** ([src/components/recipes/shared.tsx:1796](../../../src/components/recipes/shared.tsx)):
same treatment, scaled to its simpler layout — muted name, free-text unit input, empty cost cell, delete
kept. (No substitute pencil exists here today; none is added.)

## 7. Scope

- **In scope:** shared `RecipePanel` (Recipe Book + Menu) and the nested `PrepRecipeModal`.
- The inline substitute-only search inside `IngredientRow` is unchanged (it replaces an existing line;
  "add anyway" is an *add* affordance).

## 8. Testing

- **vitest** (`src/lib/__tests__/recipeCosts` or nearest): a recipe with one inventory line and one
  custom line — assert the custom line yields `lineCost === 0`, `ingredientType === 'custom'`,
  `ingredientName` equals the typed string; and that `totalCost`, `dimensionConflicts`, and the
  aggregated allergen set are identical to the same recipe without the custom line.
- **`npm run build`** — type-check the widened `ingredientType` union across both files.
- **`npm test`** — full pure-cost-math suite stays green.

## Non-goals (YAGNI)

- No costing, allergen entry, or nutrition on custom lines.
- No PREP→inventory effect (a `$0` line already changes nothing in `syncPrepToInventory`).
- No conversion of existing inventory items into custom lines beyond the substitute-promote path.
- No new search endpoint — "add anyway" is entirely client-driven off the typed query.
