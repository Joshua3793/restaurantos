# UOM Overhaul — Purchase Structure & Conversion System

## Goal

Fix the broken unit-of-measure system: decouple product structure (fixed physics of the item) from count unit (flexible per-session preference), add a `qtyUOM` field so the number in "qty per case" is unambiguous, support 3-level purchase hierarchies (case → pack → item → weight), and repair 300+ items whose purchase data was malformed during the original Excel import.

## Architecture

Product structure (purchaseUnit + qtyPerPurchaseUnit + qtyUOM + optional innerQty + optional packSize/packUOM) defines the fixed physical facts of an item and determines base cost. Count unit is a separate concern — a per-session preference that is always convertible from the structure. Recipes always cost in base units (g / ml / each), which are derived from structure alone and never change when count unit changes.

Three structural paths based on `qtyUOM`:
- **Weight-based** (`qtyUOM` = kg/g/ml/l): `1 purchaseUnit = qty × conv(qtyUOM)` base units
- **Count → weight** (`qtyUOM` = each): `1 purchaseUnit = qty × packSize × conv(packUOM)` base units
- **Count → pack → weight** (`qtyUOM` = pack): `1 purchaseUnit = qty × innerQty × packSize × conv(packUOM)` base units

## Tech Stack

Next.js 14 App Router · TypeScript · Prisma + PostgreSQL · Tailwind CSS

---

## Schema Changes

### `InventoryItem` — add `qtyUOM`, `innerQty`, `needsReview`

```prisma
model InventoryItem {
  // ... existing fields ...
  qtyUOM      String   @default("each") // unit of qtyPerPurchaseUnit: kg/g/ml/l/each/pack
  innerQty    Decimal?                  // items per pack — only set when qtyUOM = "pack"
  needsReview Boolean  @default(false)  // flagged by migration script for manual review
}
```

### Existing field semantics (no rename, new meaning)

| Field | New semantics |
|---|---|
| `purchaseUnit` | Container type only — case, bag, box, bottle, tray, sleeve, dozen, pallet, each. No numbers, no weight units. |
| `qtyPerPurchaseUnit` | How many `qtyUOM` units are in one `purchaseUnit` |
| `packSize` | Weight or volume of one individual item (null or 1 when weight doesn't apply) |
| `packUOM` | Unit of `packSize` — weight/volume unit (g, kg, ml, l) or "each" when no weight defined |
| `countUOM` | Default count unit for count sheets — a preference only, not a structural constraint |
| `baseUnit` | Derived: "g" if qtyUOM or packUOM is weight; "ml" if volume; "each" otherwise |
| `conversionFactor` | Stored derived value: base units per 1 `countUOM`. Recalculated on save. |

---

## Logic Changes

### `src/lib/utils.ts`

#### `PURCHASE_UNITS` — lock to container types only

```typescript
export const PURCHASE_UNITS = [
  'case', 'bag', 'box', 'bottle', 'pack', 'tray',
  'sleeve', 'dozen', 'pallet', 'jug', 'each',
]
```

Remove: `'kg'`, `'g'`, `'lb'`, `'oz'`, `'l'`, `'ml'` — these are never valid container types.

#### `QTY_UOMS` — new export (unit options for the qty field)

```typescript
export const QTY_UOMS = ['each', 'pack', 'kg', 'g', 'lb', 'oz', 'l', 'ml']
```

#### `deriveBaseUnit(qtyUOM: string, packUOM: string): string`

```typescript
export function deriveBaseUnit(qtyUOM: string, packUOM: string): string {
  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  if (weightUnits.includes(qtyUOM)) return 'g'
  if (volumeUnits.includes(qtyUOM)) return 'ml'
  if (weightUnits.includes(packUOM)) return 'g'
  if (volumeUnits.includes(packUOM)) return 'ml'
  return 'each'
}
```

Signature change: now takes `qtyUOM` as first arg in addition to `packUOM`. All callers updated.

#### `calcPricePerBaseUnit(price, qty, qtyUOM, innerQty, packSize, packUOM): number`

```typescript
export function calcPricePerBaseUnit(
  purchasePrice: number,
  qtyPerPurchaseUnit: number,
  qtyUOM: string,
  innerQty: number | null,
  packSize: number,
  packUOM: string,
): number {
  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)

  let divisor: number
  if (isWeightQty) {
    divisor = qtyPerPurchaseUnit * getUnitConv(qtyUOM)
  } else if (qtyUOM === 'pack' && innerQty != null) {
    divisor = qtyPerPurchaseUnit * innerQty * packSize * getUnitConv(packUOM)
  } else {
    // each — with or without weight
    divisor = qtyPerPurchaseUnit * packSize * getUnitConv(packUOM)
  }
  return divisor > 0 ? purchasePrice / divisor : 0
}
```

#### `calcConversionFactor(countUOM, qty, qtyUOM, innerQty, packSize, packUOM): number`

```typescript
export function calcConversionFactor(
  countUOM: string,
  qtyPerPurchaseUnit: number,
  qtyUOM: string,
  innerQty: number | null,
  packSize: number,
  packUOM: string,
): number {
  // Standard weight/volume units — direct conversion to base
  if (countUOM in UNIT_CONV) return UNIT_CONV[countUOM]

  const itemBaseUnits = packSize * getUnitConv(packUOM) // base units per 1 item
  const packBaseUnits = (innerQty ?? 1) * itemBaseUnits  // base units per 1 pack

  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)

  if (countUOM === 'case' || countUOM === qtyUOM) {
    if (isWeightQty) return qtyPerPurchaseUnit * getUnitConv(qtyUOM)
    return qtyPerPurchaseUnit * packBaseUnits
  }
  if (countUOM === 'pack') return packBaseUnits
  if (countUOM === 'each') return itemBaseUnits > 0 ? itemBaseUnits : 1
  return 1
}
```

### `src/lib/count-uom.ts`

#### `getCountableUoms(item)` — derive from structure, not hardcoded lists

The function currently returns a fixed set. Replace with structure-derived logic:

```typescript
export function getCountableUoms(item: ItemDims): CountableUom[] {
  const uoms: CountableUom[] = []
  const base = deriveBaseUnit(item.qtyUOM ?? 'each', item.packUOM ?? 'each')
  const hasWeight = base === 'g' || base === 'ml'
  const hasInnerQty = item.innerQty != null && Number(item.innerQty) > 0
  const hasItemWeight = hasWeight && Number(item.packSize ?? 0) > 0

  // Purchase unit (case / bag / etc.)
  uoms.push({
    label: item.purchaseUnit,
    hint: buildCaseHint(item), // e.g. "10 packs × 6 × 100g"
  })

  // Pack level (only when qtyUOM = "pack")
  if (item.qtyUOM === 'pack' && hasInnerQty) {
    const packG = Number(item.innerQty) * Number(item.packSize ?? 1) * getUnitConv(item.packUOM ?? 'each')
    uoms.push({ label: 'pack', hint: packG > 0 ? `${packG.toFixed(0)} ${base}` : `${item.innerQty} each` })
  }

  // Each (individual item)
  if (hasItemWeight) {
    uoms.push({ label: 'each', hint: `${item.packSize} ${item.packUOM}` })
  } else if (item.qtyUOM === 'each' || item.qtyUOM === 'pack') {
    uoms.push({ label: 'each' })
  }

  // Weight/volume options when base unit is g or ml
  if (base === 'g') uoms.push(...[
    { label: 'kg', hint: '1,000 g' },
    { label: 'g' },
    { label: 'lb', hint: '454 g' },
  ])
  if (base === 'ml') uoms.push(...[
    { label: 'l', hint: '1,000 ml' },
    { label: 'ml' },
  ])

  return uoms
}
```

`convertCountQtyToBase` and `convertBaseToCountUom` updated to handle `pack` level using `innerQty`.

---

## UI Changes

### `src/lib/utils.ts`

- Export `QTY_UOMS` constant (see above)

### `src/app/inventory/page.tsx` and `src/components/inventory/InventoryItemDrawer.tsx`

Both forms get the same purchase structure redesign. The "Purchase Structure" section replaces the current `purchaseUnit / qtyPerPurchaseUnit / packSize / packUOM` grid.

#### New field layout (purchase structure section)

```
Row 1 (2 cols):
  [Purchase Unit ▾]    [Qty per Unit:  N  | qtyUOM ▾]

Conditional indented block (shown when qtyUOM = "each" or "pack"):
  When qtyUOM = "pack":
    [Items per Pack:  N  | each]    [Weight per Item (optional):  N  | g ▾]
  When qtyUOM = "each":
    [Weight per Each (optional):  N  | g ▾]

Row 2 (full width):
  [Purchase Price ($)]
```

**"Weight per Item" / "Weight per Each" behaviour:**
- Labelled with `(optional)` tag
- Hint: "Leave blank → price per each. Fill in → price per g, usable in recipes by weight."
- If left blank: `packSize` stored as null, `packUOM` stored as "each", `baseUnit` = "each"
- The weight unit selector shows: g, kg, ml, l, lb, oz

**Auto-calculated preview** (below purchase price, same gold box as today):
- Shows full chain: `1 case = N packs × M each × Wg = X g`
- Shows per-level: `1 pack = Yg · 1 each = Zg`
- Shows: `Price per g: $X.XXXX / g` (or `Price per each: $X.XX / each` when no weight)

#### Updated `EditForm` interface additions

```typescript
qtyUOM: string           // new
innerQty: string         // new (stored as string in form, parsed on save)
```

#### `openEdit` / initial state

```typescript
qtyUOM: item.qtyUOM ?? 'each',
innerQty: item.innerQty != null ? String(item.innerQty) : '',
```

#### `handleSave` PUT body additions

```typescript
qtyUOM: editForm.qtyUOM,
innerQty: editForm.innerQty ? parseFloat(editForm.innerQty) : null,
```

### `src/app/api/inventory/[id]/route.ts` — PUT handler

Add `qtyUOM`, `innerQty`, `needsReview` to the explicit field list passed to `prisma.inventoryItem.update()`.

### Inventory list page — `needsReview` banner

When any item has `needsReview = true`, show a dismissible amber banner at the top of the inventory page:

```
⚠  X items need purchase structure review — their data couldn't be auto-repaired 
   during migration. [Show items ▾]
```

"Show items" filters the list to `needsReview = true` items only. Saving an item in the drawer clears `needsReview` automatically (set to false on any PUT).

---

## Data Migration

### `prisma/migrate-uom.ts` — one-time script

Run with: `npx ts-node prisma/migrate-uom.ts`

Processes every `InventoryItem` and applies rules in order:

**Rule 1 — Parse embedded quantity in purchaseUnit**
If `purchaseUnit` matches pattern `"N unit"` (e.g. `"20 each"`, `"2 kg"`, `"1 case"`):
- Extract N → `qtyPerPurchaseUnit`
- Extract unit → `qtyUOM` (mapped to canonical: "each"/"pack"/"kg"/"g" etc.)
- Set `purchaseUnit` to the remaining container word, or `"case"` if only a unit remains

**Rule 2 — purchaseUnit is a weight/volume unit**
If `purchaseUnit` ∈ `['kg', 'g', 'lb', 'oz', 'l', 'ml']`:
- Set `qtyUOM = purchaseUnit`
- Set `purchaseUnit = 'bag'` (best-guess container)

**Rule 3 — purchaseUnit is valid, qtyUOM missing**
If `purchaseUnit` is already in `PURCHASE_UNITS`:
- If `packUOM` is a weight/volume unit → `qtyUOM = 'each'`
- Else → `qtyUOM = 'each'`

**Rule 4 — Flag unresolved items**
If after rules 1–3 `purchaseUnit` is still not in `PURCHASE_UNITS`, or `qtyUOM` couldn't be determined: set `needsReview = true`. Do not modify other fields.

Script logs a summary: `"Fixed: 287 · Flagged for review: 14"`.

Script file is deleted after running (it's a one-time tool).

---

## Error Handling

- `PUT /api/inventory/[id]`: validate `qtyUOM` is in `QTY_UOMS`; validate `innerQty > 0` if provided; validate `packSize >= 0`. Return 400 with message on invalid input.
- `calcPricePerBaseUnit` with zero divisor: return 0 (existing behaviour).
- `getCountableUoms` with missing/null fields: always returns at least `[purchaseUnit, 'each']`.

---

## Out of Scope

- Bulk edit UI for `needsReview` items (fixed via existing item drawer one by one)
- Re-importing from the original Excel file
- Volume-to-weight conversions (e.g. 1 ml water = 1 g) — not supported; different dimensions stay separate
- Per-storage-location UOM overrides
- Multi-unit purchasing (e.g. buying same item in both cases and individual bottles)
