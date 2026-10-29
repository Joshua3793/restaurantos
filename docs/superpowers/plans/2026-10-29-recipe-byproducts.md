# Recipe By-products Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PREP recipe can list by-products ("Comes off this batch") that are credited at their own item price, so the recipe's cost — and every dish built on it — is ingredients − credits.

**Architecture:** New `RecipeByproduct` table (no price column). `computeRecipeCost` costs by-product lines with the same item-line maths as ingredients and returns `totalCost` = max(0, gross − credit), so every existing reader of `totalCost` (and `syncPrepToInventory`, hence the spine) gets the net for free. The few paths with their own query or sum are patched; propagation also follows by-product items. The editor gets a module-scope `ByproductsSection` that writes through three new per-row endpoints, like ingredients.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma 5 + Postgres (Supabase) · Tailwind (flat tokens only) · vitest.

**Spec:** `docs/superpowers/specs/2026-10-29-recipe-byproducts-design.md`

## Global Constraints

- Work in the worktree `/Users/joshua/dev/fergies-os-byproducts` on branch `feat/recipe-byproducts` (based on `origin/main` 066af981). Run `npm ci` there first — do **not** symlink the main checkout's `node_modules` (`prisma generate` would rewrite the main checkout's client; the main checkout is behind `origin/main`).
- No stored price anywhere: credit = item-line cost of the by-product item at read time.
- PREP recipes only. By-product item must be a plain `InventoryItem`: not a prep output (`recipe` relation null), not the recipe's own output, active, not merged (`mergedIntoId` null).
- Writes (`POST`/`PATCH`/`DELETE` by-products, price edit) require `requireSession('MANAGER')`; reads follow the recipe routes as they are today (no money redaction added).
- Guard copy, exact: `Credits ${X} are more than the batch costs ${Y} — check the weights` where X, Y are `formatCurrency` strings (e.g. `Credits $30.00 are more than the batch costs $25.00 — check the weights`).
- The server guard is computed on the LAST basis (the stored spine number). The editor computes on AVG_30D as today. Do not try to align the two.
- New route files `export const dynamic = 'force-dynamic'`.
- Tailwind: flat colour tokens only (`bg-red`, `text-ink-3`, …) — numbered classes are broken in this repo.
- Helper components at module scope, never inside a component body.
- Prisma `Decimal` → `Number()` before maths.
- Every DB migration and every live-data change needs Joshua's yes at that moment. Applying the new table to the live database is Task 1 Step 6 and is the first such stop.
- After every task: `npm test` green; after Tasks 3, 5, 6, 7: `npm run build` green (all API routes `ƒ (Dynamic)`).

## Review Focus

1. **Ingredient edit pushes credits past cost** (chef lowers Brisket AAA from 13 kg to 1 kg) — the edit saves, `totalCost` floors at $0.00, `creditExceedsCost` is true, the editor shows the red guard line. Test: Task 2 `floors net at zero and flags it`.
2. **By-product priced per each but entered in kg** (dimension conflict) — credit is $0 with the same conflict warning an ingredient shows, never a garbage number. Test: Task 2 `dimension-conflicted by-product credits zero`.
3. **By-product item with no price** — credit $0, row asks "What would you pay per kg?", never a silent $0. Test: Task 2 `unpriced by-product is flagged`; UI check in Task 7.
4. **The by-product's price changes elsewhere** (inventory edit, invoice approve, supplier box) — Smoked Brisket re-costs and the sandwich follows. Test: Task 4 `by-product price change re-syncs the producing recipe`.
5. **Optimistic editor totals after an ingredient edit/delete** — the panel shows the net, not Σ lineCost. Test: Task 7 Step 2 browser check (edit an ingredient qty on a recipe with a by-product; total stays net).

---

### Task 1: The `RecipeByproduct` table

**Files:**
- Modify: `prisma/schema.prisma` (models `Recipe`, `InventoryItem`, new `RecipeByproduct`)
- Create: `prisma/migrations/20261029000000_recipe_byproducts/migration.sql`

**Interfaces:**
- Produces: Prisma model `RecipeByproduct { id String @id @default(uuid()); recipeId String; inventoryItemId String; qty Decimal; unit String; sortOrder Int @default(0); notes String?; createdAt DateTime @default(now()) }`, `recipe Recipe @relation("RecipeByproducts", fields: [recipeId], references: [id], onDelete: Cascade)`, `inventoryItem InventoryItem @relation("RecipeByproductItem", fields: [inventoryItemId], references: [id])` (Restrict), `@@index([recipeId])`, `@@index([inventoryItemId])`. Back-relations: `Recipe.byproducts RecipeByproduct[] @relation("RecipeByproducts")`, `InventoryItem.recipeByproducts RecipeByproduct[] @relation("RecipeByproductItem")`.

- [ ] **Step 1:** `cp /Users/joshua/dev/fergies-os/.env /Users/joshua/dev/fergies-os-byproducts/.env && cd /Users/joshua/dev/fergies-os-byproducts && npm ci` — expect postinstall to run `prisma generate` cleanly. `.env` is git-ignored; never commit it.
- [ ] **Step 2:** Add the model and back-relations above to `prisma/schema.prisma`.
- [ ] **Step 3:** Generate the SQL without the shadow DB (it is broken here — P3006). Load env (`set -a && . ./.env; set +a`; `.env` is copied from the main checkout, not symlinked), build the session-mode pooler URL from `$DATABASE_URL` (port 6543→5432, drop `pgbouncer` param), then `npx prisma migrate diff --from-url "$SESSION_URL" --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/20261029000000_recipe_byproducts/migration.sql`. Expected: only `CREATE TABLE "RecipeByproduct"`, two indexes, two FKs. If anything else appears, stop — that is drift, not this change.
- [ ] **Step 4:** `npx prisma generate` and `npm run build` — expect green.
- [ ] **Step 5:** Commit: `git commit -m "feat(recipes): RecipeByproduct table"`.
- [ ] **Step 6 (⚠️ live — stop for Joshua's yes):** apply with `npx prisma db execute --url "$SESSION_URL" --file prisma/migrations/20261029000000_recipe_byproducts/migration.sql`, then `DIRECT_URL="$SESSION_URL" npx prisma migrate resolve --applied 20261029000000_recipe_byproducts`. Additive table only; nothing existing changes. Can be deferred until just before merge — Tasks 2–6 use mocked Prisma.

### Task 2: By-product costing in `computeRecipeCost`

**Files:**
- Create: `src/lib/recipe-byproducts.ts`
- Modify: `src/lib/recipeCosts.ts` (`computeRecipeCost`, `IngredientWithCost`, `RecipeWithCost`)
- Test: `src/lib/__tests__/recipe-byproducts.test.ts` (new), `src/lib/__tests__/recipeCosts.test.ts`

**Interfaces:**
- Produces in `src/lib/recipe-byproducts.ts` (pure, no Prisma import):
  - `export interface ByproductWithCredit { id: string; sortOrder: number; inventoryItemId: string; itemName: string; qty: number; unit: string; notes: string | null; itemBaseUnit: string; pricePerBaseUnit: number; credit: number; dimensionConflict: boolean; costBasis: CostBasis; unpriced: boolean }`
  - `export function netCost(gross: number, credit: number): number` → `Math.max(0, gross - credit)`
  - `export function creditGuardMessage(credit: number, gross: number): string` → the exact Global Constraints copy, using `formatCurrency` from `@/lib/utils`.
  - `export function yieldBreakdown(r: { ingredients: Array<{ qtyBase: number; unit: string; ingredientType: 'inventory' | 'recipe' | 'custom' }>; baseYieldQty: number; yieldUnit: string; byproducts: Array<{ itemName: string; qty: number; unit: string }> }): { input: number; main: number; parts: Array<{ name: string; qty: number }>; lost: number; overflow: boolean } | null` — all quantities in grams; MASS and VOLUME lines both counted, ml treated as g (the app's density≈1 kitchen convention); COUNT lines and units that are not MASS/VOLUME are skipped; returns `null` when the yield unit is not MASS/VOLUME or there are no by-products. `lost = input − main − Σparts` (may be negative); `overflow = main + Σparts > input × 1.02`.
- Produces in `src/lib/recipeCosts.ts`:
  - `computeRecipeCost(recipe, opts)` input gains `byproducts?: Array<{ id: string; sortOrder: number; qty: Numeric; unit: string; notes: string | null; inventoryItemId: string; inventoryItem: { itemName: string; baseUnit: string; densityGPerMl?: unknown } & Parameters<typeof asChainItem>[0] }>`; return gains `grossCost: number; byproductCredit: number; creditExceedsCost: boolean; byproducts: ByproductWithCredit[]`; `totalCost` becomes `netCost(grossCost, byproductCredit)`; `costPerPortion`/`foodCostPct` use the net.
  - `RecipeWithCost` gains the same four fields.
  - `IngredientWithCost` gains `byproductOf: string | null` (filled in Task 3; `null` here).

- [ ] **Step 1: Write failing tests** in `recipeCosts.test.ts`, reusing the `ing()`/`recipe()` builders and adding a `bp(overrides)` builder:
  - `credits a by-product at its item price and nets the total`: ingredients 13 kg of an item at $19.70/kg (RATE) → gross 256.10; by-products 2 kg @ $10.00/kg + 1.5 kg @ $3.50/kg → `byproductCredit` ≈ 25.25, `totalCost` ≈ 230.85, `grossCost` ≈ 256.10, `creditExceedsCost` false.
  - `floors net at zero and flags it`: gross 25, credit 30 → `totalCost` 0, `creditExceedsCost` true.
  - `dimension-conflicted by-product credits zero`: by-product item COUNT/each with no each-measure, entered `2 kg` → `credit` 0, `dimensionConflict` true.
  - `unpriced by-product is flagged`: item with `{ mode: 'PACK', purchasePrice: 0 }` → `credit` 0, `unpriced` true.
  - `uses the AVG price map for by-products`: `opts.prices` has the by-product item id at a different price → credit uses it, `costBasis` `'AVG_30D'`.
  - `no by-products is byte-identical`: omitting `byproducts` → `grossCost === totalCost`, `byproductCredit === 0`, `byproducts` `[]`.
- [ ] **Step 2:** Write `recipe-byproducts.test.ts`: `netCost`, `creditGuardMessage(30, 25)` equals `'Credits $30.00 are more than the batch costs $25.00 — check the weights'`, and `yieldBreakdown` for Smoked Brisket (13 kg + 300 g ingredients, 6 kg yield, 2 kg + 1.5 kg by-products → input 13300, main 6000, lost 3800, overflow false), a count-yield recipe → `null`, and an overflow case (yield 10 kg from 9 kg in → overflow true).
- [ ] **Step 3:** Run `npx vitest run src/lib/__tests__/recipeCosts.test.ts src/lib/__tests__/recipe-byproducts.test.ts` — expect FAIL.
- [ ] **Step 4:** Implement. Extract the existing inventory-item branch of the ingredient map into a module-private `costItemLine(item, itemId, qty, unit, prices)` returning `{ pricePerBaseUnit, costBasis, dimensionConflict, lineCost }` and use it for both ingredients and by-products, so the two can never cost differently. `basisSummary` counts ingredient lines only (unchanged).
- [ ] **Step 5:** Run the two test files, then `npm test` — expect PASS, no other test changed.
- [ ] **Step 6:** Commit `feat(recipes): credit by-products in recipe cost`.

### Task 3: Load by-products everywhere a recipe is costed

**Files:**
- Modify: `src/lib/recipeCosts.ts` (`RECIPE_COST_INCLUDE`, `prefetchRecipes`, `fetchRecipeWithCost`), `src/app/api/recipes/route.ts` (list GET include + id collection), `src/app/api/search/route.ts` (include)
- Test: `src/lib/__tests__/recipeCosts.test.ts`, `src/lib/__tests__/recipe-basis.test.ts`

**Interfaces:**
- Consumes: Task 2 `computeRecipeCost` `byproducts` input.
- Produces:
  - `export const BYPRODUCT_COST_INCLUDE` (in `recipeCosts.ts`) = `{ include: { inventoryItem: { select: { itemName: true, lastUpdated: true, ...PRICING_SELECT, _count: { select: { supplierPrices: true } }, supplierPrices: { where: { isPrimary: true }, select: { supplier: { select: { name: true } } }, take: 1 } } } }, orderBy: { sortOrder: 'asc' } }` — used as `byproducts: BYPRODUCT_COST_INCLUDE` in `RECIPE_COST_INCLUDE`, the list GET include and the search include.
  - `ByproductWithCredit` (Task 2) gains UI-only fields filled by `fetchRecipeWithCost`/list: `itemLastUpdated: string; itemPackChain: unknown; itemPricing: unknown; hasOffers: boolean; primarySupplierName: string | null` — make them optional on the pure type so Task 2 tests stay valid.
  - Ingredient `inventoryItem` select gains `recipeByproducts: { select: { recipe: { select: { name: true } } }, take: 1 }`; `computeRecipeCost` sets `byproductOf` from it (`null` when none).
  - `fetchRecipeWithCost(id, opts)` opts gain `editByproducts?: (rows: ByproductCostRow[]) => ByproductCostRow[]` where `type ByproductCostRow = RecipeCostRow['byproducts'][number]`, exported. Applied before costing; when present the result is NOT memoised. Used by Task 5's guard.

- [ ] **Step 1: Failing tests:**
  - `fetchRecipeWithCost returns net cost and by-product lines` (mock `recipe.findUnique` returning a row with `byproducts`) → `totalCost` net, `byproducts[0].credit`, `hasOffers` false.
  - In `recipe-basis.test.ts`: `AVG basis prices by-product items from the window` — the by-product item id is passed to `windowedAvgCost` (both via `costContext` raw ids and via the `prefetchRecipes` missing-ids path).
  - `editByproducts overrides the loaded rows and skips the memo`.
  - `syncPrepToInventory writes the net` — extend the existing sync test fixture with a by-product; assert `pricing.purchasePrice` equals the net.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement: add by-product item ids to `rawIds` in `fetchRecipeWithCost`, to the `missing` collection in `prefetchRecipes`, and to `pageIds` in the list GET. Map the UI-only fields in `fetchRecipeWithCost` and the list GET. Add `grossCost`, `byproductCredit`, `creditExceedsCost`, `byproducts` to the hand-built `RecipeWithCost` result (the comment there warns that unlisted fields vanish).
- [ ] **Step 4:** `npm test` and `npm run build` — expect PASS.
- [ ] **Step 5:** Commit `feat(recipes): load by-products on every recipe cost read`.

### Task 4: Re-cost when a by-product's price moves

**Files:**
- Modify: `src/lib/recipeCosts.ts` (`propagatePrepCostChanges`), `src/lib/recipe-costs.ts` (`recalculateRecipeCosts`)
- Test: `src/lib/__tests__/recipeCosts.test.ts` (graph test block), new `src/lib/__tests__/recipe-costs-alerts.test.ts` if none exists

**Interfaces:**
- Consumes: Task 1 relation `Recipe.byproducts`.
- Produces: no new exports; `propagatePrepCostChanges` and `recalculateRecipeCosts` behaviour only.

- [ ] **Step 1: Failing tests:**
  - `by-product price change re-syncs the producing recipe`: graph fixture where recipe R (output O) has ingredient X and by-product T; seed `[T]` → R is re-synced, O returned as moved when its price changes.
  - `recalculateRecipeCosts subtracts credits`: recipe with ingredient qty×cur = 100 and by-product qty×cur = 20 → new total 80 used for `changePct`; a recipe reached only through a by-product id is included.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement: in `propagatePrepCostChanges` select `byproducts: { select: { inventoryItemId: true } }` and `addConsumer(bp.inventoryItemId, r.id)`. In `recalculateRecipeCosts`, find affected recipe ids from both `recipeIngredient` and `recipeByproduct`, include `byproducts` with `inventoryItem: { select: { id: true, ...PRICING_SELECT } }`, and subtract `qty × price` (old and new, same crude no-conversion style the function already uses) — then floor each total at 0 via `netCost`.
- [ ] **Step 4:** `npm test` — expect PASS.
- [ ] **Step 5:** Commit `feat(recipes): by-product price changes re-cost the batch they come off`.

### Task 5: By-product endpoints

**Files:**
- Create: `src/app/api/recipes/[id]/byproducts/route.ts` (POST), `src/app/api/recipes/[id]/byproducts/[bpId]/route.ts` (PATCH, DELETE)
- Test: `src/app/api/recipes/__tests__/byproducts.test.ts`

**Interfaces:**
- Consumes: `fetchRecipeWithCost(id, { editByproducts })` (Task 3), `creditGuardMessage` (Task 2), `resyncPrepRecipe`, `assertKnownUnit`, `requireSession`.
- Produces:
  - `POST /api/recipes/[id]/byproducts` body `{ inventoryItemId: string; qty: number; unit: string; notes?: string } | { createItem: { itemName: string; rate: number }; qty: number; unit: string }` → 201 with `fetchRecipeWithCost(id, { basis: 'AVG_30D' })`.
  - `PATCH /api/recipes/[id]/byproducts/[bpId]` body `{ qty?: number; unit?: string; notes?: string | null; sortOrder?: number }` → 200 with the same.
  - `DELETE /api/recipes/[id]/byproducts/[bpId]` → 200 with the same.
  - Error codes (JSON `{ error, code }`, 400 unless noted): `NOT_PREP`, `NOT_FOUND` (404), `PREP_OUTPUT` ("{name} is made by a recipe — only plain items can come off a batch."), `OWN_OUTPUT`, `INACTIVE_ITEM`, `BAD_UNIT`, `BAD_QTY` (qty must be > 0), `CREDIT_EXCEEDS` (message = `creditGuardMessage`), `DUPLICATE` (same item already listed on this recipe — edit that row instead).

- [ ] **Step 1: Failing tests** (mock Prisma + `requireSession` like `delete-guard.test.ts`):
  - `rejects below MANAGER` (403 from `AuthError`).
  - `rejects a MENU recipe` (`NOT_PREP`).
  - `rejects a prep output item` (`PREP_OUTPUT`) and `the recipe's own output` (`OWN_OUTPUT`).
  - `rejects a duplicate item` (`DUPLICATE`).
  - `rejects credits above the batch cost` — `editByproducts` preview (LAST basis) returns credit 30 vs gross 25 → 400 `CREDIT_EXCEEDS` with the exact copy; nothing written.
  - `creates the row, resyncs and returns the recipe` — `resyncPrepRecipe` called once with the recipe id.
  - `createItem makes a not-counted plain item in the recipe's kitchen`: `inventoryItem.create` called with `isStocked: false`, `dimension` from the unit (`kg` → `MASS`), `baseUnit` canonical (`g`), `countUnit` = the unit, `packChain: []`, `pricing: { mode: 'RATE', rate, rateUnit: unit }`; and `itemRevenueCenter.create` with the recipe's `revenueCenterId` when it is set.
  - `PATCH re-checks the guard with the edited qty`; `DELETE never trips the guard`.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement. Order inside POST/PATCH: auth → load recipe (`type`, `inventoryItemId`, `revenueCenterId`) → validate item/unit/qty → LAST-basis preview via `fetchRecipeWithCost(id, { editByproducts })` → guard → write → `resyncPrepRecipe(id).catch(log)` → respond. A `createItem` write and the by-product row go in one `prisma.$transaction`. Check that `packChain: []` with RATE pricing is accepted by `validateChainItem` for a MASS item; if it is not, use `[{ unit, per: getUnitConv(unit) }]`.
- [ ] **Step 4:** `npm test` and `npm run build` — PASS, new routes `ƒ (Dynamic)`.
- [ ] **Step 5:** Commit `feat(recipes): by-product endpoints with the credit guard`.

### Task 6: Write paths that must carry by-products

**Files:**
- Modify: `src/app/api/recipes/[id]/save-scale/route.ts`, `src/app/api/recipes/[id]/scale/route.ts`, `src/lib/item-merge.ts`, `src/lib/item-merge-exec.ts` (and wherever `REPOINT_FK` / `TABLE_DELEGATE` are defined — grep), `src/app/api/inventory/[id]/route.ts` (DELETE blockers)
- Test: `src/lib/__tests__/item-merge.test.ts`, `src/lib/__tests__/item-merge-rows.test.ts`, existing save-scale / inventory delete tests if present, else add cases beside them

**Interfaces:**
- Consumes: Task 1 relations.
- Produces: `RepointTable` gains `'RecipeByproduct'`; `MergeRelations` gains `recipeByproductIds: string[]`.

- [ ] **Step 1: Failing tests:**
  - save-scale: `copies by-products scaled by the factor` (×2 → 4 kg trim on the copy).
  - scale preview: by-product `qty` and `credit` multiplied by the factor in the response.
  - merge: `repoints by-product rows to the survivor` (plan contains a `RecipeByproduct` repoint op with the absorbed rows' ids; undo reverses it like `RecipeIngredient`).
  - inventory DELETE: an item that is a by-product is blocked with `comes off ${n} recipe batch${n > 1 ? 'es' : ''}` in `blockers`.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement each, mirroring the `RecipeIngredient` handling in the same file. Load by-product ids in the merge executor's relation loader with `db.recipeByproduct.findMany({ where: w, select: { id: true } })`.
- [ ] **Step 4:** `npm test` and `npm run build` — PASS.
- [ ] **Step 5:** Commit `feat(recipes): scale, merge and delete carry by-products`.

### Task 7: The "Comes off this batch" box in the recipe editor

**Files:**
- Create: `src/components/recipes/ByproductsSection.tsx`
- Modify: `src/components/recipes/shared.tsx` (`Recipe` type, `RecipePanel` optimistic totals at `updateIngredient`/`deleteIngredient`/`substituteIngredient`, totals box, dark cost strip PREP branch, `IngredientRow` tag)

**Interfaces:**
- Consumes: Task 3/5 response shape (`byproducts: ByproductWithCredit[]`, `grossCost`, `byproductCredit`, `creditExceedsCost`), `yieldBreakdown`, `netCost`, `creditGuardMessage` (Task 2), `PATCH /api/inventory/[id]/pricing` (existing; body `{ packChain, pricing, expectedLastUpdated }`, 409 codes `HAS_OFFERS`, `STALE`, `PREP_OWNED`).
- Produces: `export function ByproductsSection(props: { recipe: Recipe; onRecipe: (r: Recipe) => void; onDirty: () => void }): JSX.Element` — module scope; renders nothing for MENU recipes.

- [ ] **Step 1:** Build `ByproductsSection` per the spec's "The editor (UX)" section:
  - Empty state: one quiet line `+ Something else comes off this batch (fat, trim, bones…)`.
  - Rows: item name · qty input · unit select (same compatible-unit groups as `IngredientRow`) · price `"$10.00/kg"` (editable when `!hasOffers`, read-only `"$10.00/kg · {primarySupplierName}"` when it has offers; shown per the row's unit = `pricePerBaseUnit × getUnitConv(unit)`) · credit `−$20.00` in green · ✕. Unpriced row: price input with placeholder `What would you pay per {unit}?`. Dimension conflict: same warning text and style `IngredientRow` uses.
  - Add: reuse `/api/recipes/search-ingredients`, show `type === 'inventory'` results only, unit defaults to the recipe's `yieldUnit`; a `Create "{query}"` option posts `createItem` (rate from the row's price input, required).
  - Price edit: `PATCH /api/inventory/{itemId}/pricing` with the item's `itemPackChain`, `{ mode: 'RATE', rate, rateUnit: row.unit }`, `itemLastUpdated`; on 409 show the server's `error`, then reload the recipe.
  - Yield bar from `yieldBreakdown` (hidden when `null`): segments main / each part / lost; red with `More comes out than goes in — check the weights.` when `overflow`.
  - Summary line `Ingredients {gross} − credits {credit} = {net} · {net ÷ baseYieldQty}/{yieldUnit}`; red guard line from `creditGuardMessage` when `creditExceedsCost`.
  - Server error on add/edit (`CREDIT_EXCEEDS` etc.) shows under the row; the row keeps the typed value until fixed or cancelled.
  - Every successful write replaces the panel's recipe with the response (`onRecipe`) and calls `onDirty`.
- [ ] **Step 2:** In `RecipePanel`: mount `<ByproductsSection>` directly under the ingredient list (PREP only); change the three optimistic totals to `totalCost: netCost(Σ lineCost, prev.byproductCredit ?? 0)` and set `grossCost` alongside; the bottom totals box and the dark cost strip read the net (already `totalCost`) and the strip shows `incl. −{credit} by-products` when credit > 0. In `IngredientRow`, when `ing.byproductOf` is set, a small tag `comes off {byproductOf}`.
- [ ] **Step 3: Verify in the browser** (preview server from this worktree; local DB writes go to the live DB, so use a throwaway TEST prep recipe, never Smoked Brisket, and switch it off/delete it afterwards — ⚠️ ask Joshua before creating it): add a by-product, see credit + net + yield bar; edit qty; edit an ingredient qty and confirm the total stays net (Review Focus 5); enter a credit above cost and see the guard; check phone width (375 px) stacks cleanly; screenshot.
- [ ] **Step 4:** `npm test`, `npm run lint`, `npm run build` — PASS.
- [ ] **Step 5:** Commit `feat(recipes): Comes off this batch box in the recipe editor`.

### Task 8: Finish

- [ ] **Step 1 (⚠️ live — stop for Joshua's yes):** Beef Tallow's ingredient line "1300 each Beef Fat Trim" → unit `g` (qty unchanged), through `PATCH /api/recipes/{tallowId}/ingredients/{lineId}` logic or a one-off script that writes a JSON backup first in the repo root like earlier repairs. Cost must stay $4.55.
- [ ] **Step 2:** Full review of the branch (superpowers:requesting-code-review), fix findings.
- [ ] **Step 3:** Update `CLAUDE.md` "Recipe costing" + "Mutators/Readers" with one paragraph on by-products (credit = item-line cost, net = `totalCost`, propagation by by-product), and add the spec's "As built" notes.
- [ ] **Step 4:** Open the PR; Joshua decides merge (merge = live).
