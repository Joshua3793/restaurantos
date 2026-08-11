# Stock in Hand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Stock in Hand" view mode to `/inventory` that reports each item's last physically counted quantity at current prices with no theoretical movement applied, plus an Excel export of exactly that view carrying five KPIs and filter provenance.

**Architecture:** Three new pure modules (`stock-in-hand.ts`, `inventory-pills.ts`) and one extracted server module (`inventory-list.ts`) are shared by the page and the export route, so the on-screen numbers and the spreadsheet cannot drift. The page derives everything client-side from data `GET /api/inventory` already returns — no new fetch. The export route reuses the list route's own fetch function.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma · `xlsx` (already a dependency) · vitest · Tailwind

**Spec:** `docs/superpowers/specs/2026-08-11-stock-in-hand-design.md`

**Branch:** `feat/stock-in-hand-view` (already created, spec already committed)

## Global Constraints

- Quantity source is `InventoryItem.lastCountQty` — never `stockOnHand`, never `countedStock`.
- Valuation price is the current computed `pricePerBaseUnit` — never `InventorySnapshot.pricePerBaseUnit`.
- `lastCountQty` is a Prisma `Decimal`, serialized as a **string** over JSON. Wrap with `Number()` at every boundary.
- `lastCountQty` is in **base units**. Quantity *display* converts base → count UOM via `convertBaseToCountUom`. Value does **not** convert — it is `baseQty × pricePerBaseUnit`.
- Never-counted items are shown, not hidden: `—` in the table, blank in the sheet, `0` contribution to value.
- Tailwind numbered color classes (`bg-red-500`) are broken in this project. Use flat tokens only (`bg-red`, `text-red-text`, `bg-gold-soft`, `text-gold-2`, `text-ink-3`, `border-line`).
- The basis line copy is fixed, verbatim: `Showing last physically counted quantities at current prices. No sales, prep, wastage or purchase movement applied.`
- Do not change how theoretical stock is computed.
- Run `npm run build` only in an isolated worktree — building in the main checkout while `next dev` runs produces bogus failures.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/stock-in-hand.ts` *(create)* | Pure quantity/value/KPI math. No Prisma, no React. |
| `src/lib/__tests__/stock-in-hand.test.ts` *(create)* | vitest coverage for the above. |
| `src/lib/inventory-pills.ts` *(create)* | Pure pill predicate shared by page and export. |
| `src/lib/__tests__/inventory-pills.test.ts` *(create)* | vitest coverage for the above. |
| `src/lib/inventory-list.ts` *(create)* | The list route's item fetch, extracted so the export reuses it verbatim. |
| `src/app/api/inventory/route.ts` *(modify, GET at 40–215)* | `GET` becomes a thin wrapper over `fetchInventoryList`. |
| `src/app/api/inventory/export/route.ts` *(modify, whole file)* | `MANAGER+` guard; `?view=stock-in-hand` workbook. |
| `src/app/inventory/page.tsx` *(modify)* | View-mode toggle, basis line, basis-aware columns/sort/KPIs, role-gated export buttons. |

---

### Task 1: Stock in Hand math

**Files:**
- Create: `src/lib/stock-in-hand.ts`
- Test: `src/lib/__tests__/stock-in-hand.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `StockInHandItem`, `StockInHandKpis`, `stockInHandQty(item): number | null`, `stockInHandValue(item): number`, `theoreticalQty(item): number`, `stockInHandKpis(items): StockInHandKpis`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/stock-in-hand.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  stockInHandQty, stockInHandValue, theoreticalQty, stockInHandKpis,
  type StockInHandItem,
} from '../stock-in-hand'

const item = (over: Partial<StockInHandItem> = {}): StockInHandItem => ({
  lastCountQty: 10,
  lastCountDate: '2026-08-01T00:00:00.000Z',
  pricePerBaseUnit: 2,
  theoreticalStock: 8,
  ...over,
})

describe('stockInHandQty', () => {
  it('returns the last counted quantity', () => {
    expect(stockInHandQty(item())).toBe(10)
  })

  it('parses Prisma Decimals that arrive as strings', () => {
    expect(stockInHandQty(item({ lastCountQty: '12.5' }))).toBe(12.5)
  })

  it('returns null when never counted', () => {
    expect(stockInHandQty(item({ lastCountQty: null }))).toBeNull()
    expect(stockInHandQty(item({ lastCountQty: undefined }))).toBeNull()
  })

  it('returns 0 for a genuine zero count, not null', () => {
    expect(stockInHandQty(item({ lastCountQty: 0 }))).toBe(0)
  })
})

describe('stockInHandValue', () => {
  it('values the counted quantity at the current price', () => {
    expect(stockInHandValue(item({ lastCountQty: 10, pricePerBaseUnit: 2 }))).toBe(20)
  })

  it('parses a string price', () => {
    expect(stockInHandValue(item({ lastCountQty: 4, pricePerBaseUnit: '1.25' }))).toBe(5)
  })

  it('is 0 when never counted, however large the theoretical stock', () => {
    expect(stockInHandValue(item({ lastCountQty: null, theoreticalStock: 999 }))).toBe(0)
  })
})

describe('theoreticalQty', () => {
  it('prefers theoreticalStock', () => {
    expect(theoreticalQty(item({ theoreticalStock: 8, stockOnHand: 3 }))).toBe(8)
  })

  it('falls back to stockOnHand when theoretical is absent', () => {
    expect(theoreticalQty(item({ theoreticalStock: null, stockOnHand: 3 }))).toBe(3)
  })

  it('is 0 when neither is present', () => {
    expect(theoreticalQty(item({ theoreticalStock: null, stockOnHand: null }))).toBe(0)
  })
})

describe('stockInHandKpis', () => {
  it('sums value, counts coverage and reports never-counted', () => {
    const k = stockInHandKpis([
      item({ lastCountQty: 10, pricePerBaseUnit: 2, theoreticalStock: 10 }),
      item({ lastCountQty: null, pricePerBaseUnit: 5, theoreticalStock: 4 }),
    ])
    expect(k.value).toBe(20)
    expect(k.counted).toBe(1)
    expect(k.total).toBe(2)
    expect(k.neverCounted).toBe(1)
  })

  it('computes unverified movement as theoretical value minus stock in hand value', () => {
    const k = stockInHandKpis([
      item({ lastCountQty: 10, theoreticalStock: 8, pricePerBaseUnit: 2 }),
    ])
    expect(k.theoreticalValue).toBe(16)
    expect(k.value).toBe(20)
    expect(k.unverifiedMovement).toBe(-4)
  })

  it('counts a never-counted item toward theoretical value but not stock in hand', () => {
    const k = stockInHandKpis([
      item({ lastCountQty: null, theoreticalStock: 4, pricePerBaseUnit: 5 }),
    ])
    expect(k.value).toBe(0)
    expect(k.theoreticalValue).toBe(20)
    expect(k.unverifiedMovement).toBe(20)
  })

  it('reports the earliest count date among counted items only', () => {
    const k = stockInHandKpis([
      item({ lastCountQty: 1, lastCountDate: '2026-08-05T00:00:00.000Z' }),
      item({ lastCountQty: 1, lastCountDate: '2026-07-02T00:00:00.000Z' }),
      item({ lastCountQty: null, lastCountDate: '2026-01-01T00:00:00.000Z' }),
    ])
    expect(k.oldestCountDate).toBe('2026-07-02T00:00:00.000Z')
  })

  it('handles an empty set without crashing', () => {
    const k = stockInHandKpis([])
    expect(k).toEqual({
      value: 0, counted: 0, total: 0, neverCounted: 0,
      oldestCountDate: null, theoreticalValue: 0, unverifiedMovement: 0,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/stock-in-hand.test.ts`
Expected: FAIL — `Failed to resolve import "../stock-in-hand"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/stock-in-hand.ts`:

```ts
/**
 * Stock in Hand — the last PHYSICALLY counted quantity, with no theoretical
 * movement applied.
 *
 * Deliberately pure (no Prisma, no React): the inventory page and the xlsx
 * export both call these functions, so the on-screen KPI strip and the KPI
 * sheet cannot drift apart. Two copies of this arithmetic would eventually
 * disagree, and the spreadsheet is the copy that leaves the building.
 *
 * Quantities here are in BASE units. Converting to a count UOM for display is
 * the caller's job (convertBaseToCountUom); value must NOT be converted —
 * pricePerBaseUnit is already per base unit.
 */

/** The fields Stock in Hand needs. Both an API row and a Prisma row satisfy it. */
export interface StockInHandItem {
  lastCountQty?: number | string | null
  lastCountDate?: string | Date | null
  pricePerBaseUnit: number | string
  theoreticalStock?: number | string | null
  stockOnHand?: number | string | null
}

/** Prisma Decimals arrive as strings over JSON — normalize at the boundary. */
function num(v: number | string | Date | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Last counted quantity in BASE units. `null` means never counted — which is
 * NOT the same as a counted zero, and the two must stay distinguishable.
 */
export function stockInHandQty(item: StockInHandItem): number | null {
  return num(item.lastCountQty)
}

/** Last counted quantity valued at the CURRENT price. Never counted → 0. */
export function stockInHandValue(item: StockInHandItem): number {
  const qty = stockInHandQty(item)
  if (qty === null) return 0
  return qty * (num(item.pricePerBaseUnit) ?? 0)
}

/** Theoretical on-hand in BASE units, falling back the way the list API does. */
export function theoreticalQty(item: StockInHandItem): number {
  return num(item.theoreticalStock) ?? num(item.stockOnHand) ?? 0
}

export interface StockInHandKpis {
  /** Σ lastCountQty × current pricePerBaseUnit */
  value: number
  /** items with a count */
  counted: number
  /** items in view */
  total: number
  /** items with no lastCountQty */
  neverCounted: number
  /** earliest lastCountDate among counted items, ISO string */
  oldestCountDate: string | null
  /** Σ theoretical stock × current pricePerBaseUnit */
  theoreticalValue: number
  /** theoreticalValue − value: how much of the headline is unconfirmed */
  unverifiedMovement: number
}

export function stockInHandKpis(items: StockInHandItem[]): StockInHandKpis {
  let value = 0
  let counted = 0
  let theoreticalValue = 0
  let oldestMs: number | null = null
  let oldestCountDate: string | null = null

  for (const item of items) {
    const ppb = num(item.pricePerBaseUnit) ?? 0
    value += stockInHandValue(item)
    theoreticalValue += theoreticalQty(item) * ppb

    if (stockInHandQty(item) === null) continue
    counted++

    if (!item.lastCountDate) continue
    const d = new Date(item.lastCountDate)
    const ms = d.getTime()
    if (Number.isNaN(ms)) continue
    if (oldestMs === null || ms < oldestMs) {
      oldestMs = ms
      oldestCountDate = d.toISOString()
    }
  }

  return {
    value,
    counted,
    total: items.length,
    neverCounted: items.length - counted,
    oldestCountDate,
    theoreticalValue,
    unverifiedMovement: theoreticalValue - value,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/stock-in-hand.test.ts`
Expected: PASS — 15 tests.

- [ ] **Step 5: Run the whole suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add src/lib/stock-in-hand.ts src/lib/__tests__/stock-in-hand.test.ts
git commit -m "feat(inventory): pure Stock in Hand quantity, value and KPI math"
```

---

### Task 2: Shared pill predicate

The export must honour the active pill, and the page already implements the pill logic inline at `src/app/inventory/page.tsx:347-357`. Reimplementing it server-side would be a second copy that drifts. Extract one predicate and have both call it.

**Files:**
- Create: `src/lib/inventory-pills.ts`
- Test: `src/lib/__tests__/inventory-pills.test.ts`

**Interfaces:**
- Consumes: `convertBaseToCountUom` from `@/lib/count-uom`.
- Produces: `INVENTORY_PILLS`, `type InventoryPill = 'all' | 'counted' | 'notCounted' | 'highValue' | 'outOfStock' | 'lowStock'`, `PILL_LABELS: Record<InventoryPill, string>`, `isCountedThisWeek(item, now?): boolean`, `matchesPill(pill, item, now?): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/inventory-pills.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { matchesPill, isCountedThisWeek, type PillItem } from '../inventory-pills'

const NOW = new Date('2026-08-11T12:00:00.000Z')

const item = (over: Partial<PillItem> = {}): PillItem => ({
  lastCountDate: '2026-08-09T00:00:00.000Z',
  pricePerBaseUnit: 5,
  theoreticalStock: 10,
  stockOnHand: 10,
  parLevel: null,
  baseUnit: 'g',
  countUnit: 'g',
  dimension: 'WEIGHT',
  packChain: [],
  ...over,
})

describe('isCountedThisWeek', () => {
  it('is true within 7 days', () => {
    expect(isCountedThisWeek(item({ lastCountDate: '2026-08-09T00:00:00.000Z' }), NOW)).toBe(true)
  })

  it('is false beyond 7 days', () => {
    expect(isCountedThisWeek(item({ lastCountDate: '2026-07-01T00:00:00.000Z' }), NOW)).toBe(false)
  })

  it('is false when never counted', () => {
    expect(isCountedThisWeek(item({ lastCountDate: null }), NOW)).toBe(false)
  })
})

describe('matchesPill', () => {
  it('all matches everything', () => {
    expect(matchesPill('all', item({ lastCountDate: null }), NOW)).toBe(true)
  })

  it('counted / notCounted are complements', () => {
    const fresh = item({ lastCountDate: '2026-08-10T00:00:00.000Z' })
    const stale = item({ lastCountDate: '2026-06-01T00:00:00.000Z' })
    expect(matchesPill('counted', fresh, NOW)).toBe(true)
    expect(matchesPill('notCounted', fresh, NOW)).toBe(false)
    expect(matchesPill('counted', stale, NOW)).toBe(false)
    expect(matchesPill('notCounted', stale, NOW)).toBe(true)
  })

  it('highValue needs a price above a cent per base unit', () => {
    expect(matchesPill('highValue', item({ pricePerBaseUnit: 0.5 }), NOW)).toBe(true)
    expect(matchesPill('highValue', item({ pricePerBaseUnit: 0.001 }), NOW)).toBe(false)
  })

  it('outOfStock reads theoretical stock, not the counted quantity', () => {
    expect(matchesPill('outOfStock', item({ theoreticalStock: 0 }), NOW)).toBe(true)
    expect(matchesPill('outOfStock', item({ theoreticalStock: -2 }), NOW)).toBe(true)
    expect(matchesPill('outOfStock', item({ theoreticalStock: 3 }), NOW)).toBe(false)
  })

  it('lowStock compares against par in COUNT units', () => {
    // 500 g theoretical, par 1 kg → count unit kg → 0.5 < 1 → low
    const low = item({
      theoreticalStock: 500, baseUnit: 'g', countUnit: 'kg',
      dimension: 'WEIGHT', packChain: [], parLevel: 1,
    })
    expect(matchesPill('lowStock', low, NOW)).toBe(true)
  })

  it('lowStock excludes items at or below zero (those are outOfStock)', () => {
    expect(matchesPill('lowStock', item({ theoreticalStock: 0, parLevel: 5 }), NOW)).toBe(false)
  })

  it('lowStock is false with no par set', () => {
    expect(matchesPill('lowStock', item({ theoreticalStock: 1, parLevel: null }), NOW)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/inventory-pills.test.ts`
Expected: FAIL — `Failed to resolve import "../inventory-pills"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/inventory-pills.ts`:

```ts
/**
 * Inventory status pills — the predicate behind the "Counted / Not counted /
 * High value / Out of stock / Low stock" chips on /inventory.
 *
 * Pure and shared: the page filters rows with it and the xlsx export applies the
 * same pill, so a filtered export cannot disagree with the screen that produced
 * it. `now` is injectable so the 7-day window is testable.
 *
 * These predicates read THEORETICAL stock on purpose, even in the Stock in Hand
 * view. "Out of stock" and "Low stock" drive reordering, and reordering must be
 * based on what is actually left, not on what was last counted.
 */
import { convertBaseToCountUom } from './count-uom'

export type InventoryPill =
  | 'all' | 'counted' | 'notCounted' | 'highValue' | 'outOfStock' | 'lowStock'

export const INVENTORY_PILLS: InventoryPill[] =
  ['all', 'counted', 'notCounted', 'highValue', 'outOfStock', 'lowStock']

export const PILL_LABELS: Record<InventoryPill, string> = {
  all: 'All items',
  counted: 'Counted',
  notCounted: 'Not counted',
  highValue: 'High value',
  outOfStock: 'Out of stock',
  lowStock: 'Low stock',
}

/** The fields a pill predicate needs. Both an API row and a Prisma row satisfy it. */
export interface PillItem {
  lastCountDate?: string | Date | null
  pricePerBaseUnit: number | string
  theoreticalStock?: number | string | null
  stockOnHand?: number | string | null
  parLevel?: number | null
  baseUnit: string
  countUnit?: string | null
  dimension: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  packChain: any
}

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Theoretical on-hand in base units, matching the list API's fallback order. */
function effStock(item: PillItem): number {
  if (item.theoreticalStock !== null && item.theoreticalStock !== undefined) {
    return num(item.theoreticalStock)
  }
  return num(item.stockOnHand)
}

/** Theoretical on-hand converted to the item's count UOM — par is in count units. */
function displayStock(item: PillItem): number {
  return convertBaseToCountUom(effStock(item), item.countUnit || item.baseUnit, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dimension: item.dimension as any,
    baseUnit: item.baseUnit,
    packChain: item.packChain,
    countUnit: item.countUnit ?? undefined,
  })
}

/** Counted within the last 7 days. */
export function isCountedThisWeek(item: PillItem, now: Date = new Date()): boolean {
  if (!item.lastCountDate) return false
  const weekAgo = new Date(now)
  weekAgo.setDate(weekAgo.getDate() - 7)
  return new Date(item.lastCountDate) >= weekAgo
}

export function matchesPill(
  pill: InventoryPill,
  item: PillItem,
  now: Date = new Date(),
): boolean {
  switch (pill) {
    case 'counted':    return isCountedThisWeek(item, now)
    case 'notCounted': return !isCountedThisWeek(item, now)
    case 'highValue':  return num(item.pricePerBaseUnit) > 0.01
    case 'outOfStock': return effStock(item) <= 0
    case 'lowStock':
      return item.parLevel != null
        && displayStock(item) > 0
        && displayStock(item) < item.parLevel
    default: return true
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/inventory-pills.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Rewire the page to the shared predicate**

In `src/app/inventory/page.tsx`, delete the local `isCountedThisWeek` (lines 147–151) and the local `FilterPill` type (line 61), then import the shared ones. Add to the import block near line 5:

```tsx
import { matchesPill, isCountedThisWeek, type InventoryPill } from '@/lib/inventory-pills'
```

Replace every `FilterPill` type reference with `InventoryPill` (the `activePill` state at line 206 and the `pills` array at line 753).

Replace the `pillFiltered` memo (lines 347–357) with:

```tsx
  // Pill filter. matchesPill is the shared predicate the export also applies, so a
  // filtered export always matches the screen that produced it.
  const pillFiltered = useMemo(() => {
    const base = filterNeedsReview ? items.filter(i => i.needsReview) : items
    if (activePill === 'all') return base
    return base.filter(i => matchesPill(activePill, i))
  }, [items, activePill, filterNeedsReview])
```

Replace the whole desktop pill-count ternary chain (lines 1021–1024) with a single expression:

```tsx
          const count = p.key === 'all'
            ? items.length
            : items.filter(i => matchesPill(p.key, i)).length
```

- [ ] **Step 6: Verify the page still compiles and pills behave**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: no errors mentioning `inventory/page.tsx` or `inventory-pills`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/inventory-pills.ts src/lib/__tests__/inventory-pills.test.ts src/app/inventory/page.tsx
git commit -m "refactor(inventory): extract pill predicate to a shared pure module"
```

---

### Task 3: Extract the inventory list fetch

The export must return exactly the rows the screen shows. The list route's fetch is ~175 lines of RC scoping, membership and aggregation logic (`src/app/api/inventory/route.ts:40-215`). Re-implementing it in the export route would guarantee eventual divergence. Extract it once; both routes call it.

**Files:**
- Create: `src/lib/inventory-list.ts`
- Modify: `src/app/api/inventory/route.ts:1-215`

**Interfaces:**
- Consumes: `requireSession`'s user type from `@/lib/auth`; `getTheoreticalStockMap` from `@/lib/count-expected`; `resolveScopedRcIds` from `@/lib/rc-scope`; `PRICING_SELECT`/`asChainItem`/`pricePerBaseUnit` from `@/lib/item-model`.
- Produces: `InventoryListParams`, `InventoryListRow`, `parseInventoryListParams(searchParams: URLSearchParams): InventoryListParams`, `fetchInventoryList(user, params): Promise<{ rows: InventoryListRow[]; outOfScope: boolean }>`.

- [ ] **Step 1: Create the module by moving code verbatim**

Create `src/lib/inventory-list.ts`. Move the body of `GET` from `src/app/api/inventory/route.ts:40-215` into `fetchInventoryList`, along with the `attachTheoreticalFields` helper at lines 11–38, applying exactly these four transformations and no others:

1. Params come from `params`, not `searchParams` — delete the `const { searchParams } = new URL(req.url)` block and the twelve `searchParams.get(...)` lines, and destructure `params` instead.
2. The out-of-scope early return `return NextResponse.json([], ...)` becomes `return { rows: [], outOfScope: true }`.
3. Each of the three `return NextResponse.json(attachTheoreticalFields(...), ...)` becomes `return { rows: attachTheoreticalFields(...), outOfScope: false }`.
4. Drop the `NextResponse`/`NextRequest` imports; keep every other import.

The scoping logic, the three RC branches, the comments, and the `getTheoreticalStockMap` calls move **unchanged**. Do not rewrite, tidy, or re-order them — this task must be behaviour-preserving.

The file header and the two new exported functions:

```ts
/**
 * The /api/inventory list fetch, extracted so the xlsx export can return exactly
 * the rows the screen shows. Two implementations of this RC-scoping logic would
 * drift, and the symptom would be a spreadsheet that quietly disagrees with the app.
 *
 * Moved verbatim from src/app/api/inventory/route.ts — behaviour-preserving.
 */
import { prisma } from './prisma'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit as chainPricePerBaseUnit } from './item-model'
import { getTheoreticalStockMap } from './count-expected'
import { resolveScopedRcIds } from './rc-scope'

export interface InventoryListParams {
  search: string
  category: string
  supplierId: string
  storageAreaId: string
  isActive: string | null
  rcId: string
  isDefault: boolean
  includeNonStocked: boolean
}

export interface InventoryListRow {
  id: string
  itemName: string
  category: string
  supplier?: { name: string } | null
  storageArea?: { name: string } | null
  baseUnit: string
  countUnit?: string | null
  dimension: string
  isActive: boolean
  lastCountDate: string | null
  theoreticalStock: number
  countedStock: number
  pricePerBaseUnit: number
  parLevel?: number | null
  // packChain, pricing, purchasePrice, stockOnHand, lastCountQty and the rest of the
  // Prisma row ride along untyped, exactly as the route returned them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

/** Read the list params off a URL. Both the list route and the export use this. */
export function parseInventoryListParams(searchParams: URLSearchParams): InventoryListParams {
  return {
    search:            searchParams.get('search') || '',
    category:          searchParams.get('category') || '',
    supplierId:        searchParams.get('supplierId') || '',
    storageAreaId:     searchParams.get('storageAreaId') || '',
    isActive:          searchParams.get('isActive'),
    rcId:              searchParams.get('rcId') || '',
    isDefault:         searchParams.get('isDefault') === 'true',
    includeNonStocked: searchParams.get('includeNonStocked') === 'true',
  }
}

/**
 * `outOfScope` is true when a scoped user asked for an rcId outside their scope —
 * the caller must return an empty result, never another RC's data.
 */
export async function fetchInventoryList(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: any,
  params: InventoryListParams,
): Promise<{ rows: InventoryListRow[]; outOfScope: boolean }> {
  const { search, category, supplierId, storageAreaId, isActive, rcId, isDefault, includeNonStocked } = params

  // ...everything from route.ts:68-215 moves here unchanged, with the four
  // transformations listed above applied.
}
```

- [ ] **Step 2: Replace the route's GET with a thin wrapper**

In `src/app/api/inventory/route.ts`, delete `attachTheoreticalFields` (lines 11–38) and the entire `GET` body, leaving:

```ts
export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const { rows } = await fetchInventoryList(user, parseInventoryListParams(searchParams))
  return NextResponse.json(rows, { headers: { 'Cache-Control': 'no-store' } })
}
```

Add the import:

```ts
import { fetchInventoryList, parseInventoryListParams } from '@/lib/inventory-list'
```

Then remove any import in `route.ts` that only `GET` used and `POST` does not — check `getTheoreticalStockMap` and `resolveScopedRcIds` specifically, and delete them if unreferenced. Leave `PRICING_SELECT`, `validateChainItem`, `withPpb`, `DIMENSION_BASE`, `dimensionOf`, `ChainItem` alone unless the compiler reports them unused.

- [ ] **Step 3: Verify it type-checks with no unused imports**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: no errors.

Run: `npm run lint 2>&1 | tail -20`
Expected: no new `@typescript-eslint/no-unused-vars` errors in `route.ts`.

- [ ] **Step 4: Verify the endpoint behaves identically**

Start the dev server via `preview_start` (never `npm run dev` in Bash), then compare a scoped and an unscoped response:

```bash
curl -s 'http://localhost:3000/api/inventory?includeNonStocked=true' | head -c 400
```

Expected: a JSON array whose first row carries `theoreticalStock`, `countedStock`, `lastCountDate` and `pricePerBaseUnit` — the same shape as before the extraction.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory-list.ts src/app/api/inventory/route.ts
git commit -m "refactor(inventory): extract list fetch so the export can reuse it"
```

---

### Task 4: Guard the export route

`/api/inventory/export` currently has **no auth at all** — no `requireSession`, no role check. API routes bypass middleware, so anyone who can reach the URL gets the full priced catalogue.

**Files:**
- Modify: `src/app/api/inventory/export/route.ts:1-10`
- Modify: `src/app/inventory/page.tsx` (export buttons at 805–811 and 979–986)

**Interfaces:**
- Consumes: `requireSession`, `AuthError` from `@/lib/auth`; `useUser` from `@/contexts/UserContext`; `atLeast` from `@/lib/roles`.
- Produces: nothing new.

- [ ] **Step 1: Add the guard**

In `src/app/api/inventory/export/route.ts`, change the imports and signature:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
```

and replace `export async function GET() {` with:

```ts
export async function GET(req: NextRequest) {
  // This route serves the full priced catalogue. API routes bypass middleware, so
  // the guard has to live here — it had none at all before.
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
```

`req` is unused for now; Task 5 uses it. If lint complains before then, add the guard and Task 5's dispatch in the same sitting.

- [ ] **Step 2: Verify the guard rejects and permits correctly**

With `DEV_AUTH_BYPASS` unset, run:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/inventory/export
```

Expected: `401`.

- [ ] **Step 3: Hide the export buttons below MANAGER**

In `src/app/inventory/page.tsx`, add the imports:

```tsx
import { useUser } from '@/contexts/UserContext'
import { atLeast } from '@/lib/roles'
```

Inside the component body, near the other state declarations (around line 206):

```tsx
  // Default-deny: `role` is null while /api/me is in flight, so the export controls
  // stay hidden rather than flashing and then 403-ing. Mirrors CostChrome.
  const { role } = useUser()
  const canExport = role !== null && atLeast(role, 'MANAGER')
```

Wrap the desktop Export button (lines 805–811) and the mobile CSV button (lines 980–986) in `{canExport && ( … )}`.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/inventory/export/route.ts src/app/inventory/page.tsx
git commit -m "fix(inventory): require MANAGER for the priced catalogue export"
```

---

### Task 5: Stock in Hand workbook

**Files:**
- Modify: `src/app/api/inventory/export/route.ts`

**Interfaces:**
- Consumes: `fetchInventoryList`, `parseInventoryListParams` (Task 3); `stockInHandKpis`, `stockInHandQty`, `stockInHandValue`, `theoreticalQty` (Task 1); `matchesPill`, `PILL_LABELS`, `type InventoryPill` (Task 2); `convertBaseToCountUom` from `@/lib/count-uom`.
- Produces: `GET` handles `?view=stock-in-hand`.

- [ ] **Step 1: Add the imports and dispatch**

At the top of `src/app/api/inventory/export/route.ts`:

```ts
import { prisma } from '@/lib/prisma'
import { fetchInventoryList, parseInventoryListParams, type InventoryListRow } from '@/lib/inventory-list'
import { stockInHandKpis, stockInHandQty, stockInHandValue, theoreticalQty } from '@/lib/stock-in-hand'
import { matchesPill, PILL_LABELS, INVENTORY_PILLS, type InventoryPill } from '@/lib/inventory-pills'
import { convertBaseToCountUom } from '@/lib/count-uom'
```

Immediately after the auth guard added in Task 4, insert:

```ts
  const { searchParams } = new URL(req.url)
  if (searchParams.get('view') === 'stock-in-hand') {
    return stockInHandWorkbook(user, searchParams)
  }
```

and capture the user from the guard — change `try { await requireSession('MANAGER') }` to:

```ts
  let user
  try { user = await requireSession('MANAGER') }
```

- [ ] **Step 2: Add the filter-label resolver**

Append to `src/app/api/inventory/export/route.ts`:

```ts
/**
 * Resolve filter IDs to human names for the KPI sheet. A file that leaves the
 * building has to say what produced it, or it has to be re-derived to be trusted.
 */
async function resolveFilterLabels(searchParams: URLSearchParams) {
  const supplierId    = searchParams.get('supplierId') || ''
  const storageAreaId = searchParams.get('storageAreaId') || ''
  const rcId          = searchParams.get('rcId') || ''

  const [supplier, storageArea, rc] = await Promise.all([
    supplierId    ? prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true } })       : null,
    storageAreaId ? prisma.storageArea.findUnique({ where: { id: storageAreaId }, select: { name: true } }) : null,
    rcId          ? prisma.revenueCenter.findUnique({ where: { id: rcId }, select: { name: true } })        : null,
  ])

  const rawPill = searchParams.get('pill') || 'all'
  const pill = (INVENTORY_PILLS as string[]).includes(rawPill) ? rawPill as InventoryPill : 'all'

  return {
    pill,
    rows: [
      ['Search',         searchParams.get('search') || '(none)'],
      ['Category',       searchParams.get('category') || 'all'],
      ['Supplier',       supplier?.name    ?? 'all'],
      ['Storage area',   storageArea?.name ?? 'all'],
      ['Revenue centre', rc?.name ?? (rcId ? rcId : 'all')],
      ['Status filter',  PILL_LABELS[pill]],
      ['Non-stocked items', searchParams.get('includeNonStocked') === 'true' ? 'included' : 'excluded'],
    ] as (string | number)[][],
  }
}
```

- [ ] **Step 3: Add the workbook builder**

Append to the same file:

```ts
const BASIS_STATEMENT =
  'Showing last physically counted quantities at current prices. ' +
  'No sales, prep, wastage or purchase movement applied.'

const CROSS_RC_NOTE =
  'lastCountQty is a single global field on the item. An RC-scoped count writes it ' +
  'but leaves that RC’s allocation alone, so on a non-default revenue centre this ' +
  'reads "last count of this item anywhere", not "last count in this revenue centre".'

/** Quantity in the item's count UOM. Value must NOT be converted — ppb is per base unit. */
function countQty(row: InventoryListRow, baseQty: number): number {
  return convertBaseToCountUom(baseQty, row.countUnit || row.baseUnit, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dimension: row.dimension as any,
    baseUnit: row.baseUnit,
    packChain: row.packChain,
    countUnit: row.countUnit ?? undefined,
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stockInHandWorkbook(user: any, searchParams: URLSearchParams) {
  const { rows: allRows, outOfScope } = await fetchInventoryList(user, parseInventoryListParams(searchParams))
  const { pill, rows: filterRows } = await resolveFilterLabels(searchParams)

  // Apply the same pill predicate the page applies, so the file matches the screen.
  const rows = outOfScope ? [] : allRows.filter(r => matchesPill(pill, r))
  const kpis = stockInHandKpis(rows)

  const wb = XLSX.utils.book_new()

  const kpiData: (string | number)[][] = [
    ['Stock in Hand'],
    ['Generated:', new Date().toLocaleString()],
    [],
    ['Basis'],
    [BASIS_STATEMENT],
    [CROSS_RC_NOTE],
    [],
    ['Filters applied'],
    ...filterRows,
    [],
    ['KPI Summary'],
    ['Stock in Hand Value',  Number(kpis.value.toFixed(2))],
    ['Coverage',             `${kpis.counted} / ${kpis.total}`],
    ['Never Counted',        kpis.neverCounted],
    ['Oldest Count',         kpis.oldestCountDate ? new Date(kpis.oldestCountDate).toLocaleDateString() : '—'],
    ['Unverified Movement',  Number(kpis.unverifiedMovement.toFixed(2))],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(kpiData), 'KPI Summary')

  const headers = [
    'Item Name', 'Category', 'Supplier', 'Storage Area', 'Count Unit',
    'Stock in Hand (count unit)', 'Base Unit', 'Stock in Hand (base)',
    'Price/Base Unit', 'Stock in Hand Value', 'Last Count Date', 'Counted?',
    'Theoretical Stock (base)', 'Unverified Movement Value',
  ]

  const dataRows = rows.map(row => {
    const qty  = stockInHandQty(row)          // base units, null = never counted
    const ppb  = Number(row.pricePerBaseUnit)
    const val  = stockInHandValue(row)
    const theo = theoreticalQty(row)
    return [
      row.itemName,
      row.category,
      row.supplier?.name ?? '',
      row.storageArea?.name ?? '',
      row.countUnit || row.baseUnit,
      qty === null ? '' : countQty(row, qty),  // blank, never 0 — a gap is not a zero
      row.baseUnit,
      qty === null ? '' : qty,
      ppb,
      val,
      row.lastCountDate ? new Date(row.lastCountDate).toLocaleDateString() : '',
      qty === null ? 'Never' : 'Yes',
      theo,
      theo * ppb - val,
    ]
  })
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...dataRows]), 'Stock in Hand')

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="stock-in-hand-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  })
}
```

- [ ] **Step 4: Verify it type-checks**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: no errors.

- [ ] **Step 5: Verify the route is dynamic**

Confirm `export const dynamic = 'force-dynamic'` is still present at the top of the file. A statically prerendered route serves build-time data and 405s on other methods.

Run: `grep -n "force-dynamic" src/app/api/inventory/export/route.ts`
Expected: one match.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/inventory/export/route.ts
git commit -m "feat(inventory): Stock in Hand xlsx export with KPIs and filter provenance"
```

---

### Task 6: Stock in Hand view mode

**Files:**
- Modify: `src/app/inventory/page.tsx`

**Interfaces:**
- Consumes: `stockInHandQty`, `stockInHandValue`, `stockInHandKpis` (Task 1); existing `effStock`, `displayStock`, `invValue`, `convertBaseToCountUom`.
- Produces: nothing consumed elsewhere.

**Critical — do not redefine `effStock` / `displayStock` / `invValue`.** They also feed the Order List (lines 1358–1370, 1451–1465), the pill counts, and the par comparisons. Reordering must stay on theoretical stock: a kitchen ordering against last month's count would over-order badly. Add *separate* basis-aware helpers and switch only the call sites listed below.

- [ ] **Step 1: Add the state and helpers**

Add the import near line 5:

```tsx
import { stockInHandQty, stockInHandValue, stockInHandKpis } from '@/lib/stock-in-hand'
```

Add state beside `showInactive` (around line 206):

```tsx
  // Stock in Hand: report the last PHYSICALLY counted quantity, no theoretical
  // movement. A view mode, not a row filter — it redefines the Stock and Value
  // columns and the KPI row, which is why it gets a visible basis line.
  const [stockInHand, setStockInHand] = useState(false)
```

Add the basis-aware helpers immediately after the existing `displayStock` definition (after line 333):

```tsx
  // Basis-aware readers. Deliberately SEPARATE from effStock/displayStock/invValue:
  // those still drive the order list, the pills and the par comparisons, which must
  // stay on theoretical stock even while this view is on.
  const basisQtyBase = (i: InventoryItem): number | null =>
    stockInHand ? stockInHandQty(i) : effStock(i)

  const basisDisplayStock = (i: InventoryItem): number | null => {
    const q = basisQtyBase(i)
    if (q === null) return null
    return convertBaseToCountUom(q, i.countUnit || i.baseUnit, {
      dimension: i.dimension, baseUnit: i.baseUnit,
      packChain: i.packChain, countUnit: i.countUnit,
    })
  }

  const basisValue = (i: InventoryItem): number =>
    stockInHand ? stockInHandValue(i) : invValue(i)
```

Note `invValue` is defined at line 367, after `displayStock` — move the `basisValue` definition below it, or hoist `invValue` above these helpers. Both are plain `const` arrow functions in the component body, so ordering matters.

- [ ] **Step 2: Make the KPI strip basis-aware**

Replace the `kpis` memo (lines 336–344) with:

```tsx
  // KPIs — items are fetched active-only, so inactive items never enter these numbers.
  const kpis = useMemo(() => {
    const totalValue = items.reduce((s, i) =>
      s + effStock(i) * parseFloat(String(i.pricePerBaseUnit)), 0)
    const counted = items.filter(i => isCountedThisWeek(i)).length
    return { totalValue, counted, notCounted: items.length - counted, activeCount: items.length }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  // Stock in Hand KPIs — same function the xlsx export calls, so the strip and the
  // sheet cannot disagree.
  const sihKpis = useMemo(() => stockInHandKpis(items), [items])
```

- [ ] **Step 3: Swap the desktop KPI row**

Wrap the existing five desktop KPI cards (lines 858–930) in `{!stockInHand && ( … )}` and add, immediately after, the Stock in Hand row. Match the existing card markup exactly — same grid, same `min-h-[128px]`, same flat color tokens:

```tsx
      {stockInHand && (
      <div className={`${showInactive ? 'hidden' : 'hidden sm:grid'} gap-3`} style={{ gridTemplateColumns: '1.35fr 1fr 1fr 1fr 1fr' }}>
        <div className="bg-ink text-paper rounded-xl border border-ink p-5 flex flex-col justify-between min-h-[128px]">
          <div>
            <div className="font-mono text-[10.5px] text-ink-4 tracking-[0.01em]">STOCK IN HAND VALUE</div>
            <div className="text-[48px] font-semibold tracking-[-0.045em] leading-none mt-2 whitespace-nowrap">
              {formatCurrency(sihKpis.value).split('.')[0]}
              <sub className="text-[22px] font-medium text-gold tracking-[-0.02em] align-baseline ml-[1px]">
                .{formatCurrency(sihKpis.value).split('.')[1] ?? '00'}
              </sub>
            </div>
          </div>
          <div className="font-mono text-[11px] text-ink-4 mt-2">Last counted quantities, current prices</div>
        </div>

        <div className="bg-paper border border-line rounded-xl p-5 flex flex-col justify-between min-h-[128px] relative">
          <div className="absolute top-0 left-0 w-8 h-[2px] bg-gold rounded-[1px]" />
          <div>
            <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">COVERAGE</div>
            <div className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-ink whitespace-nowrap">
              {sihKpis.counted}
              <span className="text-[18px] font-normal text-ink-3"> / {sihKpis.total}</span>
            </div>
          </div>
          <div className="font-mono text-[11px] text-ink-3 mt-2">items physically counted</div>
        </div>

        <div className="rounded-xl p-5 flex flex-col justify-between min-h-[128px]" style={{ background: '#fffbeb', border: '1px solid #fcd34d' }}>
          <div>
            <div className="font-mono text-[10.5px] text-gold-2 tracking-[0.01em]">NEVER COUNTED</div>
            <div className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-gold-2">{sihKpis.neverCounted}</div>
          </div>
          <div className="font-mono text-[11px] text-gold-2 font-medium mt-2">valued at $0 here</div>
        </div>

        <div className="bg-paper border border-line rounded-xl p-5 flex flex-col justify-between min-h-[128px]">
          <div>
            <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">OLDEST COUNT</div>
            <div className="text-[22px] font-semibold tracking-[-0.03em] leading-none mt-3 text-ink">
              {sihKpis.oldestCountDate
                ? new Date(sihKpis.oldestCountDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })
                : '—'}
            </div>
          </div>
          <div className="font-mono text-[11px] text-ink-3 mt-2">in the current view</div>
        </div>

        <div className="bg-paper border border-line rounded-xl p-5 flex flex-col justify-between min-h-[128px]">
          <div>
            <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">UNVERIFIED MOVEMENT</div>
            <div className="text-[26px] font-semibold tracking-[-0.03em] leading-none mt-2 text-ink whitespace-nowrap">
              {formatCurrency(sihKpis.unverifiedMovement)}
            </div>
          </div>
          <div className="font-mono text-[11px] text-ink-3 mt-2">theoretical minus counted</div>
        </div>
      </div>
      )}
```

Do the same for the mobile strip (lines 836–856): wrap it in `{!stockInHand && ( … )}` and add a Stock in Hand variant carrying Stock in Hand Value, Coverage, Never Counted and Unverified Movement, using the same `flex-shrink-0 … min-w-[140px]` card classes already there.

- [ ] **Step 4: Add the basis line**

Directly above the KPI strips, add:

```tsx
      {stockInHand && !showInactive && (
        <div className="flex items-start gap-3 rounded-xl border border-line bg-bg-2 px-4 py-3">
          <AlertCircle size={15} className="text-ink-3 mt-0.5 shrink-0" />
          <div className="text-[13px] text-ink-2">
            <span className="font-semibold">Stock in Hand</span> — showing last physically counted
            quantities at current prices. No sales, prep, wastage or purchase movement applied.
            {activeRcId && !activeRc?.isDefault && (
              <> Counts are recorded per item, not per revenue centre, so these are each item&rsquo;s
              most recent count anywhere.</>
            )}
          </div>
        </div>
      )}
```

`AlertCircle` is already imported (used by the inactive banner at line 826). If `activeRc` has no `isDefault` field on the client type, drop that conditional clause rather than inventing the field — verify before writing it.

- [ ] **Step 5: Switch the table columns**

In `renderRow`, replace lines 581–584 with:

```tsx
    const itemValue = basisValue(item)
    const basisQty  = basisDisplayStock(item)        // null = never counted
    const stockQty  = displayStock(item)             // theoretical — drives the status pill
    const isOut     = stockQty <= 0
    const isLow     = !isOut && item.parLevel != null && stockQty < item.parLevel
```

`isOut`/`isLow` keep reading theoretical on purpose — the status pill answers "can we serve this tonight", which the counted quantity cannot.

Replace the stock cell at line 626 with:

```tsx
              {basisQty === null
                ? <span className="text-ink-4">—</span>
                : <>{basisQty.toFixed(1)}<small className="font-mono text-[10.5px] text-ink-3 ml-[3px] font-normal">{item.countUnit || formatPurchaseDisplay(item)}</small></>}
```

Replace the mobile row's stock line at line 703 with:

```tsx
              {(() => { const q = basisDisplayStock(item); return q === null ? '—' : q.toFixed(1) })()} {item.countUnit || item.baseUnit}
```

Replace the two category-subtotal reducers at lines 1532 and 1589 — both read:

```tsx
            const catValue = rows.reduce((s, i) => s + invValue(i), 0)
```

with:

```tsx
            const catValue = rows.reduce((s, i) => s + basisValue(i), 0)
```

- [ ] **Step 6: Make sorting follow the visible basis**

In the `byCol` comparator (lines 376–386), replace the `stock` and `value` cases:

```tsx
        case 'stock':    return ((basisQtyBase(a) ?? -Infinity) - (basisQtyBase(b) ?? -Infinity)) * dir
        case 'value':    return (basisValue(a) - basisValue(b)) * dir
```

Never-counted rows sort to the bottom on a descending sort, which is where a gap belongs. Add `stockInHand` to the `sortedItems` memo dependency array (line 400).

- [ ] **Step 7: Add the toggle**

Beside the desktop inactive switch (after line 1062), add:

```tsx
        <button
          onClick={() => setStockInHand(v => !v)}
          title="Show last physically counted quantities only — no theoretical movement"
          className={`flex items-center gap-2 font-mono text-[11px] px-3 py-[6px] rounded-full transition-colors whitespace-nowrap ${
            stockInHand ? 'bg-ink text-paper border border-ink' : 'bg-paper border border-line text-ink-2 hover:border-ink-3'
          }`}
        >
          Stock in Hand
          <span className={`relative inline-flex w-[26px] h-[15px] shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ${stockInHand ? 'bg-gold' : 'bg-line-2'}`}>
            <span className={`pointer-events-none inline-block h-[11px] w-[11px] transform rounded-full bg-white shadow transition duration-200 ${stockInHand ? 'translate-x-[11px]' : 'translate-x-0'}`} />
          </span>
        </button>
```

The inactive switch carries `ml-auto`; move that class onto whichever button should sit rightmost so the row still ends flush.

Add the same toggle to the mobile pill row beside the mobile inactive switch (after line 1013), using the mobile switch's `flex-shrink-0 … rounded-full` classes.

In `toggleInactiveView` (line 744), add `setStockInHand(false)` — the inactive view replaces the KPI row, so the two modes must not both be on.

- [ ] **Step 8: Point the export buttons at the current view**

Replace both export `onClick` handlers with one that carries the live filters:

```tsx
  const exportHref = () => {
    const p = new URLSearchParams()
    if (stockInHand) p.set('view', 'stock-in-hand')
    if (search)         p.set('search', search)
    if (catFilter)      p.set('category', catFilter)
    if (supplierFilter) p.set('supplierId', supplierFilter)
    if (areaFilter)     p.set('storageAreaId', areaFilter)
    if (activeRcId)     { p.set('rcId', activeRcId); if (activeRc?.isDefault) p.set('isDefault', 'true') }
    if (showNonStocked) p.set('includeNonStocked', 'true')
    if (activePill !== 'all') p.set('pill', activePill)
    return `/api/inventory/export?${p.toString()}`
  }
```

Define it in the component body near the other handlers, and set both buttons to `onClick={() => { window.location.href = exportHref() }}`. Label the desktop button `Export Stock in Hand` while `stockInHand` is true, so it is obvious which file you get. Check the exact name of the RC default flag on `activeRc` before writing `activeRc?.isDefault` — if the client type lacks it, omit that param.

- [ ] **Step 9: Verify**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: no errors.

Run: `npm run lint 2>&1 | tail -20`
Expected: no new errors in `page.tsx`.

- [ ] **Step 10: Commit**

```bash
git add src/app/inventory/page.tsx
git commit -m "feat(inventory): Stock in Hand view mode with counted-basis KPIs"
```

---

### Task 7: Full verification

PR #80 is still sitting unverified in the browser. This one does not ship that way.

**Files:** none modified unless a defect is found.

- [ ] **Step 1: Run the test suite**

Run: `npm test`
Expected: PASS, including the 25 new tests from Tasks 1–2.

- [ ] **Step 2: Build in an isolated worktree**

Building in the main checkout while `next dev` runs gives bogus failures, and `next build` rewrites `tsconfig.json`.

```bash
git worktree add /private/tmp/claude-501/-Users-joshua-dev-fergies-os/build-sih HEAD
ln -s "$PWD/node_modules" /private/tmp/claude-501/-Users-joshua-dev-fergies-os/build-sih/node_modules
ln -s "$PWD/.env" /private/tmp/claude-501/-Users-joshua-dev-fergies-os/build-sih/.env
cd /private/tmp/claude-501/-Users-joshua-dev-fergies-os/build-sih && npm run build
```

Expected: build succeeds. In the route table, `/api/inventory/export` and `/api/inventory` both show `ƒ (Dynamic)`, not `○ (Static)`.

Then: `git worktree remove /private/tmp/claude-501/-Users-joshua-dev-fergies-os/build-sih --force`

- [ ] **Step 3: Browser-verify the view mode**

Start the dev server with `preview_start` (never `npm run dev` via Bash), open `/inventory`, and confirm each of:

1. Toggle off → KPI row reads THEORETICAL STOCK VALUE; a known item shows its theoretical quantity.
2. Toggle on → basis line appears; KPI row swaps to the five Stock in Hand cards; the same item's Stock column changes to its counted quantity.
3. An item that has never been counted shows `—`, not `0`, and `$0.00` value.
4. Coverage denominator equals the Active Items count from the theoretical view.
5. Unverified Movement equals theoretical value minus Stock in Hand value — check by arithmetic against the two hero cards.
6. Sorting by Stock and by Value reorders sensibly, with never-counted rows at the bottom descending.
7. Order List still shows theoretical quantities while Stock in Hand is on — open it and confirm par suggestions did not change.
8. Turning on the Inactive view clears the Stock in Hand toggle.

Read the console via `read_console_messages` and confirm no errors.

- [ ] **Step 4: Verify the export end to end**

With a category filter and a pill active, click Export. Then:

```bash
ls -la ~/Downloads/stock-in-hand-*.xlsx
```

Open it and confirm: KPI Summary sheet lists the basis statement, every filter with resolved names (not raw IDs), and the five KPIs matching the on-screen strip exactly; the Stock in Hand sheet has 14 columns; never-counted rows carry a blank quantity and `Never`; row count equals the on-screen row count.

- [ ] **Step 5: Verify the auth guard from a STAFF session**

Sign in as a STAFF user (or set the role in Supabase `user_metadata`) and confirm the Export button is absent from `/inventory`, and that hitting `/api/inventory/export?view=stock-in-hand` directly returns 403.

- [ ] **Step 6: Commit any fixes and open the PR**

```bash
git push -u origin feat/stock-in-hand-view
gh pr create --title "feat(inventory): Stock in Hand view + Excel export" --body "$(cat <<'EOF'
Adds a Stock in Hand view mode to /inventory: each item's last physically
counted quantity (`lastCountQty`, frozen at count finalize) valued at current
prices, with no theoretical movement applied. Exportable to xlsx with five KPIs
and a record of the filters that produced the file.

Also fixes: `/api/inventory/export` had no auth guard at all — API routes bypass
middleware, so the full priced catalogue was reachable by anyone. Now MANAGER+,
with the export buttons hidden below that clearance (default-deny while the role
is loading).

Shared pure modules (`stock-in-hand.ts`, `inventory-pills.ts`) and an extracted
`inventory-list.ts` mean the spreadsheet and the screen compute from the same
code rather than from two implementations that agree today.

## Verified
- `npm test` — 25 new tests pass, full suite green
- `npm run build` in an isolated worktree; both routes report ƒ (Dynamic)
- Browser: toggle, KPI swap, never-counted `—`, sorting, order list unaffected
- Downloaded a real xlsx and checked both sheets against the on-screen KPIs
- STAFF session: export button absent, direct route call returns 403

## Not verified
- Non-default revenue centre behaviour beyond the stated cross-RC limitation

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Replace the Verified / Not verified sections with what actually happened. If a
check was skipped, say so — do not carry the template's claims forward unchecked.

---

## Verification Summary

| Spec requirement | Task |
|---|---|
| Quantity = frozen `lastCountQty` | 1 |
| Never-counted shown, blank, $0 | 1, 5, 6 |
| Valuation at current `pricePerBaseUnit` | 1 |
| Five KPIs, identical on screen and in sheet | 1, 5, 6 |
| View mode, not a pill | 6 |
| Basis line always visible | 6 |
| Filters/search/RC/pills keep working | 2, 6 |
| Sorting follows the visible basis | 6 |
| Order list and pills stay on theoretical | 2, 6 |
| Hidden while inactive view is on | 6 |
| Cross-RC limitation stated in UI and sheet | 5, 6 |
| Export = exactly the filtered view | 3, 5 |
| KPI sheet records filters | 5 |
| 14-column data sheet | 5 |
| `stock-in-hand-YYYY-MM-DD.xlsx` | 5 |
| `MANAGER+` on the export route | 4 |
| Export button hidden below MANAGER, default-deny | 4 |
| vitest coverage of the pure math | 1, 2 |
| Build in isolated worktree | 7 |
| Browser verification | 7 |

**Out of scope, per spec:** per-RC `lastCountQty`; frozen `InventorySnapshot` valuation; changes to theoretical stock computation; role-gating the page's existing theoretical KPI cards.
