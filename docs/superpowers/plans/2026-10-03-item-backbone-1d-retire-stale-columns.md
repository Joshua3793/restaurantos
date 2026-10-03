# Item backbone — Stage 1d: retire the stale copies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No screen or route reads or writes the five stale copies — `InventoryItem.purchasePrice`, `InventoryItem.supplierId`, `InventoryItem.location`, `InventoryItem.needsReview`, `InventorySupplierPrice.lastPrice` — and the number they used to hold is derived from the supplier boxes instead. The columns themselves stay in the schema until a separate drop PR (Stage 1e) one week after this ships.

**Architecture:** Two pure derivations replace the copies: `listedPrice(row)` (exists, Stage 1a) for an item's headline price and a new `offerListedPrice(offer)` for a box's; the item's **supplier is its primary box's supplier** (`PRIMARY_SUPPLIER_INCLUDE` + `withSupplier(row)` keep the `supplier`/`supplierId` shape every page already renders). A dry-run-by-default backfill gives the 76 items that carry a supplier but no box a box built from their own chain and price (same numbers), and copies a single-valued legacy `location` into `storageAreaId` where that is empty. Readers switch to the derivations; writers stop writing the columns; a gate test keeps them out. A legacy unauthenticated price route is deleted.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma, vitest, `npm run build`.

**Spec:** `docs/superpowers/specs/2026-10-03-item-backbone-design.md` §2.3. Stages 1a (#154), 1b (#155), 1c (#156) are merged; main = `bef8318`.

## Global Constraints

- Branch off `origin/main` (= `bef8318`). Worktree `.claude/worktrees/retire-stale-columns`, branch `worktree-retire-stale-columns`, pushed as `feat/retire-stale-columns`. One PR, squash-merged. **No migration in this PR** — the columns stay; Stage 1e drops them.
- `node`/`npm` are not on the sandbox PATH: prefix every command with `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" &&` (Bash `dangerouslyDisableSandbox: true`). `node_modules`/`.env` are symlinks; `.env` is the LIVE database.
- **Live facts (2026-10-03, read-only stats):** 468 active items; 224 carry `supplierId`; **76** carry a supplier but have no box (25 of them have approved invoice lines, 51 never); **68** have a box but no `supplierId`; **17** have a `supplierId` that differs from their primary box's supplier (e.g. Free Run Eggs: item says Sysco, primary box is Legends Haul) — the primary box wins; `needsReview` is true on 0 rows; `location` is set on 249 rows, mostly equal to a storage-area name, 44 of them on items with no `storageAreaId`; `lastPrice` differs from the box's own `pricing` on 14 of 266 rows, all by float noise (81.18000000000001 vs 81.18). If the Task 2 dry run prints materially different numbers, stop and report.
- **No price number changes.** The headline price every screen shows must equal `listedPrice(item)` (PACK → box price, RATE → the rate), which is what the column held. A box's shown price = `offerListedPrice(offer)`.
- API response shapes stay backward compatible: `item.supplier`, `item.supplierId`, `item.purchasePrice`, `offer.lastPrice` keep appearing where they did, now **computed** (like `pricePerBaseUnit`). The redaction key lists keep covering them.
- Prisma `Decimal` values arrive as strings — `Number()` before arithmetic. `Decimal` columns being left in place must still be written by nothing: the create paths must not pass `purchasePrice` (its default is 0).
- Tests: `npm test` green; `npm run build` green; lint findings identical to `main` (20 pre-existing files).

---

### Task 1: The derivations — `offerListedPrice`, `PRIMARY_SUPPLIER_INCLUDE`, `withSupplier`

**Files:**
- Modify: `src/lib/offer-price.ts` (append)
- Create: `src/lib/item-supplier.ts`
- Test: `src/lib/__tests__/offer-price.test.ts` (append), `src/lib/__tests__/item-supplier.test.ts`

**Interfaces (every later task uses these exact names):**
```ts
// src/lib/offer-price.ts (pure, client-safe)
export function offerListedPrice(offer: { pricing?: unknown }): number   // PACK → purchasePrice, RATE → rate, else 0
// src/lib/item-supplier.ts (pure types + a Prisma include fragment; no prisma import)
export const PRIMARY_SUPPLIER_INCLUDE = { supplierPrices: { where: { isPrimary: true }, select: { supplierId: true, supplier: { select: { id: true, name: true } } }, take: 1 } } as const
export interface PrimarySupplierRow { supplierPrices?: Array<{ supplierId: string; supplier: { id: string; name: string } }> | null }
export function withSupplier<T extends PrimarySupplierRow>(row: T): Omit<T, 'supplierPrices'> & { supplier: { id: string; name: string } | null; supplierId: string | null }
```

- [ ] **Step 1: Failing tests**

Append to `src/lib/__tests__/offer-price.test.ts`:
```ts
describe('offerListedPrice — the number the legacy lastPrice column held', () => {
  it('PACK: the box price', () => expect(offerListedPrice({ pricing: { mode: 'PACK', purchasePrice: 81.18 } })).toBe(81.18))
  it('RATE: the rate itself', () => expect(offerListedPrice({ pricing: { mode: 'RATE', rate: 28.6, rateUnit: 'kg' } })).toBe(28.6))
  it('no pricing → 0', () => expect(offerListedPrice({ pricing: null })).toBe(0))
})
```
(add `offerListedPrice` to that file's import from `@/lib/offer-price`.)

`src/lib/__tests__/item-supplier.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { withSupplier, PRIMARY_SUPPLIER_INCLUDE } from '@/lib/item-supplier'

describe('withSupplier — an item\'s supplier is its primary box\'s supplier', () => {
  it('maps the primary box to supplier/supplierId and drops supplierPrices', () => {
    const row = { id: 'i1', itemName: 'Free Run Eggs', supplierPrices: [{ supplierId: 's2', supplier: { id: 's2', name: 'Legends Haul' } }] }
    expect(withSupplier(row)).toEqual({ id: 'i1', itemName: 'Free Run Eggs', supplier: { id: 's2', name: 'Legends Haul' }, supplierId: 's2' })
  })
  it('no box → null supplier', () => {
    expect(withSupplier({ id: 'i1', supplierPrices: [] })).toEqual({ id: 'i1', supplier: null, supplierId: null })
  })
  it('the include asks for the primary box only', () => {
    expect(PRIMARY_SUPPLIER_INCLUDE.supplierPrices.where).toEqual({ isPrimary: true })
    expect(PRIMARY_SUPPLIER_INCLUDE.supplierPrices.take).toBe(1)
  })
})
```

- [ ] **Step 2: Run — fail**

Run: `npx vitest run src/lib/__tests__/offer-price.test.ts src/lib/__tests__/item-supplier.test.ts`
Expected: FAIL (missing exports / module).

- [ ] **Step 3: Implement**

Append to `src/lib/offer-price.ts`:
```ts
/**
 * The price a supplier box lists, in its pricing's own mode: the box price for
 * PACK, the rate itself for RATE. This is the number the legacy `lastPrice`
 * column held (it only ever differed by float noise); derive it, never store it.
 */
export function offerListedPrice(offer: { pricing?: unknown }): number {
  const p = offer.pricing as { mode?: string; purchasePrice?: unknown; rate?: unknown } | null | undefined
  if (!p) return 0
  return p.mode === 'RATE' ? Number(p.rate || 0) : Number(p.purchasePrice || 0)
}
```

`src/lib/item-supplier.ts`:
```ts
// An item's supplier IS its primary supplier box's supplier (spec §2.3). The
// legacy `InventoryItem.supplierId` column drifted from the primary on 17 live
// items and was missing on 68 that had a box; it is no longer read or written.
// Spread PRIMARY_SUPPLIER_INCLUDE into a select/include, then withSupplier(row)
// to keep the `supplier` / `supplierId` shape every page already renders.
export const PRIMARY_SUPPLIER_INCLUDE = {
  supplierPrices: {
    where: { isPrimary: true },
    select: { supplierId: true, supplier: { select: { id: true, name: true } } },
    take: 1,
  },
} as const

export interface PrimarySupplierRow {
  supplierPrices?: Array<{ supplierId: string; supplier: { id: string; name: string } }> | null
}

export function withSupplier<T extends PrimarySupplierRow>(
  row: T,
): Omit<T, 'supplierPrices'> & { supplier: { id: string; name: string } | null; supplierId: string | null } {
  const { supplierPrices, ...rest } = row
  const primary = supplierPrices?.[0] ?? null
  return { ...rest, supplier: primary?.supplier ?? null, supplierId: primary?.supplierId ?? null }
}
```

- [ ] **Step 4: Run — pass; commit**

```bash
git add src/lib/offer-price.ts src/lib/item-supplier.ts src/lib/__tests__/offer-price.test.ts src/lib/__tests__/item-supplier.test.ts
git commit -m "feat(items): derive a box's listed price and an item's supplier from the primary box"
```

---

### Task 2: Backfill — every item with a supplier gets a box; single-valued locations become storage areas

**Files:**
- Create: `scripts/backfill-item-supplier-boxes.ts`

**Interfaces:**
- Produces, on `--apply`: for each active item with `supplierId` set and NO offer → one `InventorySupplierPrice` row `{ inventoryItemId, supplierId, supplierName: Supplier.name, isPrimary: true, lastPrice: listedPrice(item), packChain: item.packChain, pricing: item.pricing, packQty/packSize/packUOM: null, supplierItemCode: null }`; for each active item with `storageAreaId` null and `location` equal (case-blind, trimmed) to exactly one `StorageArea.name` → `storageAreaId` set. Prints the 17 supplier≠primary items as information (no write). Backup JSON `item-supplier-boxes-backup-<ISO>.json` at the repo root before any write.

- [ ] **Step 1: Write the script**

```ts
// Before the item's own `supplierId` column is retired, every item that names a
// supplier gets a supplier BOX from its own chain + price (same numbers, nothing
// re-priced), so the derived supplier (primary box) equals what the item showed.
//   DRY RUN (default):  npx tsx scripts/backfill-item-supplier-boxes.ts
//   APPLY:              npx tsx scripts/backfill-item-supplier-boxes.ts --apply
// Also copies a single-valued legacy `location` onto an empty storageAreaId.
import fs from 'fs'
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT } from '../src/lib/item-model'
import { listedPrice } from '../src/lib/cost-basis'

const APPLY = process.argv.includes('--apply')

async function main() {
  const areas = await prisma.storageArea.findMany({ select: { id: true, name: true } })
  const areaByName = new Map(areas.map(a => [a.name.trim().toLowerCase(), a.id]))

  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true, itemName: true, supplierId: true, storageAreaId: true, location: true, ...PRICING_SELECT,
      supplier: { select: { id: true, name: true } },
      supplierPrices: { select: { id: true, supplierId: true, isPrimary: true } },
    },
  })

  const boxes: { itemId: string; label: string; data: Record<string, unknown> }[] = []
  const areasToSet: { itemId: string; label: string; storageAreaId: string }[] = []
  const differs: string[] = []

  for (const it of items) {
    if (it.supplierId && it.supplier && it.supplierPrices.length === 0) {
      const price = listedPrice(it)
      boxes.push({
        itemId: it.id,
        label: `${it.itemName}: box for ${it.supplier.name} at ${price.toFixed(2)} (${(it.pricing as { mode?: string })?.mode ?? 'PACK'})`,
        data: {
          inventoryItemId: it.id, supplierId: it.supplierId, supplierName: it.supplier.name,
          isPrimary: true, lastPrice: price, packChain: it.packChain as object, pricing: it.pricing as object,
          packQty: null, packSize: null, packUOM: null, supplierItemCode: null,
        },
      })
    }
    const primary = it.supplierPrices.find(o => o.isPrimary)
    if (it.supplierId && primary && primary.supplierId !== it.supplierId) differs.push(`${it.itemName}: item says ${it.supplier?.name}, primary box is another supplier — the box wins`)
    if (!it.storageAreaId && it.location) {
      const id = areaByName.get(it.location.trim().toLowerCase())
      if (id) areasToSet.push({ itemId: it.id, label: `${it.itemName}: location "${it.location}" → storage area`, storageAreaId: id })
    }
  }

  console.log(`Supplier boxes to create: ${boxes.length}`)
  for (const b of boxes) console.log(`  ${APPLY ? 'APPLY' : 'DRY  '} ${b.label}`)
  console.log(`Storage areas to set from a single-valued location: ${areasToSet.length}`)
  for (const a of areasToSet) console.log(`  ${APPLY ? 'APPLY' : 'DRY  '} ${a.label}`)
  console.log(`Items whose own supplier differs from their primary box (information only, no write): ${differs.length}`)
  for (const d of differs) console.log(`  ${d}`)
  if (!APPLY || (boxes.length === 0 && areasToSet.length === 0)) { console.log(APPLY ? 'nothing to write' : 're-run with --apply to write'); return }

  const backup = `item-supplier-boxes-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  fs.writeFileSync(backup, JSON.stringify({ boxes, areasToSet }, null, 2))
  console.log(`backup written: ${backup}`)
  await prisma.$transaction([
    ...boxes.map(b => prisma.inventorySupplierPrice.create({ data: b.data as Parameters<typeof prisma.inventorySupplierPrice.create>[0]['data'] })),
    ...areasToSet.map(a => prisma.inventoryItem.update({ where: { id: a.itemId }, data: { storageAreaId: a.storageAreaId } })),
  ])
  console.log(`${boxes.length} box(es) created, ${areasToSet.length} storage area(s) set`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Dry run (live, read-only)**

Run: `npx tsx scripts/backfill-item-supplier-boxes.ts`
Expected: `Supplier boxes to create: 76`, a storage-area count ≤ 44, `… differs …: 17`. Record the full output in the report — the owner reads it as the Before/After. Materially different counts → stop and report.

- [ ] **Step 3: Apply (owner-approved live write)**

Run: `npx tsx scripts/backfill-item-supplier-boxes.ts --apply` → backup written, `76 box(es) created, N storage area(s) set`. Re-run the dry run: `Supplier boxes to create: 0`.

- [ ] **Step 4: Commit the script (backup JSON stays untracked)**

```bash
git add scripts/backfill-item-supplier-boxes.ts
git commit -m "chore(items): every item that names a supplier gets a box from its own price (dry-run by default)"
```

---

### Task 3: Readers — the item's supplier comes from its primary box

**Files:**
- Modify: `src/lib/inventory-list.ts` (`itemInclude` ~186; the `supplierId` filter ~172; row mapping where `supplier` is read)
- Modify: `src/app/api/inventory/[id]/route.ts` (GET include ~30; PUT's returned `include` ~226)
- Modify: `src/app/api/inventory/route.ts` (POST's returned `include` ~104)
- Modify: `src/app/api/inventory/export/route.ts` (select ~33; the `supplierId` filter ~121–131 and both row mappings ~84, ~265)
- Modify: `src/app/api/chat/route.ts` (select ~63–67)
- Modify: `src/app/api/reports/analytics/route.ts` (selects ~224, ~234; `i.supplier?.name` reads)
- Modify: `src/app/api/eod/orders/route.ts` (`itemInclude` ~47–51; grouping ~185–186)
- Modify: `src/app/api/search/route.ts` (inventory `where` ~46, select ~52)
- Modify: `src/app/inventory/page.tsx` (nothing to change if the API keeps `supplier`/`supplierId` — verify)
- Tests: `src/app/api/inventory/__tests__/money-and-edit-gates.test.ts` (its ITEM fixture gets `supplierPrices: [...]` so `withSupplier` yields the same `supplier`)

**Rule:** wherever a Prisma select/include has `supplier: true` or `supplier: { select: { name: true } }` or `supplierId: true` on an **InventoryItem**, replace with `...PRIMARY_SUPPLIER_INCLUDE` and wrap the row with `withSupplier(row)` before it is used or returned. Wherever a `where` filters `{ supplierId }` on an InventoryItem, use `{ supplierPrices: { some: { supplierId } } }` ("items this supplier sells"). Wherever a `where` searches `supplier: { name: contains }` on an InventoryItem, use `supplierPrices: { some: { supplier: { name: contains } } }`.

- [ ] **Step 1: Failing test**

In `money-and-edit-gates.test.ts`, change `ITEM.supplier: { id: 's1', name: 'Gordon' }` to `supplierPrices: [{ supplierId: 's1', supplier: { id: 's1', name: 'Gordon' } }]` and add an assertion in the LEAD/MANAGER GET test: `expect(body.supplier).toEqual({ id: 's1', name: 'Gordon' }); expect(body.supplierId).toBe('s1')`.

Run: `npx vitest run src/app/api/inventory/__tests__/money-and-edit-gates.test.ts` → FAIL (`supplier` undefined).

- [ ] **Step 2: Implement per the rule, file by file**

- `inventory-list.ts`: `itemInclude = { ...PRIMARY_SUPPLIER_INCLUDE, storageArea: true, recipe: {...} }`; every place a row is pushed into the result, pass it through `withSupplier(...)` first; the filter line becomes `supplierId ? { supplierPrices: { some: { supplierId } } } : {}`; update the header comment that lists ride-along fields.
- `[id]/route.ts` GET: `include: { ...PRIMARY_SUPPLIER_INCLUDE, storageArea: true, … }` and `const body = { ...withLastCost(withSupplier(item)), costBasis }`; PUT's final `include` likewise + `withSupplier` on the returned row.
- `inventory/route.ts` POST: returned row `withLastCost(withSupplier(item))` with the include swapped.
- `export/route.ts`: select → `...PRIMARY_SUPPLIER_INCLUDE`; rows via `withSupplier`; the `supplierId` filter name lookup stays (it reads `Supplier` by id) but the list fetch already applies the new filter through `fetchInventoryList`.
- `chat/route.ts`: select → drop `supplierId: true, supplier: {...}`, add `...PRIMARY_SUPPLIER_INCLUDE`; map with `withSupplier`.
- `analytics/route.ts`: both selects → `...PRIMARY_SUPPLIER_INCLUDE`; `withSupplier` before `.supplier?.name`.
- `eod/orders/route.ts`: `itemInclude` → replace `supplier`/`supplierId` with `...PRIMARY_SUPPLIER_INCLUDE`; after loading rows apply `withSupplier`; grouping unchanged (`row.supplierId ?? '__none__'`).
- `search/route.ts`: `where` OR entry → `{ supplierPrices: { some: { supplier: { name: contains } } } }`; select → `...PRIMARY_SUPPLIER_INCLUDE`; map `withLastCost(withSupplier(i))`.

- [ ] **Step 3: Build + the test**

Run: `npx vitest run src/app/api/inventory/__tests__/money-and-edit-gates.test.ts` → PASS. `npm run build` → green (type errors here point at a reader you missed — fix it the same way).

- [ ] **Step 4: Commit**

```bash
git add src
git commit -m "refactor(items): an item's supplier is its primary box's supplier — every reader derives it"
```

---

### Task 4: Writers stop writing the stale copies; the legacy price route goes

**Files:**
- Modify: `src/app/api/inventory/route.ts` (POST: no `supplierId`/`location`/`purchasePrice` on the item; a chosen supplier becomes a box)
- Modify: `src/app/api/inventory/[id]/route.ts` (PUT: strip `supplierId`, `location`, `purchasePrice`, `needsReview`; no `needsReview: false` write)
- Modify: `src/app/api/inventory/bulk/route.ts` (remove the `setSupplier` action) and `src/app/inventory/page.tsx` (remove that bulk option; remove the `location` input + field from the add form; remove the `needsReview` filter + banner)
- Modify: `src/app/count/page.tsx` (add-item form: remove the `location` input/field; `supplierId` still sent — POST turns it into a box)
- Modify: `src/components/inventory/InventoryItemDrawer.tsx` (edit mode: the Supplier combobox becomes a read-only line "Supplier: <name> — from its main supplier box; make another box main to change it"; stop sending `supplierId`; drop the `needsReview` type field)
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts` (no `purchasePrice` on the item update ~823 or create ~937; no `supplierId` on create ~934; after CREATE_NEW, create the box when `newData.supplierId || session.supplierId` — `{ inventoryItemId: created.id, supplierId, supplierName: Supplier.name (canonicalSupplierName), isPrimary: true, lastPrice: listedPrice(newChain), packChain: newChain.packChain, pricing: newChain.pricing, supplierItemCode: scanItem.supplierItemCode ?? null, lastInvoiceSessionId: sessionId }` + `undo.created('OFFER', id)`)
- Modify: `src/app/api/recipes/route.ts` (~278), `src/app/api/recipes/[id]/save-scale/route.ts` (~113), `src/app/api/inventory/sync-prepd/route.ts` (~45): delete `purchasePrice: 0`
- Modify: `src/lib/recipeCosts.ts` `syncPrepToInventory` (~573): delete the `purchasePrice` write
- Modify: `src/lib/primary-offer.ts`: `syncPrimaryOfferToItem` no longer writes `purchasePrice`; `mirrorItemToPrimaryOffer` no longer writes `lastPrice` and selects `pricing`/`packChain` only; delete `purchasePriceFromPricing`
- Modify: `src/lib/inventory-import.ts` (payload: drop `purchasePrice` and `pricePerBaseUnit` keys) + `src/app/api/inventory/import/route.ts` (~58)
- Modify: `src/lib/invoice/rollback.ts` (~411: `data: { pricing: … }` only), `src/lib/invoice/revert-pricing.ts` (return `{ pricing, basis }`; drop `purchasePrice` from the shape and its tests), `src/lib/invoice/approve-undo.ts` (`ITEM_FIELDS` without `purchasePrice`, `OFFER_FIELDS` without `lastPrice`, `DECIMAL_FIELDS` likewise; and in `rollback.ts` `applyRow`/`toPrismaData`, drop keys not in the current field lists so an OLD undo row carrying `purchasePrice`/`lastPrice` still restores cleanly)
- Modify: `src/lib/invoice/create-new-repair.ts` (`ItemRewrite.purchasePrice` + `planStockRewrite`'s `purchasePrice` → removed; `rateFrom: 'lastPrice'` fallback → `'offer listed price'` using `offerListedPrice(offer)`), `src/lib/invoice/offer-repair.ts` (`rewrite` result drops `lastPrice`), `src/lib/item-merge.ts` (synthesized row: no `lastPrice`)
- Modify: `scripts/repair-create-new-shape.ts`, `scripts/repair-weight-priced-offers.ts`, `scripts/repair-offer-chains.ts`, `scripts/backfill-primary-offers.ts`, `scripts/verify-primary-offers.ts`: only what the build requires (they are in the TS project) — drop the removed fields; if a script is a one-off already run, add it to `tsconfig.json` `exclude` with a `// DEAD` header instead
- Delete: `src/app/api/invoices/[id]/process/route.ts` (unauthenticated legacy price writer with no UI caller)
- Tests: `src/lib/__tests__/revert-pricing.test.ts`, `rollback.test.ts`, `approve-undo.test.ts`, `create-new-repair.test.ts`, `offer-repair.test.ts`, `item-merge*.test.ts` — adjust fixtures/expectations to the removed fields (never loosen types); new test in `rollback.test.ts`: an undo row whose `prev` carries `purchasePrice: 12` and `lastPrice: 3` restores without those keys in the written `data`.

- [ ] **Step 1: Failing tests first** — the rollback "old undo row" test and the revert-pricing shape test (write them, run, see RED).
- [ ] **Step 2: Implement file by file**, running the directly covering test after each lib edit.
- [ ] **Step 3: `npm test`, `npm run build`, `npm run lint`** (baseline 20 files). Fix every type error by removing the stale field, never by re-adding a write.
- [ ] **Step 4: Commit**

```bash
git add -A src scripts tsconfig.json
git commit -m "refactor(items): nothing writes purchasePrice, supplierId, location or needsReview on an item, or lastPrice on a box; legacy price route deleted"
```

---

### Task 5: Readers of `purchasePrice` / `lastPrice` / `location` / `needsReview` switch to the derivations; a gate keeps them out

**Files:**
- Modify (readers): `src/app/inventory/page.tsx` (~489 sort, ~742, ~851, ~1688, ~1759: `parseFloat(String(item.purchasePrice))` → `listedPriceOf(item)` where `const listedPriceOf = (i) => listedPrice(i)` — `listedPrice` is client-safe? It lives in `cost-basis.ts` which imports prisma: NOT client-safe. So: the list API attaches a computed `purchasePrice: listedPrice(row)` in `inventory-list.ts`'s row mapping (and the `[id]`, POST, search, scanitems, sessions routes attach it with `withLastCost`-style spreading: `{ ...row, purchasePrice: listedPrice(row) }`). The page keeps reading `item.purchasePrice` unchanged.) Do the same for `offer.lastPrice` in `src/lib/supplier-offers.ts` (`lastPrice: offerListedPrice(o)`) and in `src/app/api/invoices/sessions/[id]/route.ts` / `scanitems/route.ts` matched-item `supplierPrices` payloads.
- Modify: `src/lib/invoice-matcher.ts` `previousPriceFor(offer, item)`: `const offerLast = offer ? offerListedPrice(offer) : 0; return offerLast > 0 ? offerLast : listedPrice(item)`; update its test (pass `{ pricing: { mode: 'PACK', purchasePrice: 139.9 } }` instead of `lastPrice`).
- Modify: `src/lib/invoice/offer-copy.ts` `offerPriceLabel(o: { pricing })` → PACK uses `offerListedPrice(o)`; `SupplierOffersSection.tsx` passes the offer (it already does).
- Modify: `src/app/api/inventory/export/route.ts`: the `Purchase Price` column → `listedPrice(item)`; drop the `Location` column and the `needsReview` echo line (~158); `src/app/api/inventory/[id]/route.ts` GET: `purchasePrice: listedPrice(item)` in the body.
- Modify: `src/lib/count-redact.ts` / `src/lib/inventory-redact.ts`: keep `purchasePrice`/`lastPrice` in the key lists (they are still emitted, computed).
- Modify: `src/components/invoices/types.ts` comment on `lastPrice` ("computed from pricing").
- Create: `src/lib/__tests__/stale-columns-gate.test.ts` — walks `src/app/api` and `src/lib` (not `__tests__`, not `scripts`), fails on any `purchasePrice: true`, `lastPrice: true`, `needsReview: true`, `location: true` select key, any `data: {` block containing `purchasePrice:` / `lastPrice:` / `needsReview:` / `location:` as a top-level key (regex on `\b(purchasePrice|lastPrice|needsReview|location)\s*:\s*(?!true\b|listedPrice|offerListedPrice)` is too loose — instead: forbid the exact tokens `purchasePrice: true`, `lastPrice: true`, `needsReview: true`, `location: true`, `purchasePrice: new`, `purchasePrice: Number`, `purchasePrice: revert`, `purchasePrice: purchasePriceFromPricing`, `lastPrice: item.`, `lastPrice: offerLastPrice`, `lastPrice: derivedPrice`, `needsReview: false`, `location: form`, `location: addItemForm`; and forbid the member reads `\.purchasePrice\b`, `\.lastPrice\b`, `\.needsReview\b`, `\.location\b` EXCEPT in an allow-list: `src/lib/cost-basis.ts`, `src/lib/offer-price.ts`, `src/lib/invoice/revert-pricing.ts` (its name), `window.location` matches (exclude lines containing `window.` or `router`), `src/app/api/inventory/[id]/route.ts` (the `delete rest.needsReview` strip line). Print the offenders.)

- [ ] **Step 1: Write the gate test; run it — RED lists the offenders.**
- [ ] **Step 2: Migrate each offender per the bullets above until the gate is GREEN.**
- [ ] **Step 3: `npm test`, `npm run build`, `npm run lint`; commit**

```bash
git add -A src
git commit -m "refactor(items): headline prices derive from the chain, box prices from their pricing; gate keeps the stale columns unread"
```

---

### Task 6: Parity, smoke, PR

- [ ] **Step 1: Read-only parity (live)**

Create `scripts/verify-stale-column-parity.ts` (read-only; commit it): for every active item, `listedPrice(row)` vs `Number(row.purchasePrice)` → report items that differ by more than $0.01 with both numbers and the primary supplier (expected: the 85 items the 2026-10-02 audit found drifted; print the count and the 10 largest gaps — this is the owner's Before/After: "Before: the list showed the stale copy; After: the real box price"); for every offer, `offerListedPrice(o)` vs `Number(o.lastPrice)` → differences > $0.01 (expected 0); for every active item, derived supplier (primary box) vs `supplier` column → count differing (expected 17) and missing-before (expected 68). Paste the output into the PR.

- [ ] **Step 2: Preview from this worktree** (temporary launch.json entry `Worktree retire-stale-columns` on port 3115, as in the earlier stages; never commit it): `/inventory` — the supplier column and the Order Guide group by the primary box's supplier (Free Run Eggs shows Legends Haul); a drifted item's price column now shows the box price; add an item with a supplier → it gets a box; the drawer's Supplier line is read-only with the hint; `/count` add-item has no Location field; `/invoices` review loads. `preview_stop`, `git checkout .claude/launch.json`.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin HEAD:feat/retire-stale-columns
gh pr create --base main --head feat/retire-stale-columns --title "refactor(items): the stale price and supplier copies are no longer read or written" --body "$(cat <<'EOF'
## What changes for the restaurant
- An item's supplier is now whichever supplier box is its main one — the same thing invoices and prices already use. 68 items that had a box but showed no supplier now show one; 17 items whose label disagreed with their main box now show the box's supplier (e.g. Free Run Eggs: Legends Haul, not Sysco).
- 76 items that named a supplier but had no box got one, built from their own current price and pack (nothing re-priced) — backup kept.
- The inventory list's price column and Order Guide show the real box price (85 items had a stale copy).
- The item editor no longer has a Supplier picker or a free-text Location; the supplier is changed by making another box main, the location is the storage area.
- An old, unprotected price-update route is gone.
- No migration yet: the old columns stay in the database for one week, then a separate change removes them.

## Before / After (read-only parity script)
<paste scripts/verify-stale-column-parity.ts output>

## How
Spec §2.3; plan `docs/superpowers/plans/2026-10-03-item-backbone-1d-retire-stale-columns.md`. `offerListedPrice`, `PRIMARY_SUPPLIER_INCLUDE` + `withSupplier`; API responses keep `supplier`/`supplierId`/`purchasePrice`/`lastPrice` as computed fields; `stale-columns-gate.test.ts` fails the suite on a new read or write.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Stage 1e (separate PR, ≥ 1 week later, not part of this plan)
Hand-authored migration dropping `InventoryItem.purchasePrice`, `supplierId` (+ its FK and the `Supplier.inventory` back-relation), `location`, `needsReview`, and `InventorySupplierPrice.lastPrice`; schema updated; `approve-undo` / `rollback` field lists already exclude them.

## Self-review
- **Spec coverage (§2.3 table):** `purchasePrice` → `listedPrice` (Tasks 4–5); `supplierId` → primary box (Tasks 1–3, backfill Task 2); `location` → `storageAreaId` (Task 2 backfill, Task 4 writers, Task 5 export); `needsReview` → removed (Tasks 4–5); `lastPrice` → `offerListedPrice` (Tasks 1, 4, 5). Drop deferred to 1e as the spec requires.
- **Placeholders:** the gate test's token list is explicit; the parity output is the one run-time value.
- **Type consistency:** `offerListedPrice(offer)`, `listedPrice(row)`, `PRIMARY_SUPPLIER_INCLUDE`, `withSupplier(row)` are the only new names and are used with those spellings in Tasks 2–6.
