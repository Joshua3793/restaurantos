# Primary-offer-driven pricing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an inventory item's headline `pricePerBaseUnit` derive from a manually-chosen, sticky **primary supplier offer**, so invoices from non-primary suppliers record an offer without re-pricing the item, and switching the primary re-prices it.

**Architecture:** Offers (`InventorySupplierPrice`) already each carry their own `packChain` + `pricing`. We add `src/lib/primary-offer.ts` with three transactional helpers that enforce the invariant *"an item with offers has exactly one primary, and `item.packChain`/`item.pricing` equal that primary offer's."* Every offer-mutating write site ends by syncing in the natural direction (offer→item at approve/set-primary; item→primary-offer at manual edit). A partial unique index guarantees ≤1 primary per item at the DB level. The ~46 spine readers are untouched — they keep reading `item.pricing`.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma + PostgreSQL (Supabase pooler), `ts-node` verify scripts. No test framework — `npm run build` is the only automated check; logic is verified with dry-run scripts.

**Spec:** [docs/superpowers/specs/2026-06-18-primary-offer-pricing-design.md](../specs/2026-06-18-primary-offer-pricing-design.md)

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src/lib/primary-offer.ts` | The invariant. `ensurePrimary`, `syncPrimaryOfferToItem`, `setPrimaryOffer`, `mirrorItemToPrimaryOffer`. Pure-ish; depends only on Prisma client + `item-model.ts`. | Create |
| `src/app/api/inventory/[id]/suppliers/route.ts` | Set-primary endpoint — call `setPrimaryOffer` + re-cost. | Modify |
| `src/app/api/invoices/sessions/[id]/approve/route.ts` | Gate item spine write on primary supplier; always upsert offer; bootstrap first offer. | Modify |
| `src/app/api/inventory/[id]/route.ts` | Manual edit mirrors item → primary offer. | Modify |
| `scripts/backfill-primary-offers.ts` | Dedupe primaries (most-recently-updated wins) + sync every item's spine. Idempotent, `APPLY=1`. | Create |
| `scripts/add-primary-offer-index.ts` | Create the partial unique index over the pooler via `$executeRawUnsafe`. | Create |
| `scripts/verify-primary-offers.ts` | Assert the invariant holds across all items. | Create |
| `prisma/migrations/<ts>_primary_offer_index/migration.sql` | Record the index DDL for history. | Create |
| `src/components/inventory/SupplierOffersSection.tsx` | "Cheaper supplier available" nudge + refresh the drawer headline after a reprice. | Modify |

The comparison UX core (`SupplierOffersSection.tsx`: cheapest highlight, "Set as primary" star, `PATCH /api/inventory/[id]/suppliers` call) **already exists**. Task 2 upgrades the endpoint; Task 10 adds the nudge + headline refresh.

---

## Task 1: Create `src/lib/primary-offer.ts`

**Files:**
- Create: `src/lib/primary-offer.ts`

- [ ] **Step 1: Write the module**

```typescript
// src/lib/primary-offer.ts
//
// The primary-offer invariant: an InventoryItem with ≥1 InventorySupplierPrice
// row has EXACTLY ONE row with isPrimary=true, and the item's packChain/pricing
// (the $ spine) equal that primary offer's. The item's dimension/baseUnit (its
// physical identity) never change with supplier; only the pack FORMAT + price do.
//
// Items with NO offers (PREP-linked, manual, non-stocked) keep authoring their
// own item.pricing — every helper here is a no-op for them.

import { prisma } from '@/lib/prisma'
import {
  asChainItem, pricePerBaseUnit, levelBaseUnits, dimensionOf,
  type PackLink, type Pricing,
} from '@/lib/item-model'

// Minimal client surface so callers can pass either `prisma` or a tx client.
type Db = Pick<typeof prisma, 'inventoryItem' | 'inventorySupplierPrice'>

export interface SyncResult {
  changed: boolean
  oldPpb: number
  newPpb: number
}

/** The price implied by an offer's pricing, for the legacy item.purchasePrice column. */
function purchasePriceFromPricing(pricing: Pricing): number {
  return pricing.mode === 'RATE' ? Number(pricing.rate || 0) : Number(pricing.purchasePrice || 0)
}

/**
 * Guarantee the item has exactly one primary offer when it has offers.
 * If none (or >1) is primary, promote the most-recently-updated offer.
 * No-op for items with no offers. Returns the primary offer id, or null.
 */
export async function ensurePrimary(itemId: string, db: Db = prisma): Promise<string | null> {
  const offers = await db.inventorySupplierPrice.findMany({
    where: { inventoryItemId: itemId },
    select: { id: true, isPrimary: true },
    orderBy: { lastUpdated: 'desc' },
  })
  if (offers.length === 0) return null
  const primaries = offers.filter((o) => o.isPrimary)
  if (primaries.length === 1) return primaries[0].id
  // none, or more than one: promote the most-recently-updated, clear the rest.
  const winner = offers[0].id
  await db.inventorySupplierPrice.updateMany({
    where: { inventoryItemId: itemId },
    data: { isPrimary: false },
  })
  await db.inventorySupplierPrice.update({ where: { id: winner }, data: { isPrimary: true } })
  return winner
}

/**
 * Write the primary offer's packChain + pricing onto the item (the $ spine).
 * Preserves the item's dimension/baseUnit; re-validates countUnit against the
 * adopted chain and falls back to the base unit if it is no longer a chain level.
 * Never writes a zero/non-finite ppb (that would silently zero every recipe cost).
 * No-op for items with no offers. Returns the ppb delta so callers can fire alerts.
 */
export async function syncPrimaryOfferToItem(itemId: string, db: Db = prisma): Promise<SyncResult> {
  const item = await db.inventoryItem.findUnique({
    where: { id: itemId },
    select: { dimension: true, baseUnit: true, packChain: true, pricing: true, countUnit: true },
  })
  if (!item) return { changed: false, oldPpb: 0, newPpb: 0 }
  const oldPpb = pricePerBaseUnit(asChainItem(item))

  const primary = await db.inventorySupplierPrice.findFirst({
    where: { inventoryItemId: itemId, isPrimary: true },
    select: { packChain: true, pricing: true },
  })
  // No usable primary offer → leave the item's own spine untouched.
  if (!primary || !Array.isArray(primary.packChain) || !primary.pricing) {
    return { changed: false, oldPpb, newPpb: oldPpb }
  }

  const newChain = primary.packChain as PackLink[]
  const newPricing = primary.pricing as Pricing
  const newPpb = pricePerBaseUnit({
    dimension: item.dimension as 'MASS' | 'VOLUME' | 'COUNT',
    baseUnit: item.baseUnit,
    packChain: newChain,
    pricing: newPricing,
  })
  if (!Number.isFinite(newPpb) || newPpb <= 0) {
    return { changed: false, oldPpb, newPpb: oldPpb }
  }

  // Re-validate countUnit against the adopted chain.
  const levels = levelBaseUnits(newChain)
  let countUnit = item.countUnit ?? 'each'
  const stillValid = countUnit in levels || dimensionOf(countUnit) === item.dimension
  if (!stillValid) countUnit = item.baseUnit

  await db.inventoryItem.update({
    where: { id: itemId },
    data: {
      packChain: newChain as unknown as object,
      pricing: newPricing as unknown as object,
      purchasePrice: purchasePriceFromPricing(newPricing),
      countUnit,
      lastUpdated: new Date(),
    },
  })
  return { changed: Math.abs(newPpb - oldPpb) > 1e-9, oldPpb, newPpb }
}

/** Make `offerId` the primary (clearing siblings) then sync the item spine. */
export async function setPrimaryOffer(itemId: string, offerId: string, db: Db = prisma): Promise<SyncResult> {
  await db.inventorySupplierPrice.updateMany({
    where: { inventoryItemId: itemId },
    data: { isPrimary: false },
  })
  await db.inventorySupplierPrice.update({ where: { id: offerId }, data: { isPrimary: true } })
  return syncPrimaryOfferToItem(itemId, db)
}

/**
 * After a manual item edit, mirror the item's chain+pricing onto the primary
 * offer so the invariant (item == primary offer) holds. No-op when no primary.
 */
export async function mirrorItemToPrimaryOffer(itemId: string, db: Db = prisma): Promise<void> {
  const primary = await db.inventorySupplierPrice.findFirst({
    where: { inventoryItemId: itemId, isPrimary: true },
    select: { id: true },
  })
  if (!primary) return
  const item = await db.inventoryItem.findUnique({
    where: { id: itemId },
    select: { packChain: true, pricing: true, purchasePrice: true },
  })
  if (!item) return
  await db.inventorySupplierPrice.update({
    where: { id: primary.id },
    data: {
      packChain: item.packChain as unknown as object,
      pricing: item.pricing as unknown as object,
      lastPrice: item.purchasePrice,
      lastUpdated: new Date(),
    },
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS (compiles; no usages yet). If `Db` type rejects a method, widen the `Pick<...>` to include it.

- [ ] **Step 3: Commit**

```bash
git add src/lib/primary-offer.ts
git commit -m "feat(pricing): primary-offer invariant helpers"
```

---

## Task 2: Upgrade the set-primary endpoint to sync the spine

**Files:**
- Modify: `src/app/api/inventory/[id]/suppliers/route.ts:19-44`

The PATCH currently flips `isPrimary` but does not re-price the item or re-cost recipes. Replace the transaction with `setPrimaryOffer` + prep-cost propagation.

- [ ] **Step 1: Add imports**

At the top of the file, after the existing imports, add:

```typescript
import { setPrimaryOffer } from '@/lib/primary-offer'
import { propagatePrepCostChanges } from '@/lib/recipeCosts'
```

- [ ] **Step 2: Replace the PATCH body**

Replace the existing `$transaction([...])` call and the final return (lines ~33-43) with:

```typescript
  const result = await setPrimaryOffer(params.id, body.offerId)
  // A primary switch is a spine change — propagate to dependent PREP recipes so
  // their costs (and every report/recipe/count read) reflect the new price now.
  // Matches the manual-edit path; session-scoped PriceAlerts are not created here.
  if (result.changed) await propagatePrepCostChanges([params.id])
  return NextResponse.json({ ok: true, repriced: result.changed, ppb: result.newPpb })
```

(Keep the existing `offerId` validation and the `findFirst` existence check above it.)

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/inventory/[id]/suppliers/route.ts
git commit -m "feat(pricing): set-primary re-prices item + re-costs recipes"
```

---

## Task 3: Gate invoice-approve's spine write on the primary supplier

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts` (UPDATE_PRICE/ADD_SUPPLIER branch, ~lines 226-402)

Currently the branch unconditionally (a) writes `item.pricing`/format, (b) creates a PriceAlert, (c) pushes to `updatedItemIds`, then (d) upserts the offer. New behaviour: **upsert the offer first**, bootstrap the item's first offer as primary, then re-price the item (write `item.pricing`/format + alert + push) **only** when (this line's supplier IS the primary) OR (the invoice had no resolvable supplier, so there is no offer to derive from — legacy direct write keeps the price live). A non-primary supplier's invoice records its offer but never re-prices the item.

This is a reorder + a single `shouldReprice` gate — the offer-upsert block and the item-write block are existing code, just moved and conditionalized. The skip guards above line 226 (dimension conflict / format differs / zero price) are unchanged: a skipped line never reaches the offer upsert, so no garbage offer is recorded.

- [ ] **Step 1: Add import**

After the existing `import { recalculateRecipeCosts } from '@/lib/recipe-costs'` line, add:

```typescript
import { ensurePrimary } from '@/lib/primary-offer'
```

- [ ] **Step 2: Replace the whole pricing-write + offer-upsert region**

Replace everything from the `// ── Dual-write the chain pricing ...` comment (~line 226) through the end of the `if (offerSupplierName) { ... }` offer-upsert block (~line 402) — i.e. up to and including the line `}).catch((e) => console.error('[approve] offer upsert failed:', e))` and its closing `}` — with the block below. The variables `rawPriceType`, `newPurchasePrice`, `resolvedRateUnit`, `useInvoicePack`, `packQty`/`packSize`/`packUOM`, `item`, `scanItem`, `offerSupplierName`, `session`, `sessionId`, `prevPrice`, `changePct`, and `newPricePerBase` are all already declared above and stay in scope.

```typescript
        // ── Build this line's pricing + (consented) format ───────────────────
        // `pricing` follows the resolved mode: UOM → RATE{rate,rateUnit}; else
        // PACK{purchasePrice}. The pack FORMAT only changes when the user
        // consented to adopt the invoice's format (useInvoicePack).
        const newPricing = rawPriceType === 'UOM'
          ? { mode: 'RATE', rate: newPurchasePrice, rateUnit: resolvedRateUnit }
          : { mode: 'PACK', purchasePrice: newPurchasePrice }
        const itemTopUnit = (item.packChain as PackLink[] | null)?.[0]?.unit
        const formatChain = useInvoicePack
          ? formToChain({
              purchaseUnit:       itemTopUnit ?? scanItem.rawUnit ?? 'case',
              purchasePrice:      newPurchasePrice,
              qtyPerPurchaseUnit: packQty,
              qtyUOM:             'each', // invoice-format pack is expressed via packSize/packUOM
              innerQty:           null,
              packSize,
              packUOM,
              priceType:          rawPriceType,
              countUOM:           item.countUnit ?? 'each',
            })
          : null

        // ── Upsert this supplier's offer (its own chain + price) ─────────────
        // >>> PASTE THE EXISTING OFFER-UPSERT BLOCK HERE UNCHANGED <<<
        // Move the current `if (offerSupplierName) { ... prisma.inventorySupplierPrice.upsert(...) ... }`
        // block (today's lines ~310-402, which builds `offerChain` and upserts the
        // offer with isPrimary:false on create) to this exact spot, verbatim.

        // ── Primary-offer authority ─────────────────────────────────────────
        // Bootstrap: the item's FIRST offer becomes primary. The item's $ spine is
        // the PRIMARY offer's value and the primary is a sticky MANUAL choice — a
        // non-primary supplier's invoice records its offer but never re-prices the
        // item. Re-price only when this line's supplier is the primary, OR when the
        // invoice had no resolvable supplier (no offer to derive from → legacy
        // direct write so the spine still updates).
        let shouldReprice = true
        if (offerSupplierName) {
          await ensurePrimary(scanItem.matchedItemId)
          const primary = await prisma.inventorySupplierPrice.findFirst({
            where: { inventoryItemId: scanItem.matchedItemId, isPrimary: true },
            select: { supplierName: true },
          })
          shouldReprice = primary?.supplierName === offerSupplierName
        }

        // ── Write the item spine (only when re-pricing) + mark approved ──────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const itemOps: any[] = [
          prisma.invoiceScanItem.update({ where: { id: scanItem.id }, data: { approved: true } }),
        ]
        if (shouldReprice) {
          itemOps.unshift(
            prisma.inventoryItem.update({
              where: { id: scanItem.matchedItemId },
              data: {
                purchasePrice: newPurchasePrice,
                lastUpdated:   new Date(),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                pricing: newPricing as any,
                ...(formatChain
                  ? {
                      dimension: formatChain.dimension,
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      packChain: formatChain.packChain as any,
                      countUnit: formatChain.countUnit,
                    }
                  : {}),
              },
            }),
          )
          if (prevPrice > 0 && Math.abs(changePct) >= 15) {
            itemOps.push(
              prisma.priceAlert.create({
                data: {
                  sessionId,
                  inventoryItemId: scanItem.matchedItemId,
                  previousPrice:   prevPrice,
                  newPrice:        newPurchasePrice,
                  changePct,
                  direction:       changePct > 0 ? 'UP' : 'DOWN',
                },
              }),
            )
            priceAlertsCreated++
          }
        }

        await prisma.$transaction(itemOps)
        if (shouldReprice) updatedItemIds.push(scanItem.matchedItemId)
        registerAlloc(scanItem.matchedItemId, scanItem.revenueCenterId)
```

- [ ] **Step 3: Delete the now-duplicated original blocks**

After the paste, the original (now-relocated) item-write `itemOps`, PriceAlert push, `await prisma.$transaction(itemOps)`, `updatedItemIds.push`, and `registerAlloc` that lived BEFORE the offer upsert must be gone (they were inside the region you replaced in Step 2). Confirm there is exactly **one** `const itemOps`, one `await prisma.$transaction(itemOps)`, and one `registerAlloc(...)` per loop iteration. The `prevPrice`/`changePct` `const` declarations (~lines 223-224, just above the replaced region) stay — they are read by the new block.

- [ ] **Step 4: Typecheck + lint**

Run: `npm run build`
Expected: PASS with no "`formatChain` is declared but never read" or "duplicate identifier `itemOps`" errors. `priceAlertsCreated` is already declared before the loop (it was incremented inside the loop originally) — confirm a single declaration remains.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/invoices/sessions/[id]/approve/route.ts
git commit -m "feat(pricing): invoice approve re-prices item only for the primary supplier"
```

---

## Task 4: Manual inventory edit mirrors item → primary offer

**Files:**
- Modify: `src/app/api/inventory/[id]/route.ts` (`postUpdate`, ~lines 84-103)

After a manual chain/price edit, keep the item == primary offer invariant by mirroring the item onto its primary offer (if any).

- [ ] **Step 1: Add import**

After the existing `import { syncPrepToInventory, propagatePrepCostChanges } from '@/lib/recipeCosts'` line, add:

```typescript
import { mirrorItemToPrimaryOffer } from '@/lib/primary-offer'
```

- [ ] **Step 2: Mirror before propagating costs**

In `postUpdate`, immediately AFTER the `if (linkedRecipe) { await syncPrepToInventory(linkedRecipe.id) }` block and BEFORE the `await propagatePrepCostChanges([id])` call, insert:

```typescript
  // A manual edit to an item that has supplier offers also updates its PRIMARY
  // offer, so the offer table doesn't silently disagree with the item spine.
  // No-op when the item has no primary offer (PREP-linked / manual-only items).
  await mirrorItemToPrimaryOffer(id)
```

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/inventory/[id]/route.ts
git commit -m "feat(pricing): manual item edit mirrors onto the primary offer"
```

---

## Task 5: Backfill script — dedupe primaries + sync spines

**Files:**
- Create: `scripts/backfill-primary-offers.ts`

- [ ] **Step 1: Write the script**

```typescript
// scripts/backfill-primary-offers.ts
// Establishes the primary-offer invariant on existing data. Idempotent.
// For each item WITH offers: ensure exactly one primary (most-recently-updated
// wins where none is set), then sync the item spine from it. Logs every item
// whose ppb CHANGED (its item.pricing had drifted from the primary offer) and
// a total-valuation conservation summary.
//
// Dry:   TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-primary-offers.ts
// Apply: APPLY=1 TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-primary-offers.ts

import { prisma } from '../src/lib/prisma'
import { asChainItem, pricePerBaseUnit } from '../src/lib/item-model'
import { ensurePrimary, syncPrimaryOfferToItem } from '../src/lib/primary-offer'

const APPLY = process.env.APPLY === '1'
const money = (n: number) => `$${n.toFixed(2)}`

async function main() {
  const itemIds = (await prisma.inventorySupplierPrice.findMany({
    select: { inventoryItemId: true },
    distinct: ['inventoryItemId'],
  })).map((r) => r.inventoryItemId)

  let changed = 0
  let valueBefore = 0
  let valueAfter = 0

  for (const id of itemIds) {
    const before = await prisma.inventoryItem.findUnique({
      where: { id },
      select: { itemName: true, dimension: true, baseUnit: true, packChain: true, pricing: true, countUnit: true, stockOnHand: true },
    })
    if (!before) continue
    const oldPpb = pricePerBaseUnit(asChainItem(before))
    const stock = Number(before.stockOnHand || 0)

    if (APPLY) {
      await ensurePrimary(id)
      const sync = await syncPrimaryOfferToItem(id)
      valueBefore += stock * sync.oldPpb
      valueAfter += stock * sync.newPpb
      if (sync.changed) {
        changed++
        console.log(`[CHANGED] ${before.itemName.padEnd(32)} ppb ${oldPpb.toFixed(5)} → ${sync.newPpb.toFixed(5)}`)
      }
    } else {
      // Dry run: report which items WOULD change without writing.
      const primary = await prisma.inventorySupplierPrice.findFirst({
        where: { inventoryItemId: id, isPrimary: true },
        select: { packChain: true, pricing: true },
      })
      const offerExists = await prisma.inventorySupplierPrice.count({ where: { inventoryItemId: id } })
      const eff = primary ?? await prisma.inventorySupplierPrice.findFirst({
        where: { inventoryItemId: id },
        orderBy: { lastUpdated: 'desc' },
        select: { packChain: true, pricing: true },
      })
      let newPpb = oldPpb
      if (eff && Array.isArray(eff.packChain) && eff.pricing) {
        const cand = pricePerBaseUnit({
          dimension: before.dimension as 'MASS' | 'VOLUME' | 'COUNT',
          baseUnit: before.baseUnit,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          packChain: eff.packChain as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pricing: eff.pricing as any,
        })
        if (Number.isFinite(cand) && cand > 0) newPpb = cand
      }
      valueBefore += stock * oldPpb
      valueAfter += stock * newPpb
      if (Math.abs(newPpb - oldPpb) > 1e-9) {
        changed++
        console.log(`[would change] ${before.itemName.padEnd(32)} ppb ${oldPpb.toFixed(5)} → ${newPpb.toFixed(5)} (offers=${offerExists})`)
      }
    }
  }

  console.log('\n──────── summary ────────')
  console.log(`items with offers:  ${itemIds.length}`)
  console.log(`spine ppb changed:  ${changed}`)
  console.log(`valuation:          ${money(valueBefore)} → ${money(valueAfter)}  (Δ ${money(valueAfter - valueBefore)})`)
  console.log(APPLY ? '\nAPPLIED.' : '\nDRY RUN — pass APPLY=1 to write.')
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS (scripts are type-checked by the build).

- [ ] **Step 3: Dry run against the live DB**

Run: `TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-primary-offers.ts`
Expected: prints a `[would change]` line per drifted item and a conservation summary, ending `DRY RUN`. Read the changed-items list — these are the items whose stored `item.pricing` disagreed with their primary offer.

- [ ] **Step 4: Commit (do not APPLY yet — the index task gates it)**

```bash
git add scripts/backfill-primary-offers.ts
git commit -m "feat(pricing): backfill script for the primary-offer invariant"
```

---

## Task 6: Add the partial unique index (DB-level invariant)

**Files:**
- Create: `scripts/add-primary-offer-index.ts`
- Create: `prisma/migrations/20260618120000_primary_offer_index/migration.sql`

The direct DB host is unreachable, so DDL goes over the pooler via `$executeRawUnsafe` (see memory: item-model redesign). The index must be created AFTER Task 5's backfill has deduped primaries, or `CREATE UNIQUE INDEX` fails on any item with two primaries. Prisma's schema language cannot express a partial (`WHERE`) unique index, so it lives only in raw SQL — `schema.prisma` is left unchanged.

- [ ] **Step 1: Write the migration SQL (for the record)**

```sql
-- prisma/migrations/20260618120000_primary_offer_index/migration.sql
-- Enforce: at most one primary offer per inventory item.
-- Applied over the pooler via scripts/add-primary-offer-index.ts ($executeRawUnsafe);
-- Prisma cannot model a partial unique index, so this is not reflected in schema.prisma.
CREATE UNIQUE INDEX IF NOT EXISTS "InventorySupplierPrice_one_primary_per_item"
  ON "InventorySupplierPrice" ("inventoryItemId")
  WHERE "isPrimary";
```

- [ ] **Step 2: Write the apply script**

```typescript
// scripts/add-primary-offer-index.ts
// Creates the partial unique index enforcing one primary offer per item, over
// the pgBouncer pooler. Idempotent (IF NOT EXISTS). Run AFTER backfill dedupes
// primaries, else it errors on rows with two primaries.
//
// Run: TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/add-primary-offer-index.ts

import { prisma } from '../src/lib/prisma'

async function main() {
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "InventorySupplierPrice_one_primary_per_item" ` +
    `ON "InventorySupplierPrice" ("inventoryItemId") WHERE "isPrimary";`
  )
  console.log('Created partial unique index InventorySupplierPrice_one_primary_per_item.')
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
```

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/add-primary-offer-index.ts prisma/migrations/20260618120000_primary_offer_index/migration.sql
git commit -m "feat(pricing): partial unique index for one primary offer per item"
```

---

## Task 7: Verify script

**Files:**
- Create: `scripts/verify-primary-offers.ts`

- [ ] **Step 1: Write the script**

```typescript
// scripts/verify-primary-offers.ts
// Read-only. Asserts the primary-offer invariant across all items:
//   1. every item WITH offers has exactly one primary
//   2. item headline ppb == its primary offer's computed ppb (≤0.5% tolerance)
// Exits non-zero if any assertion fails.
//
// Run: TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/verify-primary-offers.ts

import { prisma } from '../src/lib/prisma'
import { asChainItem, pricePerBaseUnit } from '../src/lib/item-model'
import { offerPricePerBase } from '../src/lib/supplier-offers'

async function main() {
  const itemIds = (await prisma.inventorySupplierPrice.findMany({
    select: { inventoryItemId: true },
    distinct: ['inventoryItemId'],
  })).map((r) => r.inventoryItemId)

  let badPrimaryCount = 0
  let ppbMismatch = 0

  for (const id of itemIds) {
    const offers = await prisma.inventorySupplierPrice.findMany({
      where: { inventoryItemId: id },
      select: { id: true, isPrimary: true, packChain: true, pricing: true, pricePerBaseUnit: true },
    })
    const primaries = offers.filter((o) => o.isPrimary)
    if (primaries.length !== 1) {
      badPrimaryCount++
      console.error(`[FAIL primary] item ${id}: ${primaries.length} primaries (expected 1)`)
      continue
    }
    const item = await prisma.inventoryItem.findUnique({
      where: { id },
      select: { itemName: true, dimension: true, baseUnit: true, packChain: true, pricing: true, countUnit: true },
    })
    if (!item) continue
    const itemPpb = pricePerBaseUnit(asChainItem(item))
    const offerPpb = offerPricePerBase(primaries[0])
    const rel = offerPpb > 0 ? Math.abs(itemPpb - offerPpb) / offerPpb : (itemPpb === 0 ? 0 : 1)
    if (rel > 0.005) {
      ppbMismatch++
      console.error(`[FAIL ppb] ${item.itemName}: item ${itemPpb.toFixed(5)} vs primary offer ${offerPpb.toFixed(5)} (${(rel * 100).toFixed(1)}%)`)
    }
  }

  console.log('\n──────── verify ────────')
  console.log(`items with offers:        ${itemIds.length}`)
  console.log(`wrong primary count:      ${badPrimaryCount}`)
  console.log(`ppb mismatch (>0.5%):     ${ppbMismatch}`)
  const ok = badPrimaryCount === 0 && ppbMismatch === 0
  console.log(ok ? '\nINVARIANT HOLDS ✓' : '\nINVARIANT VIOLATED ✗')
  if (!ok) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-primary-offers.ts
git commit -m "test(pricing): verify the primary-offer invariant"
```

---

## Task 8: Run the migration sequence against the live DB

This is the cutover. Order matters: backfill (dedupe) → index → verify.

- [ ] **Step 1: Apply the backfill**

Run: `APPLY=1 TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-primary-offers.ts`
Expected: ends `APPLIED.` with a `spine ppb changed` count matching the dry run, and a small valuation Δ. A large Δ means many items had drifted — review the `[CHANGED]` list before continuing.

- [ ] **Step 2: Create the index**

Run: `TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/add-primary-offer-index.ts`
Expected: `Created partial unique index...`. If it errors with a uniqueness violation, an item still has two primaries — re-run Step 1, then retry.

- [ ] **Step 3: Verify**

Run: `TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/verify-primary-offers.ts`
Expected: `INVARIANT HOLDS ✓` and exit 0.

- [ ] **Step 4: Mark the migration applied in history**

Run (matches the project's documented `migrate resolve` workaround for the broken shadow DB):
`npx prisma migrate resolve --applied 20260618120000_primary_offer_index`
Expected: `Migration ... marked as applied.`

---

## Task 9: Manual end-to-end verification

- [ ] **Step 1: Start the dev server** (preview_start, per project memory — node not on sandbox PATH).

- [ ] **Step 2: Non-primary supplier does NOT re-price.** Pick an item with ≥2 offers. Note its primary and its displayed `pricePerBaseUnit`. Approve an invoice for a NON-primary supplier of that item at a clearly different price. Expected: the item's headline ppb and the cost-chrome strip are UNCHANGED; the non-primary offer's row in the inventory drawer shows the new price; no PriceAlert for that item.

- [ ] **Step 3: Switching primary re-prices.** In the inventory drawer's supplier offers section, click the star on a different (e.g. cheapest) offer. Expected: `ok:true, repriced:true`; the item's headline ppb changes to that offer's ppb; a dependent recipe's cost reflects the change (open the recipe / reports).

- [ ] **Step 4: Primary supplier's invoice re-prices.** Approve an invoice for the item's CURRENT primary supplier at a new price. Expected: the item re-prices; a PriceAlert fires if the change ≥15%.

- [ ] **Step 5: Final build.** Run: `npm run build` — Expected: PASS, all API routes show `ƒ (Dynamic)`.

---

## Task 10: Offers UI — nudge + live headline refresh

**Files:**
- Modify: `src/components/inventory/SupplierOffersSection.tsx`

The section already highlights the cheapest offer and has a set-primary star. Add: (1) a "cheaper supplier available" nudge when the primary isn't the cheapest, (2) a callback so the parent drawer's headline price refreshes after a reprice.

- [ ] **Step 1: Add the optional callback prop**

Change the component signature (line ~33) to:

```typescript
export function SupplierOffersSection({ itemId, baseUnit, onRepriced }: { itemId: string; baseUnit: string | null; onRepriced?: () => void }) {
```

- [ ] **Step 2: Fire the callback after a reprice**

Replace `setPrimary` (lines ~46-55) with:

```typescript
  const setPrimary = async (offerId: string) => {
    setSaving(true)
    const res = await fetch(`/api/inventory/${itemId}/suppliers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offerId }),
    }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    setSaving(false)
    load()
    if (res?.repriced) onRepriced?.()
  }
```

- [ ] **Step 3: Compute the nudge condition**

Immediately after `const cheapest = Math.min(...offers.map(o => o.pricePerBaseUnit).filter(p => p > 0))` (line ~58), add:

```typescript
  const primaryOffer = offers.find(o => o.isPrimary)
  const cheaperThanPrimary =
    !!primaryOffer && Number.isFinite(cheapest) && primaryOffer.pricePerBaseUnit > cheapest
```

- [ ] **Step 4: Render the nudge**

Immediately after the closing `</div>` of the offers list box (the `</div>` that closes `<div className="border border-line rounded-lg ...">`, line ~100) and before the component's final `</div>`, add:

```tsx
      {cheaperThanPrimary && (
        <div className="font-mono text-[10.5px] text-gold-2">
          Cheaper supplier available — {fmtPpb(cheapest, baseUnit)} vs primary {fmtPpb(primaryOffer!.pricePerBaseUnit, baseUnit)}.
        </div>
      )}
```

- [ ] **Step 5: Wire the parent (optional, if a live refresh exists)**

Search for the `<SupplierOffersSection` usage:

Run: `grep -rn "SupplierOffersSection" src/components src/app`

If the containing drawer has an item-refetch function (e.g. `loadItem`/`refresh`), pass it: `onRepriced={loadItem}`. If there is none, omit the prop — the offers list still updates in place and the headline refreshes when the drawer is reopened.

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/inventory/SupplierOffersSection.tsx
git commit -m "feat(pricing): cheaper-supplier nudge + headline refresh on reprice"
```

---

## Notes for the implementer

- **Decimal-as-string:** Prisma `Decimal`/JSON fields come back as strings — `asChainItem`/`Number()` already coerce; never call `.toFixed()` on a raw field.
- **No interactive transactions over the pooler for the helpers:** `primary-offer.ts` helpers default to the top-level `prisma` client and run queries sequentially. The partial unique index is the real guard against duplicate primaries; the brief non-atomic window in `ensurePrimary`/`setPrimaryOffer` self-heals (a missing primary is fixed on the next `ensurePrimary`).
- **PREP / manual / non-stocked items have no offers** — every helper is a no-op for them, so their `item.pricing` (from `syncPrepToInventory` / manual edit) is never disturbed.
- **`item.dimension` and `item.baseUnit` never change with supplier** — only `packChain`/`pricing`/`countUnit`/`purchasePrice` are synced from the primary offer.
