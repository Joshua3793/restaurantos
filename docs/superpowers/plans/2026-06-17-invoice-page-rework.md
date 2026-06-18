# Invoice Page Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the pack-chain migration of the invoice pipeline — replace the matcher's format-reconciliation logic with an OfferDraft / base-unit reconcile model, delete the "format mismatch" and "mode mismatch" error classes end-to-end, align the review drawer to the redesign spec, and drop the now-dead DB columns and model.

**Architecture:** The new spec (`Controla OS (2)/item-model-redesign/invoice-engine.js`) says: each OCR line maps to an `OfferDraft` `{dimension, baseUnit, packChain, pricing, receivedBase}` built from the OCR CASE/PKG/UNIT hierarchy; reconciliation against the matched item is a single subtraction at the base unit (`pricePerBaseUnit` derived from the chain); the **only** hard blocker is a **dimension conflict** (e.g. kg priced onto an `each` item); a price delta ≥5% is an *alert*, not a blocker. We introduce one new module (`src/lib/invoice/offer.ts`) mirroring the spec, wire it into the matcher, approve route, and drawer, then delete the format/mode-mismatch machinery and its backing columns.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase pooler) · existing `src/lib/item-model.ts` pack-chain helpers (`pricePerBaseUnit`, `basePerPurchase`, `dimensionOf`, `DIMENSION_BASE`, `asChainItem`, `getUnitConv`).

**No test suite:** Per CLAUDE.md the only automated correctness gate is `npm run build` (type-check). Each task's verification step is the build plus, where relevant, a `verify-*.ts` script and a preview smoke check — NOT unit tests.

**Build command (node is not on the sandbox PATH):**
```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build
```
(Bash tool needs `dangerouslyDisableSandbox: true` for this. Do NOT run a build while the preview server is up — it clobbers `.next/`; restart preview after.)

---

## Scope correction (read before starting)

The scoping discussion listed `invoicePackQty/invoicePackSize/invoicePackUOM` among columns to drop. **Do NOT drop them.** They hold the OCR **CASE/PKG/UNIT hierarchy** that `chainFromOcr` (spec) needs to *build* the pack chain — they are load-bearing OCR data, not format-mismatch machinery. The columns that actually get dropped are only: `formatMismatch`, `needsFormatConfirm`, `applyInvoiceFormat`, `rawPriceType` (plus the dead `InvoiceLineItem` model). `invoicePack*` stay.

## File structure

**New:**
- `src/lib/invoice/offer.ts` — `OfferInput`, `OfferDraft`, `ReconcileResult`, `buildOffer()`, `reconcileOffer()`, `scanItemToOfferInput()`, `ocrLineToOfferInput()`. The single source of OCR→chain mapping, reused by matcher, approve, and drawer.

**Modified (logic):**
- `src/lib/invoice-matcher.ts` — `MatchResult` loses `formatMismatch/invoicePackQty/Size/UOM/needsFormatConfirm` as *computed* fields; reconcile via `reconcileOffer`.
- `src/app/api/invoices/sessions/[id]/approve/route.ts` — offer-driven write; drop `rawPriceType`/`applyInvoiceFormat`/format-mismatch skip; keep dimension-conflict guard.
- `src/app/api/invoices/sessions/[id]/process/route.ts` — stop persisting `formatMismatch`/`needsFormatConfirm`.
- `src/app/api/invoices/sessions/[id]/route.ts` — PATCH stops accepting `rawPriceType`/`needsFormatConfirm`/`formatMismatch`/`applyInvoiceFormat`.
- `src/lib/invoice/predicates.ts` — delete `hasFormatMismatch`/`hasModeMismatch`; add `hasDimensionConflict`.
- `src/lib/invoice/filters.ts` — drop `formatMismatch`/`modeMismatch` filter keys; add `dimensionConflict`.
- `src/lib/invoice/calculations.ts`, `formatters.ts`, `resolution.ts` — drop `rawPriceType` branch; keep `invoicePack*` reads.
- `src/components/invoices/types.ts` — `ScanItem` loses `formatMismatch/applyInvoiceFormat/needsFormatConfirm/rawPriceType`.
- `src/components/invoices/v2/issues.tsx` — delete `ModeIssue`; add `DimensionConflictIssue`.
- `src/components/invoices/v2/card.tsx` — delete `FormatMismatchNotice` + mismatch wiring; render `DimensionConflictIssue`.
- `src/components/invoices/v2/composites.tsx` — drop `formatMismatch`/`modeMismatch` from `CHIP_ORDER`.
- `src/components/invoices/v2/InvoiceReviewDrawer.tsx` — progress/approve gates use `hasDimensionConflict` not format/mode.
- `src/components/invoices/v2/context.tsx` — drop `modeWritebackItems`.
- `src/app/api/inventory/[id]/stock-movements/route.ts`, `price-history/route.ts`, `src/lib/supplier-offers.ts`, `scripts/backfill-supplier-offers.ts` — `invoicePack*` reads stay; only remove `rawPriceType` reads.

**Modified (visual):**
- `src/components/invoices/v2/chrome.tsx`, `card.tsx`, `issues.tsx` — align to `Controla OS (2)/app/InvoiceDrawer.html` + plan §5 tokens.

**Schema/DB (last):**
- `prisma/schema.prisma` — remove the 4 columns from `InvoiceScanItem`, remove `InvoiceLineItem` model + its relation on `Invoice`.
- Live DB — drop columns + table via `$executeRawUnsafe` over the pooler (see Task 12).

---

## Task 1: New offer/reconcile core module (additive — nothing breaks yet)

**Files:**
- Create: `src/lib/invoice/offer.ts`
- Reference: `src/lib/item-model.ts:20-61` (`DIMENSION_BASE`, `dimensionOf`, `basePerPurchase`, `pricePerBaseUnit`, `asChainItem`), `src/lib/utils.ts` (`getUnitConv`), `Controla OS (2)/item-model-redesign/invoice-engine.js` (the spec being mirrored).

- [ ] **Step 1: Write the module**

```typescript
// src/lib/invoice/offer.ts
//
// OCR line → pack-chain OfferDraft → reconcile against the matched item.
// Mirrors Controla OS (2)/item-model-redesign/invoice-engine.js onto the real
// item-model helpers. This is THE single place OCR pack data becomes a chain;
// the matcher, approve route, and drawer all go through it. There is no
// "format reconciliation" — a chain is built from the OCR hierarchy and the two
// sides are compared at the base unit. The only hard blocker is a dimension
// conflict (e.g. kg priced onto an `each` item).

import {
  type Dimension, type PackLink, type Pricing, type ChainItem,
  DIMENSION_BASE, dimensionOf, basePerPurchase, pricePerBaseUnit,
} from '@/lib/item-model'
import { getUnitConv } from '@/lib/utils'

/** Flat OCR pack fields, normalised. Both OcrLineItem and InvoiceScanItem map onto this. */
export interface OfferInput {
  pricingMode: 'per_case' | 'per_weight' | 'unknown' | null
  qtyShipped: number | null
  qtyShippedUOM: string | null
  packQty: number | null
  packSize: number | null
  packUOM: string | null
  unitPrice: number | null      // per_case: the case price
  rate: number | null           // per_weight: $/rateUOM
  rateUOM: string | null
  totalQty: number | null       // per_weight: actual received weight/volume
  totalQtyUOM: string | null
  isCatchweight: boolean | null
}

export interface OfferDraft {
  dimension: Dimension
  baseUnit: string
  packChain: PackLink[]
  pricing: Pricing
  isCatchweight: boolean
  receivedBase: number          // quantity received, in base units
  receivedLabel: string
}

export type ReconcileStatus = 'NEW' | 'MATCH' | 'PRICE_DELTA' | 'CONFLICT'
export interface ReconcileResult {
  status: ReconcileStatus
  newPpb: number
  oldPpb: number | null
  deltaPct: number | null
  dimensionConflict: boolean
}

const PRICE_ALERT_PCT = 5

const norm = (u: string | null | undefined) => (u ?? '').trim().toLowerCase()
const toBase = (qty: number | null | undefined, unit: string | null | undefined) =>
  Number(qty || 0) * getUnitConv(unit || 'each')

/** Build the pack chain from the OCR CASE/PKG/UNIT fields. Leaf carries base content. */
export function chainFromOcr(o: OfferInput, dimension: Dimension): PackLink[] {
  const topUnit = norm(o.qtyShippedUOM) || 'case'
  const packQty = Number(o.packQty || 1)
  const packSize = Number(o.packSize || 1)
  const packUOM = norm(o.packUOM) || 'each'
  const leafPer = dimension === 'COUNT' ? 1 : packSize * getUnitConv(packUOM)
  const leafUnit = dimension === 'COUNT' ? 'each' : (packUOM === 'each' ? 'each' : packUOM)
  if (packQty > 1) {
    return [{ unit: topUnit, per: packQty }, { unit: leafUnit, per: leafPer }]
  }
  return [{ unit: topUnit, per: leafPer }]   // single inner: collapse to one link
}

/** OCR line → OfferDraft. One branch on the mode the OCR already decided. */
export function buildOffer(o: OfferInput): OfferDraft {
  const sigUnit = o.pricingMode === 'per_weight'
    ? (o.rateUOM || o.totalQtyUOM || 'kg')
    : (o.packUOM || o.qtyShippedUOM || 'each')
  const dimension = dimensionOf(sigUnit)
  const baseUnit = DIMENSION_BASE[dimension]
  const packChain = chainFromOcr(o, dimension)

  if (o.pricingMode === 'per_weight') {
    const receivedBase = toBase(o.totalQty, o.totalQtyUOM || o.rateUOM)
    return {
      dimension, baseUnit, packChain,
      pricing: { mode: 'RATE', rate: Number(o.rate || 0), rateUnit: norm(o.rateUOM) || baseUnit },
      isCatchweight: !!o.isCatchweight,
      receivedBase,
      receivedLabel: `${Number(o.totalQty || 0)} ${o.totalQtyUOM || o.rateUOM || ''} actual`,
    }
  }
  const basePerPurchaseUnit = basePerPurchase(packChain)
  const receivedBase = Number(o.qtyShipped || 0) * basePerPurchaseUnit
  return {
    dimension, baseUnit, packChain,
    pricing: { mode: 'PACK', purchasePrice: Number(o.unitPrice || 0) },
    isCatchweight: false,
    receivedBase,
    receivedLabel: `${Number(o.qtyShipped || 0)} ${norm(o.qtyShippedUOM) || 'case'} × ${basePerPurchaseUnit} ${baseUnit}`,
  }
}

/** Reconcile against the matched item — one subtraction at the base unit. */
export function reconcileOffer(offer: OfferDraft, matched: ChainItem | null): ReconcileResult {
  const newPpb = pricePerBaseUnit({ ...offer, countUnit: undefined, stockOnHand: 0 })
  if (!matched) {
    return { status: 'NEW', newPpb, oldPpb: null, deltaPct: null, dimensionConflict: false }
  }
  const oldPpb = pricePerBaseUnit(matched)
  const dimensionConflict = offer.dimension !== matched.dimension
  const deltaPct = oldPpb > 0 ? ((newPpb - oldPpb) / oldPpb) * 100 : null
  let status: ReconcileStatus = 'MATCH'
  if (dimensionConflict) status = 'CONFLICT'
  else if (deltaPct != null && Math.abs(deltaPct) >= PRICE_ALERT_PCT) status = 'PRICE_DELTA'
  return { status, newPpb, oldPpb, deltaPct, dimensionConflict }
}

/** Adapter: an OcrLineItem (matcher input) → OfferInput. Field names already align. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ocrLineToOfferInput(o: any): OfferInput {
  return {
    pricingMode: o.pricingMode ?? null,
    qtyShipped: o.qtyShipped ?? null,
    qtyShippedUOM: o.qtyShippedUOM ?? null,
    packQty: o.packQty ?? null,
    packSize: o.packSize ?? null,
    packUOM: o.packUOM ?? null,
    unitPrice: o.unitPrice ?? null,
    rate: o.rate ?? null,
    rateUOM: o.rateUOM ?? null,
    totalQty: o.totalQty ?? null,
    totalQtyUOM: o.totalQtyUOM ?? null,
    isCatchweight: o.isCatchweight ?? null,
  }
}

/** Adapter: a persisted InvoiceScanItem row → OfferInput (column names differ). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scanItemToOfferInput(s: any): OfferInput {
  return {
    pricingMode: s.pricingMode ?? null,
    qtyShipped: s.rawQty != null ? Number(s.rawQty) : null,
    qtyShippedUOM: s.rawUnit ?? null,
    packQty: s.invoicePackQty != null ? Number(s.invoicePackQty) : null,
    packSize: s.invoicePackSize != null ? Number(s.invoicePackSize) : null,
    packUOM: s.invoicePackUOM ?? null,
    unitPrice: s.rawUnitPrice != null ? Number(s.rawUnitPrice) : null,
    rate: s.rate != null ? Number(s.rate) : null,
    rateUOM: s.rateUOM ?? null,
    totalQty: s.totalQty != null ? Number(s.totalQty) : null,
    totalQtyUOM: s.totalQtyUOM ?? null,
    isCatchweight: s.isCatchweight ?? null,
  }
}
```

- [ ] **Step 2: Verify it builds**

Run: `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && npm run build`
Expected: PASS (no type errors). The module is unused so far, so only its own types are checked.

- [ ] **Step 3: Smoke-test the transform against the spec fixtures**

Create `scripts/verify-offer-engine.ts` that imports `buildOffer`/`reconcileOffer` and asserts the four `OCR_LINES` fixtures from `Controla OS (2)/item-model-redesign/invoice-engine.js` produce the expected ppb:
- `ketchup` (per_case 12×1L, $48/cs) → newPpb ≈ 48/12000 = $0.004/ml; reconcile vs matched (pricing PACK $48, chain case×12 / bottle×1000) → MATCH, deltaPct ≈ 0.
- `ribeye` (per_weight, rate $28.60/kg, totalQty 7.40kg) → newPpb = 28.60/1000 = $0.0286/g; reconcile vs matched RATE $27.90/kg → PRICE_DELTA (deltaPct ≈ +2.5%? No → under 5% → MATCH). Assert deltaPct ≈ +2.5, status MATCH.
- `cola` (per_case 24×355ml, $30/cs) vs 3-level matched chain → MATCH (legacy would scream format mismatch; assert dimensionConflict false).
- `arugula` (no match) → status NEW.

Header comment: `// Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/verify-offer-engine.ts`

Run it. Expected: all asserts PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/invoice/offer.ts scripts/verify-offer-engine.ts
git commit -m "feat(invoice): add OfferDraft/reconcile core (pack-chain OCR mapping)"
```

---

## Task 2: Matcher → reconcile via OfferDraft, drop format-mismatch computation

**Files:**
- Modify: `src/lib/invoice-matcher.ts` (`MatchResult` lines 43-58; `buildMatchResult` 179-335)
- Reference: `src/lib/invoice/offer.ts` (Task 1)

- [ ] **Step 1: Trim `MatchResult`** — remove `formatMismatch`, `needsFormatConfirm` from the interface (lines 51, 55). KEEP `invoicePackQty/Size/UOM` (they carry the OCR hierarchy downstream). Add nothing else.

- [ ] **Step 2: Replace the price/format block in `buildMatchResult`** — delete the `comparePricesNormalized` block (lines 209-286) and the `formatMismatch` computation (lines 293-316). Replace with reconcile:

```typescript
// ── Reconcile at the base unit via the offer draft ────────────────────────
import { buildOffer, reconcileOffer, ocrLineToOfferInput } from '@/lib/invoice/offer'
import { asChainItem } from '@/lib/item-model'
// ... inside buildMatchResult, after previousPrice/newPrice are set:
const offerDraft = buildOffer(ocrLineToOfferInput(ocrItem))
const matchedChain = asChainItem({
  dimension: bestItem.dimension, baseUnit: bestItem.baseUnit,
  packChain: bestItem.packChain, pricing: bestItem.pricing, countUnit: bestItem.countUnit ?? undefined,
})
const rec = reconcileOffer(offerDraft, matchedChain)
const priceDiffPct = rec.deltaPct != null ? Math.round(rec.deltaPct * 100) / 100 : null
```

- [ ] **Step 3: Update the return object** (lines 318-334) — drop `formatMismatch`/`needsFormatConfirm`; keep `invoicePackQty/Size/UOM` sourced from the OCR fields directly:

```typescript
return {
  ...ocrItem,
  matchedItemId: bestItem.id,
  matchConfidence: confidence,
  matchScore: bestScore,
  action,
  previousPrice,
  newPrice,
  priceDiffPct,
  invoicePackQty:  ocrItem.packQty  ?? null,
  invoicePackSize: ocrItem.packSize ?? null,
  invoicePackUOM:  ocrItem.packUOM  ?? null,
  totalQty:    ocrItem.totalQty    ?? null,
  totalQtyUOM: ocrItem.totalQtyUOM ?? ocrItem.packUOM ?? null,
}
```

Apply the same field removal to the no-match early-return (lines 548-564) and remove the now-unused `chainPackFormat`, `comparePricesNormalized`, `format`/`formatConfirmed` params if no longer referenced. (`parseFormatFromDescription` is still used to populate `invoicePack*` — keep it.)

- [ ] **Step 4: Build**

Run the build command. Expected: PASS. Fix any callers of the removed `MatchResult` fields flagged by the compiler (the next tasks handle the persistence/UI sides — if the build points at `process/route.ts`, do Task 3's edit now).

- [ ] **Step 5: Run the matcher-adjacent verify scripts**

Run `scripts/verify-invoice-pricing.ts` and `scripts/verify-rc-theoretical.ts` (both via the `TS_NODE_PROJECT=tsconfig.scripts.json` command). Expected: still PASS — reconcile must not change ppb for clean matches.

- [ ] **Step 6: Commit**

```bash
git add src/lib/invoice-matcher.ts
git commit -m "refactor(invoice): matcher reconciles via OfferDraft at base unit; drop formatMismatch/needsFormatConfirm computation"
```

---

## Task 3: Stop persisting formatMismatch/needsFormatConfirm at process time

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/process/route.ts:298-340` (scan-item write)

- [ ] **Step 1:** Remove `formatMismatch: item.formatMismatch,` (line 315) and `needsFormatConfirm: item.needsFormatConfirm,` (line 319) from the `invoiceScanItem` create payload. Keep `invoicePackQty/Size/UOM` writes (lines 316-318).

- [ ] **Step 2: Build.** Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/invoices/sessions/[id]/process/route.ts
git commit -m "refactor(invoice): stop persisting formatMismatch/needsFormatConfirm on scan items"
```

---

## Task 4: Approve route — offer-driven write, drop rawPriceType/applyInvoiceFormat/format-skip

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts`
- Reference: `src/lib/invoice/offer.ts`; the dimension-conflict guard already at lines 161-182 (KEEP it).

- [ ] **Step 1: Build the offer per line** near the top of the per-item loop (replace the `rawPriceType` derivation at line 83):

```typescript
import { buildOffer, scanItemToOfferInput } from '@/lib/invoice/offer'
// ...
const offer = buildOffer(scanItemToOfferInput(item))
const isUomMode = offer.pricing.mode === 'RATE'
```

- [ ] **Step 2: Replace the pricing write** (lines 231-273) so `pricing`/`packChain`/`dimension`/`countUnit` come from `offer`, unconditionally (no `applyInvoiceFormat` gate):

```typescript
const newPricing = offer.pricing   // {mode:'RATE',rate,rateUnit} | {mode:'PACK',purchasePrice}
// ... in the inventoryItem update:
data: {
  pricing: newPricing,
  packChain: offer.packChain,
  dimension: offer.dimension,
  // countUnit: keep the item's existing countUnit unless creating new
  ...
}
```

- [ ] **Step 3: Delete the format-mismatch skip** (lines 184-208) and the `applyInvoiceFormat` consent read (lines 100-111). **Keep** the dimension-conflict guard (161-182) — it is now the sole blocker; if `offer.dimension !== item.dimension` for a matched line, skip the price write and record it (the drawer blocks approval before this, but keep the server guard as defense-in-depth).

- [ ] **Step 4: Remove `rawPriceType` everywhere in this file** (lines 30, 83, 117, 143, 200, 231, 249, 312, 347, 350, 360). The per_case/per_weight branch is now `isUomMode` from `offer.pricing.mode`. The `InventorySupplierPrice` offer write keeps its `packQty/packSize/packUOM` (from `invoicePack*`) — do not remove those.

- [ ] **Step 5: Build.** Expected: PASS. The spine invariant (ppb derived, never written to `InventoryItem`) must hold — confirm no new `pricePerBaseUnit:` assignment to an `inventoryItem.update`.

- [ ] **Step 6: Verify approve parity**

Run `scripts/verify-item-model-parity.ts` and `scripts/verify-invoice-pricing.ts`. Expected: PASS (ppb for approved items unchanged vs the chain).

- [ ] **Step 7: Commit**

```bash
git add src/app/api/invoices/sessions/[id]/approve/route.ts
git commit -m "refactor(invoice): approve writes offer chain+pricing directly; drop rawPriceType/applyInvoiceFormat/format-skip; dimension conflict is sole blocker"
```

---

## Task 5: PATCH route — stop accepting dropped fields

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/route.ts:52-97` (PATCH body)

- [ ] **Step 1:** Remove `rawPriceType` (line 76), `needsFormatConfirm` (line 77), and any `formatMismatch`/`applyInvoiceFormat` assignments from the PATCH update payload. Keep `invoicePackQty/Size/UOM` (lines 73-75) — the drawer's pack editor still writes these.

- [ ] **Step 2: Build.** Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/invoices/sessions/[id]/route.ts
git commit -m "refactor(invoice): PATCH no longer accepts rawPriceType/needsFormatConfirm/formatMismatch/applyInvoiceFormat"
```

---

## Task 6: Predicates — delete format/mode, add dimension-conflict

**Files:**
- Modify: `src/lib/invoice/predicates.ts`
- Reference: `src/lib/invoice/offer.ts`, `src/components/invoices/types.ts` (`ScanItem.matchedItem` shape)

- [ ] **Step 1:** Delete `hasFormatMismatch` (lines 50-100) and `hasModeMismatch` (lines 102-112) and their helpers (`numEq`, `uomEq`, `itemPackFormat` if only used here).

- [ ] **Step 2:** Add `hasDimensionConflict` — the new sole blocker:

```typescript
import { buildOffer, scanItemToOfferInput } from './offer'
import { dimensionOf } from '@/lib/item-model'

/** True when the invoice line's dimension differs from the linked item's. The
 *  only hard blocker under the pack-chain model. */
export function hasDimensionConflict(item: ScanItem): boolean {
  if (!item.matchedItem) return false
  const offer = buildOffer(scanItemToOfferInput(item))
  const itemDim = (item.matchedItem.dimension as 'MASS'|'VOLUME'|'COUNT' | undefined)
    ?? dimensionOf(item.matchedItem.baseUnit ?? 'each')
  return offer.dimension !== itemDim
}
```

- [ ] **Step 3:** Update `pickAccent` (line ~181): replace `hasFormatMismatch(item) || hasModeMismatch(item) ||` with `hasDimensionConflict(item) ||`.

- [ ] **Step 4: Build.** Expected: errors in `filters.ts`/`card.tsx`/`resolution.ts`/`InvoiceReviewDrawer.tsx` referencing the deleted predicates — those are fixed in Tasks 7-9. If executing inline, proceed; if per-subagent, this task's build is expected-red and the gate is "only the expected callers fail."

- [ ] **Step 5: Commit** (after Tasks 7-9 land, or commit now if inline-batching):

```bash
git add src/lib/invoice/predicates.ts
git commit -m "refactor(invoice): replace hasFormatMismatch/hasModeMismatch with hasDimensionConflict"
```

---

## Task 7: Filters — swap mismatch keys for dimensionConflict

**Files:**
- Modify: `src/lib/invoice/filters.ts`

- [ ] **Step 1:** In `FilterKey` (lines 13-19) remove `'formatMismatch'` and `'modeMismatch'`; add `'dimensionConflict'`.
- [ ] **Step 2:** In `matchesFilter` (lines 23-49) remove the two `case` arms (28-29); add `case 'dimensionConflict': return hasDimensionConflict(item)`.
- [ ] **Step 3:** In `getFilterCounts` (51-62) remove lines 56-57; add `dimensionConflict: items.filter(i => matchesFilter(i, 'dimensionConflict')).length,`.
- [ ] **Step 4:** In `getActiveFilters` order (line 66) replace `'formatMismatch', 'modeMismatch'` with `'dimensionConflict'` (place it right after `'needsLink'` — it's the top-severity blocker).
- [ ] **Step 5:** In `FILTER_LABELS` (71-) remove lines 74-75; add `dimensionConflict: 'Dimension conflict',`.
- [ ] **Step 6:** Update the `import` of predicates at the top to drop `hasFormatMismatch`/`hasModeMismatch`, add `hasDimensionConflict`.
- [ ] **Step 7: Build.** Expected: PASS for this file (composites.tsx may still error — Task 9).
- [ ] **Step 8: Commit**

```bash
git add src/lib/invoice/filters.ts
git commit -m "refactor(invoice): filter by dimensionConflict instead of format/mode mismatch"
```

---

## Task 8: resolution.ts + calculations.ts + formatters.ts — drop rawPriceType branch

**Files:**
- Modify: `src/lib/invoice/resolution.ts:8,90,93`; `src/lib/invoice/calculations.ts:24-30,52`; `src/lib/invoice/formatters.ts` (no rawPriceType — leave `invoicePack*` reads)

- [ ] **Step 1: resolution.ts** — update the predicates import (line 8) to drop `hasModeMismatch`/`hasFormatMismatch`, add `hasDimensionConflict`. In `lineIssues` (lines 79-104): delete the mode-mismatch push (line 90) and the format-as-mode push (line 93); add `if (hasDimensionConflict(item)) out.push({ kind: 'conflict', resolved: false })`. In `lineUnresolved`: a `conflict` issue is always unresolved (blocks approve).

- [ ] **Step 2: calculations.ts** — in `computeLineMath` (lines 22-30) remove the `rawPriceType` read (line 26) and the `pt === 'PKG'/'UOM'` branch (29-30); derive mode from `item.pricingMode` instead (`per_weight` → rate math, else case math). Keep `invoicePackQty/Size/UOM` reads (24-25, 52).

- [ ] **Step 3: formatters.ts** — no change needed (it reads `invoicePack*`, which stay). Verify by grep that it has no `rawPriceType`.

- [ ] **Step 4: Build.** Expected: PASS for these files.
- [ ] **Step 5: Commit**

```bash
git add src/lib/invoice/resolution.ts src/lib/invoice/calculations.ts
git commit -m "refactor(invoice): issues/line-math derive mode from pricingMode; conflict is the unresolved blocker"
```

---

## Task 9: Drawer UI — delete ModeIssue/FormatMismatchNotice, add DimensionConflictIssue

**Files:**
- Modify: `src/components/invoices/v2/issues.tsx`, `card.tsx`, `composites.tsx`, `InvoiceReviewDrawer.tsx`, `context.tsx`

- [ ] **Step 1: issues.tsx** — delete `ModeIssue` (lines 56-102). Add `DimensionConflictIssue` (a red `.issue` block, no resolve buttons — it's terminal; the line cannot be approved onto this item):

```tsx
export function DimensionConflictIssue({ item }: { item: ScanItem }) {
  const invDim = derivePricingMode(item) === 'per-weight' ? 'weight/volume' : 'count'
  const itemName = item.matchedItem?.itemName ?? 'this item'
  return (
    <div className="px-4 py-2.5 border-b border-dashed border-line">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold uppercase bg-red-soft text-red-text">
          Dimension conflict
        </span>
        <p className="text-[12.5px] text-ink-2 leading-snug">
          This line is priced by a unit that doesn’t match <span className="font-medium">{itemName}</span>’s
          measurement type. Re-link to a compatible item to approve it.
        </p>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: card.tsx** — update import (line 19): drop `hasModeMismatch`/`hasFormatMismatch`, add `hasDimensionConflict`; import `DimensionConflictIssue` from `./issues`. Replace locals (47-48) with `const dimConflict = !isSkipped && hasDimensionConflict(item)`. Update `isAttention` (53) to use `dimConflict`. Update `data-task` (68): `dimConflict ? 'conflict' : undefined`. Replace the `ModeIssue` render (297) and the `FormatMismatchNotice` block (301-305) with `{dimConflict && <DimensionConflictIssue item={item} />}`. Delete `FormatMismatchNotice` (447-505).

- [ ] **Step 3: composites.tsx** — in `CHIP_ORDER` (line 728) remove `'formatMismatch'` and `'modeMismatch'`; insert `'dimensionConflict'` after `'needsLink'`. Leave `CaseStructureEditor` (236-310) intact — it still edits `invoicePack*`.

- [ ] **Step 4: InvoiceReviewDrawer.tsx** — import (line 24): drop `hasModeMismatch`/`hasFormatMismatch`, add `hasDimensionConflict`. In the progress/approve filters (lines 395, 416, 450) replace `hasModeMismatch(i) || hasFormatMismatch(i)` with `hasDimensionConflict(i)`. The approve button stays disabled while any line has a dimension conflict (it's terminal — can only be cleared by re-linking).

- [ ] **Step 5: context.tsx** — remove `modeWritebackItems: Set<string>` (line 31) and its setter/`toggleModeWriteback` from the context value + provider. Grep for `modeWriteback` and remove all references (issues.tsx's ModeIssue was the only consumer and is gone).

- [ ] **Step 6: Build.** Expected: PASS (whole app compiles now).
- [ ] **Step 7: Preview smoke**

Start preview (config "RestaurantOS (Next.js)"). Open `/invoices`, open a session into the drawer. Confirm: no "Format mismatch"/"Mode mismatch" chips or blocks; a price change still shows as an alert; the drawer opens/closes and approve works. Screenshot.

- [ ] **Step 8: Commit**

```bash
git add src/components/invoices/v2 src/lib/invoice/predicates.ts
git commit -m "feat(invoice): drawer drops format/mode-mismatch UI, adds dimension-conflict blocker"
```

---

## Task 10: types.ts — trim ScanItem

**Files:**
- Modify: `src/components/invoices/types.ts:49-73`

- [ ] **Step 1:** Remove `formatMismatch` (67), `applyInvoiceFormat` (68), `needsFormatConfirm` (72), `rawPriceType` (73) from `ScanItem`. Keep `invoicePackQty/Size/UOM` (69-71).
- [ ] **Step 2: Build.** Expected: PASS — if anything still references the removed fields, fix it (should be none after Tasks 1-9).
- [ ] **Step 3: Commit**

```bash
git add src/components/invoices/types.ts
git commit -m "refactor(invoice): drop format/mode-mismatch fields from ScanItem type"
```

---

## Task 11: Peripheral readers — remove rawPriceType only

**Files:**
- Modify: `src/app/api/inventory/[id]/price-history/route.ts:44`; `src/app/api/inventory/[id]/stock-movements/route.ts` (verify it keeps `invoicePack*`); `src/lib/supplier-offers.ts`; `scripts/backfill-supplier-offers.ts`

- [ ] **Step 1: price-history** — remove `rawPriceType: s.rawPriceType,` (line 44); keep `invoicePackUOM` (45).
- [ ] **Step 2: stock-movements** — confirm lines 94-98 read `invoicePackQty/Size/UOM` (KEEP) and have no `rawPriceType`. No change unless a `rawPriceType` read exists.
- [ ] **Step 3: supplier-offers.ts / backfill** — confirm they reference only `invoicePack*` (KEEP). No change.
- [ ] **Step 4: Build.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/app/api/inventory/[id]/price-history/route.ts
git commit -m "refactor(invoice): drop rawPriceType from price-history response"
```

---

## Task 12: Visual polish — align drawer to InvoiceDrawer.html / plan §5

**Files:**
- Modify: `src/components/invoices/v2/chrome.tsx`, `card.tsx`, `issues.tsx`
- Reference: `Controla OS (2)/app/InvoiceDrawer.html` (visual source of truth), `Controla OS (2)/app/Invoice Drawer - Implementation Plan.md` §5 (token table), `Controla OS (2)/app/styles.css`

The structure already matches the spec (ImpactStrip = cost-chrome, AlertBanner = gold-soft, ReviewProgress = bar + segmented, SectionDivider = Needs-attention/Auto-matched/Other). Polish only:

- [ ] **Step 1:** Open `InvoiceDrawer.html` in the preview browser (or read it) and diff the live drawer against it for: section divider labels ("Needs attention" / "Auto-matched" / "Other line items"), the `.issue` badge tones (`.mode`=gold-soft, `.price`=red-soft, `.sku`=blue-soft, and the new conflict=red), the footer impact summary copy ("writes N prices, creates M items, re-costs K recipes"), and the title font (`Fraunces 500` per §5 token row "Type").
- [ ] **Step 2:** Apply the gaps as Tailwind/token edits. Use the flat color tokens (`bg-gold-soft`, `text-red-text`, `bg-red-soft`, `text-ink-2`, …) — numbered tokens (`bg-red-500`) are broken in this project. Verify the footer renders the writes/creates/re-costs summary (plan §0 problem #5, §7 state 1).
- [ ] **Step 3: Preview verify** — screenshot the drawer in the "standard review" state and the "all resolved" state (bar at 100%, approve enabled). Compare side-by-side with `InvoiceDrawer.html`. Confirm `preview_console_logs` is clean.
- [ ] **Step 4: Commit**

```bash
git add src/components/invoices/v2/chrome.tsx src/components/invoices/v2/card.tsx src/components/invoices/v2/issues.tsx
git commit -m "style(invoice): align review drawer to InvoiceDrawer.html spec tokens"
```

---

## Task 13: DB migration (expand-contract — LAST, after all code is deployed)

**Files:**
- Modify: `prisma/schema.prisma` (`InvoiceScanItem` model; `Invoice` model relation; delete `InvoiceLineItem` model)
- Reference: memory `project_prisma_migrate_shadow_broken.md` and `project_item_model_redesign.md` — **never** run a full-schema `migrate diff` (direct DB host unreachable); use `$executeRawUnsafe` over the pooler for DDL. Expand-contract: code that no longer reads/writes these columns must be DEPLOYED before the DROP.

> **Gate:** Do not start this task until Tasks 1-12 are merged and deployed to production. Dropping a column an old running build still selects will 500 that build.

- [ ] **Step 1: Remove from schema** — in `InvoiceScanItem` delete `formatMismatch`, `needsFormatConfirm`, `applyInvoiceFormat`, `rawPriceType`. KEEP `invoicePackQty/Size/UOM`. Delete the entire `InvoiceLineItem` model and remove its relation field from the `Invoice` model.

- [ ] **Step 2: Regenerate the client**

Run: `export PATH=... && npx prisma generate`
Then build. Expected: PASS (no code references the removed columns/model — Tasks 1-11 ensured this; `scripts/migrate-sqlite-to-pg.ts` references `InvoiceLineItem` — delete those lines or the dead script).

- [ ] **Step 3: Drop the columns + table on the live DB via the pooler**

Write `scripts/drop-invoice-legacy-columns.ts`:

```typescript
// Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/drop-invoice-legacy-columns.ts
import { prisma } from '../src/lib/prisma'
async function main() {
  const stmts = [
    `ALTER TABLE "InvoiceScanItem" DROP COLUMN IF EXISTS "formatMismatch"`,
    `ALTER TABLE "InvoiceScanItem" DROP COLUMN IF EXISTS "needsFormatConfirm"`,
    `ALTER TABLE "InvoiceScanItem" DROP COLUMN IF EXISTS "applyInvoiceFormat"`,
    `ALTER TABLE "InvoiceScanItem" DROP COLUMN IF EXISTS "rawPriceType"`,
    `DROP TABLE IF EXISTS "InvoiceLineItem"`,
  ]
  for (const s of stmts) { console.log(s); await prisma.$executeRawUnsafe(s) }
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
```

Run it. Expected: each statement logs and succeeds.

- [ ] **Step 4: Record the migration** — follow the diff/db-execute/resolve workaround from `project_prisma_migrate_shadow_broken.md` to add a no-op migration folder recording the DROP (so `migrate deploy` history stays consistent), matching the precedent commit `a39e324`.

- [ ] **Step 5: Final build + verify**

Run the build and `scripts/verify-rc-theoretical.ts` + `scripts/verify-item-model-parity.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma scripts/drop-invoice-legacy-columns.ts
git commit -m "chore(db): drop InvoiceScanItem.{formatMismatch,needsFormatConfirm,applyInvoiceFormat,rawPriceType} + InvoiceLineItem (applied to live DB via pooler)"
```

---

## Self-review checklist (done during planning)

- **Spec coverage:** invoice-engine.js `chainFromOcr`/`ocrLineToOffer`/`reconcile`/`writeBack` → Task 1. Matcher reconcile → Task 2. Approve write-back → Task 4. "Format/mode mismatch gone" → Tasks 2,3,5,6,7,8,9,10. Dimension conflict as sole blocker → Tasks 4,6,9. Drawer spec (plan doc §2/§5/§7) → Tasks 9,12. DB drop → Task 13. ✓
- **Type consistency:** `OfferInput`/`OfferDraft`/`ReconcileResult` defined in Task 1, consumed unchanged in Tasks 2,4,6. `hasDimensionConflict` defined Task 6, consumed Tasks 7,8,9. ✓
- **Scope correction:** `invoicePack*` retained everywhere (Tasks 2,3,5,8,11,13). ✓
- **Expand-contract:** DB drop (Task 13) gated behind deploy of Tasks 1-12. ✓

## Out of scope (per plan doc §10)
Bulk approve, AI "likely UOM fix" suggestion, line comments/@mentions, dispute-email composer.
```
