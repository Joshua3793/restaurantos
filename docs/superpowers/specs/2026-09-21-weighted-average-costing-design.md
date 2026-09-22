# Weighted-average costing for recipes and menu — design

**Date:** 2026-09-21
**Status:** implemented
**Builds on:** `2026-09-20-item-consolidation-design.md` (purchases pool across suppliers, receipts frozen as `receivedQtyBase`), `2026-09-21-line-first-receiving-design.md`, `2026-09-21-weight-priced-count-items-design.md`.

## The problem

Every cost in the app is the primary supplier's **last** price (`pricePerBaseUnit(item)`, derived from the item's `packChain` + `pricing`). A recipe therefore costs at whatever the most recent primary-supplier invoice said, even when half of the month's eggplant came from a cheaper second supplier, or the last delivery was a one-off spike. Now that purchases from every supplier pool onto ONE item (item consolidation) and every approved line carries a frozen `receivedQtyBase`, the thing a chef actually wants — *what did a gram of this cost us lately* — is derivable.

## Decisions (user, 2026-09-21)

1. **Scope: recipe and menu costs only.** Recipe cost, cost per portion, menu food-cost % and the cost shown when adding an ingredient use the average. Stock valuation, counts, COGS, variance, theoretical usage, wastage and price alerts keep the last price — a count taken today is still valued at the price you'd pay to replace the stock, and the count value still matches the latest invoice.
2. **Window: rolling 30 days.**
3. **Fallback: last price, clearly labelled.** An item with no qualifying purchase in the window is costed at today's number, and the UI says so.
4. **Nested preps recurse on the requested basis.** A prep used inside another recipe is re-costed from its own raw ingredients at their averages. `syncPrepToInventory` keeps writing the LAST-price cost to the prep's linked item, so a prep item's spine — and every reader of it — moves by exactly $0.
5. **Mechanism: derive at read time.** Nothing is stored. No migration, no backfill, no live-DB write.

## 1. The number — `src/lib/cost-basis.ts`

```ts
export const COST_WINDOW_DAYS = 30
export type CostBasis = 'AVG_30D' | 'LAST'

export interface ItemCostBasis {
  basis: CostBasis
  /** $/base-unit on the chosen basis. On 'LAST' this equals pricePerBaseUnit(item). */
  pricePerBase: number
  /** The average's evidence — present whenever ≥ 1 line qualified, even when the guard fell back. */
  avg?: { pricePerBase: number; paid: number; received: number; lines: number; excluded: number }
  /** Why an item with evidence is NOT on the average. */
  fallbackReason?: 'no-purchases' | 'implausible'
}

/** Pure: fold qualifying lines into one basis for one item. */
export function foldCostBasis(a: {
  lines: Array<{ rawLineTotal: unknown; receivedQtyBase: unknown }>
  lastPricePerBase: number
}): ItemCostBasis

/** Prisma: one grouped read for many items, as of `asOf` (default now). */
export async function windowedAvgCost(itemIds: string[], asOf?: Date): Promise<Map<string, ItemCostBasis>>
```

**Which lines qualify.** `InvoiceScanItem` rows where `approved = true`, `session.status = 'APPROVED'`, `matchedItemId ∈ itemIds`, `splitToSessionId IS NULL` (RC-split parents are excluded; their clones carry the scaled money and quantity, so the clones sum to the parent — the same filter `periodPurchases` in `cogs.ts` uses), `session.purchaseDate` within the 30 Pacific days ending on `asOf` (bounds built the way `periodPurchases` builds them), and **both** `rawLineTotal > 0` and `receivedQtyBase > 0`. A line contributes to both sums or to neither: credits and negative lines, unpriced lines (Veal Bones with no price must not drag the average toward $0), and lines never frozen are excluded and counted in `excluded`.

**The fold.** `avg = Σ rawLineTotal ÷ Σ receivedQtyBase` (Prisma `Decimal` → `Number()` first). Then:

- no qualifying line → `{ basis: 'LAST', pricePerBase: last, fallbackReason: 'no-purchases' }`;
- `last > 0` and `avg / last` or `last / avg` `> IMPLAUSIBLE_PRICE_RATIO` (20, the existing constant in `line-format.ts`) → `{ basis: 'LAST', pricePerBase: last, avg, fallbackReason: 'implausible' }` — a historically mis-frozen receipt must not poison recipes;
- otherwise `{ basis: 'AVG_30D', pricePerBase: avg, avg }`.

`last === 0` (an unpriced item) with a plausible average → the average is used: it is real money for real goods.

**PREP-linked items never average.** `windowedAvgCost` skips items with a `recipe` relation; their cost is the recipe's computed cost (section 2). Items merged away (`mergedIntoId`) are never asked for — the merge re-pointed their lines to the survivor, and v1 merges are same-base-unit, so the frozen quantities are comparable.

The window is a code constant. There is no settings UI and no settings model to put one in.

## 2. Where it plugs in — `src/lib/recipeCosts.ts`

`computeRecipeCost(recipe, opts?)` gains `opts.prices?: Map<string, ItemCostBasis>`. For a raw ingredient, `lineCost = convertQty(...) × (prices.get(itemId)?.pricePerBase ?? pricePerBaseUnit(item))`, and every computed ingredient line gains `costBasis: CostBasis` (`'LAST'` when the map has no entry — which is also what every existing caller gets, byte-identically). The recipe result gains `basisSummary: { basis: CostBasis; avgLines: number; lastLines: number }` — `basis` is `'AVG_30D'` when `avgLines > 0`, else `'LAST'` (the same rule a nested prep's line follows).

`fetchRecipeWithCost(id, opts?: { basis?: CostBasis })` — default `'LAST'`, byte-identical to today. With `'AVG_30D'`:

1. collect the recipe's raw ingredient item ids and call `windowedAvgCost` once;
2. for each ingredient with a `linkedRecipe`, cost it by **recursing** into that recipe on the same basis instead of reading its linked item's spine (`linkedRecipeUnitCost` stays for the LAST path): `costPerUnit = nested.totalCost ÷ nested.baseYieldQty` in the nested recipe's `yieldUnit`, the same unit the spine would have given. A per-call memo (`Map<recipeId, RecipeWithCost>`) makes each prep cost once per request; a `visited` set turns a cycle (A ⊃ B ⊃ A) into a spine read tagged `'LAST'` rather than infinite recursion;
3. a nested prep's line is tagged `'AVG_30D'` when *any* of its own lines (recursively) is averaged, `'LAST'` when all of them fell back.

**Callers that ask for the average** — the recipe/menu surfaces: `GET /api/recipes` (list; it calls `computeRecipeCost` directly, so it computes ONE `windowedAvgCost` for the union of ingredient ids across the page and resolves nested preps through the memo — not one query per recipe), `GET /api/recipes/[id]`, `GET /api/recipes/[id]/scale`, `GET /api/recipes/search-ingredients` (the unit cost shown while building a recipe is the cost the saved recipe will show).

**Callers that stay on the last price** (they pass nothing): `recipe-costs.ts` recalculation and `RecipeAlert`, `theoretical-cost.ts` / theoretical usage / food-cost variance / cost-chrome, `reports/analytics`, `reports/menu-engineering`, `signals/rules.ts`, `syncPrepToInventory` and `propagatePrepCostChanges`, wastage, counts, COGS, price alerts. No stored number moves anywhere.

## 3. What the chef sees

All three surfaces read the `costBasis` / `basisSummary` the API now returns; nothing else on screen changes.

- **Recipe / menu panel** (`RecipePanel` in `src/components/recipes/shared.tsx`, shared by both pages, mobile and desktop): one line under the cost summary — *"Costed at the 30-day average · 3 of 12 ingredients at last price"* (or just *"Costed at the 30-day average"*). Ingredient rows tagged `'LAST'` get a small `last price` tag in `text-ink-4`; averaged rows get no tag. A nested prep row shows its recursively averaged cost and carries a tag only when it fell back.
- **Recipe cards and the menu FC%** move to the average; no new chrome.
- **Item drawer** (`InventoryItemDrawer`, pricing card): a *30-day average* row beside the last price — `$2.71/each · 4 invoices · $312.40 for 115 each · −8 % vs last price`. No evidence: *"No purchases in 30 days — recipes use the last price."* Guard tripped: *"Average ignored — 23× off the last price; check this item's receipts"* in `text-red-text` (a data problem worth a human's eye). `GET /api/inventory/[id]` gains `costBasis: ItemCostBasis`.

Not shown: the window length; per-supplier averages (the offers section already shows each supplier's current price).

## 4. Edge cases

| Case | Behaviour |
|---|---|
| RC-split invoice | parent excluded (`splitToSessionId` set), clones counted — sums to the parent |
| Credit / negative line | excluded from both sums, counted |
| Unpriced line (no `rawLineTotal`) | excluded from both sums — free goods don't pull the average to $0 |
| Line never frozen (`receivedQtyBase` null) | excluded |
| Catch-weight line | real weight, real money — correct by construction |
| Weight-priced count item (#135) | `receivedQtyBase` is in each via the each-measure; money is real — correct |
| Merged item | absorbed item's lines were re-pointed to the survivor; same base unit by the v1 merge rule |
| Session DELETE, receipt re-freeze | derived at read — the average changes the moment the rows do |
| PREP item | never averaged; costed by recursion (section 2) |
| Recipe cycle | repeated link costed at the spine, tagged `'LAST'` |
| `last === 0`, plausible average | average used |
| Average > 20× off last price | last price used, `fallbackReason: 'implausible'`, drawer warns |

**Known limits (documented, not fixed here).** (1) A frozen receipt is in the item's base unit *at freeze time*; editing an item's base unit later does not move old receipts. The 20× guard catches g↔kg, not lb↔kg; the drawer's "paid for received" line makes it visible. (2) Correcting an each-measure re-derives the last price but not historic frozen receipts — the same rule counts follow. (3) The window is by `purchaseDate` (the invoice's own date), so a late-approved invoice lands where it was dated, as COGS does.

## 5. Performance

One grouped Prisma query per request (`groupBy matchedItemId` with `_sum` on `rawLineTotal`/`receivedQtyBase` cannot express the both-positive rule, so it is a `findMany` of the qualifying lines' two columns + `matchedItemId` — ~1,500 rows today — folded in memory). The recipe list computes it once for the page; nested preps memoise per request. No caching across requests.

## 6. Testing

- `foldCostBasis`: the exclusion rules one by one (negative, null total, null/zero received, a line that has only one of the two), the guard in both directions, `last === 0`, and a real shape (eggplant: NAF 12 lb → 30 each for $41.88 + Sysco 24 each for $70.30 ⇒ $2.077/each).
- `computeRecipeCost` with a price map: line cost + `costBasis` per line, `basisSummary`, and — with no map — byte-identical output to today (snapshot of an existing fixture).
- `fetchRecipeWithCost` recursion (Prisma mocked): nested prep re-costed on the basis, memo hit count, cycle tagged `'LAST'`, default basis untouched.
- `npx tsc --noEmit`, `npm test`, isolated `npm run build`.

## 7. Proof before merge — read-only sizing

`docs/audits/2026-09-21-weighted-average-costing/wac-sizing.ts` on live data, no writes: for every non-PREP item, last price vs 30-day average, basis, guard trips; for every MENU recipe, cost per portion and FC% before → after; for every PREP recipe, batch cost before → after. The top movers, the count of items on each basis and every guard trip go to the user before merge. Deploy is the only rollout step; only the recipe and menu pages change.

## Out of scope

Cost history charts; per-supplier averages; a settings toggle for the window; moving COGS, variance, valuation or alerts to the average. Each is its own later decision.

## As built

Implemented in six tasks on `feat/weighted-average-costing` (`d71ee1e`..`45081b3`): `cost-basis.ts` and its fold/window/guard → `computeRecipeCost`'s price map, per-line `costBasis`, `basisSummary` → `fetchRecipeWithCost`'s memoised, cycle-safe recursion into nested preps → the four recipe/menu routes plus `GET /api/inventory/[id]` → the recipe panel caption/tags and the item drawer's 30-day-average card. All of it derived at read time; nothing stored, no migration.

Deviations from the design as written:

- **The ingredient picker's prep results stay on the spine.** `search-ingredients` averages inventory-item results (`costBasis` from `windowedAvgCost`), but `recipeResults` (PREP recipes shown in the same picker) keep reading the synced item's last price and are tagged `'LAST'` unconditionally — recursing every PREP recipe's full nested-prep average on every keystroke (up to 50 rows per query) wasn't worth it. This one surface knowingly breaks §3's "the cost shown while building is the cost the saved recipe will show"; the saved recipe (list/detail routes) shows the correctly averaged cost once opened.
- **`CostContext` is not `Promise.all`-safe** — its `visiting` set brackets one recursion path, so two top-level recipes sharing one context in parallel could spuriously flag each other's ids as cycles. The list route (`GET /api/recipes`) costs the page's recipes in a sequential `for...of` over one shared `ctx` instead of `Promise.all`. Task 6's sizing script calls `fetchRecipeWithCost` twice per recipe (LAST and AVG_30D) via `Promise.all`, which is safe only because neither call passes a `ctx` — each builds its own internal context, so there's nothing shared to race.
- **The spec's §6 fixture arithmetic had a floating-point-brittle assertion** (`41.88 / 30` asserted as the literal `1.396` via exact `toMatchObject`, but IEEE-754 gives `1.3960000000000001`); the test now asserts `basis` and uses `toBeCloseTo(1.396, 4)` for the number. `foldCostBasis` itself is unchanged.
- **A brief typo in the recursion test suite**: a one-ingredient pizza fixture was asserted at `lastLines: 1`, but `computeRecipeCost` defines `lastLines = ingredients.length − avgLines`, so a fully-averaged single-ingredient recipe is `lastLines: 0`. The test was written to the correct value; `computeRecipeCost`'s arithmetic (already reviewed in Task 2) was not changed.
- **The editable ingredient row (`IngredientRow` in `shared.tsx`) does not show a `last price` tag** — only the read-only `RecipePrintModal` does. The design's copy list and §3 didn't specify copy for the editable row, so none was invented.
- Two smaller recursion notes carried as known behaviour rather than fixed: a missing nested recipe is re-queried once per referencing line (not memoised as `null`, recursion still terminates); a raw item that is itself PREP-linked is re-queried once per recipe that uses it (bounded, not unbounded, since recipes themselves are memoised).
- **Task 6's sizing script** (`docs/audits/2026-09-21-weighted-average-costing/wac-sizing.ts`) is copied from this doc's §7 with one fix: the design's `select` spread both an explicit `baseUnit: true` and `...PRICING_SELECT` (which already selects `baseUnit`), which `tsc` rejects as a duplicate key (TS2783); the explicit key was dropped. Imports are relative (`../../../src/lib/...`), matching the other scripts already under `docs/audits/`, rather than the `@/` alias the design's snippet used.

_Sizing: (controller fills in after the read-only run)_
