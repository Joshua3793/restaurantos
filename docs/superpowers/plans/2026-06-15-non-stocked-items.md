# Non-Stocked Items (`isStocked`) Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement task-by-task. Steps use `- [ ]`.

**Goal:** Add `isStocked` to `InventoryItem` so recipe-only utility ingredients (tap water) stay usable in recipes at $0 but drop out of counts, valuation, theoretical stock, purchasing, and the default inventory list.

**Architecture:** One boolean column (default true). 21 operational readers add `isStocked: true`; 3 recipe/search readers stay unfiltered. Inventory GET gains an `includeNonStocked` param; the page gets a toggle. Write path pins `pricePerBaseUnit=0` when not stocked.

**Tech Stack:** Next.js 14 App Router, Prisma + Postgres (Supabase), TypeScript. Gate = `npm run build` (no test suite). Node on PATH: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"`.

---

### Task 1: Schema + migration

**Files:** Modify `prisma/schema.prisma` (model `InventoryItem`, ~line 89 near `isActive`); migration SQL.

- [ ] **Step 1:** Add to `model InventoryItem`, beside `isActive`:
```prisma
  isStocked          Boolean   @default(true)
```
- [ ] **Step 2:** Apply to the live DB without `prisma migrate dev` (broken — P3006). Create the migration via diff + db execute + resolve:
```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
cd /Users/joshua/dev/fergies-os
mkdir -p prisma/migrations/20260615000000_add_is_stocked
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > /tmp/d.sql  # sanity only
printf 'ALTER TABLE "InventoryItem" ADD COLUMN "isStocked" BOOLEAN NOT NULL DEFAULT true;\n' > prisma/migrations/20260615000000_add_is_stocked/migration.sql
npx prisma db execute --file prisma/migrations/20260615000000_add_is_stocked/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied 20260615000000_add_is_stocked
npx prisma generate
```
- [ ] **Step 3:** `npm run build` → Compiled successfully (Prisma client now types `isStocked`).
- [ ] **Step 4:** Commit `prisma/schema.prisma` + the migration dir.

---

### Task 2: Write path — accept `isStocked`, force $0

**Files:** `src/app/api/inventory/route.ts` (POST), `src/app/api/inventory/[id]/route.ts` (PUT), `src/components/inventory/InventoryItemDrawer.tsx`.

- [ ] **Step 1:** In POST and PUT, after computing `pricePerBaseUnit`, derive the stocked flag and override price:
```ts
const isStocked = body.isStocked !== false   // default true
const finalPPB = isStocked ? pricePerBaseUnit : 0
```
Store `isStocked` and use `finalPPB` for `pricePerBaseUnit` in the `data` object. (`isStocked` may also arrive via `...rest`; set it explicitly after the spread so the normalized value wins, same pattern as `purchaseUnit`.)
- [ ] **Step 2:** In `InventoryItemDrawer.tsx`, add an `isStocked` field to the edit form state (default from the item, fallback `true`) and a toggle labelled **"Not stocked (recipe-only)"** (checked = `!isStocked`). Include `isStocked` in the PUT/POST payload.
- [ ] **Step 3:** `npm run build` green. Commit.

---

### Task 3: Filter operational readers (`isStocked: true`)

**Files (add `isStocked: true` to the `where`):**
- `src/app/api/count/sessions/route.ts:52`
- `src/app/api/count/areas/route.ts:18`
- `src/app/api/count/sessions/[id]/sync/route.ts:27`
- `src/app/api/insights/cost-chrome/route.ts:51`
- `src/app/api/insights/spine-audit/route.ts:27`
- `src/app/api/reports/dashboard/route.ts:27`
- `src/app/api/reports/cogs/route.ts:30` and `:106` (add `where: { isStocked: true }` to the bare `findMany()`)
- `src/app/api/reports/analytics/route.ts:57` and `:242`
- `src/app/api/reports/inventory-efficiency/route.ts:24`
- `src/lib/count-expected.ts:447` (`getTheoreticalStockMap` item fetch)

- [ ] **Step 1:** For each site, add `isStocked: true` alongside the existing `isActive: true` (or as the sole filter where none exists). Do NOT touch single-item `findUnique` calls.
- [ ] **Step 2:** `npm run build` green.
- [ ] **Step 3:** Commit.

---

### Task 4: Inventory list + page toggle

**Files:** `src/app/api/inventory/route.ts` (GET), `src/app/inventory/page.tsx`.

- [ ] **Step 1:** In GET, read `const includeNonStocked = searchParams.get('includeNonStocked') === 'true'`. In `itemWhere.AND`, push `includeNonStocked ? {} : { isStocked: true }`. Apply the same constraint to the non-default-RC allocation path (filter `a.inventoryItem.isStocked` after fetch, or add to the allocation `where`) and the all-RC `findMany`.
- [ ] **Step 2:** In `page.tsx`, add `showNonStocked` state (default false); when true, append `includeNonStocked=true` to the `/api/inventory` query string in both fetches. Add a toggle control (near the existing filter pills) labelled **"Show non-stocked"**.
- [ ] **Step 3:** Render a subtle "Not stocked" badge on rows where `item.isStocked === false`; ensure such rows show no inventory value (value column blank/—).
- [ ] **Step 4:** `npm run build` green. Commit.

---

### Task 5: Keep recipe/search visible + data seed

**Files:** `src/app/api/recipes/search-ingredients/route.ts:45`, `src/app/api/search/route.ts:12`, `src/app/api/inventory/search/route.ts:50`; new `scripts/seed-non-stocked.ts`.

- [ ] **Step 1:** At each of the 3 search readers, add the comment `// non-stocked items are valid recipe ingredients — do NOT filter isStocked`. No code change.
- [ ] **Step 2:** Write `scripts/seed-non-stocked.ts` (dry default, `APPLY=1`, idempotent): set `isStocked=false` for Water (`cba7ab9431b2142e3899bff5`) and sanitize it — `baseUnit='ml'`, `pricePerBaseUnit=0`, `purchaseUnit='each'`, `countUOM='ml'`, `packUOM='each'`, `qtyUOM='ml'`. Log before/after.
- [ ] **Step 3:** Run dry, then `APPLY=1`. Confirm idempotent re-run = no change.
- [ ] **Step 4:** Verify (read-only): write a throwaway or extend a script to confirm Water is absent from a cost-chrome-style `findMany({ where: { isActive:true, isStocked:true } })` sum and present in `recipes/search-ingredients`. `npm run build` green. Commit.

---

### Task 6: Final verification + push

- [ ] **Step 1:** `npm run build` green; run `scripts/verify-count-conversion.ts` (still 0 collapses) and `scripts/audit-uom-backbone.ts` (no new unknowns).
- [ ] **Step 2:** Spot-check via preview: inventory page hides Water by default, "Show non-stocked" reveals it with a badge; a recipe using Water costs it at $0.
- [ ] **Step 3:** Push `feat/rc-partitioned-theoretical-stock`.
