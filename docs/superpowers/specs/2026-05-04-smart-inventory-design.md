# Smart Inventory — Par Levels & Barcode/SKU

## Goal

Add per-revenue-center par levels (with smart order quantity suggestions) and a barcode field to inventory items, extending the count-page camera scanner to match by barcode.

## Architecture

Par levels live on `StockAllocation` (already per-RC per-item) so each revenue center has independent thresholds. A new `PATCH /api/stock-allocations` endpoint saves them. The order guide expands to include any item whose theoretical stock is below par, not just zero-stock items. The barcode is a single nullable field on `InventoryItem`; the count scanner queries it via `/api/inventory/search?barcode=X`.

## Tech Stack

Next.js 14 App Router · TypeScript · Prisma + PostgreSQL · Tailwind CSS

---

## Schema Changes

### `InventoryItem` — add `barcode`

```prisma
model InventoryItem {
  // ... existing fields ...
  barcode String? // UPC / EAN / internal code — used by count scanner
}
```

### `StockAllocation` — add `parLevel` + `reorderQty`

```prisma
model StockAllocation {
  // ... existing fields ...
  parLevel    Decimal? // minimum desired stock in baseUnit; null = no par set
  reorderQty  Decimal? // fixed order quantity override in purchaseUnit; null = auto (par - current)
}
```

---

## API Changes

### New: `PATCH /api/stock-allocations`

Upserts `parLevel` and `reorderQty` for a single allocation row.

**Request body:**
```json
{ "inventoryItemId": "...", "rcId": "...", "parLevel": 10, "reorderQty": null }
```

**Behaviour:**
- Upserts the `StockAllocation` row (creates if missing, updates if exists).
- `parLevel` is stored in `baseUnit` (convert from `countUOM` before saving, matching the existing `quantity` convention).
- `reorderQty` is stored in `purchaseUnit` (it's what gets typed into the order guide — cases, kg, etc.).
- Returns the updated allocation row.

### Modified: `GET /api/inventory`

When `rcId` is present, the existing route already joins `StockAllocation` to attach `rcStock`. Extend that pass to also attach `parLevel` and `reorderQty` onto each returned item.

**New fields on response item (when rcId provided):**
```json
{
  "rcStock": 3.0,
  "parLevel": 10.0,
  "reorderQty": null
}
```

`parLevel` is converted from `baseUnit` → `countUOM` before returning (same conversion applied to `rcStock`).

### Modified: `GET /api/inventory/search`

Add optional `?barcode=X` query param. When present, performs an exact match on `InventoryItem.barcode` instead of a fuzzy name search. Returns the single matching item or an empty array.

```
GET /api/inventory/search?barcode=054900002313
```

### Unchanged: `GET /api/stock-allocations?itemId=`

Already returns all allocations for an item. After migration, `parLevel` and `reorderQty` are included automatically in the Prisma response — no code change needed.

---

## UI Changes

### 1. `RcAllocationPanel` (`src/components/inventory/RcAllocationPanel.tsx`)

**View mode — each RC row gains:**
- Current stock vs par: `3.0 kg / par 10 kg`
- Status badge: **Below Par** (amber) or **At Par** (green) — only shown when `parLevel` is set
- "Edit Par" button that expands inline fields

**Edit par inline form (per RC row):**
- `Par Level` input (in countUOM)
- `Order Qty` input (in purchaseUnit, placeholder "auto")
- Save / Cancel buttons
- On save: calls `PATCH /api/stock-allocations` with converted values

**Below-par highlight:**
- RC row gets amber left border + amber background tint when `current < parLevel`
- Suggested order line: `📦 Suggested: X [purchaseUnit] (par − current)` — only shown when below par

### 2. Inventory List — `src/app/inventory/page.tsx`

**`InventoryItem` interface additions:**
```typescript
parLevel?: number | null    // in countUOM, from StockAllocation join
reorderQty?: number | null  // in purchaseUnit
```

**StockStatus component — new `belowPar` state:**
- Condition: `parLevel != null && currentStock < parLevel && currentStock > 0`
- Badge: amber/yellow pill "Low Stock" (distinct from "Out of Stock" red and "In Stock" green)

**Filter pills — new "Low Stock" pill:**
- Condition: `parLevel != null && effStock(i) < parLevel && effStock(i) > 0`
- Sits between existing "Out of Stock" and "Counted This Week" pills

**Order List modal — expanded logic and UI:**

*Item inclusion (was: out of stock only):*
```typescript
// Before
const orderItems = activeItems.filter(i => effStock(i) <= 0)

// After
const orderItems = activeItems.filter(i =>
  effStock(i) <= 0 || (i.parLevel != null && effStock(i) < i.parLevel)
)
```

*Pre-filled quantity:*
```typescript
function suggestedQty(item: InventoryItem): string {
  if (item.reorderQty != null) return String(item.reorderQty)
  if (item.parLevel != null && item.parLevel > effStock(i)) {
    // Convert (parLevel - current) from countUOM to purchaseUnit
    const needed = item.parLevel - effStock(item)
    return String(Math.ceil(needed / item.qtyPerPurchaseUnit))
  }
  return ''
}
```

*Pre-fill `orderQtys` state on modal open* (instead of blank inputs):
```typescript
const initialQtys: Record<string, string> = {}
for (const item of orderItems) {
  initialQtys[item.id] = suggestedQty(item)
}
setOrderQtys(initialQtys)
```

*Filter tabs in modal header:*
- **All (N)** — all items needing reorder
- **⚠ Below Par (N)** — `parLevel != null && effStock > 0 && effStock < parLevel`
- **Out of Stock (N)** — `effStock <= 0`

*Per-item row additions:*
- Status pill: "Below Par" (amber) or "Out of Stock" (red)
- Meta line: `Par X [unit] · Have Y · Need Z` when parLevel is set

### 3. Barcode Field in Item Drawers

Both `src/app/inventory/page.tsx` (inline drawer) and `src/components/inventory/InventoryItemDrawer.tsx` (count-page drawer) get the same changes:

**Edit mode — new field below Count UOM:**
```
Barcode
[input: scan or type barcode]
```

**View mode — new row in info grid:**
```
Barcode    054900002313
```
Hidden (no row rendered) when `barcode` is null.

**Save:** `barcode` field included in the `PUT /api/inventory/[id]` request body. The PUT handler already passes through unknown fields via the existing spread — just needs `barcode` added to the explicit field list.

### 4. Count Scanner — Barcode Match

The camera scanner in `src/app/count/page.tsx` currently sends scanned text to a fuzzy name search. Extend the scan handler:

```typescript
async function handleScan(scannedText: string) {
  // 1. Try barcode exact match first
  const barcodeRes = await fetch(`/api/inventory/search?barcode=${encodeURIComponent(scannedText)}`)
  const barcodeResults = await barcodeRes.json()
  if (barcodeResults.length === 1) {
    jumpToItem(barcodeResults[0].id)  // existing scroll-to-item logic
    return
  }
  // 2. Fall back to existing fuzzy name search
  handleTextSearch(scannedText)
}
```

No UI change needed — the scanner UI stays the same; barcode match just makes it more accurate.

---

## Data Flow Summary

```
User opens item drawer
  → GET /api/stock-allocations?itemId=X
  → Panel renders per-RC rows with parLevel, reorderQty, below-par indicator

User edits par level for Cafe
  → PATCH /api/stock-allocations { itemId, rcId, parLevel, reorderQty }
  → Panel re-renders with new values

User opens Order List
  → Uses items already loaded in page state (includes parLevel from GET /api/inventory?rcId=)
  → Filters: effStock <= 0 OR effStock < parLevel
  → Pre-fills orderQtys from suggestedQty()

User scans barcode during count
  → GET /api/inventory/search?barcode=X
  → Exact match → jump to item
  → No match → fall back to name search
```

---

## Error Handling

- `PATCH /api/stock-allocations`: validates `parLevel >= 0`, `reorderQty > 0` if provided. Returns 400 with message on invalid input.
- Barcode search with no match returns `[]` — scanner falls back to name search silently.
- Par level conversion: if `countUOM` is not convertible to `baseUnit` (unit mismatch), clamp the stored value and log a warning — don't fail the save.

---

## Out of Scope

- Automatic reorder triggering / PO generation
- Barcode scanning during invoice receiving
- Per-storage-area par levels
- Par level history / audit log
