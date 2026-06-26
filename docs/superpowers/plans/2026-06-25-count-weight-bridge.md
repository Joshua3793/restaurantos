# Count↔Weight Unit Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one COUNT inventory item carry a canonical "1 each = N g/ml" measure so weight-format invoices normalize to count (no recurring dimension conflict) and weight-based recipes still cost correctly.

**Architecture:** Add two nullable columns (`eachMeasureQty`, `eachMeasureUnit`) to `InventoryItem`. Surface them as an `EachMeasure` bridge read off each item row. A single `convertQtyBridged` helper handles count↔(mass|volume). Four sites become bridge-aware: recipe costing, the invoice dimension-conflict check, invoice offer normalization, and the approve-route cost guard. UI to set the bridge, plus a non-destructive conflict resolver.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase pooler) · Tailwind. No test suite — verification is `npm run build` (type-check) + a standalone node assertion script for the pure helper + manual preview checks.

**Spec:** [docs/superpowers/specs/2026-06-25-count-weight-bridge-design.md](../specs/2026-06-25-count-weight-bridge-design.md)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `prisma/schema.prisma` | `InventoryItem.eachMeasureQty/Unit` | Modify |
| `scripts/add-each-measure-columns.ts` | Raw DDL over pooler (migration) | Create |
| `src/lib/item-model.ts` | `EachMeasure` type, `eachMeasureOf`, `ChainItem.eachMeasure`, `PRICING_SELECT`, `asChainItem` | Modify |
| `src/lib/uom.ts` | `convertQtyBridged`, bridge-aware `dimensionallyCostable` | Modify |
| `scripts/check-bridge-conversions.ts` | Standalone assertions for the pure helpers | Create |
| `src/lib/recipeCosts.ts` | Bridged line cost + select | Modify |
| `src/lib/invoice/offer.ts` | `buildOffer` forced-count branch when item bridges | Modify |
| `src/lib/invoice/predicates.ts` | Bridge-aware `hasDimensionConflict` | Modify |
| `src/app/api/invoices/sessions/[id]/approve/route.ts` | Bridge-aware guard + $/each write | Modify |
| `src/app/api/inventory/[id]/route.ts` | Accept + persist `eachMeasureQty/Unit` | Modify |
| `src/app/api/inventory/route.ts` | Accept `eachMeasureQty/Unit` on create | Modify |
| Inventory item form/drawer (`ItemChainEditor` + drawer) | Bridge input field | Modify |
| `src/components/invoices/v2/issues.tsx` | Non-destructive "set bridge" resolver | Modify |
| `scripts/assign-each-measure.ts` | Candidate listing + backfill | Create |

---

## Task 1: Schema columns + migration

**Files:**
- Modify: `prisma/schema.prisma` (InventoryItem, after line 102 `barcode`)
- Create: `scripts/add-each-measure-columns.ts`

- [ ] **Step 1: Add the columns to the Prisma model**

In `prisma/schema.prisma`, inside `model InventoryItem`, add after the `barcode String?` line (currently line 102):

```prisma
  // ── Count↔weight bridge (COUNT items only) ──────────────────────────────────
  // Canonical measure of ONE base count unit, e.g. 1 each (loaf) = 1100 g.
  // Lets weight-format invoices normalize to count and weight-based recipes cost.
  eachMeasureQty     Decimal?                 // measure of 1 base unit (e.g. 1100)
  eachMeasureUnit    String?                  // its unit, base-canonical (g | ml)
```

- [ ] **Step 2: Apply DDL over the pooler (direct host is unreachable)**

Create `scripts/add-each-measure-columns.ts`:

```ts
// One-off DDL: add the count↔weight bridge columns. Run with: npx tsx scripts/add-each-measure-columns.ts
// Uses $executeRawUnsafe over the pooler — never `prisma migrate diff` (direct DB host unreachable).
import { prisma } from '../src/lib/prisma'

async function main() {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "eachMeasureQty" DECIMAL`
  )
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "eachMeasureUnit" TEXT`
  )
  console.log('✓ eachMeasureQty / eachMeasureUnit columns ensured')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 3: Run the DDL script**

Run: `npx tsx scripts/add-each-measure-columns.ts`
Expected: `✓ eachMeasureQty / eachMeasureUnit columns ensured`

- [ ] **Step 4: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `Generated Prisma Client` with no errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma scripts/add-each-measure-columns.ts
git commit -m "feat(item): add count↔weight bridge columns (eachMeasureQty/Unit)"
```

---

## Task 2: Bridge type + `eachMeasureOf` + `ChainItem.eachMeasure`

**Files:**
- Modify: `src/lib/item-model.ts`

- [ ] **Step 1: Add the `EachMeasure` type and extend `ChainItem`**

In `src/lib/item-model.ts`, after `export type PackLink = ...` (line 4) add:

```ts
/** Canonical measure of ONE base count unit, e.g. { qty: 1100, unit: 'g' } = 1 each. */
export type EachMeasure = { qty: number; unit: string }
```

In the `ChainItem` interface (currently ends with `stockOnHand?: number`), add a field:

```ts
  /** Present only on COUNT items with a count↔weight bridge configured. */
  eachMeasure?: EachMeasure | null
```

- [ ] **Step 2: Add `eachMeasureOf` helper**

Add below `dimensionOf` (after line 26):

```ts
/** Read the count↔weight bridge off an item row. Null unless the item is COUNT
 *  and BOTH columns are populated. Decimal arrives as string from Prisma JSON. */
export function eachMeasureOf(row: {
  dimension?: string | null
  eachMeasureQty?: unknown
  eachMeasureUnit?: string | null
}): EachMeasure | null {
  if ((row.dimension ?? 'COUNT') !== 'COUNT') return null
  const qty = row.eachMeasureQty != null ? Number(row.eachMeasureQty) : NaN
  const unit = (row.eachMeasureUnit ?? '').trim()
  if (!Number.isFinite(qty) || qty <= 0 || !unit) return null
  return { qty, unit }
}
```

- [ ] **Step 3: Select the columns and populate `asChainItem`**

Update `PRICING_SELECT` (line 94) to:

```ts
export const PRICING_SELECT = {
  dimension: true, baseUnit: true, packChain: true, pricing: true, countUnit: true,
  eachMeasureQty: true, eachMeasureUnit: true,
} as const
```

Update `asChainItem`'s parameter type and body to carry the bridge:

```ts
export function asChainItem(row: {
  dimension: string; baseUnit: string; packChain: unknown; pricing: unknown
  countUnit?: string; stockOnHand?: unknown
  eachMeasureQty?: unknown; eachMeasureUnit?: string | null
}): ChainItem {
  return {
    dimension: row.dimension as Dimension,
    baseUnit: row.baseUnit,
    packChain: (row.packChain as PackLink[]) ?? [],
    pricing: (row.pricing as Pricing) ?? { mode: 'PACK', purchasePrice: 0 },
    countUnit: row.countUnit,
    stockOnHand: row.stockOnHand != null ? Number(row.stockOnHand) : 0,
    eachMeasure: eachMeasureOf(row),
  }
}
```

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: build succeeds (no type errors). If `eachMeasureOf` is reported unused, that's fine — Task 3 consumes it.

- [ ] **Step 5: Commit**

```bash
git add src/lib/item-model.ts
git commit -m "feat(item): EachMeasure bridge type, eachMeasureOf, ChainItem.eachMeasure"
```

---

## Task 3: `convertQtyBridged` + bridge-aware `dimensionallyCostable`

**Files:**
- Modify: `src/lib/uom.ts`
- Create: `scripts/check-bridge-conversions.ts`

- [ ] **Step 1: Write the standalone assertion script (the "failing test")**

Create `scripts/check-bridge-conversions.ts`:

```ts
// Pure-logic assertions for the count↔weight bridge. Run: npx tsx scripts/check-bridge-conversions.ts
import { convertQtyBridged, dimensionallyCostable } from '../src/lib/uom'

const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
let failures = 0
function check(label: string, got: number | boolean, want: number | boolean) {
  const ok = typeof want === 'number' && typeof got === 'number' ? approx(got, want) : got === want
  if (!ok) { failures++; console.error(`✗ ${label}: got ${got}, want ${want}`) }
  else console.log(`✓ ${label}`)
}

const bridge = { qty: 1100, unit: 'g' }   // 1 each = 1100 g

// measured → count
check('200g → each',  convertQtyBridged(200, 'g', 'each', bridge), 200 / 1100)
check('8.8kg → each', convertQtyBridged(8.8, 'kg', 'each', bridge), 8)
// count → measured
check('2 each → g',   convertQtyBridged(2, 'each', 'g', bridge), 2200)
check('2 each → kg',  convertQtyBridged(2, 'each', 'kg', bridge), 2.2)
// same dimension delegates to convertQty (bridge ignored)
check('1kg → g',      convertQtyBridged(1, 'kg', 'g', bridge), 1000)
check('3 each → each',convertQtyBridged(3, 'each', 'each', bridge), 3)
// no bridge: cross-dimension passes through unchanged (today's behavior)
check('200g → each (no bridge)', convertQtyBridged(200, 'g', 'each', null), 200)
// dimensionallyCostable with bridge
check('costable g↔each +bridge', dimensionallyCostable('g', 'each', bridge), true)
check('costable g↔each no bridge', dimensionallyCostable('g', 'each', null), false)
check('costable g↔ml (unchanged)', dimensionallyCostable('g', 'ml'), true)

if (failures) { console.error(`\n${failures} fail:`); process.exit(1) }
console.log('\nall bridge assertions passed')
```

- [ ] **Step 2: Run it to confirm it fails (functions not defined yet)**

Run: `npx tsx scripts/check-bridge-conversions.ts`
Expected: FAIL — `convertQtyBridged is not a function` / TS export error.

- [ ] **Step 3: Implement `convertQtyBridged` and extend `dimensionallyCostable`**

In `src/lib/uom.ts`, add the `EachMeasure` import-free bridge converter after `convertQty` (line 253). Note `dimensionForUnit` already exists at line 269.

```ts
/**
 * Like convertQty, but bridges count↔(weight|volume) using a per-each measure.
 *  - same dimension → delegates to convertQty (bridge ignored)
 *  - measured → count: convert qty into the bridge unit, then divide by bridge.qty
 *  - count → measured: multiply by bridge.qty (in the bridge unit), then convert
 *  - cross-dimension with NO bridge → identical to convertQty (passthrough)
 */
export function convertQtyBridged(
  qty: number, fromUnit: string, toUnit: string,
  bridge?: { qty: number; unit: string } | null,
): number {
  const fromDim = dimensionForUnit(fromUnit)
  const toDim = dimensionForUnit(toUnit)
  if (fromDim === toDim) return convertQty(qty, fromUnit, toUnit)
  if (!bridge || !(bridge.qty > 0)) return convertQty(qty, fromUnit, toUnit)
  const bridgeDim = dimensionForUnit(bridge.unit)
  // measured → count
  if (fromDim === bridgeDim && toDim === 'count') {
    return convertQty(qty, fromUnit, bridge.unit) / bridge.qty
  }
  // count → measured
  if (fromDim === 'count' && toDim === bridgeDim) {
    return convertQty(qty * bridge.qty, bridge.unit, toUnit)
  }
  // bridge doesn't span these two dimensions → unchanged
  return convertQty(qty, fromUnit, toUnit)
}
```

Replace `dimensionallyCostable` (line 283) with a bridge-aware version (keep the existing doc comment above it):

```ts
export function dimensionallyCostable(
  unitA: string, unitB: string,
  bridge?: { qty: number; unit: string } | null,
): boolean {
  const a = dimensionForUnit(unitA)
  const b = dimensionForUnit(unitB)
  if (a === b) return true
  const measured = (d: UnitDimension) => d === 'weight' || d === 'volume'
  if (measured(a) && measured(b)) return true
  // count ↔ measured is costable ONLY when a bridge spans them
  if (bridge && bridge.qty > 0) {
    const bd = dimensionForUnit(bridge.unit)
    const pair = new Set([a, b])
    if (pair.has('count') && pair.has(bd) && measured(bd)) return true
  }
  return false
}
```

- [ ] **Step 4: Run the assertions to confirm they pass**

Run: `npx tsx scripts/check-bridge-conversions.ts`
Expected: all lines `✓`, final `all bridge assertions passed`.

- [ ] **Step 5: Type-check the whole app**

Run: `npm run build`
Expected: build succeeds. Existing 2-arg `dimensionallyCostable` callers still compile (third arg optional).

- [ ] **Step 6: Commit**

```bash
git add src/lib/uom.ts scripts/check-bridge-conversions.ts
git commit -m "feat(uom): convertQtyBridged + bridge-aware dimensionallyCostable"
```

---

## Task 4: Recipe costing uses the bridge

**Files:**
- Modify: `src/lib/recipeCosts.ts` (imports line 7-8; costing block lines 103-118)

- [ ] **Step 1: Import the bridged converter**

Change line 7 from:

```ts
import { convertQty, dimensionallyCostable } from './uom'
```

to:

```ts
import { convertQty, convertQtyBridged, dimensionallyCostable } from './uom'
```

- [ ] **Step 2: Use the bridge for the direct-ingredient cost path**

In `computeRecipeCost`, the direct inventory-item branch currently reads (lines ~106-109):

```ts
      ingredientBaseUnit = ing.inventoryItem.baseUnit
      dimensionConflict  = !dimensionallyCostable(ing.unit, ingredientBaseUnit)
      // ...
      lineCostQty = convertQty(qty, ing.unit, ing.inventoryItem.baseUnit)
```

Replace those three statements with bridge-aware versions. `ing.inventoryItem` is an `asChainItem` input, so read its bridge via `eachMeasureOf`:

```ts
      ingredientBaseUnit = ing.inventoryItem.baseUnit
      const ingBridge = eachMeasureOf(ing.inventoryItem)
      dimensionConflict  = !dimensionallyCostable(ing.unit, ingredientBaseUnit, ingBridge)
      // ...
      lineCostQty = convertQtyBridged(qty, ing.unit, ing.inventoryItem.baseUnit, ingBridge)
```

Add `eachMeasureOf` to the item-model import on line 8:

```ts
import { dimensionOf, eachMeasureOf, PRICING_SELECT, asChainItem, pricePerBaseUnit as chainPricePerBaseUnit } from './item-model'
```

> Note: `PRICING_SELECT` (updated in Task 2) already pulls `eachMeasureQty/Unit`, so every `inventoryItem: { select: { ...PRICING_SELECT } }` in this file (lines 195, 200) provides the fields with no further change. The linked-recipe branch (yield-based, lines 111-118) is intentionally left on `convertQty` — a PREP output's yield unit is its own base, never a bridged count item.

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/lib/recipeCosts.ts
git commit -m "feat(recipes): cost weight-based lines on COUNT items via the bridge"
```

---

## Task 5: Bridge-aware invoice dimension-conflict check

**Files:**
- Modify: `src/lib/invoice/predicates.ts` (`hasDimensionConflict`, lines 55-61)

- [ ] **Step 1: Make `hasDimensionConflict` consult the item's bridge**

Replace the body of `hasDimensionConflict` with:

```ts
export function hasDimensionConflict(item: ScanItem): boolean {
  if (!item.matchedItem) return false
  const offer = buildOffer(scanItemToOfferInput(item))
  const md = item.matchedItem as {
    dimension?: string; baseUnit?: string
    eachMeasureQty?: unknown; eachMeasureUnit?: string | null
  }
  const itemDim = (md.dimension as 'MASS' | 'VOLUME' | 'COUNT' | undefined) ?? dimensionOf(md.baseUnit ?? 'each')
  if (offer.dimension === itemDim) return false
  // A measured offer (MASS/VOLUME) on a COUNT item is BRIDGEABLE, not a conflict,
  // when the item carries an each-measure spanning that dimension.
  const bridge = eachMeasureOf(md)
  if (itemDim === 'COUNT' && bridge && dimensionOf(bridge.unit) === offer.dimension) return false
  return true
}
```

- [ ] **Step 2: Import `eachMeasureOf`**

Change the item-model import (line ~8) to:

```ts
import { dimensionOf, eachMeasureOf } from '@/lib/item-model'
```

- [ ] **Step 3: Ensure `matchedItem` carries the bridge columns**

The `ScanItem.matchedItem` is hydrated where scan items are fetched for the review UI. Confirm the select that builds `matchedItem` includes the bridge columns. Run:

```bash
grep -rn "matchedItem" src/app/api/invoices/sessions --include=*.ts | grep -i "select\|include" 
```

If `matchedItem` is selected via `...PRICING_SELECT`, no change is needed (Task 2 added the fields). If it uses an explicit field list, add `eachMeasureQty: true, eachMeasureUnit: true` to that select.

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoice/predicates.ts src/app/api/invoices/sessions
git commit -m "feat(invoice): treat measured line on bridged COUNT item as no-conflict"
```

---

## Task 6: Offer normalization — "prefer the explicit count"

**Files:**
- Modify: `src/lib/invoice/offer.ts` (`buildOffer`, `chainFromOcr`)

Goal: when the matched item is a bridged COUNT item, build the offer as COUNT (use `packQty` as the count; treat the weight `packSize/packUOM` as the per-each size), so pricing resolves to $/each. Bare total-weight lines (no `packQty`) divide by the bridge.

- [ ] **Step 1: Add an options arg to `buildOffer`**

Change the signature and the dimension decision. Replace the top of `buildOffer` (lines 70-77) with:

```ts
export function buildOffer(
  o: OfferInput,
  opts?: { bridge?: { qty: number; unit: string } | null },
): OfferDraft {
  const sigUnit = o.pricingMode === 'per_weight'
    ? (o.rateUOM || o.totalQtyUOM || 'kg')
    : (o.packUOM || o.qtyShippedUOM || 'each')
  const rawDimension = dimensionOf(sigUnit)
  // When the matched item is a bridged COUNT item and the line is measured,
  // normalize the offer to COUNT (the weight is per-each size, not the dimension).
  const bridge = opts?.bridge ?? null
  const dimension: Dimension =
    bridge && bridge.qty > 0 && rawDimension !== 'COUNT' ? 'COUNT' : rawDimension
  const baseUnit = DIMENSION_BASE[dimension]
  const packChain = chainFromOcr(o, dimension, bridge)
```

(The rest of `buildOffer` is unchanged: the `per_weight` and CASE branches below still read `dimension`/`baseUnit`/`packChain`.)

- [ ] **Step 2: Teach `chainFromOcr` the bridged bare-weight case**

Replace `chainFromOcr` (lines 57-68) with:

```ts
export function chainFromOcr(
  o: OfferInput, dimension: Dimension,
  bridge?: { qty: number; unit: string } | null,
): PackLink[] {
  const topUnit = norm(o.qtyShippedUOM) || 'case'
  const packQty = Number(o.packQty || 1)
  const packSize = Number(o.packSize || 1)
  const packUOM = norm(o.packUOM) || 'each'

  if (dimension === 'COUNT') {
    // Bridged normalization of a measured line with NO explicit count:
    // derive the count from the received total weight ÷ bridge, rounded to whole.
    if (bridge && bridge.qty > 0 && packQty <= 1 && norm(packUOM) !== 'each') {
      const totalInBridge = toBase(o.totalQty ?? o.qtyShipped, o.totalQtyUOM || packUOM)
      const count = Math.max(1, Math.round(totalInBridge / bridge.qty))
      return [{ unit: topUnit, per: count }]
    }
    // Explicit count present (e.g. 8 × 1100 g) → use packQty directly; never divide.
    const leafPer = 1
    const leafUnit = 'each'
    if (packQty > 1) return [{ unit: topUnit, per: packQty }, { unit: leafUnit, per: leafPer }]
    return [{ unit: topUnit, per: leafPer }]
  }

  const leafPer = packSize * getUnitConv(packUOM)
  const leafUnit = packUOM === 'each' ? 'each' : packUOM
  if (packQty > 1) return [{ unit: topUnit, per: packQty }, { unit: leafUnit, per: leafPer }]
  return [{ unit: topUnit, per: leafPer }]
}
```

> Behavior preserved for non-bridged calls: when `dimension === 'COUNT'` and no bridge, the explicit-count branch is identical to the old COUNT path (`leafPer = 1`). The MASS/VOLUME path is unchanged.

- [ ] **Step 3: Pass the bridge from callers that know the matched item**

`buildOffer` is also called with no matched context (e.g. `hasDimensionConflict` Task 5 deliberately calls the raw `buildOffer()` to detect the *raw* dimension — leave it). For the approve route (Task 7) and any drawer/reconcile site that has the matched item, pass `{ bridge: eachMeasureOf(matchedItem) }`. Find call sites:

```bash
grep -rn "buildOffer(" src --include=*.ts --include=*.tsx
```

For each call site where a matched item is in scope and the intent is to produce the *final* costed offer, change `buildOffer(input)` → `buildOffer(input, { bridge: eachMeasureOf(matched) })`. Leave the predicate's raw call alone.

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoice/offer.ts
git commit -m "feat(invoice): normalize measured lines to count on bridged items"
```

---

## Task 7: Approve-route guard + $/each write

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts` (guard ~178; ensure item select carries bridge)

- [ ] **Step 1: Confirm the approved item row selects the bridge columns**

The approve route loads the matched `item` to compute the spine write. Find its select and ensure it includes the bridge:

```bash
grep -n "eachMeasure\|baseUnit\|dimension\|select:" src/app/api/invoices/sessions/[id]/approve/route.ts | head -30
```

If the item is loaded with an explicit select, add `eachMeasureQty: true, eachMeasureUnit: true`. If it spreads `...PRICING_SELECT`, it's already covered.

- [ ] **Step 2: Make the dimension-conflict guard bridge-aware**

At the guard (line ~178), build the bridge from the item and pass it through, AND convert the rate to $/each when bridged. Replace the guard condition:

```ts
        const itemBridge = eachMeasureOf(item)
        if (isUomMode && item.baseUnit &&
            !dimensionallyCostable(resolvedRateUnit, item.baseUnit, itemBridge)) {
          console.error(
            `[approve] Skipping price write for "${scanItem.rawDescription}" — ` +
            `rate unit '${resolvedRateUnit}' (${dimensionOf(resolvedRateUnit)}) ` +
            `can't be costed against item base '${item.baseUnit}' (${item.dimension}).`
          )
          skippedLines++
          continue
        }
```

- [ ] **Step 3: Convert a bridged rate to $/base-each before the spine write**

Where `newPricePerBase` is computed for the UOM/rate path, a bridged COUNT item needs $/each, not $/g. After `newPricePerBase` is set and before the `<= 0` guard, add:

```ts
        // Bridged COUNT item billed by weight: the rate's base is measured ($/g),
        // but the spine base is `each`. Convert: $/each = $/g × (g per each).
        if (isUomMode && item.dimension === 'COUNT' && itemBridge &&
            dimensionOf(resolvedRateUnit) === dimensionOf(itemBridge.unit)) {
          // newPricePerBase is in $/<bridge.unit base>; scale up to $/each.
          newPricePerBase = newPricePerBase * convertQty(itemBridge.qty, itemBridge.unit, DIMENSION_BASE['MASS'] === itemBridge.unit ? 'g' : 'ml')
        }
```

> Simpler equivalent if `newPricePerBase` is already per the canonical base unit (`g`/`ml`): `newPricePerBase = newPricePerBase * itemBridge.qty` (since `itemBridge.qty` is stored in the canonical base unit). Use the plain-multiply form and drop the convertQty wrapper:

```ts
        if (isUomMode && item.dimension === 'COUNT' && itemBridge &&
            dimensionOf(resolvedRateUnit) === dimensionOf(itemBridge.unit)) {
          newPricePerBase = newPricePerBase * itemBridge.qty   // $/g × g-per-each → $/each
        }
```

Use the plain-multiply form. Ensure `eachMeasureOf`, `convertQty`, `DIMENSION_BASE` are imported in this route (add to existing item-model / uom imports as needed).

> Note: most bridged Brioche lines are per_case (packQty present), not UOM/rate — those flow through the CASE branch, which after Task 6 builds a COUNT chain and yields $/each with no extra code. This step covers only the bare-weight/rate case.

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/invoices/sessions/[id]/approve/route.ts"
git commit -m "feat(invoice): approve writes \$/each for bridged COUNT items"
```

---

## Task 8: Inventory API accepts the bridge

**Files:**
- Modify: `src/app/api/inventory/[id]/route.ts` (PUT, lines ~33-67)
- Modify: `src/app/api/inventory/route.ts` (POST create)

- [ ] **Step 1: Accept + persist on update (PUT)**

In `src/app/api/inventory/[id]/route.ts`, destructure the new fields (line ~33) and include them in the `data`. Normalize: only persist when `dimension === 'COUNT'` and a positive qty + unit are given; otherwise write `null` to both (clearing a stale bridge if dimension changed).

```ts
  const { dimension, packChain, pricing, countUnit, supplierId, storageAreaId,
          eachMeasureQty, eachMeasureUnit, ...rest } = body
```

In the `data: { ... }` object (line ~62), add:

```ts
      eachMeasureQty: dimension === 'COUNT' && Number(eachMeasureQty) > 0 ? Number(eachMeasureQty) : null,
      eachMeasureUnit: dimension === 'COUNT' && Number(eachMeasureQty) > 0 && eachMeasureUnit ? String(eachMeasureUnit) : null,
```

- [ ] **Step 2: Accept on create (POST)**

In `src/app/api/inventory/route.ts`, apply the same destructure + `data` additions in the create handler, mirroring Step 1 exactly (same null-normalization rule).

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/inventory/[id]/route.ts src/app/api/inventory/route.ts
git commit -m "feat(inventory): persist eachMeasure bridge on create/update"
```

---

## Task 9: Inventory UI — set the bridge

**Files:**
- Modify: the shared chain editor `ItemChainEditor` (locate via grep) + the item drawer that submits PUT

- [ ] **Step 1: Locate the form component and its state**

```bash
grep -rln "ItemChainEditor\|packChain" src/components src/app/inventory --include=*.tsx
```

Identify the component holding `dimension`/`packChain`/`pricing` form state and the payload it POSTs/PUTs.

- [ ] **Step 2: Add the bridge input (COUNT only)**

Add two controlled fields, rendered only when `dimension === 'COUNT'`, beneath the pack-chain editor:

```tsx
{dimension === 'COUNT' && (
  <div className="flex items-end gap-2">
    <label className="flex-1">
      <span className="block text-sm text-muted">Weight / volume per unit (optional)</span>
      <input
        type="number" inputMode="decimal" min="0" step="any"
        className="w-full rounded border px-2 py-1"
        value={eachMeasureQty ?? ''}
        onChange={e => setEachMeasureQty(e.target.value === '' ? null : Number(e.target.value))}
        placeholder="e.g. 1100"
      />
    </label>
    <select
      className="rounded border px-2 py-1"
      value={eachMeasureUnit ?? 'g'}
      onChange={e => setEachMeasureUnit(e.target.value)}
    >
      <option value="g">g</option>
      <option value="ml">ml</option>
    </select>
  </div>
)}
<p className="text-xs text-muted">Lets weight-format invoices receive as units and weight-based recipes cost correctly. Leave blank if not needed.</p>
```

Wire `eachMeasureQty` / `eachMeasureUnit` into the component's form state (init from the loaded item) and into the submit payload (`eachMeasureQty`, `eachMeasureUnit`).

- [ ] **Step 3: Verify in the preview**

Start the dev server (preview_start), open `/inventory`, edit a COUNT item, confirm the field shows; edit a MASS item, confirm it's hidden. Save a value and reload to confirm it persists (network 200 on PUT).

- [ ] **Step 4: Commit**

```bash
git add src/components src/app/inventory
git commit -m "feat(inventory): UI to set the count↔weight bridge on COUNT items"
```

---

## Task 10: Non-destructive conflict resolver

**Files:**
- Modify: `src/components/invoices/v2/issues.tsx` (dimension-conflict block, lines ~61-98)
- Reuse: `PUT /api/inventory/[id]` (Task 8) to write the bridge

- [ ] **Step 1: Add a "set bridge & receive as count" primary action**

In the dimension-conflict resolver, when the matched item is COUNT (or its base is `each`) and the offer dimension is measured, render a new primary action ABOVE the destructive AdoptFormatModal trigger. It derives the per-each size from the line's `packSize/packUOM` (or the line total ÷ inferred count), PUTs the bridge to the item, then re-runs the line's match so it re-evaluates as no-conflict.

```tsx
{isCountItem && offerIsMeasured && (
  <ActButton variant="primary" onClick={() => ctx.bridgeAndReceiveAsCount(item)}>
    Set 1 each = {perEachLabel} and receive as units
  </ActButton>
)}
```

- [ ] **Step 2: Implement `bridgeAndReceiveAsCount` in the invoice context**

Locate the context that exposes `adoptInvoiceFormat` (same file/provider) and add:

```ts
async function bridgeAndReceiveAsCount(item: ScanItem) {
  const md = item.matchedItem as { id: string; dimension?: string; packChain?: unknown }
  // per-each size = the measured pack size from the line (e.g. 1100 g)
  const qty = Number(item.invoicePackSize ?? item.packSize ?? 0)
  const unit = String(item.invoicePackUOM ?? item.packUOM ?? 'g').toLowerCase()
  if (!(qty > 0)) return
  await fetch(`/api/inventory/${md.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dimension: 'COUNT',
      packChain: md.packChain,            // unchanged
      eachMeasureQty: qty,
      eachMeasureUnit: unit,
    }),
  })
  await refreshSession()                  // re-hydrate matchedItem (now carries the bridge)
}
```

> The PUT requires `packChain`/`pricing`/`countUnit` (the route validates `packChain` present) — include the item's current values unchanged. Confirm the exact required payload against Task 8's destructure and pass the existing item fields so nothing else changes.

- [ ] **Step 3: Verify in preview**

With a real bridged scenario (or a seeded one): open an invoice whose Sysco line conflicts on a COUNT item, click the new action, confirm the conflict clears and the line receives as units (no stock reset, no dimension flip on the item).

- [ ] **Step 4: Commit**

```bash
git add src/components/invoices/v2/issues.tsx src/components/invoices
git commit -m "feat(invoice): non-destructive 'set bridge & receive as units' resolver"
```

---

## Task 11: Backfill candidate listing + assignment

**Files:**
- Create: `scripts/assign-each-measure.ts`

- [ ] **Step 1: Write the candidate-listing script**

Create `scripts/assign-each-measure.ts`. In `--list` mode it prints COUNT items that have weight-format offers or match-rules (a current/latent mismatch); in `--apply` mode it writes a confirmed `{ itemId, qty, unit }[]` map.

```ts
// List/apply count↔weight bridges. Run:
//   npx tsx scripts/assign-each-measure.ts --list
//   npx tsx scripts/assign-each-measure.ts --apply
import { prisma } from '../src/lib/prisma'

// Confirmed bridges go here after reviewing --list output:
const ASSIGN: { itemId: string; qty: number; unit: string }[] = [
  // { itemId: 'ckxxx', qty: 1100, unit: 'g' },
]

async function list() {
  const items = await prisma.inventoryItem.findMany({
    where: { dimension: 'COUNT' },
    select: { id: true, itemName: true, baseUnit: true,
      supplierPrices: { select: { supplierName: true, packUOM: true, packSize: true } },
      matchRules: { select: { invoicePackUOM: true, invoicePackSize: true } } },
  })
  const measured = (u?: string | null) => !!u && ['g','kg','ml','l','oz','lb'].includes(u.toLowerCase())
  const candidates = items.filter(i =>
    i.supplierPrices.some(p => measured(p.packUOM)) || i.matchRules.some(r => measured(r.invoicePackUOM)))
  for (const c of candidates) {
    const sizes = [
      ...c.supplierPrices.filter(p => measured(p.packUOM)).map(p => `${p.supplierName}:${p.packSize}${p.packUOM}`),
      ...c.matchRules.filter(r => measured(r.invoicePackUOM)).map(r => `rule:${r.invoicePackSize}${r.invoicePackUOM}`),
    ]
    console.log(`${c.id}  ${c.itemName}  → ${sizes.join(', ')}`)
  }
  console.log(`\n${candidates.length} candidate COUNT item(s). Add confirmed ones to ASSIGN and run --apply.`)
}

async function apply() {
  for (const a of ASSIGN) {
    await prisma.inventoryItem.update({
      where: { id: a.itemId },
      data: { eachMeasureQty: a.qty, eachMeasureUnit: a.unit },
    })
    console.log(`✓ ${a.itemId} → 1 each = ${a.qty} ${a.unit}`)
  }
  console.log(`\napplied ${ASSIGN.length} bridge(s)`)
}

const mode = process.argv[2]
;(mode === '--apply' ? apply() : list())
  .then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Run the listing**

Run: `npx tsx scripts/assign-each-measure.ts --list`
Expected: a list of candidate COUNT items (incl. Brioche Unsliced) with the weight sizes seen per supplier. **Stop and show the user** to confirm per-each weights before applying.

- [ ] **Step 3: Apply confirmed bridges (after user confirmation)**

Fill `ASSIGN` with the confirmed items, then run: `npx tsx scripts/assign-each-measure.ts --apply`
Expected: `✓` per item, `applied N bridge(s)`.

- [ ] **Step 4: Commit the script**

```bash
git add scripts/assign-each-measure.ts
git commit -m "chore(inventory): bridge candidate-listing + backfill script"
```

---

## Task 12: Final verification

- [ ] **Step 1: Full type-check / build**

Run: `npm run build`
Expected: succeeds; API routes for invoices/inventory still show `ƒ (Dynamic)`.

- [ ] **Step 2: Pure-logic regression**

Run: `npx tsx scripts/check-bridge-conversions.ts`
Expected: `all bridge assertions passed`.

- [ ] **Step 3: Live end-to-end (preview)**

1. Set Brioche's bridge (1 each = 1100 g) via the inventory UI.
2. Scan/open a Sysco Brioche line (`8 × 1100 g`): confirm **no dimension conflict**, receives as **8 each**, and on approve the spine reads **$/each** (`casePrice ÷ 8`).
3. Open a Snowcap Brioche line (`1 × 8 each`): still clean.
4. Open a weight-based recipe using Brioche: cost is **non-zero and correct**.
5. Pick an unrelated null-bridge COUNT item and confirm its recipe/invoice costs are **unchanged**.

- [ ] **Step 4: Final commit (if any verification fixups)**

```bash
git add -A
git commit -m "test(bridge): verification fixups for count↔weight bridge"
```

---

## Self-Review notes

- **Spec coverage:** §1 data model → Tasks 1-3; §2 recipe costing → Task 4; §3a conflict check → Task 5; §3b normalization → Task 6; §3c approve guard → Task 7; §4 UI → Tasks 9-10; §5 migration/backfill → Tasks 1 & 11; §6 testing → Tasks 3 & 12.
- **Type consistency:** `EachMeasure = { qty, unit }` used identically across `eachMeasureOf`, `convertQtyBridged`, `dimensionallyCostable`, `buildOffer` opts, and the approve guard. `convertQtyBridged` / `dimensionallyCostable` third arg is optional everywhere, so existing 2-arg callers compile.
- **Non-regression:** null-bridge items take the unchanged `convertQty` / old `chainFromOcr` COUNT path; MASS/VOLUME paths untouched.
- **Open implementation confirmations (grep-verified during execution, not guesses):** exact `matchedItem` select (Task 5.3), all `buildOffer(` call sites (Task 6.3), the approve item select + whether `newPricePerBase` is already canonical-base (Task 7), and the inventory form component path (Task 9.1).
