# Item backbone — Stage 2c: "Change how it's measured" (guided remeasure) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manager can change an item's measure (weight / volume / pieces) even after it has counts, deliveries, boxes and recipes — through one guided flow that shows what will be restated, restates it in one transaction, and can be undone. This closes R3's "guided fix" and restores the cross-measure "use the invoice's format" path that Stage 2b blocks.

**Architecture:** A remeasure is **one constant factor `k` = new base units per old base unit**, fixed by a bridge the manager supplies (one piece = 150 g; or 1 ml weighs 1.03 g). Chains keep their container links and collapse everything inside through `k`; prices keep the SAME $/base after conversion (`ppb_new = ppb_old / k`). Every frozen number (count lines + snapshots, receipts, stock baselines, transfers) is then re-derived against the corrected item with the EXISTING planners in `src/lib/invoice/create-new-repair.ts` (`planReceiptRefreeze`, `planCountRefreeze`, `planStockRewrite`, `planSessionTotals`), falling back to `old × k` for any row the rules cannot re-read. Boxes are rewritten by the same chain/pricing rule. A new pure module `src/lib/remeasure-plan.ts` builds the plan; `src/lib/remeasure-exec.ts` (server-only) loads, locks, applies in one transaction, records an `ItemRemeasure` manifest and undoes it. Three routes + one drawer sheet.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma (one additive migration, applied with `node scripts/apply-migration.cjs`), vitest, `npm run build`.

**Spec:** `docs/superpowers/specs/2026-10-03-item-backbone-design.md` §3 R3 (and the R3 lock already shipped in Stage 2a: `PATCH /api/inventory/[id]/pricing` → 409 `DIMENSION_LOCKED`; `src/lib/item-history.ts`).

## Global Constraints

- Branch off `origin/main` after Stage 2b (`feat/supplier-boxes`) merges. Worktree `.claude/worktrees/remeasure`, branch `worktree-remeasure`, pushed as `feat/remeasure`. One PR, squash-merged. After `EnterWorktree`: `git fetch origin && git reset --hard origin/main`; symlink `node_modules` and `.env` from the main checkout.
- `node`/`npm` are not on the sandbox PATH: prefix every command with `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" &&` (Bash `dangerouslyDisableSandbox: true`). `npm run build` may rewrite `tsconfig.json` — `git checkout tsconfig.json` afterwards. Lint baseline on `main` = 20 files with pre-existing findings; the branch must not add a file.
- **One migration, additive only** (`ItemRemeasure` table). Applied to the LIVE database with `node scripts/apply-migration.cjs prisma/migrations/20261004000000_item_remeasure` (idempotent). No data rewrite ships in this PR — the flow only runs when a manager clicks Apply.
- **The factor rule is the whole design.** `k` = new base per old base. Prices: `pricePerBaseUnit(after) × k ≈ pricePerBaseUnit(before)` (relative tolerance 1e-9) for the item AND every box. Chains: container links (units whose `unitKind` is `'container'`, plus `each`) are kept; measure links are collapsed. Exact rules in Task 1.
- **Nothing is invented.** A row the receiving/count rules can re-derive is re-derived (the numbers the app would have frozen had the item been born right); a row they cannot is scaled `old × k` and COUNTED in the summary as "scaled". Wastage rows are NOT rewritten (`WastageLog.qtyWasted` is in the chef's unit and converts at read through the bridge). `InvoiceLineItem` rows are provenance and are not rewritten. `CountLine.variancePct/varianceCost/expectedQty` are not rewritten (same reasoning as the script: `expectedQty` is itself frozen in the old base).
- **The bridge is required and stored.** COUNT ↔ weight/volume needs `eachQty + eachUnit` ("one piece = 150 g"); weight ↔ volume needs `densityGPerMl`. Apply writes the bridge onto the item (`eachMeasureQty/eachMeasureUnit` or `densityGPerMl`) so recipe lines in the OLD unit keep costing through it (`convertQtyBridged`, `movementQtyBase`), and so `planCountRefreeze`/`planReceiptRefreeze` can resolve entries in the old unit.
- Invariant from `src/lib/primary-offer.ts` still holds after apply: an item with boxes equals its primary box (the item's new chain/pricing IS the rewritten primary box's; for a box-less item the item's own chain/pricing is rewritten).
- Role gates: all routes MANAGER+. Prisma `Decimal` → `Number()`. Codes and sentences: `NOT_FOUND` 404 "That item doesn't exist."; `PREP_OWNED` 409 "A recipe-made item is measured by its recipe."; `TOMBSTONE` 409 "This item was merged into another."; `OPEN_COUNT` 409 "This item is on a count that is still open. Finalize or discard it first."; `SAME_MEASURE` 400 "It is already measured that way."; `NEEDS_BRIDGE` 400 (sentence from `remeasureFactor`); `STALE` 409 "Someone changed this item a moment ago. Reload to see their change before changing its measure."; `INVALID` 400 (joined `validateChainItem` errors); `UNDO_UNSAFE` 409 "The item has changed since — undo is no longer safe.".
- Tests: `npm test` green; `npm run build` green; routes `ƒ (Dynamic)`.
- Plain English in every UI string; no code words. Measure words: weight / volume / pieces.

---

### Task 1: The pure planner — `src/lib/remeasure-plan.ts`

**Files:**
- Create: `src/lib/remeasure-plan.ts`
- Modify: `src/lib/invoice/create-new-repair.ts` — widen `planStockRewrite`'s `rewrite` parameter type to `{ dimension: Dimension }` (the function never reads it; `grep -n "a.rewrite\|rewrite\." ` to confirm) so a COUNT target type-checks.
- Test: `src/lib/__tests__/remeasure-plan.test.ts`

**Interfaces (produces):**
```ts
import type { ChainItem, Dimension, PackLink, Pricing } from '@/lib/item-model'

export interface Measure { dimension: Dimension; unit: string }        // unit of that dimension; 'each' for COUNT
export interface Bridge { eachQty?: number | null; eachUnit?: string | null; densityGPerMl?: number | null }

/** k = new base units per 1 old base unit, or the plain sentence saying what is missing. */
export function remeasureFactor(from: ChainItem, to: Measure, bridge: Bridge): { k: number } | { error: string; code: 'SAME_MEASURE' | 'NEEDS_BRIDGE' }

/** Container links kept, measure links collapsed through k. See rules below. */
export function rewriteChain(chain: PackLink[], fromDim: Dimension, to: Measure, k: number): PackLink[]

/** Same $/base after conversion. PACK stays PACK unless the chain collapsed to a bare measure. */
export function rewritePricing(before: ChainItem, afterChain: PackLink[], to: Measure, k: number): Pricing

/** The old count unit if it still names a link of the new chain or a unit of the new dimension, else to.unit. */
export function rewriteCountUnit(countUnit: string | null | undefined, afterChain: PackLink[], to: Measure): string

export interface RemeasureBoxInput { id: string; supplierName: string | null; isPrimary: boolean; packChain: unknown; pricing: unknown; packQty?: unknown; packSize?: unknown; packUOM?: string | null }
export interface RemeasureInput {
  item: Parameters<typeof asChainItem>[0] & { id: string; itemName: string; stockOnHand?: unknown; lastCountQty?: unknown; isStocked: boolean }
  to: Measure
  bridge: Bridge
  boxes: RemeasureBoxInput[]
  receipts: ReceiptLine[]                       // from create-new-repair (approved lines, with parentLineId resolved)
  counts: CountLineRow[]                        // from create-new-repair (with snapshot attached)
  countSessions: { lineId: string; sessionDate: Date | string; revenueCenterId: string | null; rcIsDefault: boolean; skipped: boolean; countedQty: number | null }[]
  allocations: { revenueCenterId: string; quantity: unknown }[]
  sessions: { id: string; snapshots: SessionSnapshotRow[]; totalCountedValue: unknown }[]
  transfers: { id: string; quantity: unknown }[]
  recipeLines: number
  wastageRows: number
}
export interface RemeasurePlan {
  k: number
  item: { before: ChainItem; after: ChainItem & { countUnit: string }; eachMeasure?: { qty: number; unit: string } | null; densityGPerMl?: number | null }
  boxes: { id: string; supplierName: string | null; isPrimary: boolean; before: { packChain: unknown; pricing: unknown; packQty: unknown; packSize: unknown; packUOM: string | null }; packChain: PackLink[]; pricing: Pricing }[]
  receipts: (ReceiptRefreezeRow & { scaled: boolean })[]
  counts: (CountRefreezeRow & { scaled: boolean })[]
  stock: StockRewrite
  sessions: SessionTotalRow[]
  transfers: { id: string; old: number; next: number }[]
  summary: RemeasureSummary
  errors: string[]                               // validateChainItem on the corrected item + every box; non-empty ⇒ refuse (INVALID)
}
export interface RemeasureSummary {
  from: { dimension: Dimension; unit: string; packLabel: string; priceLabel: string; countUnit: string }
  to:   { dimension: Dimension; unit: string; packLabel: string; priceLabel: string; countUnit: string }
  boxes: { supplierName: string; isPrimary: boolean; before: string; after: string }[]
  counts: { n: number; scaled: number }
  receipts: { n: number; scaled: number }
  transfers: number
  recipes: number
  wastage: number
  warnings: string[]
}
export function planRemeasure(input: RemeasureInput): RemeasurePlan | { error: string; code: 'SAME_MEASURE' | 'NEEDS_BRIDGE' }
export function packLabel(ci: ChainItem): string      // "case (12 × 150 g)" — reuse formatPurchaseDisplay from '@/lib/count-uom'
export function priceLabel(ci: ChainItem): string     // "$40.00 per case" (PACK) · "$6.05 per lb" (RATE); money 2 dp
```

**Rules (exact):**

`remeasureFactor(from, to, bridge)`:
- `to.dimension === from.dimension` → `{ error: "It is already measured by <weight|volume|pieces>.", code: 'SAME_MEASURE' }` (even if the unit differs — the base is the same; a unit is a display choice).
- COUNT → MASS|VOLUME: needs `bridge.eachQty > 0` and `dimensionOf(bridge.eachUnit) === to.dimension`; `k = convertQty(eachQty, eachUnit, DIMENSION_BASE[to.dimension])`. Missing → `{ error: "Tell the app how much one piece <weighs|holds> first — for example 1 each = 150 g.", code: 'NEEDS_BRIDGE' }`.
- MASS|VOLUME → COUNT: needs `bridge.eachQty > 0` and `dimensionOf(bridge.eachUnit) === from.dimension`; `k = 1 / convertQty(eachQty, eachUnit, DIMENSION_BASE[from.dimension])`. Missing → same sentence.
- MASS → VOLUME: needs `densityGPerMl > 0`; `k = 1 / densityGPerMl` (g → ml). VOLUME → MASS: `k = densityGPerMl`. Missing → `{ error: "Tell the app the density first — how many grams 1 ml weighs.", code: 'NEEDS_BRIDGE' }`.
- The bridge in the request wins over the item's stored bridge; the stored one is the prefill (UI).

`rewriteChain(chain, fromDim, to, k)` — `isContainer(unit) = unitKind(unit) === 'container' || canonicalUom(unit) === 'each'`:
- `containers = chain.filter(l => isContainer(l.unit))` (original order). Measure links are dropped.
- `fromDim === 'COUNT'` (old base = each): keep every container link's `per` as-is, then **append** `{ unit: 'each', per: round6(k) }` — unless the innermost container IS `each`, in which case replace its `per` with `round6(innermost.per × k)` (normally `1 × k`). Examples: `[{case:12}]` → `[{case:12},{each:150}]`; `[{each:1}]` → `[{each:150}]`; `[]` → `[{each:150}]`.
- `fromDim !== 'COUNT'` and `containers.length > 0`: every container link's `per` as-is except the innermost, whose `per = round6(levelBaseUnits(chain)[innermost.unit] × k)` (the old base it contained, converted). Examples (k = 1/74): `[{case:72},{each:74}]` → `[{case:72},{each:1}]`; (k = 1/150) `[{case:4},{lb:453.6}]` → `[{case:12.096}]`; MASS→VOLUME d=1.03 (k = 1/1.03): `[{case:4},{lb:453.6}]` → `[{case:1761.553398}]`.
- `fromDim !== 'COUNT'` and no containers: `[{ unit: to.unit, per: UNIT_FACTORS[canonicalUom(to.unit)].toBase }]` — for COUNT `to.unit = 'each'`, per 1. Example `[{lb:453.6}]` MASS→VOLUME to `l` → `[{l:1000}]`.
- `round6 = (x) => Math.round(x * 1e6) / 1e6`.

`rewritePricing(before, afterChain, to, k)`:
- `ppbNew = pricePerBaseUnit(before) / k`.
- `collapsed` = the before chain had no container link and `before.dimension !== 'COUNT'` (the "no containers" branch above) — then the pack no longer exists: return `{ mode: 'RATE', rate: round4(ppbNew × toBase(to.unit)), rateUnit: to.unit }`.
- `before.pricing.mode === 'PACK'` and not collapsed → return the pricing unchanged (same object shape; `purchasePrice` untouched — the physical pack costs the same; its base changed with the chain).
- `before.pricing.mode === 'RATE'` → `{ mode: 'RATE', rate: round4(ppbNew × toBase(to.unit)), rateUnit: to.unit }` where `toBase('each') = 1`.
- `round4 = (x) => Math.round(x * 1e4) / 1e4`.

`rewriteCountUnit(countUnit, afterChain, to)`: `const u = canonicalUom(countUnit ?? '')`; keep `countUnit` when `afterChain.some(l => canonicalUom(l.unit) === u)` or `dimensionOf(u) === to.dimension`; else `to.unit`.

`planRemeasure(input)`:
1. `before = asChainItem(input.item)`; `f = remeasureFactor(before, input.to, input.bridge)`; on error return it.
2. `afterChain = rewriteChain(before.packChain, before.dimension, to, k)`; `afterPricing = rewritePricing(before, afterChain, to, k)`; `countUnit = rewriteCountUnit(input.item.countUnit, afterChain, to)`.
3. Bridges on the corrected item: COUNT↔measure → `eachMeasure = { qty: bridge.eachQty, unit: bridge.eachUnit }` and keep `densityGPerMl` as stored; MASS↔VOLUME → `densityGPerMl = bridge.densityGPerMl` and keep `eachMeasure` as stored (if its unit is in the NEW dimension it still works; if it is in the old one, leave it — `convertQtyBridged` converts through the bridge unit).
4. `after: ChainItem = { dimension: to.dimension, baseUnit: DIMENSION_BASE[to.dimension], packChain: afterChain, pricing: afterPricing, countUnit, eachMeasure, densityGPerMl }`; `errors = validateChainItem(after, { requirePositivePrice: input.item.isStocked })`.
5. Boxes: for each box, `boxCi = { ...before, packChain: box.packChain as PackLink[], pricing: box.pricing as Pricing }`; `packChain = rewriteChain(boxCi.packChain, before.dimension, to, k)`; `pricing = rewritePricing(boxCi, packChain, to, k)`; push `errors` from `validateChainItem({ ...after, packChain, pricing }, { requirePositivePrice: input.item.isStocked })` prefixed with the supplier name. If the item has boxes, the PRIMARY box's rewritten chain/pricing REPLACE `after.packChain/pricing` (the item equals its main box — identical maths anyway, this just guarantees byte-equality).
6. `ppb = pricePerBaseUnit(after)`; receipts: `planReceiptRefreeze(input.receipts, after)`; a row whose `via` is `'none'` or whose `next` is 0 while `old` is non-zero → replace `next = old × k`, `via = 'scaled'`, `scaled: true`; else `scaled: false`.
7. Counts: `planCountRefreeze(input.counts, after, ppb)`; a row with `needsDecision` → `next = (old ?? 0) × k`, `via = 'scaled'`, `needsDecision = false`, `scaled: true`; if it had a `snapshot` row planned, recompute `snapshot.qtyOnHand = next`, `totalValue = next × ppb` (unit/ppb already set). Rows with `snapshotMismatch` keep it (left alone) and are counted in warnings.
8. Stock: `planStockRewrite({ item: input.item, allocations: input.allocations, countLines: <StockCountRow built from counts × input.countSessions by lineId>, rewrite: { dimension: to.dimension } })`.
9. Sessions: `planSessionTotals(input.sessions, new Map(counts.filter(c => c.snapshot).map(c => [c.snapshot.id, c.snapshot.totalValue])))`.
10. Transfers: `{ id, old: Number(quantity), next: round6(old × k) }` for each.
11. Summary: labels via `packLabel`/`priceLabel`; `counts.n` = rows where `isMaterial(old,next) || snapshot || snapshotUnitOnly`; `receipts.n` = rows where `isMaterial`; `scaled` counts; `transfers` = rows where `isMaterial`; `recipes = input.recipeLines`; `wastage = input.wastageRows`; warnings: `"<n> counts could not be re-read from what was typed and were scaled instead."` (when scaled > 0), same for deliveries, `"<n> count snapshots were left alone (they no longer match their count line)."` (snapshotMismatch), `"Stock on hand was left alone — no finalized count sets it."` when `stock.stockOnHand.next == null && stock.stockOnHand.old !== 0`.

- [ ] **Step 1: Failing tests** `src/lib/__tests__/remeasure-plan.test.ts`:
  - `remeasureFactor`: each of the six directions (k values: COUNT→MASS 150 g → 150; COUNT→VOLUME 250 ml → 250; MASS→COUNT 150 g → 1/150; VOLUME→COUNT; MASS→VOLUME d=1.03 → 1/1.03; VOLUME→MASS → 1.03); SAME_MEASURE; NEEDS_BRIDGE when the bridge unit is in the wrong dimension (COUNT→MASS with eachUnit `ml`).
  - `rewriteChain`: the six examples listed under the rules, plus `[]` COUNT→MASS.
  - `rewritePricing` invariant: for PACK `$40/[{case:12}]` COUNT→MASS k=150: `pricePerBaseUnit(after) × 150 ≈ pricePerBaseUnit(before)`; for RATE `$2/each` → `$/lb = 2/150×453.592 = 6.0479`; collapsed `[{lb:453.6}]` RATE $3/lb MASS→VOLUME d=1.03 to `l` → RATE per l with ppb invariant.
  - `rewriteCountUnit`: `case` kept; `each` kept on a MASS chain that has an `each` link; `lb` on a COUNT target → `each`.
  - `planRemeasure` end-to-end fixture: COUNT item `[{case:12}]` PACK $40, countUnit `case`, stocked; one Sysco primary box same chain $40 and one Snow Cap box `[{case:6}]` $22; one approved per-case receipt line (`rawQty 2, rawUnit 'cs'`, `invoicePackQty 12, invoicePackUOM 'each'`) frozen at 24; one per-lb line (`rateUOM 'lb'`, `totalQty 10, totalQtyUOM 'lb'`) frozen at 10 (wrong — 10 "each"); one count line `3 case` frozen at 36 with a snapshot `qtyOnHand 36`; one count line entered `5 lb` frozen at 5 (needsDecision under COUNT, resolvable under MASS); one transfer 12; allocations []; sessions with those snapshots. Expect: k=150; after chain `[{case:12},{each:150}]`; receipts: per-case → 3600 (`via` not scaled), per-lb → 4535.92 (billed-weight, not scaled); counts: `3 case` → 5400 with snapshot 5400 and `totalValue = 5400 × ppb`; `5 lb` → 2267.96 (not scaled); transfer 12 → 1800; `stock.stockOnHand.next` = the latest observed line's next; boxes: Sysco `[{case:12},{each:150}]` PACK $40 (primary ⇒ item identical), Snow Cap `[{case:6},{each:150}]` PACK $22; `errors` empty; summary counts n=2, receipts n=2, scaled 0, transfers 1.
  - A second fixture where a count line's unit is unresolvable after conversion (`entries` with a unit of a third dimension, qty ≠ 0) → that row `scaled: true`, `next = old × k`, and the warning sentence present.
- [ ] **Step 2: Implement** `src/lib/remeasure-plan.ts` per the rules (pure: imports only `@/lib/uom`, `@/lib/item-model`, `@/lib/invoice/create-new-repair`, `@/lib/count-uom` for `formatPurchaseDisplay`). Widen `planStockRewrite`'s type.
- [ ] **Step 3:** `npm test`; commit `feat(inventory): plan a measure change as one factor — chains keep their containers, prices keep their $/base, frozen rows re-derive`.

---

### Task 2: Migration, exec module, routes

**Files:**
- Create: `prisma/migrations/20261004000000_item_remeasure/migration.sql`; modify `prisma/schema.prisma` (model `ItemRemeasure`).
- Create: `src/lib/remeasure-exec.ts` (`import 'server-only'`)
- Create: `src/app/api/inventory/[id]/remeasure/route.ts` (`GET`, `POST`), `src/app/api/inventory/remeasures/[id]/undo/route.ts` (`POST`)
- Tests: `src/app/api/inventory/__tests__/remeasure-routes.test.ts` (mock `@/lib/remeasure-exec`, `@/lib/auth`), `src/lib/__tests__/remeasure-manifest.test.ts` (pure manifest builder + undo-writes builder).

**Migration (exact):**
```sql
-- ItemRemeasure: the record of one "change how it's measured" run — the before-values
-- of every row it restated (src/lib/remeasure-exec.ts), replayed backwards by undo.
CREATE TABLE "ItemRemeasure" (
  "id"        TEXT NOT NULL,
  "itemId"    TEXT NOT NULL,
  "changedBy" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undoneAt"  TIMESTAMP(3),
  "manifest"  JSONB NOT NULL,
  CONSTRAINT "ItemRemeasure_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ItemRemeasure_itemId_idx" ON "ItemRemeasure"("itemId");
```
Schema:
```prisma
model ItemRemeasure {
  id        String    @id @default(cuid())
  itemId    String
  changedBy String
  changedAt DateTime  @default(now())
  undoneAt  DateTime?
  // RemeasureManifest (src/lib/remeasure-exec.ts): before-values of every row restated.
  manifest  Json
  @@index([itemId])
}
```
Apply: `node scripts/apply-migration.cjs prisma/migrations/20261004000000_item_remeasure` then `npx prisma generate`.

**Exec (`src/lib/remeasure-exec.ts`) — interfaces:**
```ts
export class RemeasureRefusal extends Error { constructor(public code: 'NOT_FOUND'|'PREP_OWNED'|'TOMBSTONE'|'OPEN_COUNT'|'SAME_MEASURE'|'NEEDS_BRIDGE'|'STALE'|'INVALID'|'UNDO_UNSAFE', message: string) }
export interface RemeasureManifest {
  itemId: string; k: number; to: Measure; from: Measure
  item: { before: { dimension; baseUnit; packChain; pricing; countUnit; eachMeasureQty; eachMeasureUnit; densityGPerMl; stockOnHand; lastCountQty } }
  boxes: { id: string; before: { packChain; pricing; packQty; packSize; packUOM } }[]
  receipts: { id: string; old: number | null }[]
  counts: { id: string; old: number | null; priceAtCount: number | null }[]
  snapshots: { id: string; before: { qtyOnHand: number; unit: string; pricePerBaseUnit: number; totalValue: number } }[]
  allocations: { revenueCenterId: string; old: number }[]
  sessions: { id: string; old: number }[]
  transfers: { id: string; old: number }[]
  afterLastUpdated: string   // item.lastUpdated ISO written by apply — undo refuses if it moved
}
export async function loadRemeasureInputs(db: Prisma.TransactionClient, itemId: string): Promise<RemeasureInput & { meta: { recipe: unknown; mergedIntoId: string | null; lastUpdated: Date; inOpenCount: boolean } }>
export async function previewRemeasure(itemId: string, to: Measure, bridge: Bridge): Promise<RemeasurePlan>          // throws RemeasureRefusal
export async function applyRemeasure(a: { itemId: string; to: Measure; bridge: Bridge; expectedLastUpdated: string; userId: string }): Promise<{ remeasureId: string; plan: RemeasurePlan }>
export async function listRemeasures(itemId: string): Promise<{ id: string; changedAt: Date; from: Measure; to: Measure; canUndo: boolean; reason: string | null }[]>
export async function undoRemeasure(id: string): Promise<void>                                                           // throws RemeasureRefusal
export function buildManifest(plan: RemeasurePlan, input: RemeasureInput, afterLastUpdated: Date): RemeasureManifest   // PURE — tested
export function undoBlocker(manifest: RemeasureManifest, now: { itemLastUpdated: Date; countLinesSince: number; remeasuresSince: number }): string | null  // PURE — tested
```
Loads (copy the selects from `scripts/repair-create-new-shape.ts` `fetchItems/fetchOffers/fetchLines/fetchCountLines/fetchSnapshots/fetchSessionSnapshots/fetchSessions` — same `where` clauses, including `approved: true, session.status 'APPROVED'` for receipts and the clone→parent key `${parentSessionId}|${rawDescription}|${sortOrder}` with the ambiguity rule; `receiptLineOf` too). Also: `stockAllocation.findMany({ where: { inventoryItemId } })`, `stockTransfer.findMany({ where: { inventoryItemId }, select: { id, quantity } })`, `recipeIngredient.count`, `wastageLog.count`, `countLine.count({ where: { inventoryItemId, session: { status: { not: 'FINALIZED' } } } })` → `inOpenCount`, and the item's `recipe` relation id + `mergedIntoId` + `lastUpdated` + `itemName` + `isStocked`.

`previewRemeasure`: loads with `prisma`; refusals in this order: NOT_FOUND, TOMBSTONE, PREP_OWNED, OPEN_COUNT; `planRemeasure`; `errors.length` → INVALID.

`applyRemeasure`: `prisma.$transaction(async tx => { … }, { maxWait: 10_000, timeout: 120_000 })`: lock the item row first — `await tx.$executeRawUnsafe(`SELECT "id" FROM "InventoryItem" WHERE "id" = '${itemId}' FOR UPDATE`)` after `isSafeRowId(itemId)` (from `@/lib/item-merge-rows`); load with `tx`; same refusals; `if (meta.lastUpdated.toISOString() !== expectedLastUpdated) → STALE`; plan; INVALID check; writes (all via `tx`, mirroring the script's `applyItem` writes exactly — offers `update` chain/pricing + `packQty/packSize/packUOM: null`; receipts `update receivedQtyBase` where material; count lines `countedQtyBase` where material + `priceAtCount` where set; snapshots (`snapshot` rows: qtyOnHand/unit/pricePerBaseUnit/totalValue; `snapshotUnitOnly`: unit); allocations; count sessions `totalCountedValue` where material; transfers `quantity` where material; the item: `dimension, baseUnit, packChain, pricing, countUnit, stockOnHand?, lastCountQty?, eachMeasureQty/eachMeasureUnit (when the bridge is the each-measure), densityGPerMl (when the bridge is density), lastUpdated: now`); then `tx.itemRemeasure.create({ data: { itemId, changedBy: userId, manifest: buildManifest(plan, input, now) } })`. After the transaction: `await propagatePrepCostChanges([itemId])` (from `@/lib/recipeCosts`) and `invalidateTheoreticalCache()` (from `@/lib/theoretical-cache`).

`undoBlocker(manifest, now)`: `now.itemLastUpdated.toISOString() !== manifest.afterLastUpdated` → "The item has changed since — undo is no longer safe."; `countLinesSince > 0` → "A count was recorded since — undo is no longer safe."; `remeasuresSince > 0` → "Its measure was changed again since — undo that one first."; else null. (`countLinesSince` = count lines whose session `createdAt > changedAt`; `remeasuresSince` = later `ItemRemeasure` rows for the item with `undoneAt null`.)

`undoRemeasure(id)`: load the row (404 if missing or undone); in a transaction with the item locked: re-read the three facts, `undoBlocker` → UNDO_UNSAFE; replay every `before`/`old` from the manifest (item incl. bridge fields and stock baselines, boxes incl. pack fields, receipts, counts, snapshots, allocations, sessions, transfers); bump the item's `lastUpdated`; set `undoneAt`. Then propagate + invalidate.

**Routes:**
- `GET /api/inventory/[id]/remeasure` → `{ changes: listRemeasures(id) }` (MANAGER+).
- `POST /api/inventory/[id]/remeasure` body `{ to: { dimension, unit }, bridge?: { eachQty?, eachUnit?, densityGPerMl? }, apply?: boolean, expectedLastUpdated?: string }` (MANAGER+). Validate: `to.dimension ∈ MASS|VOLUME|COUNT`, `to.unit` a known unit of that dimension (`dimensionOf(unit) === to.dimension`; for COUNT only `'each'`), bridge numbers finite; else 400 `BAD_FIELD` "Reload the item and try again.". `apply` false/missing → `{ ok: true, plan: summary + k }` (return `plan.summary` and `k` only — not the row lists). `apply: true` requires `expectedLastUpdated` (400 BAD_FIELD otherwise) → `{ ok: true, remeasureId, summary }`. Map `RemeasureRefusal` → its code/status; unknown errors → 500 "The measure change could not be completed. Nothing was changed." `export const dynamic = 'force-dynamic'; export const maxDuration = 300`.
- `POST /api/inventory/remeasures/[id]/undo` → `{ ok: true }` / refusal (MANAGER+).

- [ ] **Step 1: Failing tests** — `remeasure-manifest.test.ts`: `buildManifest` captures the before-values for a plan with one box, one receipt, one count+snapshot, one transfer; `undoBlocker` three sentences + null. `remeasure-routes.test.ts`: LEAD → 403 on all three; POST preview returns `summary` and no row lists; POST apply without `expectedLastUpdated` → 400 BAD_FIELD; bad `to.unit` (`lb` with dimension COUNT) → 400; a `RemeasureRefusal('STALE', …)` from exec → 409 with code; undo route maps `UNDO_UNSAFE` → 409.
- [ ] **Step 2:** migration + schema + `prisma generate`; implement exec + routes.
- [ ] **Step 3:** `npm test`; `npm run build` (routes `ƒ`); apply the migration to the live database with `node scripts/apply-migration.cjs …` and record the output in the report; commit `feat(inventory): change how an item is measured — one transaction, undoable`.

---

### Task 3: The drawer sheet + the two entry points

**Files:**
- Create: `src/components/inventory/RemeasureSheet.tsx` (+ `RemeasuredRow`)
- Modify: `src/components/inventory/InventoryItemDrawer.tsx` (locked-measure line gets the button; `RemeasuredRow` under `MergedItemsRow`; `refreshItem()` after apply/undo)
- Modify: `src/components/invoices/v2/AdoptFormatModal.tsx` (the cross-measure sentence ends "…Change how the item is measured from its drawer first." with a link `/inventory?item=<id>` opening in a new tab; the button stays disabled)
- Create: `src/lib/remeasure-copy.ts` (pure sentences) + test `src/lib/__tests__/remeasure-copy.test.ts`

**Copy (pure, tested):**
```ts
export function measureWord(d: Dimension): 'weight' | 'volume' | 'pieces'
export function bridgePrompt(from: Dimension, to: Dimension): { label: string; unitOptions: string[]; kind: 'each' | 'density' }
//  COUNT→MASS:   { label: 'One piece weighs', unitOptions: ['g','kg','oz','lb'], kind: 'each' }
//  COUNT→VOLUME: { label: 'One piece holds',  unitOptions: ['ml','l'],          kind: 'each' }
//  MASS→COUNT:   { label: 'One piece weighs', unitOptions: ['g','kg','oz','lb'], kind: 'each' }
//  VOLUME→COUNT: { label: 'One piece holds',  unitOptions: ['ml','l'],          kind: 'each' }
//  MASS↔VOLUME:  { label: '1 ml weighs (g)',  unitOptions: ['g'],               kind: 'density' }
export function changeLines(s: RemeasureSummary): string[]
//  "<n> count(s) will be restated." · "<n> deliver(y|ies) will be restated." · "<n> supplier box(es) will be re-expressed." ·
//  "<n> stock transfer(s) will be restated." · "<n> recipe(s) keep costing through the bridge." (or "No recipe uses it.") ·
//  "<n> wastage entr(y|ies) stay as typed." · then each warning verbatim. Zero rows → the line is omitted (except recipes).
export function appliedToast(to: Dimension): string   // "Now measured by weight. Counts, deliveries and boxes were restated."
```

**Sheet UX** (same shell as `MergeItemSheet` — bottom sheet < sm, centered panel ≥ sm; MANAGER+ only):
- Header: "Change how {itemName} is measured". Sub: "Today: {measureWord(from)} · {from.packLabel} · {from.priceLabel}".
- Step 1 "Measure it by": three choice cards Weight / Volume / Pieces (the current one shows "current" and is not selectable). Unit select under the chosen card (weight g/kg/lb/oz; volume ml/l; pieces: each only, no select). Bridge row per `bridgePrompt` (number input + unit select; prefilled from the item's stored `eachMeasureQty/Unit` or `densityGPerMl` when its unit fits). Button "Show what changes" → POST `apply:false`; refusals show their sentence inline.
- Step 2 "What changes": a Before → After card with two columns (measure word, pack label, price label, count unit); the box list (supplier · before → after, ★ main); `changeLines(summary)` as bullets; warnings in amber. Buttons: "Apply" (primary) and "Back". Apply → POST `apply:true` with `expectedLastUpdated: item.lastUpdated`; STALE → sentence + "Reload" which calls `onChanged()` and closes; success → `onChanged()`, close, toast `appliedToast(to)`.
- `RemeasuredRow({ itemId, refreshKey, onChanged })`: GET `/api/inventory/[id]/remeasure`; for each change with `undoneAt` null: "Measure changed to {word} · {relative time}" + "Undo" (or "· undo no longer safe" with the reason as title) — same shape as `MergedItemsRow`.
- Drawer: in edit mode, the locked line becomes: "Measured by {word} — locked because it has counts, deliveries or recipes." + button "Change how it's measured" (opens the sheet; hidden below MANAGER). ALSO in view mode under the PRICE block for MANAGER+: a small link "Change how it's measured" (so the flow is reachable without entering Edit).
- Invoice review: the AdoptFormatModal cross-measure sentence (box/new-box target) ends with the link; nothing else changes there.

- [ ] **Step 1:** copy helpers + tests.
- [ ] **Step 2:** build the sheet, row, drawer wiring, modal sentence; `npm run build`; lint.
- [ ] **Step 3:** commit `feat(inventory): "Change how it's measured" sheet — preview, apply, undo`.

---

### Task 4: Smoke, PR, merge

- [ ] Preview from the worktree (temporary launch.json entry, port 3118; verify `lsof -a -p <pid> -d cwd -Fn`). Use the existing throwaway item **"ZZ Test Box Item (safe to delete)"** (id `cmut0gvxr00016p26kx7g4myv`, currently inactive — reactivate it): give it one Sysco box, record one quick count (3 case), then run the flow MASS→COUNT with "one piece weighs 100 g": preview shows 1 count, 1 box, the Before/After labels; Apply; the item reads pieces with chain `[{case:10}]`, the box too, the count line's base = 30, the price label unchanged ($15 per case); Undo restores everything (compare the item + box + count line JSON before/after). Then deactivate the item again.
- [ ] Also check the invoice review screen's adopt modal sentence on a cross-measure line (any REVIEW session) names the drawer link.
- [ ] Push `feat/remeasure`, PR (Before: "an item's measure could not be changed once it had history — a wrong one was stuck". After: "Change how it's measured — pick weight/volume/pieces, say what one piece weighs, see what will be restated, apply, undo"), `gh pr checks --watch`, squash-merge after the final review passes.

## Self-review
- **Spec coverage:** R3 guided fix (route + diff + apply in one transaction + undo manifest) ✔; bridges stored so recipes keep costing ✔; the Stage 2b cross-measure refusal now points at the fix ✔. Not covered on purpose: rewriting `WastageLog` (unit-stored), `InvoiceLineItem` (provenance), count variances (frozen expectations) — all stated in the summary copy.
- **Placeholders:** none; every sentence and rule is given.
- **Type consistency:** `Measure`, `Bridge`, `RemeasurePlan`, `RemeasureSummary`, `RemeasureManifest`, `RemeasureRefusal`, `planRemeasure`, `previewRemeasure`, `applyRemeasure`, `undoRemeasure`, `listRemeasures`, `buildManifest`, `undoBlocker`, `bridgePrompt`, `changeLines`, `appliedToast`, `RemeasureSheet`, `RemeasuredRow` as named throughout.
