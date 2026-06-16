# Non-Stocked Items (`isStocked`) — Design Spec

**Date:** 2026-06-15
**Branch:** `feat/rc-partitioned-theoretical-stock`

## Problem

A recipe ingredient must be an `InventoryItem` (recipes reference items by `inventoryItemId`). But some ingredients — tap water, ice — are not stocked, counted, valued, or purchased. Forcing them into Inventory pollutes every operational surface (stock counts, on-hand valuation, theoretical stock, purchasing/reorder, variance) and forces nonsense UOM config (Water as "case = 1 ml").

## Goal

Mark such items as **non-stocked**: they stay usable as recipe ingredients (costed at $0) but drop out of all operational surfaces. One boolean switch, default-safe, generalizing to any free/utility ingredient.

## Decision

`isStocked: Boolean @default(true)` on `InventoryItem`. `false` = recipe-only utility ingredient.

- **Inventory page:** hidden by default; a **"Show non-stocked"** toggle reveals them.
- **Cost:** non-stocked items are pinned to `pricePerBaseUnit = 0` (force $0).
- Rejected alternatives: nullable recipe ingredient (too invasive — costing/allergens/prep-sync/UI all assume `inventoryItemId`); utility-category convention (fragile).

## Schema

```prisma
model InventoryItem {
  // ...
  isStocked Boolean @default(true)  // false = recipe-only utility ingredient (e.g. tap water);
                                    // excluded from counts/valuation/purchasing/theoretical stock
}
```

Migration via the diff/db-execute/resolve workaround (`prisma migrate dev` is broken here — P3006 shadow drift). `@default(true)` backfills every existing row → zero behavior change until an item is flagged.

## Write path

- `POST /api/inventory` and `PUT /api/inventory/[id]` accept `isStocked` (default `true`). When `isStocked === false`, pin `pricePerBaseUnit = 0` in the write (overrides the computed value).
- `InventoryItemDrawer` / inventory form: a toggle labelled **"Not stocked (recipe-only)"**. When on, the price/pack fields may stay but cost is forced to 0 on save.

## Excluded operational readers (add `isStocked: true` to the `where`)

**Counts (4):**
- `src/app/api/count/sessions/route.ts:52` (session create)
- `src/app/api/count/areas/route.ts:18`
- `src/app/api/count/sessions/[id]/sync/route.ts:27`
- (`lines/route.ts` is a single-item `findUnique` — no filter needed)

**Valuation / on-hand (8):**
- `src/app/api/insights/cost-chrome/route.ts:51`
- `src/app/api/insights/spine-audit/route.ts:27`
- `src/app/api/reports/dashboard/route.ts:27`
- `src/app/api/reports/cogs/route.ts:30` and `:106` (legacy fallback — add `isStocked: true`)
- `src/app/api/reports/analytics/route.ts:57` and `:242`
- `src/app/api/reports/inventory-efficiency/route.ts:24`

**Theoretical stock (1):**
- `src/lib/count-expected.ts:447` (`getTheoreticalStockMap`)

**Purchasing / reorder + inventory list (3 paths in one file):**
- `src/app/api/inventory/route.ts` — the three `findMany`/allocation paths (default-RC `:90`, non-default-RC `:60`, all-RC `:117`). These also back the inventory page and its client-side par/reorder filtering.

## Inventory page

- `GET /api/inventory`: new optional `includeNonStocked` param (default `false`). When not `'true'`, the `itemWhere` adds `isStocked: true`. When `'true'`, no `isStocked` constraint (show all).
- `src/app/inventory/page.tsx`: a **"Show non-stocked"** toggle; when on, append `includeNonStocked=true` to the fetch. Default off. Non-stocked rows render with a subtle "Not stocked" badge and no value contribution.

## Kept visible (MUST NOT filter `isStocked`)

- `src/app/api/recipes/search-ingredients/route.ts:45`
- `src/app/api/search/route.ts:12`
- `src/app/api/inventory/search/route.ts:50`

Add a one-line comment at each: `// non-stocked items are valid recipe ingredients — do NOT filter isStocked`.

## Data

`scripts/seed-non-stocked.ts` (dry default, `APPLY=1`):
- Set `isStocked=false` for Water (`cba7ab9431b2142e3899bff5`).
- Sanitize Water: `baseUnit='ml'`, `pricePerBaseUnit=0`, `purchaseUnit='each'`, `countUOM='ml'`, `packUOM='each'`, `qtyUOM='ml'` (or leave pack columns; the key is price 0 + sane base). Idempotent.

## Out of scope (unchanged)

- The 6 remaining degenerate 1-unit containers (need real pack data from the owner).
- Bucket B non-canonical baseUnit (pricing-spine follow-up).

## Verification

- `npm run build` green.
- A read-only check: non-stocked items are absent from cost-chrome on-hand and a count session's item set, present in `recipes/search-ingredients`, and cost $0 in any recipe using them.
- Manual: inventory page hides Water by default; "Show non-stocked" reveals it with a badge.
