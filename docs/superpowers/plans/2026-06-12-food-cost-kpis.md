# Food-Cost & Operational KPIs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the misleading purchase-only food-cost KPI with honest, recipe- and count-based metrics — theoretical food cost, actual food cost, their variance (shrinkage), plus wastage %, cost/cover, menu engineering, and inventory turns.

**Architecture:** Compute-on-read everywhere (no cached costs — spine principle). Theoretical cost reuses `fetchRecipeWithCost` (resolves nested PREP correctly) via a new batched helper. Pass-strip metrics extend `/api/reports/dashboard` over a single Monday-WTD window; period/variance metrics extend `/api/reports/cogs` and a new focused `/api/insights/food-cost-variance`. Menu-engineering and inventory-efficiency get their own endpoints + Reports views.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma + PostgreSQL, Tailwind. No test suite — `npm run build` is the only automated check; each task also verifies with a live API/preview check.

**Spec:** [docs/superpowers/specs/2026-06-12-food-cost-kpis-design.md](../specs/2026-06-12-food-cost-kpis-design.md)

**Conventions reminders (from CLAUDE.md):**
- Wrap every Prisma `Decimal` read in `Number()` before arithmetic/`.toFixed()`.
- API routes with mutating or live behavior need `export const dynamic = 'force-dynamic'` (the routes here are GET + live; keep/add it).
- Never instantiate `PrismaClient` — import `prisma` from `src/lib/prisma`.
- Define React sub-components at module scope, not inside a client component body.

---

## File Structure

**Create:**
- `src/lib/dates.ts` — shared `startOfWeek(d)` (Monday 00:00 local) so dashboard + cost-chrome share identical week boundaries.
- `src/lib/theoretical-cost.ts` — batched theoretical plate-cost over a list of sold line items.
- `src/lib/cogs.ts` — `computePeriodCogs()` global snapshot-based COGS for a date range.
- `src/app/api/insights/food-cost-variance/route.ts` — resolves the last closed count period and returns actual vs theoretical food cost + variance.
- `src/app/api/reports/menu-engineering/route.ts` — per-dish margin × popularity quadrants.
- `src/app/api/reports/inventory-efficiency/route.ts` — inventory turns / days-on-hand.
- `src/app/reports/menu/page.tsx` — menu-engineering view.

**Modify:**
- `src/app/api/insights/cost-chrome/route.ts` — import shared `startOfWeek`.
- `src/app/api/reports/dashboard/route.ts` — add the WTD food-cost block.
- `src/app/api/reports/cogs/route.ts` — emit `actualFoodCostPct`, `theoreticalFoodCostPct`, variance.
- `src/app/pass/page.tsx` — two food-cost heroes, wastage %, cost/cover, variance summary cell.
- `src/app/variance/page.tsx` — food-cost variance summary header.

---

## PHASE 1 — Pass strip: relabel + theoretical + adjacent ratios

### Task 1.1: Shared `startOfWeek` helper

**Files:**
- Create: `src/lib/dates.ts`
- Modify: `src/app/api/insights/cost-chrome/route.ts` (remove local `startOfWeek`, import shared)

- [ ] **Step 1: Create the helper**

```typescript
// src/lib/dates.ts
/** Start of the current week — Monday 00:00 local time. */
export function startOfWeek(d: Date): Date {
  const out = new Date(d)
  const day = out.getDay() || 7 // Sun = 0 → 7
  if (day !== 1) out.setHours(-24 * (day - 1))
  out.setHours(0, 0, 0, 0)
  return out
}
```

- [ ] **Step 2: Use it in cost-chrome**

In `src/app/api/insights/cost-chrome/route.ts`: add `import { startOfWeek } from '@/lib/dates'` near the top, and DELETE the local `function startOfWeek(d: Date): Date { ... }` at the bottom of the file. Leave the call site `const weekStart = startOfWeek(now)` unchanged.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles; no "startOfWeek is not defined" / duplicate-declaration errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/dates.ts src/app/api/insights/cost-chrome/route.ts
git commit -m "refactor(dates): extract shared startOfWeek helper"
```

---

### Task 1.2: Batched theoretical-cost helper

**Files:**
- Create: `src/lib/theoretical-cost.ts`

- [ ] **Step 1: Create the helper**

```typescript
// src/lib/theoretical-cost.ts
import { fetchRecipeWithCost } from './recipeCosts'

export interface TheoreticalCostResult {
  /** Σ qtySold × costPerPortion across all line items with a resolvable cost. */
  theoreticalCost: number
  /** Distinct recipes sold that had a resolvable costPerPortion. */
  costedRecipes: number
  /** Distinct recipes sold (denominator for coverage). */
  totalRecipes: number
}

/**
 * Sum theoretical plate cost over sold line items.
 * Dedupes recipe lookups; reuses fetchRecipeWithCost so nested PREP costs
 * resolve correctly (do NOT re-implement cost resolution here — see the
 * nested-PREP cost bug history).
 * A recipe whose costPerPortion is null (e.g. no portionSize) is treated as
 * uncosted: it contributes 0 and counts against coverage.
 */
export async function theoreticalCostForLineItems(
  lineItems: Array<{ recipeId: string; qtySold: number }>,
): Promise<TheoreticalCostResult> {
  const distinctIds = Array.from(new Set(lineItems.map(li => li.recipeId)))
  const recipes = await Promise.all(distinctIds.map(id => fetchRecipeWithCost(id)))

  const costPerPortion = new Map<string, number | null>()
  distinctIds.forEach((id, i) => costPerPortion.set(id, recipes[i]?.costPerPortion ?? null))

  let theoreticalCost = 0
  let costedRecipes = 0
  for (const id of distinctIds) {
    const cpp = costPerPortion.get(id)
    if (cpp != null) costedRecipes++
  }
  for (const li of lineItems) {
    const cpp = costPerPortion.get(li.recipeId)
    if (cpp != null) theoreticalCost += li.qtySold * cpp
  }
  return { theoreticalCost, costedRecipes, totalRecipes: distinctIds.length }
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/theoretical-cost.ts
git commit -m "feat(cost): batched theoretical plate-cost helper"
```

---

### Task 1.3: Dashboard endpoint — WTD food-cost block

**Files:**
- Modify: `src/app/api/reports/dashboard/route.ts`

- [ ] **Step 1: Add imports**

At the top of `src/app/api/reports/dashboard/route.ts`, add:

```typescript
import { startOfWeek } from '@/lib/dates'
import { theoreticalCostForLineItems } from '@/lib/theoretical-cost'
```

- [ ] **Step 2: Add WTD queries to the Promise.all block**

The handler already has a `Promise.all([...])` destructured as `[inventoryRaw, weekWastage, monthWastage, recentInvoices, weeklySales, weeklyPurchases]`. Add three more entries and extend the destructure. Insert `const weekStart = startOfWeek(now)` just after the existing `const monthAgo = ...` line. Then change the destructure + array to:

```typescript
  const weekStart = startOfWeek(now)

  const [
    inventoryRaw, weekWastage, monthWastage, recentInvoices, weeklySales, weeklyPurchases,
    salesWTD, purchasesWTD,
  ] = await Promise.all([
    // ...keep the six existing queries exactly as they are...
    // (inventoryItem.findMany, weekWastage aggregate, monthWastage aggregate,
    //  invoiceSession.findMany, salesEntry.findMany weeklySales, invoiceScanItem weeklyPurchases)
    prisma.salesEntry.findMany({
      where: { date: { gte: weekStart }, ...rcFilter },
      select: {
        totalRevenue: true, foodSalesPct: true, covers: true,
        lineItems: { select: { recipeId: true, qtySold: true } },
      },
    }),
    prisma.invoiceScanItem.aggregate({
      where: {
        approved: true,
        splitToSessionId: null,
        session: { approvedAt: { gte: weekStart }, ...(rcId ? { revenueCenterId: rcId } : {}) },
      },
      _sum: { rawLineTotal: true },
    }),
  ])
```

(The six original queries stay verbatim — only the two new ones are appended and the destructure widened.)

- [ ] **Step 3: Compute the WTD block**

Just before the final `return NextResponse.json({...})`, add:

```typescript
  // ── WTD food-cost block (single Monday-WTD window; all cells comparable) ──
  const foodSalesWTD = salesWTD.reduce(
    (s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
  const revenueWTD = salesWTD.reduce((s, e) => s + Number(e.totalRevenue), 0)
  const purchasesWTDTotal = Number(purchasesWTD._sum.rawLineTotal ?? 0)

  const wtdLineItems = salesWTD.flatMap(e => e.lineItems)
  const theo = await theoreticalCostForLineItems(wtdLineItems)

  const purchaseFoodCostPct  = foodSalesWTD > 0 ? (purchasesWTDTotal / foodSalesWTD) * 100 : null
  const theoreticalFoodCostPct = foodSalesWTD > 0 ? (theo.theoreticalCost / foodSalesWTD) * 100 : null

  const coversWTD = salesWTD.reduce((s, e) => s + (e.covers ?? 0), 0)
  const avgCheck     = coversWTD > 0 ? revenueWTD / coversWTD : null
  const revPerCover  = coversWTD > 0 ? foodSalesWTD / coversWTD : null
  const costPerCover = coversWTD > 0 ? theo.theoreticalCost / coversWTD : null

  // Wastage % uses the existing rolling-7d wastage $ + 7d food sales so the two
  // wastage figures (the $ cell and this %) share one window.
  const wastagePctOfSales = weeklyFoodSales > 0 ? (weeklyWastageCost / weeklyFoodSales) * 100 : null
```

- [ ] **Step 4: Return the new fields**

Add these keys to the returned JSON object (inside the existing `NextResponse.json({ ... })`):

```typescript
    weekStartWTD: weekStart.toISOString(),
    foodSalesWTD,
    purchasesWTD: purchasesWTDTotal,
    purchaseFoodCostPct,
    theoreticalCostWTD: theo.theoreticalCost,
    theoreticalFoodCostPct,
    theoreticalCoverage: { costed: theo.costedRecipes, total: theo.totalRecipes },
    wastagePctOfSales,
    coversWTD,
    avgCheck,
    revPerCover,
    costPerCover,
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: compiles; dashboard route still listed as `ƒ (Dynamic)` in output.

- [ ] **Step 6: Live check**

Start the preview (`RestaurantOS (Next.js)`), then in `preview_eval` run:

```javascript
fetch('/api/reports/dashboard').then(r=>r.json()).then(d=>({
  purchaseFoodCostPct:d.purchaseFoodCostPct, theoreticalFoodCostPct:d.theoreticalFoodCostPct,
  coverage:d.theoreticalCoverage, costPerCover:d.costPerCover, wastagePctOfSales:d.wastagePctOfSales
}))
```

Expected: object with numeric (or null) fields and a `coverage {costed,total}` where `costed ≤ total`.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/reports/dashboard/route.ts
git commit -m "feat(dashboard): WTD food-cost block (theoretical, purchase, wastage%, per-cover)"
```

---

### Task 1.4: Pass strip — two food-cost heroes + ratios

**Files:**
- Modify: `src/app/pass/page.tsx`

- [ ] **Step 1: Extend the `DashboardData` interface**

Add these fields to `interface DashboardData`:

```typescript
  purchaseFoodCostPct: number | null
  theoreticalFoodCostPct: number | null
  theoreticalCoverage: { costed: number; total: number }
  wastagePctOfSales: number | null
  coversWTD: number
  avgCheck: number | null
  revPerCover: number | null
  costPerCover: number | null
```

- [ ] **Step 2: Replace `HeroKPI` with a generic `FoodCostHero`**

Delete the existing `function HeroKPI({ chrome, dashboard }) { ... }` and replace with (module scope):

```tsx
function FoodCostHero({ label, sub, pct, target, footer }: {
  label: string; sub: string; pct: number | null; target: number; footer?: React.ReactNode
}) {
  const intStr = pct !== null ? Math.floor(pct).toString() : '—'
  const decimal = pct !== null ? `.${(pct % 1).toFixed(1).slice(2)}%` : ''
  return (
    <div className="bg-ink text-paper rounded-[12px] border border-ink p-5 flex flex-col justify-between min-h-[128px] relative overflow-hidden">
      <div>
        <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em]">{label}</div>
        <div className="font-mono text-[9px] text-ink-4 tracking-[0.01em] mt-0.5">{sub}</div>
        <div className="text-[44px] font-semibold tracking-[-0.045em] leading-none mt-2">
          {intStr}<sub className="text-[20px] font-medium text-gold tracking-[-0.02em] align-baseline">{decimal}</sub>
        </div>
      </div>
      <div className="font-mono text-[11px] text-ink-3 tracking-[0]">
        {footer ?? (
          <>target <b className="text-paper">{target.toFixed(1)}</b>
            {pct !== null && (
              <> · <span className={pct > target ? 'text-red' : 'text-green'}>
                {pct > target ? '+' : ''}{(pct - target).toFixed(1)}
              </span> vs target</>
            )}
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Render both heroes + update the grid**

Replace the KPI grid block (`<div className="grid gap-3 mb-6 grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]"> ... </div>`) with:

```tsx
        <div className="grid gap-3 mb-6 grid-cols-2 lg:grid-cols-[1.2fr_1.2fr_1fr_1fr_1fr]">
          <FoodCostHero
            label="PURCHASE COST · WTD" sub="invoices ÷ food sales"
            pct={dashboard?.purchaseFoodCostPct ?? chrome?.foodCostPct ?? null}
            target={chrome?.targetPct ?? 27}
          />
          <FoodCostHero
            label="THEORETICAL FOOD COST · WTD" sub="from recipe costs"
            pct={dashboard?.theoreticalFoodCostPct ?? null}
            target={chrome?.targetPct ?? 27}
            footer={dashboard ? (
              <>
                {dashboard.costPerCover != null
                  ? <><b className="text-paper">{formatCurrency(dashboard.costPerCover)}</b>/cover</>
                  : <>per-cover n/a</>}
                {' · '}
                <span className="text-ink-4">
                  {dashboard.theoreticalCoverage.costed}/{dashboard.theoreticalCoverage.total} items costed
                </span>
              </>
            ) : undefined}
          />
          <KPI label="THEORETICAL ON HAND"
            value={dashboard ? formatCurrency(dashboard.totalInventoryValue) : '—'}
            delta={<><b>{dashboard?.outOfStockCount ?? 0}</b> out of stock</>}
          />
          <KPI label="PREP TO DO"
            value={prepSummary.total.toString()}
            delta={
              prepSummary.top.filter(p => p.priority === '911').length > 0
                ? <><b className="text-red-text">{prepSummary.top.filter(p => p.priority === '911').length} critical</b></>
                : <>all on par</>
            }
          />
          <KPI label="WASTAGE · 7D"
            value={dashboard ? formatCurrency(dashboard.weeklyWastageCost) : '—'}
            valueClass={dashboard && dashboard.weeklyWastageCost > 0 ? 'text-red-text' : ''}
            delta={dashboard?.wastagePctOfSales != null
              ? <><b className={dashboard.wastagePctOfSales > 3 ? 'text-red-text' : ''}>{dashboard.wastagePctOfSales.toFixed(1)}%</b> of food sales</>
              : <>tracked from <b>waste log</b></>}
          />
        </div>
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles; no unused `HeroKPI` reference remains (grep `HeroKPI` → no hits).

- [ ] **Step 5: Live check**

Reload `/pass` in preview. `preview_snapshot` (or screenshot) and confirm: two dark hero cells side by side — "PURCHASE COST · WTD" and "THEORETICAL FOOD COST · WTD" — then On hand / Prep / Wastage. Wastage cell shows a "% of food sales" sub-line.

- [ ] **Step 6: Commit**

```bash
git add src/app/pass/page.tsx
git commit -m "feat(pass): split food-cost into purchase + theoretical heroes; wastage% + cost/cover"
```

---

## PHASE 2 — Actual food cost % + theoretical-vs-actual variance

### Task 2.1: `computePeriodCogs` helper

**Files:**
- Create: `src/lib/cogs.ts`

- [ ] **Step 1: Create the helper**

```typescript
// src/lib/cogs.ts
import { prisma } from './prisma'

export interface PeriodCogs {
  openingValue: number
  closingValue: number
  purchases: number
  cogs: number              // opening + purchases − closing
  foodSales: number
  openingSessionId: string | null
  closingSessionId: string | null
  /** True when fewer than two finalized counts bound the period. */
  needsCounts: boolean
}

const ms = (v: Date | number | string | null | undefined): number => {
  if (!v) return 0
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  return new Date(String(v).replace(' ', 'T')).getTime()
}

/**
 * Global, snapshot-based COGS for a date range.
 * Opening = most recent finalized count ≤ startMs; Closing = most recent ≤ endMs.
 * Purchases summed from approved InvoiceSession scan items in range.
 * (Global only — per-RC actual COGS needs per-RC snapshots; not supported.)
 */
export async function computePeriodCogs(startMs: number, endMs: number): Promise<PeriodCogs> {
  const sessions = await prisma.countSession.findMany({
    where: { status: 'FINALIZED' },
    select: { id: true, finalizedAt: true, totalCountedValue: true },
  })
  sessions.sort((a, b) => ms(a.finalizedAt) - ms(b.finalizedAt))

  const opening = [...sessions].reverse().find(s => ms(s.finalizedAt) <= startMs) ?? null
  const closing = [...sessions].reverse().find(s => ms(s.finalizedAt) <= endMs) ?? null

  const openingValue = opening ? Number(opening.totalCountedValue) : 0
  const closingValue = closing ? Number(closing.totalCountedValue) : 0

  const purchasesAgg = await prisma.invoiceScanItem.aggregate({
    where: {
      approved: true,
      splitToSessionId: null,
      session: { approvedAt: { gte: new Date(startMs), lte: new Date(endMs) } },
    },
    _sum: { rawLineTotal: true },
  })
  const purchases = Number(purchasesAgg._sum.rawLineTotal ?? 0)

  const salesAgg = await prisma.salesEntry.findMany({
    where: { date: { gte: new Date(startMs), lte: new Date(endMs) } },
    select: { totalRevenue: true, foodSalesPct: true },
  })
  const foodSales = salesAgg.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)

  return {
    openingValue, closingValue, purchases,
    cogs: openingValue + purchases - closingValue,
    foodSales,
    openingSessionId: opening?.id ?? null,
    closingSessionId: closing?.id ?? null,
    needsCounts: !opening || !closing || opening.id === closing.id,
  }
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/cogs.ts
git commit -m "feat(cogs): global period-COGS helper from count snapshots"
```

---

### Task 2.2: `/api/insights/food-cost-variance` endpoint

**Files:**
- Create: `src/app/api/insights/food-cost-variance/route.ts`

- [ ] **Step 1: Create the route**

```typescript
// src/app/api/insights/food-cost-variance/route.ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { computePeriodCogs } from '@/lib/cogs'
import { theoreticalCostForLineItems } from '@/lib/theoretical-cost'

export const dynamic = 'force-dynamic'

// GET /api/insights/food-cost-variance
// Actual vs theoretical food cost % for the most recently closed count period
// (between the last two finalized counts). Global only.
export async function GET() {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const sessions = await prisma.countSession.findMany({
    where: { status: 'FINALIZED' },
    orderBy: { finalizedAt: 'desc' },
    take: 2,
    select: { id: true, finalizedAt: true, sessionDate: true },
  })

  if (sessions.length < 2 || !sessions[0].finalizedAt || !sessions[1].finalizedAt) {
    return NextResponse.json({
      needsCounts: true,
      message: 'Need at least two finalized counts to measure actual food cost.',
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const [closing, opening] = sessions // desc: [0]=latest, [1]=previous
  const startMs = new Date(opening.finalizedAt).getTime()
  const endMs   = new Date(closing.finalizedAt).getTime()

  const cogs = await computePeriodCogs(startMs, endMs)

  const lineItems = await prisma.saleLineItem.findMany({
    where: { sale: { date: { gte: new Date(startMs), lte: new Date(endMs) } } },
    select: { recipeId: true, qtySold: true },
  })
  const theo = await theoreticalCostForLineItems(lineItems)

  const actualFoodCostPct      = cogs.foodSales > 0 ? (cogs.cogs / cogs.foodSales) * 100 : null
  const theoreticalFoodCostPct = cogs.foodSales > 0 ? (theo.theoreticalCost / cogs.foodSales) * 100 : null
  const variancePctPoints =
    actualFoodCostPct != null && theoreticalFoodCostPct != null
      ? actualFoodCostPct - theoreticalFoodCostPct : null
  const varianceDollars = cogs.cogs - theo.theoreticalCost

  return NextResponse.json({
    needsCounts: false,
    globalOnly: true,
    period: { startDate: opening.finalizedAt, endDate: closing.finalizedAt },
    actualFoodCostPct,
    theoreticalFoodCostPct,
    variancePctPoints,
    varianceDollars,
    cogs: cogs.cogs,
    theoreticalCost: theo.theoreticalCost,
    foodSales: cogs.foodSales,
    coverage: { costed: theo.costedRecipes, total: theo.totalRecipes },
  }, { headers: { 'Cache-Control': 'no-store' } })
}
```

- [ ] **Step 2: Build + live check**

Run: `npm run build` (expect route listed `ƒ (Dynamic)`).
In `preview_eval`: `fetch('/api/insights/food-cost-variance').then(r=>r.json())`
Expected: either `{needsCounts:true,...}` (if <2 counts) or an object with `actualFoodCostPct`, `theoreticalFoodCostPct`, `variancePctPoints`, `varianceDollars`, `period`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/insights/food-cost-variance/route.ts
git commit -m "feat(insights): food-cost variance endpoint (actual vs theoretical, last count period)"
```

---

### Task 2.3: COGS report endpoint — emit food-cost % + variance

**Files:**
- Modify: `src/app/api/reports/cogs/route.ts`

- [ ] **Step 1: Add the theoretical import**

At the top of `src/app/api/reports/cogs/route.ts` add:

```typescript
import { theoreticalCostForLineItems } from '@/lib/theoretical-cost'
```

- [ ] **Step 2: Compute the new fields in COGS-mode**

The COGS-mode section already computes `cogs` (opening + purchases − closing) and queries `salesEntries` for the range with `foodSalesPct`. Find where food sales total is summed (search for `salesEntries` near the end of the handler). Immediately after the food-sales total is available (call it `foodSalesTotal` — if the existing variable has another name, reuse it; do NOT introduce a duplicate sum), add:

```typescript
  // Theoretical cost over the same range (recipe-based), for variance.
  const cogsLineItems = await prisma.saleLineItem.findMany({
    where: { sale: { date: { gte: rangeStart, lte: rangeEnd } } },
    select: { recipeId: true, qtySold: true },
  })
  const cogsTheo = await theoreticalCostForLineItems(cogsLineItems)

  const actualFoodCostPct      = foodSalesTotal > 0 ? (cogs / foodSalesTotal) * 100 : null
  const theoreticalFoodCostPct = foodSalesTotal > 0 ? (cogsTheo.theoreticalCost / foodSalesTotal) * 100 : null
  const foodCostVariancePts =
    actualFoodCostPct != null && theoreticalFoodCostPct != null
      ? actualFoodCostPct - theoreticalFoodCostPct : null
```

> NOTE: If the handler does not already have a single `foodSalesTotal` number, add `const foodSalesTotal = salesEntries.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)` using the actual `salesEntries` variable name in scope.

- [ ] **Step 3: Add fields to the COGS-mode response**

In the `NextResponse.json({...})` returned by COGS-mode, add:

```typescript
    actualFoodCostPct,
    theoreticalFoodCostPct,
    foodCostVariancePts,
    theoreticalCost: cogsTheo.theoreticalCost,
    theoreticalCoverage: { costed: cogsTheo.costedRecipes, total: cogsTheo.totalRecipes },
```

- [ ] **Step 4: Build + live check**

Run: `npm run build`.
In `preview_eval`, pick a wide range:
```javascript
fetch('/api/reports/cogs?startDate=2026-01-01&endDate=2026-06-12').then(r=>r.json()).then(d=>({actual:d.actualFoodCostPct,theo:d.theoreticalFoodCostPct,varPts:d.foodCostVariancePts}))
```
Expected: numeric or null `actual`/`theo`/`varPts`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/reports/cogs/route.ts
git commit -m "feat(reports): COGS endpoint emits actual/theoretical food cost % + variance"
```

---

### Task 2.4: Surface variance on Pass + Variance page

**Files:**
- Modify: `src/app/pass/page.tsx`
- Modify: `src/app/variance/page.tsx`

- [ ] **Step 1: Fetch variance on Pass**

In `src/app/pass/page.tsx`, add state near the other `useState`s:

```typescript
  const [fcVariance, setFcVariance] = useState<{
    needsCounts: boolean
    actualFoodCostPct?: number | null
    theoreticalFoodCostPct?: number | null
    variancePctPoints?: number | null
    varianceDollars?: number
    period?: { startDate: string; endDate: string }
  } | null>(null)
```

In the existing `load()` `Promise.all`, append one more fetch and capture it (add `, fv` to the destructure and a `if (fv) setFcVariance(fv)` after):

```typescript
          fetch('/api/insights/food-cost-variance', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
```

- [ ] **Step 2: Render a variance line under the hero grid**

Immediately AFTER the closing `</div>` of the KPI grid (the `grid ... lg:grid-cols-[1.2fr_1.2fr_1fr_1fr_1fr]` block), add:

```tsx
        {fcVariance && !fcVariance.needsCounts && fcVariance.variancePctPoints != null && (
          <div className="mb-6 -mt-3 flex items-center gap-3 font-mono text-[11px] text-ink-3">
            <span className="w-1.5 h-1.5 rounded-full bg-gold" />
            <span>
              SHRINKAGE · last count period —
              actual <b className="text-ink">{fcVariance.actualFoodCostPct!.toFixed(1)}%</b> vs
              theoretical <b className="text-ink">{fcVariance.theoreticalFoodCostPct!.toFixed(1)}%</b> ·
              drift <b className={fcVariance.variancePctPoints > 0 ? 'text-red-text' : 'text-green'}>
                {fcVariance.variancePctPoints > 0 ? '+' : ''}{fcVariance.variancePctPoints.toFixed(1)} pts
              </b>
              {fcVariance.varianceDollars != null && <> ({formatCurrency(fcVariance.varianceDollars)})</>}
            </span>
            <span className="text-ink-4">global only</span>
          </div>
        )}
```

- [ ] **Step 3: Add the same summary to the Variance page header**

In `src/app/variance/page.tsx`, add state + fetch:

```typescript
  const [fc, setFc] = useState<{ needsCounts: boolean; actualFoodCostPct?: number | null; theoreticalFoodCostPct?: number | null; variancePctPoints?: number | null; varianceDollars?: number } | null>(null)
  useEffect(() => {
    fetch('/api/insights/food-cost-variance', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null).then(j => j && setFc(j))
  }, [])
```

Then directly under the `<PageHead .../>` element, add:

```tsx
      {fc && !fc.needsCounts && fc.variancePctPoints != null && (
        <div className="mb-4 rounded-[12px] border border-line bg-paper p-4 flex flex-wrap items-center gap-x-6 gap-y-1 font-mono text-[12px]">
          <span className="text-ink-3">FOOD COST · last count period</span>
          <span>actual <b className="text-ink">{fc.actualFoodCostPct!.toFixed(1)}%</b></span>
          <span>theoretical <b className="text-ink">{fc.theoreticalFoodCostPct!.toFixed(1)}%</b></span>
          <span>drift <b className={fc.variancePctPoints > 0 ? 'text-red-text' : 'text-green'}>
            {fc.variancePctPoints > 0 ? '+' : ''}{fc.variancePctPoints.toFixed(1)} pts
          </b>{fc.varianceDollars != null && <> ({formatCurrency(fc.varianceDollars)})</>}</span>
        </div>
      )}
```

- [ ] **Step 4: Build + live check**

Run: `npm run build`.
Reload `/pass` and `/variance` in preview. If ≥2 finalized counts exist, the shrinkage line/card shows actual/theoretical/drift; otherwise it is absent (no error, no NaN).

- [ ] **Step 5: Commit**

```bash
git add src/app/pass/page.tsx src/app/variance/page.tsx
git commit -m "feat(variance): surface actual-vs-theoretical food-cost shrinkage on Pass + Variance"
```

---

## PHASE 3 — Menu engineering & inventory efficiency

### Task 3.1: Menu-engineering endpoint

**Files:**
- Create: `src/app/api/reports/menu-engineering/route.ts`

- [ ] **Step 1: Create the route**

```typescript
// src/app/api/reports/menu-engineering/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { fetchRecipeWithCost } from '@/lib/recipeCosts'

export const dynamic = 'force-dynamic'

type Quadrant = 'STAR' | 'PLOWHORSE' | 'PUZZLE' | 'DOG'

// GET /api/reports/menu-engineering?days=30
// Classifies MENU dishes by popularity (qty sold) × profitability (contribution
// margin = menuPrice − costPerPortion), split on the medians.
export async function GET(req: NextRequest) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const days = Number(new URL(req.url).searchParams.get('days') ?? 30)
  const since = new Date(); since.setDate(since.getDate() - days)

  const lineItems = await prisma.saleLineItem.findMany({
    where: { sale: { date: { gte: since } } },
    select: { recipeId: true, qtySold: true },
  })

  const qtyByRecipe = new Map<string, number>()
  for (const li of lineItems) qtyByRecipe.set(li.recipeId, (qtyByRecipe.get(li.recipeId) ?? 0) + li.qtySold)

  const ids = Array.from(qtyByRecipe.keys())
  const recipes = await Promise.all(ids.map(id => fetchRecipeWithCost(id)))

  const dishes = recipes.flatMap((r, i) => {
    if (!r || r.type !== 'MENU') return []
    const qty = qtyByRecipe.get(ids[i]) ?? 0
    const cost = r.costPerPortion
    const price = r.menuPrice
    const margin = price != null && cost != null ? price - cost : null
    return [{
      recipeId: r.id, name: r.name, qtySold: qty,
      menuPrice: price, costPerPortion: cost, margin,
      foodCostPct: r.foodCostPct,
    }]
  })

  const median = (xs: number[]): number => {
    if (xs.length === 0) return 0
    const s = [...xs].sort((a, b) => a - b)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }
  const medPopularity = median(dishes.map(d => d.qtySold))
  const medMargin     = median(dishes.filter(d => d.margin != null).map(d => d.margin as number))

  const classified = dishes.map(d => {
    let quadrant: Quadrant | null = null
    if (d.margin != null) {
      const popular = d.qtySold >= medPopularity
      const profitable = d.margin >= medMargin
      quadrant = popular && profitable ? 'STAR'
        : popular && !profitable ? 'PLOWHORSE'
        : !popular && profitable ? 'PUZZLE' : 'DOG'
    }
    return { ...d, quadrant }
  })

  return NextResponse.json({
    days, medianPopularity: medPopularity, medianMargin: medMargin,
    dishes: classified.sort((a, b) => b.qtySold - a.qtySold),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
```

- [ ] **Step 2: Build + live check**

Run: `npm run build`.
`preview_eval`: `fetch('/api/reports/menu-engineering?days=60').then(r=>r.json()).then(d=>({n:d.dishes.length,sample:d.dishes[0]}))`
Expected: `dishes` array; each item has a `quadrant` of STAR/PLOWHORSE/PUZZLE/DOG or null (uncosted).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/reports/menu-engineering/route.ts
git commit -m "feat(reports): menu-engineering endpoint (stars/plowhorses/puzzles/dogs)"
```

---

### Task 3.2: Menu-engineering view

**Files:**
- Create: `src/app/reports/menu/page.tsx`

- [ ] **Step 1: Create the page**

```tsx
// src/app/reports/menu/page.tsx
'use client'
import { useEffect, useState } from 'react'
import { PageHead } from '@/components/layout/PageHead'
import { formatCurrency } from '@/lib/utils'

interface Dish {
  recipeId: string; name: string; qtySold: number
  menuPrice: number | null; costPerPortion: number | null; margin: number | null
  foodCostPct: number | null
  quadrant: 'STAR' | 'PLOWHORSE' | 'PUZZLE' | 'DOG' | null
}
interface Resp { days: number; medianPopularity: number; medianMargin: number; dishes: Dish[] }

const QUADRANT_META: Record<string, { label: string; cls: string }> = {
  STAR:      { label: '⭐ Stars',      cls: 'text-green' },
  PLOWHORSE: { label: '🐴 Plowhorses', cls: 'text-ink' },
  PUZZLE:    { label: '❓ Puzzles',    cls: 'text-gold-2' },
  DOG:       { label: '🐶 Dogs',       cls: 'text-red-text' },
}

export default function MenuEngineeringPage() {
  const [data, setData] = useState<Resp | null>(null)
  const [days, setDays] = useState<30 | 60 | 90>(30)

  useEffect(() => {
    fetch(`/api/reports/menu-engineering?days=${days}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null).then(j => j && setData(j))
  }, [days])

  const groups: Array<keyof typeof QUADRANT_META> = ['STAR', 'PLOWHORSE', 'PUZZLE', 'DOG']

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <PageHead title="Menu Engineering"
        sub={data ? <>Last <b>{data.days}d</b> · {data.dishes.length} dishes · split at median popularity <b>{data.medianPopularity}</b> / margin <b>{formatCurrency(data.medianMargin)}</b></> : <>Loading…</>} />

      <div className="flex gap-2 mb-4">
        {([30, 60, 90] as const).map(d => (
          <button key={d} onClick={() => setDays(d)}
            className={`px-3 py-1 rounded-md font-mono text-[12px] border ${days === d ? 'bg-ink text-paper border-ink' : 'border-line text-ink-3'}`}>
            {d}d
          </button>
        ))}
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        {groups.map(q => {
          const items = (data?.dishes ?? []).filter(d => d.quadrant === q)
          return (
            <div key={q} className="rounded-[12px] border border-line bg-paper p-4">
              <div className={`font-mono text-[12px] mb-3 ${QUADRANT_META[q].cls}`}>{QUADRANT_META[q].label} · {items.length}</div>
              <div className="space-y-2">
                {items.map(d => (
                  <div key={d.recipeId} className="flex items-center justify-between text-[13px]">
                    <span className="text-ink truncate mr-2">{d.name}</span>
                    <span className="font-mono text-[11px] text-ink-3 whitespace-nowrap">
                      ×{d.qtySold} · {d.margin != null ? formatCurrency(d.margin) : '—'} margin
                    </span>
                  </div>
                ))}
                {items.length === 0 && <div className="text-ink-4 text-[12px]">none</div>}
              </div>
            </div>
          )
        })}
      </div>

      {(data?.dishes ?? []).some(d => d.quadrant === null) && (
        <div className="mt-4 font-mono text-[11px] text-ink-4">
          {(data?.dishes ?? []).filter(d => d.quadrant === null).length} dish(es) hidden — no menu price or cost set.
        </div>
      )}
    </div>
  )
}
```

> If `PageHead` props differ from `{ title, sub }`, match the signature used in `src/app/variance/page.tsx` (it imports the same component) — copy that usage exactly.

- [ ] **Step 2: Build + live check**

Run: `npm run build`.
Navigate to `/reports/menu` in preview; confirm four quadrant cards render with dishes, and the day toggle re-fetches.

- [ ] **Step 3: Commit**

```bash
git add src/app/reports/menu/page.tsx
git commit -m "feat(reports): menu-engineering quadrant view"
```

---

### Task 3.3: Inventory-efficiency endpoint (turns / days-on-hand)

**Files:**
- Create: `src/app/api/reports/inventory-efficiency/route.ts`

- [ ] **Step 1: Create the route**

```typescript
// src/app/api/reports/inventory-efficiency/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { computePeriodCogs } from '@/lib/cogs'

export const dynamic = 'force-dynamic'

// GET /api/reports/inventory-efficiency?days=30
// Inventory turns and days-on-hand from trailing-window COGS + current on-hand.
export async function GET(req: NextRequest) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const days = Number(new URL(req.url).searchParams.get('days') ?? 30)
  const endMs = Date.now()
  const startMs = endMs - days * 86_400_000

  const cogs = await computePeriodCogs(startMs, endMs)

  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: { stockOnHand: true, pricePerBaseUnit: true },
  })
  const onHandValue = items.reduce((s, it) => s + Number(it.stockOnHand) * Number(it.pricePerBaseUnit), 0)

  const avgInventory = (cogs.openingValue + cogs.closingValue) / 2
  const periodCogs = cogs.cogs
  const dailyCogs = days > 0 ? periodCogs / days : 0

  const turns      = avgInventory > 0 ? periodCogs / avgInventory : null      // for the window
  const turnsAnnual = turns != null ? turns * (365 / days) : null
  const daysOnHand = dailyCogs > 0 ? onHandValue / dailyCogs : null

  return NextResponse.json({
    days, onHandValue, avgInventory, periodCogs,
    turns, turnsAnnual, daysOnHand,
    needsCounts: cogs.needsCounts,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
```

- [ ] **Step 2: Build + live check**

Run: `npm run build`.
`preview_eval`: `fetch('/api/reports/inventory-efficiency?days=30').then(r=>r.json())`
Expected: `{ onHandValue, daysOnHand, turnsAnnual, needsCounts, ... }`; if `needsCounts` is true, turns/daysOnHand may be null (acceptable — documented).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/reports/inventory-efficiency/route.ts
git commit -m "feat(reports): inventory turns / days-on-hand endpoint"
```

---

### Task 3.4: Inventory-efficiency tile on Pass strip (optional surface)

**Files:**
- Modify: `src/app/pass/page.tsx`

- [ ] **Step 1: Fetch + render days-on-hand**

Add state and a fetch in the existing `load()` (append to its `Promise.all` and destructure as `ie`):

```typescript
          fetch('/api/reports/inventory-efficiency?days=30', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
```
```typescript
  const [invEff, setInvEff] = useState<{ daysOnHand: number | null; turnsAnnual: number | null } | null>(null)
  // ...inside load(), after the await: if (ie) setInvEff(ie)
```

Add a sub-line to the existing "THEORETICAL ON HAND" KPI by changing its `delta` to:

```tsx
            delta={invEff?.daysOnHand != null
              ? <><b>{invEff.daysOnHand.toFixed(0)}</b> days on hand · <b>{dashboard?.outOfStockCount ?? 0}</b> out of stock</>
              : <><b>{dashboard?.outOfStockCount ?? 0}</b> out of stock</>}
```

- [ ] **Step 2: Build + live check**

Run: `npm run build`. Reload `/pass`; the On-hand KPI shows "N days on hand" when counts exist.

- [ ] **Step 3: Commit**

```bash
git add src/app/pass/page.tsx
git commit -m "feat(pass): days-on-hand on the on-hand KPI"
```

---

## Final verification

- [ ] `npm run build` clean; all new API routes show `ƒ (Dynamic)` in the build output.
- [ ] `/pass`: two food-cost heroes (purchase + theoretical) with the same denominator; wastage % sub-line; shrinkage line when ≥2 counts; days-on-hand on the on-hand KPI.
- [ ] `/variance`: food-cost shrinkage summary card above the drift table.
- [ ] `/reports/menu`: four quadrants populate.
- [ ] Reconcile by hand for one known week: `theoreticalFoodCostPct ≈ Σ(qty×costPerPortion) ÷ foodSalesWTD × 100`.
- [ ] RC switch on Pass updates purchase/theoretical/wastage; shrinkage line still reads "global only".

---

## Self-review notes (addressed)

- **Spec coverage:** Phase 1 (relabel, theoretical, wastage %, cost/cover) → Tasks 1.1–1.4; actual-vs-theoretical variance → Tasks 2.1–2.4; menu engineering → 3.1–3.2; inventory turns → 3.3–3.4. All spec sections mapped.
- **Type consistency:** `theoreticalCostForLineItems` returns `{ theoreticalCost, costedRecipes, totalRecipes }` — used consistently in 1.3, 2.2, 2.3. `computePeriodCogs` returns `{ openingValue, closingValue, purchases, cogs, foodSales, openingSessionId, closingSessionId, needsCounts }` — used in 2.2 and 3.3. Coverage shape `{ costed, total }` consistent across dashboard + variance + cogs.
- **Known limitations carried from spec:** actual food cost is global-only and count-period-bound; uncosted recipes reduce coverage rather than silently understating; per-cover/turns render `—`/null without counts or covers.
