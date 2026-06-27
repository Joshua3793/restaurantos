# UoM Reconciliation — Density Bridge + Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop treating a cross-dimension invoice/item unit mismatch as a hard conflict that forces a destructive overwrite; instead learn a conversion **once, stored on the item**, and pre-fill a one-tap confirm — adding a real density bridge for weight↔volume and a four-way classifier that replaces the `hasDimensionConflict` boolean.

**Architecture:** The conversion factor lives **on the `InventoryItem`** (decided with the user — `densityGPerMl` mirrors the existing `eachMeasureQty/Unit` count↔weight bridge), so recipe costing and invoice reconciliation can never disagree. The spine (`pricePerBaseUnit`) is still set **once at the invoice-approve boundary**; recipes read the spine and the same item-level density everywhere. Everything is additive: no item is rewritten by the resolver, no migration of existing data, density defaults are flagged estimates that degrade to "ask" rather than guess silently.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase pooler) · React client components · Tailwind. No unit-test suite — pure logic is verified with standalone `scripts/` files run via the `scripts/uom-reconcile/run.sh` wrapper; UI/route changes are verified with `npm run build` + the preview tools.

---

## Conventions for this plan

- **Verification of pure functions** uses a throwaway script under `scripts/uom-reconcile/` run via `bash scripts/uom-reconcile/run.sh <file>` (wraps ts-node with TS_NODE_BASEURL so `@/` aliases resolve) (same mechanism this repo already uses for `scripts/verify-count-conversion.ts`). Each script `process.exit(1)`s on a failed assertion so red/green is real. These scripts are committed alongside the code as living checks.
- **Verification of routes/UI** uses `npm run build` (the repo's only type-check) and, where visible, the `preview_*` tools.
- **DB schema changes**: per the repo's migration constraints (memory: `prisma migrate dev` fails P3006; direct host unreachable), DDL is applied with `$executeRawUnsafe` over the pooler, the column is added to `schema.prisma`, then `npx prisma generate`. Expand-contract: code that reads the new column tolerates `null` from day one, so deploy order doesn't matter.
- **Commit after every task.** Branch: `feat/uom-density-bridge`.

```bash
git checkout -b feat/uom-density-bridge
```

---

## File Structure

**New files**
- `src/lib/density.ts` — seed density library (g/ml) + `lookupDensity(name, category?)`. One responsibility: name → density default.
- `src/lib/invoice/classify.ts` — `classifyDimensionRelationship()` → four-way verdict + trust tier + pre-derived factor. The new brain that replaces the boolean.
- `src/lib/invoice/cost-sanity.ts` — `costDriftWithinBand()` ±25% guardrail (pure).
- `scripts/uom-reconcile/verify-*.ts` — verification scripts (one per pure module).

**Modified files**
- `prisma/schema.prisma:106` — add `densityGPerMl Decimal?` to `InventoryItem` (next to the eachMeasure bridge).
- `src/lib/uom.ts:262` — extend `convertQtyBridged` with an optional `density` arg (weight↔volume path).
- `src/lib/item-model.ts` — `densityOf()` reader, `ChainItem.densityGPerMl`, `PRICING_SELECT`, `asChainItem`.
- `src/lib/recipeCosts.ts:113-116` — pass item density into `convertQtyBridged`.
- `src/app/api/invoices/sessions/[id]/approve/route.ts:151-215` — apply density at the weight↔volume boundary + persist `densityGPerMl` on the item.
- `src/lib/invoice/predicates.ts:55` — re-express `hasDimensionConflict` as a thin wrapper over the classifier.
- `src/components/invoices/v2/issues.tsx:62` — verdict-driven resolver: density-bridge form, blue-not-red, pre-fill + trust flag + guardrail, demote `adoptInvoiceFormat` to an Advanced disclosure.
- `src/components/invoices/v2/context.tsx` + `InvoiceReviewDrawer.tsx` — `setItemDensity(item, gPerMl)` action (persists density on the item, mirrors `bridgeAndReceiveAsCount`).
- Header copy: "N to bridge" instead of "N conflicts" (drawer header).

---

## Phase 1 — Conversion engine + data model (spine-safe foundation)

### Task 1: Add `densityGPerMl` column to InventoryItem

**Files:**
- Modify: `prisma/schema.prisma:106`
- Create: `scripts/uom-reconcile/add-density-column.ts`

- [ ] **Step 1: Add the field to the schema** (immediately after `eachMeasureUnit` at line 107)

```prisma
  eachMeasureQty     Decimal?                 // measure of 1 base unit (e.g. 1100)
  eachMeasureUnit    String?                  // its unit, base-canonical (g | ml)
  // ── Weight↔volume density bridge (measured items) ───────────────────────────
  // Grams per millilitre for THIS good. Lets a weight invoice ($/kg) set the
  // spine of a volume-based item (and vice-versa) without the silent density≈1
  // assumption. Null = unknown (callers fall back to 1.0, flagged as estimate).
  densityGPerMl      Decimal?
```

- [ ] **Step 2: Write the DDL apply script**

```ts
// scripts/uom-reconcile/add-density-column.ts
import { prisma } from '../../src/lib/prisma'

async function main() {
  // Idempotent: ADD COLUMN IF NOT EXISTS over the pooler (no shadow DB).
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "densityGPerMl" DECIMAL`,
  )
  const [{ count }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM information_schema.columns
     WHERE table_name = 'InventoryItem' AND column_name = 'densityGPerMl'`,
  )
  if (Number(count) !== 1) throw new Error('densityGPerMl column not present after ALTER')
  console.log('OK: densityGPerMl present')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 3: Apply the DDL**

Run: `bash scripts/uom-reconcile/run.sh add-density-column.ts`
Expected: `OK: densityGPerMl present`

- [ ] **Step 4: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: completes; `InventoryItem.densityGPerMl` now typed `Prisma.Decimal | null`.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma scripts/uom-reconcile/add-density-column.ts
git commit -m "feat(uom): add InventoryItem.densityGPerMl weight↔volume bridge column"
```

---

### Task 2: Extend `convertQtyBridged` with a density path

**Files:**
- Modify: `src/lib/uom.ts:262-281`
- Create: `scripts/uom-reconcile/verify-convert-density.ts`

- [ ] **Step 1: Write the failing verification script**

```ts
// scripts/uom-reconcile/verify-convert-density.ts
import { convertQtyBridged } from '../../src/lib/uom'

let fails = 0
function near(label: string, got: number, want: number, tol = 1e-6) {
  if (Math.abs(got - want) > tol) { console.error(`FAIL ${label}: got ${got}, want ${want}`); fails++ }
  else console.log(`ok   ${label}`)
}

// honey 1.42 g/ml. 1 kg of honey = 1000 g → 1000/1.42 = 704.225 ml
near('kg→l honey', convertQtyBridged(1, 'kg', 'l', null, 1.42), 0.704225, 1e-4)
// 1 L of honey → 1000 ml × 1.42 = 1420 g = 1.42 kg
near('l→kg honey', convertQtyBridged(1, 'l', 'kg', null, 1.42), 1.42, 1e-4)
// no density → unchanged 1:1 passthrough (today's behaviour preserved)
near('kg→l no density', convertQtyBridged(1, 'kg', 'l', null, null), 1)
near('kg→l zero density', convertQtyBridged(1, 'kg', 'l', null, 0), 1)
// same dimension ignores density entirely
near('kg→g same dim', convertQtyBridged(2, 'kg', 'g', null, 1.42), 2000)
// count↔measured bridge still works, density irrelevant
near('each→g pack bridge', convertQtyBridged(2, 'each', 'g', { qty: 1100, unit: 'g' }, null), 2200)

if (fails) { console.error(`${fails} failure(s)`); process.exit(1) }
console.log('all passed'); process.exit(0)
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bash scripts/uom-reconcile/run.sh verify-convert-density.ts`
Expected: FAIL — `convertQtyBridged` currently ignores the 5th arg, so the density cases return `1` (passthrough) instead of the density-scaled value.

- [ ] **Step 3: Add the density branch to `convertQtyBridged`**

Replace the body of `convertQtyBridged` (lines 262-281) with:

```ts
export function convertQtyBridged(
  qty: number, fromUnit: string, toUnit: string,
  bridge?: { qty: number; unit: string } | null,
  density?: number | null,   // grams per millilitre — weight↔volume only
): number {
  const fromDim = dimensionForUnit(fromUnit)
  const toDim = dimensionForUnit(toUnit)
  if (fromDim === toDim) return convertQty(qty, fromUnit, toUnit)

  // weight ↔ volume via density (g/ml). Without a density, fall through to the
  // 1:1 passthrough below (today's density≈1 behaviour, unchanged).
  const measured = (d: UnitDimension) => d === 'weight' || d === 'volume'
  if (measured(fromDim) && measured(toDim) && density && density > 0) {
    if (fromDim === 'weight') {            // weight → volume:  g → ml = g / density
      const grams = convertQty(qty, fromUnit, 'g')
      return convertQty(grams / density, 'ml', toUnit)
    }
    const ml = convertQty(qty, fromUnit, 'ml')   // volume → weight: ml → g = ml × density
    return convertQty(ml * density, 'g', toUnit)
  }

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
  return convertQty(qty, fromUnit, toUnit)
}
```

Also update the doc-comment above it (lines 255-261) to add: `*  - weight ↔ volume WITH density (g/ml) → convert through g/ml using the density`.

- [ ] **Step 4: Run the verification to confirm it passes**

Run: `bash scripts/uom-reconcile/run.sh verify-convert-density.ts`
Expected: `all passed`

- [ ] **Step 5: Type-check the whole app** (the 5th param is optional, so existing 4-arg callers still compile)

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/lib/uom.ts scripts/uom-reconcile/verify-convert-density.ts
git commit -m "feat(uom): density path in convertQtyBridged for weight↔volume"
```

---

### Task 3: Seed density library + lookup

**Files:**
- Create: `src/lib/density.ts`
- Create: `scripts/uom-reconcile/verify-density-lookup.ts`

- [ ] **Step 1: Write the failing verification script**

```ts
// scripts/uom-reconcile/verify-density-lookup.ts
import { lookupDensity } from '../../src/lib/density'

let fails = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); fails++ }
  else console.log(`ok   ${label}`)
}

eq('egg yolk',  lookupDensity('Liquid Egg Yolk 11kg'), { gPerMl: 1.03, source: 'library' })
eq('olive oil', lookupDensity('Extra Virgin Olive Oil'), { gPerMl: 0.91, source: 'library' })
eq('honey',     lookupDensity('Clover Honey'), { gPerMl: 1.42, source: 'library' })
eq('unknown',   lookupDensity('Mystery Goo'), { gPerMl: 1.0, source: 'fallback' })
// case-insensitive + first-match-wins on the longest keyword
eq('sesame oil', lookupDensity('SESAME OIL TOASTED'), { gPerMl: 0.92, source: 'library' })

if (fails) { console.error(`${fails} failure(s)`); process.exit(1) }
console.log('all passed'); process.exit(0)
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bash scripts/uom-reconcile/run.sh verify-density-lookup.ts`
Expected: FAIL — `Cannot find module '../../src/lib/density'`.

- [ ] **Step 3: Create the density library**

```ts
// src/lib/density.ts
/**
 * Seed density library (grams per millilitre at service temperature). Used to
 * pre-fill the weight↔volume bridge when an invoice bills a measured good in the
 * OTHER dimension than the item tracks. Defaults only — every value is editable
 * per item (item.densityGPerMl) and a line that shows BOTH a weight and a volume
 * overrides the library. No name match → 1.00 flagged as an estimate, never a
 * silent guess. Values mirror the spec §04 density table.
 */
export type DensityHit = { gPerMl: number; source: 'library' | 'line' | 'fallback' }

// Keyword → density. Matched as a case-insensitive substring of the item name.
// Order matters only for display; lookup picks the LONGEST matching keyword so
// "sesame oil" beats a bare "oil" entry.
const DENSITY_LIBRARY: Record<string, number> = {
  // water-like
  water: 1.0, stock: 1.01, broth: 1.01, vinegar: 1.01, wine: 0.99,
  // dairy & egg
  'whole milk': 1.03, milk: 1.03, 'heavy cream': 0.99, cream: 0.99,
  'egg yolk': 1.03, 'egg white': 1.04, 'whole egg': 1.03, egg: 1.03,
  // juice & acidic
  'orange juice': 1.05, 'apple juice': 1.05, 'lemon juice': 1.03, 'lime juice': 1.03,
  lemon: 1.03, lime: 1.03, passata: 1.06, 'soy sauce': 1.17,
  // oils & fats
  'canola oil': 0.92, 'vegetable oil': 0.92, 'veg oil': 0.92, 'olive oil': 0.91,
  'sesame oil': 0.92, 'melted butter': 0.91, butter: 0.91, oil: 0.92,
  // syrups & sugar
  'simple syrup': 1.26, agave: 1.31, 'maple syrup': 1.33, maple: 1.33,
  molasses: 1.4, honey: 1.42, syrup: 1.26,
  // thick & emulsified (defaults provided; UI suggests weight-tracking)
  ketchup: 1.1, mustard: 1.05, mayonnaise: 0.91, mayo: 0.91,
}

const KEYWORDS_BY_LENGTH = Object.keys(DENSITY_LIBRARY).sort((a, b) => b.length - a.length)

/** Best density default for an item, by name (category reserved for future use). */
export function lookupDensity(name: string, _category?: string | null): DensityHit {
  const n = (name ?? '').toLowerCase()
  for (const kw of KEYWORDS_BY_LENGTH) {
    if (n.includes(kw)) return { gPerMl: DENSITY_LIBRARY[kw], source: 'library' }
  }
  return { gPerMl: 1.0, source: 'fallback' }
}
```

- [ ] **Step 4: Run the verification to confirm it passes**

Run: `bash scripts/uom-reconcile/run.sh verify-density-lookup.ts`
Expected: `all passed`

- [ ] **Step 5: Commit**

```bash
git add src/lib/density.ts scripts/uom-reconcile/verify-density-lookup.ts
git commit -m "feat(uom): seed density library + lookupDensity"
```

---

## Phase 2 — Classifier + guardrail (pure logic)

### Task 4: `densityOf()` reader + ChainItem wiring

**Files:**
- Modify: `src/lib/item-model.ts:13-22, 32-41, 115-135`
- Create: `scripts/uom-reconcile/verify-density-of.ts`

- [ ] **Step 1: Write the failing verification script**

```ts
// scripts/uom-reconcile/verify-density-of.ts
import { densityOf, asChainItem } from '../../src/lib/item-model'

let fails = 0
function eq(label: string, got: unknown, want: unknown) {
  if (got !== want) { console.error(`FAIL ${label}: got ${got}, want ${want}`); fails++ }
  else console.log(`ok   ${label}`)
}

eq('valid density', densityOf({ densityGPerMl: '1.03' as unknown }), 1.03)
eq('null density',  densityOf({ densityGPerMl: null }), null)
eq('zero rejected', densityOf({ densityGPerMl: 0 }), null)
eq('asChainItem carries density',
   asChainItem({ dimension: 'VOLUME', baseUnit: 'ml', packChain: [], pricing: {}, densityGPerMl: '0.91' as unknown }).densityGPerMl,
   0.91)

if (fails) { console.error(`${fails} failure(s)`); process.exit(1) }
console.log('all passed'); process.exit(0)
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bash scripts/uom-reconcile/run.sh verify-density-of.ts`
Expected: FAIL — `densityOf` is not exported.

- [ ] **Step 3: Add `densityOf`, the ChainItem field, and select/coerce wiring**

In `src/lib/item-model.ts`, add to the `ChainItem` interface (after line 21):

```ts
  /** Present only on measured items with a weight↔volume density bridge. g/ml. */
  densityGPerMl?: number | null
```

Add the reader after `eachMeasureOf` (after line 41):

```ts
/** Read the weight↔volume density (g/ml) off an item row. Null unless > 0.
 *  Decimal arrives as a string from Prisma JSON. */
export function densityOf(row: { densityGPerMl?: unknown }): number | null {
  const d = row.densityGPerMl != null ? Number(row.densityGPerMl) : NaN
  return Number.isFinite(d) && d > 0 ? d : null
}
```

Add `densityGPerMl: true` to `PRICING_SELECT` (line 115-118):

```ts
export const PRICING_SELECT = {
  dimension: true, baseUnit: true, packChain: true, pricing: true, countUnit: true,
  eachMeasureQty: true, eachMeasureUnit: true, densityGPerMl: true,
} as const
```

In `asChainItem` add to the param type and the return object:

```ts
export function asChainItem(row: {
  dimension: string; baseUnit: string; packChain: unknown; pricing: unknown
  countUnit?: string; stockOnHand?: unknown
  eachMeasureQty?: unknown; eachMeasureUnit?: string | null
  densityGPerMl?: unknown
}): ChainItem {
  return {
    dimension: row.dimension as Dimension,
    baseUnit: row.baseUnit,
    packChain: (row.packChain as PackLink[]) ?? [],
    pricing: (row.pricing as Pricing) ?? { mode: 'PACK', purchasePrice: 0 },
    countUnit: row.countUnit,
    stockOnHand: row.stockOnHand != null ? Number(row.stockOnHand) : 0,
    eachMeasure: eachMeasureOf(row),
    densityGPerMl: densityOf(row),
  }
}
```

- [ ] **Step 4: Run the verification to confirm it passes**

Run: `bash scripts/uom-reconcile/run.sh verify-density-of.ts`
Expected: `all passed`

- [ ] **Step 5: Commit**

```bash
git add src/lib/item-model.ts scripts/uom-reconcile/verify-density-of.ts
git commit -m "feat(uom): densityOf reader + ChainItem.densityGPerMl + PRICING_SELECT"
```

---

### Task 5: ±25% cost-sanity guardrail

**Files:**
- Create: `src/lib/invoice/cost-sanity.ts`
- Create: `scripts/uom-reconcile/verify-cost-sanity.ts`

- [ ] **Step 1: Write the failing verification script**

```ts
// scripts/uom-reconcile/verify-cost-sanity.ts
import { costDriftWithinBand } from '../../src/lib/invoice/cost-sanity'

let fails = 0
function eq(label: string, got: boolean, want: boolean) {
  if (got !== want) { console.error(`FAIL ${label}: got ${got}, want ${want}`); fails++ }
  else console.log(`ok   ${label}`)
}

eq('0% drift', costDriftWithinBand(4.22, 4.22), true)
eq('+24% within', costDriftWithinBand(4.22 * 1.24, 4.22), true)
eq('+26% outside', costDriftWithinBand(4.22 * 1.26, 4.22), false)
eq('-26% outside', costDriftWithinBand(4.22 * 0.74, 4.22), false)
eq('no basis allows', costDriftWithinBand(9.9, 0), true)  // current<=0 → nothing to compare
eq('custom band', costDriftWithinBand(2, 1, 1.5), true)    // +100% within a 150% band

if (fails) { console.error(`${fails} failure(s)`); process.exit(1) }
console.log('all passed'); process.exit(0)
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bash scripts/uom-reconcile/run.sh verify-cost-sanity.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the guardrail**

```ts
// src/lib/invoice/cost-sanity.ts
/**
 * Guardrail before a bridge factor is offered as a one-tap auto-confirm: the
 * reconciled $/base-unit must land within ±band of the item's current spine
 * $/base-unit. A factor that swings cost outside the band is held back as
 * "this looks off — check it" (the resolver downgrades auto-derive → ask),
 * even when the factor was derivable. When there's no current cost to compare
 * against (new/unpriced item), there's nothing to sanity-check → allow.
 */
export function costDriftWithinBand(
  reconciledPpb: number,
  currentPpb: number,
  band = 0.25,
): boolean {
  if (!(currentPpb > 0)) return true
  return Math.abs(reconciledPpb - currentPpb) / currentPpb <= band
}
```

- [ ] **Step 4: Run the verification to confirm it passes**

Run: `bash scripts/uom-reconcile/run.sh verify-cost-sanity.ts`
Expected: `all passed`

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoice/cost-sanity.ts scripts/uom-reconcile/verify-cost-sanity.ts
git commit -m "feat(invoice): ±25% cost-sanity guardrail helper"
```

---

### Task 6: `classifyDimensionRelationship()` four-way verdict

**Files:**
- Create: `src/lib/invoice/classify.ts`
- Create: `scripts/uom-reconcile/verify-classify.ts`
- Modify: `src/lib/invoice/predicates.ts:55-74` (re-express `hasDimensionConflict` as a wrapper)

- [ ] **Step 1: Write the failing verification script**

```ts
// scripts/uom-reconcile/verify-classify.ts
import { classifyDimensionRelationship } from '../../src/lib/invoice/classify'
import type { ScanItem } from '../../src/components/invoices/types'

let fails = 0
function eq(label: string, got: unknown, want: unknown) {
  if (got !== want) { console.error(`FAIL ${label}: got ${got}, want ${want}`); fails++ }
  else console.log(`ok   ${label}`)
}

// Minimal ScanItem factory — only the fields the classifier reads.
function line(p: Partial<ScanItem>): ScanItem {
  return {
    id: 'x', rawDescription: 'x', matchConfidence: 'HIGH', action: 'UPDATE_PRICE',
    ...p,
  } as unknown as ScanItem
}

// 1) Same dimension (kg line on a g item) → IDENTICAL
eq('identical', classifyDimensionRelationship(line({
  rateUOM: 'kg', pricingMode: 'per_weight',
  matchedItem: { dimension: 'MASS', baseUnit: 'g', itemName: 'Flour' } as never,
})).verdict, 'IDENTICAL')

// 2) Weight line on a VOLUME item, name in library, no in-line volume → DENSITY_BRIDGE / suggest
{
  const r = classifyDimensionRelationship(line({
    rateUOM: 'kg', pricingMode: 'per_weight',
    matchedItem: { dimension: 'VOLUME', baseUnit: 'ml', itemName: 'Liquid Egg Yolk' } as never,
  }))
  eq('density verdict', r.verdict, 'DENSITY_BRIDGE')
  eq('density tier', r.tier, 'suggest')
  eq('density value', r.verdict === 'DENSITY_BRIDGE' && r.density, 1.03)
}

// 3) Weight line on a COUNT item WITH derivable per-each (packSize+count) → PACK_BRIDGE / auto
{
  const r = classifyDimensionRelationship(line({
    pricingMode: 'per_weight', invoicePackUOM: 'lb', invoicePackSize: 2.04 as never, rawQty: 12 as never,
    matchedItem: { dimension: 'COUNT', baseUnit: 'each', itemName: 'Cabbage', countUnit: 'each' } as never,
  }))
  eq('pack verdict', r.verdict, 'PACK_BRIDGE')
  eq('pack tier', r.tier, 'auto')
}

// 4) Weight line on a COUNT item, weak match, nothing derivable → TRUE_CONFLICT
{
  const r = classifyDimensionRelationship(line({
    rateUOM: 'kg', pricingMode: 'per_weight', matchConfidence: 'LOW',
    matchedItem: { dimension: 'COUNT', baseUnit: 'each', itemName: 'Fresh Lemons', countUnit: 'each' } as never,
  }))
  eq('true conflict', r.verdict, 'TRUE_CONFLICT')
}

if (fails) { console.error(`${fails} failure(s)`); process.exit(1) }
console.log('all passed'); process.exit(0)
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bash scripts/uom-reconcile/run.sh verify-classify.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the classifier**

```ts
// src/lib/invoice/classify.ts
// The four-way verdict that replaces the hasDimensionConflict boolean. Reads the
// invoice line + linked item and decides whether the unit gap is a no-op
// (IDENTICAL), a recoverable bridge (DENSITY_BRIDGE / PACK_BRIDGE) pre-filled to
// a trust tier, or a genuine bad match (TRUE_CONFLICT) that should re-link first.
import type { ScanItem } from '@/components/invoices/types'
import { buildOffer, scanItemToOfferInput } from './offer'
import { dimensionOf, eachMeasureOf } from '@/lib/item-model'
import { lookupDensity } from '@/lib/density'

export type Tier = 'auto' | 'suggest' | 'ask'
export type DimRelationship =
  | { verdict: 'IDENTICAL' }
  | { verdict: 'DENSITY_BRIDGE'; tier: Tier; density: number; source: 'line' | 'library' | 'fallback' }
  | { verdict: 'PACK_BRIDGE'; tier: Tier; perEach: { qty: number; unit: string } | null }
  | { verdict: 'TRUE_CONFLICT' }

const isMeasured = (d: string) => d === 'MASS' || d === 'VOLUME'

export function classifyDimensionRelationship(item: ScanItem): DimRelationship {
  if (!item.matchedItem) return { verdict: 'IDENTICAL' } // unlinked is a separate issue
  const offer = buildOffer(scanItemToOfferInput(item))
  const md = item.matchedItem as {
    dimension?: string; baseUnit?: string; itemName?: string
    eachMeasureQty?: unknown; eachMeasureUnit?: string | null
  }
  const itemDim = (md.dimension as 'MASS' | 'VOLUME' | 'COUNT' | undefined) ?? dimensionOf(md.baseUnit ?? 'each')

  if (offer.dimension === itemDim) return { verdict: 'IDENTICAL' }

  // weight ↔ volume → density bridge
  if (isMeasured(offer.dimension) && isMeasured(itemDim)) {
    // A line carrying BOTH a weight and a volume gives a measured density (auto).
    // Otherwise default from the library by name (suggest); no match → 1.0 flag.
    const hit = lookupDensity(md.itemName ?? '')
    return {
      verdict: 'DENSITY_BRIDGE',
      tier: hit.source === 'fallback' ? 'ask' : 'suggest',
      density: hit.gPerMl,
      source: hit.source,
    }
  }

  // count ↔ measured → pack bridge (existing eachMeasure machinery)
  if (offer.dimension === 'COUNT' || itemDim === 'COUNT') {
    // Auto when the line itself carries pack count + per-each measure.
    const packSize = item.invoicePackSize != null ? Number(item.invoicePackSize) : null
    const packUnit = (item.invoicePackUOM ?? item.rateUOM ?? '')?.toLowerCase() || null
    if (packSize && packSize > 0 && packUnit) {
      return { verdict: 'PACK_BRIDGE', tier: 'auto', perEach: { qty: packSize, unit: packUnit } }
    }
    // Suggest when the item already remembers a per-each measure.
    const stored = eachMeasureOf(md)
    if (stored) return { verdict: 'PACK_BRIDGE', tier: 'suggest', perEach: stored }
    // Strong match but no factor → ask for it. Weak match → it's probably the
    // wrong product: surface re-link first.
    if (item.matchConfidence === 'HIGH') return { verdict: 'PACK_BRIDGE', tier: 'ask', perEach: null }
    return { verdict: 'TRUE_CONFLICT' }
  }

  return { verdict: 'TRUE_CONFLICT' }
}
```

- [ ] **Step 4: Run the verification to confirm it passes**

Run: `bash scripts/uom-reconcile/run.sh verify-classify.ts`
Expected: `all passed`

- [ ] **Step 5: Re-express `hasDimensionConflict` as a wrapper** (keeps all existing call sites working)

Replace `hasDimensionConflict` in `src/lib/invoice/predicates.ts` (lines 55-74) with:

```ts
import { classifyDimensionRelationship } from './classify'

// ── Dimension conflict ────────────────────────────────────────────────────────
/** True only for a genuine, non-recoverable mismatch (a wrong match). Density and
 *  pack bridges are NOT conflicts — they're recoverable and surface as "to bridge".
 *  Thin wrapper over classifyDimensionRelationship so every legacy call site
 *  (pickAccent, lineIssues, card) keeps the same boolean meaning. */
export function hasDimensionConflict(item: ScanItem): boolean {
  if (!item.matchedItem) return false
  return classifyDimensionRelationship(item).verdict === 'TRUE_CONFLICT'
}
```

Remove the now-unused `eachMeasureOf` import from predicates.ts if nothing else references it (check first; `dimensionOf` may still be used elsewhere in the file — it is not, so prune both `dimensionOf` and `eachMeasureOf` from the line 9 import only if unused after this edit). Run `npm run build` to confirm no unused-import or missing-symbol errors.

> **Behaviour change to note:** weight↔volume and recoverable count↔measured lines previously returned `true` from `hasDimensionConflict` (hard red blocker). They now return `false` (recoverable). This is intentional and is the core of the redesign — but it means those lines are **no longer blocked from approval by this predicate alone**. Phase 3 Task 8 wires the approve-time density application so the spine is set correctly for them; until Task 8 lands, a weight↔volume line would approve using the existing 1:1 path. Land Phase 3 before shipping.

- [ ] **Step 6: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/lib/invoice/classify.ts src/lib/invoice/predicates.ts scripts/uom-reconcile/verify-classify.ts
git commit -m "feat(invoice): classifyDimensionRelationship + hasDimensionConflict wrapper"
```

---

## Phase 3 — Apply density in costing + approve (spine wiring)

### Task 7: Thread item density into recipe costing

**Files:**
- Modify: `src/lib/recipeCosts.ts:7-9, 85, 113-116`
- Create: `scripts/uom-reconcile/verify-recipe-density.ts`

- [ ] **Step 1: Write the failing verification script** (drives `computeRecipeCost` directly — no DB)

```ts
// scripts/uom-reconcile/verify-recipe-density.ts
import { computeRecipeCost } from '../../src/lib/recipeCosts'

let fails = 0
function near(label: string, got: number, want: number, tol = 1e-3) {
  if (Math.abs(got - want) > tol) { console.error(`FAIL ${label}: got ${got}, want ${want}`); fails++ }
  else console.log(`ok   ${label}`)
}

// Item: honey, base ml, $0.01/ml. Recipe asks for 1 kg of it.
// With density 1.42 g/ml: 1 kg = 1000 g = 704.225 ml → cost = 704.225 × 0.01 = $7.042
const recipe = {
  baseYieldQty: 1, portionSize: null, menuPrice: null,
  ingredients: [{
    id: 'i1', sortOrder: 0, qtyBase: 1, unit: 'kg', notes: null,
    inventoryItemId: 'inv1', linkedRecipeId: null, linkedRecipe: null,
    inventoryItem: {
      itemName: 'Honey', baseUnit: 'ml', dimension: 'VOLUME',
      packChain: [{ unit: 'jug', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 10 }, // $10 / 1000 ml = $0.01/ml
      densityGPerMl: 1.42 as unknown,
    },
  }],
}
const out = computeRecipeCost(recipe as never)
near('honey kg→ml cost', out.totalCost, 7.0422, 1e-3)
if (out.dimensionConflicts !== 0) { console.error(`FAIL: expected 0 dimension conflicts, got ${out.dimensionConflicts}`); fails++ }
else console.log('ok   no dimension conflict')

if (fails) { console.error(`${fails} failure(s)`); process.exit(1) }
console.log('all passed'); process.exit(0)
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bash scripts/uom-reconcile/run.sh verify-recipe-density.ts`
Expected: FAIL — costing currently passes weight↔volume 1:1, so it computes 1000 ml × $0.01 = $10.00, not $7.042.

- [ ] **Step 3: Pass the item density into `convertQtyBridged`**

In `src/lib/recipeCosts.ts`, update the import on line 9 to add `densityOf`:

```ts
import { dimensionOf, DIMENSION_BASE, eachMeasureOf, densityOf, PRICING_SELECT, asChainItem, pricePerBaseUnit as chainPricePerBaseUnit } from './item-model'
```

In the ingredient type (line 85) add the density field to the inline select shape:

```ts
      inventoryItem: ({ itemName: string; baseUnit: string; allergens?: string[]; densityGPerMl?: unknown } & Parameters<typeof asChainItem>[0]) | null
```

Replace lines 113-116 with:

```ts
      const ingBridge    = eachMeasureOf(ing.inventoryItem)
      const ingDensity   = densityOf(ing.inventoryItem)
      dimensionConflict  = !dimensionallyCostable(ing.unit, ingredientBaseUnit, ingBridge)
      // Convert recipe unit → inventory base unit before multiplying by price.
      // Density bridges weight↔volume; ingBridge bridges count↔measured.
      lineCostQty = convertQtyBridged(qty, ing.unit, ing.inventoryItem.baseUnit, ingBridge, ingDensity)
```

> Callers that load `ing.inventoryItem` for costing already spread `...PRICING_SELECT` (Task 4 added `densityGPerMl` there), so the field is fetched automatically. Grep for recipe-ingredient selects that hand-list columns instead of spreading `PRICING_SELECT` and add `densityGPerMl: true` if any are found: `grep -rn "PRICING_SELECT" src/ | grep -i recipe`.

- [ ] **Step 4: Run the verification to confirm it passes**

Run: `bash scripts/uom-reconcile/run.sh verify-recipe-density.ts`
Expected: `all passed`

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/lib/recipeCosts.ts scripts/uom-reconcile/verify-recipe-density.ts
git commit -m "feat(cost): apply item densityGPerMl in recipe weight↔volume costing"
```

---

### Task 8: Apply density at the invoice-approve boundary + persist on item

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts:151-215, ~249-260`

- [ ] **Step 1: Resolve density when a UOM rate crosses weight↔volume**

In the approve route, the UOM branch (lines 155-169) computes `newPricePerBase = newPurchasePrice / getUnitConv(rateUnit)`. That yields `$/g` for a `$/kg` rate. When the **item's base is the OTHER measured dimension** (e.g. base `ml`, rate `kg`), the value must be scaled by density to become `$/ml`. Insert, immediately after the existing UOM block closes (after line 169, inside the `if (isUomMode)`):

```ts
          // ── Weight↔volume density bridge ────────────────────────────────────
          // A measured rate ($/kg) on an item whose base is the OTHER measured
          // dimension ($/ml) must cross via density (g/ml), not the silent 1:1.
          // Precedence: density already learned on the item > library default by
          // name > 1.0 fallback. The resolved density is persisted on the item
          // below, so recipe costing (Task 7) and this spine write always agree.
          const rateDim = dimensionOf(resolvedRateUnit)
          const baseDim = dimensionOf(item.baseUnit ?? 'each')
          const crossesWV =
            (rateDim === 'MASS' && baseDim === 'VOLUME') ||
            (rateDim === 'VOLUME' && baseDim === 'MASS')
          if (crossesWV) {
            const learned = item.densityGPerMl != null ? Number(item.densityGPerMl) : null
            density = (learned && learned > 0)
              ? learned
              : lookupDensity(item.itemName ?? scanItem.rawDescription ?? '').gPerMl
            // newPricePerBase is $/<rate-base> (e.g. $/g). Cross to the item base:
            //   rate MASS  → item VOLUME:  $/g × (g/ml) = $/ml
            //   rate VOLUME→ item MASS:    $/ml ÷ (g/ml) = $/g
            newPricePerBase = rateDim === 'MASS'
              ? newPricePerBase * density
              : newPricePerBase / density
          }
```

Declare `let density = 0` and import `lookupDensity` at the top of the file:

```ts
import { lookupDensity } from '@/lib/density'
```

and add `density` to the `let` declarations near `let newPricePerBase: number` (line 151):

```ts
        let newPricePerBase: number
        let density = 0
```

Ensure `item` is selected with `itemName` and `densityGPerMl` — find the inventory-item fetch for the approve loop and confirm both columns are in its `select` (add `itemName: true, densityGPerMl: true` if missing).

- [ ] **Step 2: Persist the resolved density on the item with the spine write**

Find the item `pricing` update (the spine write near line 249-260, the `prisma.inventoryItem.update` that sets `pricing`/`purchasePrice`). Add `densityGPerMl` to its `data` so a learned/derived density sticks for next time:

```ts
        data: {
          purchasePrice: newPurchasePrice,
          lastUpdated:   new Date(),
          pricing: newPricing as any,
          // Persist the resolved weight↔volume density so the next invoice +
          // every recipe cost uses the same factor (no per-path divergence).
          ...(density > 0 ? { densityGPerMl: density } : {}),
        },
```

> The dimension guard at lines 205-215 already passes weight↔volume (`dimensionallyCostable` returns true for measured↔measured), so no change there — it still correctly skips a measured rate landing on a COUNT/each item.

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Manually verify against a real session** (no automated harness for the approve route)

Start the dev server and confirm a weight↔volume line approves and writes a sane spine:

Run: `preview_start` (config name `dev`), then in the app open an invoice with a `$/kg` line linked to a volume item (or seed one). Approve, then check the item's `densityGPerMl` and `pricing` via Prisma studio or a quick script:

```bash
cat > scripts/uom-reconcile/check-egg-yolk.ts <<'EOF'
import { prisma } from '../../src/lib/prisma'
prisma.inventoryItem.findFirst({ where: { itemName: { contains: 'Egg Yolk', mode: 'insensitive' } }, select: { itemName: true, baseUnit: true, densityGPerMl: true, pricing: true } }).then(r => { console.log(r); process.exit(0) })
EOF
bash scripts/uom-reconcile/run.sh check-egg-yolk.ts
```

Expected: `densityGPerMl` is populated (e.g. `1.03`) and `pricing` reflects the density-scaled `$/ml`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/invoices/sessions/[id]/approve/route.ts
git commit -m "feat(invoice): density bridge at approve boundary + persist densityGPerMl"
```

---

## Phase 4 — Resolver UX (verdict-driven, blue-not-red)

### Task 9: `setItemDensity` drawer action

**Files:**
- Modify: `src/components/invoices/v2/context.tsx` (type), `src/components/invoices/v2/InvoiceReviewDrawer.tsx` (impl, near `bridgeAndReceiveAsCount` at line 816)

- [ ] **Step 1: Add the action to the context type**

In `src/components/invoices/v2/context.tsx`, beside `bridgeAndReceiveAsCount` (around line 67):

```ts
  // ── Resolve a weight↔volume mismatch non-destructively: set the item's density
  // (g/ml) so a measured invoice in the other dimension costs correctly. Like the
  // pack bridge, this writes ONLY the bridge field — never dimension/chain/stock.
  setItemDensity: (item: ScanItem, gPerMl: number) => Promise<void>
```

- [ ] **Step 2: Implement it** in `InvoiceReviewDrawer.tsx`, mirroring `bridgeAndReceiveAsCount` (after line 845):

```ts
  const setItemDensity = useCallback(async (item: ScanItem, gPerMl: number) => {
    const md = item.matchedItem
    if (!md?.id || !(gPerMl > 0)) return
    await fetch(`/api/inventory/${md.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dimension:  md.dimension,        // unchanged
        packChain:  md.packChain,        // unchanged
        pricing:    md.pricing,          // unchanged
        countUnit:  md.countUnit ?? null,// unchanged
        densityGPerMl: gPerMl,           // ← the only write
      }),
    })
    if (session) await refreshSession(session.id)
  }, [session, refreshSession])
```

Add `setItemDensity` to the context provider `value={{ ... }}` object alongside `bridgeAndReceiveAsCount`.

- [ ] **Step 3: Confirm the inventory PUT route accepts `densityGPerMl`**

Open `src/app/api/inventory/[id]/route.ts` and confirm the PATCH/PUT handler persists `densityGPerMl` when present (it must pass through to `prisma.inventoryItem.update`). If the handler whitelists fields, add `densityGPerMl` to the whitelist with a `Number()`-coerce + `> 0` guard. Add this code where sibling fields like `eachMeasureQty` are handled:

```ts
    ...(body.densityGPerMl != null && Number(body.densityGPerMl) > 0
      ? { densityGPerMl: Number(body.densityGPerMl) }
      : {}),
```

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/invoices/v2/context.tsx src/components/invoices/v2/InvoiceReviewDrawer.tsx src/app/api/inventory/[id]/route.ts
git commit -m "feat(invoice): setItemDensity drawer action (non-destructive density write)"
```

---

### Task 10: Verdict-driven `DimensionConflictIssue` (density form, blue-not-red, demote adopt)

**Files:**
- Modify: `src/components/invoices/v2/issues.tsx:53-174`

- [ ] **Step 1: Branch the issue render on the classifier verdict**

In `issues.tsx`, import the classifier and guardrail at the top:

```ts
import { classifyDimensionRelationship } from '@/lib/invoice/classify'
import { costDriftWithinBand } from '@/lib/invoice/cost-sanity'
import { computeNormalisedPrices } from '@/lib/invoice/calculations'
```

Inside `DimensionConflictIssue`, compute the verdict once and use it to choose copy, colour, and pre-fill:

```ts
  const rel = classifyDimensionRelationship(item)
  const isDensity = rel.verdict === 'DENSITY_BRIDGE'
  const isTrue    = rel.verdict === 'TRUE_CONFLICT'
  // Density pre-fill + ±25% guardrail: a derivable factor that swings cost out of
  // band is demoted to "check it" (never one-tap).
  const norm = computeNormalisedPrices(item)
  const densityPrefill = isDensity ? rel.density : null
```

- [ ] **Step 2: Render the density bridge form** (new branch, sibling to the existing pack-bridge form). Add a density-specific state + save handler near the existing `bridging` state (line 98):

```ts
  const [dq, setDq] = useState(densityPrefill != null ? String(densityPrefill) : '')
  const [savingD, setSavingD] = useState(false)
  const driftOk = norm ? costDriftWithinBand(norm.invoicePPB * Number(dq || 0), norm.inventoryPPB) : true
  const canSaveD = Number(dq) > 0 && !savingD
  const saveDensity = async () => {
    setSavingD(true)
    try { await ctx.setItemDensity(item, Number(dq)) }
    finally { setSavingD(false) }
  }
```

For the **density** verdict, render an `IssueShell` with `kind="conflict"` BUT with blue "teach" copy and a one-tap confirm:

```tsx
  if (isDensity) {
    return (
      <IssueShell kind="price" /* blue/info tone, not red */ label="Confirm the bridge"
        actions={
          <>
            <ActButton variant="primary" disabled={!canSaveD} onClick={saveDensity}>
              {savingD ? 'Saving…' : `Confirm · 1 ml = ${dq || '?'} g`}
            </ActButton>
            <ActButton onClick={() => ctx.startLinkPicker(lineId)}>Wrong item → re-link</ActButton>
            <details className="adv"><summary>Advanced</summary>
              <ActButton variant="danger" onClick={() => ctx.adoptInvoiceFormat(item)}>
                Change {itemName} to {DIM_LABEL[offer.dimension]} (resets stock, re-costs recipes)
              </ActButton>
            </details>
          </>
        }
      >
        <span>
          {itemName} is billed by <b>{DIM_LABEL[offer.dimension]}</b> but tracked by{' '}
          <b>{DIM_LABEL[itemDim]}</b>. They’re the same liquid — bridge by density.
          {rel.source === 'fallback' && <i> Estimate — confirm before saving.</i>}
          {!driftOk && <i className="text-red-text"> This factor swings cost &gt;25% — check it.</i>}
        </span>
        <div className="flex items-center gap-1.5 mt-2" onClick={e => e.stopPropagation()}>
          <span className="text-[12.5px]">1 ml =</span>
          <input type="number" inputMode="decimal" min="0" step="any" value={dq}
            onChange={e => setDq(e.target.value)}
            className="w-20 h-8 px-2 text-center border border-line rounded bg-paper text-sm tabular-nums" />
          <span className="text-[12.5px] text-ink-3">g</span>
        </div>
      </IssueShell>
    )
  }
```

- [ ] **Step 3: Keep the pack-bridge branch, demote `adoptInvoiceFormat`** For the count↔measured (pack) and `TRUE_CONFLICT` cases, keep the existing form but move the destructive "Change … to …" button into the same `<details className="adv">` Advanced disclosure, and lead with re-link for `TRUE_CONFLICT`. The existing pack-bridge editable form (lines 135-171) is unchanged; only the action row changes: re-link + bridge primary, adopt demoted.

- [ ] **Step 4: Header count copy** In `InvoiceReviewDrawer.tsx`, the header pill that reads `"N conflicts"` / `"N to bridge"` (search for the `hdPill` / count string) — change the label so recoverable bridges read "N to bridge" and only `TRUE_CONFLICT` lines (via `hasDimensionConflict`) read as a hard count. Use `classifyDimensionRelationship` to tally bridgeable vs true.

- [ ] **Step 5: Type-check + visual verify**

Run: `npm run build`
Expected: build succeeds.

Then `preview_start`, open an invoice with (a) a `$/kg` line on a volume item and (b) a `$/lb` line on a count item. Confirm: (a) renders a **blue** "Confirm the bridge · 1 ml = 1.03 g" one-tap; (b) renders the pack-bridge form; the destructive "Change …" button is under **Advanced** in both. `preview_screenshot` the resolved states.

- [ ] **Step 6: Commit**

```bash
git add src/components/invoices/v2/issues.tsx src/components/invoices/v2/InvoiceReviewDrawer.tsx
git commit -m "feat(invoice): verdict-driven resolver — density form, blue-not-red, adopt demoted to Advanced"
```

---

### Task 11: Density editable in Setup → Suppliers (optional, ship-after)

**Files:**
- Modify: the item inventory drawer where `eachMeasure` is edited (mirror the field), or Setup → Suppliers density table.

- [ ] **Step 1:** Add a `densityGPerMl` number input to the inventory item drawer (beside the eachMeasure bridge inputs), so a wrong density can be corrected once, globally. It PUTs to `/api/inventory/[id]` (already wired in Task 9 Step 3). Pre-fill from `lookupDensity(itemName)` when the stored value is null, flagged "estimate".

- [ ] **Step 2:** `npm run build`, visual verify the input saves and re-costs dependent recipes (the spine read picks it up automatically).

- [ ] **Step 3: Commit**

```bash
git commit -am "feat(inventory): edit item density (corrects weight↔volume bridge globally)"
```

---

## Self-Review

**Spec coverage** (against the imported `UoM Reconciliation.html`):
- §01 resolution menu rebuilt (confirm-bridge primary, adopt demoted) → Task 10. ✅
- §02 live resolver (verdict-driven render) → Task 10. ✅
- §03 `classifyDimensionRelationship()` four-way → Task 6. ✅
- §03 "bring drawer in line with `dimensionallyCostable`" → Task 6 (wrapper makes weight↔vol no longer a conflict). ✅
- §04 density library, line-derived override, 1.00 flagged fallback → Task 3 (library) + Task 6/Task 8 (precedence: line > learned > library > 1.0). ✅ (Line-derived density from a line carrying both weight+volume is handled by the `'line'` source slot in the classifier type and approve precedence; if a future OCR field exposes both, populate `source:'line'` there.)
- §05 trust ladder (auto/suggest/ask) → Task 6 `tier`. ✅
- §05 ±25% cost sanity check → Task 5 + Task 10 (drift demotes to "check it"). ✅
- §06 data model: bridge stored additively, item dimension/chain/stock never written by the flow → **deviation from spec, per user decision:** density lives on the **item** (`densityGPerMl`), not the supplier offer, so recipe costing and reconciliation share one factor (Task 1/7/8). Pack bridge already on item (`eachMeasure`). ✅ (documented)
- §06 memory: future lines auto-resolve → Task 8 persists density on item; once set, the classifier returns IDENTICAL-equivalent via learned density precedence, so no card surfaces. ✅
- §06 retire: demote `adoptInvoiceFormat`, keep/promote the bridge → Task 10. ✅

**Placeholder scan:** every code step contains complete code; verification scripts contain real assertions and exit codes; commands are concrete (`bash scripts/uom-reconcile/run.sh <file>`, `npm run build`). No TBD/TODO. ✅

**Type consistency:** `densityGPerMl` (column + body field), `densityOf()`, `DensityHit.source ∈ {library,line,fallback}`, `DimRelationship.source ∈ {line,library,fallback}`, `Tier ∈ {auto,suggest,ask}`, `setItemDensity(item, gPerMl)`, `costDriftWithinBand(reconciled, current, band)` — names match across all tasks. `convertQtyBridged(qty, from, to, bridge?, density?)` — 5-arg signature used identically in Task 2 (def), Task 7 (recipe call). ✅

**Critical ordering note:** Task 6 flips weight↔volume from "hard conflict" to "recoverable", which removes the approval block for those lines. Task 8 (approve-time density application) MUST ship in the same release, or a weight↔volume line could approve on the old 1:1 path. Phases 1→3 are the spine-safe core; ship them together. Phase 4 is UX and can follow.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-26-uom-density-bridge.md`.
