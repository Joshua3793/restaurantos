# Item Model Redesign — Pack-Chain Backbone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 8-field + 2-mode-switch `InventoryItem` pricing model with one declared `dimension`, one ordered `packChain`, and one `pricing` mode — and compute `pricePerBaseUnit` purely on read from those facts, deleting the cached `pricePerBaseUnit` / `conversionFactor` columns so backbone corruption becomes structurally impossible.

**Architecture:** A single pure module `src/lib/item-model.ts` owns the types (`Dimension`, `PackLink[]`, `Pricing`) and the total, branch-free `pricePerBaseUnit(item)` / `basePerUnit(item, unit)` functions (reusing the canonical `UNIT_FACTORS` table in `uom.ts` — never a second conversion table). The DB stores `dimension`, `baseUnit`, `packChain` (Json), `pricing` (Json), `countUnit`, `stockOnHand` (already base-unit). Every cost read loads a fixed `PRICING_SELECT` fragment and calls `pricePerBaseUnit(item)` instead of reading a column. A one-time deterministic backfill reconstructs each chain from today's legacy fields by running the legacy formula, so every existing recipe cost is reproduced exactly. The cached columns and legacy pack fields are dropped only after all writers and readers are switched.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase, pgBouncer transaction pool) · `ts-node` for scripts. No test runner — verification is a plain-node assertion harness (`scripts/test-item-model.ts`, mirroring `scripts/test-pricing-fix.ts`) plus `npm run build`.

**Decisions locked (with the user):**
- **Pure compute-on-read.** Delete `pricePerBaseUnit` and `conversionFactor`; replace all ~46 reads with `pricePerBaseUnit(item)` / `basePerUnit(item, unit)`.
- **Core model first.** `ItemOffer[]` migration is **out of scope** — `InventorySupplierPrice` keeps its own `pricePerBaseUnit` column for now (offers are a follow-up plan).
- **`stockOnHand` keeps its name.** It already holds base-unit quantities (= the design's `stockBase`); renaming it would churn count/allocation/reports for zero behavioural gain. The plan documents the equivalence and leaves the column name.
- **Reuse the canonical unit table.** `item-model.ts` imports `getUnitConv` / `getUnitDimension` from `uom.ts`. Do **not** reintroduce a local `TO_BASE` map (the design's `engine.js` had one only because it was a standalone prototype; our repo unified the tables in commit `332ed0f` and must stay unified).

---

## Reference: the target shapes

```ts
// src/lib/item-model.ts
export type Dimension = 'MASS' | 'VOLUME' | 'COUNT'
export type PackLink  = { unit: string; per: number }       // ordered outer→inner; leaf.per is in baseUnit
export type Pricing =
  | { mode: 'PACK'; purchasePrice: number }                 // pay per top container
  | { mode: 'RATE'; rate: number; rateUnit: string }        // pay per weight/volume (catchweight/bulk)
```

```prisma
// prisma/schema.prisma — InventoryItem, end state
enum Dimension { MASS  VOLUME  COUNT }

dimension   Dimension  @default(COUNT)
baseUnit    String     @default("each")   // 'g' | 'ml' | 'each' — declared, SI
packChain   Json       @default("[]")     // PackLink[]
pricing     Json       @default("{\"mode\":\"PACK\",\"purchasePrice\":0}")
countUnit   String     @default("each")   // a chain level OR a same-dimension unit
stockOnHand Decimal    @default(0)         // unchanged; always in baseUnit
// REMOVED: pricePerBaseUnit, conversionFactor, qtyPerPurchaseUnit, qtyUOM,
//          innerQty, packSize, packUOM, priceType, purchaseUnit, countUOM, needsReview→kept
```

**Field migration map (from the design's Handoff tab):**

| Old field(s) | → | New |
|---|---|---|
| `itemName, category, supplierId` | → | unchanged |
| `purchaseUnit` | → | `packChain[0].unit` |
| `qtyPerPurchaseUnit + qtyUOM + innerQty + packSize + packUOM` | ⇒ | `packChain[]` |
| `priceType: CASE` | → | `pricing.mode = 'PACK'` (+ `purchasePrice`) |
| `priceType: UOM` | → | `pricing.mode = 'RATE'` (+ `rate`, `rateUnit`) |
| `purchasePrice` | → | `pricing.purchasePrice` (PACK) |
| `baseUnit` (guessed) | ⇒ | `dimension → baseUnit` (declared, SI) |
| `countUOM` | → | `countUnit` (must resolve to a chain level or dim unit) |
| `conversionFactor` (stored) | ✕ | deleted — `basePerUnit(item, countUnit)` on read |
| `pricePerBaseUnit` (stored) | ✕ | deleted — `pricePerBaseUnit(item)` on read |
| `stockOnHand` | → | `stockOnHand` (same column, base-unit semantics) |
| `InventorySupplierPrice` | — | unchanged this plan (ItemOffer is a follow-up) |

---

## File Structure

**Create:**
- `src/lib/item-model.ts` — types + pure functions + `PRICING_SELECT` Prisma fragment + `validateChainItem()`.
- `scripts/test-item-model.ts` — assertion harness (no DB) proving the engine against the 4 fixtures.
- `scripts/backfill-item-model.ts` — one-time deterministic migration legacy fields → chain.
- `scripts/verify-item-model-parity.ts` — reads every item, asserts `pricePerBaseUnit(item)` == legacy stored ppb within tolerance.
- `prisma/migrations/<ts>_item_model_add/migration.sql` — additive columns.
- `prisma/migrations/<ts>_item_model_drop/migration.sql` — drop cached + legacy columns (last).

**Modify (writers):**
- `src/app/api/inventory/route.ts` — POST create.
- `src/app/api/inventory/[id]/route.ts` — PUT update.
- `src/app/api/invoices/sessions/[id]/approve/route.ts` — UPDATE_PRICE + CREATE_NEW.
- `src/lib/inventory-import.ts` + `src/app/api/inventory/import/route.ts` — CSV import.
- `src/lib/recipeCosts.ts` — `syncPrepToInventory` writes a PREP chain instead of ppb.
- `src/app/api/invoices/[id]/process/route.ts` — legacy process writer.
- `src/app/api/inventory/repair-prices/route.ts` — retire / no-op (chain makes it unnecessary).

**Modify (readers — mechanical, see Task 12 recipe):** ~25 files listed in Task 12.

**Modify (form UI):**
- `src/components/inventory/InventoryItemDrawer.tsx` — chain editor replaces qtyUOM/packUOM/innerQty/priceType.
- `src/app/inventory/page.tsx` — inline add form + live preview.

---

## PHASE 0 — The pure engine (no DB, fully testable)

### Task 1: Create the item-model engine

**Files:**
- Create: `src/lib/item-model.ts`
- Test: `scripts/test-item-model.ts`

- [ ] **Step 1: Write the failing test harness**

Create `scripts/test-item-model.ts`:

```ts
// Pure-engine regression test for the pack-chain item model. No DB.
// Run: npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/test-item-model.ts
import {
  pricePerBaseUnit, basePerUnit, levelBaseUnits, stockValue, validateChainItem,
  type Dimension, type PackLink, type Pricing,
} from '../src/lib/item-model'

let failures = 0
function eq(label: string, got: number, want: number, tol = 1e-9) {
  const ok = Math.abs(got - want) <= Math.max(tol, Math.abs(want) * 1e-6)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${got} want=${want}`)
  if (!ok) failures++
}

// Ketchup: case 12 × 1L bottle, $48 PACK → 48 / (12*1000) = 0.004 /ml
const ketchup = { dimension: 'VOLUME' as Dimension, baseUnit: 'ml',
  packChain: [{ unit: 'case', per: 12 }, { unit: 'bottle', per: 1000 }] as PackLink[],
  pricing: { mode: 'PACK', purchasePrice: 48 } as Pricing, countUnit: 'bottle', stockOnHand: 21000 }
eq('ketchup ppb', pricePerBaseUnit(ketchup), 48 / 12000)
eq('ketchup 1 bottle = ml', basePerUnit(ketchup, 'bottle'), 1000)
eq('ketchup 1 case = ml', basePerUnit(ketchup, 'case'), 12000)
eq('ketchup stock value', stockValue(ketchup), 21000 * (48 / 12000))

// Romaine: case 24 × 250g head, $32 PACK → 32 / 6000 g
const romaine = { dimension: 'MASS' as Dimension, baseUnit: 'g',
  packChain: [{ unit: 'case', per: 24 }, { unit: 'head', per: 250 }] as PackLink[],
  pricing: { mode: 'PACK', purchasePrice: 32 } as Pricing, countUnit: 'head', stockOnHand: 9000 }
eq('romaine ppb', pricePerBaseUnit(romaine), 32 / 6000)
eq('romaine 1 head = g', basePerUnit(romaine, 'head'), 250)
eq('romaine in kg', basePerUnit(romaine, 'kg'), 1000)        // dim unit, not a level

// Soda: case 4 × sleeve 6 × can 355ml, $36 PACK → 36 / 8520 ml
const soda = { dimension: 'VOLUME' as Dimension, baseUnit: 'ml',
  packChain: [{ unit: 'case', per: 4 }, { unit: 'sleeve', per: 6 }, { unit: 'can', per: 355 }] as PackLink[],
  pricing: { mode: 'PACK', purchasePrice: 36 } as Pricing, countUnit: 'can', stockOnHand: 17040 }
eq('soda ppb', pricePerBaseUnit(soda), 36 / 8520)
eq('soda levels case', levelBaseUnits(soda.packChain).case, 8520)

// Ribeye: catchweight RATE $28.60/kg → 28.6 / 1000 per g
const ribeye = { dimension: 'MASS' as Dimension, baseUnit: 'g',
  packChain: [{ unit: 'case', per: 9000 }] as PackLink[],
  pricing: { mode: 'RATE', rate: 28.6, rateUnit: 'kg' } as Pricing, countUnit: 'kg', stockOnHand: 7400 }
eq('ribeye ppb', pricePerBaseUnit(ribeye), 28.6 / 1000)
eq('ribeye stock value', stockValue(ribeye), 7400 * (28.6 / 1000))

// validation
console.log('validate ok:', validateChainItem(ketchup).length === 0 ? 'PASS' : 'FAIL')
console.log('validate catches empty chain:',
  validateChainItem({ ...ketchup, packChain: [] }).length > 0 ? 'PASS' : 'FAIL')
console.log('validate catches per<=0:',
  validateChainItem({ ...ketchup, packChain: [{ unit: 'x', per: 0 }] }).length > 0 ? 'PASS' : 'FAIL')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
```

- [ ] **Step 2: Run it to confirm it fails (module missing)**

Run: `npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/test-item-model.ts`
Expected: FAIL — `Cannot find module '../src/lib/item-model'`.

- [ ] **Step 3: Implement `src/lib/item-model.ts`**

```ts
import { getUnitConv, getUnitDimension } from './utils'

export type Dimension = 'MASS' | 'VOLUME' | 'COUNT'
export type PackLink = { unit: string; per: number }
export type Pricing =
  | { mode: 'PACK'; purchasePrice: number }
  | { mode: 'RATE'; rate: number; rateUnit: string }

/** Item facts the pricing engine needs. Decimal fields arrive as strings from
 *  Prisma JSON responses — callers must Number()-coerce per CLAUDE.md. */
export interface ChainItem {
  dimension: Dimension
  baseUnit: string
  packChain: PackLink[]
  pricing: Pricing
  countUnit?: string
  stockOnHand?: number
}

export const DIMENSION_BASE: Record<Dimension, string> = { MASS: 'g', VOLUME: 'ml', COUNT: 'each' }

/** Map a unit string to a Dimension via the canonical uom.ts table. */
export function dimensionOf(unit: string): Dimension {
  const d = getUnitDimension(unit)            // 'weight' | 'volume' | 'count'
  return d === 'weight' ? 'MASS' : d === 'volume' ? 'VOLUME' : 'COUNT'
}

/** base units in ONE top (purchase) unit = product of every link's `per`. */
export function basePerPurchase(chain: PackLink[]): number {
  return (chain ?? []).reduce((acc, l) => acc * Number(l?.per || 0), 1)
}

/** base units contained in 1 of EACH level — running product up the chain. */
export function levelBaseUnits(chain: PackLink[]): Record<string, number> {
  const out: Record<string, number> = {}
  let running = 1
  for (let i = (chain?.length ?? 0) - 1; i >= 0; i--) {
    running *= Number(chain[i].per || 0)
    out[chain[i].unit] = running
  }
  return out
}

/** base units per 1 of ANY chosen unit (a named chain level OR a same-dim unit). */
export function basePerUnit(item: ChainItem, unit: string): number {
  const lv = levelBaseUnits(item.packChain)
  if (unit in lv) return lv[unit]
  if (dimensionOf(unit) === item.dimension) return getUnitConv(unit)
  // Not resolvable — caller passed a foreign unit. 1 keeps callers total/safe.
  return 1
}

/** THE algorithm — pure, total, branch-free except the explicit pricing mode. */
export function pricePerBaseUnit(item: ChainItem): number {
  const p = item.pricing
  if (p?.mode === 'RATE') {
    const conv = getUnitConv(p.rateUnit)
    return conv > 0 ? Number(p.rate || 0) / conv : 0
  }
  const denom = basePerPurchase(item.packChain)
  return denom > 0 ? Number((p as { purchasePrice?: number })?.purchasePrice || 0) / denom : 0
}

/** Back-compat alias for the deleted column's old meaning at a count unit. */
export const conversionFactor = (item: ChainItem, countUnit = item.countUnit ?? 'each') =>
  basePerUnit(item, countUnit)

export const stockValue = (item: ChainItem) => Number(item.stockOnHand || 0) * pricePerBaseUnit(item)
export const countQty   = (item: ChainItem, countUnit = item.countUnit ?? 'each') =>
  Number(item.stockOnHand || 0) / basePerUnit(item, countUnit)

/** Recipe line cost: qty of `unit` (same dimension) → cost. */
export const lineCost = (item: ChainItem, qty: number, unit: string) =>
  qty * getUnitConv(unit) * pricePerBaseUnit(item)

/** Invariants from the design's Handoff tab. Returns [] when valid. */
export function validateChainItem(item: ChainItem): string[] {
  const errs: string[] = []
  const chain = item.packChain ?? []
  if (chain.length < 1) errs.push('chain must have at least one link')
  if (chain.some((l) => !(Number(l?.per) > 0))) errs.push('every per must be > 0')
  const leaf = chain[chain.length - 1]
  if (leaf && item.dimension !== 'COUNT' && dimensionOf(item.baseUnit) !== (item.dimension === 'MASS' ? 'MASS' : 'VOLUME'))
    errs.push('baseUnit dimension must equal item dimension')
  if (item.countUnit) {
    const lv = levelBaseUnits(chain)
    if (!(item.countUnit in lv) && dimensionOf(item.countUnit) !== item.dimension)
      errs.push('countUnit must be a chain level or a same-dimension unit')
  }
  if (item.pricing?.mode === 'RATE' && dimensionOf(item.pricing.rateUnit) !== item.dimension)
    errs.push('RATE.rateUnit must share the item dimension')
  return errs
}

/** Prisma select fragment every cost reader uses to load pricing facts. */
export const PRICING_SELECT = {
  dimension: true, baseUnit: true, packChain: true, pricing: true, countUnit: true,
} as const

/** Coerce a Prisma row (Json columns may be untyped) into a ChainItem. */
export function asChainItem(row: {
  dimension: string; baseUnit: string; packChain: unknown; pricing: unknown
  countUnit?: string; stockOnHand?: unknown
}): ChainItem {
  return {
    dimension: row.dimension as Dimension,
    baseUnit: row.baseUnit,
    packChain: (row.packChain as PackLink[]) ?? [],
    pricing: (row.pricing as Pricing) ?? { mode: 'PACK', purchasePrice: 0 },
    countUnit: row.countUnit,
    stockOnHand: row.stockOnHand != null ? Number(row.stockOnHand) : 0,
  }
}
```

- [ ] **Step 4: Run the harness — expect ALL PASS**

Run: `npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/test-item-model.ts`
Expected: every line `PASS`, final `ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/item-model.ts scripts/test-item-model.ts
git commit -m "feat(item-model): pure pack-chain pricing engine + test harness"
```

---

## PHASE 1 — Additive schema (new columns alongside old)

> Migrations use the diff/db-execute/resolve workaround — `prisma migrate dev` fails here (P3006 shadow drift; see memory `project_prisma_migrate_shadow_broken`).

### Task 2: Add the new columns (nullable, non-destructive)

**Files:**
- Modify: `prisma/schema.prisma` (InventoryItem)
- Create: `prisma/migrations/<ts>_item_model_add/migration.sql`

- [ ] **Step 1: Edit `prisma/schema.prisma`**

Add the enum near the other enums:

```prisma
enum Dimension { MASS  VOLUME  COUNT }
```

Inside `model InventoryItem`, add (keep ALL existing columns for now):

```prisma
  dimension   Dimension @default(COUNT)
  packChain   Json      @default("[]")
  pricing     Json      @default("{\"mode\":\"PACK\",\"purchasePrice\":0}")
  countUnit   String    @default("each")
```

(`baseUnit` and `stockOnHand` already exist and are reused as-is.)

- [ ] **Step 2: Generate the migration SQL without applying via dev**

Run:
```bash
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > /tmp/item_add.sql
```
Inspect `/tmp/item_add.sql`: it must be `ALTER TABLE ... ADD COLUMN` + `CREATE TYPE "Dimension"` only — **no DROP**. If any DROP appears, stop and re-derive.

- [ ] **Step 3: Apply to the dev DB and record the migration**

```bash
mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_item_model_add
# move /tmp/item_add.sql into that dir as migration.sql, then:
npx prisma db execute --file prisma/migrations/<dir>/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied <dir>
npx prisma generate
```

- [ ] **Step 4: Verify the client compiles**

Run: `npm run build`
Expected: build succeeds; `InventoryItem` now exposes `dimension/packChain/pricing/countUnit` alongside the legacy fields.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(item-model): additive schema — dimension/packChain/pricing/countUnit"
```

---

## PHASE 2 — Deterministic backfill + parity proof

### Task 3: Write the backfill script

**Files:**
- Create: `scripts/backfill-item-model.ts`

Algorithm per item: derive `dimension` from the current `baseUnit` (SI-forced), build `packChain` from the legacy pack fields, set `pricing` from `priceType`, set `countUnit` from `countUOM`. Reconstruct the chain so that `basePerPurchase(chain)` equals the legacy denominator — i.e. `pricePerBaseUnit(item)` reproduces the stored `pricePerBaseUnit` within tolerance.

- [ ] **Step 1: Implement `scripts/backfill-item-model.ts`**

```ts
// One-time backfill: legacy pricing fields → packChain/pricing/dimension/countUnit.
// Reproduces today's pricePerBaseUnit exactly (chain denominator = legacy divisor).
// Prints a dry-run plan; pass APPLY=1 to write. Flags ambiguous rows needsReview.
// Run: APPLY=1 npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-item-model.ts
import { prisma } from '../src/lib/prisma'
import { getUnitConv, isMeasuredUnit } from '../src/lib/utils'
import { pricePerBaseUnit, dimensionOf, type PackLink, type Pricing, type Dimension } from '../src/lib/item-model'

const APPLY = process.env.APPLY === '1'

function dimensionFromBase(baseUnit: string): Dimension {
  return dimensionOf(baseUnit)   // 'g'→MASS, 'ml'→VOLUME, 'each'→COUNT
}

/** Build chain + pricing reproducing the legacy divisor exactly. */
function toChain(it: any): { chain: PackLink[]; pricing: Pricing; dimension: Dimension; baseUnit: string; review: boolean } {
  const dimension = dimensionFromBase(it.baseUnit)
  const baseUnit = dimension === 'MASS' ? 'g' : dimension === 'VOLUME' ? 'ml' : 'each'
  const price = Number(it.purchasePrice)
  const qtyPer = Number(it.qtyPerPurchaseUnit) || 1
  const packSize = Number(it.packSize) || 1
  const packConv = getUnitConv(it.packUOM)        // base units per packUOM
  const top = it.purchaseUnit || 'case'

  // RATE (catchweight / per-weight): priceType UOM.
  if (it.priceType === 'UOM') {
    const rateUnit = isMeasuredUnit(it.packUOM) ? it.packUOM : (dimension === 'MASS' ? 'kg' : dimension === 'VOLUME' ? 'l' : 'each')
    // single nominal level for counting cases only; per = legacy nominal base content
    const chain: PackLink[] = [{ unit: top, per: qtyPer * packSize * packConv || 1 }]
    return { chain, pricing: { mode: 'RATE', rate: price, rateUnit }, dimension, baseUnit, review: false }
  }

  // PACK: reconstruct the divisor branch used by calcPricePerBaseUnit.
  let chain: PackLink[]
  let review = false
  if (isMeasuredUnit(it.qtyUOM)) {
    // weight/volume qty: divisor = qtyPer * conv(qtyUOM). One level, leaf in base.
    chain = [{ unit: top, per: qtyPer * getUnitConv(it.qtyUOM) }]
  } else if (it.qtyUOM === 'pack' && it.innerQty != null) {
    // divisor = qtyPer * innerQty * packSize * conv(packUOM)
    chain = [
      { unit: top, per: qtyPer },
      { unit: 'pack', per: Number(it.innerQty) },
      { unit: 'each', per: packSize * packConv },
    ]
  } else {
    // divisor = qtyPer * packSize * conv(packUOM)
    chain = [
      { unit: top, per: qtyPer },
      { unit: 'each', per: packSize * packConv },
    ]
  }
  if (chain.some((l) => !(l.per > 0))) review = true
  return { chain, pricing: { mode: 'PACK', purchasePrice: price }, dimension, baseUnit, review }
}

async function main() {
  const items = await prisma.inventoryItem.findMany()
  let drift = 0, flagged = 0
  for (const it of items) {
    const { chain, pricing, dimension, baseUnit, review } = toChain(it)
    const countUnit = it.countUOM || 'each'
    const newPpb = pricePerBaseUnit({ dimension, baseUnit, packChain: chain, pricing, countUnit })
    const oldPpb = Number(it.pricePerBaseUnit)
    const ok = oldPpb === 0 || Math.abs(newPpb - oldPpb) <= Math.max(1e-9, oldPpb * 1e-4)
    if (!ok) { drift++; console.log(`DRIFT ${it.itemName}: old=${oldPpb} new=${newPpb}`) }
    const needsReview = it.needsReview || review || !ok
    if (needsReview) flagged++
    if (APPLY) {
      await prisma.inventoryItem.update({
        where: { id: it.id },
        data: { dimension, baseUnit, packChain: chain as any, pricing: pricing as any, countUnit, needsReview },
      })
    }
  }
  console.log(`\n${items.length} items · ${drift} drift · ${flagged} flagged needsReview · ${APPLY ? 'APPLIED' : 'DRY RUN'}`)
  await prisma.$disconnect()
}
main()
```

- [ ] **Step 2: Dry-run and inspect drift**

Run: `npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-item-model.ts`
Expected: `N items · 0 drift · K flagged · DRY RUN`. **If drift > 0**, read each `DRIFT` line — the legacy reconstruction missed a branch (likely a non-SI `baseUnit` row or a `totalQty`-priced invoice item). Fix `toChain` until drift is 0 (the parity invariant is non-negotiable; recipe costs must not move).

- [ ] **Step 3: Apply**

Run: `APPLY=1 npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-item-model.ts`
Expected: `... APPLIED`, flagged count printed.

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-item-model.ts
git commit -m "feat(item-model): deterministic legacy→chain backfill (parity-preserving)"
```

### Task 4: Parity verifier (chain vs legacy ppb across all items)

**Files:**
- Create: `scripts/verify-item-model-parity.ts`

- [ ] **Step 1: Implement the verifier**

```ts
// Reads every item, asserts pricePerBaseUnit(chain) == stored legacy ppb within 0.01%.
// Run: npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/verify-item-model-parity.ts
import { prisma } from '../src/lib/prisma'
import { pricePerBaseUnit, asChainItem } from '../src/lib/item-model'

async function main() {
  const items = await prisma.inventoryItem.findMany()
  let bad = 0
  for (const it of items) {
    const newPpb = pricePerBaseUnit(asChainItem(it as any))
    const oldPpb = Number(it.pricePerBaseUnit)
    if (oldPpb > 0 && Math.abs(newPpb - oldPpb) > oldPpb * 1e-4) {
      bad++; console.log(`MISMATCH ${it.itemName}: chain=${newPpb} legacy=${oldPpb}`)
    }
  }
  console.log(bad === 0 ? `OK — ${items.length} items match` : `${bad} mismatches`)
  await prisma.$disconnect(); process.exit(bad === 0 ? 0 : 1)
}
main()
```

- [ ] **Step 2: Run — expect OK / 0 mismatches**

Run: `npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/verify-item-model-parity.ts`
Expected: `OK — N items match`, exit 0. This is the gate before switching any reader.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-item-model-parity.ts
git commit -m "test(item-model): cross-DB parity verifier (chain == legacy ppb)"
```

---

## PHASE 3 — Switch the WRITERS to emit chains

> After this phase every new/edited item carries a correct `packChain`/`pricing`. The legacy columns are still written too (dual-write) so unmigrated readers keep working until Phase 4.

### Task 5: Inventory create (POST) writes a chain

**Files:**
- Modify: `src/app/api/inventory/route.ts:140-186`

- [ ] **Step 1: Add a shared form→chain helper**

Create `src/lib/item-model-form.ts`:

```ts
import { getUnitConv, isMeasuredUnit } from './utils'
import { dimensionOf, type PackLink, type Pricing, type Dimension } from './item-model'

export interface ItemFormInput {
  purchaseUnit: string
  purchasePrice: number
  qtyPerPurchaseUnit: number
  qtyUOM: string
  innerQty: number | null
  packSize: number
  packUOM: string
  priceType: 'CASE' | 'UOM'
  countUOM: string
}

/** Build chain/pricing/dimension/baseUnit/countUnit from the legacy form shape.
 *  Single source of truth shared by create, update, import, and the form preview. */
export function formToChain(f: ItemFormInput): {
  dimension: Dimension; baseUnit: string; packChain: PackLink[]; pricing: Pricing; countUnit: string
} {
  // dimension from whichever field carries a measured unit, else COUNT
  const measured = isMeasuredUnit(f.qtyUOM) ? f.qtyUOM : isMeasuredUnit(f.packUOM) ? f.packUOM : null
  const dimension: Dimension = measured ? dimensionOf(measured) : 'COUNT'
  const baseUnit = dimension === 'MASS' ? 'g' : dimension === 'VOLUME' ? 'ml' : 'each'
  const top = f.purchaseUnit || 'case'
  const packConv = getUnitConv(f.packUOM)

  if (f.priceType === 'UOM') {
    const rateUnit = isMeasuredUnit(f.packUOM) ? f.packUOM : dimension === 'MASS' ? 'kg' : dimension === 'VOLUME' ? 'l' : 'each'
    return {
      dimension, baseUnit, countUnit: f.countUOM || 'each',
      packChain: [{ unit: top, per: (f.qtyPerPurchaseUnit || 1) * (f.packSize || 1) * packConv || 1 }],
      pricing: { mode: 'RATE', rate: f.purchasePrice, rateUnit },
    }
  }
  let packChain: PackLink[]
  if (isMeasuredUnit(f.qtyUOM)) {
    packChain = [{ unit: top, per: f.qtyPerPurchaseUnit * getUnitConv(f.qtyUOM) }]
  } else if (f.qtyUOM === 'pack' && f.innerQty != null) {
    packChain = [
      { unit: top, per: f.qtyPerPurchaseUnit },
      { unit: 'pack', per: f.innerQty },
      { unit: 'each', per: f.packSize * packConv },
    ]
  } else {
    packChain = [
      { unit: top, per: f.qtyPerPurchaseUnit },
      { unit: 'each', per: f.packSize * packConv },
    ]
  }
  return { dimension, baseUnit, packChain, pricing: { mode: 'PACK', purchasePrice: f.purchasePrice }, countUnit: f.countUOM || 'each' }
}
```

- [ ] **Step 2: Use it in the POST handler**

In `src/app/api/inventory/route.ts`, after the existing legacy field parsing (keep it for dual-write), build the chain and add it to the create `data`:

```ts
import { formToChain } from '@/lib/item-model-form'
// ...inside POST, after pt/cu/ps/pu/qu/iq are computed:
const chain = formToChain({
  purchaseUnit: rest.purchaseUnit ?? 'each', purchasePrice: pp,
  qtyPerPurchaseUnit: qty, qtyUOM: qu, innerQty: iq, packSize: ps, packUOM: pu,
  priceType: pt, countUOM: cu,
})
const item = await prisma.inventoryItem.create({
  data: {
    ...rest,
    // legacy dual-write (unchanged):
    purchasePrice: pp, qtyPerPurchaseUnit: qty, packSize: ps, packUOM: pu,
    countUOM: cu, qtyUOM: qu, innerQty: iq, priceType: pt,
    conversionFactor, pricePerBaseUnit, baseUnit,
    // new chain:
    dimension: chain.dimension, packChain: chain.packChain as any,
    pricing: chain.pricing as any, countUnit: chain.countUnit,
    supplierId: supplierId || null, storageAreaId: storageAreaId || null,
  },
  include: { supplier: true, storageArea: true },
})
```

- [ ] **Step 3: Build + manual parity for one created item**

Run: `npm run build` → succeeds.
Then create a test item via the dev UI and run `scripts/verify-item-model-parity.ts` → `OK`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/item-model-form.ts src/app/api/inventory/route.ts
git commit -m "feat(item-model): inventory create dual-writes packChain/pricing"
```

### Task 6: Inventory update (PUT) writes a chain

**Files:**
- Modify: `src/app/api/inventory/[id]/route.ts:77-96`

- [ ] **Step 1: Build the chain in PUT**

Mirror Task 5: call `formToChain(...)` from the parsed PUT body and add `dimension/packChain/pricing/countUnit` to the update `data` alongside the existing legacy writes. Keep `needsReview: false` on edit (a human-confirmed chain is trusted).

- [ ] **Step 2: Build + verify**

Run: `npm run build`; edit an item in the UI; run parity verifier → `OK`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/inventory/[id]/route.ts
git commit -m "feat(item-model): inventory update dual-writes packChain/pricing"
```

### Task 7: Invoice approve writes a chain (UPDATE_PRICE + CREATE_NEW)

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts` (UPDATE_PRICE ~174-180; CREATE_NEW ~284-301)

- [ ] **Step 1: CREATE_NEW path → chain**

Where a new item is created (`calcPricePerBaseUnit` at ~283, create at ~289-301), also compute and store the chain via `formToChain` using the invoice's resolved pack fields (`qtyPerPurchaseUnit`, `packSize`, `packUOM`, derived `priceType`). Keep legacy fields dual-written.

- [ ] **Step 2: UPDATE_PRICE path → re-derive chain when format or price changes**

At ~174-180, when an existing item's price/format updates: rebuild `pricing` from the approved price (PACK `purchasePrice` or RATE `rate`/`rateUnit` per `derivePricingMode`), and rebuild `packChain` **only when `useInvoicePack` is true** (the existing consent gate — never silently overwrite a format). When `useInvoicePack` is false, keep the existing `packChain` and update only `pricing`. This preserves the `applyInvoiceFormat` consent semantics (memory `project_invoice_impose_format`).

- [ ] **Step 3: Build + approve a real invoice in dev, verify parity**

Run: `npm run build`; approve a session in the dev UI; run parity verifier → `OK`; spot-check the matched item's recipe cost is unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/invoices/sessions/[id]/approve/route.ts
git commit -m "feat(item-model): invoice approve writes packChain/pricing (consent-gated format)"
```

### Task 8: CSV import + Sysco catalog write chains

**Files:**
- Modify: `src/lib/inventory-import.ts:150-179` (`mapRowToPayload`)
- Modify: `src/app/api/inventory/import/route.ts:52`
- Modify: `scripts/import-sysco-catalog.ts:~407`

- [ ] **Step 1: Add chain to the import payload**

In `mapRowToPayload`, after computing the legacy fields, call `formToChain` and include `dimension/packChain/pricing/countUnit` in the returned payload; ensure `import/route.ts` passes them through to `create`.

- [ ] **Step 2: Build + import the verify fixture**

Run: `npm run build`; `npx ts-node ... scripts/verify-inventory-import.ts`; then parity verifier → `OK`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/inventory-import.ts src/app/api/inventory/import/route.ts scripts/import-sysco-catalog.ts
git commit -m "feat(item-model): CSV + Sysco imports write packChain/pricing"
```

### Task 9: PREP sync writes a chain (`syncPrepToInventory`)

**Files:**
- Modify: `src/lib/recipeCosts.ts:245-285` (`syncPrepToInventory`)

A PREP output item's cost is `recipe.totalCost / baseYieldQty`. Represent it as a one-link PACK chain so `pricePerBaseUnit` reproduces that exactly.

- [ ] **Step 1: Write the PREP chain**

In `syncPrepToInventory`, alongside the existing `pricePerBaseUnit`/`conversionFactor`/`baseUnit` writes, add:

```ts
import { dimensionOf } from './item-model'
// yieldUnit is the recipe's base yield unit (e.g. 'g','ml','each'); baseYieldQty is total base yield.
const dimension = dimensionOf(yieldUnit)
const baseUnit  = dimension === 'MASS' ? 'g' : dimension === 'VOLUME' ? 'ml' : 'each'
// ppb = totalCost / baseYieldQty  ⟺  PACK price=totalCost over a chain of per=baseYieldQty
const packChain = [{ unit: countUOM || 'batch', per: baseYieldQty }]
const pricing   = { mode: 'PACK' as const, purchasePrice: recipe.totalCost }
// add to the update data:
//   dimension, baseUnit, packChain: packChain as any, pricing: pricing as any, countUnit: countUOM
```

- [ ] **Step 2: Build + edit a PREP recipe, verify nested cost unchanged**

Run: `npm run build`; edit a PREP recipe in dev; run parity verifier → `OK`; confirm a MENU recipe using that PREP shows the same cost as before (guards memory `project_nested_prep_cost_bug`).

- [ ] **Step 3: Commit**

```bash
git add src/lib/recipeCosts.ts
git commit -m "feat(item-model): PREP sync writes a one-link PACK chain"
```

### Task 10: Legacy invoice process + repair-prices

**Files:**
- Modify: `src/app/api/invoices/[id]/process/route.ts:20-32`
- Modify: `src/app/api/inventory/repair-prices/route.ts`

- [ ] **Step 1: process route** — when it updates `pricePerBaseUnit`, also update `pricing` (RATE or PACK) to match; keep `packChain` untouched (price-only update).

- [ ] **Step 2: repair-prices** — convert to a no-op that returns a deprecation notice, OR have it rewrite `pricing.purchasePrice`/`pricing.rate` from the chain rather than the cached column. Simplest: return `{ deprecated: true }` (corruption is now structurally impossible; this admin tool is obsolete).

- [ ] **Step 3: Build + commit**

```bash
npm run build
git add src/app/api/invoices/[id]/process/route.ts src/app/api/inventory/repair-prices/route.ts
git commit -m "feat(item-model): align legacy process writer; retire repair-prices"
```

---

## PHASE 4 — Switch the READERS to compute on read

> Gate: parity verifier must print `OK` before starting. Each reader stops reading the `pricePerBaseUnit` / `conversionFactor` columns and computes from the chain.

### Task 11: The two costing libs (highest-traffic readers)

**Files:**
- Modify: `src/lib/recipeCosts.ts` (read sites ~82-117, ~158-163, ~175-180)
- Modify: `src/lib/count-expected.ts` (reads `baseUnit`; ppb consumed by cost-chrome/reports)

- [ ] **Step 1: `recipeCosts.ts` — compute ppb from the chain**

Replace `pricePerBaseUnit = Number(ing.inventoryItem.pricePerBaseUnit)` with a call to `pricePerBaseUnit(asChainItem(ing.inventoryItem))`, and update every Prisma `select`/`include` that requested `pricePerBaseUnit` to request `...PRICING_SELECT` instead (still keep `baseUnit` — used by `convertQty`). The `lineCost = convertQty(qty, unit, baseUnit) × ppb` shape is unchanged.

```ts
import { pricePerBaseUnit, asChainItem, PRICING_SELECT } from './item-model'
// select: { itemName: true, ...PRICING_SELECT, allergens: true }
// ppb:    pricePerBaseUnit(asChainItem(ing.inventoryItem))
```

- [ ] **Step 2: `count-expected.ts`** — it already reads only `baseUnit` for `convertQty`; leave those. Where downstream callers (cost-chrome) multiply theoretical qty × ppb, they switch in Task 12.

- [ ] **Step 3: Build + verify a recipe cost matches pre-change**

Run: `npm run build`; open a MENU recipe in dev, confirm `costPerPortion` is identical to a value recorded before the change (use the parity verifier's item ppb × known qty as the oracle).

- [ ] **Step 4: Commit**

```bash
git add src/lib/recipeCosts.ts src/lib/count-expected.ts
git commit -m "refactor(item-model): recipe costing computes ppb from the chain"
```

### Task 12: Mechanical reader sweep (all remaining ppb/conversionFactor reads)

**The recipe (apply to every file below):**
1. In each Prisma query, replace `pricePerBaseUnit: true` (and `conversionFactor: true`) in `select` with `...PRICING_SELECT` (import from `@/lib/item-model`). Keep `baseUnit`/`stockOnHand` selects.
2. Replace each in-memory read `Number(x.pricePerBaseUnit)` with `pricePerBaseUnit(asChainItem(x))`.
3. Replace each `Number(x.conversionFactor)` with `basePerUnit(asChainItem(x), x.countUnit)`.
4. `npm run build` after each file; commit in small batches by feature area.

**Files (grouped — each is a checkbox):**

- [ ] **Cost chrome / spine audit** — `src/app/api/insights/cost-chrome/route.ts:53,122,130-135`; `src/app/api/insights/spine-audit/route.ts:35,62,74,110`. (Spine audit's "recent writers" view loses meaning once the column is gone — repoint it to show items missing a valid chain via `validateChainItem`, or simplify to a data-quality list.)
- [ ] **Count** — `src/lib/count-finalize.ts:73`; `src/app/api/count/areas/route.ts:20,38`.
- [ ] **Reports** — `src/app/api/reports/theoretical-usage/route.ts:37-41,56,62,82,86,157,167`; `reports/inventory-efficiency/route.ts:26`; `reports/analytics/route.ts:59`; `reports/dashboard/route.ts:31,72`; `reports/cogs/route.ts` (via theoretical-usage).
- [ ] **Inventory search/export/list** — `src/app/api/search/route.ts:14,24,29`; `src/app/api/inventory/search/route.ts:36,68`; `src/app/api/inventory/export/route.ts:24`; `src/app/inventory/page.tsx:143,550,600` (preview now from `formToChain`+`pricePerBaseUnit`).
- [ ] **Invoices** — `src/lib/invoice-matcher.ts:327-329,359-361,395-397`; `src/lib/invoice/resolution.ts:48-50,66`; `src/app/api/invoices/sessions/route.ts:70`; `sessions/[id]/route.ts:20,187`; `sessions/[id]/scanitems/route.ts:41`; `src/app/api/invoices/alerts/route.ts:10`; `src/components/invoices/v2/InvoiceReviewDrawer.tsx:1454,1470-1473`. (Matcher: ppb is a *scoring signal* — compute it; behaviour identical.)
- [ ] **Prep / suppliers / wastage** — `src/app/api/prep/items/[id]/route.ts:23,32`; `src/components/suppliers/SupplierDetail.tsx`; `src/app/api/wastage/route.ts:36,75` (reads `baseUnit` only — leave).
- [ ] **Digest / chat** — `src/app/api/digest/route.ts:45,64,75`; `src/app/api/chat/route.ts:62,89`.
- [ ] **Components** — `src/components/recipes/shared.tsx:5-6,670-671,729-733,1140`; `src/components/inventory/InventoryItemDrawer.tsx` read sites (the drawer's live preview moves to `formToChain` in Phase 5).

**Per-batch verification:** `npm run build` + load the affected page in dev and confirm the number renders and matches the parity oracle. Commit message per batch, e.g. `refactor(item-model): reports read ppb from chain`.

- [ ] **Final gate:** `grep -rn "pricePerBaseUnit" src/ | grep -v "item-model" | grep -v "InventorySupplierPrice"` returns **only** the new `pricePerBaseUnit(` function calls — no `.pricePerBaseUnit` column reads remain on `InventoryItem`. (Offer reads on `InventorySupplierPrice.pricePerBaseUnit` are out of scope and remain.)

---

## PHASE 5 — Chain-based form UI

### Task 13: Inventory drawer — chain editor replaces the mode switches

**Files:**
- Modify: `src/components/inventory/InventoryItemDrawer.tsx`

Recreate the design's **New builder** + **Drawer** (`builder.jsx`, `builder.jsx` DrawerTab) in our stack: a dimension segmented control, a pack-chain editor (rows of `{unit, per}` with add/remove, leaf suffixed by base unit), a `count unit` select populated from chain levels ∪ dimension units, and a `pricing mode` toggle (PACK → purchase price; RATE → rate + rateUnit). The live preview reads `pricePerBaseUnit(formState)` directly. Match the existing drawer's Tailwind tokens (flat tokens `bg-gold-soft`, `text-red-text` — numbered classes are broken per memory `project_tailwind_color_tokens`).

- [ ] **Step 1: Build the chain-editor sub-component at module scope**

Define `<PackChainEditor value={chain} onChange={...} baseUnit={...} />` at module scope (never inside the drawer body — remount/focus-loss per CLAUDE.md). Rows: text `unit`, number `per`, remove button; an `+ add level` button.

- [ ] **Step 2: Replace the conditional qtyUOM/packUOM/innerQty/priceType block (lines ~480-636)** with: dimension control + `PackChainEditor` + pricing-mode block. Remove `qtyUOM`/`innerQty`/`priceType`/`packUOM` inputs from the form. Save handler PUTs `{ dimension, packChain, pricing, countUnit, stockOnHand, ... }` (no legacy pack fields).

- [ ] **Step 3: Live preview** — replace the lines ~702-749 preview box with `pricePerBaseUnit({ dimension, baseUnit, packChain, pricing })` and `formatPricePerBase`.

- [ ] **Step 4: Build + manually exercise all four fixture shapes**

Run: `npm run build`. In dev, create each of: a simple case (ketchup), weight-per-each (romaine head=250g), 3-level pack (soda), catchweight RATE (ribeye). Confirm each preview ppb matches the engine test values, and the saved item passes the parity verifier.

- [ ] **Step 5: Commit**

```bash
git add src/components/inventory/InventoryItemDrawer.tsx
git commit -m "feat(item-model): chain-editor inventory form (dimension · chain · pricing)"
```

### Task 14: Inventory page inline add form

**Files:**
- Modify: `src/app/inventory/page.tsx`

- [ ] **Step 1** Mirror Task 13 in the inline add form; POST `{ dimension, packChain, pricing, countUnit }`. The mobile/desktop dual-renderer pattern applies — update both blocks (per CLAUDE.md mobile UX).
- [ ] **Step 2** `npm run build`; add an item on mobile + desktop widths via dev; parity verifier `OK`.
- [ ] **Step 3** Commit: `feat(item-model): inline add form uses chain editor`.

---

## PHASE 6 — Drop the cached + legacy columns

> Only after Phases 3–5 are merged and the parity verifier + `npm run build` are green, and the Task 12 final grep gate is clean.

### Task 15: Remove dead writers and helper exports

**Files:**
- Modify: `src/app/api/inventory/route.ts`, `[id]/route.ts`, `approve/route.ts`, `inventory-import.ts` — delete the legacy dual-writes (`pricePerBaseUnit`, `conversionFactor`, `qtyUOM`, `innerQty`, `packSize`, `packUOM`, `priceType`, `qtyPerPurchaseUnit`, `purchaseUnit`, `countUOM`).
- Modify: `src/lib/utils.ts` — delete `calcPricePerBaseUnit`, `calcConversionFactor`, `deriveBaseUnit` (now unused). Keep `getUnitConv`, `getUnitDimension`, `isMeasuredUnit`, `compatibleCountUnits`, `priceDisplayScale`, `formatPricePerBase`.

- [ ] **Step 1** Delete the dead code. Run `grep -rn "calcPricePerBaseUnit\|calcConversionFactor\|deriveBaseUnit" src/ scripts/` — only `scripts/test-pricing-fix.ts` (legacy regression) and `scripts/repair-*.ts` may remain; delete or archive those.
- [ ] **Step 2** `npm run build` — fix any remaining type errors from removed fields.
- [ ] **Step 3** Commit: `refactor(item-model): remove legacy pricing helpers and dual-writes`.

### Task 16: Drop columns from the schema

**Files:**
- Modify: `prisma/schema.prisma` (InventoryItem)
- Create: `prisma/migrations/<ts>_item_model_drop/migration.sql`

- [ ] **Step 1** Remove from `model InventoryItem`: `qtyPerPurchaseUnit`, `qtyUOM`, `innerQty`, `packSize`, `packUOM`, `priceType`, `conversionFactor`, `pricePerBaseUnit`, `purchaseUnit`, `countUOM`. Keep `baseUnit`, `dimension`, `packChain`, `pricing`, `countUnit`, `stockOnHand`, `purchasePrice`? — **purchasePrice moves into `pricing.purchasePrice`; drop the column** only after confirming price-alert/supplier readers use `pricing.purchasePrice` (Task 12 invoices batch). Keep `needsReview` (still used by the backfill review queue).
- [ ] **Step 2** Derive the drop SQL with `prisma migrate diff` (same workaround as Task 2); **inspect for an accidental data-loss DROP on the wrong column**; apply via `db execute` + `migrate resolve`.
- [ ] **Step 3** `npx prisma generate` + `npm run build` → green.
- [ ] **Step 4** Run parity verifier? — it reads `it.pricePerBaseUnit` which no longer exists; **update it to compare against a pre-drop snapshot JSON** captured before this task, or retire it (its job is done once columns are gone). Capture the snapshot first: a tiny script dumping `{id, ppb}` to `/tmp/ppb-snapshot.json` before Step 2, then compare after.
- [ ] **Step 5** Commit: `feat(item-model): drop cached + legacy pricing columns`.

### Task 17: Retire obsolete repair/audit scripts

**Files:**
- Delete/archive: `scripts/repair-pricing-corruption.ts`, `scripts/repair-baseunit-normalize.ts`, `scripts/repair-count-baseunit.ts`, `scripts/repair-count-uom.ts`, `scripts/normalize-stored-uom.ts`, `scripts/test-pricing-fix.ts`, `src/app/api/inventory/repair-prices/route.ts`.

- [ ] **Step 1** `git rm` the scripts the design's Handoff tab marks as retired (corruption is structurally impossible once derivations compute on read). Leave `migrate-allocations-to-base.ts` and stock scripts (unrelated to pricing).
- [ ] **Step 2** `npm run build` → green. Commit: `chore(item-model): retire repair scripts made obsolete by the chain model`.

---

## Self-Review notes (gaps & guards)

- **Parity is the contract.** Phases 3–4 dual-write/compute; the verifier must read `OK` at every gate. Any drift means recipe costs would silently move — never proceed past drift.
- **`InventorySupplierPrice` untouched.** Multi-supplier `ItemOffer[]` is explicitly a follow-up; its `pricePerBaseUnit` column survives and the matcher's offer reads are unchanged. Note this in a `project_item_model_redesign` memory at completion, with the ItemOffer follow-up as `[[item-offers-followup]]`.
- **RC theoretical stock (PR #9) reads `baseUnit` + ppb.** Keeping `baseUnit` and computing ppb from the chain keeps `count-expected.ts`/`cost-chrome` semantics identical; do not touch the RC allocation/transfer math.
- **`stockOnHand` not renamed** — documented as the design's `stockBase` equivalent; count-finalize/stock-allocations stay as-is.
- **pgBouncer:** Json column writes are ORM `update` calls (safe); no raw `$executeRaw` array writes are introduced. Migrations run via the `db execute`/`migrate resolve` workaround, never `migrate dev`.
- **Catchweight already half-done:** today's `priceType: 'UOM'` is RATE semantics; the backfill maps it directly, so no behavioural change for catchweight items beyond the cleaner shape.
```
