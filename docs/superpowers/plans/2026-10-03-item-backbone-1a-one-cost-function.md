# Item backbone — Stage 1a: one cost function — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every server-side reader of an item's cost gets its number from ONE module (`src/lib/cost-basis.ts`) on an explicit basis — `AVG_30D` for recipes/menu/wastage, `LAST` for counts/reports/orders — and a test fails the suite if anyone bypasses it.

**Architecture:** `src/lib/item-model.ts` stays the pure pricing engine (chain → $/base). `src/lib/cost-basis.ts` becomes the only *reader-facing* API: sync `lastCost(row)` / `withLastCost(row)` / `purchaseUnitCost(row)` for rows already loaded with `PRICING_SELECT`, and async batched `itemCosts(ids, basis)` / `itemCost(id, basis)` that load what they need. All ~30 route/lib readers switch to it. The LAST basis is numerically identical to today's direct engine call, so no count, report or order number moves; only two behaviours change on purpose — wastage is costed on the 30-day average, and the invoice matcher's "was" price no longer falls back to the stale `purchasePrice` column.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma, vitest (`npm test`), `npm run build` as the type-check.

**Spec:** `docs/superpowers/specs/2026-10-03-item-backbone-design.md` §2.1, §2.2, §2.5 (the `purchasePrice` column itself, `supplierId`, `offer.lastPrice`, the offer FK migration and the bridged stock maths are Stages 1b–1d, separate plans).

## Global Constraints

- Branch off `origin/main` (local `main` is 21 commits behind and dirty — do not build on it). Branch name `feat/one-cost-function`. One PR, squash-merged.
- `node`/`npm` are not on the sandbox PATH: prefix every command with `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" &&` (Bash calls need `dangerouslyDisableSandbox: true`). Run `npx prisma generate` once before the first build.
- `npm run build` is the correctness check; never run it while a preview dev server is serving from the same checkout.
- No new stored cost anywhere. Nothing in this plan writes to the live database. The parity script is read-only.
- Prisma `Decimal` values arrive as strings in JSON — wrap with `Number()`.
- No migration in this plan.
- Allowed direct importers of `pricePerBaseUnit` / `withPpb` / `lineCost` / `stockValue` from `item-model` after this plan: `src/lib/item-model.ts`, `src/lib/cost-basis.ts`, `src/lib/offer-price.ts`, `src/lib/primary-offer.ts`, `src/lib/supplier-offers.ts`, `src/lib/item-model-form.ts`, `src/lib/inventory-import.ts`, everything under `src/lib/invoice/`, and test files. Everything else under `src/app/api/**` and `src/lib/**` must go through `cost-basis`.

---

### Task 1: The reader API in `cost-basis.ts`

**Files:**
- Modify: `src/lib/cost-basis.ts`
- Test: `src/lib/__tests__/cost-basis.test.ts`

**Interfaces:**
- Consumes: `pricePerBaseUnit`, `asChainItem`, `basePerPurchase`, `withPpb`, `PRICING_SELECT` from `@/lib/item-model`; existing `windowedAvgCost`, `foldCostBasis`, `ItemCostBasis`.
- Produces (every later task relies on these exact names):
  ```ts
  export type ChainRow = Parameters<typeof asChainItem>[0]
  export function lastCost(row: ChainRow): number
  export function withLastCost<T extends ChainRow>(row: T): T & { pricePerBaseUnit: number }
  export function purchaseUnitCost(row: ChainRow): number
  export async function itemCosts(itemIds: string[], basis: CostBasis, asOf?: Date): Promise<Map<string, ItemCostBasis>>
  export async function itemCost(itemId: string, basis: CostBasis, asOf?: Date): Promise<ItemCostBasis | null>
  // ItemCostBasis.fallbackReason gains 'prep-linked'
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/__tests__/cost-basis.test.ts` (the file already mocks `@/lib/prisma` as `{ prisma: {} }` on line 2 — replace that line with the richer mock below so `itemCosts` can run):

```ts
// replace line 2:  vi.mock('@/lib/prisma', () => ({ prisma: {} }))
const db = { inventoryItem: { findMany: vi.fn() }, invoiceScanItem: { findMany: vi.fn() } }
vi.mock('@/lib/prisma', () => ({ prisma: db }))
```

and add at the end of the file:

```ts
import { lastCost, withLastCost, purchaseUnitCost, itemCosts, itemCost } from '@/lib/cost-basis'

// Butter: 1 case = 11,350 g at $142.50 → $0.012555…/g
const BUTTER = {
  id: 'i1', dimension: 'MASS', baseUnit: 'g', countUnit: 'case',
  packChain: [{ unit: 'case', per: 11350 }], pricing: { mode: 'PACK', purchasePrice: 142.5 },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null, recipe: null,
}
// Salmon: priced $28.60/kg, chain 1 lb = 453.6 g (purchase unit is a pound)
const SALMON = {
  id: 'i2', dimension: 'MASS', baseUnit: 'g', countUnit: 'lb',
  packChain: [{ unit: 'lb', per: 453.6 }], pricing: { mode: 'RATE', rate: 28.6, rateUnit: 'kg' },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null, recipe: null,
}

describe('lastCost / withLastCost', () => {
  it('lastCost is the primary chain price per base unit', () => {
    expect(lastCost(BUTTER)).toBeCloseTo(142.5 / 11350, 9)
    expect(lastCost(SALMON)).toBeCloseTo(28.6 / 1000, 9)
  })
  it('withLastCost attaches pricePerBaseUnit and keeps every other field', () => {
    const out = withLastCost(BUTTER)
    expect(out.pricePerBaseUnit).toBeCloseTo(142.5 / 11350, 9)
    expect(out.packChain).toBe(BUTTER.packChain)
  })
})

describe('purchaseUnitCost — the price of ONE top-of-chain unit', () => {
  it('PACK: the box price', () => {
    expect(purchaseUnitCost(BUTTER)).toBeCloseTo(142.5, 9)
  })
  it('RATE: rate × base units in one purchase unit (a pound of $28.60/kg salmon is $12.97, not $28.60)', () => {
    expect(purchaseUnitCost(SALMON)).toBeCloseTo(28.6 * 0.4536, 6)
  })
})

describe('itemCosts / itemCost', () => {
  beforeEach(() => { db.inventoryItem.findMany.mockReset(); db.invoiceScanItem.findMany.mockReset() })

  it('LAST: one findMany, every id priced from its chain', async () => {
    db.inventoryItem.findMany.mockResolvedValueOnce([BUTTER, SALMON])
    const m = await itemCosts(['i1', 'i2'], 'LAST')
    expect(m.get('i1')).toEqual({ basis: 'LAST', pricePerBase: lastCost(BUTTER) })
    expect(m.get('i2')).toEqual({ basis: 'LAST', pricePerBase: lastCost(SALMON) })
    expect(db.invoiceScanItem.findMany).not.toHaveBeenCalled()
  })

  it('AVG_30D: averages receipts in the window and falls back to LAST with reason prep-linked for a prep output', async () => {
    const PREP = { ...SALMON, id: 'p1', recipe: { id: 'r1' } }
    // windowedAvgCost: items (recipe: null) then lines; the fill-in query for prep-linked ids
    db.inventoryItem.findMany
      .mockResolvedValueOnce([BUTTER])                 // windowedAvgCost items (recipe: null)
      .mockResolvedValueOnce([PREP])                   // fill-in for ids it did not return
    db.invoiceScanItem.findMany.mockResolvedValueOnce([
      { matchedItemId: 'i1', rawLineTotal: '100', receivedQtyBase: '10000' },  // $0.01/g
    ])
    const m = await itemCosts(['i1', 'p1'], 'AVG_30D')
    expect(m.get('i1')).toMatchObject({ basis: 'AVG_30D', pricePerBase: 0.01 })
    expect(m.get('p1')).toEqual({ basis: 'LAST', pricePerBase: lastCost(PREP), fallbackReason: 'prep-linked' })
  })

  it('itemCost returns null for an unknown id', async () => {
    db.inventoryItem.findMany.mockResolvedValueOnce([])
    expect(await itemCost('nope', 'LAST')).toBeNull()
  })
})
```

Also add `beforeEach` to the vitest import on line 1: `import { describe, it, expect, vi, beforeEach } from 'vitest'`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/cost-basis.test.ts`
Expected: FAIL — `lastCost` is not exported (the existing `foldCostBasis`/`costWindow` cases still pass).

- [ ] **Step 3: Implement**

In `src/lib/cost-basis.ts`:

Change the import on line 8 to:
```ts
import { PRICING_SELECT, asChainItem, pricePerBaseUnit, basePerPurchase, withPpb } from '@/lib/item-model'
```

Change the `fallbackReason` line in `ItemCostBasis` to:
```ts
  /** Why an item is NOT on the average. */
  fallbackReason?: 'no-purchases' | 'implausible' | 'prep-linked'
```

Replace the file-header comment (lines 1–6) with:
```ts
// THE reader-facing cost API. Every route and lib that needs "what does a base
// unit of this item cost" imports from HERE, on an explicit basis:
//   LAST    — the primary supplier's last price, derived from the item's
//             packChain + pricing (numerically the engine's pricePerBaseUnit).
//             Counts, stock value, COGS, variance, theoretical usage, orders.
//   AVG_30D — Σ line total ÷ Σ frozen receivedQtyBase over the approved invoice
//             lines of the last COST_WINDOW_DAYS, pooled across every supplier.
//             Recipes, menu, wastage. Falls back to LAST, labelled.
// Nothing here is stored (a cached cost is the divergence class the spine was
// cleaned of). `src/lib/item-model.ts` stays the pure engine; the gate test
// `src/lib/__tests__/cost-readers-gate.test.ts` keeps readers out of it.
```

Append at the end of the file:
```ts
/** A Prisma row loaded with `...PRICING_SELECT` (plus whatever else the caller selected). */
export type ChainRow = Parameters<typeof asChainItem>[0]

/** LAST basis, synchronous: the primary chain's $/base for a row already in hand. */
export function lastCost(row: ChainRow): number {
  return pricePerBaseUnit(asChainItem(row))
}

/** Attach a computed `pricePerBaseUnit` (LAST) for API responses that still expose the field. */
export function withLastCost<T extends ChainRow>(row: T): T & { pricePerBaseUnit: number } {
  return withPpb(row)
}

/**
 * LAST basis price of ONE top-of-chain (purchase) unit — the box price for a
 * PACK item; for a RATE item the rate × the base units one purchase unit holds
 * (a pound of $28.60/kg salmon is $12.97). Replaces every read of the legacy
 * `purchasePrice` column, which held the RATE itself for weight-priced items.
 */
export function purchaseUnitCost(row: ChainRow): number {
  const chain = asChainItem(row)
  return lastCost(row) * basePerPurchase(chain.packChain)
}

/** Batched: one cost per id on `basis`. Unknown ids are simply absent. */
export async function itemCosts(itemIds: string[], basis: CostBasis, asOf: Date = new Date()): Promise<Map<string, ItemCostBasis>> {
  const ids = Array.from(new Set(itemIds))
  if (ids.length === 0) return new Map()
  if (basis === 'LAST') {
    const rows = await prisma.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true, ...PRICING_SELECT } })
    return new Map(rows.map((r) => [r.id, { basis: 'LAST' as const, pricePerBase: lastCost(r) }]))
  }
  const out = await windowedAvgCost(ids, asOf)
  // windowedAvgCost never averages a PREP output (its cost is the recipe's);
  // those ids come back on LAST, labelled, so a caller always gets an entry.
  const missing = ids.filter((id) => !out.has(id))
  if (missing.length > 0) {
    const rows = await prisma.inventoryItem.findMany({ where: { id: { in: missing } }, select: { id: true, ...PRICING_SELECT } })
    for (const r of rows) out.set(r.id, { basis: 'LAST', pricePerBase: lastCost(r), fallbackReason: 'prep-linked' })
  }
  return out
}

/** One item on `basis`; null when the id does not exist. */
export async function itemCost(itemId: string, basis: CostBasis, asOf: Date = new Date()): Promise<ItemCostBasis | null> {
  return (await itemCosts([itemId], basis, asOf)).get(itemId) ?? null
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/__tests__/cost-basis.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Check nothing switches exhaustively on `fallbackReason`**

Run: `grep -rn "fallbackReason" src --include='*.ts' --include='*.tsx' | grep -v __tests__`
Expected: only reads/labels (e.g. in recipe UI). If any `switch` on it has no `default`, add `case 'prep-linked':` with the same copy as `'no-purchases'`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/cost-basis.ts src/lib/__tests__/cost-basis.test.ts
git commit -m "feat(cost): one reader API — lastCost, purchaseUnitCost, itemCosts on an explicit basis"
```

---

### Task 2: Parity script (read-only, run against the live database)

**Files:**
- Create: `scripts/verify-cost-parity.ts`

**Interfaces:**
- Consumes: `itemCosts` (Task 1); `pricePerBaseUnit`, `asChainItem`, `PRICING_SELECT` from `item-model`.
- Produces: a console line `OK — <n> items match (LAST); <m> on the 30-day average` and exit code 0, or `FAIL — <k> mismatches` and exit 1. Task 7 reruns it.

- [ ] **Step 1: Write the script**

```ts
// Read-only parity check for the one-cost-function migration.
// For every active item: the LAST basis through the reader API must equal the
// engine's direct pricePerBaseUnit(asChainItem(row)) EXACTLY. Also reports how
// many items currently cost on the 30-day average (information only).
//
// Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/verify-cost-parity.ts
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '../src/lib/item-model'
import { itemCosts } from '../src/lib/cost-basis'

async function main() {
  const rows = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: { id: true, itemName: true, ...PRICING_SELECT },
  })
  const ids = rows.map((r) => r.id)
  const last = await itemCosts(ids, 'LAST')
  const avg = await itemCosts(ids, 'AVG_30D')

  let bad = 0
  for (const r of rows) {
    const direct = pricePerBaseUnit(asChainItem(r))
    const viaLib = last.get(r.id)?.pricePerBase
    if (viaLib !== direct) {
      bad++
      console.log(`MISMATCH ${r.id} ${r.itemName}: engine=${direct} lib=${viaLib}`)
    }
    if (!avg.has(r.id)) { bad++; console.log(`MISSING AVG entry ${r.id} ${r.itemName}`) }
  }
  const onAvg = Array.from(avg.values()).filter((b) => b.basis === 'AVG_30D').length
  console.log(bad === 0
    ? `OK — ${rows.length} items match (LAST); ${onAvg} on the 30-day average`
    : `FAIL — ${bad} mismatches`)
  await prisma.$disconnect()
  if (bad > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Run it**

Run: `TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/verify-cost-parity.ts`
(If `tsconfig-paths` is not resolvable, run `npx tsx scripts/verify-cost-parity.ts` instead — the repair scripts use that runner.)
Expected: `OK — 468 items match (LAST); <m> on the 30-day average` (468 was the active count on 2026-10-02; any `OK` line is a pass). Record the printed line in the PR description.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-cost-parity.ts
git commit -m "chore(cost): read-only parity script for the reader API"
```

---

### Task 3: Wastage is costed on the 30-day average

**Files:**
- Modify: `src/app/api/wastage/route.ts` (lines 4, 62–65)
- Create: `src/app/api/wastage/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `itemCost` (Task 1).
- Produces: `WastageLog.costImpact` for new logs = qty in base × AVG_30D $/base (LAST when the item has no qualifying purchases). Historic rows untouched.

- [ ] **Step 1: Write the failing test**

`src/app/api/wastage/__tests__/route.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import type { NextRequest } from 'next/server'

// Butter: 1 case = 11,350 g at $142.50 (LAST = $0.012555/g). One approved receipt in
// the window: $100 for 10,000 g (AVG = $0.01/g). Wasting 500 g must cost $5.00 on the
// average, not $6.28 on the last price.
const ITEM = {
  id: 'i1', itemName: 'Butter', dimension: 'MASS', baseUnit: 'g', countUnit: 'case',
  packChain: [{ unit: 'case', per: 11350 }], pricing: { mode: 'PACK', purchasePrice: 142.5 },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null, recipe: null,
}
const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'w1', ...data, inventoryItem: ITEM }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    inventoryItem: { findUnique: async () => ITEM, findMany: async () => [ITEM] },
    invoiceScanItem: { findMany: async () => [{ matchedItemId: 'i1', rawLineTotal: '100', receivedQtyBase: '10000' }] },
    wastageLog: { create },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: async () => ({ id: 'u1', role: 'STAFF', isActive: true }),
  AuthError: class extends Error { status = 401 },
}))
vi.mock('@/lib/rc-scope', () => ({ scopeWhereFromParams: async () => ({}), assertRcWritable: async () => {} }))
vi.mock('@/lib/theoretical-cache', () => ({ invalidatesTheoretical: (h: unknown) => h }))

const route = await import('@/app/api/wastage/route')

describe('POST /api/wastage', () => {
  it('freezes costImpact on the 30-day average, not the last price', async () => {
    const req = { url: 'http://x/api/wastage', json: async () => ({
      inventoryItemId: 'i1', qtyWasted: '500', unit: 'g', reason: 'SPOILED', revenueCenterId: 'rc1',
    }) } as unknown as NextRequest
    const res = await route.POST(req)
    expect(res.status).toBe(201)
    const data = create.mock.calls[0][0].data
    expect(Number(data.costImpact)).toBeCloseTo(5.0, 6)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/wastage/__tests__/route.test.ts`
Expected: FAIL — `costImpact` ≈ 6.28 (last price).

- [ ] **Step 3: Implement**

In `src/app/api/wastage/route.ts` replace line 4
```ts
import { asChainItem, pricePerBaseUnit } from '@/lib/item-model'
```
with
```ts
import { itemCost } from '@/lib/cost-basis'
```
and replace lines 62–65
```ts
  const item = await prisma.inventoryItem.findUnique({ where: { id: inventoryItemId } })
  const ppbu = item ? pricePerBaseUnit(asChainItem(item)) : 0
  const qtyBase = item ? convertQty(parseFloat(qtyWasted), unit, item.baseUnit) : parseFloat(qtyWasted)
  const costImpact = qtyBase * ppbu
```
with
```ts
  const item = await prisma.inventoryItem.findUnique({ where: { id: inventoryItemId } })
  // Wastage is an expense, costed like a recipe line: what a base unit actually
  // cost us lately (30-day average across suppliers), LAST when nothing was bought.
  const ppbu = item ? (await itemCost(item.id, 'AVG_30D'))?.pricePerBase ?? 0 : 0
  const qtyBase = item ? convertQty(parseFloat(qtyWasted), unit, item.baseUnit) : parseFloat(qtyWasted)
  const costImpact = qtyBase * ppbu
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/app/api/wastage/__tests__/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/wastage/route.ts src/app/api/wastage/__tests__/route.test.ts
git commit -m "feat(wastage): cost a wasted quantity on the 30-day average, like a recipe line"
```

---

### Task 4: The invoice matcher's "was" price never reads the stale column

**Files:**
- Modify: `src/lib/invoice-matcher.ts` (import block line 4; candidate select lines 453–458; `buildMatchResult` lines 331–334)
- Test: `src/lib/__tests__/invoice-matcher-aliases.test.ts`

**Interfaces:**
- Consumes: `purchaseUnitCost` (Task 1).
- Produces: `export function previousPriceFor(offer: { lastPrice?: unknown } | null | undefined, item: ChainRow): number` in `invoice-matcher.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/__tests__/invoice-matcher-aliases.test.ts` (add `previousPriceFor` to the existing import from `@/lib/invoice-matcher`):

```ts
describe('previousPriceFor — the "was" price on a matched line', () => {
  const BUTTER = {
    dimension: 'MASS', baseUnit: 'g', countUnit: 'case',
    packChain: [{ unit: 'case', per: 11350 }], pricing: { mode: 'PACK', purchasePrice: 142.5 },
    eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  }
  it("is this supplier's own last offer price when the offer exists", () => {
    expect(previousPriceFor({ lastPrice: '139.9' }, BUTTER)).toBe(139.9)
  })
  it('falls back to the primary chain purchase-unit price, never a stored column', () => {
    expect(previousPriceFor(null, BUTTER)).toBeCloseTo(142.5, 9)
    expect(previousPriceFor({ lastPrice: null }, BUTTER)).toBeCloseTo(142.5, 9)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/invoice-matcher-aliases.test.ts`
Expected: FAIL — `previousPriceFor` is not exported.

- [ ] **Step 3: Implement**

In `src/lib/invoice-matcher.ts`:

Line 4 becomes:
```ts
import { PRICING_SELECT } from '@/lib/item-model'
import { purchaseUnitCost, type ChainRow } from '@/lib/cost-basis'
```

Add, directly above `function buildMatchResult(` (line 321):
```ts
/**
 * The "was" price shown on a matched line: what THIS supplier charged last time
 * (its offer's lastPrice), else the item's primary chain priced per purchase
 * unit. Never the legacy `purchasePrice` column — it drifts from `pricing`.
 */
export function previousPriceFor(offer: { lastPrice?: unknown } | null | undefined, item: ChainRow): number {
  const offerLast = offer?.lastPrice != null ? Number(offer.lastPrice) : NaN
  return Number.isFinite(offerLast) ? offerLast : purchaseUnitCost(item)
}
```

Replace lines 331–334
```ts
  // "was" price = what THIS supplier charged last time, when known. Falls back
  // to the item's purchase price (single-supplier behaviour) otherwise.
  const offerLastPrice = offer?.lastPrice != null ? Number(offer.lastPrice) : null
  const previousPrice = offerLastPrice ?? Number(bestItem.purchasePrice)
```
with
```ts
  // "was" price = what THIS supplier charged last time, when known; else the
  // primary chain's purchase-unit price (see previousPriceFor).
  const previousPrice = previousPriceFor(offer, bestItem)
```

In the candidate `select` (lines 453–458) delete the line `purchasePrice: true,`. If the local `InventoryItem` type in this file declares `purchasePrice`, delete that property too (`npm run build` in Step 5 will point at any remaining use).

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/__tests__/invoice-matcher-aliases.test.ts src/lib/__tests__/invoice-offer.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx prisma generate && npm run build`
Expected: build succeeds. If `purchasePrice` is still referenced in `invoice-matcher.ts`, replace that read with `purchaseUnitCost(item)`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/invoice-matcher.ts src/lib/__tests__/invoice-matcher-aliases.test.ts
git commit -m "fix(invoices): the matcher's 'was' price derives from the chain, never the stale purchasePrice column"
```

---

### Task 5: EOD order guide prices a purchase unit from the chain

**Files:**
- Modify: `src/app/api/eod/orders/route.ts` (select lines 46–55, row type lines 57–70, line 173)

**Interfaces:**
- Consumes: `purchaseUnitCost` (Task 1).
- Produces: `unitPrice` on each order line = `purchaseUnitCost(row)` (PACK unchanged; RATE items now priced per purchase unit instead of the bare rate).

- [ ] **Step 1: Implement**

Add to the imports at the top of `src/app/api/eod/orders/route.ts`:
```ts
import { purchaseUnitCost } from '@/lib/cost-basis'
```
In `itemInclude` delete the line `purchasePrice: true,`. In the `rows` type delete the line `purchasePrice: unknown`.
Replace line 173
```ts
    const unitPrice = Number(row.purchasePrice) // price per purchase (top-of-chain) unit
```
with
```ts
    const unitPrice = purchaseUnitCost(row) // price per purchase (top-of-chain) unit, from the chain
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: success. If the type-check complains that `row` lacks a `PRICING_SELECT` field, the select already spreads `...PRICING_SELECT` — add the missing field name to the `rows` type literal.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/eod/orders/route.ts
git commit -m "fix(eod): the order guide prices a purchase unit from the chain, not the purchasePrice column"
```

---

### Task 6: Every other reader goes through `cost-basis`, enforced by a gate test

**Files:**
- Create: `src/lib/__tests__/cost-readers-gate.test.ts`
- Modify (exact edits in the table below): 29 files under `src/app/api/**` and `src/lib/**`
- Modify: `src/app/api/inventory/__tests__/money-and-edit-gates.test.ts` (its `@/lib/cost-basis` mock)

**Interfaces:**
- Consumes: `lastCost`, `withLastCost` (Task 1).
- Produces: nothing new; a failing test whenever a non-allowed file imports a money function from `item-model`.

- [ ] **Step 1: Write the gate test (it must fail first, listing the offenders)**

`src/lib/__tests__/cost-readers-gate.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// The one-cost-function rule (spec 2026-10-03-item-backbone-design §2.1):
// routes and libs read an item's cost through `@/lib/cost-basis`, never the
// engine directly. The engine's money exports may only be imported by the
// pricing libs listed here and by tests.
const ROOT = join(__dirname, '..', '..')            // src/
const SCAN = ['app/api', 'lib']
const ALLOWED = [
  'lib/item-model.ts', 'lib/cost-basis.ts', 'lib/offer-price.ts', 'lib/primary-offer.ts',
  'lib/supplier-offers.ts', 'lib/item-model-form.ts', 'lib/inventory-import.ts',
]
const ALLOWED_PREFIXES = ['lib/invoice/']
const MONEY = ['pricePerBaseUnit', 'withPpb', 'lineCost', 'stockValue']
const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"](?:@\/lib\/item-model|\.\/item-model|\.\.\/item-model)['"]/gs

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('cost readers go through cost-basis', () => {
  it('no route or lib imports a money function from item-model', () => {
    const offenders: string[] = []
    for (const base of SCAN) {
      for (const file of walk(join(ROOT, base))) {
        const rel = relative(ROOT, file).split('\\').join('/')
        if (rel.includes('__tests__/')) continue
        if (ALLOWED.includes(rel) || ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) continue
        const src = readFileSync(file, 'utf8')
        for (const m of src.matchAll(IMPORT_RE)) {
          const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, ''))
          const bad = names.filter((n) => MONEY.includes(n))
          if (bad.length) offenders.push(`${rel}: ${bad.join(', ')}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: Run it — it must fail and list every offender**

Run: `npx vitest run src/lib/__tests__/cost-readers-gate.test.ts`
Expected: FAIL with ~29 entries. Keep that list open; it is your checklist for Step 3.

- [ ] **Step 3: Migrate each file**

Rule for every file: (a) in the `@/lib/item-model` (or `./item-model`) import, delete `pricePerBaseUnit` and `withPpb` (and any `as` alias of them); keep `asChainItem`/`PRICING_SELECT` only if still used after the edit; (b) add `import { lastCost, withLastCost } from '@/lib/cost-basis'` with only the names the file uses (merge into an existing `@/lib/cost-basis` import if there is one); (c) apply the line edits:

| File | Line | Before → After |
|---|---|---|
| `app/api/insights/spine-audit/route.ts` | 73 | `pricePerBaseUnit(asChainItem(it))` → `lastCost(it)` |
| | 116 | `pricePerBaseUnit: pricePerBaseUnit(asChainItem(r.inventoryItem!))` → `pricePerBaseUnit: lastCost(r.inventoryItem!)` |
| `app/api/insights/cost-chrome/route.ts` | 149 | `pricePerBaseUnit(asChainItem(it))` → `lastCost(it)` |
| `app/api/suppliers/[id]/intelligence/route.ts` | 76 | `pricePerBaseUnit(asChainItem(i))` → `lastCost(i)` |
| `app/api/chat/route.ts` | 119 | `pricePerBaseUnit(asChainItem(i))` → `lastCost(i)` |
| | 147 | `pricePerBaseUnit(asChainItem(ing.inventoryItem))` → `lastCost(ing.inventoryItem)` |
| `app/api/invoices/alerts/route.ts` | 30 | `{ ...a, inventoryItem: { ...a.inventoryItem, pricePerBaseUnit: pricePerBaseUnit(asChainItem(a.inventoryItem)) } }` → `{ ...a, inventoryItem: withLastCost(a.inventoryItem) }` |
| `app/api/invoices/sessions/[id]/route.ts` | 57 | `withPpb(mi)` → `withLastCost(mi)` |
| `app/api/invoices/sessions/[id]/approve/route.ts` | 542 | `pricePerBaseUnit(itemAsChain)` → `lastCost(item)` (`item` is the matched row built into `itemAsChain` at line 222; same bridges, same number) |
| | 1217 | `pricePerBaseUnit(asChainItem(p.inventoryItem))` → `lastCost(p.inventoryItem)` |
| `app/api/invoices/sessions/[id]/scanitems/route.ts` | 51 | `matchedItem: { ...item.matchedItem, pricePerBaseUnit: pricePerBaseUnit(asChainItem(item.matchedItem)) }` → `matchedItem: withLastCost(item.matchedItem)` |
| `app/api/digest/route.ts` | 94 | `pricePerBaseUnit(asChainItem(i))` → `lastCost(i)` |
| | 104 | `pricePerBaseUnit(asChainItem(ing.inventoryItem))` → `lastCost(ing.inventoryItem)` |
| | 119 | `pricePerBaseUnit(asChainItem(li.inventoryItem))` → `lastCost(li.inventoryItem)` |
| `app/api/count/sessions/route.ts` | 198 | `pricePerBaseUnit(asChainItem(item))` → `lastCost(item)` |
| | 226 | `withPpb(l.inventoryItem)` → `withLastCost(l.inventoryItem)` |
| `app/api/count/areas/route.ts` | 87 | `pricePerBaseUnit(asChainItem(it))` → `lastCost(it)` |
| `app/api/count/sessions/[id]/lines/route.ts` | 61 | `pricePerBaseUnit(asChainItem(item))` → `lastCost(item)` |
| | 68 | `withPpb(line.inventoryItem)` → `withLastCost(line.inventoryItem)` |
| `app/api/count/sessions/[id]/route.ts` | 61 | `...withPpb(l.inventoryItem)` → `...withLastCost(l.inventoryItem)` |
| `app/api/count/sessions/[id]/sync/route.ts` | 94, 181, 194, 200, 219 | each `pricePerBaseUnit(asChainItem(item))` → `lastCost(item)` |
| | 250 | `withPpb(l.inventoryItem)` → `withLastCost(l.inventoryItem)` |
| `app/api/count/sessions/[id]/lines/[lineId]/route.ts` | 183 | `withPpb(updated.inventoryItem)` → `withLastCost(updated.inventoryItem)` |
| `app/api/search/route.ts` | 66 | `inventoryRaw.map(i => ({ ...i, pricePerBaseUnit: pricePerBaseUnit(asChainItem(i)) }))` → `inventoryRaw.map(i => withLastCost(i))` |
| `app/api/recipes/search-ingredients/route.ts` | 100 | `?? pricePerBaseUnit(asChainItem(item))` → `?? lastCost(item)` |
| | 114 | `recipe.inventoryItem ? pricePerBaseUnit(asChainItem(recipe.inventoryItem)) : 0` → `recipe.inventoryItem ? lastCost(recipe.inventoryItem) : 0` |
| `app/api/inventory/route.ts` | 118 | `withPpb(item)` → `withLastCost(item)` |
| `app/api/inventory/search/route.ts` | 60 | `out([{ ...item, pricePerBaseUnit: pricePerBaseUnit(asChainItem(item)) }])` → `out([withLastCost(item)])` |
| | 108 | `pricePerBaseUnit: pricePerBaseUnit(asChainItem(i))` → `pricePerBaseUnit: lastCost(i)` |
| `app/api/inventory/export/route.ts` | 47 | `pricePerBaseUnit(asChainItem(i))` → `lastCost(i)` |
| | 77 | `const ppb = pricePerBaseUnit(ci)` → `const ppb = lastCost(item)` (keep line 76 `const ci = asChainItem(item)` — `ci.baseUnit` and `basePerUnit(ci, …)` still use it) |
| `app/api/inventory/[id]/route.ts` | 43 | `withPpb(item)` → `withLastCost(item)` |
| | 228 | `withPpb(updated)` → `withLastCost(updated)` |
| `app/api/reports/inventory-efficiency/route.ts` | 68 | `pricePerBaseUnit(asChainItem(it))` → `lastCost(it)` |
| `app/api/reports/theoretical-usage/route.ts` | 104 | `pricePerBaseUnit(asChainItem(it))` → `lastCost(it)` |
| | 108 | `pricePerBaseUnit(asChainItem(prep))` → `lastCost(prep)` |
| `app/api/reports/dashboard/route.ts` | 168, 183, 200 | each `pricePerBaseUnit(asChainItem(item))` → `lastCost(item)` |
| | 182 | `...withPpb(item)` → `...withLastCost(item)` |
| `app/api/reports/analytics/route.ts` | 308, 316, 328 | each `pricePerBaseUnit(asChainItem(i))` → `lastCost(i)` |
| `app/api/reports/cogs/route.ts` | 64 | `pricePerBaseUnit(asChainItem(item))` → `lastCost(item)` |
| `lib/count-finalize.ts` | 119 | `pricePerBaseUnit(asChainItem(item))` → `lastCost(item)` |
| `lib/quick-count.ts` | 62 | `pricePerBaseUnit(asChainItem(item))` → `lastCost(item)` |
| `lib/recipe-costs.ts` | 57 | `pricePerBaseUnit(asChainItem(ing.inventoryItem))` → `lastCost(ing.inventoryItem)` |
| `lib/recipeCosts.ts` | 11 | drop `pricePerBaseUnit as chainPricePerBaseUnit` from the `./item-model` import; add `lastCost` to the existing `@/lib/cost-basis` import on line 12 |
| | 139 | `chainPricePerBaseUnit(asChainItem(ing.inventoryItem))` → `lastCost(ing.inventoryItem)` |
| | 257 | `chainPricePerBaseUnit(asChainItem(item))` → `lastCost(item)` |
| | 672–673 | `chainPricePerBaseUnit(asChainItem(before))` → `lastCost(before)`; same for `after` |
| `lib/inventory-list.ts` | 10 | import becomes `import { asChainItem } from './item-model'` (keep only if still used) + `import { lastCost } from '@/lib/cost-basis'` |
| | 128 | `chainPricePerBaseUnit(asChainItem(item as any))` → `lastCost(item as any)` |

Line numbers are as of `origin/main` @ `1c0248f`; use the gate test output and `grep -n` if they have drifted.

A mechanical first pass for the simple pattern (then fix the rest by hand from the table):
```bash
grep -rlE 'pricePerBaseUnit\(asChainItem\(' src/app/api src/lib --include='*.ts' \
  | grep -vE '__tests__|lib/(item-model|cost-basis|offer-price|primary-offer|supplier-offers|item-model-form|inventory-import)\.ts|lib/invoice/' \
  | xargs perl -pi -e 's/\b(?:chainPricePerBaseUnit|pricePerBaseUnit)\(asChainItem\(([^()]+)\)\)/lastCost($1)/g; s/\bwithPpb\(/withLastCost(/g'
```

- [ ] **Step 4: Fix the one test that mocks `cost-basis`**

`src/app/api/inventory/__tests__/money-and-edit-gates.test.ts` mocks `@/lib/cost-basis` with only `windowedAvgCost`; the item route now also imports `withLastCost` from it. Replace that mock with:
```ts
vi.mock('@/lib/cost-basis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cost-basis')>()),
  windowedAvgCost: async () => new Map([['i1', { basis: 'AVG_30D', avg: { pricePerBase: 0.0131 } }]]),
}))
```
Then: `grep -rln "vi.mock('@/lib/cost-basis'" src` — apply the same spread to any other test it finds.

- [ ] **Step 5: Run the gate, the whole suite, lint and build**

Run: `npx vitest run src/lib/__tests__/cost-readers-gate.test.ts`
Expected: PASS (`offenders` is `[]`).

Run: `npm test`
Expected: all green.

Run: `npm run lint`
Expected: no errors. Remove any `asChainItem`/`PRICING_SELECT` import lint reports as unused.

Run: `npm run build`
Expected: success; every API route still shows `ƒ (Dynamic)`.

- [ ] **Step 6: Commit**

```bash
git add -A src/app/api src/lib
git commit -m "refactor(cost): every route and lib reads item cost through cost-basis; gate test keeps it that way"
```

---

### Task 7: Parity after, PR

**Files:** none new.

- [ ] **Step 1: Re-run the parity script**

Run: `TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/verify-cost-parity.ts`
Expected: the same `OK — <n> items match (LAST); <m> on the 30-day average` line as Task 2 Step 2 (same `n`, same `m` unless an invoice was approved in between).

- [ ] **Step 2: Smoke the preview (read-only)**

Start the dev server with `preview_start` (`RestaurantOS (Next.js)`), then with `DEV_AUTH_BYPASS=true` open `/inventory`, `/count`, `/reports`, `/wastage`, `/end-of-day` and confirm: no console errors; the inventory list and the count page show the same prices as before; the order guide's lines still carry a unit price. Take one screenshot of `/inventory` for the PR.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/one-cost-function
gh pr create --title "feat(cost): one cost function — every screen reads item cost from cost-basis" --body "$(cat <<'EOF'
## What changes for the restaurant
- Wastage is now costed at the 30-day average (what we actually paid), like recipes. Historic wastage rows are untouched.
- Invoice review's "was" price comes from the chain, never the stale purchasePrice column.
- The order guide prices a purchase unit from the chain (a $/kg item is priced per pound/case, not per kg).
- Counts, stock value, COGS, variance, reports: unchanged numbers (parity script: `<paste the OK line>`).

## How
Spec: docs/superpowers/specs/2026-10-03-item-backbone-design.md §2. `src/lib/cost-basis.ts` is the one reader API (`lastCost`, `withLastCost`, `purchaseUnitCost`, `itemCosts(basis)`); 29 readers migrated; `cost-readers-gate.test.ts` fails the suite if a route imports a money function from `item-model` again.

No migration. No live-data writes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

- **Spec coverage (§2.1, §2.2, §2.5):** one function + gate (Tasks 1, 6); wastage → AVG (Task 3); alert "was" price from the supplier's own offer with a chain fallback (Task 4); orders from the chain (Task 5); parity script (Tasks 2, 7). §2.3 stale-copy retirement, §2.4 bridged stock maths and the offer FK are deliberately Stage 1b–1d.
- **Placeholders:** none; every edit is spelled out, the mechanical pass has its exact command and the table covers every grep hit on `origin/main` @ `1c0248f`.
- **Type consistency:** `lastCost(row: ChainRow)`, `withLastCost`, `purchaseUnitCost`, `itemCosts(ids, basis, asOf?)`, `itemCost(id, basis, asOf?)` are used with those exact names and argument orders in Tasks 3–6; `previousPriceFor(offer, item)` is defined and tested in Task 4 only.
