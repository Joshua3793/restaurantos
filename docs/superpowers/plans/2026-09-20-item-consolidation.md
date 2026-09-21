# Item Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one inventory item hold many suppliers correctly — receiving and pricing read the *supplier's* pack, receipts are frozen, the matcher reads the offer library, and duplicate rows can be merged (and un-merged).

**Architecture:** A tiny pure resolver (`line-format.ts`) swaps the item's chain for the line's supplier-offer chain before the existing receiving math runs; approve freezes the result in `InvoiceScanItem.receivedQtyBase`. A pure merge *planner* turns two item rows + their relations into a manifest; a thin executor applies it in one transaction and the same manifest drives undo. Spec: `docs/superpowers/specs/2026-09-20-item-consolidation-design.md`.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + Postgres (Supabase, pgBouncer transaction mode) · vitest · Tailwind (flat colour tokens).

## Global Constraints

- Base units are canonical SI (`g` | `ml` | `each`). Same dimension ⇒ same base unit ⇒ conversion factor 1.
- Never store a parallel cost. `receivedQtyBase` is a frozen *quantity* (a point-in-time fact, like `CountLine.countedQtyBase`), not a price.
- Every new route: `export const dynamic = 'force-dynamic'`, guard with `requireSession('MANAGER')`, catch `AuthError` → `NextResponse.json({ error }, { status })`.
- Prisma: import the singleton from `@/lib/prisma`. No `$executeRaw` tagged templates (pgBouncer).
- Migrations: the shadow DB is broken (P3006). Hand-write the SQL, apply with `npx prisma db execute` over the **session pooler** (`DATABASE_URL` host, port 5432, no `pgbouncer` param), then `npx prisma migrate resolve --applied <name>`. Never run a full-schema `migrate diff`.
- Tailwind: flat tokens only (`bg-red`, `text-red-text`, `bg-blue-soft`, `text-ink-2`) — numbered classes are broken.
- Client sub-components at module scope, never inside a component body.
- Prisma `Decimal` arrives as a string in JSON — wrap with `Number()`.
- Correctness gate after every task: `npm test` (fast) and, for anything touching routes/components, `npm run build` **in an isolated worktree** (a build in the main checkout bogus-fails while the dev server runs, and rewrites `tsconfig.json`).
- PREP-owned items (`Recipe.inventoryItemId` set) never merge.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `prisma/migrations/20260920000000_item_consolidation/migration.sql` | create: three additive changes |
| `prisma/schema.prisma` | modify: `mergedIntoId`, `ItemMerge`, `receivedQtyBase` |
| `src/lib/invoice/line-format.ts` | create: `pickOffer`, `resolveLineFormat` — pure, client-safe |
| `src/lib/invoice/line-qty.ts` | modify: honour frozen value; accept an offer |
| `src/lib/count-expected.ts` | modify: `buildPurchaseMap` loads offers + frozen value |
| `src/lib/invoice/resolution.ts`, `src/components/invoices/v2/card.tsx`, `ApprovedReport.tsx` | modify: pass the session supplier's offer |
| `src/app/api/invoices/sessions/[id]/approve/route.ts` | modify: guard vs supplier offer, keep offer chain, freeze receipt |
| `scripts/backfill-received-qty-base.ts` | create: dry-run diff + apply with backup |
| `src/lib/invoice-matcher.ts` | modify: offer-SKU tier 0, alias scoring |
| `src/lib/invoice/new-supplier.ts` | create: `isNewSupplierForItem`, pure |
| `src/components/invoices/v2/issues.tsx`, `InvoiceReviewDrawer.tsx` | modify: new-supplier note, "add as supplier instead" banner |
| `src/lib/item-merge.ts` | create: pure planner (`planMerge`, `planUndo`, types) |
| `src/lib/item-merge-exec.ts` | create: load relations, execute manifest, undo (server-only) |
| `src/lib/quick-count.ts` | create: `recordQuickCount` extracted from the quick route |
| `src/app/api/inventory/[id]/merge/route.ts`, `src/app/api/inventory/merges/[id]/undo/route.ts` | create |
| `src/components/inventory/MergeItemSheet.tsx` | create: search → preview → confirm |
| `src/components/inventory/InventoryItemDrawer.tsx` | modify: entry point + "Merged · Undo" line |
| `scripts/audit-duplicate-items.ts` | committed with this plan: the worklist |
| `CLAUDE.md` | modify: document the resolver, frozen receipts, merge |

---

### Task 1: Schema + migration

**Files:**
- Modify: `prisma/schema.prisma` (models `InventoryItem`, `InvoiceScanItem`; new model `ItemMerge`)
- Create: `prisma/migrations/20260920000000_item_consolidation/migration.sql`

**Interfaces:**
- Produces: `InventoryItem.mergedIntoId: string | null`, `InvoiceScanItem.receivedQtyBase: Decimal | null`, model `ItemMerge { id, survivorId, absorbedId, mergedBy, mergedAt, undoneAt, manifest }`.

- [ ] **Step 1: Edit the schema.** In `model InventoryItem`, after `barcode String?`:

```prisma
  // Set ⇒ this row is a TOMBSTONE absorbed into another item (src/lib/item-merge.ts).
  // A tombstone is also isActive=false, so every isActive filter already hides it.
  mergedIntoId       String?
  mergedInto         InventoryItem?           @relation("ItemMergedInto", fields: [mergedIntoId], references: [id])
  absorbedItems      InventoryItem[]          @relation("ItemMergedInto")
```

In `model InvoiceScanItem`, after `bbox Json?`:

```prisma
  // Base units this line RECEIVED, frozen at approve (like CountLine.countedQtyBase).
  // A quantity, not a cost. Null = not yet frozen → readers compute live.
  receivedQtyBase    Decimal?
```

New model (place after `InventorySupplierPrice`):

```prisma
model ItemMerge {
  id         String    @id @default(cuid())
  survivorId String
  absorbedId String
  mergedBy   String
  mergedAt   DateTime  @default(now())
  undoneAt   DateTime?
  // MergeManifest (src/lib/item-merge.ts): every re-pointed row id per table and
  // the before-value of anything overwritten. Undo replays it in reverse.
  manifest   Json

  @@index([survivorId])
  @@index([absorbedId])
}
```

- [ ] **Step 2: Write the migration SQL** at `prisma/migrations/20260920000000_item_consolidation/migration.sql`:

```sql
ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "mergedIntoId" TEXT;
DO $$ BEGIN
  ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_mergedIntoId_fkey"
    FOREIGN KEY ("mergedIntoId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "InvoiceScanItem" ADD COLUMN IF NOT EXISTS "receivedQtyBase" DECIMAL(65,30);

CREATE TABLE IF NOT EXISTS "ItemMerge" (
  "id" TEXT NOT NULL,
  "survivorId" TEXT NOT NULL,
  "absorbedId" TEXT NOT NULL,
  "mergedBy" TEXT NOT NULL,
  "mergedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undoneAt" TIMESTAMP(3),
  "manifest" JSONB NOT NULL,
  CONSTRAINT "ItemMerge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ItemMerge_survivorId_idx" ON "ItemMerge"("survivorId");
CREATE INDEX IF NOT EXISTS "ItemMerge_absorbedId_idx" ON "ItemMerge"("absorbedId");
```

- [ ] **Step 3: Validate + regenerate.** Run: `npx prisma validate && npx prisma generate`. Expected: "The schema at prisma/schema.prisma is valid" and a generated client. **Restart the dev server after `prisma generate`.**

- [ ] **Step 4: Apply to the DB — ASK THE USER FIRST (this is the live database).** Then, with `SESSION_URL` = `DATABASE_URL` rewritten to port 5432 without `?pgbouncer=true`:

```bash
npx prisma db execute --url "$SESSION_URL" --file prisma/migrations/20260920000000_item_consolidation/migration.sql
npx prisma migrate resolve --applied 20260920000000_item_consolidation
```

Expected: "Script executed successfully." then "Migration … marked as applied."

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260920000000_item_consolidation
git commit -m "feat(db): item merge tombstone, merge log, frozen received qty"
```

---

### Task 2: The line-format resolver

**Files:**
- Create: `src/lib/invoice/line-format.ts`
- Test: `src/lib/__tests__/line-format.test.ts`

**Interfaces:**
- Consumes: `ChainItem`, `PackLink`, `Pricing`, `basePerPurchase`, `dimensionOf` from `@/lib/item-model`.
- Produces:
  - `interface OfferFormat { supplierId?: string | null; supplierName?: string | null; packChain?: unknown; pricing?: unknown }`
  - `interface SupplierRef { supplierId?: string | null; supplierName?: string | null; canonicalName?: string | null }`
  - `pickOffer<T extends OfferFormat>(offers: T[] | null | undefined, ref: SupplierRef): T | null`
  - `resolveLineFormat(item: ChainItem, offer: OfferFormat | null | undefined): ChainItem`

The spec's resolver order is: (1) the line's printed pack, (2) the supplier offer's chain, (3) the item's chain. Step 1 already lives inside `lineReceivedBaseUnits` and needs no `line` argument here; this function decides between 2 and 3.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { pickOffer, resolveLineFormat } from '@/lib/invoice/line-format'
import { lineReceivedBaseUnits } from '@/lib/invoice/line-qty'
import { asChainItem } from '@/lib/item-model'

// Romaine hearts: the item (primary supplier) is 4 case › 12 pack = 48 each.
const romaine = asChainItem({
  dimension: 'COUNT', baseUnit: 'each',
  packChain: [{ unit: 'case', per: 4 }, { unit: 'pack', per: 12 }],
  pricing: { mode: 'PACK', purchasePrice: 60 },
})
const otherSupplier = {
  supplierId: 'sup-b', supplierName: 'North Arm Farms',
  packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 30 },
}

describe('resolveLineFormat', () => {
  it('no offer → the item chain, unchanged (regression lock for items without offers)', () => {
    expect(resolveLineFormat(romaine, null)).toBe(romaine)
  })

  it('uses the supplier offer chain, keeps the item base unit and bridges', () => {
    const r = resolveLineFormat({ ...romaine, eachMeasure: { qty: 300, unit: 'g' } }, otherSupplier)
    expect(r.packChain).toEqual([{ unit: 'case', per: 12 }])
    expect(r.baseUnit).toBe('each')
    expect(r.eachMeasure).toEqual({ qty: 300, unit: 'g' })
  })

  it('"2 cases" with no printed pack credits the SUPPLIER case, not the item case', () => {
    const line = { rawQty: 2, rawUnit: 'case' }
    expect(lineReceivedBaseUnits(line, romaine)).toBe(96)                                   // today: wrong for supplier B
    expect(lineReceivedBaseUnits(line, resolveLineFormat(romaine, otherSupplier))).toBe(24) // fixed
  })

  it('an empty or zero offer chain falls back to the item', () => {
    expect(resolveLineFormat(romaine, { packChain: [] })).toBe(romaine)
    expect(resolveLineFormat(romaine, { packChain: [{ unit: 'case', per: 0 }] })).toBe(romaine)
    expect(resolveLineFormat(romaine, { packChain: null })).toBe(romaine)
  })

  it('a RATE offer on a PACK item makes the line read as billed weight', () => {
    const beef = asChainItem({
      dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 10000 }],
      pricing: { mode: 'PACK', purchasePrice: 200 },
    })
    const catchWeight = { packChain: [{ unit: 'kg', per: 1000 }], pricing: { mode: 'RATE', rate: 22, rateUnit: 'kg' } }
    const line = { rawQty: 1, rawUnit: 'case', totalQty: 9.4, totalQtyUOM: 'kg' }
    expect(lineReceivedBaseUnits(line, beef)).toBe(10000)
    expect(lineReceivedBaseUnits(line, resolveLineFormat(beef, catchWeight))).toBeCloseTo(9400)
  })

  it('ignores a RATE offer whose unit is another dimension', () => {
    const r = resolveLineFormat(romaine, { packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'RATE', rate: 5, rateUnit: 'kg' } })
    expect(r.pricing).toEqual(romaine.pricing)
    expect(r.packChain).toEqual([{ unit: 'case', per: 12 }])
  })
})

describe('pickOffer', () => {
  const offers = [
    { supplierId: 'sup-a', supplierName: 'Sysco', packChain: [] },
    { supplierId: null, supplierName: 'North Arm Farms', packChain: [] },
  ]
  it('joins on supplierId first', () => {
    expect(pickOffer(offers, { supplierId: 'sup-a', supplierName: 'SYSCO CANADA' })?.supplierName).toBe('Sysco')
  })
  it('falls back to the canonical then the raw name', () => {
    expect(pickOffer(offers, { supplierName: 'NAF', canonicalName: 'North Arm Farms' })?.supplierName).toBe('North Arm Farms')
    expect(pickOffer(offers, { supplierName: 'North Arm Farms' })?.supplierName).toBe('North Arm Farms')
  })
  it('null when nothing matches or there is no supplier', () => {
    expect(pickOffer(offers, { supplierName: 'GFS' })).toBeNull()
    expect(pickOffer(offers, {})).toBeNull()
    expect(pickOffer(null, { supplierName: 'Sysco' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run it.** `npx vitest run src/lib/__tests__/line-format.test.ts` → FAIL, "Cannot find module '@/lib/invoice/line-format'".

- [ ] **Step 3: Implement** `src/lib/invoice/line-format.ts`:

```ts
// Which pack format does an invoice line speak? An item with several suppliers
// has several packs; the item's own chain is only the PRIMARY supplier's. Reading
// every line through the item's chain is what forced a second item per supplier
// (spec 2026-09-20-item-consolidation). Pure + client-safe.

import { type ChainItem, type PackLink, type Pricing, basePerPurchase, dimensionOf } from '@/lib/item-model'

/** The slice of an InventorySupplierPrice row this module reads. */
export interface OfferFormat {
  supplierId?: string | null
  supplierName?: string | null
  packChain?: unknown
  pricing?: unknown
}

export interface SupplierRef {
  supplierId?: string | null
  supplierName?: string | null
  /** Supplier.name — offers are stored under it; sessions may carry an OCR variant. */
  canonicalName?: string | null
}

/** The offer belonging to a line's supplier. supplierId is the reliable join. */
export function pickOffer<T extends OfferFormat>(offers: T[] | null | undefined, ref: SupplierRef): T | null {
  if (!offers?.length) return null
  if (ref.supplierId) {
    const byId = offers.find(o => o.supplierId && o.supplierId === ref.supplierId)
    if (byId) return byId
  }
  for (const name of [ref.canonicalName, ref.supplierName]) {
    if (!name) continue
    const byName = offers.find(o => o.supplierName === name)
    if (byName) return byName
  }
  return null
}

/**
 * The ChainItem a line should be received/priced through: the supplier offer's
 * chain + pricing mode when it has a usable one, else the item unchanged. Base
 * unit and bridges always stay the item's. (A pack PRINTED on the line still wins
 * — that rule lives inside lineReceivedBaseUnits.)
 */
export function resolveLineFormat(item: ChainItem, offer: OfferFormat | null | undefined): ChainItem {
  const chain = Array.isArray(offer?.packChain) ? (offer!.packChain as PackLink[]) : []
  if (chain.length === 0 || !(basePerPurchase(chain) > 0)) return item

  const p = offer?.pricing as Pricing | null | undefined
  const rateOk = p?.mode === 'RATE' && !!p.rateUnit && dimensionOf(p.rateUnit) === item.dimension
  const pricing: Pricing = p?.mode === 'PACK' || rateOk ? (p as Pricing) : item.pricing
  return { ...item, packChain: chain, pricing }
}
```

- [ ] **Step 4: Run it.** `npx vitest run src/lib/__tests__/line-format.test.ts` → PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoice/line-format.ts src/lib/__tests__/line-format.test.ts
git commit -m "feat(invoices): resolve a line's pack through its supplier offer"
```

---

### Task 3: Readers use the resolver and the frozen value

**Files:**
- Modify: `src/lib/invoice/line-qty.ts` (`LineQtyInput`, `lineReceivedBaseUnits`, `lineReceivedCountQty`)
- Modify: `src/lib/count-expected.ts:291-375` (`buildPurchaseMap`)
- Modify: `src/lib/invoice/resolution.ts:20-36,50-64`, `src/components/invoices/v2/card.tsx:93-101`, `src/components/invoices/v2/ApprovedReport.tsx:99-112`
- Test: `src/lib/__tests__/line-qty.test.ts` (append)

**Interfaces:**
- Consumes: `resolveLineFormat`, `pickOffer`, `OfferFormat` (Task 2).
- Produces: `LineQtyInput.receivedQtyBase?: number | string | null`; `lineReceivedCountQty(line, matched, offer?: OfferFormat | null)`.

- [ ] **Step 1: Append failing tests** to `src/lib/__tests__/line-qty.test.ts`:

```ts
describe('frozen receipts and supplier offers', () => {
  const romaine = item({
    dimension: 'COUNT', baseUnit: 'each', countUnit: 'each',
    packChain: [{ unit: 'case', per: 4 }, { unit: 'pack', per: 12 }],
  })

  it('a frozen receivedQtyBase wins over every live rule', () => {
    expect(lineReceivedBaseUnits(line({ rawQty: 2, receivedQtyBase: '24' }), romaine)).toBe(24)
  })
  it('a null or zero frozen value computes live', () => {
    expect(lineReceivedBaseUnits(line({ rawQty: 2, receivedQtyBase: null }), romaine)).toBe(96)
    expect(lineReceivedBaseUnits(line({ rawQty: 2, receivedQtyBase: 0 }), romaine)).toBe(96)
  })
  it('lineReceivedCountQty reads the line through the supplier offer', () => {
    const matched = { dimension: 'COUNT', baseUnit: 'each', packChain: romaine.packChain, pricing: romaine.pricing, countUnit: 'each' }
    expect(lineReceivedCountQty(line({ rawQty: 2 }), matched).qty).toBe(96)
    expect(lineReceivedCountQty(line({ rawQty: 2 }), matched, { packChain: [{ unit: 'case', per: 12 }] }).qty).toBe(24)
  })
})
```

- [ ] **Step 2: Run.** `npx vitest run src/lib/__tests__/line-qty.test.ts` → the three new tests FAIL.

- [ ] **Step 3: Edit `line-qty.ts`.** Add the import and field, the frozen short-circuit, and the offer parameter:

```ts
import { resolveLineFormat, type OfferFormat } from '@/lib/invoice/line-format'
```

In `LineQtyInput` add:

```ts
  /** Frozen at approve. When > 0 it IS the answer — the live rules below are only
   *  for lines not yet approved (or not yet backfilled). Callers computing the
   *  value to freeze must NOT pass it. */
  receivedQtyBase?: number | string | null
```

First lines of `lineReceivedBaseUnits`:

```ts
  const frozen = num(line.receivedQtyBase)
  if (frozen > 0) return frozen
```

`lineReceivedCountQty` — new signature and one changed line:

```ts
export function lineReceivedCountQty(
  line: LineQtyInput, matched: MatchedItemLike, offer?: OfferFormat | null,
): { qty: number; countUom: string } {
```
```ts
  const base = lineReceivedBaseUnits(line, resolveLineFormat(chainItem, offer))
```

- [ ] **Step 4: Run.** `npx vitest run src/lib/__tests__/line-qty.test.ts` → PASS.

- [ ] **Step 5: `buildPurchaseMap`.** In the `select`, add `receivedQtyBase: true`, add `supplierId: true` to the `session` select, and widen `matchedItem`:

```ts
      matchedItem: {
        select: {
          id: true,
          ...PRICING_SELECT,
          supplierPrices: { select: { supplierId: true, supplierName: true, packChain: true, pricing: true } },
        },
      },
```

Replace the `lineReceivedBaseUnits({...}, asChainItem(si.matchedItem))` call's arguments:

```ts
    const baseUnits = lineReceivedBaseUnits({
      receivedQtyBase: si.receivedQtyBase?.toString() ?? null,
      rawQty:         si.rawQty?.toString() ?? null,
      rawUnit:        si.rawUnit,
      totalQty:       si.totalQty?.toString() ?? null,
      totalQtyUOM:    si.totalQtyUOM,
      rateUOM:        si.rateUOM,
      invoicePackQty:  si.invoicePackQty?.toString() ?? null,
      invoicePackSize: si.invoicePackSize?.toString() ?? null,
      invoicePackUOM:  si.invoicePackUOM,
    }, resolveLineFormat(
      asChainItem(si.matchedItem),
      // Offers are stored under the canonical supplier name; supplierId is the
      // reliable join and the raw session name the fallback.
      pickOffer(si.matchedItem.supplierPrices, { supplierId: si.session.supplierId, supplierName: si.session.supplierName }),
    ))
```

Add `import { resolveLineFormat, pickOffer } from '@/lib/invoice/line-format'`.

- [ ] **Step 6: Client callers.** In `src/lib/invoice/resolution.ts`, delete the local `offerMatches` + body of `offerForSupplier` and delegate (keeps one join rule):

```ts
import { pickOffer } from '@/lib/invoice/line-format'

export function offerForSupplier(item: ScanItem, ref: SupplierRef) {
  return pickOffer(item.matchedItem?.supplierPrices ?? null, ref)
}
```

`cheapestOtherOffer` used `offerMatches`; rewrite its filter as `o => o !== offerForSupplier(item, ref) && offerPricePerBase(o) > 0`.

`hasInvalidRcSplit` needs the session supplier. Change its signature to `hasInvalidRcSplit(item: ScanItem, ref?: SupplierRef)` and pass `ref ? offerForSupplier(item, ref) : null` as the third argument of `lineReceivedCountQty`. Update its callers: `card.tsx:87` → `hasInvalidRcSplit(item, { supplierId: ctx.sessionSupplierId, supplierName: ctx.sessionSupplierName })`; run `grep -rn "hasInvalidRcSplit(" src` and give every other caller the same ref (each already has `sessionSupplier` or `ctx` in scope).

`card.tsx:93-101` — add the third argument:

```ts
      }, offerForSupplier(item, { supplierId: ctx.sessionSupplierId, supplierName: ctx.sessionSupplierName }))
```

`ApprovedReport.tsx` `stockEffect(item)` → `stockEffect(item, supplier: SupplierRef)`, third argument `offerForSupplier(item, supplier)`; pass the session's `{ supplierId, supplierName }` from the report's props at each call site (`grep -n "stockEffect(" src/components/invoices/v2/ApprovedReport.tsx`). The `ScanItem` type needs `receivedQtyBase?: number | string | null` in `src/components/invoices/types.ts` so the frozen value flows into `lineReceivedCountQty`.

- [ ] **Step 7: Verify.** `npm test` → all green. In an isolated worktree: `npm run build` → compiles, `/api/invoices/sessions/[id]` still `ƒ (Dynamic)`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/invoice/line-qty.ts src/lib/count-expected.ts src/lib/invoice/resolution.ts src/components/invoices src/lib/__tests__/line-qty.test.ts
git commit -m "feat(stock): receive through the supplier's pack; prefer the frozen receipt"
```

---

### Task 4: Approve — guard against the supplier's pack, keep the offer's chain, freeze the receipt

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts` (item loop `:107-520`, CREATE_NEW `:560-592`)
- Create: `src/lib/invoice/approve-format.ts` (pure decision, so it is testable)
- Test: `src/lib/__tests__/approve-format.test.ts`

**Interfaces:**
- Consumes: `resolveLineFormat`, `OfferFormat`; `basePerPurchase`, `packFormatsDisagree`, `PackLink` from `@/lib/item-model`; `lineReceivedBaseUnits`.
- Produces: `packReference(itemChain: PackLink[], lineOffer: OfferFormat | null, itemHasOffers: boolean): { baseTotal: number; against: 'offer' | 'item' } | null`.

The rule: compare the invoice's pack against **this supplier's previous pack**. No offer from this supplier yet on an item that has other offers ⇒ no reference, guard silent (the line's pack becomes the new offer). An item with no offers at all keeps today's behaviour.

- [ ] **Step 1: Failing test** `src/lib/__tests__/approve-format.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { packReference } from '@/lib/invoice/approve-format'

const itemChain = [{ unit: 'case', per: 4 }, { unit: 'pack', per: 12 }] // 48

describe('packReference', () => {
  it('this supplier has an offer → compare against ITS pack', () => {
    expect(packReference(itemChain, { packChain: [{ unit: 'case', per: 12 }] }, true)).toEqual({ baseTotal: 12, against: 'offer' })
  })
  it('new supplier on an item that already has offers → no reference (guard silent)', () => {
    expect(packReference(itemChain, null, true)).toBeNull()
  })
  it('item with no offers at all → today’s behaviour, compare against the item', () => {
    expect(packReference(itemChain, null, false)).toEqual({ baseTotal: 48, against: 'item' })
  })
  it('an offer with an unusable chain behaves like no offer', () => {
    expect(packReference(itemChain, { packChain: [] }, true)).toBeNull()
  })
})
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement** `src/lib/invoice/approve-format.ts`:

```ts
import { type PackLink, basePerPurchase } from '@/lib/item-model'
import type { OfferFormat } from '@/lib/invoice/line-format'

/** What an invoice line's printed pack should be checked against at approve.
 *  A different SUPPLIER having a different pack is normal; the same supplier
 *  changing its pack is a real format change (AdoptFormatModal). */
export function packReference(
  itemChain: PackLink[], lineOffer: OfferFormat | null, itemHasOffers: boolean,
): { baseTotal: number; against: 'offer' | 'item' } | null {
  const offerChain = Array.isArray(lineOffer?.packChain) ? (lineOffer!.packChain as PackLink[]) : []
  const offerTotal = offerChain.length ? basePerPurchase(offerChain) : 0
  if (offerTotal > 0) return { baseTotal: offerTotal, against: 'offer' }
  if (itemHasOffers) return null
  const itemTotal = basePerPurchase(itemChain)
  return itemTotal > 0 ? { baseTotal: itemTotal, against: 'item' } : null
}
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Wire the route.** Imports:

```ts
import { resolveLineFormat } from '@/lib/invoice/line-format'
import { packReference } from '@/lib/invoice/approve-format'
import { lineReceivedBaseUnits } from '@/lib/invoice/line-qty'
import { asChainItem } from '@/lib/item-model'
```

(a) Right after `const item = scanItem.matchedItem!` load this supplier's existing offer once:

```ts
        const itemOffers = await prisma.inventorySupplierPrice.findMany({
          where: { inventoryItemId: scanItem.matchedItemId },
          select: { supplierId: true, supplierName: true, packChain: true, pricing: true },
        })
        const lineOffer = offerSupplierName
          ? itemOffers.find(o => o.supplierName === offerSupplierName) ?? null
          : null
```

(b) In the PACK branch (`:225-256`) replace `const itemBaseTotal = basePerPurchase(...)` / `packFormatsDisagree(invoiceBaseTotal, itemBaseTotal)` with:

```ts
          const ref = packReference((item.packChain as PackLink[]) ?? [], lineOffer, itemOffers.length > 0)
          const packs = ref ? packFormatsDisagree(invoiceBaseTotal, ref.baseTotal) : { disagree: false, ratio: 1 }
```

and in the `console.error` say `the ${ref!.against === 'offer' ? "supplier's previous" : "item's stored"} format (${ref!.baseTotal} …)`. Then compute the price over the pack the line actually speaks — the invoice's own when printed, else the supplier's, else the item's:

```ts
          const speaks = resolveLineFormat(asChainItem(item as never), lineOffer)
          newPricePerBase = invoiceBaseTotal > 0
            ? newPurchasePrice / invoiceBaseTotal
            : pricePerBaseUnit({ ...speaks, pricing: { mode: 'PACK', purchasePrice: newPurchasePrice } })
```

For the primary supplier the offer chain equals the item chain (`syncPrimaryOfferToItem`), so the spine write below is numerically unchanged; the difference is only for non-primary suppliers, whose `newPricePerBase` was previously off by the pack ratio.

(c) Offer upsert, the no-line-pack branch (`:400-409`): stop overwriting a supplier's own chain with the item's. Replace `packChain: itemChain,` with:

```ts
                // No printed pack: keep what we already know about THIS supplier's
                // pack. Falling back to the item's chain here used to erase it.
                packChain: (Array.isArray(lineOffer?.packChain) && (lineOffer!.packChain as PackLink[]).length
                  ? (lineOffer!.packChain as PackLink[]) : itemChain),
```

(d) Freeze the receipt. Add above `const itemOps`:

```ts
        const lineQty = {
          rawQty: scanItem.rawQty?.toString() ?? null, rawUnit: scanItem.rawUnit,
          totalQty: scanItem.totalQty?.toString() ?? null, totalQtyUOM: scanItem.totalQtyUOM,
          rateUOM: scanItem.rateUOM,
          invoicePackQty: scanItem.invoicePackQty?.toString() ?? null,
          invoicePackSize: scanItem.invoicePackSize?.toString() ?? null,
          invoicePackUOM: scanItem.invoicePackUOM,
        } // deliberately NO receivedQtyBase: a re-approve recomputes
        const receivedQtyBase = lineReceivedBaseUnits(lineQty, resolveLineFormat(asChainItem(item as never), lineOffer))
```

and change the update to `data: { approved: true, receivedQtyBase: receivedQtyBase > 0 ? receivedQtyBase : null }`.

(e) CREATE_NEW (`:586-589`): build the same `lineQty` object and write `receivedQtyBase: lineReceivedBaseUnits(lineQty, asChainItem(created as never)) || null` alongside `matchedItemId: created.id, approved: true`.

(f) `parseValidSplit` (`:82`) — pass the offer: it runs before the loop, so look it up from a map built once:

```ts
    const offersByItem = new Map<string, Array<{ supplierId: string | null; supplierName: string; packChain: unknown; pricing: unknown }>>()
    // (fill from one findMany over the session's matchedItemIds, before parseValidSplit is defined)
```
```ts
      const offer = offerSupplierName ? offersByItem.get(scanItem.matchedItemId!)?.find(o => o.supplierName === offerSupplierName) ?? null : null
      const { qty: total } = lineReceivedCountQty(scanItem as any, scanItem.matchedItem as any, offer) // eslint-disable-line @typescript-eslint/no-explicit-any
```

Move the `offerSupplierName` declaration above `parseValidSplit`, and reuse `offersByItem` for step (a) instead of a per-line query.

- [ ] **Step 6: Confirm there is no un-approve path to clear.** Run `grep -rn "approved: false" src/app/api`. Expected: no hits — session DELETE cascades its scan items, so a frozen value can never outlive its approval.

- [ ] **Step 7: Verify.** `npm test`; isolated-worktree `npm run build`. Then with the dev server (preview_start), approve a test invoice line for a non-primary supplier with a different printed pack and confirm in `preview_logs` there is no `[approve] Skipping price write` and the row's `receivedQtyBase` is set (`npx prisma studio` or a one-off query). **This writes to the live DB — use a throwaway invoice and delete the session afterwards.**

- [ ] **Step 8: Commit**

```bash
git add src/lib/invoice/approve-format.ts src/lib/__tests__/approve-format.test.ts "src/app/api/invoices/sessions/[id]/approve/route.ts"
git commit -m "feat(invoices): approve checks the supplier's own pack and freezes the receipt"
```

---

### Task 5: Backfill `receivedQtyBase`

**Files:**
- Create: `scripts/backfill-received-qty-base.ts`

**Interfaces:**
- Consumes: `lineReceivedBaseUnits`, `resolveLineFormat`, `pickOffer`, `asChainItem`, `PRICING_SELECT`.

- [ ] **Step 1: Write the script**

```ts
/**
 * Freeze InvoiceScanItem.receivedQtyBase for every approved line.
 *
 *   npx tsx scripts/backfill-received-qty-base.ts            # DRY RUN: writes a diff file, changes nothing
 *   npx tsx scripts/backfill-received-qty-base.ts --apply    # backup JSON first, then write
 *
 * "old" = today's rule (the item's own chain). "next" = the supplier-offer rule.
 * Every line where they differ is a historical miscount the dry run surfaces.
 */
import { writeFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT, asChainItem } from '../src/lib/item-model'
import { lineReceivedBaseUnits } from '../src/lib/invoice/line-qty'
import { resolveLineFormat, pickOffer } from '../src/lib/invoice/line-format'

const APPLY = process.argv.includes('--apply')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

async function main() {
  const lines = await prisma.invoiceScanItem.findMany({
    where: {
      approved: true, matchedItemId: { not: null },
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] },
      session: { status: 'APPROVED' },
    },
    select: {
      id: true, rawDescription: true, receivedQtyBase: true,
      rawQty: true, rawUnit: true, totalQty: true, totalQtyUOM: true, rateUOM: true,
      invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
      session: { select: { supplierId: true, supplierName: true, invoiceNumber: true, purchaseDate: true } },
      matchedItem: {
        select: {
          id: true, itemName: true, ...PRICING_SELECT,
          supplierPrices: { select: { supplierId: true, supplierName: true, packChain: true, pricing: true } },
        },
      },
    },
  })

  const diff: unknown[] = []
  const writes: { id: string; next: number; prev: string | null }[] = []
  for (const l of lines) {
    if (!l.matchedItem) continue
    const input = {
      rawQty: l.rawQty?.toString() ?? null, rawUnit: l.rawUnit,
      totalQty: l.totalQty?.toString() ?? null, totalQtyUOM: l.totalQtyUOM, rateUOM: l.rateUOM,
      invoicePackQty: l.invoicePackQty?.toString() ?? null,
      invoicePackSize: l.invoicePackSize?.toString() ?? null, invoicePackUOM: l.invoicePackUOM,
    }
    const chain = asChainItem(l.matchedItem)
    const old = lineReceivedBaseUnits(input, chain)
    const next = lineReceivedBaseUnits(input, resolveLineFormat(chain, pickOffer(l.matchedItem.supplierPrices, l.session)))
    if (Math.abs(next - old) > Math.max(0.001, old * 0.005)) {
      diff.push({
        item: l.matchedItem.itemName, base: l.matchedItem.baseUnit, line: l.rawDescription,
        supplier: l.session.supplierName, invoice: l.session.invoiceNumber, date: l.session.purchaseDate,
        old, next, ratio: old > 0 ? +(next / old).toFixed(3) : null,
      })
    }
    if (next > 0) writes.push({ id: l.id, next, prev: l.receivedQtyBase?.toString() ?? null })
  }

  writeFileSync(`received-qty-base-diff-${stamp}.json`, JSON.stringify(diff, null, 2))
  console.log(`${lines.length} approved lines · ${writes.length} to freeze · ${diff.length} change vs today's rule`)
  console.log(`diff → received-qty-base-diff-${stamp}.json`)
  if (!APPLY) { console.log('DRY RUN — nothing written. Re-run with --apply.'); return }

  writeFileSync(`received-qty-base-backup-${stamp}.json`, JSON.stringify(writes.map(w => ({ id: w.id, prev: w.prev })), null, 2))
  for (const w of writes) {
    await prisma.invoiceScanItem.update({ where: { id: w.id }, data: { receivedQtyBase: w.next } })
  }
  console.log(`applied ${writes.length} · backup → received-qty-base-backup-${stamp}.json`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Dry run.** `npx tsx scripts/backfill-received-qty-base.ts`. Expected: a count line and a diff file. **Hand the diff file to the user and STOP.** Each entry moves theoretical stock retroactively (counted snapshots do not move).

- [ ] **Step 3: Apply only after the user approves the diff.** `npx tsx scripts/backfill-received-qty-base.ts --apply`. Expected: "applied N · backup → …". Re-run the dry run: "0 change" is NOT expected (old-vs-next is a rule comparison) — instead confirm `to freeze` equals the number of rows with `receivedQtyBase` set.

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-received-qty-base.ts
git commit -m "chore(scripts): backfill frozen received quantities with a dry-run diff"
```

---

### Task 6: Matcher reads the offer library

**Files:**
- Modify: `src/lib/invoice-matcher.ts` (`scoreMatch :118`, code rules `:354-381`, tier 0 `:429-448`, fuzzy loop `:484-493`, the confidence after it)
- Test: `src/lib/__tests__/invoice-matcher-aliases.test.ts`

**Interfaces:**
- Produces (exported for the test): `bestAliasScore(description: string, itemName: string, aliases: string[]): { score: number; viaAlias: boolean }`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import { bestAliasScore } from '@/lib/invoice-matcher'

describe('bestAliasScore', () => {
  it('scores against the item name when that is the best', () => {
    const r = bestAliasScore('Zucchini Green', 'Zucchini Green', [])
    expect(r).toEqual({ score: 100, viaAlias: false })
  })
  it('a learned description from another supplier lifts a weak name match', () => {
    const byName = bestAliasScore('ZUCCHINI GRN FANCY 20LB', 'Farm Squash Zuchinni', [])
    const byAlias = bestAliasScore('ZUCCHINI GRN FANCY 20LB', 'Farm Squash Zuchinni', ['ZUCCHINI GREEN FANCY'])
    expect(byAlias.score).toBeGreaterThan(byName.score)
    expect(byAlias.viaAlias).toBe(true)
  })
  it('an alias that scores lower than the name is ignored', () => {
    expect(bestAliasScore('Butter Unsalted', 'Butter Unsalted', ['COCOA BUTTER CHIPS']).viaAlias).toBe(false)
  })
})
```

- [ ] **Step 2: Run** → FAIL (`bestAliasScore` is not exported).

- [ ] **Step 3: Implement.** `scoreMatch` takes an item with `itemName`/`_normName`/`_keyName`. Add below it:

```ts
/** Best fuzzy score of a description against an item's NAME and the descriptions
 *  other invoices have already taught it (its match rules, any supplier). */
export function bestAliasScore(description: string, itemName: string, aliases: string[]): { score: number; viaAlias: boolean } {
  const descNorm = normalize(description)
  const descKey  = keyWords(description)
  const asItem = (name: string) => ({ itemName: name }) as unknown as InventoryItem
  const nameScore = scoreMatch(description, asItem(itemName), descNorm, descKey)
  let best = nameScore, viaAlias = false
  for (const a of aliases) {
    const s = scoreMatch(description, asItem(a), descNorm, descKey)
    if (s > best) { best = s; viaAlias = true }
  }
  return { score: best, viaAlias }
}
```

Load aliases once in `matchLineItems`, after `inventoryItems`:

```ts
  const aliasRows = await prisma.invoiceMatchRule.findMany({ select: { inventoryItemId: true, rawDescription: true } }).catch(() => [])
  const aliasesByItem = new Map<string, string[]>()
  for (const r of aliasRows) aliasesByItem.set(r.inventoryItemId, [...(aliasesByItem.get(r.inventoryItemId) ?? []), r.rawDescription])
```

Fuzzy loop — replace the body and the confidence line:

```ts
    let bestViaAlias = false
    for (const item of normalizedItems) {
      let score = scoreMatch(ocrItem.description, item, descNorm, descKey)
      let via = false
      for (const a of aliasesByItem.get(item.id) ?? []) {
        const s = scoreMatch(ocrItem.description, { itemName: a } as unknown as InventoryItem, descNorm, descKey)
        if (s > score) { score = s; via = true }
      }
      if (score > bestScore) { bestScore = score; bestItem = item; bestViaAlias = via }
    }
    // A match won through ANOTHER wording is a hint, not a fact — same downgrade a
    // generic learned rule gets. A human confirms it; approval then saves a rule
    // under this supplier and the next invoice is HIGH.
    const raw = confidenceFromScore(bestScore)
    const confidence: MatchConfidence = bestViaAlias && raw === 'HIGH' ? 'MEDIUM' : raw
```

Tier 0 — also accept an offer SKU. After `codeRuleMap` is built and `offerRows` loaded, add:

```ts
  // Offer SKUs are the supplier library itself: (supplier, SKU) → item, even when
  // no match rule was ever saved (e.g. an offer that arrived through a merge).
  const offerBySku = new Map<string, string>()
  for (const o of offerRows) if (o.supplierItemCode && !offerBySku.has(o.supplierItemCode)) offerBySku.set(o.supplierItemCode, o.inventoryItemId)
  const itemById = new Map(inventoryItems.map(i => [i.id, i]))
```

and inside the map callback, directly after the `if (codeRule?.inventoryItem) { … }` block:

```ts
    const skuItem = ocrItem.supplierItemCode ? itemById.get(offerBySku.get(ocrItem.supplierItemCode) ?? '') : undefined
    if (skuItem) {
      const ocrPack = (ocrItem.packQty || ocrItem.packSize)
        ? { packQty: ocrItem.packQty ?? 1, packSize: ocrItem.packSize ?? 1, packUOM: ocrItem.packUOM ?? 'each' }
        : parseFormatFromDescription(ocrItem.description)
      return buildMatchResult(ocrItem, skuItem as unknown as InventoryItem, 'HIGH', 100, ocrPack, offerByItemId.get(skuItem.id) ?? null)
    }
```

`offerRows` is declared after `codeRuleMap` today — if `offerBySku` needs it earlier, move the `offerRows` block up; nothing else depends on its position. `inventoryItems` already excludes inactive rows, so a tombstone's SKU can only resolve through the survivor's re-pointed offer.

- [ ] **Step 4: Run.** `npx vitest run src/lib/__tests__/invoice-matcher-aliases.test.ts` → PASS; `npm test` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoice-matcher.ts src/lib/__tests__/invoice-matcher-aliases.test.ts
git commit -m "feat(invoices): match on offer SKUs and learned descriptions from any supplier"
```

---

### Task 7: Invoice review — stop new duplicates

**Files:**
- Create: `src/lib/invoice/new-supplier.ts`
- Test: `src/lib/__tests__/new-supplier.test.ts`
- Modify: `src/components/invoices/v2/issues.tsx` (new `NewSupplierNote`, beside `SupplierSwitchNote :500`), `src/components/invoices/v2/card.tsx` (render it), `src/components/invoices/v2/InvoiceReviewDrawer.tsx` (`AddNewItemModal :1394`)

**Interfaces:**
- Consumes: `offerForSupplier`, `SupplierRef` (`resolution.ts`).
- Produces: `isNewSupplierForItem(item: ScanItem, ref: SupplierRef): boolean`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import { isNewSupplierForItem } from '@/lib/invoice/new-supplier'
import type { ScanItem } from '@/components/invoices/types'

const base = { action: 'ADD_SUPPLIER', matchedItem: { supplierPrices: [{ supplierId: 'a', supplierName: 'Sysco' }] } } as unknown as ScanItem

describe('isNewSupplierForItem', () => {
  it('true when the item has offers but none from this supplier', () => {
    expect(isNewSupplierForItem(base, { supplierId: 'b', supplierName: 'North Arm Farms' })).toBe(true)
  })
  it('false when this supplier already has an offer', () => {
    expect(isNewSupplierForItem(base, { supplierId: 'a', supplierName: 'Sysco' })).toBe(false)
  })
  it('false for unmatched, skipped, or supplier-less lines, and for items with no offers', () => {
    expect(isNewSupplierForItem({ ...base, matchedItem: null } as ScanItem, { supplierName: 'X' })).toBe(false)
    expect(isNewSupplierForItem({ ...base, action: 'SKIP' } as ScanItem, { supplierName: 'X' })).toBe(false)
    expect(isNewSupplierForItem(base, {})).toBe(false)
    expect(isNewSupplierForItem({ ...base, matchedItem: { supplierPrices: [] } } as unknown as ScanItem, { supplierName: 'X' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/lib/invoice/new-supplier.ts`:

```ts
import type { ScanItem } from '@/components/invoices/types'
import { offerForSupplier, type SupplierRef } from '@/lib/invoice/resolution'

/** This line brings a supplier the matched item has never been bought from. */
export function isNewSupplierForItem(item: ScanItem, ref: SupplierRef): boolean {
  if (!item.matchedItem || item.action === 'SKIP' || item.action === 'CREATE_NEW') return false
  if (!ref.supplierId && !ref.supplierName) return false
  const offers = item.matchedItem.supplierPrices ?? []
  return offers.length > 0 && !offerForSupplier(item, ref)
}
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: `NewSupplierNote`** in `issues.tsx`, module scope, below `SupplierSwitchNote` (same info-tone classes):

```tsx
// ─── NewSupplierNote ───────────────────────────────────────────────────────────
// First purchase of this item from this supplier. Not an issue: approving records
// the supplier with ITS OWN pack under the same item — no second item needed.
export function NewSupplierNote({ item, sessionSupplier }: { item: ScanItem; sessionSupplier: { supplierId: string | null; supplierName: string | null } }) {
  if (!isNewSupplierForItem(item, sessionSupplier)) return null
  const pack = item.invoicePackQty && item.invoicePackSize
    ? `${Number(item.invoicePackQty)} × ${Number(item.invoicePackSize)} ${item.invoicePackUOM ?? ''}`.trim()
    : null
  return (
    <div className="mx-4 my-2.5 flex items-start gap-2.5 bg-blue-soft border border-blue-soft rounded-lg px-3 py-2.5">
      <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-blue-soft text-blue-text shrink-0">
        New supplier
      </span>
      <span className="text-[12.5px] text-ink-2 leading-[1.45]">
        First time buying <b className="font-semibold text-ink">{item.matchedItem?.itemName}</b> from{' '}
        {sessionSupplier.supplierName ?? 'this supplier'}. It will be added as a supplier of this item
        {pack ? <> with its own pack (<b className="font-semibold text-ink">{pack}</b>)</> : null} — your costing price does not change.
      </span>
    </div>
  )
}
```

Import `isNewSupplierForItem`. In `card.tsx`, render `<NewSupplierNote item={item} sessionSupplier={sessionSupplier} />` directly after the existing `<SupplierSwitchNote … />` (`grep -n "SupplierSwitchNote" src/components/invoices/v2/card.tsx`).

- [ ] **Step 6: "Add as a supplier instead" banner** in `AddNewItemModal`. Add two optional props, `similar?: { id: string; itemName: string; recipeCount: number } | null` and `onUseExisting?: (itemId: string) => void`. At the top of the modal body:

```tsx
        {similar && onUseExisting && (
          <div className="mb-3 flex items-start gap-2.5 bg-gold-soft border border-gold-soft rounded-lg px-3 py-2.5">
            <span className="text-[12.5px] text-ink-2 leading-[1.45] flex-1">
              Looks like <b className="font-semibold text-ink">{similar.itemName}</b>
              {similar.recipeCount > 0 ? <> (used in {similar.recipeCount} recipe{similar.recipeCount === 1 ? '' : 's'})</> : null}.
              A second item splits its stock away from your recipes.
            </span>
            <button type="button" onClick={() => onUseExisting(similar.id)}
              className="shrink-0 text-[12px] font-semibold text-ink underline underline-offset-2">
              Add as a supplier instead
            </button>
          </div>
        )}
```

In the parent (`:1364`), compute `similar` when the modal opens: `fetch('/api/inventory/search?q=' + encodeURIComponent(line.rawDescription) + '&limit=1&withUsage=1')`, take the first hit with `score >= 40`. `onUseExisting(id)` calls the drawer's existing "link this line to item" handler (the one the match picker uses — `grep -n "matchedItemId" src/components/invoices/v2/InvoiceReviewDrawer.tsx`) with `action: 'ADD_SUPPLIER'`, then closes the modal.

`src/app/api/inventory/search/route.ts`: when `withUsage=1`, add `_count: { select: { recipeIngredients: true } }` to the select and return `recipeCount` and the existing fuzzy `score` on each row. The route is currently unauthenticated (known gap) — add the repo-standard guard while here:

```ts
  try { await requireSession() } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
```

- [ ] **Step 7: Verify in the browser.** preview_start the dev server; open an invoice in review whose supplier is new for a matched item → the "New supplier" note shows and the default action is `ADD_SUPPLIER`. Open Create New on a line resembling an existing item → banner shows; clicking it links the line. `read_console_messages` clean. Screenshot both.

- [ ] **Step 8: Commit**

```bash
git add src/lib/invoice/new-supplier.ts src/lib/__tests__/new-supplier.test.ts src/components/invoices/v2 src/app/api/inventory/search/route.ts
git commit -m "feat(invoices): a new supplier joins the existing item instead of spawning a duplicate"
```

---

### Task 8: Merge planner (pure)

**Files:**
- Create: `src/lib/item-merge.ts`
- Test: `src/lib/__tests__/item-merge.test.ts`

**Interfaces:**
- Produces (all exported):

```ts
export type MergeGuard = 'SAME_ITEM' | 'PREP_OWNED' | 'TOMBSTONE' | 'OPEN_COUNT' | 'NO_BRIDGE' | 'NEEDS_ON_HAND'
export interface MergeItemRow {
  id: string; itemName: string; baseUnit: string; dimension: Dimension; countUnit: string
  packChain: PackLink[]; pricing: Pricing; stockOnHand: number
  eachMeasure: EachMeasure | null; densityGPerMl: number | null
  isActive: boolean; mergedIntoId: string | null; ownedByRecipe: boolean; inOpenCount: boolean
  theoreticalOnHand: number
}
export interface MergeRelations {          // everything that points at the ABSORBED row…
  scanItems: { id: string; receivedQtyBase: number | null }[]
  invoiceLineItemIds: string[]; priceAlertIds: string[]; matchRuleIds: string[]; transferIds: string[]
  transfers: { id: string; quantity: number }[]
  wastage: { id: string; qtyWasted: number; unit: string }[]
  recipeIngredients: { id: string; qtyBase: number; unit: string }[]
  countLines: { id: string; expectedQty: number; countedQtyBase: number | null; priceAtCount: number }[]
  snapshots: { id: string; sessionId: string; qtyOnHand: number; unit: string; pricePerBaseUnit: number; totalValue: number; source: string }[]
  offers: { id: string; supplierName: string; supplierId: string | null; lastUpdated: string; isPrimary: boolean }[]
  allocations: { id: string; revenueCenterId: string; quantity: number; parLevel: number | null; reorderQty: number | null }[]
  itemRcs: { id: string; revenueCenterId: string }[]
  latestPurchaseSupplier: { supplierId: string | null; supplierName: string } | null
}
export interface SurvivorRelations {       // …and what the SURVIVOR already has that can collide
  offers: { id: string; supplierName: string; lastUpdated: string }[]
  allocations: { id: string; revenueCenterId: string; quantity: number }[]
  itemRcs: { revenueCenterId: string }[]
  snapshots: { id: string; sessionId: string; qtyOnHand: number; totalValue: number; source: string }[]
}
export type MergeOp =
  | { t: 'repoint'; table: RepointTable; ids: string[] }
  | { t: 'update'; table: UpdateTable; id: string; before: Record<string, unknown>; after: Record<string, unknown> }
  | { t: 'delete'; table: DeleteTable; row: Record<string, unknown> }        // full row kept for undo
  | { t: 'create'; table: 'InventorySupplierPrice'; row: Record<string, unknown> }
export interface MergeManifest { survivorId: string; absorbedId: string; factor: number; ops: MergeOp[] }
export type MergePlan = { ok: true; manifest: MergeManifest; summary: MergeSummary } | { ok: false; guard: MergeGuard; message: string }
export function baseFactor(absorbed: MergeItemRow, survivor: MergeItemRow): number | null
export function planMerge(survivor: MergeItemRow, absorbed: MergeItemRow, rel: MergeRelations, sRel: SurvivorRelations, opts: { combinedOnHandProvided: boolean }): MergePlan
export function planUndo(manifest: MergeManifest): MergeOp[]
```

`factor` = survivor base units per 1 absorbed base unit. Base units are canonical SI, so same dimension ⇒ 1. Cross dimension goes through the **survivor's** bridge only: COUNT→MASS/VOLUME `each × eachMeasure`, MASS↔VOLUME via `densityGPerMl`. Quantities multiply by `factor`; prices per base unit divide by it; money totals do not move.

- [ ] **Step 1: Failing tests** `src/lib/__tests__/item-merge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { baseFactor, planMerge, planUndo, type MergeItemRow, type MergeRelations, type SurvivorRelations } from '@/lib/item-merge'

const row = (over: Partial<MergeItemRow>): MergeItemRow => ({
  id: 'x', itemName: 'x', baseUnit: 'g', dimension: 'MASS', countUnit: 'kg',
  packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 10 }, stockOnHand: 0,
  eachMeasure: null, densityGPerMl: null, isActive: true, mergedIntoId: null,
  ownedByRecipe: false, inOpenCount: false, theoreticalOnHand: 0, ...over,
})
const noRel: MergeRelations = {
  scanItems: [], invoiceLineItemIds: [], priceAlertIds: [], matchRuleIds: [], transferIds: [], transfers: [],
  wastage: [], recipeIngredients: [], countLines: [], snapshots: [], offers: [], allocations: [], itemRcs: [],
  latestPurchaseSupplier: null,
}
const noSRel: SurvivorRelations = { offers: [], allocations: [], itemRcs: [], snapshots: [] }
const S = row({ id: 'S', itemName: 'kennebec potato' })
const A = row({ id: 'A', itemName: 'Potatoes, Kennebec O/S' })
const plan = (s = S, a = A, rel = noRel, sRel = noSRel, provided = false) => planMerge(s, a, rel, sRel, { combinedOnHandProvided: provided })

describe('baseFactor', () => {
  it('same dimension → 1', () => expect(baseFactor(A, S)).toBe(1))
  it('each → g through the survivor each-measure', () => {
    expect(baseFactor(row({ baseUnit: 'each', dimension: 'COUNT' }), row({ eachMeasure: { qty: 0.3, unit: 'kg' } }))).toBe(300)
  })
  it('g → each through the survivor each-measure', () => {
    expect(baseFactor(row({}), row({ baseUnit: 'each', dimension: 'COUNT', eachMeasure: { qty: 250, unit: 'g' } }))).toBeCloseTo(1 / 250)
  })
  it('ml → g through density', () => {
    expect(baseFactor(row({ baseUnit: 'ml', dimension: 'VOLUME' }), row({ densityGPerMl: 0.92 }))).toBeCloseTo(0.92)
  })
  it('no bridge → null', () => expect(baseFactor(row({ baseUnit: 'each', dimension: 'COUNT' }), S)).toBeNull())
})

describe('guards', () => {
  const guard = (p: ReturnType<typeof plan>) => (p.ok ? null : p.guard)
  it('same item', () => expect(guard(plan(S, S))).toBe('SAME_ITEM'))
  it('PREP-owned, either side', () => {
    expect(guard(plan(row({ id: 'S', ownedByRecipe: true }), A))).toBe('PREP_OWNED')
    expect(guard(plan(S, row({ id: 'A', ownedByRecipe: true })))).toBe('PREP_OWNED')
  })
  it('tombstone', () => expect(guard(plan(S, row({ id: 'A', mergedIntoId: 'Z', isActive: false })))).toBe('TOMBSTONE'))
  it('open count', () => expect(guard(plan(S, row({ id: 'A', inOpenCount: true })))).toBe('OPEN_COUNT'))
  it('no bridge', () => expect(guard(plan(S, row({ id: 'A', baseUnit: 'each', dimension: 'COUNT' })))).toBe('NO_BRIDGE'))
  it('absorbed on-hand > 0 needs a combined on-hand', () => {
    expect(guard(plan(S, row({ id: 'A', theoreticalOnHand: 12 })))).toBe('NEEDS_ON_HAND')
    expect(plan(S, row({ id: 'A', theoreticalOnHand: 12 }), noRel, noSRel, true).ok).toBe(true)
  })
})

describe('planMerge ops', () => {
  it('re-points plain tables and tombstones the absorbed row', () => {
    const p = plan(S, A, { ...noRel, scanItems: [{ id: 'si1', receivedQtyBase: null }], matchRuleIds: ['r1'], priceAlertIds: ['p1'] })
    if (!p.ok) throw new Error(p.message)
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'InvoiceScanItem', ids: ['si1'] })
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'InvoiceMatchRule', ids: ['r1'] })
    expect(p.manifest.ops).toContainEqual({
      t: 'update', table: 'InventoryItem', id: 'A',
      before: { isActive: true, mergedIntoId: null }, after: { isActive: false, mergedIntoId: 'S' },
    })
  })

  it('converts quantities when the base unit changes (each → g, ×300)', () => {
    const s = row({ id: 'S', eachMeasure: { qty: 300, unit: 'g' } })
    const a = row({ id: 'A', baseUnit: 'each', dimension: 'COUNT' })
    const p = plan(s, a, {
      ...noRel,
      scanItems: [{ id: 'si1', receivedQtyBase: 10 }],
      recipeIngredients: [{ id: 'ri1', qtyBase: 2, unit: 'each' }],
      countLines: [{ id: 'cl1', expectedQty: 4, countedQtyBase: 5, priceAtCount: 0.9 }],
    })
    if (!p.ok) throw new Error(p.message)
    const upd = (id: string) => p.manifest.ops.find(o => o.t === 'update' && o.id === id) as { after: Record<string, number | string> }
    expect(upd('si1').after.receivedQtyBase).toBe(3000)
    expect(upd('ri1').after).toEqual({ qtyBase: 600, unit: 'g' })
    expect(upd('cl1').after.countedQtyBase).toBe(1500)
    expect(upd('cl1').after.priceAtCount).toBeCloseTo(0.003)
  })

  it('offer collision keeps the newer, deletes the older, never leaves two primaries', () => {
    const p = plan(S, A,
      { ...noRel, offers: [{ id: 'oA', supplierName: 'Sysco', supplierId: 's', lastUpdated: '2026-09-01', isPrimary: true }] },
      { ...noSRel, offers: [{ id: 'oS', supplierName: 'Sysco', lastUpdated: '2026-08-01' }] })
    if (!p.ok) throw new Error(p.message)
    expect(p.manifest.ops.some(o => o.t === 'delete' && o.table === 'InventorySupplierPrice' && o.row.id === 'oS')).toBe(true)
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'InventorySupplierPrice', ids: ['oA'] })
    expect(p.manifest.ops.some(o => o.t === 'update' && o.id === 'oA' && o.after.isPrimary === false)).toBe(true)
  })

  it('synthesizes an offer when the absorbed row has purchases but none', () => {
    const p = plan(S, row({ id: 'A', packChain: [{ unit: 'lb', per: 453.592 }] }),
      { ...noRel, scanItems: [{ id: 'si1', receivedQtyBase: null }], latestPurchaseSupplier: { supplierId: null, supplierName: 'North Arm Farms' } })
    if (!p.ok) throw new Error(p.message)
    const created = p.manifest.ops.find(o => o.t === 'create') as { row: Record<string, unknown> }
    expect(created.row).toMatchObject({ inventoryItemId: 'S', supplierName: 'North Arm Farms', isPrimary: false, packChain: [{ unit: 'lb', per: 453.592 }] })
  })

  it('two snapshots of one count session collapse into one, stronger source wins', () => {
    const p = plan(S, A,
      { ...noRel, snapshots: [{ id: 'nA', sessionId: 'c1', qtyOnHand: 500, unit: 'g', pricePerBaseUnit: 0.01, totalValue: 5, source: 'COUNTED' }] },
      { ...noSRel, snapshots: [{ id: 'nS', sessionId: 'c1', qtyOnHand: 1000, totalValue: 10, source: 'THEORETICAL' }] })
    if (!p.ok) throw new Error(p.message)
    const upd = p.manifest.ops.find(o => o.t === 'update' && o.id === 'nS') as { after: Record<string, unknown> }
    expect(upd.after).toMatchObject({ qtyOnHand: 1500, totalValue: 15, source: 'COUNTED' })
    expect(p.manifest.ops.some(o => o.t === 'delete' && o.table === 'InventorySnapshot' && o.row.id === 'nA')).toBe(true)
  })

  it('allocations union: collision sums, otherwise re-points', () => {
    const p = plan(S, A,
      { ...noRel, allocations: [
        { id: 'aA1', revenueCenterId: 'rc1', quantity: 5, parLevel: null, reorderQty: null },
        { id: 'aA2', revenueCenterId: 'rc2', quantity: 7, parLevel: null, reorderQty: null } ] },
      { ...noSRel, allocations: [{ id: 'aS1', revenueCenterId: 'rc1', quantity: 10 }] })
    if (!p.ok) throw new Error(p.message)
    expect((p.manifest.ops.find(o => o.t === 'update' && o.id === 'aS1') as { after: { quantity: number } }).after.quantity).toBe(15)
    expect(p.manifest.ops).toContainEqual({ t: 'repoint', table: 'StockAllocation', ids: ['aA2'] })
  })
})

describe('planUndo', () => {
  it('is the exact inverse, in reverse order', () => {
    const p = plan(S, A, { ...noRel, scanItems: [{ id: 'si1', receivedQtyBase: null }] })
    if (!p.ok) throw new Error(p.message)
    const undo = planUndo(p.manifest)
    expect(undo[0]).toEqual({ t: 'update', table: 'InventoryItem', id: 'A', before: { isActive: false, mergedIntoId: 'S' }, after: { isActive: true, mergedIntoId: null } })
    expect(undo.at(-1)).toEqual({ t: 'repoint', table: 'InvoiceScanItem', ids: ['si1'] }) // executor re-points to absorbedId
  })
})
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement** `src/lib/item-merge.ts`:

```ts
// Merge two inventory items that are the same good. PURE: rows in, manifest out.
// The executor (item-merge-exec.ts) applies a manifest; undo applies planUndo().
// Spec: docs/superpowers/specs/2026-09-20-item-consolidation-design.md §1.

import type { Dimension, PackLink, Pricing, EachMeasure } from '@/lib/item-model'
import { dimensionOf } from '@/lib/item-model'
import { UNIT_FACTORS, canonicalUom } from '@/lib/uom'

export type MergeGuard = 'SAME_ITEM' | 'PREP_OWNED' | 'TOMBSTONE' | 'OPEN_COUNT' | 'NO_BRIDGE' | 'NEEDS_ON_HAND'
export type RepointTable =
  | 'InvoiceScanItem' | 'InvoiceLineItem' | 'PriceAlert' | 'InvoiceMatchRule' | 'StockTransfer' | 'WastageLog'
  | 'RecipeIngredient' | 'CountLine' | 'InventorySnapshot' | 'InventorySupplierPrice' | 'StockAllocation' | 'ItemRevenueCenter'
export type UpdateTable = RepointTable | 'InventoryItem'
export type DeleteTable = 'InventorySupplierPrice' | 'InventorySnapshot' | 'StockAllocation' | 'ItemRevenueCenter'

// (MergeItemRow, MergeRelations, SurvivorRelations, MergeOp, MergeManifest, MergePlan — exactly as in the Interfaces block above)

export interface MergeSummary {
  invoiceLines: number; recipeLines: number; countLines: number; snapshots: number
  offersMoved: number; offersDropped: number; offerSynthesized: boolean; factor: number
  absorbedOnHand: number; survivorOnHand: number
}

const SOURCE_RANK: Record<string, number> = { COUNTED: 3, CARRIED: 2, THEORETICAL: 1, SKIPPED: 0 }
/** value of `qty unit` in its dimension's base unit */
const toBase = (qty: number, unit: string) => qty * (UNIT_FACTORS[canonicalUom(unit)]?.toBase ?? 1)

export function baseFactor(absorbed: MergeItemRow, survivor: MergeItemRow): number | null {
  if (absorbed.dimension === survivor.dimension) return 1
  const each = survivor.eachMeasure
  if (each && each.qty > 0 && (absorbed.dimension === 'COUNT') !== (survivor.dimension === 'COUNT')) {
    const measured = absorbed.dimension === 'COUNT' ? survivor.dimension : absorbed.dimension
    if (dimensionOf(each.unit) !== measured) return null
    const basePerEach = toBase(each.qty, each.unit)
    return absorbed.dimension === 'COUNT' ? basePerEach : 1 / basePerEach
  }
  const d = survivor.densityGPerMl
  if (d && d > 0 && absorbed.dimension !== 'COUNT' && survivor.dimension !== 'COUNT')
    return absorbed.dimension === 'VOLUME' ? d : 1 / d
  return null
}

export function planMerge(
  survivor: MergeItemRow, absorbed: MergeItemRow, rel: MergeRelations, sRel: SurvivorRelations,
  opts: { combinedOnHandProvided: boolean },
): MergePlan {
  const fail = (guard: MergeGuard, message: string): MergePlan => ({ ok: false, guard, message })
  if (survivor.id === absorbed.id) return fail('SAME_ITEM', 'Pick a different item to merge in.')
  for (const r of [survivor, absorbed]) {
    if (r.ownedByRecipe) return fail('PREP_OWNED', `${r.itemName} is made by a prep recipe — prep items can’t be merged.`)
    if (r.mergedIntoId || !r.isActive) return fail('TOMBSTONE', `${r.itemName} is inactive or was already merged.`)
    if (r.inOpenCount) return fail('OPEN_COUNT', `${r.itemName} is on a count that is still open. Finalize or discard it first.`)
  }
  const k = baseFactor(absorbed, survivor)
  if (k === null)
    return fail('NO_BRIDGE', `${absorbed.itemName} is tracked in ${absorbed.baseUnit} and ${survivor.itemName} in ${survivor.baseUnit}. Add ${
      absorbed.dimension === 'COUNT' || survivor.dimension === 'COUNT' ? 'an each-measure (weight of one each)' : 'a density'
    } to ${survivor.itemName} first.`)
  if (absorbed.theoreticalOnHand > 0 && !opts.combinedOnHandProvided)
    return fail('NEEDS_ON_HAND', `${absorbed.itemName} still shows stock on hand. Enter the combined on-hand for both.`)

  const ops: MergeOp[] = []
  const repoint = (table: RepointTable, ids: string[]) => { if (ids.length) ops.push({ t: 'repoint', table, ids }) }
  const conv = k !== 1

  // ── plain re-points ──────────────────────────────────────────────────────────
  repoint('InvoiceScanItem', rel.scanItems.map(s => s.id))
  repoint('InvoiceLineItem', rel.invoiceLineItemIds)
  repoint('PriceAlert', rel.priceAlertIds)
  repoint('InvoiceMatchRule', rel.matchRuleIds)
  repoint('StockTransfer', rel.transfers.map(t => t.id))
  repoint('WastageLog', rel.wastage.map(w => w.id))
  repoint('RecipeIngredient', rel.recipeIngredients.map(r => r.id))
  repoint('CountLine', rel.countLines.map(c => c.id))

  // ── base-unit conversion (only when the base unit actually changes) ──────────
  if (conv) {
    for (const s of rel.scanItems) if (s.receivedQtyBase != null)
      ops.push({ t: 'update', table: 'InvoiceScanItem', id: s.id, before: { receivedQtyBase: s.receivedQtyBase }, after: { receivedQtyBase: s.receivedQtyBase * k } })
    for (const t of rel.transfers)
      ops.push({ t: 'update', table: 'StockTransfer', id: t.id, before: { quantity: t.quantity }, after: { quantity: t.quantity * k } })
    for (const w of rel.wastage) if (dimensionOf(w.unit) !== survivor.dimension)
      ops.push({ t: 'update', table: 'WastageLog', id: w.id, before: { qtyWasted: w.qtyWasted, unit: w.unit }, after: { qtyWasted: toBase(w.qtyWasted, w.unit) * k, unit: survivor.baseUnit } })
    for (const r of rel.recipeIngredients) if (dimensionOf(r.unit) !== survivor.dimension)
      ops.push({ t: 'update', table: 'RecipeIngredient', id: r.id, before: { qtyBase: r.qtyBase, unit: r.unit }, after: { qtyBase: toBase(r.qtyBase, r.unit) * k, unit: survivor.baseUnit } })
    for (const c of rel.countLines)
      ops.push({ t: 'update', table: 'CountLine', id: c.id,
        before: { expectedQty: c.expectedQty, countedQtyBase: c.countedQtyBase, priceAtCount: c.priceAtCount },
        after:  { expectedQty: c.expectedQty * k, countedQtyBase: c.countedQtyBase == null ? null : c.countedQtyBase * k, priceAtCount: c.priceAtCount / k } })
  }

  // ── snapshots: same count session on both sides → one summed row ─────────────
  const sSnap = new Map(sRel.snapshots.map(s => [s.sessionId, s]))
  const moveSnaps: string[] = []
  for (const n of rel.snapshots) {
    const qty = n.qtyOnHand * k
    const hit = sSnap.get(n.sessionId)
    if (hit) {
      const stronger = (SOURCE_RANK[n.source] ?? 0) > (SOURCE_RANK[hit.source] ?? 0) ? n.source : hit.source
      ops.push({ t: 'update', table: 'InventorySnapshot', id: hit.id,
        before: { qtyOnHand: hit.qtyOnHand, totalValue: hit.totalValue, source: hit.source },
        after:  { qtyOnHand: hit.qtyOnHand + qty, totalValue: hit.totalValue + n.totalValue, source: stronger } })
      ops.push({ t: 'delete', table: 'InventorySnapshot', row: { ...n, inventoryItemId: absorbed.id } })
    } else {
      moveSnaps.push(n.id)
      if (conv) ops.push({ t: 'update', table: 'InventorySnapshot', id: n.id,
        before: { qtyOnHand: n.qtyOnHand, unit: n.unit, pricePerBaseUnit: n.pricePerBaseUnit },
        after:  { qtyOnHand: qty, unit: survivor.baseUnit, pricePerBaseUnit: n.pricePerBaseUnit / k } })
    }
  }
  repoint('InventorySnapshot', moveSnaps)

  // ── offers: unique (item, supplierName); moved offers are never primary ──────
  const sOffer = new Map(sRel.offers.map(o => [o.supplierName, o]))
  const moveOffers: string[] = []
  let dropped = 0
  for (const o of rel.offers) {
    const hit = sOffer.get(o.supplierName)
    if (hit && hit.lastUpdated >= o.lastUpdated) { ops.push({ t: 'delete', table: 'InventorySupplierPrice', row: { ...o, inventoryItemId: absorbed.id } }); dropped++; continue }
    if (hit) { ops.push({ t: 'delete', table: 'InventorySupplierPrice', row: { ...hit, inventoryItemId: survivor.id } }); dropped++ }
    if (o.isPrimary) ops.push({ t: 'update', table: 'InventorySupplierPrice', id: o.id, before: { isPrimary: true }, after: { isPrimary: false } })
    moveOffers.push(o.id)
  }
  repoint('InventorySupplierPrice', moveOffers)
  // Deleting the survivor's own colliding offer may remove its primary; the
  // executor calls ensurePrimary(survivorId) after applying (primary-offer.ts).

  const synth = rel.offers.length === 0 && rel.scanItems.length > 0 && !!rel.latestPurchaseSupplier
    && !sOffer.has(rel.latestPurchaseSupplier!.supplierName) && k === 1
  if (synth) ops.push({ t: 'create', table: 'InventorySupplierPrice', row: {
    inventoryItemId: survivor.id, supplierName: rel.latestPurchaseSupplier!.supplierName,
    supplierId: rel.latestPurchaseSupplier!.supplierId, isPrimary: false,
    lastPrice: absorbed.pricing.mode === 'RATE' ? absorbed.pricing.rate : absorbed.pricing.purchasePrice,
    packChain: absorbed.packChain, pricing: absorbed.pricing,
  } })
  // k !== 1: the absorbed chain is denominated in another base unit, so it cannot
  // be an offer on the survivor. Frozen receivedQtyBase already preserves history.

  // ── per-RC rows: unique (rc, item) ──────────────────────────────────────────
  const sAlloc = new Map(sRel.allocations.map(a => [a.revenueCenterId, a]))
  const moveAllocs: string[] = []
  for (const a of rel.allocations) {
    const hit = sAlloc.get(a.revenueCenterId)
    if (hit) {
      ops.push({ t: 'update', table: 'StockAllocation', id: hit.id, before: { quantity: hit.quantity }, after: { quantity: hit.quantity + a.quantity * k } })
      ops.push({ t: 'delete', table: 'StockAllocation', row: { ...a, inventoryItemId: absorbed.id } })
    } else {
      moveAllocs.push(a.id)
      // par/reorder are in the absorbed row's COUNT unit — meaningless on the survivor.
      ops.push({ t: 'update', table: 'StockAllocation', id: a.id,
        before: { quantity: a.quantity, parLevel: a.parLevel, reorderQty: a.reorderQty },
        after:  { quantity: a.quantity * k, parLevel: null, reorderQty: null } })
    }
  }
  repoint('StockAllocation', moveAllocs)
  const sRc = new Set(sRel.itemRcs.map(r => r.revenueCenterId))
  const moveRcs: string[] = []
  for (const r of rel.itemRcs) {
    if (sRc.has(r.revenueCenterId)) ops.push({ t: 'delete', table: 'ItemRevenueCenter', row: { ...r, inventoryItemId: absorbed.id } })
    else moveRcs.push(r.id)
  }
  repoint('ItemRevenueCenter', moveRcs)

  // ── stock + tombstone (always last) ─────────────────────────────────────────
  if (absorbed.stockOnHand !== 0)
    ops.push({ t: 'update', table: 'InventoryItem', id: survivor.id, before: { stockOnHand: survivor.stockOnHand }, after: { stockOnHand: survivor.stockOnHand + absorbed.stockOnHand * k } })
  ops.push({ t: 'update', table: 'InventoryItem', id: absorbed.id, before: { isActive: true, mergedIntoId: null }, after: { isActive: false, mergedIntoId: survivor.id } })

  return {
    ok: true,
    manifest: { survivorId: survivor.id, absorbedId: absorbed.id, factor: k, ops },
    summary: {
      invoiceLines: rel.scanItems.length, recipeLines: rel.recipeIngredients.length, countLines: rel.countLines.length,
      snapshots: rel.snapshots.length, offersMoved: moveOffers.length, offersDropped: dropped, offerSynthesized: synth,
      factor: k, absorbedOnHand: absorbed.theoreticalOnHand, survivorOnHand: survivor.theoreticalOnHand,
    },
  }
}

/** Inverse ops, reverse order. `repoint` is its own inverse — the executor
 *  targets absorbedId when undoing. create ↔ delete swap; updates swap before/after. */
export function planUndo(manifest: MergeManifest): MergeOp[] {
  return [...manifest.ops].reverse().map((op): MergeOp => {
    if (op.t === 'update') return { ...op, before: op.after, after: op.before }
    if (op.t === 'delete') return { t: 'create', table: op.table as 'InventorySupplierPrice', row: op.row }
    if (op.t === 'create') return { t: 'delete', table: op.table, row: op.row }
    return op
  })
}
```

Widen `MergeOp`'s `create.table` to `DeleteTable | 'InventorySupplierPrice'` so the undo of a snapshot/allocation delete type-checks.

Note on the stock line: adding `absorbed.stockOnHand × k` is the exact rule when the absorbed on-hand is 0 (it adds 0, or a stale non-zero baseline whose theoretical balance is 0 — the guard checked *theoretical*). When it is > 0 the executor's Quick Count overwrites the baseline right after, so this op is harmless either way; it is kept so undo restores the number.

- [ ] **Step 4: Run.** `npx vitest run src/lib/__tests__/item-merge.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/item-merge.ts src/lib/__tests__/item-merge.test.ts
git commit -m "feat(inventory): pure merge planner with a reversible manifest"
```

---

### Task 9: Merge executor, undo, routes

**Files:**
- Create: `src/lib/quick-count.ts` (extracted from `src/app/api/inventory/count/[id]/quick/route.ts:63-110`)
- Modify: `src/app/api/inventory/count/[id]/quick/route.ts` (call the lib)
- Create: `src/lib/item-merge-exec.ts`
- Create: `src/app/api/inventory/[id]/merge/route.ts`, `src/app/api/inventory/merges/[id]/undo/route.ts`

**Interfaces:**
- Consumes: everything Task 8 produces; `computeExpectedForItem(itemId, rcId)` → `{ expectedBase }`; `ensurePrimary(itemId)` from `@/lib/primary-offer`.
- Produces:
  - `recordQuickCount(a: { itemId: string; countedQty: number; selectedUom: string; rcId: string; countedBy: string }): Promise<{ ok: true; sessionId: string } | { ok: false; status: number; error: string }>`
  - `loadMergeInputs(survivorId, absorbedId): Promise<{ survivor, absorbed, rel, sRel } | null>`
  - `executeMerge(manifest: MergeManifest, mergedBy: string): Promise<{ mergeId: string }>`
  - `undoMerge(mergeId: string): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }>`
  - `POST /api/inventory/[id]/merge` body `{ absorbedId: string; dryRun?: boolean; combinedOnHand?: { countedQty: number; selectedUom: string; rcId: string } }` → `200 { ok: true, dryRun, summary, mergeId? }` | `422 { ok: false, guard, message }`
  - `POST /api/inventory/merges/[id]/undo` → `200 { ok: true }` | `409 { error }`
  - `GET /api/inventory/[id]/merge` → `{ merges: { id, absorbedName, mergedAt, canUndo, reason? }[] }`

- [ ] **Step 1: Extract `recordQuickCount`.** Move the quick route's body from `assertCountableUom` through `finalizeCountSession` into `src/lib/quick-count.ts` unchanged, returning `{ ok:false, status:400, error }` for a `CountUomError`, `{ ok:false, status:404, … }` for a missing item/expected, and `{ ok:true, sessionId }`. The route's POST becomes validation → `recordQuickCount(...)` → the existing variance read-back. Run `npm test`; then with the dev server do one quick count on a throwaway item from the inventory drawer to prove the route still works (live DB — pick an item, count it to its current value).

- [ ] **Step 2: Executor** `src/lib/item-merge-exec.ts`:

```ts
import 'server-only'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { asChainItem, PRICING_SELECT } from '@/lib/item-model'
import { computeExpectedForItem } from '@/lib/count-expected'
import { ensurePrimary } from '@/lib/primary-offer'
import { planUndo, type MergeItemRow, type MergeManifest, type MergeOp, type MergeRelations, type SurvivorRelations } from '@/lib/item-merge'

const n = (v: unknown) => (v == null ? 0 : Number(v))
const FK: Record<string, string> = { InvoiceScanItem: 'matchedItemId' } // every other table: inventoryItemId
const delegate = (tx: Prisma.TransactionClient, table: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tx as any)[table.charAt(0).toLowerCase() + table.slice(1)]

async function itemRow(id: string): Promise<MergeItemRow | null> {
  const r = await prisma.inventoryItem.findUnique({
    where: { id },
    select: { id: true, itemName: true, isActive: true, mergedIntoId: true, stockOnHand: true, ...PRICING_SELECT,
      recipe: { select: { id: true } },
      countLines: { where: { session: { status: 'IN_PROGRESS' } }, select: { id: true }, take: 1 } },
  })
  if (!r) return null
  const c = asChainItem(r)
  const expected = await computeExpectedForItem(id, null)
  return {
    id: r.id, itemName: r.itemName, baseUnit: c.baseUnit, dimension: c.dimension, countUnit: c.countUnit ?? c.baseUnit,
    packChain: c.packChain, pricing: c.pricing, stockOnHand: n(r.stockOnHand),
    eachMeasure: c.eachMeasure ?? null, densityGPerMl: c.densityGPerMl ?? null,
    isActive: r.isActive, mergedIntoId: r.mergedIntoId, ownedByRecipe: !!r.recipe, inOpenCount: r.countLines.length > 0,
    theoreticalOnHand: expected?.expectedBase ?? 0,
  }
}

export async function loadMergeInputs(survivorId: string, absorbedId: string) {
  const [survivor, absorbed] = await Promise.all([itemRow(survivorId), itemRow(absorbedId)])
  if (!survivor || !absorbed) return null
  const w = { inventoryItemId: absorbedId }
  const [scan, ili, pa, mr, tr, wl, ri, cl, sn, of, al, rc, last] = await Promise.all([
    prisma.invoiceScanItem.findMany({ where: { matchedItemId: absorbedId }, select: { id: true, receivedQtyBase: true } }),
    prisma.invoiceLineItem.findMany({ where: w, select: { id: true } }),
    prisma.priceAlert.findMany({ where: w, select: { id: true } }),
    prisma.invoiceMatchRule.findMany({ where: w, select: { id: true } }),
    prisma.stockTransfer.findMany({ where: w, select: { id: true, quantity: true } }),
    prisma.wastageLog.findMany({ where: w, select: { id: true, qtyWasted: true, unit: true } }),
    prisma.recipeIngredient.findMany({ where: w, select: { id: true, qtyBase: true, unit: true } }),
    prisma.countLine.findMany({ where: w, select: { id: true, expectedQty: true, countedQtyBase: true, priceAtCount: true } }),
    prisma.inventorySnapshot.findMany({ where: w }),
    prisma.inventorySupplierPrice.findMany({ where: w }),
    prisma.stockAllocation.findMany({ where: w }),
    prisma.itemRevenueCenter.findMany({ where: w }),
    prisma.invoiceScanItem.findFirst({
      where: { matchedItemId: absorbedId, approved: true, session: { supplierName: { not: null } } },
      orderBy: { session: { purchaseDate: 'desc' } },
      select: { session: { select: { supplierId: true, supplierName: true } } },
    }),
  ])
  const rel: MergeRelations = {
    scanItems: scan.map(s => ({ id: s.id, receivedQtyBase: s.receivedQtyBase == null ? null : n(s.receivedQtyBase) })),
    invoiceLineItemIds: ili.map(x => x.id), priceAlertIds: pa.map(x => x.id), matchRuleIds: mr.map(x => x.id),
    transferIds: tr.map(x => x.id), transfers: tr.map(t => ({ id: t.id, quantity: n(t.quantity) })),
    wastage: wl.map(x => ({ id: x.id, qtyWasted: n(x.qtyWasted), unit: x.unit })),
    recipeIngredients: ri.map(x => ({ id: x.id, qtyBase: n(x.qtyBase), unit: x.unit })),
    countLines: cl.map(x => ({ id: x.id, expectedQty: n(x.expectedQty), countedQtyBase: x.countedQtyBase == null ? null : n(x.countedQtyBase), priceAtCount: n(x.priceAtCount) })),
    snapshots: sn.map(x => ({ ...x, qtyOnHand: n(x.qtyOnHand), pricePerBaseUnit: n(x.pricePerBaseUnit), totalValue: n(x.totalValue), snapshotDate: x.snapshotDate.toISOString() })) as never,
    offers: of.map(o => ({ ...o, lastPrice: n(o.lastPrice), packQty: o.packQty == null ? null : n(o.packQty), packSize: o.packSize == null ? null : n(o.packSize), lastUpdated: o.lastUpdated.toISOString() })) as never,
    allocations: al.map(a => ({ id: a.id, revenueCenterId: a.revenueCenterId, quantity: n(a.quantity), parLevel: a.parLevel == null ? null : n(a.parLevel), reorderQty: a.reorderQty == null ? null : n(a.reorderQty) })),
    itemRcs: rc.map(r => ({ id: r.id, revenueCenterId: r.revenueCenterId })),
    latestPurchaseSupplier: last?.session.supplierName ? { supplierId: last.session.supplierId, supplierName: last.session.supplierName } : null,
  }
  const sw = { inventoryItemId: survivorId }
  const [sOf, sAl, sRc, sSn] = await Promise.all([
    prisma.inventorySupplierPrice.findMany({ where: sw }),
    prisma.stockAllocation.findMany({ where: sw, select: { id: true, revenueCenterId: true, quantity: true } }),
    prisma.itemRevenueCenter.findMany({ where: sw, select: { revenueCenterId: true } }),
    prisma.inventorySnapshot.findMany({ where: { ...sw, sessionId: { in: sn.map(x => x.sessionId) } } }),
  ])
  const sRel: SurvivorRelations = {
    offers: sOf.map(o => ({ ...o, lastPrice: n(o.lastPrice), packQty: o.packQty == null ? null : n(o.packQty), packSize: o.packSize == null ? null : n(o.packSize), lastUpdated: o.lastUpdated.toISOString() })) as never,
    allocations: sAl.map(a => ({ ...a, quantity: n(a.quantity) })),
    itemRcs: sRc,
    snapshots: sSn.map(x => ({ id: x.id, sessionId: x.sessionId, qtyOnHand: n(x.qtyOnHand), totalValue: n(x.totalValue), source: x.source })),
  }
  return { survivor, absorbed, rel, sRel }
}
```

Offers and snapshots are loaded as **full rows** (the `as never` casts above) so a `delete` op carries everything needed to re-create the row on undo; the planner only reads the fields declared in its interfaces.

```ts
async function applyOps(tx: Prisma.TransactionClient, ops: MergeOp[], repointTo: string) {
  for (const op of ops) {
    const d = delegate(tx, op.table)
    if (op.t === 'repoint') await d.updateMany({ where: { id: { in: op.ids } }, data: { [FK[op.table] ?? 'inventoryItemId']: repointTo } })
    else if (op.t === 'update') await d.update({ where: { id: op.id }, data: op.after })
    else if (op.t === 'delete') await d.delete({ where: { id: op.row.id as string } })
    else await d.create({ data: op.row })
  }
}

export async function executeMerge(manifest: MergeManifest, mergedBy: string) {
  // Deletes run before re-points of the same table inside the planner's op order
  // only for collisions it removed itself; unique (item, supplier) / (rc, item)
  // can therefore never trip. 30 s: a busy item has hundreds of scan lines.
  const merge = await prisma.$transaction(async tx => {
    const deletes = manifest.ops.filter(o => o.t === 'delete')
    const rest = manifest.ops.filter(o => o.t !== 'delete')
    await applyOps(tx, deletes, manifest.survivorId)
    await applyOps(tx, rest, manifest.survivorId)
    return tx.itemMerge.create({ data: { survivorId: manifest.survivorId, absorbedId: manifest.absorbedId, mergedBy, manifest: manifest as unknown as Prisma.InputJsonValue } })
  }, { timeout: 30_000 })
  await ensurePrimary(manifest.survivorId)
  return { mergeId: merge.id }
}

/** Undo is safe only while nothing NEW hangs off the survivor through a
 *  relationship the merge re-pointed. */
export async function undoBlocker(merge: { survivorId: string; mergedAt: Date }): Promise<string | null> {
  const since = { gte: merge.mergedAt }
  const [inv, cnt] = await Promise.all([
    prisma.invoiceScanItem.count({ where: { matchedItemId: merge.survivorId, approved: true, session: { approvedAt: since } } }),
    prisma.countLine.count({ where: { inventoryItemId: merge.survivorId, session: { finalizedAt: since } } }),
  ])
  if (inv) return 'An invoice has been approved on this item since the merge.'
  if (cnt) return 'This item has been counted since the merge.'
  return null
}

export async function undoMerge(mergeId: string) {
  const merge = await prisma.itemMerge.findUnique({ where: { id: mergeId } })
  if (!merge || merge.undoneAt) return { ok: false as const, status: 404 as const, error: 'Merge not found or already undone.' }
  const blocker = await undoBlocker(merge)
  if (blocker) return { ok: false as const, status: 409 as const, error: `Undo is no longer safe: ${blocker}` }
  const manifest = merge.manifest as unknown as MergeManifest
  await prisma.$transaction(async tx => {
    const ops = planUndo(manifest)
    // creates (restored rows) must land AFTER the re-points free their unique slot
    await applyOps(tx, ops.filter(o => o.t !== 'create'), manifest.absorbedId)
    await applyOps(tx, ops.filter(o => o.t === 'create'), manifest.absorbedId)
    await tx.itemMerge.update({ where: { id: mergeId }, data: { undoneAt: new Date() } })
  }, { timeout: 30_000 })
  await ensurePrimary(manifest.survivorId)
  return { ok: true as const }
}
```

`InvoiceSession.approvedAt` and `CountSession.finalizedAt` both exist (schema `:403`, `:266`). The spec's third undo blocker (a recipe-ingredient edit) has no timestamp column on `RecipeIngredient`; use `Recipe.updatedAt >= mergedAt` for any recipe whose ingredient points at the survivor **and** whose ingredient id is in the manifest's `RecipeIngredient` repoint list — add that as a third `count` in `undoBlocker` with the message "A recipe using this item has been edited since the merge."

- [ ] **Step 3: Routes.** `src/app/api/inventory/[id]/merge/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { planMerge } from '@/lib/item-merge'
import { loadMergeInputs, executeMerge, undoBlocker } from '@/lib/item-merge-exec'
import { recordQuickCount } from '@/lib/quick-count'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const authFail = (e: unknown) => {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
  throw e
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') } catch (e) { return authFail(e) }
  const rows = await prisma.itemMerge.findMany({ where: { survivorId: params.id, undoneAt: null }, orderBy: { mergedAt: 'desc' } })
  const names = await prisma.inventoryItem.findMany({ where: { id: { in: rows.map(r => r.absorbedId) } }, select: { id: true, itemName: true } })
  const nameOf = new Map(names.map(x => [x.id, x.itemName]))
  const merges = await Promise.all(rows.map(async r => {
    const reason = await undoBlocker(r)
    return { id: r.id, absorbedName: nameOf.get(r.absorbedId) ?? 'Unknown item', mergedAt: r.mergedAt, canUndo: !reason, reason }
  }))
  return NextResponse.json({ merges })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession('MANAGER') } catch (e) { return authFail(e) }
  const body = await req.json().catch(() => null)
  const absorbedId = typeof body?.absorbedId === 'string' ? body.absorbedId : ''
  if (!absorbedId) return NextResponse.json({ error: 'absorbedId is required' }, { status: 400 })
  const onHand = body?.combinedOnHand
  const onHandOk = onHand && Number.isFinite(Number(onHand.countedQty)) && Number(onHand.countedQty) >= 0
    && typeof onHand.selectedUom === 'string' && typeof onHand.rcId === 'string' && onHand.rcId

  const inputs = await loadMergeInputs(params.id, absorbedId)
  if (!inputs) return NextResponse.json({ error: 'Item not found' }, { status: 404 })
  const plan = planMerge(inputs.survivor, inputs.absorbed, inputs.rel, inputs.sRel, { combinedOnHandProvided: !!onHandOk })
  if (!plan.ok) return NextResponse.json(plan, { status: 422 })
  if (body?.dryRun) return NextResponse.json({ ok: true, dryRun: true, summary: plan.summary })

  const { mergeId } = await executeMerge(plan.manifest, user.name?.trim() || user.email)
  if (onHandOk) {
    const qc = await recordQuickCount({ itemId: params.id, countedQty: Number(onHand.countedQty), selectedUom: onHand.selectedUom, rcId: onHand.rcId, countedBy: user.name?.trim() || user.email })
    if (!qc.ok) return NextResponse.json({ ok: true, dryRun: false, mergeId, summary: plan.summary, warning: `Merged, but the on-hand count failed: ${qc.error}. Quick-count the item now.` })
  }
  return NextResponse.json({ ok: true, dryRun: false, mergeId, summary: plan.summary })
}
```

`src/app/api/inventory/merges/[id]/undo/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { undoMerge } from '@/lib/item-merge-exec'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e }
  const r = await undoMerge(params.id)
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status })
}
```

- [ ] **Step 4: Verify.** `npm test`; isolated-worktree `npm run build` → both new routes listed `ƒ (Dynamic)`. With the dev server: `POST /api/inventory/<GF English Muffin 4PK id>/merge` `{ absorbedId: <GF ENGLISH MUFFIN id>, dryRun: true }` via `javascript_tool` fetch → `200` with `summary.invoiceLines ≈ 10`, `factor: 1`. A dry run writes nothing. **Do not run a real merge in this task.**

- [ ] **Step 5: Commit**

```bash
git add src/lib/quick-count.ts src/lib/item-merge-exec.ts src/app/api/inventory
git commit -m "feat(inventory): merge + undo API over the planner manifest"
```

---

### Task 10: Merge UI in the item drawer

**Files:**
- Create: `src/components/inventory/MergeItemSheet.tsx`
- Modify: `src/components/inventory/InventoryItemDrawer.tsx` (near `:889`, the `SupplierOffersSection` line)
- Modify: `src/app/api/inventory/search/route.ts` (`withUsage=1` adds `purchaseCount`, `stockOnHand`)

**Interfaces:**
- Consumes: `GET/POST /api/inventory/[id]/merge`, `POST /api/inventory/merges/[id]/undo`, `GET /api/inventory/search?q=&withUsage=1` → rows with `{ id, itemName, baseUnit, recipeCount, purchaseCount, stockOnHand }`.
- Produces: `<MergeItemSheet survivor={{ id, itemName, countUnit, baseUnit }} rcId={string | null} onClose={() => void} onMerged={() => void} />`.

- [ ] **Step 1: Search usage fields.** In the search route's `withUsage` branch add `stockOnHand: true` and `_count: { select: { recipeIngredients: true, invoiceMatches: { where: { approved: true } } } }`; map to `recipeCount`, `purchaseCount`, `stockOnHand: Number(...)`.

- [ ] **Step 2: `MergeItemSheet.tsx`** — one component, three states (`pick` → `preview` → `done`), module-scope sub-components only:

```tsx
'use client'
import { useEffect, useState } from 'react'
import { X, Search, GitMerge } from 'lucide-react'

type Hit = { id: string; itemName: string; baseUnit: string; recipeCount: number; purchaseCount: number; stockOnHand: number }
type Summary = { invoiceLines: number; recipeLines: number; countLines: number; snapshots: number; offersMoved: number; offersDropped: number; offerSynthesized: boolean; factor: number; absorbedOnHand: number; survivorOnHand: number }
type Preview = { ok: true; summary: Summary } | { ok: false; guard: string; message: string }

export function MergeItemSheet({ survivor, rcId, onClose, onMerged }: {
  survivor: { id: string; itemName: string; countUnit: string; baseUnit: string }
  rcId: string | null; onClose: () => void; onMerged: () => void
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [picked, setPicked] = useState<Hit | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [onHand, setOnHand] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const t = setTimeout(() => {
      fetch(`/api/inventory/search?q=${encodeURIComponent(q)}&limit=12&withUsage=1`)
        .then(r => r.json()).then((rows: Hit[]) => setHits(rows.filter(h => h.id !== survivor.id))).catch(() => setHits([]))
    }, 200)
    return () => clearTimeout(t)
  }, [q, survivor.id])

  const post = (extra: Record<string, unknown>) =>
    fetch(`/api/inventory/${survivor.id}/merge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ absorbedId: picked!.id, ...extra }) })

  const needsOnHand = preview && !preview.ok && preview.guard === 'NEEDS_ON_HAND'
  const combined = needsOnHand && onHand !== '' && rcId
    ? { combinedOnHand: { countedQty: Number(onHand), selectedUom: survivor.countUnit, rcId } } : {}

  async function pick(h: Hit) {
    setPicked(h); setPreview(null); setError(null)
    const r = await fetch(`/api/inventory/${survivor.id}/merge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ absorbedId: h.id, dryRun: true }) })
    setPreview(await r.json())
  }
  async function confirm() {
    setBusy(true); setError(null)
    const r = await post(combined)
    const d = await r.json()
    setBusy(false)
    if (!r.ok || !d.ok) { setError(d.message ?? d.error ?? 'Merge failed'); return }
    onMerged(); onClose()
  }

  const canConfirm = !!preview && (preview.ok || (needsOnHand && onHand !== '' && !!rcId))

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div className="relative z-50 bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl p-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[15px] font-semibold text-ink flex items-center gap-2"><GitMerge size={16} /> Merge into {survivor.itemName}</h3>
          <button onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {!picked && (
          <>
            <label className="flex items-center gap-2 border border-line rounded-lg px-3 py-2">
              <Search size={14} className="text-ink-3" />
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Find the duplicate item…" className="flex-1 outline-none text-[14px]" />
            </label>
            <ul className="mt-2 divide-y divide-line">
              {hits.map(h => (
                <li key={h.id}>
                  <button onClick={() => pick(h)} className="w-full text-left py-2.5">
                    <div className="text-[14px] text-ink">{h.itemName}</div>
                    <div className="text-[12px] text-ink-3 font-mono">
                      {h.recipeCount} recipe{h.recipeCount === 1 ? '' : 's'} · {h.purchaseCount} purchase{h.purchaseCount === 1 ? '' : 's'} · {h.stockOnHand} {h.baseUnit} on hand
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {picked && (
          <>
            <p className="text-[13px] text-ink-2 mb-3">
              <b className="text-ink">{picked.itemName}</b> will be folded into <b className="text-ink">{survivor.itemName}</b> and hidden. Its supplier, SKU and pack stay, as a supplier of this item.
            </p>
            {!preview && <p className="text-[13px] text-ink-3">Checking…</p>}
            {preview?.ok && <SummaryList s={preview.summary} />}
            {preview && !preview.ok && (
              <div className={`rounded-lg px-3 py-2.5 text-[13px] ${needsOnHand ? 'bg-blue-soft text-ink-2' : 'bg-red-soft text-red-text'}`}>{preview.message}</div>
            )}
            {needsOnHand && (
              <label className="block mt-3 text-[13px] text-ink-2">
                Combined on hand ({survivor.countUnit}){!rcId && <span className="text-red-text"> — pick a revenue center first</span>}
                <input type="number" min="0" step="any" inputMode="decimal" value={onHand} onChange={e => setOnHand(e.target.value)}
                  className="mt-1 w-full border border-line rounded-lg px-3 py-2 text-[14px]" />
              </label>
            )}
            {error && <p className="mt-3 text-[13px] text-red-text">{error}</p>}
            <div className="mt-4 flex gap-2 justify-end">
              <button onClick={() => { setPicked(null); setPreview(null) }} className="px-3 py-2 text-[13px] text-ink-2">Back</button>
              <button disabled={!canConfirm || busy} onClick={confirm}
                className="px-3 py-2 rounded-lg bg-ink text-white text-[13px] font-semibold disabled:opacity-40">
                {busy ? 'Merging…' : 'Merge items'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SummaryList({ s }: { s: Summary }) {
  const rows: [string, string][] = [
    ['Invoice lines moved', String(s.invoiceLines)],
    ['Recipe lines moved', String(s.recipeLines)],
    ['Count lines / snapshots', `${s.countLines} / ${s.snapshots}`],
    ['Supplier offers', `${s.offersMoved} moved${s.offersDropped ? `, ${s.offersDropped} older duplicate dropped` : ''}${s.offerSynthesized ? ', 1 created from its pack' : ''}`],
  ]
  if (s.factor !== 1) rows.push(['Unit conversion', `× ${Number(s.factor.toPrecision(4))}`])
  return (
    <dl className="text-[13px] divide-y divide-line border border-line rounded-lg">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between px-3 py-2"><dt className="text-ink-3">{k}</dt><dd className="text-ink font-mono">{v}</dd></div>
      ))}
    </dl>
  )
}
```

No `backdrop-blur` on the scrim (known freeze). Every colour token used here (`line`, `ink`, `ink-2`, `ink-3`, `red-soft`, `red-text`, `blue-soft`) is defined in `tailwind.config.ts`.

- [ ] **Step 3: Drawer entry + undo line.** In `InventoryItemDrawer.tsx`, directly after the `<SupplierOffersSection … />` line, MANAGER+ and non-PREP items only (use the drawer's existing role/prep flags — `grep -n "MANAGER\|isPrep\|recipe" src/components/inventory/InventoryItemDrawer.tsx`):

```tsx
                <MergedItemsRow itemId={item.id} refreshKey={mergeTick} onChanged={refreshItem} />
                <button type="button" onClick={() => setMergeOpen(true)}
                  className="mt-2 text-[12.5px] font-semibold text-ink-2 underline underline-offset-2">
                  Merge another item into this one…
                </button>
```

with `const [mergeOpen, setMergeOpen] = useState(false)`, `const [mergeTick, setMergeTick] = useState(0)`, `refreshItem` = the same refetch the `onRepriced` prop on that line already performs, and near the `QuickCountSheet` mount:

```tsx
            {mergeOpen && (
              <MergeItemSheet survivor={{ id: item.id, itemName: item.itemName, countUnit: item.countUnit ?? item.baseUnit ?? 'each', baseUnit: item.baseUnit ?? 'each' }}
                rcId={activeRcId ?? null} onClose={() => setMergeOpen(false)} onMerged={() => { setMergeTick(t => t + 1); refreshItem() }} />
            )}
```

(`activeRcId` = whatever the drawer passes to `QuickCountSheet` as its RC.) `MergedItemsRow` lives at module scope in `MergeItemSheet.tsx`:

```tsx
export function MergedItemsRow({ itemId, refreshKey, onChanged }: { itemId: string; refreshKey: number; onChanged: () => void }) {
  const [merges, setMerges] = useState<{ id: string; absorbedName: string; canUndo: boolean; reason: string | null }[]>([])
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    fetch(`/api/inventory/${itemId}/merge`).then(r => (r.ok ? r.json() : { merges: [] })).then(d => setMerges(d.merges ?? [])).catch(() => setMerges([]))
  }, [itemId, refreshKey])
  if (merges.length === 0) return null
  async function undo(id: string) {
    const r = await fetch(`/api/inventory/merges/${id}/undo`, { method: 'POST' })
    if (!r.ok) { setErr((await r.json()).error ?? 'Undo failed'); return }
    setMerges(m => m.filter(x => x.id !== id)); onChanged()
  }
  return (
    <div className="mt-3 text-[12.5px] text-ink-3 space-y-1">
      {merges.map(m => (
        <div key={m.id} className="flex items-center gap-2">
          <span>Merged: <span className="text-ink-2">{m.absorbedName}</span></span>
          {m.canUndo
            ? <button type="button" onClick={() => undo(m.id)} className="underline underline-offset-2 text-ink-2">Undo</button>
            : <span title={m.reason ?? ''}>· undo no longer safe</span>}
        </div>
      ))}
      {err && <p className="text-red-text">{err}</p>}
    </div>
  )
}
```

- [ ] **Step 4: Browser verification (dry-run only).** preview_start; open `/inventory`, open "ENGLISH MUFFIN GF 4PK", click "Merge another item into this one…", search "gf english", pick "GF ENGLISH MUFFIN" → the summary shows ~10 invoice lines, 1 supplier offer (collision → "older duplicate dropped"), no unit conversion. Pick a PREP item's name → it must not be listed by search (search excludes PREP outputs). Resize to mobile (375) → the sheet is a bottom sheet. `read_console_messages` clean. Screenshot the preview. **Press Back, not Merge.**

- [ ] **Step 5: Commit**

```bash
git add src/components/inventory src/app/api/inventory/search/route.ts
git commit -m "feat(inventory): merge a duplicate item from the item drawer, with undo"
```

---

### Task 11: Audit script, docs, first live merge

**Files:**
- Modify: `scripts/audit-duplicate-items.ts` (one filter)
- Modify: `CLAUDE.md`

- [ ] **Step 1: The audit script is already committed** with this plan (`scripts/audit-duplicate-items.ts`, read-only). Add one filter now that the column exists: in its `findMany` `where`, add `mergedIntoId: null`.

Run: `npx tsx scripts/audit-duplicate-items.ts` → Section A (name-similar groups, `SEVERED` flagged), Section B (bought but in no recipe, with candidate siblings), and a footer. Baseline 2026-09-20: **126 of 422** bought-but-unused, **30** items pooling ≥ 2 offers.

- [ ] **Step 2: CLAUDE.md.** Under "Key data flows → Invoice processing", append to step 5: "…and freezes the line's received base quantity in `InvoiceScanItem.receivedQtyBase`." Add after the "Unit of measure" block:

```markdown
**One item, many suppliers** (`src/lib/invoice/line-format.ts`): an item's own `packChain` is only its PRIMARY supplier's pack. Every invoice line is received and priced through `resolveLineFormat(item, pickOffer(offers, supplier))` — printed pack first (inside `lineReceivedBaseUnits`), then that supplier's offer chain, then the item chain. Never hand `asChainItem(item)` straight to `lineReceivedBaseUnits` for an invoice line. `InvoiceScanItem.receivedQtyBase` is the frozen receipt (a quantity, like `countedQtyBase`); readers prefer it and compute live only when it is null. Approve's pack-disagreement guard compares against **the same supplier's** previous pack (`packReference`), never another supplier's.

**Item merge** (`src/lib/item-merge.ts` planner → `item-merge-exec.ts`): duplicate rows fold into a survivor; the absorbed row becomes a tombstone (`mergedIntoId`, `isActive=false`), its offer/SKU/pack move to the survivor, and the `ItemMerge.manifest` replays in reverse for undo. PREP-owned items never merge. Any new table with an `inventoryItemId` FK MUST be added to the planner's re-point list, or a merge strands its rows on the tombstone. Worklist: `scripts/audit-duplicate-items.ts`.
```

Verify every path named above exists (`ls`) before committing.

- [ ] **Step 3: Commit**

```bash
git add scripts/audit-duplicate-items.ts CLAUDE.md
git commit -m "docs: item consolidation — resolver, frozen receipts, merge; audit worklist"
```

- [ ] **Step 4: First live merge — WITH THE USER, after deploy.** Record the survivor's theoretical on-hand and movement track (item drawer) for "ENGLISH MUFFIN GF 4PK". Merge "GF ENGLISH MUFFIN" into it. Expected: the 10 absorbed purchases appear in the movement track; recipe depletion unchanged; the absorbed row gone from `/inventory` and count sheets. Click Undo → both rows back exactly as before (compare to the recorded numbers). Merge again. Re-run the audit: bought-but-unused drops to 125. The remaining list is the user's, one judgment call at a time — never batch-merge by script.

---

## Self-Review Notes

- **Spec coverage:** §1 data model → Tasks 1, 8, 9 · §2 resolver/approve/freeze/backfill → Tasks 2–5 · §3a → Task 10 · §3b → Task 7 · §3c → Task 6 · §4 tests/rollout/audit → every task + Task 11. Rollout order in the spec (migration → resolver+freeze → matcher+prevention → merge) is the task order.
- **Deviation from the spec, deliberate:** `resolveLineFormat(item, offer)` takes no `line` — the printed-pack rule already lives in `lineReceivedBaseUnits`. A synthesized offer is skipped when the merge converts base units (the absorbed chain is in the wrong unit); frozen `receivedQtyBase` preserves that history instead.
- **Names the implementer must look up in the file before use** (each has a grep in its step): the item drawer's role / PREP / active-RC variables, and the review drawer's "link line to item" handler. Everything else named in this plan was verified against `origin/main` @ a3fe766.
