# Supplier-Aware Pricing (Supplier Offers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track price, pack format, and SKU per (item, supplier) so supplier alternation stops producing false price/format alerts, and surface supplier comparison + price stability on the item page, the invoice drawer, and the purchasing report.

**Architecture:** `InventorySupplierPrice` (already upserted on approval, never read) becomes the full "supplier offer" record. Costing stays last-price-paid (spine untouched). The matcher compares each line against *that supplier's* offer (price + format) instead of the item's single fields; the approve route upserts the offer with the resolved data. Price history/volatility is derived at query time from approved invoice lines. Spec: `docs/superpowers/specs/2026-06-10-supplier-aware-pricing-design.md`.

**Tech Stack:** Next.js 14 App Router · Prisma/Supabase (pgBouncer — migration shadow DB broken, use diff workaround) · Tailwind flat color tokens only (`bg-gold-soft`, `text-green-text` — numbered shades like `amber-600` are BROKEN in this project).

**Verification:** No test suite — `npm run build` is the automated check after every task. node/npm are not on the sandbox PATH: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"` (needs `dangerouslyDisableSandbox`). Never run a build while the preview dev server is running. Work directly on `main` (this project's convention — confirmed by the user's history) unless the controller says otherwise.

---

## Task 1: Schema migration — offer fields + unique constraint

**Files:**
- Modify: `prisma/schema.prisma` (model `InventorySupplierPrice` ~line 378; model `InvoiceScanItem` ~line 327)
- Create: `prisma/migrations/<ts>_supplier_offers/migration.sql` (generated + hand-prepended dedupe)

- [ ] **Step 1: Edit `prisma/schema.prisma`**

In `model InventorySupplierPrice`, add after `isPrimary Boolean @default(false)`:

```prisma
  supplierItemCode     String?  // this supplier's SKU for the item
  packQty              Decimal? // THIS supplier's pack format (qty per case)
  packSize             Decimal?
  packUOM              String?
  lastInvoiceSessionId String?  // provenance: approval that last set this offer

  @@unique([inventoryItemId, supplierName])
```

In `model InvoiceScanItem`, confirm whether an index on `matchedItemId` exists; if not, add next to the model's other index/unique lines:

```prisma
  @@index([matchedItemId])
```

- [ ] **Step 2: Generate the migration (diff workaround — `migrate dev` is broken with P3006)**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
set -a && . ./.env; set +a
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
TS=$(date +%Y%m%d%H%M%S)
mkdir -p "prisma/migrations/${TS}_supplier_offers"
npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script > "prisma/migrations/${TS}_supplier_offers/migration.sql"
cat "prisma/migrations/${TS}_supplier_offers/migration.sql"
```

NOTE: `DIRECT_URL` may be IPv6-only-unreachable; if `migrate diff` fails with P1001, substitute the Supabase **session-mode pooler** URL (same host as `DATABASE_URL`, port 5432, query params stripped) — this worked for the two prior migrations.

Expected SQL: ADD COLUMN ×5 on `InventorySupplierPrice`, CREATE UNIQUE INDEX on `(inventoryItemId, supplierName)`, possibly CREATE INDEX on `InvoiceScanItem(matchedItemId)`. If it contains DROPs of unrelated tables, STOP and report BLOCKED.

- [ ] **Step 3: Prepend a dedupe statement before the unique index**

The live table may hold duplicate `(inventoryItemId, supplierName)` rows (the old code used `findFirst` + create). Edit the generated migration.sql so this runs BEFORE the `CREATE UNIQUE INDEX` line:

```sql
-- Dedupe before unique constraint: keep the most recently updated row per (item, supplier)
DELETE FROM "InventorySupplierPrice" a
USING "InventorySupplierPrice" b
WHERE a."inventoryItemId" = b."inventoryItemId"
  AND a."supplierName"    = b."supplierName"
  AND (a."lastUpdated" < b."lastUpdated"
       OR (a."lastUpdated" = b."lastUpdated" AND a."id" < b."id"));
```

- [ ] **Step 4: Apply, record, regenerate**

```bash
npx prisma db execute --url "$DIRECT_URL" --file "prisma/migrations/${TS}_supplier_offers/migration.sql"
npx prisma migrate resolve --applied "${TS}_supplier_offers"
npx prisma generate
```

(Use the same pooler substitution as Step 2 if needed.)

- [ ] **Step 5: Build**

Run: `npm run build` (after `rm -rf .next`). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(suppliers): offer fields + unique (item,supplier) on InventorySupplierPrice"
```

---

## Task 2: Price-history + volatility library

**Files:**
- Create: `src/lib/supplier-offers.ts`

- [ ] **Step 1: Create `src/lib/supplier-offers.ts`**

```ts
// Server-only helpers for supplier offers: per-supplier price history derived
// from approved invoice lines, and the volatility metric shown in the UI.
// History is NOT stored — every approved scan item already records the price,
// pack, supplier (via its session) and date.

import { prisma } from '@/lib/prisma'
import { getUnitConv } from '@/lib/utils'

export interface SupplierOfferStats {
  id: string
  supplierName: string
  supplierId: string | null
  isPrimary: boolean
  lastPrice: number
  pricePerBaseUnit: number
  packQty: number | null
  packSize: number | null
  packUOM: string | null
  supplierItemCode: string | null
  lastUpdated: string
  lastInvoiceSessionId: string | null
  /** approved purchases of this item from this supplier in the trailing 90 days */
  purchases90d: number
  /** coefficient of variation of $/base-unit over those purchases; null when < 3 */
  volatility: number | null
  stability: 'stable' | 'variable' | 'volatile' | null
  history: { date: string; ppb: number }[]
}

// CV thresholds (spec §4): <5% stable · 5–15% variable · >15% volatile.
export function stabilityOf(volatility: number | null): SupplierOfferStats['stability'] {
  if (volatility === null) return null
  if (volatility < 0.05) return 'stable'
  if (volatility <= 0.15) return 'variable'
  return 'volatile'
}

/** Coefficient of variation (stddev ÷ mean). Null when fewer than 3 samples. */
export function volatilityOf(prices: number[]): number | null {
  if (prices.length < 3) return null
  const mean = prices.reduce((s, p) => s + p, 0) / prices.length
  if (mean <= 0) return null
  const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length
  return Math.sqrt(variance) / mean
}

/**
 * Normalise one approved scan line to $/base-unit.
 * per_weight lines: rate ÷ conv(rateUOM). per_case: price ÷ (packQty × packSize × conv(packUOM)).
 * Falls back to the item's current pack when the line carries none.
 */
export function scanLinePricePerBase(
  line: {
    newPrice: unknown
    rate: unknown
    rateUOM: string | null
    pricingMode: string | null
    invoicePackQty: unknown
    invoicePackSize: unknown
    invoicePackUOM: string | null
  },
  itemFallback: { qtyPerPurchaseUnit: unknown; packSize: unknown; packUOM: string | null },
): number | null {
  const num = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  if (line.pricingMode === 'per_weight' && num(line.rate) && line.rateUOM) {
    const conv = getUnitConv(line.rateUOM)
    return conv > 0 ? num(line.rate)! / conv : null
  }
  const price = num(line.newPrice)
  if (!price) return null
  const pq = num(line.invoicePackQty) ?? num(itemFallback.qtyPerPurchaseUnit) ?? 1
  const ps = num(line.invoicePackSize) ?? num(itemFallback.packSize) ?? 1
  const pu = line.invoicePackUOM ?? itemFallback.packUOM ?? 'each'
  const conv = getUnitConv(pu)
  const divisor = pq * ps * conv
  return divisor > 0 ? price / divisor : null
}

const HISTORY_WINDOW_DAYS = 90

/** Offers for one inventory item, enriched with trailing-90-day history stats. */
export async function getSupplierOffers(inventoryItemId: string): Promise<SupplierOfferStats[]> {
  const [offers, item] = await Promise.all([
    prisma.inventorySupplierPrice.findMany({
      where: { inventoryItemId },
      orderBy: { lastUpdated: 'desc' },
    }),
    prisma.inventoryItem.findUnique({
      where: { id: inventoryItemId },
      select: { qtyPerPurchaseUnit: true, packSize: true, packUOM: true },
    }),
  ])
  if (!item || offers.length === 0) return []

  const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const lines = await prisma.invoiceScanItem.findMany({
    where: {
      matchedItemId: inventoryItemId,
      approved: true,
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] },
      session: { status: 'APPROVED', approvedAt: { gte: since } },
    },
    select: {
      newPrice: true, rate: true, rateUOM: true, pricingMode: true,
      invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
      session: { select: { supplierName: true, approvedAt: true, invoiceDate: true } },
    },
    orderBy: { session: { approvedAt: 'asc' } },
  })

  const bySupplier = new Map<string, { date: string; ppb: number }[]>()
  for (const l of lines) {
    const supplier = l.session?.supplierName
    if (!supplier) continue
    const ppb = scanLinePricePerBase(l, item)
    if (ppb === null) continue
    const date = l.session.invoiceDate ?? l.session.approvedAt?.toISOString().slice(0, 10) ?? ''
    if (!bySupplier.has(supplier)) bySupplier.set(supplier, [])
    bySupplier.get(supplier)!.push({ date, ppb })
  }

  return offers.map(o => {
    const history = bySupplier.get(o.supplierName) ?? []
    const volatility = volatilityOf(history.map(h => h.ppb))
    return {
      id: o.id,
      supplierName: o.supplierName,
      supplierId: o.supplierId,
      isPrimary: o.isPrimary,
      lastPrice: Number(o.lastPrice),
      pricePerBaseUnit: Number(o.pricePerBaseUnit),
      packQty: o.packQty !== null ? Number(o.packQty) : null,
      packSize: o.packSize !== null ? Number(o.packSize) : null,
      packUOM: o.packUOM,
      supplierItemCode: o.supplierItemCode,
      lastUpdated: o.lastUpdated.toISOString(),
      lastInvoiceSessionId: o.lastInvoiceSessionId,
      purchases90d: history.length,
      volatility,
      stability: stabilityOf(volatility),
      history,
    }
  })
}
```

- [ ] **Step 2: Build** — `npm run build`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/supplier-offers.ts
git commit -m "feat(suppliers): offer stats lib — derived price history + volatility"
```

---

## Task 3: Matcher compares against the supplier's own offer

**Files:**
- Modify: `src/lib/invoice-matcher.ts`

Read the whole file first. Current behavior in `buildMatchResult`: `previousPrice = Number(bestItem.purchasePrice)`; price normalisation recomputes the inventory side from `bestItem` purchase fields; `formatMismatch` compares the invoice format against `bestItem.qtyPerPurchaseUnit/packSize/packUOM`.

- [ ] **Step 1: Load this supplier's offers in `matchLineItems`**

After the existing code-rule loading block (search for `codeRuleMap`), add:

```ts
  // ── This supplier's offers: per-supplier last price + pack format ─────────
  // Comparing a line against the supplier's OWN offer (not the item's single
  // price/format fields) is what stops supplier alternation from reading as
  // price changes and format mismatches on every invoice.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let offerRows: any[] = []
  if (supplierName) {
    try {
      offerRows = await prisma.inventorySupplierPrice.findMany({
        where: { supplierName },
      })
    } catch {
      // table/columns missing on a stale client — fall back to item comparison
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offerByItemId = new Map<string, any>()
  for (const o of offerRows) offerByItemId.set(o.inventoryItemId, o)
```

- [ ] **Step 2: Thread the offer into `buildMatchResult`**

Change the signature (keep parameter order — add one optional param at the end):

```ts
function buildMatchResult(
  ocrItem: OcrLineItem,
  bestItem: InventoryItem,
  confidence: MatchConfidence,
  bestScore: number,
  format?: { packQty: number; packSize: number; packUOM: string } | null,
  formatConfirmed = false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offer?: any | null   // InventorySupplierPrice row for (bestItem, session supplier)
): OcrLineItem & MatchResult {
```

Inside, make three substitutions:

(a) `previousPrice` — replace `const previousPrice = Number(bestItem.purchasePrice)` with:

```ts
  // "was" price = what THIS supplier charged last time, when known. Falls back
  // to the item's purchase price (single-supplier behaviour) otherwise.
  const offerLastPrice = offer?.lastPrice != null ? Number(offer.lastPrice) : null
  const previousPrice = offerLastPrice ?? Number(bestItem.purchasePrice)
```

(b) the normalised inventory-side price — in the block computing `invPricePerPackUOM` (search for `invPackTotal`), replace:

```ts
      const invPackTotal = Number(bestItem.qtyPerPurchaseUnit) * Number(bestItem.packSize)
      const invPricePerPackUOM = invPackTotal > 0 ? Number(bestItem.purchasePrice) / invPackTotal : 0
      const normalized = comparePricesNormalized(
        invoicePricePerPackUOM, format.packUOM,
        invPricePerPackUOM,     bestItem.packUOM
      )
```

with:

```ts
      // Inventory side of the comparison: prefer the supplier's own offer
      // (their price over their pack format); fall back to the item fields.
      const offerHasFormat = !!(offer && offer.packQty != null && offer.packSize != null && offer.packUOM)
      const invSidePrice  = offerLastPrice ?? Number(bestItem.purchasePrice)
      const invSideQty    = offerHasFormat ? Number(offer.packQty)  : Number(bestItem.qtyPerPurchaseUnit)
      const invSideSize   = offerHasFormat ? Number(offer.packSize) : Number(bestItem.packSize)
      const invSideUOM    = offerHasFormat ? (offer.packUOM as string) : bestItem.packUOM
      const invPackTotal = invSideQty * invSideSize
      const invPricePerPackUOM = invPackTotal > 0 ? invSidePrice / invPackTotal : 0
      const normalized = comparePricesNormalized(
        invoicePricePerPackUOM, format.packUOM,
        invPricePerPackUOM,     invSideUOM
      )
```

(c) `formatMismatch` — replace the comparison target (search for `const formatMismatch = !!(`):

```ts
  // A format mismatch means the invoice's pack STRUCTURE differs from what
  // THIS supplier is known to ship (their offer), falling back to the item's
  // stored format when no offer format exists yet.
  const fmQty  = offer?.packQty  != null ? Number(offer.packQty)  : Number(bestItem.qtyPerPurchaseUnit)
  const fmSize = offer?.packSize != null ? Number(offer.packSize) : Number(bestItem.packSize)
  const fmUOM  = (offer?.packUOM as string | null) ?? bestItem.packUOM
  const formatMismatch = !!(
    format &&
    (
      Number(format.packQty)  !== fmQty ||
      Number(format.packSize) !== fmSize ||
      normalizeUOM(format.packUOM) !== normalizeUOM(fmUOM)
    )
  )
```

- [ ] **Step 3: Pass the offer at every `buildMatchResult` call site**

There are three call sites (tier-0 code rule, learned description rule, fuzzy match). At each, add the final argument:

```ts
        offerByItemId.get(<theItem>.id) ?? null
```

where `<theItem>` is respectively `codeRule.inventoryItem`, `learned.inventoryItem`, and `bestItem`. (The first two are plain objects with `.id`.)

- [ ] **Step 4: Build** — `npm run build`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoice-matcher.ts
git commit -m "feat(suppliers): matcher compares price/format against the supplier's own offer"
```

---

## Task 4: Approve route — full offer upsert

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts`

- [ ] **Step 1: Replace the supplier-price block with a single upsert**

Find the block beginning `// Upsert supplier price record (non-critical, outside transaction)` (a `findFirst` then `update`/`create`). Replace the whole block with:

```ts
        // Upsert this supplier's offer: their last price, their pack format
        // (post-review resolved values), their SKU. Non-critical, outside the
        // transaction. The unique (inventoryItemId, supplierName) key replaced
        // the old findFirst/create dance (Task 1 migration deduped old rows).
        if (session.supplierName) {
          const offerPack = scanItem.invoicePackQty !== null && scanItem.invoicePackSize !== null
            ? {
                packQty:  Number(scanItem.invoicePackQty),
                packSize: Number(scanItem.invoicePackSize),
                packUOM:  scanItem.invoicePackUOM ?? 'each',
              }
            : {}
          await prisma.inventorySupplierPrice.upsert({
            where: {
              inventoryItemId_supplierName: {
                inventoryItemId: scanItem.matchedItemId,
                supplierName:    session.supplierName,
              },
            },
            create: {
              inventoryItemId:      scanItem.matchedItemId,
              supplierName:         session.supplierName,
              supplierId:           session.supplierId || null,
              lastPrice:            newPurchasePrice,
              pricePerBaseUnit:     newPricePerBase,
              isPrimary:            false,
              supplierItemCode:     scanItem.supplierItemCode ?? null,
              lastInvoiceSessionId: sessionId,
              ...offerPack,
            },
            update: {
              lastPrice:            newPurchasePrice,
              pricePerBaseUnit:     newPricePerBase,
              lastUpdated:          new Date(),
              lastInvoiceSessionId: sessionId,
              ...(session.supplierId ? { supplierId: session.supplierId } : {}),
              ...(scanItem.supplierItemCode ? { supplierItemCode: scanItem.supplierItemCode } : {}),
              ...offerPack,
            },
          }).catch((e) => console.error('[approve] offer upsert failed:', e))
        }
```

Notes: this stays inside the `UPDATE_PRICE / ADD_SUPPLIER` branch where `newPurchasePrice`, `newPricePerBase`, and `scanItem` are in scope, AFTER the price guards (a guarded/skipped line must not update the offer — verify the guards `continue` before this point). The offer's pack format updates from the line's **resolved** `invoicePack*` values — review already gated any mismatch; the `applyInvoiceFormat` consent flag continues to gate only the ITEM's reference format (do not change that logic).

- [ ] **Step 2: Build** — `npm run build`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/invoices/sessions/[id]/approve/route.ts"
git commit -m "feat(suppliers): approve upserts the full supplier offer (price, format, SKU)"
```

---

## Task 5: Suppliers endpoint + set-primary

**Files:**
- Create: `src/app/api/inventory/[id]/suppliers/route.ts`

- [ ] **Step 1: Create the route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getSupplierOffers } from '@/lib/supplier-offers'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/inventory/[id]/suppliers — offers + derived history stats
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const offers = await getSupplierOffers(params.id)
  return NextResponse.json(offers)
}

// PATCH /api/inventory/[id]/suppliers — { offerId } → set primary (clears siblings)
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const body = await req.json().catch(() => ({}))
  if (!body.offerId) return NextResponse.json({ error: 'offerId required' }, { status: 400 })
  const offer = await prisma.inventorySupplierPrice.findFirst({
    where: { id: body.offerId, inventoryItemId: params.id },
    select: { id: true },
  })
  if (!offer) return NextResponse.json({ error: 'Offer not found' }, { status: 404 })
  await prisma.$transaction([
    prisma.inventorySupplierPrice.updateMany({
      where: { inventoryItemId: params.id },
      data: { isPrimary: false },
    }),
    prisma.inventorySupplierPrice.update({
      where: { id: body.offerId },
      data: { isPrimary: true },
    }),
  ])
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Build** — `npm run build`. Expected: PASS; route shows `ƒ (Dynamic)`.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/inventory/[id]/suppliers/route.ts"
git commit -m "feat(suppliers): item suppliers endpoint (offers + stats, set primary)"
```

---

## Task 6: Item drawer "Suppliers" section

**Files:**
- Create: `src/components/inventory/SupplierOffersSection.tsx`
- Modify: `src/components/inventory/InventoryItemDrawer.tsx` (mount only)

- [ ] **Step 1: Create the section component**

```tsx
'use client'
// Suppliers section for the inventory item drawer: one row per supplier offer
// with their pack, SKU, normalized $/base-unit, stability, and a primary star.
// Data: GET /api/inventory/[id]/suppliers (see src/lib/supplier-offers.ts).

import { useEffect, useState, useCallback } from 'react'
import { Star } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import type { SupplierOfferStats } from '@/lib/supplier-offers'

const STABILITY_BADGE: Record<NonNullable<SupplierOfferStats['stability']>, { label: string; cls: string }> = {
  stable:   { label: 'Stable',   cls: 'bg-green-soft text-green-text' },
  variable: { label: 'Variable', cls: 'bg-gold-soft text-gold-2' },
  volatile: { label: 'Volatile', cls: 'bg-red-soft text-red-text' },
}

function fmtPack(o: SupplierOfferStats): string {
  if (o.packQty != null && o.packSize != null && o.packUOM) return `${o.packQty} × ${o.packSize}${o.packUOM}`
  return '—'
}

// $/base shown per kg/L for weight/volume bases so the numbers are readable.
function fmtPpb(ppb: number, baseUnit: string | null): string {
  if (baseUnit === 'g')  return `${formatCurrency(ppb * 1000)}/kg`
  if (baseUnit === 'ml') return `${formatCurrency(ppb * 1000)}/L`
  return `${formatCurrency(ppb)}/${baseUnit ?? 'each'}`
}

export function SupplierOffersSection({ itemId, baseUnit }: { itemId: string; baseUnit: string | null }) {
  const [offers, setOffers] = useState<SupplierOfferStats[] | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    fetch(`/api/inventory/${itemId}/suppliers`)
      .then(r => (r.ok ? r.json() : []))
      .then(setOffers)
      .catch(() => setOffers([]))
  }, [itemId])

  useEffect(() => { load() }, [load])

  const setPrimary = async (offerId: string) => {
    setSaving(true)
    await fetch(`/api/inventory/${itemId}/suppliers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offerId }),
    }).catch(() => {})
    setSaving(false)
    load()
  }

  if (!offers || offers.length === 0) return null
  const cheapest = Math.min(...offers.map(o => o.pricePerBaseUnit).filter(p => p > 0))

  return (
    <div className="space-y-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4 font-semibold">
        Suppliers · {offers.length}
      </div>
      <div className="border border-line rounded-lg divide-y divide-line overflow-hidden">
        {offers.map(o => {
          const isCheapest = offers.length > 1 && o.pricePerBaseUnit > 0 && o.pricePerBaseUnit === cheapest
          const badge = o.stability ? STABILITY_BADGE[o.stability] : null
          return (
            <div key={o.id} className={`flex items-center gap-3 px-3 py-2.5 ${isCheapest ? 'bg-green-soft/40' : 'bg-paper'}`}>
              <button
                type="button"
                disabled={saving}
                onClick={() => setPrimary(o.id)}
                title={o.isPrimary ? 'Primary supplier' : 'Set as primary'}
                className="shrink-0 p-1"
              >
                <Star size={14} className={o.isPrimary ? 'text-gold fill-gold' : 'text-line-2 hover:text-gold'} />
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-ink truncate">{o.supplierName}</div>
                <div className="font-mono text-[10.5px] text-ink-4 mt-0.5">
                  {fmtPack(o)}{o.supplierItemCode ? ` · #${o.supplierItemCode}` : ''} · last {new Date(o.lastUpdated).toLocaleDateString('en-CA')}
                </div>
              </div>
              {badge && (
                <span className={`font-mono text-[9.5px] font-semibold uppercase px-2 py-[3px] rounded-full shrink-0 ${badge.cls}`}>
                  {badge.label}{o.volatility !== null ? ` ±${Math.round(o.volatility * 100)}%` : ''}
                </span>
              )}
              <div className="text-right shrink-0">
                <div className="font-mono text-[13px] font-semibold text-ink tabular-nums">
                  {fmtPpb(o.pricePerBaseUnit, baseUnit)}
                </div>
                <div className="font-mono text-[10.5px] text-ink-4">{formatCurrency(o.lastPrice)}/case{isCheapest ? ' · cheapest' : ''}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

NOTE: importing only the *type* from `@/lib/supplier-offers` is safe in a client component (`import type` is erased at compile time). Do NOT import the functions.

- [ ] **Step 2: Mount it in `InventoryItemDrawer.tsx`**

Read the drawer's read-only view section (the component is ~918 lines; the view starts after `return (` ~line 324 and includes a price-history block — find it with `grep -n "invoiceHistory\|PRICE HISTORY\|priceHistory" src/components/inventory/InventoryItemDrawer.tsx`). Mount the section immediately AFTER the price/purchase info block and BEFORE the price-history block (or after price-history if the structure reads better — judgement call, keep it in the view-mode branch only, not the edit form):

```tsx
import { SupplierOffersSection } from './SupplierOffersSection'
...
  {item && <SupplierOffersSection itemId={item.id} baseUnit={item.baseUnit ?? null} />}
```

(Adapt the `item` variable name to the drawer's actual state variable.)

- [ ] **Step 3: Build** — `npm run build`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/inventory/SupplierOffersSection.tsx src/components/inventory/InventoryItemDrawer.tsx
git commit -m "feat(suppliers): supplier offers section on the inventory item drawer"
```

---

## Task 7: Invoice drawer — supplier-switch note + supplier-scoped big-price gate

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/route.ts` (GET include)
- Modify: `src/components/invoices/types.ts`
- Modify: `src/lib/invoice/resolution.ts`
- Modify: `src/components/invoices/v2/issues.tsx`
- Modify: `src/components/invoices/v2/card.tsx`
- Modify: `src/components/invoices/v2/context.tsx`, `src/components/invoices/v2/InvoiceReviewDrawer.tsx` (context value)

- [ ] **Step 1: Include offers in the session GET**

In the GET handler of `src/app/api/invoices/sessions/[id]/route.ts`, the session `findUnique` includes `scanItems: { include: { matchedItem: true } }` (verify exact shape). Change the matchedItem include to:

```ts
      scanItems: {
        include: {
          matchedItem: {
            include: { supplierPrices: true },
          },
        },
      },
```

(The relation on `InventoryItem` is named `supplierPrices` — `prisma/schema.prisma:98`.)

- [ ] **Step 2: Type the offers on `ScanItem.matchedItem`**

In `src/components/invoices/types.ts`, find the matched-item shape inside `ScanItem` and add:

```ts
  supplierPrices?: Array<{
    id: string
    supplierName: string
    lastPrice: string | number          // Prisma Decimal serialises as string
    pricePerBaseUnit: string | number
    packQty: string | number | null
    packSize: string | number | null
    packUOM: string | null
    isPrimary: boolean
  }>
```

- [ ] **Step 3: Supplier-scoped helpers in `src/lib/invoice/resolution.ts`**

Add (near `isBigPriceChange`):

```ts
// ── Supplier offers on the matched item ──────────────────────────────────────
export function offerForSupplier(item: ScanItem, supplierName: string | null | undefined) {
  if (!supplierName || !item.matchedItem?.supplierPrices) return null
  return item.matchedItem.supplierPrices.find(o => o.supplierName === supplierName) ?? null
}

/** Cheapest OTHER supplier's $/base for the supplier-switch note. */
export function cheapestOtherOffer(item: ScanItem, supplierName: string | null | undefined) {
  const offers = (item.matchedItem?.supplierPrices ?? [])
    .filter(o => o.supplierName !== supplierName && Number(o.pricePerBaseUnit) > 0)
  if (offers.length === 0) return null
  return offers.reduce((min, o) => Number(o.pricePerBaseUnit) < Number(min.pricePerBaseUnit) ? o : min)
}
```

Then change `isBigPriceChange` to be supplier-aware. Current body uses `computeNormalisedPrices(item)` (which compares against the item's spine `pricePerBaseUnit`) falling back to `hasPriceChange(item, 15)`. New version:

```ts
export function isBigPriceChange(item: ScanItem, sessionSupplierName?: string | null): boolean {
  if (!item.matchedItem) return false
  const norm = computeNormalisedPrices(item)
  if (norm) {
    // Compare against THIS supplier's own last $/base when we know it — a
    // supplier switch with both suppliers flat must not demand an ack.
    const offer = offerForSupplier(item, sessionSupplierName)
    const offerPPB = offer ? Number(offer.pricePerBaseUnit) : 0
    if (offerPPB > 0) {
      return Math.abs(((norm.invoicePPB - offerPPB) / offerPPB) * 100) > 15
    }
    return Math.abs(norm.pctDiff) > 15
  }
  return hasPriceChange(item, 15)
}
```

The compiler will flag every caller; pass the session supplier at each (Step 5).

- [ ] **Step 4: `SupplierSwitchNote` component in `issues.tsx`**

Append (reuse the file's existing imports; add `offerForSupplier, cheapestOtherOffer` from `@/lib/invoice/resolution` and `computeNormalisedPrices` is already imported there — verify):

```tsx
// ─── SupplierSwitchNote ────────────────────────────────────────────────────────
// Info-tone note when the spine price moved only because the purchase switched
// suppliers: this supplier's own price is steady, but another supplier set the
// current costing price. Not an issue — needs no decision.
export function SupplierSwitchNote({ item, sessionSupplierName }: { item: ScanItem; sessionSupplierName: string | null }) {
  const norm  = computeNormalisedPrices(item)
  const offer = offerForSupplier(item, sessionSupplierName)
  if (!norm || !offer) return null
  const offerPPB = Number(offer.pricePerBaseUnit)
  if (offerPPB <= 0) return null
  const vsSelf  = Math.abs(((norm.invoicePPB - offerPPB) / offerPPB) * 100)
  const vsSpine = Math.abs(norm.pctDiff)
  // Only when the apparent move is a supplier artifact: steady vs self, ≥3% vs spine.
  if (vsSelf >= 3 || vsSpine < 3) return null
  const other = cheapestOtherOffer(item, sessionSupplierName)
  const factor = norm.baseUnit === 'g' || norm.baseUnit === 'ml' ? 1000 : 1
  const unit   = norm.baseUnit === 'g' ? 'kg' : norm.baseUnit === 'ml' ? 'L' : (norm.baseUnit || 'each')
  return (
    <div className="mx-4 my-2.5 flex items-start gap-2.5 bg-blue-soft border border-blue-soft rounded-lg px-3 py-2.5">
      <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-blue-soft text-blue-text shrink-0">
        Supplier switch
      </span>
      <span className="text-[12.5px] text-ink-2 leading-[1.45]">
        {sessionSupplierName ?? 'This supplier'}&rsquo;s price is steady at{' '}
        <b className="font-semibold text-ink">{formatCurrency(norm.invoicePPB * factor)}/{unit}</b> — your costing price
        currently comes from a different supplier
        {other ? <> ({other.supplierName} <b className="font-semibold text-ink">{formatCurrency(Number(other.pricePerBaseUnit) * factor)}/{unit}</b>)</> : null}.
        Approving will re-cost at this supplier&rsquo;s price.
      </span>
    </div>
  )
}
```

(`formatCurrency` — check it's imported in issues.tsx; add from `@/lib/utils` if not.)

- [ ] **Step 5: Wire session supplier through the drawer**

- `context.tsx`: add to `DrawerContextValue`:

```ts
  /** The invoice's supplier — used for supplier-scoped price comparisons. */
  sessionSupplierName: string | null
```

- `InvoiceReviewDrawer.tsx`: add `sessionSupplierName: session?.supplierName ?? null,` to `ctxValue` (+ dep array entry for `session`— already a dep, verify). Update its own `isBigPriceChange(...)` call sites (search the file) to pass `session?.supplierName`.
- `card.tsx`: `const bigPrice = !isSkipped && isBigPriceChange(item, ctx.sessionSupplierName)`; render the note next to the other issue blocks (visible even when collapsed-state logic allows — put it with the issue blocks):

```tsx
          {!bigPrice && <SupplierSwitchNote item={item} sessionSupplierName={ctx.sessionSupplierName} />}
```

- Any other `isBigPriceChange` callers the compiler flags: pass the session supplier where available, `undefined` where not (behavior falls back to spine comparison).

- [ ] **Step 6: Build** — `npm run build`. Expected: PASS (compiler sweep for `isBigPriceChange` callers complete).

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/invoices/sessions/[id]/route.ts" src/components/invoices/types.ts src/lib/invoice/resolution.ts src/components/invoices/v2
git commit -m "feat(suppliers): supplier-switch note; big-price gate compares against supplier's own offer"
```

---

## Task 8: Purchasing report — multi-supplier + volatility blocks

**Files:**
- Modify: `src/app/api/reports/analytics/route.ts` (purchasing section — read it first; it answers `?section=purchasing&days=N`)
- Modify: `src/app/reports/tabs/PurchasingTab.tsx`

- [ ] **Step 1: Add data to the analytics purchasing section**

In the analytics route, find where the purchasing section's response object is built (`summary`, `supplierSpend`, `topItems`, `spendTrend`). Add a `multiSupplier` block computed by this function (place it in the same file, import `volatilityOf, stabilityOf, scanLinePricePerBase` from `@/lib/supplier-offers`):

```ts
async function buildMultiSupplierBlock(days: number) {
  // Items with offers from 2+ suppliers
  const offers = await prisma.inventorySupplierPrice.findMany({
    include: { inventoryItem: { select: { id: true, itemName: true, baseUnit: true, qtyPerPurchaseUnit: true, packSize: true, packUOM: true } } },
  })
  const byItem = new Map<string, typeof offers>()
  for (const o of offers) {
    if (!byItem.has(o.inventoryItemId)) byItem.set(o.inventoryItemId, [])
    byItem.get(o.inventoryItemId)!.push(o)
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const lines = await prisma.invoiceScanItem.findMany({
    where: {
      approved: true,
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] },
      matchedItemId: { in: [...byItem.keys()] },
      session: { status: 'APPROVED', approvedAt: { gte: since } },
    },
    select: {
      matchedItemId: true, rawLineTotal: true,
      newPrice: true, rate: true, rateUOM: true, pricingMode: true,
      invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
      session: { select: { supplierName: true } },
    },
  })

  const items: Array<{
    itemId: string; name: string; baseUnit: string | null
    offers: Array<{ supplier: string; ppb: number; isPrimary: boolean }>
    spreadPct: number
    potentialSaving: number
  }> = []
  let totalSaving = 0

  for (const [itemId, itemOffers] of byItem) {
    if (itemOffers.length < 2) continue
    const inv = itemOffers[0].inventoryItem
    const offerList = itemOffers
      .map(o => ({ supplier: o.supplierName, ppb: Number(o.pricePerBaseUnit), isPrimary: o.isPrimary }))
      .filter(o => o.ppb > 0)
      .sort((a, b) => a.ppb - b.ppb)
    if (offerList.length < 2) continue
    const minPPB = offerList[0].ppb
    const maxPPB = offerList[offerList.length - 1].ppb
    const spreadPct = Math.round(((maxPPB - minPPB) / minPPB) * 100)

    // Savings: for every line of this item in the window, what you paid above
    // the cheapest offer's $/base. lineTotal × (1 − minPPB / paidPPB).
    let saving = 0
    for (const l of lines) {
      if (l.matchedItemId !== itemId || !l.rawLineTotal) continue
      const paidPPB = scanLinePricePerBase(l, inv)
      if (!paidPPB || paidPPB <= minPPB) continue
      saving += Number(l.rawLineTotal) * (1 - minPPB / paidPPB)
    }
    totalSaving += saving
    items.push({ itemId, name: inv.itemName, baseUnit: inv.baseUnit, offers: offerList, spreadPct, potentialSaving: Math.round(saving * 100) / 100 })
  }
  items.sort((a, b) => b.potentialSaving - a.potentialSaving)

  // Most volatile (item, supplier) pairs over the window, from line history.
  const histKey = (id: string, s: string) => `${id}|${s}`
  const hist = new Map<string, number[]>()
  const itemMeta = new Map<string, { name: string; inv: { qtyPerPurchaseUnit: unknown; packSize: unknown; packUOM: string | null } }>()
  for (const o of offers) itemMeta.set(o.inventoryItemId, { name: o.inventoryItem.itemName, inv: o.inventoryItem })
  for (const l of lines) {
    const s = l.session?.supplierName
    const meta = l.matchedItemId ? itemMeta.get(l.matchedItemId) : null
    if (!s || !meta) continue
    const ppb = scanLinePricePerBase(l, meta.inv)
    if (ppb === null) continue
    const k = histKey(l.matchedItemId!, s)
    if (!hist.has(k)) hist.set(k, [])
    hist.get(k)!.push(ppb)
  }
  const volatile = [...hist.entries()]
    .map(([k, prices]) => {
      const [itemId, supplier] = k.split('|')
      const v = volatilityOf(prices)
      return { name: itemMeta.get(itemId)?.name ?? '?', supplier, volatility: v, stability: stabilityOf(v), purchases: prices.length }
    })
    .filter(e => e.volatility !== null)
    .sort((a, b) => (b.volatility ?? 0) - (a.volatility ?? 0))
    .slice(0, 8)

  return { items: items.slice(0, 12), totalSaving: Math.round(totalSaving * 100) / 100, volatile }
}
```

and add to the purchasing response object: `multiSupplier: await buildMultiSupplierBlock(days),`

- [ ] **Step 2: Render in `PurchasingTab.tsx`**

After the existing Supplier Breakdown + Top Items grid, add (full code — adapt only the data extraction style to match the file's existing `data.X as T` pattern):

```tsx
      {/* Multi-supplier comparison */}
      {(() => {
        const ms = data.multiSupplier as {
          items: { itemId: string; name: string; baseUnit: string | null; offers: { supplier: string; ppb: number; isPrimary: boolean }[]; spreadPct: number; potentialSaving: number }[]
          totalSaving: number
          volatile: { name: string; supplier: string; volatility: number | null; stability: string | null; purchases: number }[]
        } | undefined
        if (!ms || (ms.items.length === 0 && ms.volatile.length === 0)) return null
        const fmtPpb = (ppb: number, base: string | null) =>
          base === 'g' ? `${formatCurrency(ppb * 1000)}/kg` : base === 'ml' ? `${formatCurrency(ppb * 1000)}/L` : `${formatCurrency(ppb)}/${base ?? 'ea'}`
        return (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <SectionHeader
                title="Multi-Supplier Items"
                subtitle={ms.totalSaving > 0 ? `Buying each from its cheapest supplier would have saved ~${formatCurrency(ms.totalSaving)} over this period` : 'Price comparison across suppliers'}
              />
              {ms.items.length > 0 ? (
                <div className="space-y-3 overflow-y-auto max-h-96">
                  {ms.items.map(it => (
                    <div key={it.itemId} className="border-b border-line pb-2.5 last:border-0">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="font-medium text-ink-2 truncate">{it.name}</span>
                        <span className="text-ink-4 shrink-0 ml-2">spread {it.spreadPct}%{it.potentialSaving > 0 ? ` · ${formatCurrency(it.potentialSaving)} potential` : ''}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {it.offers.map((o, i) => (
                          <span key={o.supplier} className={`font-mono text-[10.5px] px-2 py-[3px] rounded-full ${i === 0 ? 'bg-green-soft text-green-text font-semibold' : 'bg-bg text-ink-3'}`}>
                            {o.supplier}: {fmtPpb(o.ppb, it.baseUnit)}{i === 0 ? ' ✓' : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : <EmptyState message="No items bought from multiple suppliers yet" />}
            </Card>

            <Card>
              <SectionHeader title="Most Volatile Prices" subtitle="Coefficient of variation per item & supplier (90d)" />
              {ms.volatile.length > 0 ? (
                <div className="space-y-2">
                  {ms.volatile.map((v, i) => (
                    <div key={`${v.name}-${v.supplier}`} className="flex items-center gap-3 py-1.5 border-b border-line last:border-0">
                      <span className="text-xs text-ink-4 w-5 text-right shrink-0">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-ink-2 truncate">{v.name}</div>
                        <div className="text-xs text-ink-4">{v.supplier} · {v.purchases} purchases</div>
                      </div>
                      <span className={`font-mono text-[10.5px] font-semibold px-2 py-[3px] rounded-full shrink-0 ${
                        v.stability === 'volatile' ? 'bg-red-soft text-red-text' : v.stability === 'variable' ? 'bg-gold-soft text-gold-2' : 'bg-green-soft text-green-text'
                      }`}>±{Math.round((v.volatility ?? 0) * 100)}%</span>
                    </div>
                  ))}
                </div>
              ) : <EmptyState message="Not enough purchase history yet (3+ buys per supplier needed)" />}
            </Card>
          </div>
        )
      })()}
```

- [ ] **Step 3: Build** — `npm run build`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/reports/analytics/route.ts src/app/reports/tabs/PurchasingTab.tsx
git commit -m "feat(suppliers): purchasing report — multi-supplier comparison, savings, volatility"
```

---

## Task 9: Backfill offers from invoice history + run it

**Files:**
- Create: `scripts/backfill-supplier-offers.ts`

- [ ] **Step 1: Create the script**

```ts
// Backfill InventorySupplierPrice offers from approved invoice history.
// Walks approved sessions oldest → newest so the final upsert per
// (item, supplier) is the most recent purchase. Idempotent.
// Run: set -a && . ./.env; set +a && npx tsx scripts/backfill-supplier-offers.ts

import { prisma } from '../src/lib/prisma'
import { scanLinePricePerBase } from '../src/lib/supplier-offers'

async function main() {
  const sessions = await prisma.invoiceSession.findMany({
    where: { status: 'APPROVED', supplierName: { not: null } },
    orderBy: [{ approvedAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true, supplierName: true, supplierId: true,
      scanItems: {
        where: { approved: true, matchedItemId: { not: null }, action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] } },
        select: {
          matchedItemId: true, newPrice: true, rate: true, rateUOM: true, pricingMode: true,
          invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true, supplierItemCode: true,
        },
      },
    },
  })

  let upserts = 0
  for (const s of sessions) {
    for (const li of s.scanItems) {
      if (!li.matchedItemId || li.newPrice == null) continue
      const item = await prisma.inventoryItem.findUnique({
        where: { id: li.matchedItemId },
        select: { qtyPerPurchaseUnit: true, packSize: true, packUOM: true },
      })
      if (!item) continue
      const ppb = scanLinePricePerBase(li, item)
      if (ppb === null) continue
      const pack = li.invoicePackQty !== null && li.invoicePackSize !== null
        ? { packQty: Number(li.invoicePackQty), packSize: Number(li.invoicePackSize), packUOM: li.invoicePackUOM ?? 'each' }
        : {}
      await prisma.inventorySupplierPrice.upsert({
        where: { inventoryItemId_supplierName: { inventoryItemId: li.matchedItemId, supplierName: s.supplierName! } },
        create: {
          inventoryItemId: li.matchedItemId,
          supplierName: s.supplierName!,
          supplierId: s.supplierId,
          lastPrice: Number(li.newPrice),
          pricePerBaseUnit: ppb,
          isPrimary: false,
          supplierItemCode: li.supplierItemCode,
          lastInvoiceSessionId: s.id,
          ...pack,
        },
        update: {
          lastPrice: Number(li.newPrice),
          pricePerBaseUnit: ppb,
          lastUpdated: new Date(),
          lastInvoiceSessionId: s.id,
          ...(s.supplierId ? { supplierId: s.supplierId } : {}),
          ...(li.supplierItemCode ? { supplierItemCode: li.supplierItemCode } : {}),
          ...pack,
        },
      })
      upserts++
    }
  }
  const total = await prisma.inventorySupplierPrice.count()
  const multi = await prisma.inventorySupplierPrice.groupBy({
    by: ['inventoryItemId'], _count: true, having: { inventoryItemId: { _count: { gt: 1 } } },
  })
  console.log(`Backfill done: ${upserts} upserts · ${total} offers total · ${multi.length} items with 2+ suppliers`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
```

(Check how `prisma/seed.ts` / `scripts/assign-allergens.ts` import prisma and run — match their import style and runner; `npx tsx` is expected to work since allergen scripts exist. If `tsx` isn't installed, use the same runner those scripts use.)

- [ ] **Step 2: Run it against the live DB**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
set -a && . ./.env; set +a
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
npx tsx scripts/backfill-supplier-offers.ts
```

Expected: a summary line with upsert count > 0 and items-with-2+-suppliers count (the user buys e.g. brioche from Snow Cap AND Sysco, so ≥1 expected if both were ever scanned for the same item).

- [ ] **Step 3: Build & commit**

```bash
npm run build
git add scripts/backfill-supplier-offers.ts
git commit -m "feat(suppliers): backfill offers from approved invoice history"
```

---

## Task 10: End-to-end verification

- [ ] **Step 1: Full build** — `rm -rf .next && npm run build`. Expected: PASS, new `/api/inventory/[id]/suppliers` route `ƒ (Dynamic)`.

- [ ] **Step 2: Live checks** (preview_start; remember the build just clobbered `.next` — start fresh; stop the server before any further builds)

1. `/inventory` → open an item that the backfill gave 2+ offers (find one via `GET /api/inventory/<id>/suppliers` over a few candidates, or pick from the backfill output) → Suppliers section renders: packs, SKUs, $/base values, cheapest highlight; tap the star → re-fetch shows `isPrimary` moved.
2. `/reports/purchasing` → Multi-Supplier Items + Most Volatile cards render (or their empty states, if history is thin).
3. `/invoices` → open any APPROVED session → drawer still renders fine (offers include didn't break the session GET).
4. preview_console_logs: no errors.

- [ ] **Step 3: Commit any verification fixes; report**

```bash
git add -A && git commit -m "fix(suppliers): verification fixes" # only if needed
```

---

## Self-review notes (already applied)

- Spec §2 matcher/`previousPrice`/format → Task 3. Spec §2 approve/offer upsert + supplier-scoped PriceAlert → Task 4 (PriceAlert needs no code change: it keys off `priceDiffPct`, which Task 3 made supplier-scoped). Spec §3 surfaces → Tasks 6/7/8. Spec §4 volatility → Task 2. Spec §5 backfill → Task 9. `isPrimary` setter → Task 5.
- The spec's "matcher carries `spinePrice`/`offerPricePerBase`" is implemented differently (deliberate simplification): the drawer derives both from `matchedItem.supplierPrices` included in the session GET (Task 7 Step 1) — no new scan-item columns needed.
- Type bridge: `SupplierOfferStats` defined once in Task 2, imported as type-only by Task 6's client component. `offerForSupplier`/`cheapestOtherOffer`/`isBigPriceChange(item, supplierName)` defined in Task 7 Step 3, used in Steps 4–5.
