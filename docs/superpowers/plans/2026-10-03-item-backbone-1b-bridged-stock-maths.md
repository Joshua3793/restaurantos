# Item backbone — Stage 1b: bridged stock maths — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Theoretical stock converts every movement through the item's bridges (each-measure, density) exactly like recipe costing does, and a movement it cannot convert is excluded and *shown* — never passed through 1:1 (today 200 g of a per-each bun depletes 200 buns).

**Architecture:** One pure helper, `movementQtyBase(qty, unit, item)` in a new `src/lib/movement-qty.ts`, replaces the six bare `convertQty` calls in `src/lib/count-expected.ts` (sales, prep draw-down, prep yield, wastage) and the two in the theoretical-usage report. It returns the base quantity, or `qtyBase: 0` plus an `unbridged: { qty, unit }` record when the units are count↔measured with no each-measure. The ledger event carries that record, `LedgerBalance` / the item ledger count them, the stock-movements API exposes them, and the item drawer prints "not counted — set 1 each = ? g". Nothing is stored.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma, vitest (`npm test`), `npm run build` as the type-check.

**Spec:** `docs/superpowers/specs/2026-10-03-item-backbone-design.md` §2.4. Stage 1a (PR #154, merged) is the base.

## Global Constraints

- Branch off `origin/main` (= `30b1ec6`, Stage 1a merged). Worktree `.claude/worktrees/bridged-stock-maths`, branch `worktree-bridged-stock-maths`, pushed as `feat/bridged-stock-maths`. One PR, squash-merged.
- `node`/`npm` are not on the sandbox PATH: prefix every command with `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" &&` (Bash `dangerouslyDisableSandbox: true`). `node_modules` and `.env` are symlinks in the worktree.
- Same-dimension movements must produce **byte-identical** numbers to today (`convertQty`). Weight↔volume keeps today's behaviour: density when the item has one, else 1:1 passthrough (tolerated, same as costing). Only count↔measured changes: through the each-measure when present, else **0 + unbridged**.
- The bridge rule is `dimensionallyCostable()` + `convertQtyBridged()` from `src/lib/uom.ts` — the same two functions `src/lib/recipeCosts.ts` costs with. No new conversion table.
- Nothing stored, no migration, no live-data writes. The audit script is read-only.
- Prisma `Decimal` values arrive as strings — `Number()` before arithmetic.
- No new `convertQty` import in `count-expected.ts` after this plan; the gate for that is the grep in Task 3 Step 5.

---

### Task 1: The one conversion — `movementQtyBase`

**Files:**
- Create: `src/lib/movement-qty.ts`
- Test: `src/lib/__tests__/movement-qty.test.ts`

**Interfaces:**
- Consumes: `dimensionallyCostable`, `convertQtyBridged` from `@/lib/uom`; `eachMeasureOf`, `densityOf` from `@/lib/item-model`.
- Produces (later tasks use these exact names):
  ```ts
  export const MOVEMENT_ITEM_SELECT = { id: true, baseUnit: true, dimension: true, eachMeasureQty: true, eachMeasureUnit: true, densityGPerMl: true } as const
  export interface MovementItem { baseUnit: string; dimension?: string | null; eachMeasureQty?: unknown; eachMeasureUnit?: string | null; densityGPerMl?: unknown }
  export interface Unbridged { qty: number; unit: string }
  export type MovementQty = { qtyBase: number; unbridged: null } | { qtyBase: 0; unbridged: Unbridged }
  export function movementQtyBase(qty: number, unit: string, item: MovementItem): MovementQty
  ```

- [ ] **Step 1: Write the failing tests**

`src/lib/__tests__/movement-qty.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { movementQtyBase, MOVEMENT_ITEM_SELECT } from '@/lib/movement-qty'

const BUN_NO_BRIDGE = { baseUnit: 'each', dimension: 'COUNT', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
const BUN_85G       = { baseUnit: 'each', dimension: 'COUNT', eachMeasureQty: '85', eachMeasureUnit: 'g', densityGPerMl: null }
const FLOUR         = { baseUnit: 'g',    dimension: 'MASS',  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
const OIL_092       = { baseUnit: 'ml',   dimension: 'VOLUME', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: '0.92' }
const OIL_NO_DENS   = { baseUnit: 'ml',   dimension: 'VOLUME', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
const LOAF_1100G    = { baseUnit: 'g',    dimension: 'MASS',  eachMeasureQty: '1100', eachMeasureUnit: 'g', densityGPerMl: null }

describe('movementQtyBase — same dimension is convertQty, unchanged', () => {
  it('1 kg of flour → 1000 g', () => expect(movementQtyBase(1, 'kg', FLOUR)).toEqual({ qtyBase: 1000, unbridged: null }))
  it('500 g of flour → 500 g', () => expect(movementQtyBase(500, 'g', FLOUR)).toEqual({ qtyBase: 500, unbridged: null }))
  it('3 each of buns → 3 each', () => expect(movementQtyBase(3, 'each', BUN_NO_BRIDGE)).toEqual({ qtyBase: 3, unbridged: null }))
})

describe('movementQtyBase — count ↔ measured through the each-measure', () => {
  it('200 g of a bun that weighs 85 g → 2.35 buns (the recipe-costing rule, not 200 buns)', () => {
    const r = movementQtyBase(200, 'g', BUN_85G)
    expect(r.unbridged).toBeNull()
    expect(r.qtyBase).toBeCloseTo(200 / 85, 9)
  })
  it('3 each of a by-weight loaf that weighs 1100 g → 3300 g', () => {
    expect(movementQtyBase(3, 'each', LOAF_1100G)).toEqual({ qtyBase: 3300, unbridged: null })
  })
  it('200 g of a bun with NO each-measure → 0, reported as unbridged', () => {
    expect(movementQtyBase(200, 'g', BUN_NO_BRIDGE)).toEqual({ qtyBase: 0, unbridged: { qty: 200, unit: 'g' } })
  })
  it('2 each of flour (no each-measure) → 0, unbridged', () => {
    expect(movementQtyBase(2, 'each', FLOUR)).toEqual({ qtyBase: 0, unbridged: { qty: 2, unit: 'each' } })
  })
})

describe('movementQtyBase — weight ↔ volume keeps today\'s tolerance', () => {
  it('920 g of oil with density 0.92 → 1000 ml', () => {
    const r = movementQtyBase(920, 'g', OIL_092)
    expect(r.unbridged).toBeNull()
    expect(r.qtyBase).toBeCloseTo(1000, 9)
  })
  it('920 g of oil with NO density → 920 ml (1:1 passthrough, never unbridged)', () => {
    expect(movementQtyBase(920, 'g', OIL_NO_DENS)).toEqual({ qtyBase: 920, unbridged: null })
  })
})

describe('MOVEMENT_ITEM_SELECT', () => {
  it('selects exactly the fields movementQtyBase reads, plus id', () => {
    expect(Object.keys(MOVEMENT_ITEM_SELECT).sort()).toEqual(['baseUnit', 'densityGPerMl', 'dimension', 'eachMeasureQty', 'eachMeasureUnit', 'id'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/movement-qty.test.ts`
Expected: FAIL — cannot resolve `@/lib/movement-qty`.

- [ ] **Step 3: Implement**

`src/lib/movement-qty.ts`:
```ts
// ONE conversion for every stock MOVEMENT (a sale's ingredient draw, a prep
// log's draw-down and yield, a wastage line): a quantity in the recipe's or
// log's unit → the item's base unit, through the item's bridges.
//
// This is the same rule recipe costing prices with (dimensionallyCostable +
// convertQtyBridged in src/lib/recipeCosts.ts). Theoretical stock used to call
// bare convertQty here, which passes a cross-dimension quantity through 1:1 —
// 200 g of a per-each bun depleted 200 buns. A movement that genuinely cannot
// be converted (count ↔ measured, no each-measure) now contributes 0 AND is
// reported as `unbridged`, so the drawer can say "not counted — set 1 each = ? g"
// instead of silently inventing a number.
//
// Pure and client-safe: imports only uom + item-model.
import { dimensionallyCostable, convertQtyBridged } from '@/lib/uom'
import { eachMeasureOf, densityOf } from '@/lib/item-model'

/** The item fields a movement conversion needs — spread into any Prisma select. */
export const MOVEMENT_ITEM_SELECT = {
  id: true, baseUnit: true, dimension: true,
  eachMeasureQty: true, eachMeasureUnit: true, densityGPerMl: true,
} as const

export interface MovementItem {
  baseUnit: string
  dimension?: string | null
  eachMeasureQty?: unknown
  eachMeasureUnit?: string | null
  densityGPerMl?: unknown
}

/** A movement the item's bridges cannot convert, kept in its own unit for display. */
export interface Unbridged { qty: number; unit: string }

export type MovementQty =
  | { qtyBase: number; unbridged: null }
  | { qtyBase: 0; unbridged: Unbridged }

/**
 * `qty` of `unit` → the item's base unit.
 *  • same dimension           → convertQty (byte-identical to before)
 *  • weight ↔ volume          → through density when the item has one, else 1:1
 *                               (today's tolerated kitchen convention, as costing)
 *  • count ↔ measured, bridge → through the each-measure
 *  • count ↔ measured, none   → 0 + unbridged
 */
export function movementQtyBase(qty: number, unit: string, item: MovementItem): MovementQty {
  const bridge = eachMeasureOf(item)
  if (!dimensionallyCostable(unit, item.baseUnit, bridge)) {
    return { qtyBase: 0, unbridged: { qty, unit } }
  }
  return { qtyBase: convertQtyBridged(qty, unit, item.baseUnit, bridge, densityOf(item)), unbridged: null }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/__tests__/movement-qty.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/movement-qty.ts src/lib/__tests__/movement-qty.test.ts
git commit -m "feat(stock): movementQtyBase — one bridged conversion for every stock movement"
```

---

### Task 2: The ledger carries and counts unbridged movements

**Files:**
- Modify: `src/lib/ledger-balance.ts` (the `LedgerEvent` interface ~line 30, `LedgerBalance` ~line 51, `runLedger` ~line 81)
- Modify: `src/lib/count-expected.ts` lines 557 and 774–775 (the two `LedgerBalance` literals)
- Test: `src/lib/__tests__/ledger-balance.test.ts`

**Interfaces:**
- Consumes: `Unbridged` from `@/lib/movement-qty` (type only).
- Produces: `LedgerEvent.unbridged?: Unbridged`; `LedgerBalance.unbridged: number` (count of unbridged events); `runLedger` and `MovementLedger.balance` populate it.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/__tests__/ledger-balance.test.ts`:
```ts
describe('runLedger — unbridged movements', () => {
  it('counts an unbridged event and never lets it move the shelf', () => {
    const unbridged: LedgerEvent = {
      ...ev('SALE', 0, D1), unbridged: { qty: 200, unit: 'g' },
    }
    const r = runLedger(10, [unbridged, ev('SALE', -4, D2)])
    expect(r).toEqual({ expected: 6, shortfall: 0, unbridged: 1 })
  })
  it('reports unbridged: 0 for a healthy ledger', () => {
    expect(runLedger(10, [ev('PURCHASE', 5, D1)])).toEqual({ expected: 15, shortfall: 0, unbridged: 0 })
  })
  it('MovementLedger.balance carries the count per item', () => {
    const l = new MovementLedger()
    l.push({ ...ev('WASTAGE', 0, D1), unbridged: { qty: 2, unit: 'each' } })
    l.push({ ...ev('WASTAGE', 0, D2, undefined, 'other'), unbridged: { qty: 1, unit: 'each' } })
    expect(l.balance(ITEM, 3).unbridged).toBe(1)
    expect(l.balance('other', 0).unbridged).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/ledger-balance.test.ts`
Expected: FAIL — `unbridged` is not a known property / `toEqual` mismatch (`{ expected: 6, shortfall: 0 }`).

- [ ] **Step 3: Implement**

In `src/lib/ledger-balance.ts`:

Add after the `displayDayKey` import:
```ts
import type { Unbridged } from './movement-qty'
```

In `LedgerEvent`, after `revenueCenterId: string | null`:
```ts
  /**
   * Set when the item's bridges could not convert this movement (count ↔
   * measured with no each-measure). `qtyBase` is then 0: the movement is
   * listed, never applied, and the balance counts it so the drawer can say so.
   */
  unbridged?: Unbridged
```

In `LedgerBalance`, after `shortfall: number`:
```ts
  /** Movements excluded because the item has no bridge to convert them. */
  unbridged: number
```

Replace `runLedger` with:
```ts
export function runLedger(baseStock: number, events: readonly LedgerEvent[]): LedgerBalance {
  let running = baseStock
  let shortfall = 0
  let unbridged = 0
  if (running < 0) { shortfall = -running; running = 0 }
  const ordered = [...events].sort(ledgerOrder)
  for (const e of ordered) {
    if (e.unbridged) { unbridged++; continue }
    running += e.qtyBase
    if (running < 0) { shortfall += -running; running = 0 }
  }
  return { expected: running, shortfall, unbridged }
}
```

In `src/lib/count-expected.ts`:
- line 557: `{ expected: 0, shortfall: 0 }` → `{ expected: 0, shortfall: 0, unbridged: 0 }`
- line 774: `{ expected: 0, shortfall: 0 }` → `{ expected: 0, shortfall: 0, unbridged: 0 }`
- line 775: `sum.set(id, { expected: cur.expected + b.expected, shortfall: cur.shortfall + b.shortfall })` → `sum.set(id, { expected: cur.expected + b.expected, shortfall: cur.shortfall + b.shortfall, unbridged: cur.unbridged + b.unbridged })`

- [ ] **Step 4: Run the tests and the type-check for literals you may have missed**

Run: `npx vitest run src/lib/__tests__/ledger-balance.test.ts src/lib/__tests__/stock-ledger.test.ts`
Expected: PASS.

Run: `grep -rn "shortfall: " src --include='*.ts' --include='*.tsx' | grep -v __tests__ | grep -v "tips/"`
Expected: only the three edited count-expected lines and `ledger-balance.ts`. Any other object literal typed `LedgerBalance` gets `unbridged: 0`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ledger-balance.ts src/lib/count-expected.ts src/lib/__tests__/ledger-balance.test.ts
git commit -m "feat(stock): the ledger lists and counts movements its bridges cannot convert"
```

---

### Task 3: Theoretical stock converts through the bridges

**Files:**
- Modify: `src/lib/count-expected.ts` — import block (lines 1–9), `IngredientWithLinks` (48–65), the sale expansion (198–219), the consumption selects (245–250), the wastage select + loop (438, 445–452), the prep selects (646–650) and loop (692–721)
- Create: `src/lib/__tests__/count-expected-bridges.test.ts`

**Interfaces:**
- Consumes: `movementQtyBase`, `MOVEMENT_ITEM_SELECT`, `MovementItem` (Task 1); `LedgerEvent.unbridged` (Task 2).
- Produces: every `SALE` / `WASTAGE` / `PREP_IN` / `PREP_OUT` event carries `unbridged` when the conversion failed, with `qtyBase: 0`; the per-source maps add 0 for those.

- [ ] **Step 1: Write the failing test**

`src/lib/__tests__/count-expected-bridges.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import type { LedgerEvent } from '@/lib/ledger-balance'

// buildWastageMap is the smallest builder that converts a movement; the sale and
// prep builders go through the same movementQtyBase call (Task 3 of the plan).
const BUN = { id: 'bun', baseUnit: 'each', dimension: 'COUNT', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
const BUN_85 = { ...BUN, eachMeasureQty: '85', eachMeasureUnit: 'g' }
const D = new Date('2026-09-20T00:00:00.000Z')
let rows: unknown[] = []
vi.mock('@/lib/prisma', () => ({ prisma: { wastageLog: { findMany: async () => rows } } }))

const { buildWastageMap } = await import('@/lib/count-expected')

const wastage = (item: typeof BUN, qtyWasted: string, unit: string) => ({
  id: 'w1', inventoryItemId: item.id, qtyWasted, unit, date: D, reason: 'SPOILED', revenueCenterId: 'rc1', inventoryItem: item,
})

describe('buildWastageMap — bridged conversion', () => {
  it('200 g of a bun that weighs 85 g depletes 2.35 buns, not 200', async () => {
    rows = [wastage(BUN_85, '200', 'g')]
    const sink: LedgerEvent[] = []
    const map = await buildWastageMap(new Date(0), ['bun'], null, undefined, undefined, sink)
    expect(map.get('bun')).toBeCloseTo(200 / 85, 9)
    expect(sink[0].qtyBase).toBeCloseTo(-200 / 85, 9)
    expect(sink[0].unbridged).toBeUndefined()
  })
  it('200 g of a bun with NO each-measure depletes nothing and is reported unbridged', async () => {
    rows = [wastage(BUN, '200', 'g')]
    const sink: LedgerEvent[] = []
    const map = await buildWastageMap(new Date(0), ['bun'], null, undefined, undefined, sink)
    expect(map.get('bun')).toBe(0)
    expect(sink[0]).toMatchObject({ type: 'WASTAGE', qtyBase: 0, unbridged: { qty: 200, unit: 'g' } })
  })
  it('3 each of a bun is still 3 (same dimension, unchanged)', async () => {
    rows = [wastage(BUN, '3', 'each')]
    const map = await buildWastageMap(new Date(0), ['bun'])
    expect(map.get('bun')).toBe(3)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/count-expected-bridges.test.ts`
Expected: FAIL — first case gets 200 (passthrough), second gets 200 and no `unbridged`.

- [ ] **Step 3: Implement**

In `src/lib/count-expected.ts`:

Line 2 `import { convertQty } from '@/lib/uom'` → delete. Add:
```ts
import { movementQtyBase, MOVEMENT_ITEM_SELECT, type MovementItem } from '@/lib/movement-qty'
```

`IngredientWithLinks` — replace every `{ id: string; baseUnit: string }` (three occurrences, lines 50, 55, 58) with `({ id: string } & MovementItem)`.

Sale expansion (lines 198–219) becomes:
```ts
  for (const ing of recipe.ingredients) {
    if (ing.inventoryItemId && ing.inventoryItem && (!eventDate || inWindow(cutoff, ing.inventoryItemId, eventDate, until))) {
      const { qtyBase: consumed, unbridged } = movementQtyBase(Number(ing.qtyBase) * batches, ing.unit, ing.inventoryItem)
      map.set(ing.inventoryItemId, (map.get(ing.inventoryItemId) ?? 0) + consumed)
      if (meta?.sink && eventDate) meta.sink.push({
        id: `sale-${meta.saleId}-${recipe.id}-${ing.inventoryItemId}`,
        date: eventDate, type: 'SALE', itemId: ing.inventoryItemId,
        qtyBase: -consumed, description: meta.label, revenueCenterId: meta.rcId,
        ...(unbridged ? { unbridged } : {}),
      })
    }

    if (ing.linkedRecipeId && ing.linkedRecipe && !visitedRecipes.has(ing.linkedRecipeId)) {
      const prep = ing.linkedRecipe
      if (prep.inventoryItemId && prep.inventoryItem && (!eventDate || inWindow(cutoff, prep.inventoryItemId, eventDate, until))) {
        const { qtyBase: consumed, unbridged } = movementQtyBase(Number(ing.qtyBase) * batches, ing.unit, prep.inventoryItem)
        map.set(prep.inventoryItemId, (map.get(prep.inventoryItemId) ?? 0) + consumed)
        if (meta?.sink && eventDate) meta.sink.push({
          id: `sale-${meta.saleId}-${recipe.id}-prep-${prep.inventoryItemId}`,
          date: eventDate, type: 'SALE', itemId: prep.inventoryItemId,
          qtyBase: -consumed, description: meta.label, revenueCenterId: meta.rcId,
          ...(unbridged ? { unbridged } : {}),
        })
      }
    }
  }
```

Consumption selects (lines 245, 248, 250): each `inventoryItem: { select: { id: true, baseUnit: true } }` → `inventoryItem: { select: MOVEMENT_ITEM_SELECT }`.

Wastage select (line 438): `inventoryItem:   { select: { baseUnit: true } }` → `inventoryItem:   { select: MOVEMENT_ITEM_SELECT }`.
Wastage loop (lines 445–452) becomes:
```ts
    const { qtyBase: converted, unbridged } = movementQtyBase(Number(w.qtyWasted), w.unit, w.inventoryItem)
    map.set(w.inventoryItemId, (map.get(w.inventoryItemId) ?? 0) + converted)
    sink?.push({
      id: w.id, date: w.date, type: 'WASTAGE', itemId: w.inventoryItemId,
      qtyBase: -converted,
      description: w.reason && w.reason !== 'UNKNOWN' ? w.reason : 'Wastage',
      revenueCenterId: w.revenueCenterId,
      ...(unbridged ? { unbridged } : {}),
    })
```

Prep selects (lines 646, 649, 650): each `{ select: { id: true, baseUnit: true } }` → `{ select: MOVEMENT_ITEM_SELECT }`.
Prep loop — line 692 block:
```ts
          const { qtyBase: drawn, unbridged } = movementQtyBase(qty, ing.unit, ing.inventoryItem)
          add(consumption, ing.inventoryItem.id, drawn)
          sink?.push({
            id: `prep-in-${log.id}-${ing.inventoryItem.id}`, date: log.logDate, at, type: 'PREP_IN',
            itemId: ing.inventoryItem.id, qtyBase: -drawn,
            description: `Prep: ${recipe.name}`, revenueCenterId: log.revenueCenterId ?? null,
            ...(unbridged ? { unbridged } : {}),
          })
```
line 703 block, same shape with `prep`:
```ts
          const { qtyBase: drawn, unbridged } = movementQtyBase(qty, ing.unit, prep)
          add(consumption, prep.id, drawn)
          sink?.push({
            id: `prep-in-${log.id}-${prep.id}`, date: log.logDate, at, type: 'PREP_IN',
            itemId: prep.id, qtyBase: -drawn,
            description: `Prep: ${recipe.name}`, revenueCenterId: log.revenueCenterId ?? null,
            ...(unbridged ? { unbridged } : {}),
          })
```
line 715 block (yield):
```ts
      const { qtyBase: yieldPerBatch, unbridged } = movementQtyBase(Number(recipe.baseYieldQty), recipe.yieldUnit, recipe.inventoryItem)
      const yieldInBase = yieldPerBatch * scale
      add(output, recipe.inventoryItem.id, yieldInBase)
      sink?.push({
        id: `prep-out-${log.id}`, date: log.logDate, at, type: 'PREP_OUT',
        itemId: recipe.inventoryItem.id, qtyBase: yieldInBase,
        description: `Prep output: ${recipe.name}`, revenueCenterId: log.revenueCenterId ?? null,
        ...(unbridged ? { unbridged } : {}),
      })
```
Also update the comment at lines 687–688 ("convertQty handles the conversion afterward") to "movementQtyBase converts through the item's bridges — same rule as recipeCosts.ts".

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/__tests__/count-expected-bridges.test.ts src/lib/__tests__/prep-window.test.ts src/lib/__tests__/ledger-balance.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and type-check**

Run: `grep -n "convertQty" src/lib/count-expected.ts`
Expected: no output (every conversion goes through `movementQtyBase`).

Run: `npx prisma generate && npm run build`
Expected: success. Afterwards `git diff --stat tsconfig.json`; if `next build` rewrote it, `git checkout tsconfig.json`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/count-expected.ts src/lib/__tests__/count-expected-bridges.test.ts
git commit -m "fix(stock): theoretical stock converts movements through the item's bridges, like costing"
```

---

### Task 4: The drawer shows what was not counted; the usage report uses the same rule

**Files:**
- Modify: `src/lib/stock-ledger.ts` (`ItemLedger` interface ~line 32, `buildItemLedger` return ~line 139)
- Modify: `src/app/api/inventory/[id]/stock-movements/route.ts` (`StockMovement` ~line 12, `StockReconciliation` ~line 34, the `movements` map ~line 85, `reconciliation` ~line 100)
- Modify: `src/components/inventory/InventoryItemDrawer.tsx` (types ~lines 44–65; movement row ~lines 956–985; the "+ n earlier" caption ~line 987)
- Modify: `src/app/api/reports/theoretical-usage/route.ts` (lines ~105 and ~109, and its `convertQty` import)
- Test: `src/lib/__tests__/stock-ledger.test.ts`

**Interfaces:**
- Consumes: `LedgerEvent.unbridged`, `LedgerBalance.unbridged` (Task 2); `movementQtyBase` (Task 1).
- Produces: `ItemLedger.unbridgedCount: number`; API `StockMovement.unbridged?: { qty: number; unit: string }`, `StockReconciliation.unbridgedCount: number`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/__tests__/stock-ledger.test.ts`:
```ts
describe('splitLedger — unbridged movements', () => {
  it('an unbridged movement (qtyBase 0) lands in neither column', () => {
    const s = splitLedger([{ type: 'SALE', qtyBase: 0 }, { type: 'PURCHASE', qtyBase: 10 }])
    expect(s).toEqual({ additions: 10, consumptions: 0, transferNet: 0 })
  })
})
```
(`buildItemLedger` needs Prisma; its one-line count is covered by the type-check and the smoke in Task 6.)

- [ ] **Step 2: Run it**

Run: `npx vitest run src/lib/__tests__/stock-ledger.test.ts`
Expected: PASS already (zero-quantity events were never counted) — this pins the behaviour the drawer now relies on.

- [ ] **Step 3: Implement — `stock-ledger.ts`**

In `ItemLedger`, after `residualBase: number`:
```ts
  /** Movements the engine listed but could not apply — the item has no bridge for their unit. */
  unbridgedCount: number
```
In `buildItemLedger`'s return object add:
```ts
    unbridgedCount: events.filter(e => e.unbridged).length,
```

- [ ] **Step 4: Implement — the API**

`src/app/api/inventory/[id]/stock-movements/route.ts`:

In `StockMovement`, after `revenueCenterId?: string | null`:
```ts
  /** Present when this movement was NOT applied: the item has no bridge for its unit. qty is then 0. */
  unbridged?: { qty: number; unit: string }
```
In `StockReconciliation`, after `movementCount: number`:
```ts
  /** Movements listed but not applied (no bridge). Zero for a healthy item. */
  unbridgedCount: number
```
In the `movements` map, add to each object:
```ts
    ...(e.unbridged ? { unbridged: e.unbridged } : {}),
```
In `reconciliation`, after `movementCount: ledger.events.length,`:
```ts
      unbridgedCount: ledger.unbridgedCount,
```

- [ ] **Step 5: Implement — the drawer**

`src/components/inventory/InventoryItemDrawer.tsx`:

`StockMovement` interface: add `unbridged?: { qty: number; unit: string }`. `StockReconciliation`: add `unbridgedCount?: number`.

In the movement row, replace the quantity `<span>` (the one rendering `{isTransfer ? '' : isPositive ? '+' : ''}{m.qty.toFixed(2)} {m.unit}`) with:
```tsx
                              {m.unbridged ? (
                                <span className="font-semibold text-gold" title="Not applied — this item has no bridge for this unit">
                                  {m.unbridged.qty.toFixed(2)} {m.unbridged.unit} · not counted
                                </span>
                              ) : (
                                <span className={`font-semibold ${isTransfer ? 'text-ink-3' : isPositive ? 'text-green' : 'text-red'}`}>
                                  {isTransfer ? '' : isPositive ? '+' : ''}{m.qty.toFixed(2)} {m.unit}
                                </span>
                              )}
```
Directly after the `{stockMovements.movements.length > 12 && (...)}` caption, add:
```tsx
                      {(stockMovements.reconciliation?.unbridgedCount ?? 0) > 0 && (
                        <div className="font-mono text-[10.5px] text-gold text-center pt-1">
                          {stockMovements.reconciliation!.unbridgedCount} movement{stockMovements.reconciliation!.unbridgedCount === 1 ? '' : 's'} not counted — set how much one {item.baseUnit === 'each' ? 'each weighs (1 each = ? g)' : 'each of this item measures (1 each = ? g)'} in Edit so they count
                        </div>
                      )}
```
(`item.baseUnit` is already in scope in that component; if the variable holding the item has another name there, use it.)

- [ ] **Step 6: Implement — theoretical-usage report**

`src/app/api/reports/theoretical-usage/route.ts`: remove `convertQty` from the `@/lib/uom` import (keep any other names), add `import { movementQtyBase } from '@/lib/movement-qty'`, and change the two `addUsage` calls:
```ts
        addUsage(it.id, it.itemName, it.baseUnit, lastCost(it), movementQtyBase(qty, ing.unit, it).qtyBase)
```
```ts
        addUsage(prep.id, prep.itemName, prep.baseUnit, lastCost(prep), movementQtyBase(qty, ing.unit, prep).qtyBase)
```
(`it`/`prep` are selected with `...PRICING_SELECT`, which carries the bridge fields `MovementItem` needs.)

- [ ] **Step 7: Type-check, lint, full suite**

Run: `npm run build` (then the `tsconfig.json` check), `npm run lint` (no NEW findings — the baseline has 20 pre-existing files), `npm test` (all green).

- [ ] **Step 8: Commit**

```bash
git add src/lib/stock-ledger.ts "src/app/api/inventory/[id]/stock-movements/route.ts" src/components/inventory/InventoryItemDrawer.tsx src/app/api/reports/theoretical-usage/route.ts src/lib/__tests__/stock-ledger.test.ts
git commit -m "feat(stock): the drawer lists movements that were not counted and says how to fix them"
```

---

### Task 5: Read-only audit — which items change, and by how much

**Files:**
- Create: `scripts/audit-unbridged-movements.ts`

**Interfaces:**
- Consumes: `getTheoreticalBalanceMap` from `@/lib/count-expected` (this branch) and the same function from the ORIGINAL engine? No — one engine. The before/after is computed as: AFTER = this branch's balance; BEFORE = AFTER with each unbridged event re-applied 1:1 (the old passthrough), which is exactly `qty` in the event's own unit added back with the old sign. The script reports both.

- [ ] **Step 1: Write the script**

```ts
// Read-only. For every active, stocked item: how many movements since its last
// count the bridges could not convert, what the theoretical on-hand is now
// (this branch), and what it was under the old 1:1 passthrough. Prints the
// items that changed, most-changed first, and a one-line total.
//
// Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-unbridged-movements.ts
import { prisma } from '../src/lib/prisma'
import { getTheoreticalBalanceMap, type LedgerEvent } from '../src/lib/count-expected'

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true, isStocked: true },
    select: { id: true, itemName: true, baseUnit: true, eachMeasureQty: true, eachMeasureUnit: true },
  })
  const byId = new Map(items.map(i => [i.id, i]))
  const events: LedgerEvent[] = []
  const after = await getTheoreticalBalanceMap(null, undefined, null, { sink: { push: e => { if (e.unbridged) events.push(e) } } })

  const perItem = new Map<string, { count: number; oldDelta: number; units: Set<string> }>()
  for (const e of events) {
    const cur = perItem.get(e.itemId) ?? { count: 0, oldDelta: 0, units: new Set<string>() }
    cur.count++
    // The old engine passed the quantity through 1:1 in the item's base unit, with the event's sign.
    const sign = e.type === 'PREP_OUT' || e.type === 'PURCHASE' ? 1 : -1
    cur.oldDelta += sign * e.unbridged!.qty
    cur.units.add(e.unbridged!.unit)
    perItem.set(e.itemId, cur)
  }

  const rows = Array.from(perItem.entries()).map(([id, v]) => {
    const it = byId.get(id)!
    const now = after.get(id)?.expected ?? 0
    const before = Math.max(0, now + v.oldDelta)
    return { name: it.itemName, base: it.baseUnit, bridge: it.eachMeasureQty ? `${it.eachMeasureQty} ${it.eachMeasureUnit}` : '—', count: v.count, units: [...v.units].join('/'), before, now }
  }).sort((a, b) => Math.abs(b.before - b.now) - Math.abs(a.before - a.now))

  for (const r of rows) {
    console.log(`${r.name.padEnd(40)} ${String(r.count).padStart(3)} lines in ${r.units.padEnd(6)} bridge ${r.bridge.padEnd(10)} before ${r.before.toFixed(2)} ${r.base} → now ${r.now.toFixed(2)} ${r.base}`)
  }
  console.log(`${rows.length} items had unbridged movements (${events.length} lines); ${items.length} active stocked items checked`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Run it against the live database (read-only)**

Run: `TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-unbridged-movements.ts` (or `npx tsx …` if `tsconfig-paths` cannot be resolved)
Expected: a list like `Brioche Bun … 14 lines in g bridge — before 212.00 each → now 12.00 each` and a final total line. Paste the total and the top 5 rows into the PR description — that is the owner's Before / After.

- [ ] **Step 3: Commit**

```bash
git add scripts/audit-unbridged-movements.ts
git commit -m "chore(stock): read-only audit of movements the bridges cannot convert"
```

---

### Task 6: Smoke in the preview, PR

- [ ] **Step 1: Preview from this worktree**

Add (temporarily, do NOT commit) to the worktree's `.claude/launch.json`:
```json
{ "name": "Worktree bridged-stock-maths", "runtimeExecutable": "/bin/sh",
  "runtimeArgs": ["-c", "cd /Users/joshua/dev/fergies-os/.claude/worktrees/bridged-stock-maths && exec /Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin/node node_modules/next/dist/bin/next dev -p 3113"],
  "port": 3113 }
```
`preview_start { name: "Worktree bridged-stock-maths" }`, confirm `lsof -a -p <pid> -d cwd -Fn` prints the worktree path. Open `/inventory`, pick an item from the audit's top rows, open its drawer: the movement track must show gold "… · not counted" rows and the caption "n movements not counted — set how much one each weighs …"; "Theoretical" must equal the audit's `now`. Open `/count` and `/reports` → Inventory tab: no console errors. Screenshot the drawer. Then `preview_stop`, `git checkout .claude/launch.json`.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin HEAD:feat/bridged-stock-maths
gh pr create --base main --head feat/bridged-stock-maths --title "fix(stock): theoretical stock converts through the item's bridges, and shows what it could not count" --body "$(cat <<'EOF'
## What changes for the restaurant
- Stock maths now uses the same "1 each = 85 g" bridges as recipe costing. Before: a recipe using 200 g of Brioche Bun took 200 buns off the shelf. After: 2.35 buns.
- A movement the item has no bridge for is no longer guessed: it is left out, listed in the item drawer in gold as "not counted", with a one-line fix ("set how much one each weighs in Edit").
- Theoretical on-hand changes for the items in the audit below. Counts, prices, recipes: unchanged.

## Before / After (live data, read-only audit)
<paste the audit's total line and top 5 rows>

## How
Spec §2.4 `docs/superpowers/specs/2026-10-03-item-backbone-design.md`; plan `docs/superpowers/plans/2026-10-03-item-backbone-1b-bridged-stock-maths.md`.
`src/lib/movement-qty.ts` (`movementQtyBase`) replaces every bare `convertQty` in `count-expected.ts` and the theoretical-usage report; `LedgerEvent.unbridged` + `LedgerBalance.unbridged`; stock-movements API and drawer expose them. No migration, no live writes.

## Checks
- `npm test` green (new: movement-qty, ledger unbridged, count-expected bridges). `npm run build` green. Lint identical to main.
- Preview: drawer screenshot attached.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

- **Spec coverage (§2.4):** bridged conversion at all six sites (Task 3), exclusion + tally (Tasks 2–3), drawer message (Task 4), report consistency (Task 4), owner-facing before/after (Task 5). Nothing in §2.4 is unplanned.
- **Placeholders:** none — every edit is written out; the audit output is the one value filled at run time.
- **Type consistency:** `movementQtyBase(qty, unit, item) → { qtyBase, unbridged }`, `MOVEMENT_ITEM_SELECT`, `MovementItem`, `Unbridged` (Task 1) are used with those names in Tasks 2–5; `LedgerEvent.unbridged?: Unbridged`, `LedgerBalance.unbridged: number`, `ItemLedger.unbridgedCount`, API `unbridged` / `unbridgedCount` match across Tasks 2–4.
