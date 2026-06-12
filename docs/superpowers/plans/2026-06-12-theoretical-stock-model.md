# Theoretical Stock Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a per-revenue-center theoretical on-hand (computed at read time) the primary stock number the app reasons with, leaving the real `stockOnHand`/`StockAllocation` anchors writable only by counts, manual overrides, and stock pulls.

**Architecture:** Extend the existing `src/lib/count-expected.ts` engine with a prep term and a batch accessor, RC-tag prep, remove the prep/invoice writes to the real ledger, and rewire alerts + display to read theoretical. No new stored field — theoretical is always derived from the count baseline + immutable event logs.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma + PostgreSQL (Supabase), Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-12-theoretical-stock-model-design.md`

---

## Project-specific notes for the implementer

- **No test suite.** Per CLAUDE.md, `npm run build` is the only automated correctness check. This plan substitutes **verification probes** (throwaway `*.mjs` scripts run against the dev database) plus `npm run build` for the usual unit tests. Each task's "test" step writes a probe that asserts the behavior; you run it before (fail) and after (pass) implementing.
- **Node is not on PATH.** Prefix every node/npm command with:
  `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"`
  Run builds with `dangerouslyDisableSandbox: true`.
- **Probes must run from the project root** so they resolve `node_modules` and `@prisma/client`. Create `probe.mjs` in the repo root, run it, then `rm` it (do not commit probes). Probes are read-only except where a task explicitly creates+deletes temp rows in a `try/finally`.
- **Build clobbers the preview server.** If a preview dev server is running, `npm run build` corrupts its `.next`. Stop the preview before building, or restart it (`preview_stop` + `preview_start`, config "RestaurantOS (Next.js)") after.
- **Prisma migrate is broken** (`migrate dev` fails P3006 shadow drift). Add migrations with the diff/db-execute/resolve workaround shown in Task 1.
- **pgBouncer transaction mode:** never use `$executeRaw` tagged templates for array columns (not relevant here, but relevant if you touch settings).
- **Prisma Decimal fields serialize as strings** — always wrap with `Number()` before arithmetic.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `prisma/schema.prisma` | `PrepItem.revenueCenterId`, `PrepLog.revenueCenterId` | Modify |
| `prisma/migrations/<ts>_prep_revenue_center/migration.sql` | Additive columns | Create |
| `src/app/api/prep/items/route.ts`, `.../[id]/route.ts` | Accept/persist prep RC; PrepLog inherits item RC | Modify |
| `src/lib/count-expected.ts` | `buildPrepMap`, prep terms in `computeExpected`, `getTheoreticalStock`, `getTheoreticalStockMap` | Modify |
| `src/app/api/prep/logs/[id]/route.ts` | Remove `applyInventoryTransaction` real write | Modify |
| `src/app/api/prep/logs/[id]/revert/route.ts` | Remove stock-reversal | Modify |
| `src/app/api/invoices/[id]/process/route.ts` | Remove `stockOnHand` write | Modify |
| `src/app/api/prep/generate/route.ts` | Read theoretical on-hand | Modify |
| `src/lib/stock-display.ts` | Shared `formatStockOnHand` helper | Create |
| Inventory list/detail, prep KPI, cost-chrome, dashboard read sites | Theoretical headline + counted anchor | Modify |

---

## Phase 1 — Schema + RC tagging

### Task 1: Add `revenueCenterId` to PrepItem and PrepLog

**Files:**
- Modify: `prisma/schema.prisma` (model `PrepItem` ~449, model `PrepLog` ~473)
- Create: `prisma/migrations/20260612000000_prep_revenue_center/migration.sql`

- [ ] **Step 1: Edit the schema**

In `model PrepItem`, add after `linkedInventoryItemId`:
```prisma
  revenueCenterId        String?
```
and in its relations block:
```prisma
  revenueCenter          RevenueCenter? @relation("PrepItemRC", fields: [revenueCenterId], references: [id])
```

In `model PrepLog`, add after `prepItemId`:
```prisma
  revenueCenterId   String?
```
and in its relations block:
```prisma
  revenueCenter     RevenueCenter? @relation("PrepLogRC", fields: [revenueCenterId], references: [id])
```

Add the back-relations to `model RevenueCenter`:
```prisma
  prepItems   PrepItem[] @relation("PrepItemRC")
  prepLogs    PrepLog[]  @relation("PrepLogRC")
```

- [ ] **Step 2: Write the migration SQL**

Create `prisma/migrations/20260612000000_prep_revenue_center/migration.sql`:
```sql
ALTER TABLE "PrepItem" ADD COLUMN "revenueCenterId" TEXT;
ALTER TABLE "PrepLog"  ADD COLUMN "revenueCenterId" TEXT;
ALTER TABLE "PrepItem" ADD CONSTRAINT "PrepItem_revenueCenterId_fkey"
  FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PrepLog" ADD CONSTRAINT "PrepLog_revenueCenterId_fkey"
  FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply the migration (shadow-DB-broken workaround)**

Run:
```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
npx prisma db execute --file prisma/migrations/20260612000000_prep_revenue_center/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied 20260612000000_prep_revenue_center
npx prisma generate
```
Expected: `db execute` succeeds; `migrate resolve` marks it applied; `generate` regenerates the client.

- [ ] **Step 4: Verify the columns exist (probe)**

Create `probe.mjs` in repo root:
```js
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const item = await p.prepItem.findFirst({ select: { id: true, revenueCenterId: true } })
const log  = await p.prepLog.findFirst({ select: { id: true, revenueCenterId: true } })
console.log('PrepItem.revenueCenterId reachable:', item === null || 'revenueCenterId' in item)
console.log('PrepLog.revenueCenterId reachable:', log === null || 'revenueCenterId' in log)
await p.$disconnect()
```
Run: `export PATH=...:$PATH && node probe.mjs && rm probe.mjs`
Expected: both lines print `true` (no Prisma "unknown field" error).

- [ ] **Step 5: Build**

Run: `npm run build` (preview stopped). Expected: `✓ Compiled successfully`.

- [ ] **Step 6: Commit**
```bash
git add prisma/schema.prisma prisma/migrations/20260612000000_prep_revenue_center/migration.sql
git commit -m "feat(schema): add revenueCenterId to PrepItem and PrepLog"
```

---

### Task 2: Persist prep RC and inherit it on log creation

**Files:**
- Modify: `src/app/api/prep/items/route.ts` (POST), `src/app/api/prep/items/[id]/route.ts` (PATCH)
- Modify: `src/app/api/prep/logs/route.ts` (POST — inherit `revenueCenterId` from the prep item)

- [ ] **Step 1: Accept `revenueCenterId` on prep item create/update**

In `prep/items/route.ts` POST, read `revenueCenterId` from the body and include `revenueCenterId: revenueCenterId || null` in the `prisma.prepItem.create({ data })`.
In `prep/items/[id]/route.ts` PATCH, when `revenueCenterId !== undefined`, include `revenueCenterId: revenueCenterId || null` in the update data.

- [ ] **Step 2: Inherit RC when a PrepLog is created**

In `prep/logs/route.ts` POST, before creating the log, fetch the prep item's RC and set it on the log:
```ts
const prepItem = await prisma.prepItem.findUnique({
  where: { id: prepItemId },
  select: { revenueCenterId: true },
})
// ...inside prisma.prepLog.create({ data: { ... } }):
revenueCenterId: prepItem?.revenueCenterId ?? null,
```

- [ ] **Step 3: Verify inheritance (probe, temp rows in try/finally)**

`probe.mjs`:
```js
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const rc = await p.revenueCenter.findFirst({ select: { id: true } })
let itemId
try {
  const item = await p.prepItem.create({ data: { name: 'TMP probe item', revenueCenterId: rc?.id ?? null, unit: 'batch' } })
  itemId = item.id
  // simulate the POST inheritance
  const fetched = await p.prepItem.findUnique({ where: { id: itemId }, select: { revenueCenterId: true } })
  const log = await p.prepLog.create({ data: { prepItemId: itemId, logDate: new Date('2099-01-01'), revenueCenterId: fetched.revenueCenterId } })
  console.log('log inherited RC:', log.revenueCenterId === (rc?.id ?? null))
  await p.prepLog.delete({ where: { id: log.id } })
} finally {
  if (itemId) await p.prepItem.delete({ where: { id: itemId } })
  await p.$disconnect()
}
```
Run: `node probe.mjs && rm probe.mjs`. Expected: `log inherited RC: true`.

- [ ] **Step 4: Build.** Run `npm run build`. Expected: `✓ Compiled successfully`.

- [ ] **Step 5: Commit**
```bash
git add src/app/api/prep/items/route.ts src/app/api/prep/items/[id]/route.ts src/app/api/prep/logs/route.ts
git commit -m "feat(prep): persist prep RC and inherit it onto prep logs"
```

---

## Phase 2 — Theoretical engine

### Task 3: `buildPrepMap` — prep consumption + output per item, RC-scoped

**Files:**
- Modify: `src/lib/count-expected.ts` (add `buildPrepMap`; it already imports `prisma` and `convertQty`)

- [ ] **Step 1: Add the import for `computeScale`**

At the top of `count-expected.ts`:
```ts
import { computeScale } from '@/lib/prep-utils'
```

- [ ] **Step 2: Add `buildPrepMap`**

Append:
```ts
/**
 * Net prep movement since `since`, scoped to an RC (via the prep item's RC).
 * Mirrors the old prep-apply write but accumulates into maps instead of writing
 * stockOnHand: raws drawn down (consumption) and the prep item produced (output).
 * Stops at sub-prep items (charges the sub-prep's own inventory item), exactly like
 * the theoretical-usage report, so prep-in-prep never double-counts.
 */
export async function buildPrepMap(
  since: Date,
  rcId?: string | null,
): Promise<{ consumption: Map<string, number>; output: Map<string, number> }> {
  const logs = await prisma.prepLog.findMany({
    where: {
      status: { in: ['DONE', 'PARTIAL'] },
      actualPrepQty: { not: null },
      logDate: { gte: since },
      ...(rcId ? { revenueCenterId: rcId } : {}),
    },
    include: {
      prepItem: {
        include: {
          linkedRecipe: {
            include: {
              inventoryItem: { select: { id: true, baseUnit: true } },
              ingredients: {
                include: {
                  inventoryItem: { select: { id: true, baseUnit: true } },
                  linkedRecipe: { select: { inventoryItem: { select: { id: true, baseUnit: true } } } },
                },
              },
            },
          },
        },
      },
    },
  })

  const consumption = new Map<string, number>()
  const output = new Map<string, number>()
  const add = (m: Map<string, number>, id: string, q: number) => m.set(id, (m.get(id) ?? 0) + q)

  for (const log of logs) {
    const recipe = log.prepItem.linkedRecipe
    if (!recipe) continue
    const { scale } = computeScale(
      Number(log.actualPrepQty),
      log.prepItem.unit,
      recipe.yieldUnit,
      Number(recipe.baseYieldQty),
    )

    for (const ing of recipe.ingredients) {
      const qty = Number(ing.qtyBase) * scale
      if (ing.inventoryItemId && ing.inventoryItem) {
        add(consumption, ing.inventoryItem.id, convertQty(qty, ing.unit, ing.inventoryItem.baseUnit))
      } else if (ing.linkedRecipeId && ing.linkedRecipe?.inventoryItem) {
        const prep = ing.linkedRecipe.inventoryItem
        add(consumption, prep.id, convertQty(qty, ing.unit, prep.baseUnit))
      }
    }

    if (recipe.inventoryItemId && recipe.inventoryItem) {
      const yieldInBase = convertQty(Number(recipe.baseYieldQty), recipe.yieldUnit, recipe.inventoryItem.baseUnit) * scale
      add(output, recipe.inventoryItem.id, yieldInBase)
    }
  }

  return { consumption, output }
}
```

- [ ] **Step 3: Verify against a known prep log (probe)**

`probe.mjs` (creates a temp DONE prep log for an existing prep item with a linked recipe, asserts consumption+output are populated, cleans up):
```js
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const item = await p.prepItem.findFirst({
  where: { linkedRecipe: { isNot: null } },
  include: { linkedRecipe: { select: { yieldUnit: true, baseYieldQty: true, inventoryItemId: true } } },
})
if (!item) { console.log('NO PREP ITEM WITH RECIPE — skip'); await p.$disconnect(); process.exit(0) }
let logId
try {
  const log = await p.prepLog.create({ data: {
    prepItemId: item.id, logDate: new Date('2099-01-02'), status: 'DONE',
    actualPrepQty: Number(item.linkedRecipe.baseYieldQty), revenueCenterId: item.revenueCenterId,
  }})
  logId = log.id
  const { buildPrepMap } = await import('./src/lib/count-expected.ts')  // see note
  const { consumption, output } = await buildPrepMap(new Date('2099-01-01'), item.revenueCenterId)
  console.log('consumption entries:', consumption.size, '| output entries:', output.size)
  console.log('prep output recorded for linked item:', output.has(item.linkedRecipe.inventoryItemId))
} finally {
  if (logId) await p.prepLog.delete({ where: { id: logId } })
  await p.$disconnect()
}
```
Note: `.ts` import under plain node may not run. If it errors, instead inline-replicate `buildPrepMap` in the probe (copy the function body, replace `convertQty`/`computeScale` with inlined equivalents) — the goal is to confirm consumption+output maps are non-empty and the linked prep item appears in `output`.
Run: `node probe.mjs && rm probe.mjs`. Expected: `consumption entries` ≥ 1, `output entries` ≥ 1, `prep output recorded... true`.

- [ ] **Step 4: Build.** `npm run build`. Expected: `✓ Compiled successfully`.

- [ ] **Step 5: Commit**
```bash
git add src/lib/count-expected.ts
git commit -m "feat(stock): buildPrepMap — RC-scoped prep consumption + output"
```

---

### Task 4: Wire prep into `computeExpected` and add the theoretical accessors

**Files:**
- Modify: `src/lib/count-expected.ts`
- Modify: `src/app/api/count/sessions/route.ts` (pass prep maps so the count screen matches)

- [ ] **Step 1: Extend `computeExpected` with prep terms (backward-compatible)**

Replace `computeExpected` with:
```ts
export function computeExpected(
  itemId: string,
  baseStock: number,
  consumptionMap: Map<string, number>,
  purchaseMap: Map<string, number>,
  wastageMap: Map<string, number>,
  prepConsumptionMap?: Map<string, number>,
  prepOutputMap?: Map<string, number>,
): number {
  const consumption = consumptionMap.get(itemId) ?? 0
  const purchases   = purchaseMap.get(itemId)    ?? 0
  const wastage     = wastageMap.get(itemId)     ?? 0
  const prepCons    = prepConsumptionMap?.get(itemId) ?? 0
  const prepOut     = prepOutputMap?.get(itemId)      ?? 0
  return Math.max(0, baseStock + purchases + prepOut - consumption - wastage - prepCons)
}
```

- [ ] **Step 2: Add prep to `computeExpectedForItem` and export it as `getTheoreticalStock`**

In `computeExpectedForItem`, change the maps block to also build the prep map, and pass it through:
```ts
  const [consumptionMap, purchaseMap, wastageMap, prepMap] = await Promise.all([
    buildConsumptionMap(since, rcId),
    buildPurchaseMap(since, rcId),
    buildWastageMap(since, [itemId], rcId),
    buildPrepMap(since, rcId),
  ])

  return {
    expectedBase: computeExpected(itemId, baseStock, consumptionMap, purchaseMap, wastageMap, prepMap.consumption, prepMap.output),
    baseStock,
  }
```
Add an alias export at the end of the file:
```ts
/** Public name for the per-item theoretical on-hand (baseUnit), scoped to an RC. */
export const getTheoreticalStock = computeExpectedForItem
```

- [ ] **Step 3: Add the batch accessor `getTheoreticalStockMap`**

Append (mirrors the count-session route's earliest-lastCount batch strategy; the per-item-date imprecision is pre-existing and accepted):
```ts
/**
 * Theoretical on-hand (baseUnit) for many items at once, scoped to an RC.
 * Mirrors the count-session route: one lookback window (earliest lastCountDate),
 * RC baseline rule (global stock for default/no RC; StockAllocation else, 0 if
 * the RC never counted the item). Returns a Map itemId -> theoretical qty.
 */
export async function getTheoreticalStockMap(
  rcId: string | null | undefined,
  itemIds?: string[],
): Promise<Map<string, number>> {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true, ...(itemIds ? { id: { in: itemIds } } : {}) },
    select: { id: true, stockOnHand: true, lastCountDate: true },
  })

  const ids = items.map(i => i.id)
  const earliest = items
    .map(i => i.lastCountDate)
    .filter(Boolean)
    .sort((a, b) => ((a as Date) > (b as Date) ? 1 : -1))[0] as Date | undefined

  const empty = new Map<string, number>()
  const [consumptionMap, purchaseMap, wastageMap, prepMap] = earliest
    ? await Promise.all([
        buildConsumptionMap(earliest, rcId),
        buildPurchaseMap(earliest, rcId),
        buildWastageMap(earliest, ids, rcId),
        buildPrepMap(earliest, rcId),
      ])
    : [empty, empty, empty, { consumption: empty, output: empty }]

  const stockAllocationMap = new Map<string, number>()
  let isDefaultRc = false
  if (rcId && ids.length > 0) {
    const rc = await prisma.revenueCenter.findUnique({ where: { id: rcId }, select: { isDefault: true } })
    isDefaultRc = !!rc?.isDefault
    const allocs = await prisma.stockAllocation.findMany({
      where: { revenueCenterId: rcId, inventoryItemId: { in: ids } },
      select: { inventoryItemId: true, quantity: true },
    })
    for (const a of allocs) stockAllocationMap.set(a.inventoryItemId, Number(a.quantity))
  }

  const result = new Map<string, number>()
  for (const item of items) {
    const baseStock = rcId
      ? (stockAllocationMap.has(item.id) ? stockAllocationMap.get(item.id)! : (isDefaultRc ? Number(item.stockOnHand) : 0))
      : Number(item.stockOnHand)
    result.set(item.id, computeExpected(item.id, baseStock, consumptionMap, purchaseMap, wastageMap, prepMap.consumption, prepMap.output))
  }
  return result
}
```

- [ ] **Step 4: Update the count-session route to pass prep maps**

In `src/app/api/count/sessions/route.ts`, add `buildPrepMap` to the import from `@/lib/count-expected`, build it alongside the others using `earliestLastCount`, and pass `prepMap.consumption, prepMap.output` as the two extra args to `computeExpected(...)` in the `lines.create` map. (Build the prep map in the same `Promise.all`; when `earliestLastCount` is undefined, default to empty maps as the others do.)

- [ ] **Step 5: Verify theoretical reflects prep (probe)**

`probe.mjs` — pick an item, read its theoretical, add a temp DONE prep log that consumes it, confirm theoretical drops; clean up:
```js
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
// find a prep item whose recipe consumes a raw inventory item with a lastCountDate
const item = await p.prepItem.findFirst({
  where: { linkedRecipe: { is: { ingredients: { some: { inventoryItemId: { not: null } } } } } },
  include: { linkedRecipe: { include: { ingredients: { where: { inventoryItemId: { not: null } }, include: { inventoryItem: true }, take: 1 } } } },
})
if (!item) { console.log('skip — no suitable prep'); await p.$disconnect(); process.exit(0) }
const raw = item.linkedRecipe.ingredients[0].inventoryItem
await p.inventoryItem.update({ where: { id: raw.id }, data: { lastCountDate: new Date('2099-01-01'), stockOnHand: 100000 } })
const { getTheoreticalStock } = await import('./src/lib/count-expected.ts')
const before = (await getTheoreticalStock(raw.id, item.revenueCenterId)).expectedBase
let logId
try {
  const log = await p.prepLog.create({ data: { prepItemId: item.id, logDate: new Date('2099-01-02'), status: 'DONE', actualPrepQty: Number(item.linkedRecipe.baseYieldQty), revenueCenterId: item.revenueCenterId } })
  logId = log.id
  const after = (await getTheoreticalStock(raw.id, item.revenueCenterId)).expectedBase
  console.log('theoretical before:', before, 'after prep log:', after, '| dropped:', after < before)
} finally {
  if (logId) await p.prepLog.delete({ where: { id: logId } })
  await p.$disconnect()
}
```
If the `.ts` dynamic import fails under node, inline-replicate the needed functions (as in Task 3). Expected: `dropped: true`.

- [ ] **Step 6: Build.** `npm run build`. Expected: `✓ Compiled successfully`.

- [ ] **Step 7: Commit**
```bash
git add src/lib/count-expected.ts src/app/api/count/sessions/route.ts
git commit -m "feat(stock): prep terms in theoretical engine + batch accessor"
```

---

### Task 4b: Prep-coverage for the remaining expected-computation routes (added during execution)

Discovered during Task 4 review: two routes compute count "expected" via `computeExpected` with 5 args (no prep) and would silently undercount once the real prep write is removed.

**Files:**
- Modify: `src/app/api/count/areas/route.ts` (~line 66 `computeExpected(...)`)
- Modify: `src/app/api/count/sessions/[id]/sync/route.ts` (~line 105, `getExpected`)

- [ ] Add `buildPrepMap` to each route's map-building (same `since`/RC scope + `earliest`-guard pattern as the count-session route) and append `prepMap.consumption, prepMap.output` to each `computeExpected(...)` call. Verify build; commit.

## Phase 3 — Cut writes over to theoretical

### Task 5: Remove the prep real write

**Files:**
- Modify: `src/app/api/prep/logs/[id]/route.ts` (delete `applyInventoryTransaction` + its invocation; drop `inventoryAdjusted` gating)
- Modify: `src/app/api/prep/logs/[id]/revert/route.ts` (delete the stock-reversal updates)

- [ ] **Step 1: Remove the apply call**

In `prep/logs/[id]/route.ts`, delete the `applyInventoryTransaction` function and the block at lines ~142-145 that calls it. Stop returning `inventoryResult`; return `NextResponse.json(log)`. Remove now-unused imports (`computeScale`, `convertQty`) **only if** nothing else in the file uses them (grep first).

- [ ] **Step 2: Remove the revert stock-reversal**

In `prep/logs/[id]/revert/route.ts`, delete the two `prisma.inventoryItem.update({ data: { stockOnHand: { increment: ... } } })` operations (the raw-restore and prep-debit). Keep whatever marks the log reverted / resets status. The `inventoryAdjusted` flag is no longer meaningful for stock; leave the column in place (harmless) but stop branching on it for stock.

- [ ] **Step 3: Verify prep completion no longer writes stock (probe)**

`probe.mjs` — record a raw item's `stockOnHand`, create+complete a prep log via the API (or directly flip status through the same code path), assert `stockOnHand` unchanged; clean up:
```js
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const item = await p.prepItem.findFirst({ where: { linkedRecipe: { is: { ingredients: { some: { inventoryItemId: { not: null } } } } } },
  include: { linkedRecipe: { include: { ingredients: { where: { inventoryItemId: { not: null } }, include: { inventoryItem: true }, take: 1 } } } } })
if (!item) { console.log('skip'); await p.$disconnect(); process.exit(0) }
const raw = item.linkedRecipe.ingredients[0].inventoryItem
const before = Number((await p.inventoryItem.findUnique({ where: { id: raw.id }, select: { stockOnHand: true } })).stockOnHand)
let logId
try {
  const log = await p.prepLog.create({ data: { prepItemId: item.id, logDate: new Date('2099-01-03'), status: 'NOT_STARTED' } })
  logId = log.id
  // hit the live route to mark DONE (preview running) — or replicate the PUT handler's writes
  const res = await fetch(`http://localhost:3000/api/prep/logs/${logId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'DONE', actualPrepQty: Number(item.linkedRecipe.baseYieldQty) }) })
  console.log('PUT', res.status)
  const after = Number((await p.inventoryItem.findUnique({ where: { id: raw.id }, select: { stockOnHand: true } })).stockOnHand)
  console.log('stockOnHand before:', before, 'after:', after, '| unchanged:', before === after)
} finally {
  if (logId) await p.prepLog.delete({ where: { id: logId } })
  await p.$disconnect()
}
```
Run with preview started. Expected: `unchanged: true`.

- [ ] **Step 4: Build.** `npm run build`. Expected: `✓ Compiled successfully`.

- [ ] **Step 5: Commit**
```bash
git add src/app/api/prep/logs/[id]/route.ts src/app/api/prep/logs/[id]/revert/route.ts
git commit -m "refactor(prep): stop writing real stock on prep apply/revert (now theoretical)"
```

---

### Task 6: Remove the invoice receiving real write

**Files:**
- Modify: `src/app/api/invoices/[id]/process/route.ts` (line ~35 `stockOnHand: newStock`)

- [ ] **Step 1: Remove the write**

Delete the `stockOnHand: newStock` assignment (and the `newStock` computation feeding only it) from the inventory update in the process route. Leave price-related writes (`pricePerBaseUnit`, etc.) untouched — those belong to the cost spine, not stock. Confirm `buildPurchaseMap` already sources receipts from `InvoiceScanItem` so theoretical still reflects the delivery.

- [ ] **Step 2: Verify receiving no longer writes stock (probe)**

`probe.mjs` — find an inventory item, snapshot `stockOnHand`; this is a read-only assertion that the process route no longer contains a stockOnHand write. Simplest deterministic check: grep the file.
```bash
grep -n "stockOnHand" src/app/api/invoices/[id]/process/route.ts || echo "NO stockOnHand write — good"
```
Expected: only `select`/read references remain, no `data: { ... stockOnHand ... }` write (verify by eye).

- [ ] **Step 3: Build.** `npm run build`. Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Commit**
```bash
git add src/app/api/invoices/[id]/process/route.ts
git commit -m "refactor(invoices): receiving feeds theoretical, no longer writes real stock"
```

---

## Phase 4 — Alerts + display

### Task 7: Prep alerts read theoretical on-hand

**Files:**
- Modify: `src/app/api/prep/generate/route.ts` (currently reads `stockOnHand` for on-hand at lines ~16-37)

- [ ] **Step 1: Swap on-hand source to theoretical**

Import `getTheoreticalStockMap` from `@/lib/count-expected`. Resolve the relevant inventory item ids (the prep items' `linkedInventoryItemId` / linked recipe inventory item) and build a theoretical map for the route's RC (use the request's `rcId` if present, else null). Replace each `onHand = Number(item.linkedInventoryItem.stockOnHand)` (and the `linkedRecipe.inventoryItem.stockOnHand` branch) with `onHand = theoreticalMap.get(<that inventory item id>) ?? 0`.

- [ ] **Step 2: Verify alert uses theoretical (probe)**

`probe.mjs` — call the live `/api/prep/generate` (preview running) before and after inserting a temp consuming prep log, assert a prep item's reported on-hand changes without any count. Clean up the temp log in `finally`. Expected: on-hand reflects the theoretical drop.

- [ ] **Step 3: Build.** `npm run build`. Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Commit**
```bash
git add src/app/api/prep/generate/route.ts
git commit -m "feat(prep): stock alerts read theoretical on-hand"
```

---

### Task 8: Shared display helper + theoretical headline with counted anchor

**Files:**
- Create: `src/lib/stock-display.ts`
- Modify: inventory list/detail API + UI, prep KPI strip, cost-chrome on-hand. Wire theoretical as headline, counted+`lastCountDate` alongside.

- [ ] **Step 1: Create the formatter**

`src/lib/stock-display.ts`:
```ts
/** Display model for stock: theoretical headline + the real counted anchor. */
export interface StockDisplay {
  theoretical: number
  counted: number | null
  lastCountDate: string | null
}

/** Short label e.g. "1.4 L · counted 2.0 on Jun 8". countedNull → theoretical only. */
export function formatStockOnHand(d: StockDisplay, unit: string): string {
  const head = `${Number(d.theoretical).toFixed(2)} ${unit}`
  if (d.counted == null || d.lastCountDate == null) return head
  const date = new Date(d.lastCountDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
  return `${head} · counted ${Number(d.counted).toFixed(2)} on ${date}`
}
```

- [ ] **Step 2: Surface theoretical in the inventory list API**

In the inventory list route (`src/app/api/inventory/route.ts`), after fetching items, call `getTheoreticalStockMap(rcId, itemIds)` once and attach `theoreticalStock`, `countedStock: Number(item.stockOnHand)`, and `lastCountDate` to each returned row. Keep `stockOnHand` in the payload for backward compat during the transition.

- [ ] **Step 3: Render headline + anchor in the inventory UI**

In the inventory list/detail components, replace the raw on-hand render with `formatStockOnHand({ theoretical, counted, lastCountDate }, unit)`. Theoretical is the bold headline; the "counted … on …" is muted secondary text.

- [ ] **Step 4: Repeat for prep KPI strip and cost-chrome on-hand**

Prep KPI (`src/components/prep/PrepKpiStrip.tsx`) and the cost-chrome on-hand value (`src/app/api/insights/cost-chrome/route.ts` + shell strip) read theoretical via the same map/helper.

- [ ] **Step 5: Verify in the browser (preview)**

Start the preview, open `/inventory`. Confirm the headline shows the theoretical number with "counted X on <date>" beside it. Take a `preview_screenshot` as proof. Confirm no console errors (`preview_console_logs level=error`).

- [ ] **Step 6: Build.** `npm run build`. Expected: `✓ Compiled successfully`.

- [ ] **Step 7: Commit**
```bash
git add src/lib/stock-display.ts src/app/api/inventory/route.ts src/components/... src/app/api/insights/cost-chrome/route.ts
git commit -m "feat(inventory): theoretical on-hand headline with counted anchor"
```

---

### Task 9: Prep logging UI — RC selection

**Files:**
- Modify: prep item form (`src/components/prep/PrepItemForm.tsx`) — add an RC selector bound to `revenueCenterId`.

- [ ] **Step 1: Add the RC field**

Add a revenue-center `<select>` to the prep item form (options from `/api/revenue-centers`), default "Shared / default". Persist via the existing create/update calls (Task 2 already accepts `revenueCenterId`).

- [ ] **Step 2: Verify in the browser (preview)**

Open the prep item form, set an RC, save, reopen — confirm it persists. `preview_screenshot` as proof.

- [ ] **Step 3: Build.** `npm run build`. Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Commit**
```bash
git add src/components/prep/PrepItemForm.tsx
git commit -m "feat(prep): assign a revenue center to prep items"
```

---

## Self-review notes

- **Spec coverage:** anchors/real-writers (Tasks 5,6 remove the non-anchor writes; counts/manual/pulls untouched), theoretical formula incl. prep (Tasks 3,4), prep RC-tagging (Tasks 1,2,9), compute-on-read engine + batch (Task 4), display headline+anchor (Task 8), alerts (Task 7), edge cases (never-counted → empty maps handled in Task 4; prep-in-prep stop in Task 3; pulls remain real — untouched), migration (Task 1 additive). All spec sections map to a task.
- **Type consistency:** `getTheoreticalStock` = alias of `computeExpectedForItem` returning `{ expectedBase, baseStock }`; `getTheoreticalStockMap` returns `Map<string,number>`; `buildPrepMap` returns `{ consumption, output }`; `computeExpected` extended with two optional trailing map args used identically by the count route and both accessors.
- **Known imprecision (documented, accepted):** batch maps use a single earliest-lastCount window — same simplification the count-session route already makes.
- **Out of scope confirmed:** no cost-path changes; no count-finalize/allocation rework beyond keeping anchors correct.
