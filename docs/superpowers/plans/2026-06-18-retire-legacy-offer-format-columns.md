# Retire Legacy Offer / Format Columns (Flags 2–4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the pack-chain cutover in the invoice/offer subsystem by (A) dropping the one truly-redundant divergence column `InventorySupplierPrice.pricePerBaseUnit`, and (B/C) converting the remaining "legacy" pack/format fields and form-shapes from *untracked tech debt* into *documented, intentional* design — plus one real DRY cleanup.

**Architecture:** The single source of truth is the pack-chain item model (`dimension` + `packChain` + `pricing` → ppb derived on read via `src/lib/item-model.ts`). `InventorySupplierPrice.pricePerBaseUnit` is a *cached copy* of a value `offerPricePerBase()` already derives from the chain — it can drift, so it is dropped. The pack-format triples (`packQty`/`packSize`/`packUOM` on offers and `invoicePack*` on `InvoiceMatchRule`) are **retained**: they carry the human-readable purchase format ("4 × 3 L") that the normalized chain collapses into base units and cannot fully reconstruct. The form-shapes feeding `formToChain` are an intentional input adapter, not stored columns.

**Tech Stack:** Next.js 14 App Router · Prisma + PostgreSQL (Supabase, pgBouncer transaction-mode pooler) · TypeScript · `ts-node` scripts gated behind `APPLY=1`/env.

**Scope decision (locked by user 2026-06-18):** "Drop only `pricePerBaseUnit`." Do NOT drop `packQty`/`packSize`/`packUOM` or the `InvoiceMatchRule.invoicePack*` triple — retain + document them.

---

## ⚠️ Migration mechanics (READ FIRST — non-standard in this repo)

This repo's migration path is **not** `prisma migrate dev`. Per established convention (memory: `project_prisma_migrate_shadow_broken`, `project_item_model_redesign`; reference script `scripts/drop-invoice-legacy-columns.ts`):

1. The shadow DB is broken (P3006) and the **direct DB host is unreachable** from this environment, so `prisma migrate dev` and full-schema `prisma migrate diff` both fail.
2. DDL is applied by a **`ts-node` script using `prisma.$executeRawUnsafe(...)` over the pgBouncer pooler**, using `ALTER TABLE ... DROP COLUMN IF EXISTS`.
3. **Expand-contract is mandatory:** the schema-trimmed code must be **deployed and running in production BEFORE the column is dropped** — the live Supabase DB is shared with prod; dropping a column the running build still selects 500s production.
4. After applying, a `migration.sql` file is written under `prisma/migrations/<ts>_<name>/` recording the DDL, and the migration is marked applied with `prisma migrate resolve --applied <name>` so migration history stays consistent.

## Verification approach (no unit-test suite)

Per `CLAUDE.md`: **there is no test suite — `npm run build` is the only automated correctness check**, and the repo's convention is read-only `scripts/verify-*.ts` assertion scripts (e.g. `verify-offer-engine.ts`, `verify-item-model-parity.ts`). This plan therefore uses, in place of unit tests:
- a new `scripts/verify-offer-ppb-parity.ts` that asserts every offer's chain-derived ppb matches its (about-to-be-dropped) stored `pricePerBaseUnit` within tolerance — the **safety gate** before the column drop, and
- `npm run build` after each code change, and
- targeted manual spot-checks where noted.

Build command (node is not on PATH in this environment):
```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
npm run build
```
Script run pattern (matches existing scripts' header comments):
```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
set -a && . ./.env; set +a && \
  TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/<name>.ts
```

---

## File Structure

| File | Phase | Responsibility / change |
|---|---|---|
| `scripts/backfill-supplier-offers.ts` | A | **Fix (currently broken):** stop selecting dropped `InventoryItem` cols; co-write `packChain`+`pricing`; stop writing `pricePerBaseUnit`. |
| `src/lib/supplier-offers.ts` | A | `offerPricePerBase()` → chain-only (drop stored-ppb fallback); remove `pricePerBaseUnit` from `SupplierOfferStats` input type. |
| `src/app/api/reports/analytics/route.ts` | A | Line ~467: read offer ppb via `offerPricePerBase(o)` not the raw column. |
| `src/lib/invoice/resolution.ts` | A | `offerForSupplier()` must return chain-derived ppb (inspect + convert if it reads the raw column). |
| `src/app/api/invoices/sessions/[id]/approve/route.ts` | A | Remove the two `pricePerBaseUnit:` writes on the offer upsert (chain is already co-written). |
| `scripts/verify-offer-ppb-parity.ts` | A | **New.** Safety gate: chain-derived ppb ≈ stored ppb for every offer; every offer has a chain. |
| `prisma/schema.prisma` | A | Remove `pricePerBaseUnit` from `InventorySupplierPrice`. |
| `scripts/drop-supplierprice-ppb.ts` | A | **New.** `$executeRawUnsafe` DDL drop over the pooler (run post-deploy). |
| `prisma/migrations/<ts>_drop_supplierprice_ppb/migration.sql` | A | **New.** Record the DDL; `migrate resolve --applied`. |
| `prisma/schema.prisma` (comments) | B | Annotate retained format columns as intentional. |
| `src/app/count/page.tsx` | C | Route the add-item form through `formToChain` (DRY: delete the inline chain-build duplicate). |
| `src/app/api/invoices/sessions/[id]/approve/route.ts` (comment) | C | Document `formToChain` as the sanctioned legacy→chain adapter boundary (no logic change). |
| `CLAUDE.md` + memory note | B/C | Record that the retained columns/adapters are intentional so future audits don't re-flag them. |

Phases A, B, C are independently shippable. **Phase A is the only one requiring a DB migration.** Recommended order: A → B → C, but B and C can ship in any order / separately.

---

## PHASE A — Drop `InventorySupplierPrice.pricePerBaseUnit`

> Resolves the divergence portion of **Flag 3**. The stored column is a corruptible copy of a chain-derived value; dropping it removes the only place an offer's ppb can drift from its chain.

### Task A1: Fix the (already-broken) supplier-offers backfill

**Context:** `scripts/backfill-supplier-offers.ts:54-57` selects `qtyPerPurchaseUnit`, `packSize`, `packUOM` from `InventoryItem` — **these columns were dropped** (commit `74c8524`/`a39e324`), so the script currently throws "column does not exist." It also writes `pricePerBaseUnit` (the column we're dropping) but never writes `packChain`/`pricing`, so after the drop `offerPricePerBase()` would have no chain to read. Fix both.

**Files:**
- Modify: `scripts/backfill-supplier-offers.ts`

- [ ] **Step 1: Add the chain-builder import**

At the top of the file (after the existing imports on lines 7-8), add:

```typescript
import { buildOffer, scanItemToOfferInput } from '../src/lib/invoice/offer'
```

- [ ] **Step 2: Fix the broken `InventoryItem` select**

Replace the broken select (currently lines ~54-57):

```typescript
      const item = await prisma.inventoryItem.findUnique({
        where: { id: li.matchedItemId },
        select: { qtyPerPurchaseUnit: true, packSize: true, packUOM: true },
      })
      if (!item) continue
```

with the chain-shaped select that `scanLinePricePerBase` actually expects (`{ packChain, baseUnit }`):

```typescript
      const item = await prisma.inventoryItem.findUnique({
        where: { id: li.matchedItemId },
        select: { packChain: true, baseUnit: true },
      })
      if (!item) continue
```

- [ ] **Step 3: Co-write `packChain` + `pricing`; stop writing `pricePerBaseUnit`**

Replace the `pack` construction + upsert (currently lines ~67-92). First build the offer chain from the line, then write it. New block:

```typescript
      const pack = li.invoicePackQty !== null && li.invoicePackSize !== null
        ? { packQty: Number(li.invoicePackQty), packSize: Number(li.invoicePackSize), packUOM: li.invoicePackUOM ?? 'each' }
        : {}
      // Per-offer chain: same OfferDraft the approve route writes. pricing carries
      // the offer's own lastPrice so chainPpb(packChain, pricing) === ppb.
      const draft = buildOffer({ ...scanItemToOfferInput(li), unitPrice: lastPrice })
      const offerChain = { packChain: draft.packChain as object, pricing: { ...draft.pricing, purchasePrice: lastPrice } as object }
      await prisma.inventorySupplierPrice.upsert({
        where: { inventoryItemId_supplierName: { inventoryItemId: li.matchedItemId, supplierName: offerSupplierName } },
        create: {
          inventoryItemId: li.matchedItemId,
          supplierName: offerSupplierName,
          supplierId: s.supplierId,
          lastPrice,
          isPrimary: false,
          supplierItemCode: li.supplierItemCode,
          lastInvoiceSessionId: s.id,
          ...offerChain,
          ...pack,
        },
        update: {
          lastPrice,
          lastUpdated: new Date(),
          lastInvoiceSessionId: s.id,
          ...offerChain,
          ...(s.supplierId ? { supplierId: s.supplierId } : {}),
          ...(li.supplierItemCode ? { supplierItemCode: li.supplierItemCode } : {}),
          ...pack,
        },
      })
```

> Note: `pricePerBaseUnit` is intentionally NOT written. While the column still exists (until Task A8) Prisma leaves it at its `@default`; after the drop the field disappears. `ppb` (the local from `scanLinePricePerBase`) is no longer needed for the write — keep the `if (ppb === null) continue` guard above it as a data-quality filter.

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: PASS (no "column does not exist" type errors; `buildOffer`/`scanItemToOfferInput` resolve).

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-supplier-offers.ts
git commit -m "fix(offers): repair broken backfill — chain select + co-write packChain/pricing"
```

### Task A2: Make `offerPricePerBase()` chain-only

**Files:**
- Modify: `src/lib/supplier-offers.ts:16-30` and the `SupplierOfferStats` input usage.

- [ ] **Step 1: Drop the stored-ppb fallback**

Replace `offerPricePerBase` (lines 16-30):

```typescript
export function offerPricePerBase(offer: {
  packChain?: unknown
  pricing?: unknown
  pricePerBaseUnit?: unknown
}): number {
  const chain = Array.isArray(offer.packChain) ? offer.packChain : null
  const pricing = offer.pricing && typeof offer.pricing === 'object' ? offer.pricing : null
  if (chain && chain.length && pricing) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return chainPpb({ packChain: chain, pricing } as any)
  }
  return Number(offer.pricePerBaseUnit ?? 0) // legacy fallback
}
```

with the chain-only version:

```typescript
export function offerPricePerBase(offer: {
  packChain?: unknown
  pricing?: unknown
}): number {
  const chain = Array.isArray(offer.packChain) ? offer.packChain : null
  const pricing = offer.pricing && typeof offer.pricing === 'object' ? offer.pricing : null
  if (chain && chain.length && pricing) {
    // pricePerBaseUnit reads only packChain + pricing; dimension/baseUnit unused.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return chainPpb({ packChain: chain, pricing } as any)
  }
  return 0 // no chain ⇒ unpriced offer (backfill guarantees a chain on every row)
}
```

- [ ] **Step 2: Update the doc-comment** above the function (lines 10-15) — replace the "Falls back to the stored `pricePerBaseUnit` column…" sentence with: `Returns 0 for an offer with no chain (should not occur post-backfill).`

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: PASS. (`getSupplierOffers` at line 186 calls `offerPricePerBase(o)` — `o` still has `packChain`/`pricing`, so this resolves. The `SupplierOfferStats.pricePerBaseUnit` *output* field stays — it's the computed value consumers read.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/supplier-offers.ts
git commit -m "refactor(offers): offerPricePerBase derives from chain only, no stored-ppb fallback"
```

### Task A3: Convert the remaining raw-column readers

There are exactly two server-side sites that read the **offer's raw `pricePerBaseUnit` column** (confirmed by grep). All other `.pricePerBaseUnit` reads are the *inventory item's* computed field (safe) or the `SupplierOfferStats` response field (computed, safe).

**Files:**
- Modify: `src/app/api/reports/analytics/route.ts:467`
- Inspect + maybe modify: `src/lib/invoice/resolution.ts` (`offerForSupplier`)

- [ ] **Step 1: analytics route — derive from chain**

At line ~467, replace:

```typescript
      .map(o => ({ supplier: o.supplierName, ppb: Number(o.pricePerBaseUnit), isPrimary: o.isPrimary }))
```

with (import `offerPricePerBase` from `@/lib/supplier-offers` at the top of the file if not already imported):

```typescript
      .map(o => ({ supplier: o.supplierName, ppb: offerPricePerBase(o), isPrimary: o.isPrimary }))
```

Confirm the `findMany` that produces `o` (line ~429) selects `packChain` + `pricing` (it currently has no explicit `select`, so it reads all columns — fine; if you add an explicit select later, include both).

- [ ] **Step 2: Inspect `offerForSupplier` in `src/lib/invoice/resolution.ts`**

`src/components/invoices/v2/issues.tsx:221` reads `Number(offer.pricePerBaseUnit)` where `offer = offerForSupplier(item, sessionSupplier)`. Open `src/lib/invoice/resolution.ts`, find `offerForSupplier`. Two cases:
- **If it returns a `SupplierOfferStats`** (i.e. its `pricePerBaseUnit` is already `offerPricePerBase(...)`-derived): no change needed — the field stays in the response type.
- **If it reads the raw column** off a `InventorySupplierPrice` row: change it to set `pricePerBaseUnit: offerPricePerBase(row)` (import from `@/lib/supplier-offers`) so the value is chain-derived and survives the column drop.

Make the minimal edit that guarantees `offer.pricePerBaseUnit` reaching `issues.tsx` is chain-derived, not the dropped column.

- [ ] **Step 3: Type-check + spot-check**

Run: `npm run build`
Expected: PASS. Then manually confirm via grep that no remaining `.pricePerBaseUnit` read targets a raw `InventorySupplierPrice` row:
```bash
grep -rn "pricePerBaseUnit" src/ | grep -iE "offer|supplierPrice" 
```
Expected: only the computed `SupplierOfferStats.pricePerBaseUnit` field definition/usages and `offerPricePerBase` internals remain.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/reports/analytics/route.ts src/lib/invoice/resolution.ts
git commit -m "refactor(offers): all offer ppb reads go through chain-derived offerPricePerBase"
```

### Task A4: Stop writing `pricePerBaseUnit` on the offer upsert

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts` (offer upsert create ~line 303, update ~line 316)

- [ ] **Step 1: Remove the two write lines**

The offer upsert already co-writes `packChain`/`pricing` (lines ~310/312/323/325). Delete the now-redundant stored-ppb writes:
- Remove the `pricePerBaseUnit:     newPricePerBase,` line in the **create** block (~line 303).
- Remove the `pricePerBaseUnit:     newPricePerBase,` line in the **update** block (~line 316).

Leave `newPricePerBase` itself — it is still used for the `InventoryItem` spine write and the skip-zero guard (lines ~128/159). Only the two *offer* writes are removed.

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/invoices/sessions/[id]/approve/route.ts"
git commit -m "refactor(offers): stop writing cached pricePerBaseUnit on offer upsert (chain is authoritative)"
```

### Task A5: Backfill + the parity safety-gate verify script

**Files:**
- Create: `scripts/verify-offer-ppb-parity.ts`

> **Gate design correction (2026-06-18, post Task A1 review):** Do NOT compare chain-derived ppb against the stored `pricePerBaseUnit` column. They are intentionally *different denominations* — the stored column was `scanLinePricePerBase`/`newPrice`-based, whereas the chain (matching the live approve route) is `lastPrice`-based; and the backfill `deleteMany`-wipes the table before rebuilding, so the old column value isn't even preserved on the rebuilt rows. The correct, meaningful gate is: **every offer row has a valid non-empty `packChain` + `pricing`, and `offerPricePerBase(row)` resolves to a finite positive number** (i.e. no row would silently price at 0 once the stored-column fallback is gone). `offerPricePerBase` is already chain-based in production for chain-bearing offers, so this is the real risk being guarded.

- [ ] **Step 1: Write the verify script**

```typescript
/**
 * Safety gate for dropping InventorySupplierPrice.pricePerBaseUnit.
 * After the chain-only refactor + backfill, the stored column is unused and
 * offerPricePerBase() derives from packChain+pricing. This asserts no offer is
 * left without a usable chain (which would silently price at 0 once the
 * stored-column fallback is removed). Read-only. Run BEFORE the column drop (A8).
 *   set -a && . ./.env; set +a && \
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/verify-offer-ppb-parity.ts
 */
import { prisma } from '../src/lib/prisma'
import { offerPricePerBase } from '../src/lib/supplier-offers'

async function main() {
  const offers = await prisma.inventorySupplierPrice.findMany()
  let noChain = 0, badPpb = 0
  for (const o of offers) {
    const chain = Array.isArray(o.packChain) ? o.packChain : []
    if (!chain.length || !o.pricing) {
      noChain++
      console.log(`NO-CHAIN  ${o.supplierName} / ${o.inventoryItemId}`)
      continue
    }
    const ppb = offerPricePerBase(o)
    if (!Number.isFinite(ppb) || ppb <= 0) {
      badPpb++
      console.log(`BAD-PPB   ${o.supplierName} / ${o.inventoryItemId}  ppb=${ppb}`)
    }
  }
  console.log(`\n${offers.length} offers · ${noChain} without chain · ${badPpb} with non-positive ppb`)
  if (noChain > 0 || badPpb > 0) { console.error('NOT SAFE TO DROP — every offer must carry a valid chain first.'); process.exit(1) }
  console.log('SAFE TO DROP pricePerBaseUnit.')
  await prisma.$disconnect()
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
```

- [ ] **Step 2: Run the backfill** (rebuilds every offer row with a chain — Task A1 made it correct)

Run:
```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
set -a && . ./.env; set +a && \
  TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/backfill-supplier-offers.ts
```
Expected: `Backfill done: N upserts · N offers total · …` with no errors.

- [ ] **Step 3: Run the parity gate**

Run:
```bash
set -a && . ./.env; set +a && \
  TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/verify-offer-ppb-parity.ts
```
Expected: `… 0 without chain · 0 ppb mismatches` and `SAFE TO DROP pricePerBaseUnit.` (exit 0).
If it reports mismatches/no-chain: STOP — investigate before continuing (do not drop the column).

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-offer-ppb-parity.ts
git commit -m "test(offers): add chain-vs-stored ppb parity gate before column drop"
```

> **CORRECTED LIVE SEQUENCE (2026-06-18, post-implementation).** The original A6→A7→A8 ordering was refined during execution. Two facts forced the change: (1) the live `pricePerBaseUnit` column is `NOT NULL` with no default, so code that stops writing it 500s on INSERT until the constraint is relaxed; (2) Prisma's bare `findMany` selects every scalar still declared in the schema, so the column cannot be dropped while the schema still declares it (`Decimal?`). The branch already makes the field `Decimal?` and stops all writes/reads of the value. Therefore the safe sequence is **two phases**:
>
> **Phase 1 — ship the divergence fix (this branch):**
> 1. Run `scripts/alter-supplierprice-ppb-nullable.ts` on the live DB (`ALTER COLUMN … DROP NOT NULL`). Safe while old code is still live.
> 2. Merge + deploy this branch. Offer ppb now derives from the chain everywhere; the cached column is dormant. **The divergence bug is fixed at this point.**
> 3. Run `scripts/verify-offer-ppb-parity.ts` (read-only). If it reports offers without a chain, run `scripts/backfill-supplier-offers.ts` in a quiet window (it `deleteMany`-wipes + rebuilds offers), then re-run the gate until clean.
>
> **Phase 2 — optional column hygiene (separate later PR):** Task A6 (remove the `Decimal?` field from schema) + deploy, THEN Task A8 (run `scripts/drop-supplierprice-ppb.ts` + record migration + `migrate resolve`). Do NOT drop the column before the field-removed schema is deployed.

### Task A6: Remove the column from the Prisma schema

**Files:**
- Modify: `prisma/schema.prisma` (`InventorySupplierPrice`)

- [ ] **Step 1: Delete the field**

In `model InventorySupplierPrice`, delete the line:

```prisma
  pricePerBaseUnit     Decimal
```

(Leave `lastPrice`, `packChain`, `pricing`, `packQty`, `packSize`, `packUOM`, `supplierItemCode`, etc.)

- [ ] **Step 2: Regenerate client + type-check**

Run:
```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
npx prisma generate && npm run build
```
Expected: PASS. The build is the real check that no code still selects/writes the removed field (a missed site fails to compile here).

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "refactor(schema): remove cached pricePerBaseUnit from InventorySupplierPrice (chain-derived)"
```

### Task A7: Deploy the schema-trimmed code (EXPAND-CONTRACT GATE)

- [ ] **Step 1: Merge + deploy** the branch so the running production build no longer references `InventorySupplierPrice.pricePerBaseUnit`. **Do NOT proceed to Task A8 until this deploy is live** — dropping the column while prod still selects it returns 500s.

  (Follow the repo's normal deploy: push branch → PR → merge to `main` → Vercel deploy. Confirm the deployment is `Ready`.)

### Task A8: Drop the column in the live DB

**Files:**
- Create: `scripts/drop-supplierprice-ppb.ts`
- Create: `prisma/migrations/<timestamp>_drop_supplierprice_ppb/migration.sql`

- [ ] **Step 1: Write the DDL script** (mirrors `scripts/drop-invoice-legacy-columns.ts`)

```typescript
/**
 * Drops the cached pricePerBaseUnit column from InventorySupplierPrice.
 * ⚠️ EXPAND-CONTRACT — RUN ONLY AFTER the schema-trimmed code is DEPLOYED (Task A7).
 * Uses $executeRawUnsafe over the pgBouncer pooler (direct host unreachable;
 * prisma migrate diff against the full schema fails — see project_prisma_migrate_shadow_broken).
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/drop-supplierprice-ppb.ts
 */
import { prisma } from '../src/lib/prisma'

async function main() {
  const stmt = `ALTER TABLE "InventorySupplierPrice" DROP COLUMN IF EXISTS "pricePerBaseUnit"`
  console.log(stmt)
  await prisma.$executeRawUnsafe(stmt)
  console.log('\nDropped pricePerBaseUnit from InventorySupplierPrice.')
  await prisma.$disconnect()
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
```

- [ ] **Step 2: Re-run the parity gate against live, then apply**

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
set -a && . ./.env; set +a
# gate must still pass:
TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/verify-offer-ppb-parity.ts
# then drop:
TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/drop-supplierprice-ppb.ts
```
Expected: gate prints `SAFE TO DROP`; drop prints the `ALTER TABLE` + success.

- [ ] **Step 3: Record the migration + mark applied**

Create `prisma/migrations/<timestamp>_drop_supplierprice_ppb/migration.sql` (use a timestamp later than the most recent migration, format `YYYYMMDDHHMMSS`):

```sql
-- Offer divergence contract step. Drop the cached pricePerBaseUnit on
-- InventorySupplierPrice — fully replaced by chain-derived offerPricePerBase().
-- Applied via $executeRawUnsafe over the pooler (direct host unreachable).
-- Safe: the deployed Prisma client no longer selects this column.
ALTER TABLE "InventorySupplierPrice" DROP COLUMN IF EXISTS "pricePerBaseUnit";
```

Then mark it applied (so history matches the live DB without re-running):
```bash
npx prisma migrate resolve --applied <timestamp>_drop_supplierprice_ppb
```

- [ ] **Step 4: Commit**

```bash
git add scripts/drop-supplierprice-ppb.ts prisma/migrations
git commit -m "chore(db): drop InventorySupplierPrice.pricePerBaseUnit (applied to live DB via pooler)"
```

---

## PHASE B — Document the retained format columns (Flag 2 + pack-triple of Flag 3)

> These columns were flagged as "legacy not migrated." Per the scope decision they are **kept on purpose** (human pack format the chain can't reconstruct). The fix is to make that intent explicit so future audits stop treating them as debt.

### Task B1: Annotate the schema

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Comment the offer pack-format columns**

On `model InventorySupplierPrice`, above `packQty`/`packSize`/`packUOM`, add:

```prisma
  // RETAINED human pack format ("4 × 3 L") — provenance/display only. The chain
  // (packChain/pricing) is the costing source of truth; these are NOT a divergence
  // risk and are NOT derivable from the normalized chain for single-link offers.
```

- [ ] **Step 2: Comment the match-rule format triple**

On `model InvoiceMatchRule`, above `invoicePackQty`/`invoicePackSize`/`invoicePackUOM`, add:

```prisma
  // RETAINED learned pack-format cache. The matcher re-applies this {qty,size,UOM}
  // triple to new scan lines (and buildMatchResult consumes the triple, not a chain).
  // Intentionally NOT migrated to packChain — the triple is the human format, not a cost.
```

- [ ] **Step 3: Verify schema still parses**

Run: `npx prisma generate`
Expected: success (comments are inert).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "docs(schema): mark retained offer/match pack-format columns as intentional (not legacy debt)"
```

### Task B2: Record the decision in CLAUDE.md + memory

**Files:**
- Modify: `CLAUDE.md` (the spine / item-model section)

- [ ] **Step 1: Add a short note** under the pack-chain notes in `CLAUDE.md`:

```markdown
**Retained format fields (not legacy debt):** `InventorySupplierPrice.{packQty,packSize,packUOM}`
and `InvoiceMatchRule.invoicePack{Qty,Size,UOM}` are kept deliberately — they store the human
purchase format the normalized `packChain` collapses into base units. Costing always derives
from the chain; these are display/provenance/learned-format only. Do not "migrate" them to a chain.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record retained offer/match format fields as intentional"
```

- [ ] **Step 3: Update auto-memory** — append a line to `/Users/joshua/.claude/projects/-Users-joshua-dev-fergies-os/memory/MEMORY.md` pointing at a new memory file recording: ppb dropped from InventorySupplierPrice; pack-format triples retained by design. (Write the memory file per the memory format; `metadata.type: project`.)

---

## PHASE C — Form-shape cleanup (Flag 4)

> Both sites already author a chain at the DB boundary, so this is DRY cleanup, not a behavior fix. **Do not refactor the approve route's logic** — it is the canonical spine writer; `formToChain` is the sanctioned adapter and a logic change there is high-risk/zero-reward. Only the count page has a real duplicate worth removing.

### Task C1: Route the Count add-item form through `formToChain`

**Context:** `src/app/count/page.tsx:797-816` re-implements chain-building inline (the `dimension`/`packChain` literal), duplicating the canonical `formToChain` in `src/lib/item-model-form.ts`. Replace the inline build with a `formToChain` call so there is one converter.

**Files:**
- Modify: `src/app/count/page.tsx` (add-item submit handler, ~lines 797-820)

- [ ] **Step 1: Import the adapter**

Add to the imports at the top of `src/app/count/page.tsx`:

```typescript
import { formToChain } from '@/lib/item-model-form'
```

- [ ] **Step 2: Replace the inline chain build**

Replace the inline `dimension`/`packChain`/`chainBody` construction (lines ~797-816) with a `formToChain` call. The current `addItemForm` fields map onto `ItemFormInput`:

```typescript
    const chain = formToChain({
      purchaseUnit:       addItemForm.purchaseUnit || 'each',
      purchasePrice:      parseFloat(addItemForm.purchasePrice) || 0,
      qtyPerPurchaseUnit: parseFloat(addItemForm.qtyPerPurchaseUnit) || 1,
      qtyUOM:             'each',
      innerQty:           null,
      packSize:           parseFloat(addItemForm.conversionFactor) || 1, // base-units per leaf
      packUOM:            addItemForm.baseUnit,                          // g | ml | each
      priceType:          'CASE',
      countUOM:           addItemForm.purchaseUnit || 'each',
      baseUnit:           addItemForm.baseUnit,
    })
    const chainBody = {
      itemName: addItemForm.itemName,
      category: addItemForm.category,
      supplierId: addItemForm.supplierId || null,
      storageAreaId: addItemForm.storageAreaId || null,
      location: addItemForm.location || null,
      stockOnHand: parseFloat(addItemForm.stockOnHand) || 0,
      dimension: chain.dimension,
      packChain: chain.packChain,
      pricing: chain.pricing,
      countUnit: chain.countUnit,
    }
```

> Verify against `src/lib/item-model-form.ts` that `formToChain`'s `packSize`/`packUOM` semantics match: it should treat `packSize × conv(packUOM)` as the leaf base content. Here `baseUnit` is already `g`/`ml`/`each` (conv 1), so `packSize = conversionFactor` reproduces the previous inline behavior `[{ unit: top, per: qtyPer }, { unit: 'each', per: conv }]`. If `formToChain` collapses the single-pack case differently than the old inline code, prefer `formToChain`'s output (it is the canonical converter) and confirm with Step 4.

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Manual verification** — start the dev server and add a count item to confirm the chain round-trips:

```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
```
Use the preview workflow: open `/count`, add a new item (e.g. "1 case = 6 × 1 each, $12"), save, then open it in `/inventory` and confirm the pack chain + price-per-base-unit display matches what was entered. Capture a screenshot as proof.

- [ ] **Step 5: Commit**

```bash
git add src/app/count/page.tsx
git commit -m "refactor(count): build add-item chain via formToChain (drop inline duplicate)"
```

### Task C2: Document the approve-route adapter boundary (no logic change)

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts` (comment only)

- [ ] **Step 1: Add a clarifying comment** above the first `formToChain({` call (~line 264):

```typescript
        // formToChain is the SANCTIONED legacy-form → pack-chain adapter. The
        // object below is a transient input DTO (qtyUOM/innerQty are vestigial
        // adapter params, never persisted) — NOT legacy columns. Do not inline this.
```

- [ ] **Step 2: Commit**

```bash
git add "src/app/api/invoices/sessions/[id]/approve/route.ts"
git commit -m "docs(invoice): mark formToChain as the sanctioned legacy-form adapter boundary"
```

---

## Self-Review notes

- **Spec coverage:** Flag 3 divergence → Phase A (drop ppb). Flag 3 pack-triple + Flag 2 → Phase B (retain + document, per scope decision). Flag 4 → Phase C (count DRY refactor + approve doc). Flag 1 (unpriced items) explicitly out of scope (manual data work).
- **No placeholders:** every code step shows the actual code; every command shows expected output. The only deliberately open step is Task A3 Step 2 (`offerForSupplier` inspection) — it cannot be pre-written without reading `resolution.ts`, so it specifies the exact decision and the minimal edit for each branch.
- **Type consistency:** `offerPricePerBase(offer)` input type loses its `pricePerBaseUnit?` member in A2; every caller (A3 analytics, A3 resolution, A5 verify, supplier-offers map) passes a row that still has `packChain`/`pricing`. `SupplierOfferStats.pricePerBaseUnit` (the computed *output* field) is unchanged and still consumed by `SupplierOffersSection.tsx`.
- **Migration safety:** the parity gate (A5) must pass before the drop (A8), and the drop only runs after deploy (A7) — expand-contract preserved.
```