# RC-Partitioned Theoretical Stock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every variable in the theoretical-stock calculation RC-attributed so each revenue center computes its own value, and the "All RCs" view is the exact sum of the per-RC values.

**Architecture:** Compute-on-read (no new ledger). Fix `buildPurchaseMap` to (a) count each purchase line in exactly one RC (`splitToSessionId: null`) and (b) derive purchased quantity from the *billed* quantity for per-weight items instead of `rawQty × case-size`. Redefine `getTheoreticalStockMap(null)` to sum every RC. Require `revenueCenterId` on the movement tables (backfill null → default RC, then `NOT NULL`), and block movement entry from the read-only "All" view.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma + PostgreSQL (Supabase), ts-node for verification scripts. No unit-test framework — correctness gates are `npm run build` and committed `scripts/verify-rc-theoretical.ts`.

**Spec:** `docs/superpowers/specs/2026-06-15-rc-partitioned-theoretical-stock-design.md`

---

## Conventions (used by every task)

`node`/`npm` are not on PATH. Prefix every Node command with:

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
```

**Build (committed correctness gate):**
```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build
```
Expected: ends with `✓ Compiled successfully` and no `Type error`.

**Run a verification script that imports `@/` aliases:**
```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && \
TS_NODE_BASEURL=./ TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS","baseUrl":"./","paths":{"@/*":["./src/*"]}}' \
node --env-file=.env -r ts-node/register -r tsconfig-paths/register scripts/verify-rc-theoretical.ts
```

**Stop the preview server before any build** (a dev server corrupts `.next/` mid-build): use `preview_stop` first, `preview_start` after if needed.

---

## File Structure

- `src/lib/count-expected.ts` — the engine. Modified in Tasks 1 & 3 (`buildPurchaseMap`, `getTheoreticalStockMap`, `computeExpectedForItem`).
- `scripts/verify-rc-theoretical.ts` — **created** Task 1, extended Task 3. Committed regression check asserting per-line correctness and `ALL = ΣRC`.
- `scripts/backfill-movement-rc.ts` — **created** Task 2. One-time backfill of null `revenueCenterId`.
- `src/app/api/insights/cost-chrome/route.ts` — Task 4 (drop bespoke all-handling).
- `prisma/schema.prisma` + `prisma/migrations/<ts>_movement_rc_not_null/migration.sql` — Task 5 (`NOT NULL`).
- `src/app/api/prep/logs/route.ts`, `src/app/api/prep/generate/route.ts`, `src/app/api/wastage/route.ts`, `src/app/api/sales/route.ts` — Task 6 (API: require concrete RC).
- Prep/wastage/sales client pages — Task 7 (UI: block from "All").

---

## Phase 1 — Engine + data accuracy (the correctness win)

### Task 1: Fix `buildPurchaseMap` — bill-quantity + single-RC counting

Fixes spec bugs #1 (cross-RC double-count) and #4 (catch-weight 10× inflation), and removes the dead legacy null branch (#2 groundwork).

**Files:**
- Modify: `src/lib/count-expected.ts` (`buildPurchaseMap`, ~lines 122-216)
- Create: `scripts/verify-rc-theoretical.ts`

- [ ] **Step 1: Write the verification script (the test)**

Create `scripts/verify-rc-theoretical.ts`:

```ts
/**
 * Regression checks for RC-partitioned theoretical stock.
 * Run via the tsconfig-paths command in the plan Conventions section.
 */
import { prisma } from '../src/lib/prisma'
import { buildPurchaseMap } from '../src/lib/count-expected'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!cond) failures++
}

async function main() {
  // ── Albacore catch-weight: 20 lb billed $370, NOT 200 lb / $3,700 ──
  const alb = await prisma.inventoryItem.findFirst({ where: { itemName: 'Albacore tuna' }, select: { id: true, pricePerBaseUnit: true } })
  if (!alb) { console.log('Albacore not found — skipping line check'); }
  else {
    const rcs = await prisma.revenueCenter.findMany({ select: { id: true, name: true } })
    let total = 0
    const since = new Date('2000-01-01')
    for (const rc of rcs) {
      const m = await buildPurchaseMap(since, rc.id)
      total += (m.get(alb.id) ?? 0)
    }
    const value = total * Number(alb.pricePerBaseUnit)
    check('Albacore purchase value ≈ $370 (was $3,700)', Math.abs(value - 370) < 5, `got $${value.toFixed(2)}, ${total.toFixed(0)} g across all RCs`)
    check('Albacore counted once (≈9,072 g, not 90,718)', total > 8000 && total < 10000, `${total.toFixed(0)} g`)
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  await prisma.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
```

- [ ] **Step 2: Run it to confirm it FAILS against current code**

Run the verification command (Conventions). Expected: `✗ FAIL  Albacore purchase value ≈ $370` (currently ~$3,700, double-counted across both RCs ≈ $7,400).

- [ ] **Step 3: Replace the `buildPurchaseMap` per-RC branch**

In `src/lib/count-expected.ts`, in `buildPurchaseMap`, the `if (rcId) { ... }` block: add `splitToSessionId: null` to the `where`, select `rawUnit`, `totalQty`, `totalQtyUOM`, and `matchedItem.priceType`, and replace the quantity math. New block:

```ts
  if (rcId) {
    const scanItems = await prisma.invoiceScanItem.findMany({
      where: {
        session: { revenueCenterId: rcId, status: 'APPROVED', createdAt: { gte: since } },
        approved: true,
        splitToSessionId: null,                      // count each line in exactly ONE RC (bug #1)
        action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] },
        matchedItemId: { not: null },
        rawQty: { not: null },
      },
      select: {
        matchedItemId: true, rawQty: true, rawUnit: true,
        totalQty: true, totalQtyUOM: true,
        invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
        session: { select: { createdAt: true } },
        matchedItem: {
          select: { id: true, baseUnit: true, priceType: true,
                    qtyPerPurchaseUnit: true, packSize: true, packUOM: true },
        },
      },
    })

    for (const si of scanItems) {
      if (!si.matchedItemId || !si.matchedItem) continue
      if (!inWindow(cutoff, si.matchedItemId, si.session.createdAt)) continue
      const qty = Number(si.rawQty ?? 0)
      if (qty <= 0) continue

      const baseUnit = si.matchedItem.baseUnit
      let baseUnits: number

      if (si.matchedItem.priceType === 'UOM') {
        // Per-weight / catch-weight: the invoice bills a weight/volume directly,
        // so rawQty (in rawUnit) is the quantity — NOT a count of cases. Prefer the
        // invoice's stated total (totalQty/totalQtyUOM); fall back to rawQty/rawUnit.
        // Multiplying by case size here was a 10× inflation (bug #4).
        const billedQty = si.totalQty != null && Number(si.totalQty) > 0 ? Number(si.totalQty) : qty
        const billedUOM = si.totalQtyUOM ?? si.rawUnit ?? baseUnit
        baseUnits = convertQty(billedQty, billedUOM, baseUnit)
      } else {
        const packQty  = si.invoicePackQty  ? Number(si.invoicePackQty)  : 0
        const packSize = si.invoicePackSize ? Number(si.invoicePackSize) : 0
        const packUOM  = si.invoicePackUOM ?? null
        if (packQty > 0 && packSize > 0 && packUOM) {
          baseUnits = convertQty(qty * packQty * packSize, packUOM, baseUnit)
        } else {
          const unitsPerCase =
            Number(si.matchedItem.qtyPerPurchaseUnit) *
            Number(si.matchedItem.packSize) *
            getUnitConv(si.matchedItem.packUOM)
          baseUnits = qty * unitsPerCase
        }
      }

      map.set(si.matchedItemId, (map.get(si.matchedItemId) ?? 0) + baseUnits)
    }
  }
```

- [ ] **Step 4: Remove the legacy null branch (bug #2)**

In the same function, delete the entire `else { ... }` block that queries `prisma.invoiceLineItem.findMany(...)`. Replace with:

```ts
  // No `else`: build maps are only ever called with a concrete rcId. The "all
  // RCs" total is the SUM of per-RC maps — see getTheoreticalStockMap(null).
```

(The function keeps `const map = new Map<string, number>()` at the top and `return map` at the bottom; with no `rcId` it now returns an empty map, which the null-summing caller never hits.)

- [ ] **Step 5: Build**

Run the build command (Conventions). Expected: `✓ Compiled successfully`.

- [ ] **Step 6: Run the verification script — expect PASS**

Run the verification command. Expected: `✓ PASS  Albacore purchase value ≈ $370` and `✓ PASS  Albacore counted once`. (Cafe's parent line is now excluded by `splitToSessionId: null`; the Catering line converts 20 lb → 9,072 g.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/count-expected.ts scripts/verify-rc-theoretical.ts
git commit -m "fix(theoretical-stock): RC-scope purchases by billed qty, count each line once

buildPurchaseMap inflated per-weight purchases by case size (Albacore 20 lb \$370
-> 90,718 g \$3,700) and double-counted lines reassigned across RCs (no
splitToSessionId filter). Derive base units from the billed quantity for UOM-priced
items; add splitToSessionId: null; drop the dead legacy InvoiceLineItem null branch.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Backfill null `revenueCenterId` → default RC

Must land before Task 3, so null-RC prep isn't dropped when "All" becomes Σ-RC.

**Files:**
- Create: `scripts/backfill-movement-rc.ts`

- [ ] **Step 1: Write the backfill script**

Create `scripts/backfill-movement-rc.ts`:

```ts
/** One-time: assign existing null-RC movements to the default revenue center. Idempotent. */
import { prisma } from '../src/lib/prisma'

async function main() {
  const def = await prisma.revenueCenter.findFirst({ where: { isDefault: true }, select: { id: true, name: true } })
  if (!def) throw new Error('No default revenue center found')
  console.log(`Default RC: ${def.name} (${def.id})`)

  const prep  = await prisma.prepLog.updateMany({   where: { revenueCenterId: null }, data: { revenueCenterId: def.id } })
  const sales = await prisma.salesEntry.updateMany({ where: { revenueCenterId: null }, data: { revenueCenterId: def.id } })
  const waste = await prisma.wastageLog.updateMany({ where: { revenueCenterId: null }, data: { revenueCenterId: def.id } })

  console.log(`Backfilled → PrepLog ${prep.count}, SalesEntry ${sales.count}, WastageLog ${waste.count}`)
  const remaining =
    (await prisma.prepLog.count({   where: { revenueCenterId: null } })) +
    (await prisma.salesEntry.count({ where: { revenueCenterId: null } })) +
    (await prisma.wastageLog.count({ where: { revenueCenterId: null } }))
  console.log(remaining === 0 ? '✓ no null-RC movements remain' : `✗ ${remaining} null-RC rows remain`)
  await prisma.$disconnect()
  process.exit(remaining === 0 ? 0 : 1)
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
```

- [ ] **Step 2: Run the backfill**

Run via the tsconfig-paths command but pointed at this file (it only imports `prisma`, so the simpler form also works):
```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && \
node --env-file=.env ./node_modules/.bin/ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-movement-rc.ts
```
Expected: `✓ no null-RC movements remain`.

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-movement-rc.ts
git commit -m "chore(theoretical-stock): backfill null-RC movements to default RC

Assigns existing null revenueCenterId on PrepLog/SalesEntry/WastageLog to the
default RC so every movement belongs to exactly one RC (prereq for ALL = sum-of-RCs
and the NOT NULL constraint).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `getTheoreticalStockMap(null)` = sum of all RCs

Fixes spec bug #2 (All omits purchases) structurally and guarantees `ALL = ΣRC`.

**Files:**
- Modify: `src/lib/count-expected.ts` (`getTheoreticalStockMap`, `computeExpectedForItem`)
- Modify: `scripts/verify-rc-theoretical.ts` (add the ΣRC assertion)

- [ ] **Step 1: Add the `ALL = ΣRC` assertion to the verification script**

Append inside `main()` in `scripts/verify-rc-theoretical.ts`, before the summary line:

```ts
  // ── ALL = sum of every RC, per item and in total ──
  {
    const { getTheoreticalStockMap } = await import('../src/lib/count-expected')
    const items = await prisma.inventoryItem.findMany({ where: { isActive: true }, select: { id: true, pricePerBaseUnit: true } })
    const ids = items.map(i => i.id)
    const price = new Map(items.map(i => [i.id, Number(i.pricePerBaseUnit)]))
    const rcs = await prisma.revenueCenter.findMany({ select: { id: true } })

    const all = await getTheoreticalStockMap(null, ids)
    const perRc = await Promise.all(rcs.map(rc => getTheoreticalStockMap(rc.id, ids)))
    const sumRc = new Map<string, number>()
    for (const m of perRc) for (const [id, q] of m) sumRc.set(id, (sumRc.get(id) ?? 0) + q)

    let maxItemDiff = 0
    for (const id of ids) maxItemDiff = Math.max(maxItemDiff, Math.abs((all.get(id) ?? 0) - (sumRc.get(id) ?? 0)))
    const valAll = ids.reduce((s, id) => s + (all.get(id) ?? 0) * price.get(id)!, 0)
    const valSum = ids.reduce((s, id) => s + (sumRc.get(id) ?? 0) * price.get(id)!, 0)
    check('ALL == ΣRC per item', maxItemDiff < 1e-6, `max item qty diff ${maxItemDiff}`)
    check('ALL value == ΣRC value', Math.abs(valAll - valSum) < 0.01, `ALL $${valAll.toFixed(2)} vs ΣRC $${valSum.toFixed(2)}`)
    console.log(`   ALL theoretical stock value = $${valAll.toFixed(2)}`)
  }
```

- [ ] **Step 2: Run it to confirm it FAILS**

Run the verification command. Expected: `✗ FAIL  ALL value == ΣRC value` (today ALL reads the empty legacy table; ALL ≠ ΣRC).

- [ ] **Step 3: Redefine `getTheoreticalStockMap` null case**

At the very top of `getTheoreticalStockMap(rcId, itemIds?)`, before the existing body, insert:

```ts
  // "All RCs" = the SUM of every revenue center's theoretical map. This makes
  // ALL = ΣRC true by construction (each RC floored at 0 independently).
  if (!rcId) {
    const rcs = await prisma.revenueCenter.findMany({ select: { id: true } })
    const perRc = await Promise.all(rcs.map(rc => getTheoreticalStockMap(rc.id, itemIds)))
    const sum = new Map<string, number>()
    for (const m of perRc) for (const [id, q] of m) sum.set(id, (sum.get(id) ?? 0) + q)
    return sum
  }
```

The existing body below now always runs with a concrete `rcId` (its `rcId ? … : stockOnHand` fallbacks become dead but harmless).

- [ ] **Step 4: Make the single-item null path consistent**

In `computeExpectedForItem(itemId, rcId)`, immediately after the `if (!item) return null` guard, add:

```ts
  // No RC selected → mirror getTheoreticalStockMap(null): sum across RCs.
  if (!rcId) {
    const m = await getTheoreticalStockMap(null, [itemId])
    const q = m.get(itemId) ?? 0
    return { expectedBase: q, baseStock: q }
  }
```

- [ ] **Step 5: Build**

Run the build command. Expected: `✓ Compiled successfully`.

- [ ] **Step 6: Run the verification script — expect PASS**

Run the verification command. Expected: all checks PASS, including `✓ PASS  ALL value == ΣRC value`. Note the printed `ALL theoretical stock value` — record it for Task 4 cross-checks.

- [ ] **Step 7: Commit**

```bash
git add src/lib/count-expected.ts scripts/verify-rc-theoretical.ts
git commit -m "feat(theoretical-stock): ALL view = sum of per-RC theoretical maps

getTheoreticalStockMap(null) now sums every RC instead of reading the dead legacy
global path, so ALL = ΣRC by construction and includes all RC-tagged purchases.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Align "All" call sites

`getTheoreticalStockMap(null)` now returns ΣRC, so null-callers inherit the fix. Only cost-chrome composes "all" by hand and must be simplified so the banner == inventory KPI == ΣRC.

**Files:**
- Modify: `src/app/api/insights/cost-chrome/route.ts`

- [ ] **Step 1: Replace cost-chrome's bespoke "all" composition**

In `src/app/api/insights/cost-chrome/route.ts`, the on-hand block computes `globalValue` and, for the no-RC case, adds non-default allocations. Replace the whole on-hand computation so that:
- when `rcId` is set → `Σ theoreticalMap(rcId)[item] × price` (the existing per-RC value),
- when no `rcId` → `Σ getTheoreticalStockMap(null)[item] × price` (which is now ΣRC).

Concretely, set `const theoreticalRcId = rcId || null` (already done in a prior fix), then compute `onHand` for the no-RC branch as the summed map value and DELETE the `sumAllocValue({ revenueCenter: { isDefault: false } })` addition (the per-RC sum already includes every RC's allocation-based stock):

```ts
  // onHand:
  //   concrete RC  → Σ theoreticalMap[item] × price   (theoreticalMap already scoped to rcId)
  //   no RC (all)  → Σ theoreticalMap[item] × price   (theoreticalMap is the ΣRC map)
  // No separate allocation add-back: ΣRC already contains each RC's allocation stock.
  const onHand = inventory.reduce(
    (sum, it) => sum + (theoreticalMap.get(it.id) ?? Number(it.stockOnHand)) * Number(it.pricePerBaseUnit),
    0,
  )
  const sourceItemCount = inventory.length
```

Remove the now-unused `sumAllocValue` helper and the `if (rcId && !rcIsDefault) … else if … else …` branch that referenced it. Keep `theoreticalMap = await getTheoreticalStockMap(theoreticalRcId, itemIds)`.

> NOTE for the non-default RC case: previously cost-chrome summed only that RC's *allocated* items via `sumAllocValue`. `getTheoreticalStockMap(rcId)` already returns 0 for items not allocated to a non-default RC (baseStock falls back to 0), so summing over all `inventory` items yields the same total. Confirm in Step 3.

- [ ] **Step 2: Build**

Run the build command. Expected: `✓ Compiled successfully`.

- [ ] **Step 3: Cross-surface check in the live app**

Start the preview (`preview_start` → "RestaurantOS (Next.js)"). In the preview page console (`preview_eval`), fetch and compare:

```js
(async () => {
  const rcs = await fetch('/api/revenue-centers').then(r => r.json());
  const out = {};
  for (const rc of rcs) out[rc.name] = (await fetch('/api/insights/cost-chrome?rcId=' + rc.id).then(r => r.json())).onHand;
  out.ALL = (await fetch('/api/insights/cost-chrome').then(r => r.json())).onHand;
  out.sumOfRCs = rcs.reduce((s, rc) => s + out[rc.name], 0);
  return out;
})()
```
Expected: `ALL ≈ sumOfRCs` (within rounding), and the printed `ALL theoretical stock value` from Task 3 Step 6 matches `out.ALL`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/insights/cost-chrome/route.ts
git commit -m "fix(cost-chrome): on-hand reads the unified ΣRC theoretical map

Drop the bespoke globalValue + non-default-allocation composition. With
getTheoreticalStockMap(null) now returning ΣRC (which already includes each RC's
allocation stock), banner ALL == inventory KPI == sum of per-RC values.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 2 — Lock in RC attribution (prevent regression)

### Task 5: Make `revenueCenterId` NOT NULL on movement tables

Runs after the Task 2 backfill (no null rows remain). Uses the documented no-shadow-DB migration workaround.

**Files:**
- Modify: `prisma/schema.prisma` (`PrepLog`, `SalesEntry`, `WastageLog`)
- Create: `prisma/migrations/<ts>_movement_rc_not_null/migration.sql`

- [ ] **Step 1: Confirm no null rows remain**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && \
node --env-file=.env ./node_modules/.bin/ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-movement-rc.ts
```
Expected: `✓ no null-RC movements remain` (idempotent; safe to re-run).

- [ ] **Step 2: Edit the schema**

In `prisma/schema.prisma`, change three fields from `String?` to `String` (drop the `?`) and their relations from optional to required:
- `model PrepLog`: `revenueCenterId String` and `revenueCenter RevenueCenter @relation("PrepLogRC", fields: [revenueCenterId], references: [id])`
- `model SalesEntry`: `revenueCenterId String` and `revenueCenter RevenueCenter @relation("SalesRC", …)`
- `model WastageLog`: `revenueCenterId String` and `revenueCenter RevenueCenter @relation("WastageRC", …)`

(Leave `PrepItem.revenueCenterId`, `InvoiceSession`, `InvoiceScanItem`, menu models nullable — definitions stay shareable.)

- [ ] **Step 3: Generate the migration SQL by diffing (no shadow DB)**

```bash
set -a && . ./.env; set +a
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
TS=$(date +%Y%m%d%H%M%S)
mkdir -p prisma/migrations/${TS}_movement_rc_not_null
npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script \
  > prisma/migrations/${TS}_movement_rc_not_null/migration.sql
cat prisma/migrations/${TS}_movement_rc_not_null/migration.sql
```
Expected: SQL with three `ALTER TABLE … ALTER COLUMN "revenueCenterId" SET NOT NULL` statements (and matching FK adjustments). If it contains anything destructive (DROP), STOP and review.

- [ ] **Step 4: Apply the migration**

```bash
npx prisma db execute --url "$DIRECT_URL" --file prisma/migrations/${TS}_movement_rc_not_null/migration.sql
npx prisma migrate resolve --applied ${TS}_movement_rc_not_null
npx prisma generate
```
Expected: db execute succeeds; resolve records it; generate rewrites the client.

- [ ] **Step 5: Build**

Restart the preview if running (`preview_stop`), then run the build command. Expected: `✓ Compiled successfully` (the regenerated client now types these fields as non-null).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(schema): require revenueCenterId on PrepLog/SalesEntry/WastageLog

Every movement now belongs to exactly one RC (backfilled first). Applied via the
diff/db-execute/resolve workaround (shadow DB is broken on this project).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: API — reject movements without a concrete RC

**Files:**
- Modify: `src/app/api/prep/logs/route.ts`, `src/app/api/prep/generate/route.ts`, `src/app/api/wastage/route.ts`, `src/app/api/sales/route.ts`

- [ ] **Step 1: Add a shared resolver**

In each POST handler that creates a movement, resolve the effective RC and reject if absent. Add this helper near the top of each route file (or import from a shared util if one already exists — check `src/lib/auth.ts` patterns first; otherwise inline):

```ts
function requireRc(rcId: string | null | undefined): string {
  if (!rcId) throw new Error('A revenue center must be selected to record this movement.')
  return rcId
}
```

- [ ] **Step 2: Apply in each route**

For each route, derive the RC from the request body (the client sends the active RC) — for prep, prefer the prep item's `revenueCenterId`, else the request's `revenueCenterId`:

```ts
// prep/logs and prep/generate:
const rcId = prepItem.revenueCenterId ?? body.revenueCenterId ?? null
const effectiveRc = requireRc(rcId)
// ...then write revenueCenterId: effectiveRc on the PrepLog

// wastage and sales:
const effectiveRc = requireRc(body.revenueCenterId ?? null)
// ...write revenueCenterId: effectiveRc
```

Wrap the `requireRc` throw so it returns a 400:

```ts
try { /* … create movement … */ }
catch (e) {
  if (e instanceof Error && e.message.includes('revenue center'))
    return NextResponse.json({ error: e.message }, { status: 400 })
  throw e
}
```

- [ ] **Step 3: Build**

Run the build command. Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Verify a null-RC POST is rejected**

With the preview running, in `preview_eval`:
```js
fetch('/api/wastage', { method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ inventoryItemId: 'x', qtyWasted: 1, unit: 'g', reason: 'SPOILAGE' }) })
  .then(r => r.status)
```
Expected: `400` (no `revenueCenterId` supplied).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/prep/logs/route.ts src/app/api/prep/generate/route.ts src/app/api/wastage/route.ts src/app/api/sales/route.ts
git commit -m "feat(rc): require a concrete revenue center to record any movement

Prep logs, prep generation, wastage, and sales POSTs reject requests without a
revenueCenterId (movements can only be recorded against one RC, never 'All').

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: UI — block movement entry from the "All" view

**Files:**
- Modify: prep page/form, `src/app/wastage/page.tsx`, `src/app/sales/page.tsx` (and any prep "Plan Prep" trigger). Confirm exact files with `grep -rl "useRc(" src/app/prep src/app/wastage src/app/sales`.

- [ ] **Step 1: Find the active-RC context shape**

Run:
```bash
grep -n "useRc\|activeRcId\|activeRc\b" src/contexts/RevenueCenterContext.tsx | head
```
Expected: a context exposing the active RC id and whether "All" is selected (e.g. `activeRcId: string | null`, null = All).

- [ ] **Step 2: Gate each movement entry point**

In the prep-log, wastage, and sales entry handlers, before submitting, block when no concrete RC is active and surface a message:

```tsx
const { activeRcId } = useRc()
// inside the submit handler:
if (!activeRcId) {
  setError('Select a revenue center (not "All") before recording this.')
  return
}
// include revenueCenterId: activeRcId in the POST body
```

Also disable the relevant submit button while `!activeRcId` and show the hint inline.

- [ ] **Step 3: Build**

Run the build command. Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Manual verification in preview**

With the preview at "All RCs" selected, confirm the prep/wastage/sales submit is blocked with the hint; switch to a concrete RC and confirm it posts and writes the RC. Use `preview_screenshot` to capture the blocked state.

- [ ] **Step 5: Commit**

```bash
git add src/app/wastage/page.tsx src/app/sales/page.tsx src/app/prep
git commit -m "feat(rc): block recording movements from the 'All' view

Prep/wastage/sales entry require a concrete revenue center; the 'All' view is
read-only aggregation. Submits are disabled with an inline hint until an RC is picked.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] Run `scripts/verify-rc-theoretical.ts` → `ALL CHECKS PASSED`.
- [ ] Build clean.
- [ ] In preview: cost-chrome banner ALL == inventory "All RCs" KPI == Cafe + Catering; Albacore contributes ~$370; Cafe/Catering totals dropped from their pre-fix values; ALL rose to include purchases.
- [ ] Push `main` (or open a PR) once the user approves the verified numbers.
