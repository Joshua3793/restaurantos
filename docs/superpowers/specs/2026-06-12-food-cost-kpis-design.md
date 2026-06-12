# Food-Cost & Operational KPIs — Design

**Date:** 2026-06-12
**Status:** Approved (scope: build everything at once)
**Author:** Joshua + Claude

## Problem

The Pass dashboard's headline "FOOD COST · WEEK TO DATE" number is **purchase-based**:

```
foodCostPct = approved invoices this week ÷ food sales this week
```

(computed in [`/api/insights/cost-chrome`](../../../src/app/api/insights/cost-chrome/route.ts), read by the Pass hero at [pass/page.tsx](../../../src/app/pass/page.tsx)).

This is a **cash-out ÷ sales** ratio, not true plate cost or true COGS. It is lumpy and timing-distorted: a single large order spikes the week it lands even though the product is consumed over many weeks; a light-invoice week reads artificially "good." It uses **neither** real stock-on-hand **nor** theoretical stock — inventory levels never enter the formula.

We want metrics that reflect what food *actually* costs, what it *should* cost, and the gap between them (shrinkage), plus a handful of adjacent operational KPIs.

## Data available (confirmed)

| Model | Gives us |
|---|---|
| `SalesEntry` | `totalRevenue`, `foodSalesPct`, `covers`, `date`, RC. |
| `SaleLineItem` | `recipeId` + `qtySold` — **per-item menu mix, entered regularly.** Enables recipe-based theoretical cost. |
| `InventorySnapshot` | Full priced snapshot (`qtyOnHand`, `pricePerBaseUnit`, `totalValue`, `category`) written **on each finalized count** → true opening/closing inventory at count boundaries. |
| `CountLine` | `expectedQty` (theoretical) vs `countedQty` (actual) + `variancePct`/`varianceCost` per item — **usage variance already captured at every count.** |
| `WastageLog` | `costImpact`, `qtyWasted`, `date`, RC. |
| `computeRecipeCost` / `fetchRecipeWithCost` ([recipeCosts.ts](../../../src/lib/recipeCosts.ts)) | `costPerPortion`, `totalCost` per recipe; nested PREP costs resolve through the spine. |

## Existing endpoints to extend (do not rebuild)

- [`/api/reports/dashboard`](../../../src/app/api/reports/dashboard/route.ts) — RC-aware; already returns `weeklyFoodSales`, `weeklyRevenue`, `weeklyWastageCost`, `weeklyPurchaseCost`, `estimatedFoodCostPct`. Home for the Pass-strip KPIs.
- [`/api/reports/cogs`](../../../src/app/api/reports/cogs/route.ts) — already computes period COGS (opening snapshot + purchases − closing snapshot) **and** food sales in range. One step from emitting actual food cost %.
- [`/api/insights/cost-chrome`](../../../src/app/api/insights/cost-chrome/route.ts) — the cross-page strip. Stays purchase-based (it is the cheap, always-on number). **Not** extended with recipe-cost math (would tax every page load).
- The **Variance page** ([variance/page.tsx](../../../src/app/variance/page.tsx)) already renders item-level "theoretical vs counted" $ drift — the natural home for the food-cost-% variance summary.

## Cross-cutting design decisions

1. **Window consistency.** The two food-cost cells on Pass (purchase + theoretical) MUST use the **same window and the same denominator** or the side-by-side comparison is meaningless. Both are computed in `/api/reports/dashboard` over **Monday-WTD** (start of current week, 00:00 local). The dashboard's existing rolling-7d "weekly" fields stay for other consumers; new fields are explicitly WTD. Pass renders both food-cost cells from `dashboard`, not from `cost-chrome`.

2. **Compute on read, never cache costs on rows.** Per the spine principle (CLAUDE.md): theoretical cost is summed at query time from `costPerPortion`. No cost is written onto `SaleLineItem`/`SalesEntry`/`Recipe`.

3. **Theoretical cost is batched.** Collect the distinct `recipeId`s sold in the window, fetch those recipes once with ingredients + each ingredient's `inventoryItem.pricePerBaseUnit`, run `computeRecipeCost` in memory. Nested PREP resolves through the spine (the linked inventory item carries the synced PREP cost), so no recursive per-recipe fetches. Target: ~2 queries regardless of menu size.

4. **Actual food cost % is global-only and count-period-bound.** It requires two finalized count snapshots. RC-mode COGS in `/api/reports/cogs` uses *current* allocations for both opening and closing (they cancel), so per-RC actual food cost is **not** supported until per-RC snapshots exist — surfaced as a clear "global only" caveat in the UI, not silently wrong.

---

## Phase 1 — Pass strip: relabel + theoretical + adjacent ratios

### 1a. Relabel the purchase hero (honesty)

`FOOD COST · WEEK TO DATE` → **`PURCHASE COST · WTD`**, sub-text *"invoices ÷ food sales"*. Math unchanged. Implemented at the Pass `HeroKPI` ([pass/page.tsx](../../../src/app/pass/page.tsx)).

### 1b. New cell — Theoretical food cost % (WTD)

```
theoreticalCostWTD     = Σ over SaleLineItem in WTD ( qtySold × recipe.costPerPortion )
theoreticalFoodCostPct = theoreticalCostWTD ÷ foodSalesWTD × 100
```

- Denominator `foodSalesWTD = Σ (SalesEntry.totalRevenue × foodSalesPct)` over Monday-WTD, RC-filtered — same value the purchase cell uses.
- A sold recipe missing a resolvable cost contributes 0 to the numerator; count such recipes and return `theoreticalCoverage` (e.g. "62 of 64 sold items costed") so the number isn't silently understated.
- Rendered as a second cell immediately right of the purchase hero, same visual weight, label **`THEORETICAL FOOD COST · WTD`**, sub-text *"from recipe costs"*.

### 1c. Wastage % of sales

```
wastagePctOfSales = weeklyWastageCost ÷ weeklyFoodSales × 100
```

Cheap add to `dashboard` (both terms already present). Surfaced on the existing Wastage cell as a sub-line, or its own cell — UI detail for the plan.

### 1d. Cost per cover / avg check

```
covers        = Σ SalesEntry.covers over window (skip null)
avgCheck      = totalRevenue ÷ covers
revPerCover   = foodSales  ÷ covers          (food revenue per cover)
costPerCover  = theoreticalCostWTD ÷ covers  (theoretical food cost per cover)
```

Returned from `dashboard`. If `covers` is null/zero for the window, these render `—` (not 0). Placement: a compact secondary KPI; exact slot is a plan-level UI decision.

### Phase 1 endpoint changes

`/api/reports/dashboard` gains a **WTD food-cost block**:
`weekStartWTD`, `foodSalesWTD`, `purchasesWTD`, `purchaseFoodCostPct`, `theoreticalCostWTD`, `theoreticalFoodCostPct`, `theoreticalCoverage {costed, total}`, `wastagePctOfSales`, `covers`, `avgCheck`, `revPerCover`, `costPerCover`. All RC-aware via existing `rcId`/`isDefault` params.

---

## Phase 2 — Actual food cost % + theoretical-vs-actual variance

### 2a. Actual food cost % (period COGS ÷ food sales)

Extend `/api/reports/cogs` COGS-mode to return:

```
actualFoodCostPct = cogs ÷ foodSalesInPeriod × 100
```

where `cogs = openingValue + purchases − closingValue` (already computed; opening/closing from finalized count snapshots) and `foodSalesInPeriod` from the salesEntries already queried in that handler. Replaces the `cogsMargin = null` placeholder.

### 2b. Theoretical food cost % for the same period

Same batched recipe-cost computation as Phase 1b, but over the **count-to-count period** (from `beginSession.finalizedAt` to `endSession.finalizedAt`) instead of WTD. Return `theoreticalFoodCostPct` for that period.

### 2c. Variance (the shrinkage number)

```
variancePctPoints = actualFoodCostPct − theoreticalFoodCostPct      (percentage points)
varianceDollars   = actualCOGS − theoreticalCostForPeriod           (the $ leak)
```

Positive variance = actual exceeds theoretical = shrinkage (waste / theft / over-portioning / miscounts).

### 2d. Surfacing

- A **variance summary KPI** on Pass and/or the top of the Variance page: "Actual X% · Theoretical Y% · Drift +Z pts ($N)" for the **last closed count period**.
- The existing per-item drift table on the Variance page is the drill-down for *where* the leak is.
- **Caveats rendered, not hidden:** "as of last finalized count (period dd Mon–dd Mon)"; "global only — per-RC actual cost needs per-RC count snapshots."

---

## Phase 3 — Menu engineering & inventory efficiency (own views, not strip cells)

### 3a. Menu engineering (stars / plowhorses / puzzles / dogs)

Per MENU recipe over a window: popularity = `Σ qtySold`; profitability = `menuPrice − costPerPortion` (contribution margin). Classify into the classic 4 quadrants against median popularity and median margin:

| | High margin | Low margin |
|---|---|---|
| **High popularity** | ⭐ Star | 🐴 Plowhorse |
| **Low popularity** | ❓ Puzzle | 🐶 Dog |

New view (a Reports sub-page or a tab on the Menu page). Reads `SaleLineItem` + recipe costs; compute-on-read.

### 3b. Inventory turns / days-on-hand

```
periodCOGS    = COGS for trailing window (Phase 2a)
avgInventory  = (openingValue + closingValue) ÷ 2
turns         = periodCOGS ÷ avgInventory            (annualize as needed)
daysOnHand    = onHandValue ÷ (periodCOGS ÷ periodDays)
```

Flags overstocking / cash tied up in stock. New Reports tile or sub-page; count-period-bound like 2a.

---

## Out of scope / non-goals

- Caching any cost on a recipe, sale, or menu row (divergence-bug risk; compute on read).
- Per-RC actual food cost (needs per-RC count snapshots — a separate initiative).
- Live (intra-day) actual food cost (impossible without continuous counts; theoretical is the live proxy).
- Changing how sales or invoices are entered.

## Risks & edge cases

- **Recipe-cost coverage:** sold items with no resolvable cost understate theoretical cost → always return + display coverage count.
- **`foodSalesPct` accuracy:** food cost % is only as good as the food-vs-total split on each `SalesEntry`. Existing assumption; unchanged.
- **No counts yet:** Phase 2 metrics render an empty/"needs a count" state, not 0 or NaN.
- **Window/denominator drift:** enforce the single-window rule (decision 1) — the two Pass food-cost cells must read the same `foodSalesWTD`.
- **Decimal serialization:** wrap all Prisma `Decimal` reads in `Number()` (CLAUDE.md).
- **Performance:** theoretical computation must batch (decision 3); verify `dashboard` latency doesn't regress meaningfully.

## Verification

- `npm run build` (only automated check).
- Manual: Pass strip shows purchase + theoretical side by side with the same denominator; numbers reconcile by hand for a known week.
- Variance summary matches `/api/reports/cogs` actual vs theoretical for a known count period.
- RC switch: theoretical/purchase/wastage update; actual-cost caveat shows for non-global.
