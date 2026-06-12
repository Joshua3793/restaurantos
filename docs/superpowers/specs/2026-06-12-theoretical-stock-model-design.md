# Theoretical vs Real Stock Model — Design

**Date:** 2026-06-12
**Status:** Approved (design); pending implementation plan
**Scope:** Per-revenue-center theoretical inventory, computed at read time. One coherent change ("per-RC in one go").

## Problem

Today `InventoryItem.stockOnHand` is a real, persisted ledger mutated by many
operations: count finalize, manual edits, invoice receiving, prep-log apply,
stock allocations/transfers, CSV import. That mixes two different kinds of
number into one field:

- **Asserted physical truth** (a count, a manual override, a physical pull) —
  trustworthy.
- **Derived bookkeeping** (receiving, sales, prep, wastage) — should be
  reconciled against reality, not trusted as fact.

Because prep-apply and invoice-process write the real ledger directly,
unlogged prep silently corrupts stock instead of surfacing as variance, and
alerts (especially prep stock alerts) read a number that drifts from reality
between counts. The engine that *should* drive decisions — the theoretical
balance — already exists in `src/lib/count-expected.ts` but is only wired into
the count screen.

## Goal

Make a **per-RC theoretical on-hand** the primary number the whole app reasons
with (display + alerts), keep the **real anchors** writable only by genuine
"truth" events, and have the two converge at each count. Prep that isn't logged
shows up as variance, never as silent real-stock corruption.

## The model

### Two real anchors

- `InventoryItem.stockOnHand` — global / default-RC anchor (base units).
- `StockAllocation.quantity` — per-RC anchor (one row per item × RC).

### Real writers (the ONLY mutators of anchors)

1. **Count finalize** — writes the anchor for the counted scope and stamps
   `lastCountDate` / `lastCountQty`.
2. **Manual inventory override** — direct edit in Inventory.
3. **Stock pulls / transfers** — physically relocating product between RCs
   (`StockAllocation` / `StockTransfer`).

Receiving, sales, prep, and wastage **never** touch anchors.

### Theoretical on-hand (computed at read time, per `(item, RC)`)

```
theoretical(item, RC) =
    anchorBaseline(item, RC)     // baseline as of that RC's last count of this item
  + purchases                    // invoice receipts, RC-scoped
  + prepOutput                   // prep batches produced, RC-scoped
  − salesConsumption             // menu sales → prep item / raw, RC-scoped
  − prepConsumption              // raws drawn down to make prep, RC-scoped
  − wastage                      // RC-scoped
```

All deltas are summed over events since that item/RC's `lastCountDate`.

`anchorBaseline` (existing rule, unchanged):
- default RC / no RC → global `stockOnHand`
- non-default RC → that RC's `StockAllocation.quantity`, or `0` if the RC has
  never been counted (not the warehouse total).

### The invariant that makes it trustworthy

When a count finalizes it writes the anchor and stamps `lastCountDate = now`, so
every delta window collapses to zero → **theoretical == real at the count, then
floats.** Unlogged prep/waste never moves theoretical, so it surfaces as variance
at the next count.

### Architecture decision: compute-on-read, no stored field

Theoretical is always derived from the anchor baseline + immutable event logs
(`InvoiceScanItem`, `SaleLineItem`, `PrepLog`, `WastageLog`). No materialized
`theoreticalStock` column — a running derived field would reintroduce exactly the
drift this redesign removes, and violates the spine principle in CLAUDE.md
("read at query time; don't cache a parallel value"). Performance is handled by
building period-maps once per request and reusing them across items.

## Code changes

### 1. Remove the two real writes

- **`src/app/api/prep/logs/[id]/route.ts`** — delete `applyInventoryTransaction`
  (raw-deduct + prep-credit). Prep's effect now flows through the theoretical
  engine from the `PrepLog` record. The `inventoryAdjusted` idempotency flag and
  the stock-reversal in `prep/logs/[id]/revert/route.ts` are removed with it.
- **`src/app/api/invoices/[id]/process/route.ts`** — stop writing `stockOnHand`.
  Receipts feed theoretical via the purchase map.

### 2. RC-tag prep (schema gap)

- Add `revenueCenterId String?` to **`PrepItem`** (nullable; null = default RC),
  mirroring the RC-recipe-book pattern. `PrepLog` inherits its item's RC at
  creation. An optional `PrepLog.revenueCenterId` override may be added if a prep
  item is ever produced for a non-default RC; default behavior inherits the item.
- Existing rows backfill to null → default RC. Additive, non-destructive.

### 3. The shared theoretical engine

Generalize `src/lib/count-expected.ts`:

- Promote `computeExpectedForItem(itemId, rcId)` into a reusable
  `getTheoreticalStock(itemId, rcId)`.
- Add a batch `getTheoreticalStockMap(rcId, itemIds?)` for list views — builds
  one set of period-maps, not N per-item queries.
- Add **`buildPrepMap(since, rcId)`** — from `PrepLog`s marked `DONE`/`PARTIAL`
  with `actualPrepQty`, netting:
  - **prepConsumption** (−): raw ingredients drawn down to make the batch,
    expanded through the recipe but **stopping at sub-prep items** (same rule as
    the theoretical-usage report) so prep-in-prep never double-counts.
  - **prepOutput** (+): the prep item's own stock produced.
  All RC-scoped via the prep item's (or log's) `revenueCenterId`.
- Extend `computeExpected` with the prep terms: `… + prepOutput − prepConsumption`.

### 4. One source of truth

Every consumer calls the same engine: count screen (already), inventory
list/detail, prep KPIs/alerts, cost-chrome on-hand, dashboards. No second stored
field.

The framing that keeps this clean: **purchases and prep move from being
real-write side-effects to being theoretical event-derivations** — same source
data, read at query time instead of written into the ledger.

## Display

- A shared formatter: **`theoretical (counted X · <date>)`** — theoretical is the
  headline; the counted value + `lastCountDate` sit alongside for trust.
- Surfaces: inventory list/detail, prep KPI strip, cost-chrome on-hand strip,
  reports/dashboards.
- No count yet → show theoretical alone (baseline = current stock).

## Alerts (the payoff)

- Prep alerts (`src/app/api/prep/generate/route.ts`) and inventory
  low-stock/signals read **theoretical** per RC instead of `stockOnHand`, so
  "running low" reflects what's been sold/prepped since the count.

## Edge cases

- **Never-counted item/RC** → `lastCountDate` null → deltas empty → theoretical =
  baseline (global stock for default RC; `0` for an uncounted non-default RC).
- **Prep-in-prep** → `buildPrepMap` stops at sub-prep items → no double-count.
- **Unit conversions** → applied per event inside each map (existing pattern).
- **Pulls/transfers** → remain real anchor writes; they re-baseline the moved
  quantity per RC, not theoretical.

## Performance

List views build the period-maps once and reuse across all items (batch), with a
per-request memo. No N+1.

## Migration (non-destructive)

- Additive schema only (`PrepItem.revenueCenterId`, optional
  `PrepLog.revenueCenterId`); backfill null.
- Stop the real writes going forward; existing `stockOnHand` stands as the
  current baseline until each item's next count re-anchors it. No data rewrite,
  fully reversible.
- Remove dead code: `applyInventoryTransaction`, revert stock-reversal,
  `inventoryAdjusted` usage.

## Known limitation

Until an item gets its first count *after* this ships, its baseline still carries
historical prep/invoice writes baked in — theoretical and reality fully converge
only after one count cycle per item. Non-blocking; worth documenting in-product.

## Out of scope

- Reworking the count finalize / allocation write paths beyond what's needed to
  keep anchors correct.
- Any change to recipe costing (cost still fully expands to leaves — unrelated to
  physical-usage stock).
- Backfilling historical theoretical values.

## Affected files (anticipated)

- `prisma/schema.prisma` — `PrepItem.revenueCenterId` (+ optional
  `PrepLog.revenueCenterId`)
- `src/lib/count-expected.ts` — engine generalization + `buildPrepMap` + prep terms
- `src/app/api/prep/logs/[id]/route.ts`, `.../revert/route.ts` — remove real writes
- `src/app/api/invoices/[id]/process/route.ts` — remove real write
- `src/app/api/prep/generate/route.ts` — alerts read theoretical
- Inventory / prep / cost-chrome / dashboard read + display sites — theoretical
  headline + counted-anchor annotation
- Prep logging UI — RC selection / inheritance
