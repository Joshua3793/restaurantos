# Creating a product from a by-weight invoice line gets the right dimension — design

**Date:** 2026-09-22
**Status:** implemented
**Builds on:** `2026-09-21-weight-priced-count-items-design.md` (the each-measure model this reuses for the COUNT case), `2026-09-21-line-first-receiving-design.md` (the receipt is frozen through the created item).

## The problem

"Create new product" on an invoice line (`AddNewItemModal` in `src/components/invoices/v2/InvoiceReviewDrawer.tsx`) seeds its form with the shipped unit hard-coded to `each` and the pack unit falling back to `each` when the line has no pack fields. A by-weight line has none — its weight lives in `rate`/`rateUOM`/`totalQty`/`totalQtyUOM`, which the seed never reads — so `formToChain` (`src/lib/item-model-form.ts`) derives `dimension: 'COUNT'`, `rateUnit: 'each'` and a chain of the raw unit with `per: 1`: `[{ lb: 1 }]`. Approve writes that verbatim, never seeds an each-measure, and freezes the receipt through it (200 lb → "200 each"). `formToChain` itself is correct when fed a measured unit; it is only ever fed `each`.

**Damage (read-only audit 2026-09-22, 422 items, 129 approved `CREATE_NEW` lines):** exactly four items carry the self-contradictory shape, all from per-lb North Arm Farms / Two Rivers lines — Potatoes Kennebec O/S, TRSM Sour Tuscan Salami, Fennel O/S (COUNT, `[{lb:1}]`, `RATE $/each`) and Kohlrabi Green (flipped to MASS by hand; chain still `[{lb:1}]` = "1 lb = 1 g"). Between them: 4 receipts and 5 count lines frozen in the wrong unit, 3 snapshots, no recipes. The other 30 by-weight creations came out right (the chef toggled the dimension, or a pack unit was present) — it is a trap, not a certainty.

## Decisions (user, 2026-09-22)

1. Fix the path **and** repair the known items (dry run first); a read-only audit lists any others for case-by-case decisions.
2. Approach A: fix the seed, guide the deliberate COUNT case with a required each-measure, and keep a server-side guard so the bad shape is unreachable from any client.

## 1. The seed and the modal

`src/lib/invoice/create-new-seed.ts` (pure):

```ts
export function lineMeasureUnit(line: { pricingMode?: string | null; rateUOM?: string | null; totalQtyUOM?: string | null; rawUnit?: string | null }): string | null
// the first of rateUOM, totalQtyUOM, rawUnit that is a weight/volume unit (canonicalUom + UNIT_FACTORS, dim !== 'count'), else null
export function isByWeightLine(line): boolean   // pricingMode === 'per_weight' || lineMeasureUnit(line) !== null
export function seedFromScanLine(line): ItemFormInput
```

For a by-weight line the seed is `{ priceType: 'UOM', purchaseUnit: <measure>, qtyUOM: <measure>, packUOM: <measure>, qtyPerPurchaseUnit: 1, packSize: 1, innerQty: null, purchasePrice: Number(rate ?? rawUnitPrice ?? newPrice ?? 0), countUOM: <measure> }`, so `formToChain` yields `dimension` MASS (or VOLUME), `baseUnit` `g`/`ml`, `pricing { mode: 'RATE', rate, rateUnit: <measure> }`, `packChain [{ unit: <measure>, per: conv }]` (`[{ lb: 453.592 }]`), `countUnit` `<measure>`. A per-case line seeds exactly as today.

The modal: under the dimension toggle, a by-weight line shows *"Billed by weight ($5.49/lb)"*. If the chef flips it to COUNT, the item drawer's each-measure field appears with *"Bought by weight but counted as units — how much does one weigh?"* and Save is disabled until it holds a positive quantity. `newItemData` gains `eachMeasureQty` and `eachMeasureUnit`. The rate unit stays the line's measure unit in that case (the #135 model: store the supplier's real `$/lb`, derive `$/each` through the each-measure); the chain is `[{ case: 1 }]`-shaped as the editor produces for a count item.

Approve's legacy fallback (older sessions whose `newItemData` is not chain-shaped, `approve/route.ts` ~:869–882, which re-derives via `formToChain` with `qtyUOM: 'each'`) uses `seedFromScanLine` too.

## 2. Approve and the safety net

For a `CREATE_NEW` line, approve:

1. runs `validateCreateNew(line, newChain, eachMeasure)` (pure, `src/lib/invoice/create-new-seed.ts`): `{ ok: true }` unless `isByWeightLine(line) && newChain.dimension === 'COUNT'` and no positive each-measure → `{ ok: false, error: 'Bought by weight but the product is counted as units — add how much one weighs, or make it a weight item.' }`. A failing line is skipped and left un-approved, visible in the session, exactly like an uncostable rate is today (`skippedLines++`, `console.error` with the reason);
2. writes `eachMeasureQty`/`eachMeasureUnit` from `newItemData` on `inventoryItem.create` (today they are never set);
3. freezes the receipt through the created item as today — now correct by construction: a MASS item receives 200 lb as 90,718 g; a COUNT item with an each-measure receives through the bridge, like any existing eggplant line.

## 3. Repair

- `scripts/audit-create-new-shape.ts` (read-only): every active item whose shape is self-contradictory — COUNT with a measure-unit chain link; `RATE` with `rateUnit` `each`; a MASS/VOLUME item with a measure link whose `per` is 1 and whose unit is not the base unit — with its receipts, count lines and recipe/count counts. Finds the four today.
- `scripts/repair-create-new-shape.ts --item <id> [--item <id>…] [--apply]`: per named item, plan `{ dimension: MASS|VOLUME from the line's measure unit, baseUnit: g|ml, packChain: [{ unit: <measure>, per: conv }], pricing: { mode: 'RATE', rate: <unchanged number>, rateUnit: <measure> }, countUnit: <measure> }`; re-freeze the item's approved receipts through the corrected chain (`lineReceived`, the same rule the backfill uses; clone lines by share); re-freeze its count lines through the count reader's own `lineCountedBase` — never a re-implemented unit resolution — and refresh their `InventorySnapshot` quantity and `totalValue` (price at count unchanged in $/base terms since the rate number is right; state it in the dry run). Prints the before/after table; `--apply` backs up `{ item, lines, countLines, snapshots }` to JSON before the first write; refuses if any row changed since planning.
- Expected on the four: Kennebec 200 → 90,718.4 g; Salami 3.74 → 1,696.4 g, counts 0 / 1,422 g / 1,422 g; Fennel 12 → 5,443.1 g; Kohlrabi chain `[{ lb: 453.592 }]`, count 10 lb → 4,535.9 g (its receipts are already in grams).
- Not part of this: merging "kennebec potato" (Sysco, MASS) into Kennebec O/S afterwards — the user's call in the merge UI once both are weight items.

## 4. Tests and rollout

`seedFromScanLine` on the four real lines (→ MASS, `$/lb`, `[{lb:453.592}]`, count `lb`) and on a per-case line (unchanged from today's seed, asserted field by field); `lineMeasureUnit` precedence and container tokens (`CS`, `each` → null); `validateCreateNew` for the three shapes; the repair planner's rewrite and refreeze maths as pure functions. `tsc --noEmit`, eslint, isolated `npm run build`. No migration. Deploy, then run the repair on the four with the user watching the dry run.

## Out of scope

Normalising the 30 correctly-dimensioned by-weight items whose chain link is labelled `each` for a pound (count-unit display only; pricing is RATE so costs are right); the create-new modal's other fields; merging duplicates.

## As built (2026-09-22)

- `seedFromScanLine` reproduces the modal's old per-case literal exactly, field for field, for a per-case line (asserted in `src/lib/__tests__/create-new-seed.test.ts`) — the by-weight path is additive, not a rewrite of the existing case.
- The COUNT flip never relabels the stored rate. The dimension toggle keeps `pricing.rateUnit` on the line's measure unit (`$/lb`, never `$/each`) whenever COUNT is on either side of the flip, deriving `$/each` from the each-measure at read time (the #135 bridge) instead of mislabelling the unit. A first pass (`6768ed8`) always restored `seed.packChain` on the way back out of COUNT, which silently discarded a chef's own chain edit and also fired on plain MASS↔VOLUME flips; the fix (`62a4935`) snapshots the live chain into `chainBeforeCount` the instant COUNT is entered, restores it (not the original seed) on the way back, and scopes the whole by-weight branch to flips that actually touch COUNT — a MASS↔VOLUME flip is untouched by any of this.
- **`lineMeasureUnit` does not trust a billed-weight column on its own.** `rateUOM` is accepted unconditionally — a printed `$/kg` IS the supplier saying what the price is per. `totalQtyUOM` / `rawUnit` count as the measure only when `pricingMode === 'per_weight'` or the money proves it (`billedWeightIsPriced`, `src/lib/invoice/line-qty.ts`: printed rate × billed weight = line total). Without that, CLAUDE.md's Butter shape — a per-CASE line `2 × 25 × 454 g` carrying a stray "2.86 kg" and no rate — would be seeded as a MASS item whose `$/kg` was really the CASE price ($70.30), and `validateCreateNew` would then refuse the *correct* COUNT product for want of an each-measure. `isByWeightLine` is unchanged: `pricingMode === 'per_weight' || lineMeasureUnit(line) !== null`. `SeedLine` therefore carries `rawQty`, `totalQty`, `rate`, `rawUnitPrice`, `rawLineTotal`.
- **Approve's legacy fallback keeps the chef's pack fields.** The fallback spreads `seedFromScanLine(scanItem)` as the floor and then overrides, only where `newItemData` has them, `purchaseUnit`, `purchasePrice`, `qtyPerPurchaseUnit`, `packSize`, `packUOM`, `priceType`, `countUOM`, `baseUnit` — every field the pre-seed fallback honoured. A by-weight line with no legacy pack fields still gets the measure seed; a legacy session that specified a 1 × 24 each case still creates that case.
- **A skipped `CREATE_NEW` is reported as such.** The session's `errorMessage` splits the two failures: price writes that could not be resolved say "price not updated", and refused `CREATE_NEW` lines say the product was **not created** and why (never configured in the Add new product form, or the each-measure gate).
- `scripts/audit-create-new-shape.ts` reports two findings, not one:
  - **A — self-contradictory shape** (COUNT with a measure-unit chain link, RATE per each over a measured pack, or a measure link with `per === 1`): Potatoes Kennebec O/S, TRSM Sour Tuscan Salami, Kohlrabi Green.
  - **B — born from a by-weight `CREATE_NEW` line, still COUNT with no each-measure** (a shape A's predicate can't see on its own, since most of the catalogue is legitimately `COUNT` / `[{each:1}]` / `RATE $/each`): a candidate list scoped to items whose most recent approved `CREATE_NEW` line was by-weight. Fennel O/S is the real hit; the same scan also surfaces items that are genuinely counted and were excluded — e.g. ENGLISH MUFFIN GF 4PK, which is `CREATE_NEW`-born from a by-weight-shaped line but is correctly a counted product with no weight relationship to repair. B is a worklist for a human, not an auto-repair queue — so the audit's paste-ready `--item …` command covers **section A only**, and B's ids are printed one per line under "CANDIDATES — decide per item", never inside a runnable line.
- The repair script **does** rewrite the stock baselines, and an earlier draft of this paragraph (claiming it never touches them) was wrong. `stockOnHand`, `StockAllocation.quantity`, `InventoryItem.lastCountQty` and `InventoryItem.purchasePrice` are all written: they are read straight off the row by `count-expected.ts` / `inventory-list.ts` / the count page's "Last count: …", and finalize wrote them in the OLD base unit, so leaving them would show a corrected item beside a stale 200-`each` baseline. Each is re-set from the corrected quantity of the latest OBSERVED count line that wrote it, routed exactly as `count-finalize.ts` routes it — unscoped or default RC → global `stockOnHand`; a non-default RC → that RC's `StockAllocation`; `lastCountQty` from the latest observed count across ALL of the item's sessions, scoped or not, since both branches of finalize write it. `purchasePrice` is the legacy headline column that `syncPrimaryOfferToItem` keeps in step with `pricing`. A target with no observed count is left alone and the dry run says so.
- Deliberately left, and stated per item in the dry run: `CountLine.variancePct` / `varianceCost` / `expectedQty` (the variance formula needs `expectedQty`, which is itself frozen in the old base unit and out of scope — recomputing would subtract a stale expectation from a corrected count), and the item's `StockTransfer`, `WastageLog` and `InvoiceLineItem` rows, whose quantities are likewise in the old base unit. Those three are COUNTED per item in the dry run rather than silently ignored: theoretical stock is computed on read from counts + receipts and resets at each count, so a movement older than the latest count changes no displayed number, but a non-zero count dated after it wants a human's eye.
- Salami's `3.135 each` count line (entered after the item was flipped to COUNT, so the corrected item has no `each` level to resolve it against) is handled via `--count-unit-override <lineId>=lb`, matching the `3.135 lb` count immediately before it in the same session.
- _Repair: (controller fills in after the run)_
