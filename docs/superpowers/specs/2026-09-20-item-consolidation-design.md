# Item consolidation — one item, many suppliers

**Date:** 2026-09-20
**Status:** design approved, not implemented
**Spec 1 of 3.** Spec 2 (weighted-average costing) and spec 3 (none needed if 3c below ships here) build on this.

## Problem

An inventory item is meant to be one good with several sources. In practice the same good is split across several `InventoryItem` rows, one per supplier or pack format. Recipes point at one row; purchases land on the others. Sales deplete the recipe row, the sibling rows accumulate theoretical stock nobody uses, and theoretical stock drifts from the shelf.

Read-only audit of the live DB, 2026-09-20 (`scratchpad/find-duplicate-items.ts`, `orphans.ts`):

- 422 active purchasable items; only 30 pool two or more supplier offers.
- **126 stocked items receive purchases but are in no recipe — about $52k of approved invoice lines.**
  1. **True duplicates (~15–20).** GF English Muffin (same Snow Cap SKU `PG2431` on both rows, `4/case › 6/pack` vs `6/case › 4/pack`), Kennebec potato (`each` vs `g`), Romaine hearts (`12/case` vs `4/case › 12/pack`), Butter Unsalted Bulk vs Butter, tomatillo, capers, cucumber, cilantro, chives, strawberries, grapes, Yukon Gold, baby zucchini.
  2. **Varieties bought, a generic used.** Six mushroom items (~$5.4k) bought; recipes use "Mixed mushrooms". Same for tomatoes and cucumbers.
  3. **Bought with no recipe at all (~$25k+).** Proteins, fish, fingerlings. Some legitimately outside recipes (fryer oil, detergent, retail pizza). A recipe-coverage gap — out of scope.

### Root cause

Almost every duplicate pair differs in pack or UOM. Two code paths assume an item has ONE pack — the primary supplier's:

- `lineReceivedBaseUnits` (`src/lib/invoice/line-qty.ts:70`) uses the line's printed pack, else falls back to **the item's own chain**, and reads RATE/PACK mode from the item. A second supplier's "2 cases" with no printed pack credits the wrong quantity.
- The approve route (`src/app/api/invoices/sessions/[id]/approve/route.ts:238-250`) prices a PACK line over the item's chain and **skips the line** when the invoice pack disagrees with the item's pack by more than 25%.

Each `InventorySupplierPrice` offer already stores its own `packChain` and `pricing`. Neither path reads them. Creating a second item was the only way to get a correct quantity and an accepted price.

## Decisions

- **Merge rows (approach A).** Rejected: a parent "product" entity above items (rewrites the spine, ~66 cost readers, ledger, counts) and an alias pointer (leaves two rows in Inventory and on count sheets).
- Merging varieties into a generic (pattern 2) is **the user's call per case**. Same mechanism, no policy, nothing automatic.
- Receipts are **frozen** at approve (`receivedQtyBase`).
- No suggestions UI. The audit script is the worklist.

## 1. Data model and merge semantics

One additive migration:

- `InventoryItem.mergedIntoId String?` — self-relation. Set ⇒ tombstone; the row also gets `isActive = false`, so existing `isActive` filters hide it.
- `ItemMerge { id, survivorId, absorbedId, mergedBy, mergedAt, undoneAt?, manifest Json }` — the manifest lists every re-pointed row id per table and the before-value of anything overwritten.
- `InvoiceScanItem.receivedQtyBase Decimal?` — see section 2.

`src/lib/item-merge.ts` holds a **pure planner** (both rows + their relations → manifest) and an executor that applies a manifest in one transaction.

| Table | Rule |
|---|---|
| `InvoiceScanItem.matchedItemId`, `InvoiceLineItem`, `WastageLog`, `StockTransfer`, `PriceAlert`, `InvoiceMatchRule` | Re-point. |
| `RecipeIngredient` | Re-point; convert `qtyBase`/`unit` if base units differ. |
| `InventorySupplierPrice` (unique item+supplier) | Re-point. On collision keep the offer with the newer `lastUpdated`; the other goes in the manifest. Re-pointed offers are never primary. |
| Absorbed row has purchases but no offer | Synthesize an offer from its `packChain`/`pricing` and the supplier of its latest approved invoice line, so its pack survives. |
| `StockAllocation`, `ItemRevenueCenter` (unique rc+item) | Union; where both exist, sum converted quantities. |
| `CountLine`, `InventorySnapshot` | Re-point with quantities converted to the survivor's base unit. Two snapshots of the same count session collapse into one summed row (keeping the stronger `source`: COUNTED > CARRIED > THEORETICAL > SKIPPED) — otherwise `resolveItemBound` picks one and drops the other. |
| `InvoiceScanItem.receivedQtyBase` | Converted if the base unit changes. |
| `Recipe.inventoryItemId`, `PrepItem.linkedInventoryItem` | **Blocked.** PREP-owned items never merge, either direction. |

**Guards** (refuse with a reason and the fix): base-unit dimensions differ and the survivor has no each-measure/density bridge spanning them; either row PREP-owned; either row in an open count session; either row already a tombstone; survivor === absorbed.

**Stock baseline.** Theoretical on-hand is `stockOnHand` as of `lastCountDate` plus events since; two rows with different count dates cannot be added exactly. If the absorbed row's theoretical on-hand is 0 the merge is exact. Otherwise the caller must supply a combined on-hand, written through the existing Quick Count path (auto-finalized `QUICK` `CountSession`) as a fresh baseline dated now.

**Undo** replays the manifest in reverse. Allowed only while nothing new references the survivor through a re-pointed relationship: no invoice line approved, count finalized, or recipe ingredient edited on the survivor since `mergedAt`. Otherwise the API returns 409 with the reason.

## 2. Receiving and pricing read the supplier's pack

New `src/lib/invoice/line-format.ts`:

`resolveLineFormat(line, item, offer | null): ChainItem` — first that applies:

1. The line's printed pack (`invoicePackQty × invoicePackSize invoicePackUOM`) — unchanged, handled inside `lineReceivedBaseUnits`.
2. **The line's supplier offer's `packChain` + `pricing` mode.**
3. The item's own chain — today's behaviour, and the only path for items with no offers.

Base unit and bridges (`eachMeasure`, `densityGPerMl`) always come from the item. `lineReceivedBaseUnits` itself does not change; callers pass the resolved `ChainItem` instead of `asChainItem(item)`. The offer is found by `(inventoryItemId, session.supplierId ?? canonical supplierName)`.

Callers that switch: `buildPurchaseMap` (`src/lib/count-expected.ts:282`), the RC split editor (`lineReceivedCountQty`), the approved-invoice report, and the approve route.

**Approve route.** The pack-disagreement guard compares the invoice pack against **this supplier's offer chain**. Disagreeing with the supplier's own previous pack still blocks (a real format change; `AdoptFormatModal` handles it). Disagreeing with a different supplier's pack is normal. With no offer for this supplier yet, the guard does not fire — the line's pack becomes the new offer's chain.

**Frozen receipts.** Approve writes `InvoiceScanItem.receivedQtyBase` from the resolver. Readers prefer the frozen value and compute live when it is null. Same reasoning as `CountLine.countedQtyBase`: a receipt is a point-in-time fact, not a cached cost, so the "no parallel price" rule is untouched. Session DELETE / un-approve clears it. Spec 2 derives price paid per base unit as `rawLineTotal / receivedQtyBase`.

**Backfill** — `scripts/backfill-received-qty-base.ts`: computes the value for every approved line under the new resolver; `--dry-run` (default) writes a diff of every line whose quantity differs from today's rule; `--apply` writes a JSON backup first. Historical corrections move theoretical stock retroactively; counted snapshots are frozen and do not move.

## 3. UI, prevention, matcher

**3a. Merge in the item drawer.** `InventoryItemDrawer`, beside `SupplierOffersSection`: "Merge another item into this one…" (MANAGER+). The open item is the survivor. A search (existing `/api/inventory/search`) picks the absorbed row; results show recipe-usage count, purchase count, on-hand. `POST /api/inventory/[id]/merge` with `{ absorbedId, dryRun, combinedOnHand? }` — dry run returns the manifest summary or the failing guard. After confirm the drawer shows "Merged: <name> · Undo" while undo is safe (`POST /api/inventory/merges/[id]/undo`). Both routes `force-dynamic`, `requireSession('MANAGER')`.

**3b. Invoice review.** When a line matches an item and the line's supplier has no offer on it, review shows "New supplier for <item> — will be added with its own pack", default action `ADD_SUPPLIER`, pack editable via `ItemChainEditor`. In the Create New modal, an existing item with fuzzy score ≥ 40 raises a banner — "Looks like <item> (used in N recipes). Add as a supplier instead?" — one click switches the action.

**3c. Matcher** (`src/lib/invoice-matcher.ts`):

- Tier 0 also matches `(supplier, supplierItemCode)` against `InventorySupplierPrice` → HIGH, alongside the `InvoiceMatchRule` lookup.
- The fuzzy tier takes the best `scoreMatch` across `itemName` **and** the `rawDescription`s of that item's match rules from any supplier. A match won through another supplier's alias is capped at MEDIUM — the same downgrade generic rules already get.

Price alerts are untouched: still per supplier offer, per base unit.

## 4. Testing and rollout

**vitest** (`src/lib/__tests__/`): `line-format.test.ts` (resolver order; RATE offer on a PACK item; no-offer item resolves exactly as today); `item-merge.test.ts` (offer collision, synthesized offer, same-session snapshot sum, unit conversion of ingredients / count lines / `receivedQtyBase`, every guard, undo round-trips to equality); matcher tests for offer-SKU tier 0 and the alias cap. `npm test` + `npm run build` in an isolated worktree.

**Rollout — each step ships alone:**

1. Migration (additive; `migrate diff` + `db execute` over the session pooler — shadow DB is broken).
2. Resolver + frozen receipts. Code first (null ⇒ live compute), then backfill: review the dry-run diff, then apply.
3. Matcher + invoice-review prevention. No new duplicates form from here.
4. Merge API + drawer UI. First merge: GF English Muffin (same supplier, same SKU, absorbed on-hand 0), undo verified. Then the audit list, one judgment call at a time — no batch merge.

Commit the audit as `scripts/audit-duplicate-items.ts`. **Verify on live data:** around each early merge, compare the survivor's theoretical on-hand and movement track — absorbed purchases appear, depletion unchanged; the "bought but in no recipe" count falls from 126.

## Out of scope

- Weighted-average costing (spec 2).
- Pattern 3, the recipe-coverage gap. The audit script keeps reporting it.
- A recipe-side "any of these items" ingredient group.
- Dropping the dead `InvoiceLineItem` table.
