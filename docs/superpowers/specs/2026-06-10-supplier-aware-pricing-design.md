# Supplier-Aware Pricing ("Supplier Offers") — Design

**Date:** 2026-06-10 · **Status:** Approved by Joshua

## Problem

The same inventory item is bought from multiple suppliers (e.g. Brioche Unsliced from Snow Cap and Sysco), but the app tracks only one price and one pack format per item:

1. **No supplier comparison** — no way to see which supplier is cheaper or which supplier's price is unstable.
2. **Repetitive false price alerts** — `pricePerBaseUnit` and `purchasePrice` are overwritten by whichever supplier was invoiced last, so every supplier alternation reads as a "price change" even when both suppliers' prices are flat.
3. **Repetitive false format mismatches** — pack format is a single field on the item, so Snow Cap's 24-pack and Sysco's 36-pack fight over it on every alternation.

`InventorySupplierPrice` already exists and is upserted on every approval — `(inventoryItemId, supplierName, supplierId, lastPrice, pricePerBaseUnit, lastUpdated, isPrimary)` — but **nothing reads it** and it carries no pack format, SKU, or history.

## Decisions (made with Joshua)

| Decision | Choice |
|---|---|
| Costing policy | **Last price paid, any supplier** — the spine (`InventoryItem.pricePerBaseUnit`) keeps updating on every approval; recipes always reflect the most recent real purchase. Supplier tracking is layered alongside, never replaces it. |
| Supplier link depth | **Full supplier offers** — each item–supplier link carries its own pack format, supplier item code, and last price. |
| UI surfaces | All three: inventory item page, invoice review drawer, purchasing report. |
| `isPrimary` | Kept, user-settable from the item page. Used for highlighting and reports only — **never** for costing. |

## 1 · Data model

Extend `InventorySupplierPrice` (additive migration, using the diff/db-execute/resolve workaround — shadow DB is broken):

```prisma
model InventorySupplierPrice {
  // existing: id, inventoryItemId, supplierName, supplierId,
  //           lastPrice, pricePerBaseUnit, lastUpdated, isPrimary
  supplierItemCode     String?   // this supplier's SKU for the item
  packQty              Decimal?  // THIS supplier's pack: qty per case
  packSize             Decimal?  //                       size per pack
  packUOM              String?   //                       unit
  lastInvoiceSessionId String?   // provenance: the approval that last set this offer
}
```

Add `@@unique([inventoryItemId, supplierName])` if not present (the approve route currently de-dupes with `findFirst`; a real unique constraint + upsert replaces that). Add an index on `InvoiceScanItem(matchedItemId)` if missing — price history queries join scan items by matched item.

**Price history is derived, not stored.** Every approved scan item already records (price, supplier via session, invoiceDate). History/volatility queries read approved `InvoiceScanItem` joined to `InvoiceSession` (`status = 'APPROVED'`, `action IN ('UPDATE_PRICE','ADD_SUPPLIER')`), using the effective unit price the line was approved with (`newPrice`).

## 2 · Write path changes

### Matcher (`src/lib/invoice-matcher.ts`)

`matchLineItems` additionally loads this supplier's offers for the candidate item set (`where: { supplierName }`). In `buildMatchResult`, when an offer exists for (matched item, session supplier):

- **`previousPrice` = `offer.lastPrice`** (that supplier's last price) instead of `item.purchasePrice`. `priceDiffPct` therefore measures *this supplier vs itself*. No offer → current behavior (item.purchasePrice).
- **Format comparison runs against the offer's pack format first** (`offer.packQty/packSize/packUOM`), falling back to the item's format when the offer has none. `formatMismatch` fires only when the invoice differs from what *this supplier* is known to ship.
- A new result field `spinePrice` (the item's current `pricePerBaseUnit`) and `offerPricePerBase` are carried so the drawer can render the supplier-switch note without recomputing.

### Approve route (`src/app/api/invoices/sessions/[id]/approve/route.ts`)

- Spine update **unchanged** (last-paid policy): `purchasePrice` + `pricePerBaseUnit` still written per the existing trust gates.
- The supplier-price upsert becomes the **offer upsert**: writes `lastPrice`, `pricePerBaseUnit`, `lastUpdated`, `lastInvoiceSessionId`, `supplierItemCode` (from the scan line), and the **resolved** pack format (`invoicePackQty/Size/UOM` after the user's review decisions). The offer's format always tracks what this supplier actually shipped — the `applyInvoiceFormat` consent flag continues to gate only the *item's* reference format, exactly as today.
- **`PriceAlert` becomes supplier-scoped**: created from `priceDiffPct` (which now means same-supplier delta). A supplier switch with both suppliers flat produces **no alert**. The ≥15% threshold is unchanged.

### Item page "set primary"

`PATCH /api/inventory/[id]/suppliers/[offerId]` (or equivalent) sets `isPrimary` true on one offer and false on siblings.

## 3 · Read surfaces

### Inventory item page — "Suppliers" section

One row per offer: supplier name, their pack (`24 × 1 each`), their SKU, **$/base unit normalized** (so different pack sizes compare honestly), last price, last bought date, stability badge, primary star (tap to set). Cheapest $/base row highlighted. Data from a new endpoint `GET /api/inventory/[id]/suppliers` returning offers + per-supplier trailing-90-day history stats.

### Invoice review drawer

- When the line's matched item has offers from **other** suppliers, and the spine price differs from this supplier's offer while the same-supplier delta is small: render an info-tone **supplier-switch note** instead of a price-change issue: *"Supplier switch — Sysco $0.42/ea vs Snow Cap $0.38/ea (your last buy)."*
- The price-compare card shows "vs this supplier last time"; when the cheapest other offer is lower, a secondary line "cheapest: Snow Cap $0.38/ea".
- Big-price-change gating (`isBigPriceChange`) now keys off the supplier-scoped `priceDiffPct` — alternation noise no longer demands acknowledgements.

### Purchasing report (`/reports/purchasing`)

New "Multi-supplier items" block:
- Items with ≥2 offers: per-supplier $/base, spread %, cheapest highlighted.
- **Savings estimate**: for the trailing 30 days, Σ over multi-supplier purchases of (paid $/base − cheapest offer $/base) × quantity — "buying each from its cheapest supplier would have saved ~$X".
- **Most volatile items**: top N by volatility (any supplier), with per-supplier badges.

## 4 · Volatility metric

Per (item, supplier), over trailing 90 days of approved invoice lines, on normalized $/base-unit prices:

- `< 3` purchases → "—" (insufficient data)
- Coefficient of variation (stddev ÷ mean): **< 5% Stable** (green) · **5–15% Variable** (gold) · **> 15% Volatile** (red)

Computed server-side in the suppliers endpoint and the purchasing report; no caching (query is small and indexed).

## 5 · Backfill

One-off script (`scripts/backfill-supplier-offers.ts`, run manually like `assign-allergens.ts`): walk approved sessions **oldest → newest**; for each approved scan item with a matched item, upsert the offer with that line's price/format/SKU. Newest wins (chronological order guarantees `lastPrice` ends correct). Existing `InventorySupplierPrice` rows are updated in place (the unique constraint may require de-duping rows first — check before adding the constraint in the migration).

## Out of scope (explicitly)

- Purchase orders / ordering from suppliers.
- Alternative costing modes (weighted average, primary-supplier costing) — `isPrimary` is informational only.
- Supplier management UI changes beyond the item-page section.
- Cross-item supplier scorecards ("Sysco is 4% more expensive overall") — derivable later from the same data.

## Compatibility / fallbacks

- Items with no offers (never bought, or CSV imports without supplier) behave exactly as today everywhere.
- Sessions with no supplier: matcher skips offer loading; alerts fall back to item-price comparison (current behavior).
- The format-consent (`applyInvoiceFormat`) and trust-gate semantics from the 2026-06-10 invoice-accuracy work are unchanged.
