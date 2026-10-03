# The item as the app's backbone — design

**Date:** 2026-10-03
**Status:** approved by the owner in conversation; implementation plans to follow, one per stage
**Builds on:** `2026-06-15-item-model-redesign` (pack chain, compute-on-read), `2026-09-20-item-consolidation-design.md` (one item, many suppliers, frozen receipts), `2026-09-21-weighted-average-costing-design.md` (30-day average, recipes only), `2026-09-26` offer-per-supplier-product migration.
**Supersedes in part:** the 2026-09-21 decision that wastage keeps the last price (wastage now uses the average — §2).

## The problem, in the owner's words

> Each item can have more than one supplier, and each supplier can provide this item in different UOM and rates. Inventory is where all this data is stored … their price is the average of the last month of purchases … then this base price is what recipes use for costing, wastage use for expenses, etc. and invoices use to compare prices. A truth across the app that always respects the UOM conversion.

The audit (this doc's §1) found that this is **already the app's design, and ~80% of it is built**. What was lost is *uniformity*: two price truths read by different pages, three stale copies of price/supplier on the item row, stock maths that ignores the bridges, an edit route that accepts anything, and an invoice matcher that keys on free-text supplier names and pollutes item names with OCR wording. This design does **not** replace the model. It finishes it, and then makes the item drawer the one place where the library is seen and maintained.

## Decisions (owner, 2026-10-02 / 2026-10-03)

| # | Decision |
|---|---|
| D1 | **Tweak, don't rebuild.** Offers (`InventorySupplierPrice`, one per supplier product, each with its own `packChain`/`pricing`) stay as the library. $/base keeps deriving at read time. |
| D2 | **Two bases, one source.** Recipes, menu and wastage use the **30-day weighted average** of approved receipts pooled across suppliers. Counts, stock value, COGS, variance, theoretical usage and orders use the **last paid price** (the primary offer). Invoice price alerts compare a line against **that supplier's own last offer**. Both bases derive from the same offer rows and the same frozen receipts, so they cannot drift. |
| D3 | **Build order: safety → names → drawer.** Stage 1 backbone, Stage 2 edit rules, Stage 3 names + supplier wordings, Stage 4 the library drawer. Each stage ships on its own. |
| D4 | **Edit rules (8)** — §3. Notably: stock changes only through a count; dimension is locked once an item has history, with a guided "change how it's measured" flow; prices are edited on the supplier box, never on the item; a bridge *can* be removed while recipes use it, and those recipes are flagged. |
| D5 | **Name + wording rules (9)** — §4. One generic `itemName`; invoice wordings and codes live per supplier; matching is supplier-scoped; the 53 OCR-named items are renamed from a suggested list the owner approves once. |

## 1. Audit — what exists and what broke

All refs are against `origin/main` @ `1c0248f`.

### 1.1 Already built (keep)

| Owner's idea | Where it lives today |
|---|---|
| Item has many suppliers, each with its own format/rate/SKU | `InventorySupplierPrice` (`prisma/schema.prisma:533`) — `packChain`, `pricing`, `supplierItemCode`, `packQty/Size/UOM`, `isPrimary`; unique per `(item, supplierName, COALESCE(supplierItemCode,''))`. Live: 258 offers on 216 items, 33 items with 2+ suppliers. |
| Every offer converts to $/base so suppliers compare | `offerPricePerBase()` (`src/lib/supplier-offers.ts`), `pricePerBaseUnit()` / `lineCost()` (`src/lib/item-model.ts:156,226`), the single `UNIT_FACTORS` table (`src/lib/uom.ts`). |
| Count↔weight and weight↔volume bridges | `InventoryItem.eachMeasureQty/Unit`, `densityGPerMl`; `convertQtyBridged()` (`uom.ts:265`); recipe costing flags an unbridgeable line as `dimensionConflict` and costs it $0 (`recipeCosts.ts:147`). |
| Invoice review asks for the bridge | `IssueKind 'bridge'` + `bridgeAndReceiveAsCount` (`src/components/invoices/v2/{atoms,context,card}.tsx`); approve has forward and reverse bridge paths (`approve/route.ts:259-281`) and refuses a cross-dimension rate it cannot cost (`:492-497`). |
| Last-month average | `windowedAvgCost()` / `foldCostBasis()` (`src/lib/cost-basis.ts`) — Σ `rawLineTotal` ÷ Σ frozen `receivedQtyBase`, 30 days, 20× implausibility guard, falls back to last price. |
| Invoice sets the item's price only when the line's supplier is primary | `approve/route.ts:758-821`; `syncPrimaryOfferToItem` (`src/lib/primary-offer.ts:70`). |

### 1.2 Broken uniformity (fix)

| Gap | Evidence |
|---|---|
| **Average used by 8 files, last price by ~40.** Wastage (`api/wastage/route.ts:63`), count finalize (`count-finalize.ts:119`), every report, EOD orders, chat, digest all call `pricePerBaseUnit` directly. | `grep cost-basis src` → 8 files; `grep -lE 'lineCost\(\|pricePerBaseUnit\('` → 40 files. |
| **Stale copies on the item row.** `purchasePrice` (never written by the drawer, read by orders/matcher/offer mirror), `supplierId` (never synced to the primary offer), `location` (no writer), `needsReview` (cleared by any save). | Live: 85 active items where `purchasePrice ≠ pricing.purchasePrice`; 85 where `supplierId ≠` primary offer's supplier; 249 carry a `location` string; 208 have no storage area. |
| **`offer.lastPrice` is a third copy**, refreshed from the stale `purchasePrice` by `mirrorItemToPrimaryOffer` (`primary-offer.ts:155`) → poisons the matcher's "was" price and price alerts. | 14 files read `lastPrice`. |
| **Theoretical stock ignores bridges.** Sales, prep draws, wastage and prep yield use plain `convertQty`, which passes a cross-dimension quantity through 1:1. 200 g of a per-each item depletes 200 each. | `count-expected.ts:199,211,445,692,703,715`. |
| **Edit route is unguarded.** `PUT /api/inventory/[id]` spreads `...rest` into `update` (mass assignment incl. `mergedIntoId`, `lastCountDate`); always re-sends `stockOnHand` rescaled by the *new* count unit, with no count stamp (the ledger then re-applies every movement since the last real count); the dimension toggle keeps a RATE number under the new unit ($12/kg → $12/ml); the pricing-mode toggle resets the price to 0 and validation accepts 0; PREP-owned fields are silently reverted by `syncPrepToInventory` after save. | `api/inventory/[id]/route.ts:61-72,143,149`; `InventoryItemDrawer.tsx:349-399,600-607`; `ItemChainEditor.tsx:212-218`. |
| **Offers have no editor.** The drawer can only star a primary (`SupplierOffersSection.tsx`); offer chains are never validated. | — |
| **Matching keys on supplier name strings.** `InvoiceMatchRule(rawDescription, supplierName)` has no supplier FK; Sysco is stored under 4 spellings in rules; the fuzzy tier is supplier-unscoped and borrows other suppliers' wording; tiers 0/1 can return inactive or PREP items; SKU normalisation differs between matcher, `pickOffer`, merge and the DB index. | `src/lib/invoice-matcher.ts:442-755`; live: 556 rules, 8 to inactive items. |
| **Item names polluted by OCR.** "Create new product" pre-fills `itemName` with the raw description and saves **no rule and no offer**. | `InvoiceReviewDrawer.tsx:1605`, `approve/route.ts:920,1177-1197`; live: 53 active items named like `GRAPE RED FRSH SEEDLS CLAM`. |
| **No dimension-change guard.** Only `scripts/repair-create-new-shape.ts` (via `src/lib/invoice/create-new-repair.ts` planners) rewrites item + offers + receipts + count lines + stock together. | — |

## 2. Stage 1 — one price backbone

### 2.1 The one function

`src/lib/cost-basis.ts` becomes the only module any reader imports for a money-per-base number. It already has `windowedAvgCost`. Add:

```ts
export type CostBasis = 'AVG_30D' | 'LAST'
/** $/base for one item on the requested basis. LAST = pricePerBaseUnit(primary offer chain). */
export async function itemCost(itemId: string, basis: CostBasis, asOf?: Date): Promise<ItemCostBasis>
/** Batched form for lists/reports — one query per call, never N+1. */
export async function itemCosts(itemIds: string[], basis: CostBasis, asOf?: Date): Promise<Map<string, ItemCostBasis>>
```

`pricePerBaseUnit()` / `lineCost()` in `item-model.ts` stay as the pure engine, but **no route or page calls them directly** for a cost number: a lint-style grep gate (`scripts/check-cost-readers.ts`, run in `npm test`) fails the build if any file outside `src/lib/{cost-basis,item-model,primary-offer,supplier-offers}.ts` and the tests imports `pricePerBaseUnit`/`lineCost`/`withPpb`. Display of the item's "last price" field in API responses keeps going through `withPpb` *inside* `cost-basis.ts`.

### 2.2 Who reads which basis

| Surface | Basis | Files to migrate |
|---|---|---|
| Recipe / menu cost, add-ingredient cost | AVG_30D (already) | — |
| Wastage `costImpact` (frozen at log time) | **AVG_30D** (change) | `api/wastage/route.ts` |
| Count finalize snapshot price, count value, count UI prices | LAST | `count-finalize.ts`, `api/count/**`, `quick-count.ts` |
| COGS, variance, theoretical usage, inventory efficiency, dashboard, analytics, cost-chrome, spine-audit | LAST | `api/reports/**`, `api/insights/**` |
| EOD orders unit price | LAST | `api/eod/orders/route.ts` (reads `purchasePrice` today) |
| Chat, digest, search, export | LAST | respective routes |
| Invoice price alert "was" price | **that supplier's offer** — `offerPricePerBase(offer)` of the line's supplier; never the item's price | `invoice-matcher.ts:333`, `approve/route.ts` |

### 2.3 Retire the stale copies

Same pattern as the 2026-06 `pricePerBaseUnit` column retirement: migrate readers → stop writers → drop column.

| Column | Replacement | Readers to migrate |
|---|---|---|
| `InventoryItem.purchasePrice` | `pricing.purchasePrice` / `pricing.rate` via `itemCost(LAST)` | ~30 files (`grep -l purchasePrice src`) — mostly response shaping |
| `InventoryItem.supplierId` | primary offer's `supplierId` (`primaryOfferOf(item)`) | `eod/orders`, `reports/analytics`, `inventory/page.tsx` grouping, list filters |
| `InventoryItem.location` | `storageAreaId` | `count/sessions/[id]/report/route.ts:70`, export |
| `InventoryItem.needsReview` | nothing (tooling flag; last writer was a one-off script) | drawer badge |
| `InventorySupplierPrice.lastPrice` | derived `offerLastPrice(offer)` = the offer's own `pricing` purchase price / rate | 14 files |
| `InventorySupplierPrice.supplierName` as a key | `supplierId` becomes **NOT NULL**; `supplierName` stays as display provenance only | matcher, approve, merge, the expression unique index → re-created on `(inventoryItemId, supplierId, COALESCE(supplierItemCode,''))` |

Backfill: `scripts/backfill-offer-supplier-fk.ts` resolves the 1 offer and every `InvoiceMatchRule` with a null/mismatched supplier through `matchSupplierByName` (`src/lib/supplier-matcher.ts`), **dry-run by default**, prints unresolved rows for a human, `--apply` writes. Backup JSON at repo root like every prior repair.

### 2.4 Bridges in stock maths

Replace the six `convertQty` calls in `count-expected.ts` with `convertQtyBridged(qty, from, to, bridgeOf(item))`. A line that still cannot cross (COUNT item, no each-measure) is **excluded from depletion and counted** in a new `unbridgeable` tally the ledger exposes, instead of passing through 1:1. The item drawer's movement track shows "n lines not counted — set 1 each = ? g".

### 2.5 Tests

- `cost-basis.test.ts`: `itemCost` LAST equals `pricePerBaseUnit(primary chain)`; AVG_30D equals existing `foldCostBasis`; alert basis uses the line's supplier offer, not the primary.
- `count-expected` tests: 200 g of a per-each item with `1 each = 100 g` depletes 2; with no bridge depletes 0 and tallies 1.
- Grep gate test for direct `pricePerBaseUnit` readers.
- Parity script `scripts/verify-cost-parity.ts`: for every active item, LAST via `itemCost` == old direct call (must print `OK — n items match` before the readers are switched).

## 3. Stage 2 — safe editing (the 8 rules)

| # | Rule (owner's words) | Contract |
|---|---|---|
| R1 | Saving only saves the form. Nothing hidden gets changed. | `PUT /api/inventory/[id]` accepts an explicit allow-list: `itemName, category, storageAreaId, isActive, isStocked, allergens, barcode, countUnit, eachMeasureQty, eachMeasureUnit, densityGPerMl`. Unknown keys → 400. `needsReview`, `stockOnHand`, `lastCount*`, `mergedIntoId`, `pricing`, `packChain`, `dimension` are **not** accepted here. |
| R2 | Stock changes only by counting. | The drawer's stock box is read-only; "Count now" opens the existing `QuickCountSheet` (`recordQuickCount`, stamps `lastCountDate`). `api/inventory/count/[id]/route.ts` ("mark counted" with the stale number) is deleted. |
| R3 | Weight / volume / each is locked once the item has history. A guided button fixes mistakes. | `hasHistory(itemId)` = any `CountLine`, `InventorySnapshot`, `InvoiceScanItem(matchedItemId)`, `RecipeIngredient`, `WastageLog`, `StockTransfer`, or 2+ offers. With history, a dimension/chain-shape change via PUT → 409 `DIMENSION_LOCKED`. New `POST /api/inventory/[id]/remeasure { measure, apply }` (MANAGER+) runs the `create-new-repair.ts` planners (`planItemRewrite`, `planOfferRewrite`, `planReceiptRefreeze`, `planCountRefreeze`, `planStockRewrite`) and returns the diff; `apply: true` executes it in one transaction with an `ItemMerge`-style manifest for undo. The drawer shows the diff ("3 counts, 12 invoice lines, 4 recipes will be restated") before Apply. |
| R4 | Prices are edited on the supplier box. The item copies its main supplier. | New `POST / PATCH / DELETE /api/inventory/[id]/suppliers[/offerId]` (MANAGER+). Body = `{ supplierId, supplierItemCode?, packQty, packSize, packUOM, pricing }` → `formToChain` → `validateChainItem` against the item's dimension + bridges → upsert. If the offer is primary, `syncPrimaryOfferToItem` runs (existing) and `propagatePrepCostChanges`. `mirrorItemToPrimaryOffer` is **deleted** — nothing flows item→offer any more. An item with **no** offers (no supplier yet) edits its own `pricing`/`packChain` through a separate `PATCH /api/inventory/[id]/pricing`; that route is refused (409 `HAS_OFFERS`) once the item has any offer, so there is never a second place to edit a supplier's price. DELETE of the last offer is allowed and leaves the item's chain as-is. DELETE of the primary promotes the next-most-recent offer (`ensurePrimary`). |
| R5 | No $0 prices by mistake. | `validateChainItem` gains `price > 0` unless `isStocked === false`. The pricing-mode toggle in `ItemChainEditor` carries the number across modes instead of resetting to 0. |
| R6 | Prep items are edited in their recipe. | For an item with `recipe != null`: name, dimension, chain, pricing, countUnit, allergens are read-only in the drawer and rejected by PUT (409 `PREP_OWNED`). The drawer links to `/recipes?item=<id>`. |
| R7 | A bridge can be removed while recipes use it; those recipes get flagged. | PUT with `eachMeasureQty: null` on an item referenced cross-dimension by `RecipeIngredient` returns the affected recipe list in a dry-run (`?dryRun=1`); the drawer shows "Burger Bun is used in 3 recipes — they will cost $0 until fixed" and asks once. On save, those recipes already surface `dimensionConflict` pills at read time (existing); additionally a `RecipeAlert` row per recipe (`exceededThreshold: true`, `newCost: 0`) so the pass/alerts feed shows them. |
| R8 | Two people editing at once: the second gets a warning. | PUT and offer routes require `expectedLastUpdated` (the row's `lastUpdated` the form loaded). Mismatch → 409 `STALE` with the current row; the drawer shows "Someone saved this item 2 minutes ago — reload". |

Also in Stage 2: `api/invoices/[id]/process/route.ts` (unauthenticated legacy price writer, no UI caller) is deleted; `api/recipes/[id]/route.ts` DELETE and `api/inventory/sync-prepd` get `requireSession(MANAGER)`.

## 4. Stage 3 — clean names and supplier wordings (the 9 rules)

### 4.1 Data

New table replacing `InvoiceMatchRule`:

```prisma
model ItemSupplierAlias {
  id               String   @id @default(cuid())
  inventoryItemId  String
  supplierId       String
  text             String            // normalised: lower, trimmed, single-spaced, punctuation stripped (same normaliser as the matcher)
  rawText          String            // as last seen on an invoice, for display
  supplierItemCode String?           // normalised with normItemCode (trim, upper)
  packQty          Decimal?          // learned human format, display/provenance only (as today)
  packSize         Decimal?
  packUOM          String?
  source           String            // 'APPROVE' | 'CREATE_NEW' | 'MERGE' | 'RENAME' | 'MANUAL'
  useCount         Int      @default(1)
  lastUsed         DateTime @default(now())
  createdAt        DateTime @default(now())
  inventoryItem    InventoryItem @relation(fields: [inventoryItemId], references: [id], onDelete: Cascade)
  supplier         Supplier      @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  @@unique([supplierId, text])
  @@index([supplierId, supplierItemCode])
  @@index([inventoryItemId])
}
```

Migration `*_item_supplier_alias`: create table; backfill from `InvoiceMatchRule` (supplier resolved by `matchSupplierByName`; rows whose supplier cannot be resolved or whose item is a tombstone/PREP are written to a report, not the table; duplicates after normalisation merge by summing `useCount`); then **drop** `InvoiceMatchRule`. `approve-undo.ts` `RULE_FIELDS`, `rollback.ts:486-499` and the merge manifest switch to alias ids — existing undo rows that reference rule ids are made no-ops for the rule step (they predate the table; a note in the migration).

### 4.2 Rules → behaviour

| # | Rule | Behaviour |
|---|---|---|
| W1 | One plain name per item. | `itemName` is the generic name. `POST /api/inventory` and CREATE_NEW refuse a name that is ≥ 70 % uppercase letters and ≥ 3 words (the OCR-style heuristic) with a hint, unless `allowShouty: true`. |
| W2 | Each supplier keeps its own wording and code. | Every approved line upserts an `ItemSupplierAlias` for (line's supplier, normalised description, code). CREATE_NEW does too (today it saves nothing), and creates the offer. |
| W3 | Matching order: that supplier's code → that supplier's wording → plain name. | Matcher tiers become: 0 alias by `(supplierId, code)`; 1 alias by `(supplierId, text)`; 2 fuzzy against `itemName` **only** (no borrowed aliases from other suppliers); 3 fuzzy against this supplier's aliases, capped MEDIUM. |
| W4 | Never land on switched-off or merged items. | Candidate set and alias joins filter `isActive && mergedIntoId == null && recipe == null` at every tier. |
| W5 | Create-new from an invoice asks for a plain name and saves the wording. | `CreateNewProductPanel` name box starts **empty** with the raw text shown beneath as "Sysco calls it: …"; the alias + offer are written on approve. |
| W6 | The four spellings of Sysco link to one Sysco. | Already `SupplierAlias`; the Stage 1 backfill collapses rule/offer supplier strings onto the FK. `learnAlias` on a *fuzzy* supplier hit becomes a suggestion the reviewer confirms, not an auto-save. |
| W7 | The drawer lists each supplier's wordings; a manager can remove a wrong one. | `GET /api/inventory/[id]/aliases`, `DELETE /api/inventory/[id]/aliases/[aliasId]` (MANAGER+). No add-by-hand in v1 (aliases are learned from invoices). |
| W8 | Small differences in wording are ignored. | One `normaliseAliasText()` in `src/lib/alias-text.ts`, used by the matcher, the upsert and the backfill; codes through `normItemCode`. |
| W9 | Merging two items keeps the old name as a wording. | `item-merge-exec.ts` writes an alias `{ supplier: absorbed item's primary offer supplier, text: absorbed itemName, source: 'MERGE' }` when the absorbed item has a primary offer, and re-points the absorbed item's aliases to the survivor (as it re-points rules today). |

### 4.3 The one-time rename

`scripts/propose-item-renames.ts` (read-only) lists the 53 shouty active items with a suggested generic name (Claude, same key as OCR, prompt: "restaurant ingredient, 1–4 words, Title Case, no pack size, no supplier code") → `docs/audits/2026-10-rename/proposals.json` + a markdown table for the owner. `scripts/apply-item-renames.ts --apply` writes the approved names and, for each, an alias `{ supplier: primary offer's supplier, text: old name, source: 'RENAME' }`, with a backup JSON. Nothing else changes (no prices, no stock).

## 5. Stage 4 — the library drawer

`InventoryItemDrawer.tsx` is rebuilt as a read-first library view. Sections, top to bottom:

1. **Header** — generic name, category, storage area, active/not-stocked badges. Edit (MANAGER+) opens the allow-listed form (R1).
2. **Cost line** — "Recipes cost this at **$0.42 / each** (30-day average, 4 deliveries)" and "Counts value it at **$0.46 / each** (last paid, Sysco, 28 Sep)". Both from `itemCost`. Hidden below LEAD (existing redaction).
3. **Supplier boxes** — one card per offer: supplier, code, human format ("1 cs = 8 × 9 each"), box price, **$/base**, last delivery, ★ primary. Cards sort by $/base. Each card: Edit / Remove (R4), Make main. "+ Add supplier box". Cards for PREP items are replaced by "Cost comes from the recipe →".
4. **Bridges** — "1 each = 85 g" / density, with the usage count ("used by 3 recipes") and R7 warning on removal.
5. **Supplier wordings** — grouped by supplier: wording, code, times seen, last seen, ✕ (W7).
6. **Stock** — on hand per revenue center, "Count now" (R2), last counted, theoretical, movement track with the `unbridgeable` tally (§2.4).
7. **History** — price history, merged-from items, recent invoice lines.

Mobile uses the same component (the drawer is already a bottom sheet under `md:`).

## 6. Rollout

| Stage | Migration? | Live-data script? | Owner approval point |
|---|---|---|---|
| 1 Backbone | yes — offer `supplierId` NOT NULL, new unique index; later a drop of 4 item columns + `lastPrice` | backfill-offer-supplier-fk (dry → apply) | parity script prints OK before switch |
| 2 Editing | no | none | — |
| 3 Names | yes — `ItemSupplierAlias`, drop `InvoiceMatchRule` | rule backfill (dry → apply); rename proposals → apply | owner approves the rename list |
| 4 Drawer | no | none | screenshots |

Each stage is its own PR off `origin/main`, squash-merged (never stacked — see `project_squash_merge_stacked_prs`). Every migration is hand-authored and grep-inspected for DROP/DELETE; drops ship in a *separate* PR after the readers have been live for a week.

## 7. Out of scope

- A per-item editor for aliases (learned only, v1).
- Changing the 30-day window or the 20× guard.
- Toast item mapping, prep planner, tips.
- Renaming `InventorySupplierPrice` → `ItemOffer` (functionally unnecessary).

## 8. Risks

- **Reader migration breadth (Stage 1).** ~40 files. Mitigated by the parity script and the grep gate; LAST basis is numerically identical to today, so no number on a count or report moves.
- **Wastage moves to the average.** Historic `costImpact` rows are frozen and untouched; only new logs change.
- **Supplier FK backfill** may leave a handful of rules/offers unresolved — they are reported, not guessed.
- **Rename** changes what chefs see in recipe lists. Mitigated by owner approval of every name and the alias keeping the old wording searchable.
