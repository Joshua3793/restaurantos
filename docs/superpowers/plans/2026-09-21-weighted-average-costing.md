# Weighted-Average Costing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recipe and menu costs use the 30-day weighted average of what was actually paid (Σ line total ÷ Σ frozen received quantity, all suppliers), falling back to the last price with a visible label; every other cost number in the app is byte-identical.

**Architecture:** A new pure-ish module `src/lib/cost-basis.ts` folds qualifying approved invoice lines into one `ItemCostBasis` per item and reads them in ONE Prisma query. `computeRecipeCost` takes an optional price map and tags every line with its basis; `fetchRecipeWithCost(id, { basis })` defaults to `'LAST'` (unchanged) and, on `'AVG_30D'`, recurses into nested prep recipes on the same basis with a per-request memo and a cycle guard. Only the four recipe/menu routes ask for the average. Nothing is stored; no migration; no live-DB write.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma (Supabase pgBouncer) · vitest · Tailwind flat tokens.

Spec: `docs/superpowers/specs/2026-09-21-weighted-average-costing-design.md`.

## Global Constraints

- **No existing number may change** except on the recipe and menu surfaces (`GET /api/recipes`, `GET /api/recipes/[id]`, `GET /api/recipes/[id]/scale`, `GET /api/recipes/search-ingredients`, and `costBasis` added to `GET /api/inventory/[id]`). Every other caller of `computeRecipeCost` / `fetchRecipeWithCost` passes nothing and must produce byte-identical output — Task 2 proves it with a snapshot test. `syncPrepToInventory`, `propagatePrepCostChanges`, `recipe-costs.ts`, `theoretical-cost.ts`, reports, signals, wastage, counts, COGS and price alerts are NOT touched.
- **Nothing is stored.** No schema change, no cached column, no backfill. `ItemCostBasis` is derived at read time.
- `COST_WINDOW_DAYS = 30`. Basis tokens are exactly `'AVG_30D' | 'LAST'`. Fallback reasons are exactly `'no-purchases' | 'implausible'`.
- A line qualifies only when `approved = true`, `session.status = 'APPROVED'`, `splitToSessionId IS NULL`, `session.purchaseDate` in the window, and **both** `Number(rawLineTotal) > 0` and `Number(receivedQtyBase) > 0`. A line contributes to both sums or to neither.
- Plausibility guard uses the existing `IMPLAUSIBLE_PRICE_RATIO` (20) from `src/lib/invoice/line-format.ts` — never a new constant. `last === 0` with a plausible average ⇒ the average is used.
- PREP-linked items (`recipe` relation non-null) are never averaged.
- The recipe list route computes ONE `windowedAvgCost` for the union of ingredient ids on the page; nested preps are memoised per request. No cross-request cache.
- UI copy, verbatim: `Costed at the 30-day average` · ` · N of M ingredients at last price` · row tag `last price` · drawer row label `30-day average` · `No purchases in 30 days — recipes use the last price.` · `Average ignored — {n}× off the last price; check this item's receipts`.
- Prisma `Decimal` arrives as a string in JSON — `Number()` before arithmetic. Prisma singleton from `@/lib/prisma`. No `$executeRaw`. Tailwind flat tokens only (`text-ink-4`, `text-red-text`, `bg-paper`, `border-line`…). Sub-components at module scope.
- vitest does NOT type-check: every task runs `npx tsc --noEmit -p tsconfig.json` (0 errors) and `npx eslint` on changed files (no NEW findings vs HEAD; lint a HEAD copy via `git show HEAD:path`, never `git stash`).
- Subagents never connect to the database, never start a dev server, never run `npm run build`, never run scripts against live data. The controller runs the Task 6 sizing script (read-only) and the isolated build.
- `export PATH="$HOME/Desktop/node-install/bin:$PATH"`. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: `cost-basis.ts` — the fold and the window

**Files:**
- Create: `src/lib/cost-basis.ts`
- Test: `src/lib/__tests__/cost-basis.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const COST_WINDOW_DAYS = 30
  export type CostBasis = 'AVG_30D' | 'LAST'
  export interface ItemCostBasis {
    basis: CostBasis
    pricePerBase: number
    avg?: { pricePerBase: number; paid: number; received: number; lines: number; excluded: number }
    fallbackReason?: 'no-purchases' | 'implausible'
  }
  export interface CostLine { rawLineTotal: unknown; receivedQtyBase: unknown }
  export function foldCostBasis(a: { lines: CostLine[]; lastPricePerBase: number }): ItemCostBasis
  export function costWindow(asOf: Date): { gte: Date; lte: Date }
  export async function windowedAvgCost(itemIds: string[], asOf?: Date): Promise<Map<string, ItemCostBasis>>
  ```
  Every item id passed in gets an entry (an item with no lines gets `{ basis: 'LAST', pricePerBase: last, fallbackReason: 'no-purchases' }`); PREP-linked and unknown ids get no entry.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
import { foldCostBasis, costWindow, COST_WINDOW_DAYS } from '@/lib/cost-basis'

const L = (rawLineTotal: unknown, receivedQtyBase: unknown) => ({ rawLineTotal, receivedQtyBase })

describe('foldCostBasis', () => {
  it('eggplant: NAF 12 lb → 30 each for $41.88 + Sysco 24 each for $70.30 ⇒ $2.077/each', () => {
    const r = foldCostBasis({ lines: [L('41.88', '30'), L('70.30', '24')], lastPricePerBase: 2.929 })
    expect(r.basis).toBe('AVG_30D')
    expect(r.pricePerBase).toBeCloseTo(112.18 / 54, 4)
    expect(r.avg).toMatchObject({ paid: 112.18, received: 54, lines: 2, excluded: 0 })
  })
  it('no qualifying line → LAST, no-purchases, no avg evidence', () => {
    expect(foldCostBasis({ lines: [], lastPricePerBase: 2.93 })).toEqual({ basis: 'LAST', pricePerBase: 2.93, fallbackReason: 'no-purchases' })
  })
  it.each([
    ['credit (negative total)', L('-10', '5')],
    ['negative received', L('10', '-5')],
    ['unpriced line', L(null, '5')],
    ['never frozen', L('10', null)],
    ['zero total', L('0', '5')],
    ['zero received', L('10', '0')],
  ])('%s is excluded from BOTH sums and counted', (_n, bad) => {
    const r = foldCostBasis({ lines: [bad, L('20', '10')], lastPricePerBase: 2 })
    expect(r.avg).toMatchObject({ paid: 20, received: 10, lines: 1, excluded: 1 })
    expect(r.pricePerBase).toBe(2)
  })
  it('only excluded lines → LAST with the evidence counted', () => {
    const r = foldCostBasis({ lines: [L(null, '5')], lastPricePerBase: 3 })
    expect(r).toMatchObject({ basis: 'LAST', pricePerBase: 3, fallbackReason: 'no-purchases', avg: { lines: 0, excluded: 1 } })
  })
  it('average more than 20× ABOVE the last price → LAST, implausible, evidence kept', () => {
    const r = foldCostBasis({ lines: [L('1000', '1')], lastPricePerBase: 2 })
    expect(r).toMatchObject({ basis: 'LAST', pricePerBase: 2, fallbackReason: 'implausible', avg: { pricePerBase: 1000 } })
  })
  it('average more than 20× BELOW the last price → LAST, implausible', () => {
    const r = foldCostBasis({ lines: [L('1', '1000')], lastPricePerBase: 2 })
    expect(r.fallbackReason).toBe('implausible')
  })
  it('exactly 20× is still plausible', () => {
    expect(foldCostBasis({ lines: [L('40', '1')], lastPricePerBase: 2 }).basis).toBe('AVG_30D')
  })
  it('an unpriced item (last = 0) with a plausible average uses the average', () => {
    const r = foldCostBasis({ lines: [L('41.88', '30')], lastPricePerBase: 0 })
    expect(r).toMatchObject({ basis: 'AVG_30D', pricePerBase: 1.396 })
  })
})

describe('costWindow', () => {
  it('is the 30 calendar days ending at asOf, start truncated to UTC midnight (purchaseDate is a UTC-midnight date)', () => {
    const w = costWindow(new Date('2026-09-21T18:30:00Z'))
    expect(w.lte.toISOString()).toBe('2026-09-21T18:30:00.000Z')
    expect(w.gte.toISOString()).toBe('2026-08-22T00:00:00.000Z')
    expect(COST_WINDOW_DAYS).toBe(30)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/__tests__/cost-basis.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `src/lib/cost-basis.ts`

```ts
// The recipe/menu cost basis: what a base unit of an item actually cost us over
// the last COST_WINDOW_DAYS, pooled across every supplier — Σ line total ÷ Σ
// frozen received quantity over the approved invoice lines in the window.
// Derived at read time, never stored (a cached cost is the divergence class the
// spine was cleaned of). Everything outside the recipe/menu surfaces keeps the
// last price: `pricePerBaseUnit(item)`.
import { prisma } from '@/lib/prisma'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'
import { IMPLAUSIBLE_PRICE_RATIO } from '@/lib/invoice/line-format'

export const COST_WINDOW_DAYS = 30
export type CostBasis = 'AVG_30D' | 'LAST'

export interface ItemCostBasis {
  basis: CostBasis
  /** $/base-unit on the chosen basis. On 'LAST' this equals pricePerBaseUnit(item). */
  pricePerBase: number
  /** The average's evidence — present whenever ≥ 1 line was looked at, even when the guard fell back. */
  avg?: { pricePerBase: number; paid: number; received: number; lines: number; excluded: number }
  /** Why an item is NOT on the average. */
  fallbackReason?: 'no-purchases' | 'implausible'
}

export interface CostLine { rawLineTotal: unknown; receivedQtyBase: unknown }

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN }

/**
 * Fold one item's qualifying lines. A line contributes to BOTH sums or to
 * neither: a credit, an unpriced line (Veal Bones with no price must not drag
 * the average toward $0) or a never-frozen receipt is excluded and counted.
 */
export function foldCostBasis(a: { lines: CostLine[]; lastPricePerBase: number }): ItemCostBasis {
  const last = Number(a.lastPricePerBase) > 0 ? Number(a.lastPricePerBase) : 0
  let paid = 0, received = 0, lines = 0, excluded = 0
  for (const l of a.lines) {
    const t = num(l.rawLineTotal), q = num(l.receivedQtyBase)
    if (t > 0 && q > 0) { paid += t; received += q; lines++ } else excluded++
  }
  if (a.lines.length === 0) return { basis: 'LAST', pricePerBase: last, fallbackReason: 'no-purchases' }
  if (lines === 0) return { basis: 'LAST', pricePerBase: last, fallbackReason: 'no-purchases', avg: { pricePerBase: 0, paid, received, lines, excluded } }
  const avgPpb = paid / received
  const avg = { pricePerBase: avgPpb, paid, received, lines, excluded }
  // A historically mis-frozen receipt (a g↔kg slip) must not poison every recipe
  // using the item — the same ratio that disqualifies an offer's pricing.
  const implausible = last > 0 && (avgPpb / last > IMPLAUSIBLE_PRICE_RATIO || last / avgPpb > IMPLAUSIBLE_PRICE_RATIO)
  if (implausible) return { basis: 'LAST', pricePerBase: last, fallbackReason: 'implausible', avg }
  return { basis: 'AVG_30D', pricePerBase: avgPpb, avg }
}

/** purchaseDate is the invoice's own calendar date stored at UTC midnight (parseInvoiceDate). */
export function costWindow(asOf: Date): { gte: Date; lte: Date } {
  const gte = new Date(asOf.getTime() - COST_WINDOW_DAYS * 86_400_000)
  gte.setUTCHours(0, 0, 0, 0)
  return { gte, lte: asOf }
}

/**
 * ONE read for many items. Every non-PREP id passed in gets an entry; PREP-linked
 * items are never averaged (their cost is the recipe's computed cost) and get none.
 */
export async function windowedAvgCost(itemIds: string[], asOf: Date = new Date()): Promise<Map<string, ItemCostBasis>> {
  const out = new Map<string, ItemCostBasis>()
  const ids = Array.from(new Set(itemIds))
  if (ids.length === 0) return out
  const [items, rows] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { id: { in: ids }, recipe: null },
      select: { id: true, ...PRICING_SELECT },
    }),
    prisma.invoiceScanItem.findMany({
      where: {
        matchedItemId: { in: ids },
        approved: true,
        splitToSessionId: null, // RC-split parents out; their clones sum to the parent (same filter as periodPurchases)
        session: { status: 'APPROVED', purchaseDate: costWindow(asOf) },
      },
      select: { matchedItemId: true, rawLineTotal: true, receivedQtyBase: true },
    }),
  ])
  const byItem = new Map<string, CostLine[]>()
  for (const r of rows) {
    if (!r.matchedItemId) continue
    const arr = byItem.get(r.matchedItemId) ?? []
    arr.push(r)
    byItem.set(r.matchedItemId, arr)
  }
  for (const it of items) {
    out.set(it.id, foldCostBasis({ lines: byItem.get(it.id) ?? [], lastPricePerBase: pricePerBaseUnit(asChainItem(it)) }))
  }
  return out
}
```

Check the exact Prisma relation name for "PREP-linked" on `InventoryItem` in `prisma/schema.prisma` (the item↔recipe back-relation used by `where: { recipe: null }` in `scripts/audit-duplicate-items.ts`) and the `InvoiceSession.status` enum value `'APPROVED'` before committing.

- [ ] **Step 4: Run** the test file → PASS. `npx tsc --noEmit -p tsconfig.json` → 0 errors. `npx eslint src/lib/cost-basis.ts src/lib/__tests__/cost-basis.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cost-basis.ts src/lib/__tests__/cost-basis.test.ts
git commit -m "feat(costing): the 30-day weighted-average cost basis — Σ paid ÷ Σ received, derived at read"
```

---

### Task 2: `computeRecipeCost` takes a price map and tags every line

**Files:**
- Modify: `src/lib/recipeCosts.ts` (`IngredientWithCost` ~:16-38, `computeRecipeCost` ~:87-175 + its return)
- Test: `src/lib/__tests__/recipeCosts.test.ts` (append)

**Interfaces:**
- Consumes: `ItemCostBasis`, `CostBasis` from Task 1.
- Produces:
  - `IngredientWithCost.costBasis: CostBasis` (new required field)
  - `computeRecipeCost(recipe, opts?: { prices?: Map<string, ItemCostBasis> })` — return gains `basisSummary: { basis: CostBasis; avgLines: number; lastLines: number }`
  - Nested prep lines carry `ing._linkedRecipeCostBasis?: CostBasis` (set by Task 3; `'LAST'` when absent).

- [ ] **Step 1: Failing tests** (append to `recipeCosts.test.ts`)

```ts
import type { ItemCostBasis } from '@/lib/cost-basis'

describe('computeRecipeCost — cost basis', () => {
  const avg = (p: number): ItemCostBasis => ({ basis: 'AVG_30D', pricePerBase: p, avg: { pricePerBase: p, paid: 1, received: 1, lines: 1, excluded: 0 } })
  const last = (p: number): ItemCostBasis => ({ basis: 'LAST', pricePerBase: p, fallbackReason: 'no-purchases' })

  it('with no map every line is LAST and the output is byte-identical to today', () => {
    const r = recipe([ing({ id: 'a', inventoryItemId: 'oil', inventoryItem: oilItem, qtyBase: 500, unit: 'ml' })])
    const before = computeRecipeCost(r)
    const after = computeRecipeCost(r, {})
    expect(after).toEqual({ ...before, basisSummary: { basis: 'LAST', avgLines: 0, lastLines: 1 } })
    expect(after.ingredients[0].costBasis).toBe('LAST')
    expect(after.ingredients[0].lineCost).toBeCloseTo(500 * 0.002, 6)
  })
  it('a mapped AVG item prices at the map, is tagged, and the summary counts it', () => {
    const r = recipe([
      ing({ id: 'a', inventoryItemId: 'oil', inventoryItem: oilItem, qtyBase: 500, unit: 'ml' }),
      ing({ id: 'b', inventoryItemId: 'chk', inventoryItem: chickenItem, qtyBase: 1000, unit: 'g' }),
    ])
    const out = computeRecipeCost(r, { prices: new Map([['oil', avg(0.003)], ['chk', last(20 / 11000)]]) })
    expect(out.ingredients[0]).toMatchObject({ costBasis: 'AVG_30D', pricePerBaseUnit: 0.003, lineCost: 1.5 })
    expect(out.ingredients[1].costBasis).toBe('LAST')
    expect(out.basisSummary).toEqual({ basis: 'AVG_30D', avgLines: 1, lastLines: 1 })
  })
  it('a nested prep line takes the basis Task 3 resolved for it', () => {
    const r = recipe([ing({ id: 'p', linkedRecipeId: 'r2', linkedRecipe: { name: 'Stock', inventoryItem: null }, qtyBase: 100, unit: 'ml', _linkedRecipeCostPerUnit: 0.01, _linkedRecipeYieldUnit: 'ml', _linkedRecipeCostBasis: 'AVG_30D' })])
    const out = computeRecipeCost(r, { prices: new Map() })
    expect(out.ingredients[0]).toMatchObject({ costBasis: 'AVG_30D', lineCost: 1 })
    expect(out.basisSummary.basis).toBe('AVG_30D')
  })
  it('a custom ingredient is LAST and counts as a last line', () => {
    const out = computeRecipeCost(recipe([ing({ id: 'c', customName: 'pinch of love', qtyBase: 1, unit: 'g' })]), { prices: new Map() })
    expect(out.ingredients[0].costBasis).toBe('LAST')
    expect(out.basisSummary).toEqual({ basis: 'LAST', avgLines: 0, lastLines: 1 })
  })
})
```

- [ ] **Step 2: Run** → FAIL (`basisSummary` undefined, `costBasis` missing).

- [ ] **Step 3: Implement.** In `IngredientWithCost` add:

```ts
  /** Which price this line was costed at: the 30-day average or the last price. */
  costBasis: CostBasis
```

In `computeRecipeCost`'s parameter type add to each ingredient `_linkedRecipeCostBasis?: CostBasis`, add the second parameter `opts: { prices?: Map<string, ItemCostBasis> } = {}`, and extend the return type with `basisSummary: { basis: CostBasis; avgLines: number; lastLines: number }`. Inside the map, declare `let costBasis: CostBasis = 'LAST'` beside the other `let`s, then:

```ts
    if (ing.inventoryItem) {
      const mapped = ing.inventoryItemId ? opts.prices?.get(ing.inventoryItemId) : undefined
      pricePerBaseUnit   = mapped ? mapped.pricePerBase : chainPricePerBaseUnit(asChainItem(ing.inventoryItem))
      costBasis          = mapped?.basis ?? 'LAST'
      // …rest of the branch unchanged
    } else if (ing.linkedRecipe) {
      pricePerBaseUnit   = ing._linkedRecipeCostPerUnit ?? 0
      costBasis          = ing._linkedRecipeCostBasis ?? 'LAST'
      // …rest unchanged
    }
```

Add `costBasis,` to the returned line object. After the map:

```ts
  const avgLines  = ingredientsWithCost.filter(i => i.costBasis === 'AVG_30D').length
  const lastLines = ingredientsWithCost.length - avgLines
  const basisSummary = { basis: (avgLines > 0 ? 'AVG_30D' : 'LAST') as CostBasis, avgLines, lastLines }
```

and include `basisSummary` in the return. Import `type { CostBasis, ItemCostBasis } from '@/lib/cost-basis'` (type-only, so no Prisma import cycle at runtime).

- [ ] **Step 4: Run** the whole file → PASS, and `npm test` (existing callers destructure named fields, so the added key is inert). `tsc` → 0. If `tsc` reports places that construct `IngredientWithCost` literals without `costBasis` (e.g. `src/components/recipes/shared.tsx` ~:1153, :1200 optimistic rows, `src/app/api/recipes/[id]/scale/route.ts`), add `costBasis: 'LAST'` to each — list them in the report.

- [ ] **Step 5: Commit**

```bash
git add src/lib/recipeCosts.ts src/lib/__tests__/recipeCosts.test.ts src/components/recipes/shared.tsx
git commit -m "feat(costing): computeRecipeCost takes a price map and tags every line with its cost basis"
```

---

### Task 3: `fetchRecipeWithCost(id, { basis })` recurses into nested preps

**Files:**
- Modify: `src/lib/recipeCosts.ts` (`RecipeWithCost` ~:46, `fetchRecipeWithCost` ~:244-330)
- Test: `src/lib/__tests__/recipe-basis.test.ts` (new; mocks `@/lib/prisma`)

**Interfaces:**
- Consumes: Task 1 `windowedAvgCost`, Task 2 `computeRecipeCost(recipe, { prices })` and `_linkedRecipeCostBasis`.
- Produces:
  ```ts
  export interface CostContext { basis: CostBasis; prices: Map<string, ItemCostBasis>; memo: Map<string, RecipeWithCost | null>; visiting: Set<string> }
  export async function costContext(basis: CostBasis, itemIds: string[], asOf?: Date): Promise<CostContext>
  export async function fetchRecipeWithCost(id: string, opts?: { basis?: CostBasis; ctx?: CostContext }): Promise<RecipeWithCost | null>
  export async function resolveLinkedRecipes<T extends { linkedRecipeId: string | null; linkedRecipe: { yieldUnit: string; inventoryItem: … } | null; unit: string }>(ingredients: T[], ctx: CostContext | null): Promise<Array<T & { _linkedRecipeCostPerUnit: number; _linkedRecipeYieldUnit: string; _linkedRecipeCostBasis: CostBasis }>>
  ```
  `RecipeWithCost` gains `basisSummary`. `resolveLinkedRecipes` is what Task 4's list route uses so it never re-implements the recursion.

- [ ] **Step 1: Failing tests** — mock Prisma with an in-memory recipe graph:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const graph: Record<string, any> = {}
const findUnique = vi.fn(async ({ where }: any) => graph[where.id] ?? null)
const scanFindMany = vi.fn(async () => [])
const itemFindMany = vi.fn(async ({ where }: any) => (where.id.in as string[]).filter(id => id === 'flour' || id === 'water').map(id => ({ id, ...ITEMS[id] })))
vi.mock('@/lib/prisma', () => ({ prisma: {
  recipe: { findUnique: (a: any) => findUnique(a) },
  invoiceScanItem: { findMany: (a: any) => scanFindMany(a) },
  inventoryItem: { findMany: (a: any) => itemFindMany(a) },
} }))
import { fetchRecipeWithCost } from '@/lib/recipeCosts'

const ITEMS: Record<string, any> = {
  flour: { itemName: 'Flour', dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'bag', per: 20000 }], pricing: { mode: 'PACK', purchasePrice: 20 }, allergens: ['Wheat'] },
  water: { itemName: 'Water', dimension: 'VOLUME', baseUnit: 'ml', packChain: [{ unit: 'l', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 0 }, allergens: [] },
}
const base = (id: string, over: any) => ({
  id, name: id, type: 'PREP', categoryId: 'c', category: { name: 'c', color: null }, inventoryItemId: null,
  baseYieldQty: '1000', yieldUnit: 'g', portionSize: null, portionUnit: null, menuPrice: null, isActive: true, notes: null,
  steps: [], activeMinutes: null, passiveMinutes: null, passiveNote: null, stages: [], method: [], createdAt: new Date(), updatedAt: new Date(),
  baseIngredientId: null, prepItems: [], ...over,
})
const invIng = (id: string, itemId: string, qty: string, unit: string) => ({ id, sortOrder: 0, qtyBase: qty, unit, notes: null, recipePercent: null, inventoryItemId: itemId, linkedRecipeId: null, customName: null, inventoryItem: ITEMS[itemId], linkedRecipe: null })
const prepIng = (id: string, recipeId: string, qty: string, unit: string) => ({ id, sortOrder: 1, qtyBase: qty, unit, notes: null, recipePercent: null, inventoryItemId: null, linkedRecipeId: recipeId, customName: null, inventoryItem: null,
  // the spine of the linked prep: syncPrepToInventory wrote $0.005/g (LAST basis)
  linkedRecipe: { name: recipeId, yieldUnit: 'g', inventoryItem: { allergens: ['Wheat'], dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'batch', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 5 } } } })

beforeEach(() => {
  for (const k of Object.keys(graph)) delete graph[k]
  findUnique.mockClear(); scanFindMany.mockClear()
  graph.dough = base('dough', { ingredients: [invIng('i1', 'flour', '1000', 'g')] })              // LAST: $1/batch ($0.001/g)
  graph.pizza = base('pizza', { type: 'MENU', menuPrice: '10', portionSize: '500', portionUnit: 'g', ingredients: [prepIng('i2', 'dough', '500', 'g')] })
})

describe('fetchRecipeWithCost basis', () => {
  it('default (no basis) reads the nested prep off its spine — byte-identical to today', async () => {
    const r = await fetchRecipeWithCost('pizza')
    expect(r!.ingredients[0]).toMatchObject({ pricePerBaseUnit: 0.005, lineCost: 2.5, costBasis: 'LAST' })
    expect(r!.basisSummary).toEqual({ basis: 'LAST', avgLines: 0, lastLines: 1 })
    expect(scanFindMany).not.toHaveBeenCalled()
  })
  it('AVG_30D recurses: the nested prep is re-costed from its raw ingredients at their averages', async () => {
    scanFindMany.mockResolvedValueOnce([{ matchedItemId: 'flour', rawLineTotal: '30', receivedQtyBase: '10000' }]) // flour avg $0.003/g
    const r = await fetchRecipeWithCost('pizza', { basis: 'AVG_30D' })
    // dough on AVG = 1000 g × $0.003 = $3/batch = $0.003/g; pizza uses 500 g → $1.50
    expect(r!.ingredients[0]).toMatchObject({ pricePerBaseUnit: 0.003, lineCost: 1.5, costBasis: 'AVG_30D' })
    expect(r!.basisSummary).toEqual({ basis: 'AVG_30D', avgLines: 1, lastLines: 1 })
  })
  it('a nested prep whose raw lines ALL fell back is tagged LAST (and priced on the recursion, not the spine)', async () => {
    const r = await fetchRecipeWithCost('pizza', { basis: 'AVG_30D' })   // no scan lines → flour LAST
    expect(r!.ingredients[0]).toMatchObject({ pricePerBaseUnit: 0.001, costBasis: 'LAST' })
  })
  it('memo: a prep used twice in one request is fetched once', async () => {
    graph.pizza.ingredients.push(prepIng('i3', 'dough', '100', 'g'))
    await fetchRecipeWithCost('pizza', { basis: 'AVG_30D' })
    expect(findUnique.mock.calls.filter(c => c[0].where.id === 'dough')).toHaveLength(1)
  })
  it('cycle: A ⊃ B ⊃ A costs the repeated link at the spine, tagged LAST, and terminates', async () => {
    graph.dough.ingredients.push(prepIng('i4', 'pizza', '10', 'g'))
    const r = await fetchRecipeWithCost('pizza', { basis: 'AVG_30D' })
    expect(r).not.toBeNull()
    const dough = await fetchRecipeWithCost('dough', { basis: 'AVG_30D' })
    expect(dough!.ingredients.find(i => i.linkedRecipeId === 'pizza')!.costBasis).toBe('LAST')
  })
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Add to `RecipeWithCost`: `basisSummary: { basis: CostBasis; avgLines: number; lastLines: number }`. Add:

```ts
export interface CostContext {
  basis: CostBasis
  prices: Map<string, ItemCostBasis>
  /** One fetch per prep per request. */
  memo: Map<string, RecipeWithCost | null>
  /** Recipes on the current recursion path — a repeat is a cycle. */
  visiting: Set<string>
}

/** Build the per-request context: ONE windowedAvgCost for every raw item id given. */
export async function costContext(basis: CostBasis, itemIds: string[], asOf?: Date): Promise<CostContext> {
  const prices = basis === 'AVG_30D' ? await windowedAvgCost(itemIds, asOf) : new Map<string, ItemCostBasis>()
  return { basis, prices, memo: new Map(), visiting: new Set() }
}

/**
 * Cost each linked-prep ingredient. LAST (ctx null): the linked item's spine, as
 * always. AVG_30D: recurse into the prep on the same basis — its cost per yield
 * unit is its averaged batch cost ÷ its yield — memoised per request; a cycle
 * falls back to the spine and is tagged LAST.
 */
export async function resolveLinkedRecipes<T extends { linkedRecipeId: string | null; unit: string; linkedRecipe: Parameters<typeof linkedRecipeUnitCost>[0] | null }>(
  ingredients: T[], ctx: CostContext | null,
) {
  const out = []
  for (const ing of ingredients) {
    let costPerUnit = 0, yieldUnit = ing.unit, costBasis: CostBasis = 'LAST'
    if (ing.linkedRecipe) {
      const spine = linkedRecipeUnitCost(ing.linkedRecipe)
      costPerUnit = spine.costPerUnit; yieldUnit = spine.yieldUnit
      if (ctx && ctx.basis === 'AVG_30D' && ing.linkedRecipeId && !ctx.visiting.has(ing.linkedRecipeId)) {
        const nested = await fetchRecipeWithCost(ing.linkedRecipeId, { ctx })
        if (nested && nested.baseYieldQty > 0) {
          // The spine prices per the synced item's canonical base unit (g/ml);
          // convert the recipe's yield to that unit so the two agree.
          const perBase = nested.totalCost / convertQty(nested.baseYieldQty, nested.yieldUnit, yieldUnit)
          if (Number.isFinite(perBase) && perBase >= 0) { costPerUnit = perBase; costBasis = nested.basisSummary.basis }
        }
      }
    }
    out.push({ ...ing, _linkedRecipeCostPerUnit: costPerUnit, _linkedRecipeYieldUnit: yieldUnit, _linkedRecipeCostBasis: costBasis })
  }
  return out
}
```

Rewrite `fetchRecipeWithCost(id, opts: { basis?: CostBasis; ctx?: CostContext } = {})`:
1. `if (opts.ctx?.memo.has(id)) return opts.ctx.memo.get(id)!`
2. fetch the recipe exactly as today;
3. `const rawIds = recipe.ingredients.flatMap(i => i.inventoryItemId ? [i.inventoryItemId] : [])`; `const ctx = opts.ctx ?? (opts.basis === 'AVG_30D' ? await costContext('AVG_30D', rawIds) : null)`; when `opts.ctx` was given but the map lacks some of `rawIds` (a nested prep's raw items the caller didn't know about), call `windowedAvgCost(missing)` and merge into `ctx.prices`;
4. `ctx?.visiting.add(id)`; `const ingredientsWithLinked = await resolveLinkedRecipes(recipe.ingredients, ctx)`; `ctx?.visiting.delete(id)`;
5. `computeRecipeCost({ ...recipe, ingredients: ingredientsWithLinked }, { prices: ctx?.prices })` and put `basisSummary` on the result; `ctx?.memo.set(id, result)`.

`convertQty` is in `@/lib/uom`; `windowedAvgCost` is a runtime import from `@/lib/cost-basis` (both modules import the Prisma singleton — that is fine, neither is client code).

- [ ] **Step 4: Run** the file + `npm test` → PASS; `tsc` → 0; eslint.

- [ ] **Step 5: Commit**

```bash
git add src/lib/recipeCosts.ts src/lib/__tests__/recipe-basis.test.ts
git commit -m "feat(costing): fetchRecipeWithCost on the 30-day basis recurses into nested preps, memoised, cycle-safe"
```

---

### Task 4: The four recipe/menu routes ask for the average; the item route exposes the basis

**Files:**
- Modify: `src/app/api/recipes/route.ts` (~:100-120), `src/app/api/recipes/[id]/route.ts` (:13, :137), `src/app/api/recipes/[id]/scale/route.ts` (:21), `src/app/api/recipes/search-ingredients/route.ts` (~:93-97), `src/app/api/inventory/[id]/route.ts` (GET, ~:25)

**Interfaces:**
- Consumes: Task 3 `costContext`, `resolveLinkedRecipes`, `fetchRecipeWithCost(id, { basis })`; Task 1 `windowedAvgCost`.
- Produces: `GET /api/recipes` items gain `basisSummary`; ingredient lines gain `costBasis`; `GET /api/inventory/[id]` gains `costBasis: ItemCostBasis | null` (null for PREP-linked items).

- [ ] **Step 1: List route.** Replace the inline `ingredientsWithLinked` map + `computeRecipeCost` with:

```ts
  const rawIds = recipes.flatMap(r => r.ingredients.flatMap(i => i.inventoryItemId ? [i.inventoryItemId] : []))
  const ctx = await costContext('AVG_30D', rawIds)
  const result = []
  for (const recipe of recipes) {
    const ingredientsWithLinked = await resolveLinkedRecipes(recipe.ingredients, ctx)
    const { totalCost, costPerPortion, foodCostPct, dimensionConflicts, ingredients, basisSummary } = computeRecipeCost(
      { ...recipe, ingredients: ingredientsWithLinked }, { prices: ctx.prices },
    )
    result.push({ …the existing literal…, basisSummary })
  }
```

(a `for` loop, not `.map(async)`, so the memo is shared sequentially and Prisma isn't hit N-wide.)

- [ ] **Step 2: Detail + scale routes.** `fetchRecipeWithCost(params.id, { basis: 'AVG_30D' })` at all three call sites (GET, the post-PATCH re-read, scale). The PATCH handler's `propagatePrepCostChanges`/`resyncPrepRecipe` calls stay exactly as they are (they cost on LAST internally).

- [ ] **Step 3: search-ingredients.** For `invResults`: `const basis = await windowedAvgCost(invItems.map(i => i.id))` then `pricePerBaseUnit: basis.get(item.id)?.pricePerBase ?? pricePerBaseUnit(asChainItem(item))` and add `costBasis: basis.get(item.id)?.basis ?? 'LAST'`. **Prep results keep the spine** (recursing 50 preps per keystroke is not worth it; the saved recipe shows the averaged cost) — add a one-line comment saying so and `costBasis: 'LAST'`. Report this as a deliberate deviation from the spec's "the cost shown while building is the cost the saved recipe will show" — it holds for inventory items, not for preps.

- [ ] **Step 4: Inventory GET.** After `withPpb(item)`: `const costBasis = item.recipe ? null : (await windowedAvgCost([item.id])).get(item.id) ?? null` and return `{ ...withPpb(item), costBasis }`.

- [ ] **Step 5: Verify.** `tsc` → 0; `npm test`; eslint on the five files. There is no route test harness — in the report, paste the three exact `curl`-style checks the controller should run against the dev server: `GET /api/recipes?type=MENU` has `basisSummary` on each row; `GET /api/recipes/<id>` ingredient rows have `costBasis`; `GET /api/inventory/<eggplant id>` has `costBasis.avg.lines ≥ 1`.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/recipes "src/app/api/inventory/[id]/route.ts"
git commit -m "feat(costing): recipe and menu routes cost on the 30-day average; the item route exposes the basis"
```

---

### Task 5: What the chef sees

**Files:**
- Modify: `src/components/recipes/shared.tsx` (`IngredientWithCost` ~:63-80, `RecipeWithCost` ~:105-116, the cost table rows ~:540-550, the cost summary ~:563-580; `IngredientRow` display ~:686 if the editable rows show a cost)
- Modify: `src/components/inventory/InventoryItemDrawer.tsx` (the Price block ~:760-800)
- Test: none (pure copy helpers are inline; verified by the click-through)

- [ ] **Step 1: Types.** Add `costBasis?: 'AVG_30D' | 'LAST'` to the client `IngredientWithCost` and `basisSummary?: { basis: 'AVG_30D' | 'LAST'; avgLines: number; lastLines: number }` to the client `RecipeWithCost` (optional on the client: cached/optimistic rows may lack them).

- [ ] **Step 2: Panel copy.** Module-scope helper in `shared.tsx`:

```tsx
function basisCaption(s: RecipeWithCost['basisSummary']): string | null {
  if (!s || s.basis !== 'AVG_30D') return null
  const n = s.avgLines + s.lastLines
  return s.lastLines === 0 ? 'Costed at the 30-day average' : `Costed at the 30-day average · ${s.lastLines} of ${n} ingredients at last price`
}
```

Under the cost summary grid render `{basisCaption(recipe.basisSummary) && <p className="text-[11px] text-ink-4 -mt-4 mb-6">{basisCaption(recipe.basisSummary)}</p>}`. In the read-only cost table row, before the amount: `{recipe.basisSummary?.basis === 'AVG_30D' && ing.costBasis === 'LAST' && <span className="mr-1.5 text-[10px] text-ink-4">last price</span>}`. No tag when the recipe itself is on LAST (nothing to contrast with).

- [ ] **Step 3: Drawer.** The drawer's item type gains `costBasis?: ItemCostBasis | null` (import the type from `@/lib/cost-basis` — type-only import; the module imports Prisma at runtime so it must be `import type`). Module-scope:

```tsx
function CostBasisRow({ cb, baseUnit, last }: { cb: ItemCostBasis; baseUnit: string; last: number }) {
  const label = <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em]">30-day average</div>
  if (cb.fallbackReason === 'implausible' && cb.avg) {
    const ratio = Math.round(Math.max(cb.avg.pricePerBase / last, last / cb.avg.pricePerBase))
    return <div>{label}<div className="text-[13px] text-red-text mt-1">Average ignored — {ratio}× off the last price; check this item's receipts</div></div>
  }
  if (cb.basis !== 'AVG_30D' || !cb.avg) {
    return <div>{label}<div className="text-[13px] text-ink-3 mt-1">No purchases in 30 days — recipes use the last price.</div></div>
  }
  const delta = last > 0 ? Math.round((cb.avg.pricePerBase / last - 1) * 100) : null
  return (
    <div>{label}
      <div className="font-medium text-ink mt-1">{formatPricePerBase(cb.avg.pricePerBase, baseUnit)}
        <span className="text-ink-3 font-normal"> · {cb.avg.lines} invoice{cb.avg.lines === 1 ? '' : 's'} · {formatCurrency(cb.avg.paid)} for {cb.avg.received.toLocaleString()} {baseUnit}{delta !== null ? ` · ${delta > 0 ? '+' : ''}${delta} % vs last price` : ''}</span>
      </div>
    </div>
  )
}
```

Render it directly under the existing Price block for non-PREP items when `item.costBasis` is present. Reuse the block's existing `formatPricePerBase`/`formatCurrency` imports.

- [ ] **Step 4: Verify.** `tsc` → 0; eslint on both files; `npm test`. In the report give the controller a 4-step click-through: Menu → any dish → caption + tags; Recipe Book → a prep with a nested prep; Inventory → Eggplant drawer → 30-day average row; Inventory → an item not bought in 30 days → the fallback sentence.

- [ ] **Step 5: Commit**

```bash
git add src/components/recipes/shared.tsx src/components/inventory/InventoryItemDrawer.tsx
git commit -m "feat(costing): the recipe panel says which basis it is costed at; the item drawer shows the 30-day average"
```

---

### Task 6: Sizing (controller-run, read-only), docs, build

**Files:**
- Create: `docs/audits/2026-09-21-weighted-average-costing/wac-sizing.ts`
- Modify: `CLAUDE.md` ("The spine" section), `docs/superpowers/specs/2026-09-21-weighted-average-costing-design.md` (Status + "As built")

- [ ] **Step 1: The sizing script** (the implementer writes it; **the controller runs it**; it only reads):

```ts
/** READ-ONLY. For every non-PREP item: last vs 30-day average, basis, guard trips.
 *  For every recipe: cost per portion / batch cost LAST → AVG_30D. Run: npx tsx <this file> */
import { prisma } from '@/lib/prisma'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'
import { windowedAvgCost } from '@/lib/cost-basis'
import { fetchRecipeWithCost } from '@/lib/recipeCosts'

async function main() {
  const items = await prisma.inventoryItem.findMany({ where: { isActive: true, recipe: null, mergedIntoId: null }, select: { id: true, itemName: true, baseUnit: true, ...PRICING_SELECT } })
  const basis = await windowedAvgCost(items.map(i => i.id))
  const rows = items.map(i => { const b = basis.get(i.id)!; const last = pricePerBaseUnit(asChainItem(i)); return { item: i.itemName, unit: i.baseUnit, last, basis: b.basis, avg: b.avg?.pricePerBase ?? null, lines: b.avg?.lines ?? 0, excluded: b.avg?.excluded ?? 0, why: b.fallbackReason ?? '', delta: b.avg && last > 0 ? +((b.avg.pricePerBase / last - 1) * 100).toFixed(1) : null } })
  const onAvg = rows.filter(r => r.basis === 'AVG_30D')
  console.log(`${rows.length} items · ${onAvg.length} on AVG_30D · ${rows.filter(r => r.why === 'no-purchases').length} no purchases · ${rows.filter(r => r.why === 'implausible').length} implausible · ${rows.reduce((n, r) => n + r.excluded, 0)} excluded lines`)
  console.log('\n=== IMPLAUSIBLE ==='); console.table(rows.filter(r => r.why === 'implausible'))
  console.log('\n=== TOP MOVERS (items) ==='); console.table([...onAvg].sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)).slice(0, 25))

  const recipes = await prisma.recipe.findMany({ where: { isActive: true }, select: { id: true, name: true, type: true } })
  const out = []
  for (const r of recipes) {
    const [a, b] = await Promise.all([fetchRecipeWithCost(r.id), fetchRecipeWithCost(r.id, { basis: 'AVG_30D' })])
    if (!a || !b) continue
    out.push({ recipe: r.name, type: r.type, batchLast: +a.totalCost.toFixed(2), batchAvg: +b.totalCost.toFixed(2), ppLast: a.costPerPortion, ppAvg: b.costPerPortion, fcLast: a.foodCostPct, fcAvg: b.foodCostPct, avgLines: b.basisSummary.avgLines, lastLines: b.basisSummary.lastLines, deltaPct: a.totalCost > 0 ? +((b.totalCost / a.totalCost - 1) * 100).toFixed(1) : null })
  }
  console.log('\n=== TOP MOVERS (recipes) ==='); console.table(out.sort((x, y) => Math.abs(y.deltaPct ?? 0) - Math.abs(x.deltaPct ?? 0)).slice(0, 30))
  const { writeFileSync } = await import('node:fs')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  writeFileSync(`wac-sizing-${stamp}.json`, JSON.stringify({ items: rows, recipes: out }, null, 2))
  console.log(`\nfull dump → wac-sizing-${stamp}.json`)
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
```

Check `mergedIntoId` is the tombstone column's name in `prisma/schema.prisma` before committing. `tsx` resolves `@/` via tsconfig paths — confirm by running `npx tsc --noEmit` including the file (or use relative imports like the other audit scripts).

- [ ] **Step 2: CLAUDE.md.** In "The spine", after the bridged-RATE bullet, add:

```markdown
- **Recipe and menu costs are on the 30-day weighted average** (`src/lib/cost-basis.ts`: `windowedAvgCost` = Σ `rawLineTotal` ÷ Σ frozen `receivedQtyBase` over approved, non-split lines in the last `COST_WINDOW_DAYS`, all suppliers; a line counts only when both are > 0; > 20× off the last price ⇒ ignored). Derived at read, never stored. Only `GET /api/recipes`, `/api/recipes/[id]`, `/[id]/scale` and `search-ingredients` ask for it (`fetchRecipeWithCost(id, { basis: 'AVG_30D' })`, which recurses into nested preps memoised per request); every other caller defaults to `'LAST'` and is unchanged — `syncPrepToInventory` still writes the LAST-price cost to a prep's linked item, so valuation, counts, COGS, theoretical usage and alerts never see the average. Each ingredient line carries `costBasis`; a recipe carries `basisSummary`. Never add a stored average.
```

- [ ] **Step 3: Spec.** `**Status:**` → implemented; append "As built" with deviations (search-ingredients prep results stay on the spine; anything the review changed) and the sizing headline numbers.

- [ ] **Step 4 (controller): run the sizing script** (read-only) from the worktree, hand the top movers + implausible list to the user. **Step 5 (controller): isolated build** — `npm test`, `tsc`, `npm run build` (sandbox disabled: `next/font` fetches Google Fonts) → `✓ Compiled`.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-21-weighted-average-costing-design.md docs/audits/2026-09-21-weighted-average-costing/wac-sizing.ts
git commit -m "docs: recipe and menu costs are on the 30-day weighted average; sizing evidence"
```

---

## Self-Review Notes

- **Spec coverage:** §1 fold + window + guard → Task 1 · §2 price map, tags, `basisSummary`, recursion/memo/cycle, the four AVG callers, LAST default → Tasks 2–4 · §3 panel caption/tags, drawer row, picker → Tasks 4–5 · §4 edge cases → Task 1 tests (exclusions) + Task 3 tests (cycle) · §6 tests → per task · §7 sizing → Task 6.
- **Deviation recorded up front:** the ingredient picker averages inventory items but not prep results (spec §2 last bullet) — Task 4 Step 3, to be written into "As built".
- **Type consistency:** `ItemCostBasis` / `CostBasis` defined once (Task 1) and imported as types by Tasks 2, 3, 5; `_linkedRecipeCostBasis` set by Task 3's `resolveLinkedRecipes` and read by Task 2's `computeRecipeCost`; `basisSummary` shape identical in Task 2's return, Task 3's `RecipeWithCost`, Task 5's client type; `costContext`/`resolveLinkedRecipes` names match between Task 3 and Task 4.
- **Byte-identical proof:** Task 2's first test (no map ⇒ identical object plus `basisSummary`) and Task 3's first test (default basis ⇒ spine read, no scan query) are the "no number moves" gates; Task 6's sizing shows what the recipe pages WILL move by.
