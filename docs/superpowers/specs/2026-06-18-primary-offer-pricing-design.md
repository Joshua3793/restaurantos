# Primary-offer-driven pricing — design

**Date:** 2026-06-18
**Status:** Approved design, pending implementation plan
**Source spec:** `~/Downloads/Controla OS (2)/controla-pack-chain` + `item-model-redesign/sections2.jsx` ("Item Offer supplier spec")

## Problem

The pack-chain item model is fully adopted (`InventoryItem.dimension/packChain/pricing/countUnit`,
`src/lib/item-model.ts`), and supplier offers already exist as `InventorySupplierPrice` rows
that each carry their own `packChain` + `pricing` (so each offer's `pricePerBaseUnit` derives on
read via `offerPricePerBase()` in `src/lib/supplier-offers.ts`).

The one idea from the spec that was **not** implemented is the **authority inversion**:

> "The model promotes offers to a first-class `ItemOffer[]`; the item's headline
> `pricePerBaseUnit` is just the primary offer's computed value."

Today the item's `pricing` is overwritten at invoice approve by *whichever line was processed*,
regardless of which supplier it came from and regardless of which offer is `isPrimary`. That
leaves two parallel pricing authorities (the item spine vs. the offers) that can silently
disagree, and there is no way to say "buy this from Costco, not GFS" and have the item re-price.

## Decisions (locked)

1. **Full inversion, scoped to items that have offers.** For any item with ≥1 supplier offer, the
   item's headline price is the **primary offer's** computed `pricePerBaseUnit`. Items with **no**
   offers (PREP-linked items synced from recipe cost, manually-created items, non-stocked
   utilities like water) keep authoring their own `item.pricing` unchanged — the offer model does
   not apply to them.
2. **Keep `InventorySupplierPrice`.** No rename to a literal `ItemOffer` table; the existing table
   already has the right shape (`packChain`, `pricing`, `lastInvoiceSessionId`, `isPrimary`).
3. **The primary supplier is a deliberate, sticky, manual choice.** It is **never** auto-promoted by
   an invoice. The only ways the primary changes are: (a) bootstrapping — the first offer an item
   ever receives becomes primary; (b) the user explicitly switches it in the UI.
4. **On sync, the item adopts the primary offer's pricing chain** (`item.packChain` ← primary
   offer's `packChain`, `item.pricing` ← primary offer's `pricing`). `countUnit` is re-validated
   against the adopted chain and falls back to the base unit if it is no longer a chain level.
5. **Backfill default primary = most-recently-updated offer**, applied only to items that have
   offers but no primary set.
6. **Write-time sync, not compute-on-read.** A single transactional helper recomputes the item
   spine from the primary offer whenever the primary offer (or the choice of primary) changes. The
   ~46 existing spine readers are untouched — they keep reading `item.pricing` / derived ppb.

## Architecture

### The single invariant

> An item with ≥1 `InventorySupplierPrice` row has **exactly one** row with `isPrimary = true`, and
> `item.packChain` / `item.pricing` equal that row's `packChain` / `pricing`.

Enforced two ways:
- **DB:** a partial unique index `(inventoryItemId) WHERE isPrimary` guarantees ≤1 primary per item.
- **Code:** every offer mutation runs inside a transaction that ends with
  `syncPrimaryOfferToItem`, which re-establishes the equality above.

### New module: `src/lib/primary-offer.ts`

The unit of work, isolated and independently testable. Depends only on Prisma + `item-model.ts`.

- `ensurePrimary(itemId, tx)` — guarantees the item has exactly one primary when it has offers:
  if none is primary, promote the most-recently-updated offer; if >1 (shouldn't happen given the
  index, but defensive), keep the most-recently-updated and clear the rest. No-op for items with no
  offers.
- `syncPrimaryOfferToItem(itemId, tx)` — reads the primary offer, writes `item.packChain` +
  `item.pricing` from it, re-validates `countUnit` against the new chain (`item-model.ts`
  `countableUnits`), falls back to base unit if invalid. No-op (item spine preserved) for items with
  no offers. Returns `{ changed: boolean, oldPpb, newPpb }` so callers know whether to fire alerts.
- `setPrimaryOffer(itemId, offerId, tx)` — flips `isPrimary` to the chosen offer, clears the rest,
  then calls `syncPrimaryOfferToItem`. Returns the same delta object.

These return the ppb delta rather than firing alerts themselves, so the alert/recipe-recost
side-effects stay in the route layer where they already live (keeps the helper pure-ish and the
fan-out testable).

### Write-path changes

| Path | Today | After |
|---|---|---|
| **Invoice approve** (`api/invoices/sessions/[id]/approve/route.ts`) | Upserts the supplier's offer **and** overwrites `item.pricing` from the processed line. | Upserts the supplier's offer (unchanged). Then: `ensurePrimary`. If the approved line's supplier **is** the primary (or the item just bootstrapped its first offer) → `syncPrimaryOfferToItem` and fire recipe re-cost + `PriceAlert`/`RecipeAlert` on the ppb delta, exactly as now. If the line's supplier is **not** primary → record the offer only; **do not** touch the item spine, **do not** alert. |
| **Set primary (new)** `POST /api/inventory/[id]/offers/[offerId]/primary` | — | `setPrimaryOffer`, then fire recipe re-cost + alerts on the delta. This is the deliberate "switch supplier and re-price" action. |
| **Manual inventory edit** (`api/inventory/[id]/route.ts`) | Writes `item.pricing` directly. | If the item has offers → the price edit edits the **primary offer** then syncs. If the item has no offers → writes `item.pricing` directly (unchanged). |
| **PREP sync** (`recipeCosts.ts` `syncPrepToInventory`) | Writes `item.pricing`. | Unchanged — PREP-linked items have no supplier offer. |

The canonical spine writer (invoice approve) and the `PriceAlert`/`RecipeAlert` fan-out keep their
current structure; only the *condition* under which the item spine is rewritten changes (primary-only
instead of every line).

### Read path / comparison UX

`getSupplierOffers()` already returns per-supplier ppb, primary flag, volatility, 90-day history.
Add to its return: rank offers by ppb ascending and flag `isCheapest` on the lowest. In
`src/components/inventory/SupplierOffersSection.tsx`:
- highlight the cheapest row and tag it "cheapest" (visual reference: `sections2.jsx` multi-supplier
  table — gold row, gold per-unit figure);
- a "Set as primary" control on each non-primary row, calling the new endpoint;
- a nudge when `cheapest !== primary` ("Costco is cheaper per ml than your primary GFS").

No new pricing math — purely ranking the values the helper already computes.

## Data flow (set-primary, the representative case)

1. User clicks "Set as primary" on the Costco offer in the inventory drawer.
2. `POST /api/inventory/[id]/offers/[offerId]/primary` → transaction: `setPrimaryOffer` flips the
   flag, clears the old primary, writes Costco's chain+pricing onto the item, re-validates
   `countUnit`. Returns `{ changed: true, oldPpb, newPpb }`.
3. Route fires the existing recipe re-cost + `PriceAlert`/`RecipeAlert` fan-out on the delta.
4. Cost-chrome strip (reads `item.pricing`-derived ppb) and any dependent recipe now reflect Costco.

## Edge cases

- **Item with no offers** — `syncPrimaryOfferToItem` is a no-op; `item.pricing` stands. Covers
  PREP-linked, manual, CSV-imported, and non-stocked items.
- **Deleting the primary offer** — after delete, `ensurePrimary` promotes the most-recently-updated
  remaining offer and re-syncs; if it was the last offer, the item keeps its last synced
  `item.pricing` (no offer to derive from — frozen, not zeroed).
- **`countUnit` orphaned by chain adoption** — re-validated each sync; falls back to base unit.
- **Catchweight / RATE-mode primary offer** — `item-model.ts` `pricePerBaseUnit` already handles
  RATE; sync copies `pricing.mode='RATE'` through unchanged.
- **First-ever offer** — bootstraps as primary and re-prices (this is the only auto-promotion).

## Migration / backfill (expand-only, non-destructive)

1. **DDL:** add partial unique index `InventorySupplierPrice_primary_per_item`
   `(inventoryItemId) WHERE "isPrimary"`. Applied over the pooler via `$executeRawUnsafe`
   (direct DB host unreachable; no full-schema `migrate diff`), recorded as a migration per the
   project's documented workaround.
2. **Script:** `scripts/backfill-primary-offers.ts` — idempotent, `APPLY=1`-gated, dry-run first.
   For each item with offers: `ensurePrimary` (promote most-recently-updated where none is primary),
   then `syncPrimaryOfferToItem`. Logs every item whose ppb **changed** as a result (these are items
   whose `item.pricing` had drifted from the primary offer — the human review queue) and prints a
   total-valuation conservation summary. Mirrors `scripts/backfill-pack-chain.ts` conventions.

## Verification

- `npm run build` — the only automated correctness check; run after every non-trivial change.
- `scripts/verify-primary-offers.ts` asserts: (1) every item-with-offers has exactly one primary;
  (2) item headline ppb equals its primary offer's computed ppb within 0.5% tolerance; (3) reports
  total inventory valuation delta vs. pre-backfill.
- Manual: approve a multi-supplier invoice for a **non-primary** supplier → confirm the item price
  does **not** move; switch primary in the drawer → confirm the cost-chrome strip + a dependent
  recipe re-cost.

## Out of scope

- Renaming `InventorySupplierPrice` → `ItemOffer` (decided against).
- Removing `item.packChain`/`item.pricing` columns (kept; they are the synced spine cache, untouched
  for offer-less items).
- Any change to the count, recipe, or theoretical-stock math beyond what `countUnit` re-validation
  requires.
