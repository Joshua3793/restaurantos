# Inventory CSV/Excel Import — Design Spec

**Date:** 2026-05-21

## Goal

Add an **Import** button to the Inventory page that lets a user bulk-add inventory items from a `.csv` or `.xlsx` file, using a simple, typo-resistant template. The system parses the file, validates every row, shows a preview, and creates the valid items — never silently producing bad data.

---

## Background — the inventory pricing model

An `InventoryItem` derives `pricePerBaseUnit`, `conversionFactor`, and `baseUnit` from a set of input fields: `purchaseUnit`, `qtyPerPurchaseUnit`, `qtyUOM`, `packSize`, `packUOM`, `innerQty`, `priceType` (`CASE` | `UOM`), `countUOM`, `purchasePrice`. The pricing math lives in `src/lib/utils.ts` (`calcPricePerBaseUnit`, `calcConversionFactor`, `deriveBaseUnit`).

That full model is too complex for a manager to fill in a spreadsheet without errors. This feature exposes a **simplified** column set and maps it onto the existing engine.

---

## Scope decisions (locked)

- **Create-new-only.** Rows whose `Item Name` matches an existing item (case-insensitive) are skipped as duplicates. The import never updates or overwrites existing items.
- **No relations in the CSV.** Imported items get `category = "UNASSIGNED"`, `supplierId = null`, `storageAreaId = null`. The user reviews the `UNASSIGNED` items afterward and bulk-assigns category / supplier / storage area.
- **Simplified pricing.** A single `Price Basis` column plus `Purchase Price`; `Per Case` adds two columns. Deeply nested pack structures (case → inner packs → units) are not expressible — those rare items are edited individually after import.
- **File formats:** both `.csv` and `.xlsx` accepted on upload.

---

## CSV/Excel template format

Seven columns:

| Column | Required | Notes |
|---|---|---|
| `Item Name` | Yes | Item identity; used for duplicate detection |
| `Purchase Price` | Yes | Numeric; the amount paid |
| `Price Basis` | Yes | What the price covers — enum (see below) |
| `Case Contains` | Only if `Price Basis = Per Case` | Numeric; content units per case |
| `Content Unit` | Only if `Price Basis = Per Case` | Unit of case contents — enum (see below) |
| `Stock On Hand` | No (default `0`) | Counted in the Content Unit (Per Case) or the basis unit |
| `Barcode` | No | Optional string |

**`Price Basis` allowed values:** `Per Case`, `Per Each`, `Per kg`, `Per g`, `Per L`, `Per mL`, `Per lb`, `Per oz`.

**`Content Unit` allowed values:** `each`, `kg`, `g`, `L`, `mL`, `lb`, `oz`.

### Example

```
Item Name         | Purchase Price | Price Basis | Case Contains | Content Unit | Stock On Hand | Barcode
Diced Tomatoes    | 24.00          | Per Case    | 24            | each         | 12            |
All Purpose Flour | 18.50          | Per kg      |               |              | 40            |
Olive Oil         | 65.00          | Per Case    | 6             | L            | 4             |
```

### Template download — typo prevention

The downloadable `.xlsx` template is **generated programmatically with the `exceljs` library**, which supports writing Excel data-validation dropdowns (the existing SheetJS `xlsx` library cannot). The template endpoint builds the file on each request: the header row, two example rows, and **list-type data-validation dropdowns** on the `Price Basis` and `Content Unit` columns so the user picks valid values instead of typing them.

`exceljs` is added as a dependency, used **only** for template generation. Import-file *parsing* continues to use the existing `xlsx` dependency.

Generating the template from code keeps it in sync if the valid values ever change. Typo prevention has two layers: the dropdown (convenience) and the import preview's strict validation (the hard guarantee).

---

## Row → `InventoryItem` mapping

`src/lib/inventory-import.ts` maps a validated row to an inventory-create payload. `Price Basis` is normalized case-insensitively and whitespace-trimmed; synonyms (`kg`, `per kg`, `PER KG`) resolve to the canonical value.

| Price Basis | Internal mapping |
|---|---|
| `Per Each` | `priceType=CASE`, `qtyPerPurchaseUnit=1`, `qtyUOM='each'`, `packSize=1`, `packUOM='each'`, `purchaseUnit='each'` → `pricePerBaseUnit = price`, `baseUnit='each'` |
| `Per kg` | `qtyPerPurchaseUnit=1`, `qtyUOM='kg'`, `purchaseUnit='kg'` → `pricePerBaseUnit = price/1000`, `baseUnit='g'` |
| `Per g` | `qtyUOM='g'` → `pricePerBaseUnit = price`, `baseUnit='g'` |
| `Per L` | `qtyUOM='l'`, `purchaseUnit='L'` → `pricePerBaseUnit = price/1000`, `baseUnit='ml'` |
| `Per mL` | `qtyUOM='ml'` → `pricePerBaseUnit = price`, `baseUnit='ml'` |
| `Per lb` | `qtyUOM='lb'` → `pricePerBaseUnit` via `getUnitConv('lb')`, `baseUnit='g'` |
| `Per oz` | `qtyUOM='oz'` → `pricePerBaseUnit` via `getUnitConv('oz')`, `baseUnit='g'` |
| `Per Case` + `Content Unit=each` | `qtyPerPurchaseUnit=CaseContains`, `qtyUOM='each'`, `purchaseUnit='Case'` → `pricePerBaseUnit = price/CaseContains`, `baseUnit='each'` |
| `Per Case` + `Content Unit=kg` | `qtyPerPurchaseUnit=CaseContains`, `qtyUOM='kg'`, `purchaseUnit='Case'` → `pricePerBaseUnit = price/(CaseContains×1000)`, `baseUnit='g'` |
| `Per Case` + other content units | analogous: `qtyUOM` = the content unit |

All mappings funnel through the existing `calcPricePerBaseUnit` / `calcConversionFactor` / `deriveBaseUnit` so behavior matches the manual add-item form.

**Stock On Hand:** entered in the Content Unit (`Per Case`) or the basis unit (otherwise). `countUOM` is set to that unit; `stockOnHand` is stored in base units = `enteredStock × conversionFactor`. Blank → `0`.

---

## Import flow & UX

A new **Import** button on the Inventory page, beside **Export**, opens `InventoryImportModal` — a three-step modal:

**Step 1 — Upload.** "Download template" link + a file picker accepting `.csv` and `.xlsx`.

**Step 2 — Preview.** The file is POSTed to the preview endpoint, which parses and validates **without writing to the database**. The modal renders every parsed row tagged:
- **Valid** — will be created; shows computed `pricePerBaseUnit` + `baseUnit` for a sanity check.
- **Error** — excluded; shows the reason (e.g. `"Price Basis 'Per box' not recognized — use: Per Case, Per Each, Per kg, Per g, Per L, Per mL, Per lb, Per oz"`).
- **Duplicate** — an item with that name already exists; skipped.
A summary line shows counts: `"18 valid · 3 errors · 2 duplicates"`. If 0 valid rows, the Import button is disabled.

**Step 3 — Confirm.** "Import N items" creates the valid rows. Result: `"Created N items in the UNASSIGNED category — review and assign their category, supplier, and storage area."` Modal closes; the inventory list refreshes.

Errors never block valid rows. The user fixes flagged rows in their spreadsheet and re-imports; duplicates are skipped, so re-importing is safe.

---

## Validation rules

A row is an **Error** if any of:
- `Item Name` is blank.
- `Purchase Price` is missing or not a non-negative number.
- `Price Basis` is missing or not in the allowed set (after normalization).
- `Price Basis = Per Case` and `Case Contains` is missing / not a positive number.
- `Price Basis = Per Case` and `Content Unit` is missing / not in the allowed set.
- `Stock On Hand` is present but not a non-negative number.

A row is a **Duplicate** (not an error) if `Item Name` case-insensitively matches an existing active or inactive `InventoryItem`, or another row earlier in the same file.

All other rows are **Valid**.

---

## Architecture

### New files

- `src/lib/inventory-import.ts` — pure logic, no DB access. Exports:
  - `parseImportFile(buffer: Buffer): RawRow[]` — parses `.csv`/`.xlsx` via the existing `xlsx` dependency.
  - `validateRows(rows: RawRow[], existingNames: Set<string>): RowReport[]` — classifies each row Valid / Error / Duplicate with reasons.
  - `mapRowToPayload(row: RawRow): InventoryCreatePayload` — maps a valid row to the create payload.
- `src/app/api/inventory/import/preview/route.ts` — `POST`; accepts the uploaded file, returns the validation report. No writes. `export const dynamic = 'force-dynamic'`.
- `src/app/api/inventory/import/route.ts` — `POST`; accepts the file, re-validates, creates the valid items inside a transaction, returns counts. `export const dynamic = 'force-dynamic'`.
- `src/app/api/inventory/import/template/route.ts` — `GET`; generates and serves the dropdown-enabled `.xlsx` template via `exceljs`. `export const dynamic = 'force-dynamic'`.
- `src/components/inventory/InventoryImportModal.tsx` — the three-step modal.

### New dependency

- `exceljs` — used only by the template route to write data-validation dropdowns.

### Modified files

- The Inventory page — add the **Import** button next to Export, and render `InventoryImportModal`.
- `src/app/api/inventory/export/route.ts` — add a `Price Basis` column and align column names so an exported file is shaped like the import template (round-trip safe). This also closes the per-weight/per-case gap in the current export.

### Shared validation

The preview and commit endpoints both call the same `validateRows` from `inventory-import.ts` — what the preview shows is exactly what the commit creates. The commit re-validates server-side (never trusts a client-submitted "valid" list).

### `UNASSIGNED` category

On import, the importer ensures an `UNASSIGNED` category exists. If the app maintains a `Category` table (`/api/categories`), an `UNASSIGNED` row is created if absent; the `InventoryItem.category` string field is set to `"UNASSIGNED"` regardless.

---

## Error handling

- Unparseable / corrupt file → preview endpoint returns a 400 with a human message; the modal shows "Could not read this file — make sure it's a .csv or .xlsx."
- Empty file (headers only) → preview reports "0 rows found."
- Missing required header columns → preview returns a clear error naming the missing columns.
- A DB failure mid-commit → the create runs in a transaction; on failure nothing is committed and the modal shows an error.

---

## Out of scope

- Updating or overwriting existing items (create-new-only).
- Importing supplier / storage area / category assignments.
- Deeply nested pack structures.
- Scheduled / automated imports.
- Bulk-assign UI for category/supplier/storage — assumed to already exist or handled separately; this spec only guarantees imported items are easy to find (all in `UNASSIGNED`).
