# Inventory Price Type (CASE vs UOM) Design

## Goal

Add a `priceType` field to inventory items so items priced by weight/volume (e.g. $9.90/kg) are handled correctly — both in the inventory UI and when the invoice scanner approves price updates.

## Background

Currently all inventory items assume `purchasePrice` is a per-case price, and `pricePerBaseUnit` is always derived via the full case formula. This is wrong for produce, meat, and other items sold by weight/volume, where the supplier quotes a rate (e.g. $/kg) rather than a case price. The invoice scanner already tracks `rawPriceType` (CASE/PKG/UOM) per scan line but does not propagate it to inventory on approve.

---

## 1. Data Model

### InventoryItem schema change

Add one field:

```prisma
priceType  String  @default("CASE")  // "CASE" | "UOM"
```

No changes to any other fields. `purchasePrice` retains its column but its semantics branch by `priceType`:

| priceType | purchasePrice meaning | pricePerBaseUnit formula |
|---|---|---|
| CASE | price per full case | `purchasePrice / (qtyPerPurchaseUnit × packSize × getUnitConv(packUOM))` |
| UOM | rate per unit (e.g. $/kg) | `purchasePrice / getUnitConv(packUOM)` |

`pricePerBaseUnit` is always derived — never entered directly by the user.

### InvoiceScanItem

No schema changes. `rawPriceType String @default("CASE")` already exists and is already persisted.

---

## 2. Calculation Logic

### `calcPricePerBaseUnit` (`src/lib/utils.ts`)

Add a `priceType` parameter with default `'CASE'` so all existing call sites continue to work unchanged:

```ts
export function calcPricePerBaseUnit(
  purchasePrice: number,
  qtyPerPurchaseUnit: number,
  qtyUOM: string,
  innerQty: number | null,
  packSize: number,
  packUOM: string,
  priceType: 'CASE' | 'UOM' = 'CASE',
): number {
  if (priceType === 'UOM') {
    const conv = getUnitConv(packUOM)
    return conv > 0 ? purchasePrice / conv : 0
  }
  // existing CASE formula unchanged
}
```

### Updated call sites

Three call sites must pass `priceType`:

1. **`/api/inventory` POST** — pass `priceType` from request body
2. **`/api/inventory/[id]` PATCH** — pass `priceType` from request body (or existing item value if not provided)
3. **`/api/invoices/sessions/[id]/approve`** — pass `rawPriceType === 'UOM' ? 'UOM' : 'CASE'`

Client-side display in both drawers recalculates live using the same logic.

---

## 3. Inventory UI (`InventoryItemDrawer`)

### New priceType toggle

Added to the Purchase Structure section, above the price field:

```
Price Type:  [● Per Case]  [○ Per UOM]
```

Default: Per Case.

### Field visibility rules

| Field | Per Case | Per UOM |
|---|---|---|
| Price field (label changes) | "Price / Case" | "Price / [packUOM]" |
| packUOM | visible | visible |
| qtyPerPurchaseUnit | visible | hidden |
| innerQty | visible | hidden |
| packSize | visible | hidden |

### List view

No changes. `pricePerBaseUnit` is already what's displayed in the table/cards and is correctly derived.

---

## 4. Invoice Approve Route (`/api/invoices/sessions/[id]/approve`)

### rawPriceType handling

The route reads `rawPriceType` from each `InvoiceScanItem` and branches:

**`rawPriceType === 'UOM'`:**
- `purchasePrice` written to inventory = `newPrice` (the rate, e.g. $9.90/kg — must be `rawUnitPrice`, not derived from line total)
- `priceType` written to inventory = `'UOM'`
- `pricePerBaseUnit` = `newPrice / getUnitConv(packUOM)`

**`rawPriceType === 'PKG'`:**
- Convert to per-case equivalent: `purchasePrice = newPrice × packSize`
- `priceType` written = `'CASE'`
- `pricePerBaseUnit` via normal CASE formula

**`rawPriceType === 'CASE'` (default):**
- No change from current behavior
- `priceType` written = `'CASE'`

### newPrice source for UOM items

For UOM scan items, `newPrice` must be the rate (e.g. $9.90/kg). The OCR extracts `rawUnitPrice` which is the per-unit price — the matcher/review UI must ensure `newPrice` reflects `rawUnitPrice` for UOM items, not a quantity-derived total.

No changes needed to OCR or matcher. The review UI already lets users set/override `newPrice` before approval.

---

## 5. Invoice Scanner Item Editor (Field Alignment)

The item editing panel inside `InvoiceDrawer` gains the same field layout as `InventoryItemDrawer`:

- **priceType toggle** (Per Case / Per UOM) — pre-populated from the matched item's `priceType`; user can override
- **Price field label** matches: "Price / Case" or "Price / [packUOM]"
- `packUOM` always visible
- `qtyPerPurchaseUnit`, `innerQty`, `packSize` hidden when priceType = UOM

**Important distinction:** `rawPriceType` on the scan item = what the invoice said. The priceType toggle in the editor = what gets written to inventory on approve. Both coexist.

No shared component is created. Both drawers independently implement the same field layout.

---

## 6. Error Handling

- If `getUnitConv(packUOM)` returns 0 for a UOM item, `pricePerBaseUnit` = 0 (same defensive behavior as CASE path).
- PKG → CASE conversion: if `packSize` is 0 or null, fall back to `newPrice` as-is (treat as single unit).
- Existing items with no `priceType` field default to `'CASE'` via Prisma default — no backfill migration needed.

---

## 7. Out of Scope

- PKG as a permanent inventory `priceType` — PKG is a purchasing exception that converts to CASE on approve.
- Shared `InventoryItemDrawer` component between inventory page and invoice scanner — field alignment only, no component unification.
- Price history display changes — `PriceAlert` records already store raw prices; no changes needed.
- Any changes to OCR prompts, the fuzzy matcher, or `InvoiceMatchRule` logic.
