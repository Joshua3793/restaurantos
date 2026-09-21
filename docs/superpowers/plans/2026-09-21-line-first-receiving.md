# Line-First Receiving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an invoice line states a weight/volume — as the shipped quantity's own unit, or as a billed weight the line's money proves was the priced quantity — receive exactly that, regardless of the item's or the supplier offer's pricing mode.

**Architecture:** One pure function, `lineReceived(line, chainItem) → { base, via, needsBridge }`, replaces the body of `lineReceivedBaseUnits` (which becomes a thin wrapper, so there is still exactly one receiving rule). Two new steps sit ahead of the pack logic; everything else is threading three price fields and the item's bridges to every caller, showing the provenance, and re-freezing ~27 historical lines behind a reviewed dry run. Spec: `docs/superpowers/specs/2026-09-21-line-first-receiving-design.md`.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + Postgres (Supabase, pgBouncer transaction mode) · vitest.

## Global Constraints

- `src/lib/invoice/line-qty.ts` stays pure and client-safe (imports only `@/lib/uom`, `@/lib/item-model`, `@/lib/count-uom`, `@/lib/invoice/line-format`). No Prisma types.
- There is ONE receiving rule. Nothing may compute a received quantity except through `lineReceived` / `lineReceivedBaseUnits` / `lineReceivedCountQty`.
- A frozen `receivedQtyBase > 0` always wins. Callers computing the value to freeze must NOT pass it (approve's `lineQtyOf`, `hasInvalidRcSplit`, the backfill).
- Cross-dimension conversion only through a bridge the ITEM carries (each-measure, density) via the existing `toBaseUnits`. Never credit a number wearing the wrong unit.
- Money tolerance: `|a − b| ≤ max(0.02, 2 % of b)`.
- Supplier ref everywhere: `{ supplierId, supplierName, canonicalName }` via `pickOffer`.
- `InvoiceScanItem.receivedQtyBase` is a frozen quantity, not a cost. RC clone rows are never run through the rule: clone = parent × (clone total ÷ parent total).
- Prisma `Decimal` arrives as a string in JSON — `Number()` before arithmetic. Prisma singleton from `@/lib/prisma`. No `$executeRaw` tagged templates.
- vitest does NOT type-check: every task runs `npx tsc --noEmit -p tsconfig.json` (0 errors) and `npx eslint` on changed files (no NEW findings vs HEAD; to lint a file at HEAD use `git show HEAD:path`, never `git stash`).
- `npm run build` only in an isolated worktree (it bogus-fails beside a running dev server and rewrites `tsconfig.json`).
- Live DB: the only write in this plan is Task 4 `--apply`, and only after the user has reviewed the dry-run diff.
- Tailwind flat tokens only (`ink`, `ink-2`, `ink-3`, `line`, `blue-soft`, `blue-text`, `gold-soft`, `red-text` …). Sub-components at module scope.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Deliberate refinements of the spec (found while reading the code)

1. **Step order.** The spec lists "shipped unit" before "billed weight". The existing RATE branch prefers the BILLED weight over the shipped quantity (catch-weight: ordered 10 kg, billed 10.4 kg), and the spec's evidence script was billed-first too. Order implemented: frozen → **billed weight proven by the money** → existing RATE branch (unchanged) → **shipped unit is a measure** → printed pack → item/offer pack. No RATE item changes behaviour.
2. **No new review issue.** `classifyDimensionRelationship` (`src/lib/invoice/classify.ts`) already raises the blocking "Needs a unit bridge" (`PACK_BRIDGE`) for a weight line on a COUNT item with no each-measure. `needsBridge` is kept on the return value for the report/backfill, but the review UI reuses the existing issue. Task 5 pins that with a test.
3. **Ambiguous money.** When `price × cases` ALSO reproduces the total, the line is ambiguous and keeps today's rule — even if the shipped and billed numbers are equal. Conservative: never a regression.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/invoice/line-qty.ts` | modify: `lineReceived`, `billedWeightIsPriced`, `ReceivedVia`; `MatchedItemLike` gains bridges; `lineReceivedCountQty` returns `via` |
| `src/lib/__tests__/line-qty.test.ts` | modify: new describe blocks with real-line fixtures |
| `src/lib/invoice/matched-like.ts` | create: `matchedLikeOf(matchedItem)` — the ONE client mapping from `InventoryMatch` to `MatchedItemLike` |
| `src/components/invoices/types.ts` | modify: `InventoryMatch` gains `eachMeasureQty`, `eachMeasureUnit`, `densityGPerMl` |
| `src/lib/invoice/resolution.ts`, `src/components/invoices/v2/card.tsx`, `src/components/invoices/v2/ApprovedReport.tsx` | modify: use `matchedLikeOf`; report shows provenance |
| `src/lib/count-expected.ts` | modify: `buildPurchaseMap` selects + passes the price fields |
| `src/app/api/invoices/sessions/[id]/approve/route.ts` | modify: `lineQtyOf` passes the price fields |
| `src/lib/invoice/received-copy.ts` | create: `receivedViaLabel(via)` — pure copy |
| `scripts/backfill-received-qty-base.ts` | modify: `--refreeze` mode |
| `scripts/export-purchase-valuation.ts` | modify: pass the price fields |
| `CLAUDE.md`, spec | modify: document the rule / as-built |

---

### Task 1: `lineReceived` — the two new steps and provenance

**Files:**
- Modify: `src/lib/invoice/line-qty.ts` (`LineQtyInput`, new exports, body of `lineReceivedBaseUnits`)
- Test: `src/lib/__tests__/line-qty.test.ts` (append)

**Interfaces:**
- Produces:
  - `LineQtyInput` gains `rawUnitPrice?`, `rate?`, `rawLineTotal?` (each `number | string | null`)
  - `type ReceivedVia = 'frozen' | 'billed-weight' | 'rate' | 'shipped-unit' | 'printed-pack' | 'item-pack' | 'none'`
  - `interface Received { base: number; via: ReceivedVia; needsBridge: boolean }`
  - `billedWeightIsPriced(line: LineQtyInput): boolean`
  - `lineReceived(line: LineQtyInput, chainItem: ChainItem): Received`
  - `lineReceivedBaseUnits(line, chainItem): number` — unchanged signature, now `lineReceived(...).base`

- [ ] **Step 1: Append the failing tests** to `src/lib/__tests__/line-qty.test.ts` (the file already has `item()` and `line()` helpers; add `lineReceived, billedWeightIsPriced` to its import):

```ts
describe('line-first receiving — real lines from the 2026-09-20 audit', () => {
  // COUNT item, 24 each/case, 1 each ≈ 0.4 lb (181.4368 g)
  const eggplant = item({
    dimension: 'COUNT', baseUnit: 'each', countUnit: 'each',
    packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 },
    eachMeasureQty: 181.4368, eachMeasureUnit: 'g',
  })
  const eggplantNoBridge = item({
    dimension: 'COUNT', baseUnit: 'each', countUnit: 'each',
    packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 },
  })
  const sausage = item({ dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 7000 }], pricing: { mode: 'PACK', purchasePrice: 60 } })
  const butter  = item({ dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 11350 }], pricing: { mode: 'PACK', purchasePrice: 120 } })
  const zucchini = item({ dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'lb', per: 250 }], pricing: { mode: 'PACK', purchasePrice: 19.96 } })

  it('shipped unit is a weight on a COUNT item → bridged through the each-measure', () => {
    const r = lineReceived(line({ rawQty: 12, rawUnit: 'lb', totalQty: 12, totalQtyUOM: 'lb', rate: 3.49, rateUOM: 'lb', rawUnitPrice: 3.49, rawLineTotal: 41.88 }), eggplant)
    expect(r.base).toBeCloseTo(30, 1)          // was 12 × 24 = 288
    expect(r.needsBridge).toBe(false)
    expect(['billed-weight', 'shipped-unit']).toContain(r.via)
  })

  it('same line, item has NO each-measure → today’s value, needsBridge', () => {
    const r = lineReceived(line({ rawQty: 12, rawUnit: 'lb', totalQty: 12, totalQtyUOM: 'lb', rate: 3.49, rateUOM: 'lb', rawUnitPrice: 3.49, rawLineTotal: 41.88 }), eggplantNoBridge)
    expect(r).toEqual({ base: 288, via: 'item-pack', needsBridge: true })
  })

  it('cases + a billed weight the money proves → the billed weight', () => {
    const r = lineReceived(line({ rawQty: 2, rawUnit: 'CS', totalQty: 14.6, totalQtyUOM: 'kg', rate: 8.5, rateUOM: 'kg', rawUnitPrice: 8.5, rawLineTotal: 124.1, invoicePackQty: 1, invoicePackSize: 7, invoicePackUOM: 'kg' }), sausage)
    expect(r).toEqual({ base: 14600, via: 'billed-weight', needsBridge: false })   // was 14,000 nominal
  })

  it('a mis-scanned printed pack does not matter when the money proves the weight', () => {
    const r = lineReceived(line({ rawQty: 4, rawUnit: 'CS', totalQty: 28.7, totalQtyUOM: 'kg', rate: 8.5, rateUOM: 'kg', rawLineTotal: 243.95, invoicePackQty: 1, invoicePackSize: 1, invoicePackUOM: 'kg' }), sausage)
    expect(r.base).toBe(28700)
    expect(r.via).toBe('billed-weight')
  })

  it('per-weight line on a PACK-priced offer (zucchini: 1 ea, billed 3.02 kg)', () => {
    const r = lineReceived(line({ rawQty: 1, rawUnit: 'ea', totalQty: 3.02, totalQtyUOM: 'kg', rate: 6.61, rateUOM: 'kg', rawUnitPrice: 19.96, rawLineTotal: 19.96 }), zucchini)
    // price×cases (19.96 × 1) ALSO equals the total → ambiguous → today's rule. Pinned on purpose:
    expect(r.via).toBe('item-pack')
  })

  it('…and the same line once rawUnitPrice is the RATE, not the line total, resolves by weight', () => {
    const r = lineReceived(line({ rawQty: 1, rawUnit: 'ea', totalQty: 3.02, totalQtyUOM: 'kg', rate: 6.61, rateUOM: 'kg', rawUnitPrice: 6.61, rawLineTotal: 19.96 }), zucchini)
    expect(r).toEqual({ base: 3020, via: 'billed-weight', needsBridge: false })
  })

  it('Sysco per-case line with a bogus billed-weight column keeps the pack (Butter)', () => {
    const r = lineReceived(line({ rawQty: 2, rawUnit: 'CS', totalQty: 2.86, totalQtyUOM: 'kg', rawUnitPrice: 172.79, rawLineTotal: 345.58, invoicePackQty: 25, invoicePackSize: 454, invoicePackUOM: 'g' }), butter)
    expect(r).toEqual({ base: 22700, via: 'printed-pack', needsBridge: false })
  })

  it('rate unit differs from the billed unit but shares its dimension → converted before the money check', () => {
    // $8.50/kg, billed 32.19 lb (= 14.6 kg) → 124.10
    expect(billedWeightIsPriced(line({ rawQty: 2, rawUnit: 'CS', totalQty: 32.187, totalQtyUOM: 'lb', rate: 8.5, rateUOM: 'kg', rawLineTotal: 124.1 }))).toBe(true)
  })

  it('billedWeightIsPriced refuses: no total, no price, count unit, cross-dimension rate, both reconcile', () => {
    expect(billedWeightIsPriced(line({ totalQty: 5, totalQtyUOM: 'kg', rate: 2 }))).toBe(false)
    expect(billedWeightIsPriced(line({ totalQty: 5, totalQtyUOM: 'kg', rawLineTotal: 10 }))).toBe(false)
    expect(billedWeightIsPriced(line({ totalQty: 5, totalQtyUOM: 'each', rate: 2, rawLineTotal: 10 }))).toBe(false)
    expect(billedWeightIsPriced(line({ totalQty: 5, totalQtyUOM: 'kg', rate: 2, rateUOM: 'l', rawLineTotal: 10 }))).toBe(false)
    expect(billedWeightIsPriced(line({ rawQty: 5, totalQty: 5, totalQtyUOM: 'kg', rate: 2, rawUnitPrice: 2, rawLineTotal: 10 }))).toBe(false)
  })

  it('regression locks: frozen wins; a RATE item still prefers the billed weight over the shipped qty', () => {
    expect(lineReceived(line({ rawQty: 2, receivedQtyBase: '24' }), sausage)).toEqual({ base: 24, via: 'frozen', needsBridge: false })
    const bison = item({ dimension: 'MASS', baseUnit: 'g', countUnit: 'kg', packChain: [{ unit: 'each', per: 1 }, { unit: 'each', per: 1000 }], pricing: { mode: 'RATE', rate: 25, rateUnit: 'kg' } })
    // ordered 10 kg, billed 10.4 kg, NO line total → the money cannot speak → RATE branch, billed first
    expect(lineReceived(line({ rawQty: 10, rawUnit: 'kg', totalQty: 10.4, totalQtyUOM: 'kg' }), bison)).toEqual({ base: 10400, via: 'rate', needsBridge: false })
    // unit-less billed weight still resolves through the priced unit
    expect(lineReceived(line({ rawQty: null, totalQty: 41.025 }), bison).base).toBeCloseTo(41025)
  })

  it('lineReceivedBaseUnits is lineReceived().base for every shape above', () => {
    const l = line({ rawQty: 2, rawUnit: 'CS', totalQty: 14.6, totalQtyUOM: 'kg', rate: 8.5, rateUOM: 'kg', rawLineTotal: 124.1 })
    expect(lineReceivedBaseUnits(l, sausage)).toBe(lineReceived(l, sausage).base)
  })
})
```

- [ ] **Step 2: Run.** `npx vitest run src/lib/__tests__/line-qty.test.ts` → FAIL (`lineReceived` / `billedWeightIsPriced` are not exported). Every pre-existing test in the file must still be listed as passing.

- [ ] **Step 3: Implement.** In `LineQtyInput` add:

```ts
  /** The three money fields. Together they prove whether a billed weight was the
   *  PRICED quantity (price × weight = total) or a column that merely sits on the
   *  invoice (Sysco per-case lines). A caller that omits them never takes the
   *  billed-weight step — safe, but wrong: pass them everywhere. */
  rawUnitPrice?: number | string | null
  rate?: number | string | null
  rawLineTotal?: number | string | null
```

Add below `toBaseUnits`:

```ts
export type ReceivedVia = 'frozen' | 'billed-weight' | 'rate' | 'shipped-unit' | 'printed-pack' | 'item-pack' | 'none'
export interface Received { base: number; via: ReceivedVia; needsBridge: boolean }

/** A weight/volume unit the generic table knows — never a count or a container. */
const isMeasureUnit = (u: string | null | undefined): boolean => {
  if (!u) return false
  const f = UNIT_FACTORS[canonicalUom(u)]
  return !!f && f.dim !== 'count'
}
const moneyAgrees = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.02)

/**
 * Was the billed weight the quantity the line was PRICED on? True only when
 * price × billed reproduces the line total AND price × cases does not. 2026-09-21,
 * 1,773 approved lines: zero disagreements with the OCR pricing mode, and it also
 * covers lines scanned before a mode was recorded. The per-case Sysco lines that
 * carry a stray weight column (Butter "2.86 kg" on 2 × 25 × 454 g) reconcile by
 * CASE and stay on the pack. When both reconcile the line is ambiguous → false.
 */
export function billedWeightIsPriced(line: LineQtyInput): boolean {
  const billed = num(line.totalQty), total = num(line.rawLineTotal)
  if (!(billed > 0) || !(total > 0) || !isMeasureUnit(line.totalQtyUOM)) return false
  const price = num(line.rate) || num(line.rawUnitPrice)
  if (!(price > 0)) return false

  // Price is per rateUOM; express the billed quantity in that unit first.
  let billedInRateUnit = billed
  if (line.rateUOM && UNIT_FACTORS[canonicalUom(line.rateUOM)]) {
    if (dimensionOf(canonicalUom(line.rateUOM)) !== dimensionOf(canonicalUom(line.totalQtyUOM!))) return false
    billedInRateUnit = convertQty(billed, canonicalUom(line.totalQtyUOM!), canonicalUom(line.rateUOM))
  }
  const byWeight = moneyAgrees(price * billedInRateUnit, total)
  const casePrice = num(line.rawUnitPrice), cases = num(line.rawQty)
  const byCase = casePrice > 0 && cases > 0 && moneyAgrees(casePrice * cases, total)
  return byWeight && !byCase
}
```

Replace the body of `lineReceivedBaseUnits` with a wrapper and move the logic into `lineReceived` (the RATE / pack / chain code is the EXISTING code, only returning `{ base, via }` instead of a number):

```ts
export function lineReceivedBaseUnits(line: LineQtyInput, chainItem: ChainItem): number {
  return lineReceived(line, chainItem).base
}

/** THE receiving rule, with its provenance. Order matters:
 *  frozen → billed weight proven by the money → RATE (billed, then shipped) →
 *  shipped unit is a measure → printed pack → the resolved chain. */
export function lineReceived(line: LineQtyInput, chainItem: ChainItem): Received {
  const frozen = num(line.receivedQtyBase)
  if (frozen > 0) return { base: frozen, via: 'frozen', needsBridge: false }

  const qty    = num(line.rawQty)
  const billed = num(line.totalQty)
  const isRate = chainItem.pricing?.mode === 'RATE'
  let needsBridge = false
  const got = (base: number, via: ReceivedVia): Received => ({ base, via, needsBridge })

  // ── The LINE says it was billed by weight, and its own money proves it. The
  //    item's / offer's pricing mode is irrelevant: a pack chain means nothing for
  //    a purchase made by weight.
  if (billedWeightIsPriced(line)) {
    const r = toBaseUnits(billed, line.totalQtyUOM, chainItem)
    if (r !== null) return { base: r, via: 'billed-weight', needsBridge: false }
    needsBridge = true   // a weight on an item with no bridge to it — fall through, say so
  }

  // ── RATE (per-weight / catch-weight) — UNCHANGED. Billed first, then shipped.
  if (isRate) {
    const pricedUnit = chainItem.pricing.mode === 'RATE' ? chainItem.pricing.rateUnit : null
    if (billed > 0) {
      const r = toBaseUnits(billed, line.totalQtyUOM ?? line.rateUOM ?? pricedUnit ?? line.rawUnit, chainItem)
      if (r !== null) return got(r, 'rate')
    }
    if (qty > 0) {
      const r = toBaseUnits(qty, line.rawUnit ?? line.rateUOM ?? pricedUnit, chainItem)
      if (r !== null) return got(r, 'rate')
    }
  }

  if (qty <= 0) return got(0, 'none')

  // ── The shipped quantity's OWN unit is a weight/volume ("12 lb"): that is what
  //    arrived, whatever the item's pack says.
  if (isMeasureUnit(line.rawUnit)) {
    const r = toBaseUnits(qty, line.rawUnit, chainItem)
    if (r !== null) return { base: r, via: 'shipped-unit', needsBridge: false }
    needsBridge = true
  }

  const packQty  = num(line.invoicePackQty)
  const packSize = num(line.invoicePackSize)
  const packUOM  = line.invoicePackUOM ?? null
  if (packQty > 0 && packSize > 0 && packUOM) {
    const r = toBaseUnits(qty * packQty * packSize, packUOM, chainItem)
    if (r !== null) return got(r, 'printed-pack')
  }

  const top = chainItem.packChain?.[0]?.unit
  const perCase = top ? basePerUnit(chainItem, top) : 1
  return got(qty * perCase, 'item-pack')
}
```

Keep every explanatory comment that exists today inside the RATE / pack sections — move them, do not delete them.

- [ ] **Step 4: Run.** `npx vitest run src/lib/__tests__/line-qty.test.ts` → all pass. If a PRE-EXISTING test changes result, stop: that is a behaviour regression the plan did not intend — report it rather than editing the old test.

- [ ] **Step 5: Verify + commit.** `npx tsc --noEmit -p tsconfig.json` → 0 errors; `npx eslint src/lib/invoice/line-qty.ts src/lib/__tests__/line-qty.test.ts`; `npm test`.

```bash
git add src/lib/invoice/line-qty.ts src/lib/__tests__/line-qty.test.ts
git commit -m "feat(invoices): receive what the line says — billed weight proven by its money, shipped weight units"
```

---

### Task 2: Every caller passes the money fields and the item's bridges

Without this task step "billed weight" never fires (no price fields) and the CLIENT cannot bridge a weight to a COUNT item (its `MatchedItemLike` drops the each-measure), so the review UI, the approve route and theoretical stock would disagree about one line — the exact failure that silently drops an RC split.

**Files:**
- Modify: `src/lib/invoice/line-qty.ts` (`MatchedItemLike`, `lineReceivedCountQty`)
- Create: `src/lib/invoice/matched-like.ts`
- Modify: `src/components/invoices/types.ts` (`InventoryMatch`)
- Modify: `src/lib/invoice/resolution.ts` (`hasInvalidRcSplit`), `src/components/invoices/v2/card.tsx` (~:103), `src/components/invoices/v2/ApprovedReport.tsx` (`stockEffect`)
- Modify: `src/lib/count-expected.ts` (`buildPurchaseMap` select + call)
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts` (`lineQtyOf`, the inline `session.scanItems` type)
- Modify: `scripts/export-purchase-valuation.ts`, `scripts/backfill-received-qty-base.ts` (inputs only; `--refreeze` is Task 4)
- Test: `src/lib/__tests__/line-qty.test.ts`, `src/lib/__tests__/matched-like.test.ts`

**Interfaces:**
- Consumes: `lineReceived`, `Received`, `ReceivedVia` (Task 1).
- Produces:
  - `MatchedItemLike` gains `eachMeasureQty?: unknown; eachMeasureUnit?: string | null; densityGPerMl?: unknown`
  - `lineReceivedCountQty(line, matched, offer?) → { qty: number; countUom: string; via: ReceivedVia; needsBridge: boolean }` (superset of today's return — existing destructuring callers keep compiling)
  - `matchedLikeOf(m: InventoryMatch): MatchedItemLike`

- [ ] **Step 1: Failing tests.** Append to `line-qty.test.ts`:

```ts
describe('lineReceivedCountQty carries the item bridges and the provenance', () => {
  const matched = {
    dimension: 'COUNT', baseUnit: 'each', countUnit: 'each',
    packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 },
    eachMeasureQty: '181.4368', eachMeasureUnit: 'g',     // Decimal arrives as a string
  }
  const lb12 = { rawQty: '12', rawUnit: 'lb', totalQty: '12', totalQtyUOM: 'lb', rate: '3.49', rateUOM: 'lb', rawUnitPrice: '3.49', rawLineTotal: '41.88' }

  it('bridges a weight line to a COUNT item on the client exactly as the server does', () => {
    const r = lineReceivedCountQty(lb12, matched)
    expect(r.qty).toBeCloseTo(30, 1)
    expect(r.countUom).toBe('each')
    expect(r.needsBridge).toBe(false)
  })
  it('without the bridge fields it falls back and says so', () => {
    const { eachMeasureQty: _q, eachMeasureUnit: _u, ...bare } = matched
    const r = lineReceivedCountQty(lb12, bare)
    expect(r.qty).toBe(288)
    expect(r.needsBridge).toBe(true)
  })
})
```

`src/lib/__tests__/matched-like.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { matchedLikeOf } from '@/lib/invoice/matched-like'
import type { InventoryMatch } from '@/components/invoices/types'

describe('matchedLikeOf', () => {
  it('maps every field the receiving rule reads, with the same defaults the callers used', () => {
    const m = { id: 'i', itemName: 'Eggplant', pricePerBaseUnit: '0', purchasePrice: '0', baseUnit: 'each',
      packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 },
      eachMeasureQty: '181.4368', eachMeasureUnit: 'g', densityGPerMl: null } as unknown as InventoryMatch
    expect(matchedLikeOf(m)).toEqual({
      dimension: 'COUNT', baseUnit: 'each', packChain: m.packChain, pricing: m.pricing, countUnit: null,
      eachMeasureQty: '181.4368', eachMeasureUnit: 'g', densityGPerMl: null,
    })
  })
})
```

- [ ] **Step 2: Run** → both new blocks FAIL.

- [ ] **Step 3: `line-qty.ts`.** `MatchedItemLike`:

```ts
export interface MatchedItemLike {
  dimension: string
  baseUnit: string | null
  packChain: unknown
  pricing: unknown
  countUnit: string | null
  /** The item's bridges. Without them the client cannot convert a weight to a
   *  COUNT item and would validate an RC split against a different total than
   *  the server and theoretical stock. Decimal arrives as a string. */
  eachMeasureQty?: unknown
  eachMeasureUnit?: string | null
  densityGPerMl?: unknown
}
```

`lineReceivedCountQty` — pass the bridges into `asChainItem` and return the provenance:

```ts
  const chainItem = asChainItem({
    dimension: matched.dimension,
    baseUnit:  matched.baseUnit ?? 'each',
    packChain: matched.packChain,
    pricing:   matched.pricing,
    countUnit: matched.countUnit ?? undefined,
    eachMeasureQty:  matched.eachMeasureQty,
    eachMeasureUnit: matched.eachMeasureUnit ?? null,
    densityGPerMl:   matched.densityGPerMl,
  })
  const dims = { dimension: matched.dimension, baseUnit: matched.baseUnit ?? 'each', packChain: matched.packChain, countUnit: matched.countUnit }
  const countUom = resolveCountUom(dims) || chainItem.baseUnit
  const got = lineReceived(line, resolveLineFormat(chainItem, offer))
  return { qty: convertBaseToCountUom(got.base, countUom, dims), countUom, via: got.via, needsBridge: got.needsBridge }
```

- [ ] **Step 4: `matched-like.ts`** (pure, client-safe):

```ts
import type { InventoryMatch } from '@/components/invoices/types'
import type { MatchedItemLike } from '@/lib/invoice/line-qty'

/** The ONE mapping from the review UI's matched item to what receiving reads.
 *  Three call sites used to hand-build this object and all three dropped the
 *  item's bridges. */
export function matchedLikeOf(m: InventoryMatch): MatchedItemLike {
  return {
    dimension: m.dimension ?? 'COUNT',
    baseUnit:  m.baseUnit ?? 'each',
    packChain: m.packChain,
    pricing:   m.pricing,
    countUnit: m.countUnit ?? null,
    eachMeasureQty:  m.eachMeasureQty ?? null,
    eachMeasureUnit: m.eachMeasureUnit ?? null,
    densityGPerMl:   m.densityGPerMl ?? null,
  }
}
```

`InventoryMatch` (types.ts) gains, beside `countUnit`:

```ts
  // Bridges (PRICING_SELECT already returns them). Decimal serialises as a string.
  eachMeasureQty?: string | number | null
  eachMeasureUnit?: string | null
  densityGPerMl?: string | number | null
```

Confirm the session GET really returns them: `grep -n "PRICING_SELECT" "src/app/api/invoices/sessions/[id]/route.ts"` — the matchedItem select spreads it, and `PRICING_SELECT` (item-model.ts) includes all three.

- [ ] **Step 5: Replace the three hand-built objects** with `matchedLikeOf(item.matchedItem)`:
  - `card.tsx` — the `lineReceivedCountQty(item as …, { dimension: … }, offerForSupplier(…))` call.
  - `resolution.ts` `hasInvalidRcSplit` — keep the `live = { …, receivedQtyBase: null }` line exactly as is.
  - `ApprovedReport.tsx` `stockEffect` — change its return type to `ReturnType<typeof lineReceivedCountQty> | null` so Task 3 can read `via`.
  Then `grep -rn "packChain: item.matchedItem.packChain\|packChain: m.packChain" src` must return nothing.

- [ ] **Step 6: Server callers pass the money fields.**
  - `count-expected.ts` `buildPurchaseMap`: add `rawUnitPrice: true, rate: true, rawLineTotal: true` to the scan-item select and, in the `lineReceivedBaseUnits({...})` literal, `rawUnitPrice: si.rawUnitPrice?.toString() ?? null, rate: si.rate?.toString() ?? null, rawLineTotal: si.rawLineTotal?.toString() ?? null`.
  - approve `lineQtyOf`: the same three, from `scanItem`. `rate` and `rawLineTotal` are already in the route's inline `session.scanItems` type; add `rawUnitPrice` only if tsc says it is missing (it is declared there today). Do NOT add `receivedQtyBase`.
  - `scripts/export-purchase-valuation.ts` `qtyInput(l)` and `scripts/backfill-received-qty-base.ts` `input`: add the three fields and their selects.
  - `scripts/audit-invoice-receipts.ts` / `audit-receipt-fix-delta.ts` are frozen historical audits of an older rule — leave them, but add one comment line at the top of each: `// Historical audit: predates line-first receiving (2026-09-21); its inputs omit the money fields on purpose.`
  - The approve route's `parseValidSplit` passes `scanItem.matchedItem` (a full row incl. the bridge columns) — confirm by reading it that the object satisfies the widened `MatchedItemLike`; it should with no edit.

- [ ] **Step 7: Verify.** `npx vitest run src/lib/__tests__/line-qty.test.ts src/lib/__tests__/matched-like.test.ts` → pass; `npx tsc --noEmit -p tsconfig.json` → 0 errors; eslint changed files; `npm test`. Then prove nothing builds a `LineQtyInput` without the money fields: `grep -rn "invoicePackUOM:" src scripts | grep -v __tests__` — every hit outside the two frozen audit scripts must sit beside `rawLineTotal`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/invoice src/components/invoices src/lib/count-expected.ts "src/app/api/invoices/sessions/[id]/approve/route.ts" scripts src/lib/__tests__
git commit -m "feat(invoices): every reader gives the receiving rule the line's money and the item's bridges"
```

---

### Task 3: Say how a quantity was received

**Files:**
- Create: `src/lib/invoice/received-copy.ts`
- Test: `src/lib/__tests__/received-copy.test.ts`
- Modify: `src/components/invoices/v2/ApprovedReport.tsx` (the two places that render `stock.qty … stock.countUom`, ~:271 and ~:381), `src/components/invoices/v2/card.tsx` (where `received` is shown beside the RC split)

**Interfaces:**
- Consumes: `ReceivedVia` (Task 1); `lineReceivedCountQty(...).via / .needsBridge` (Task 2).
- Produces: `receivedViaLabel(via: ReceivedVia): string | null`; `receivedNote(r: { via: ReceivedVia; needsBridge: boolean }): string | null`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest'
import { receivedViaLabel, receivedNote } from '@/lib/invoice/received-copy'

describe('received-copy', () => {
  it('labels each provenance in plain words; the pack paths need no label', () => {
    expect(receivedViaLabel('billed-weight')).toBe('billed weight')
    expect(receivedViaLabel('shipped-unit')).toBe('shipped by weight')
    expect(receivedViaLabel('rate')).toBe('billed weight')
    expect(receivedViaLabel('frozen')).toBe(null)
    expect(receivedViaLabel('printed-pack')).toBe(null)
    expect(receivedViaLabel('item-pack')).toBe(null)
    expect(receivedViaLabel('none')).toBe(null)
  })
  it('warns when a weight could not be converted', () => {
    expect(receivedNote({ via: 'item-pack', needsBridge: true }))
      .toBe('Billed by weight, but this item has no weight per each — received through its pack instead.')
    expect(receivedNote({ via: 'billed-weight', needsBridge: false })).toBe(null)
  })
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `received-copy.ts`:

```ts
import type { ReceivedVia } from '@/lib/invoice/line-qty'

/** Shown only when it tells the reader something the pack does not. */
export function receivedViaLabel(via: ReceivedVia): string | null {
  if (via === 'billed-weight' || via === 'rate') return 'billed weight'
  if (via === 'shipped-unit') return 'shipped by weight'
  return null
}

export function receivedNote(r: { via: ReceivedVia; needsBridge: boolean }): string | null {
  return r.needsBridge
    ? 'Billed by weight, but this item has no weight per each — received through its pack instead.'
    : null
}
```

- [ ] **Step 4: Render.** In `ApprovedReport.tsx`, directly after each `<span className="font-mono">{qty(stock.qty)} {stock.countUom}</span>`:

```tsx
{receivedViaLabel(stock.via) && <span className="text-ink-3"> · {receivedViaLabel(stock.via)}</span>}
```

and, once per row under the stock line, `{receivedNote(stock) && <p className="text-[12px] text-red-text">{receivedNote(stock)}</p>}`. In `card.tsx`, where the RC-split target (`received.qty received.countUom`) is displayed, add the same `· label`. An APPROVED line reports `via: 'frozen'` (no label) — that is correct: the report then shows the frozen number, and the label appears on lines not yet approved or re-computed. Do not change any number, layout block, or class outside these insertions.

- [ ] **Step 5: Verify + commit.** Focused tests, `tsc`, eslint, `npm test`.

```bash
git add src/lib/invoice/received-copy.ts src/lib/__tests__/received-copy.test.ts src/components/invoices/v2/ApprovedReport.tsx src/components/invoices/v2/card.tsx
git commit -m "feat(invoices): show when a line was received by its billed or shipped weight"
```

---

### Task 4: `--refreeze` — re-freeze history behind a reviewed diff

**Files:**
- Modify: `scripts/backfill-received-qty-base.ts`

**Interfaces:**
- Consumes: `lineReceived` (Task 1), the widened inputs (Task 2).

Modes after this task: no flag = dry run of the ORIGINAL backfill (fills only NULL rows — now a no-op on this DB); `--refreeze` = recompute EVERY approved line ignoring the stored value, dry run; `--refreeze --apply` = backup, then update only the rows that change.

- [ ] **Step 1: Implement.** Add `const REFREEZE = process.argv.includes('--refreeze')`. Extend the select with `id`, `sessionId`, `sortOrder`, `splitToSessionId`, `receivedQtyBase`, `rawUnitPrice`, `rate`, `rawLineTotal`, and `session: { select: { …existing…, parentSessionId: true } }`. In `--refreeze` mode:

```ts
  // PARENTS and ordinary lines: run the rule (never pass receivedQtyBase).
  // CLONES (session.parentSessionId != null): never run the rule — a clone carries
  // its parent's share. A parent with a null rawQty clones to rawQty = share, which
  // can make "price × cases" reconcile by accident and flip the clone's branch.
  const byKey = new Map<string, typeof lines[number]>()          // parentSessionId|description|sortOrder → parent
  for (const l of lines) if (!l.session.parentSessionId) byKey.set(`${l.sessionId}|${l.rawDescription}|${l.sortOrder}`, l)

  const next = new Map<string, { base: number; via: string; needsBridge: boolean }>()
  for (const l of lines) {
    if (!l.matchedItem || l.session.parentSessionId) continue
    const chain = resolveLineFormat(asChainItem(l.matchedItem), pickOffer(l.matchedItem.supplierPrices, { supplierId: l.session.supplierId, supplierName: l.session.supplierName, canonicalName: l.session.supplier?.name ?? null }))
    next.set(l.id, lineReceived(inputOf(l), chain))               // inputOf = the Task-2 literal, WITHOUT receivedQtyBase
  }
  const orphans: string[] = []
  for (const l of lines) {
    if (!l.session.parentSessionId) continue
    const parent = byKey.get(`${l.session.parentSessionId}|${l.rawDescription}|${l.sortOrder}`)
    const p = parent ? next.get(parent.id) : undefined
    const pt = parent ? Number(parent.rawLineTotal) : 0, ct = Number(l.rawLineTotal)
    if (!parent || !p || !(pt > 0) || !(ct > 0)) { orphans.push(l.id); continue }   // leave the clone's frozen value alone
    next.set(l.id, { base: p.base * (ct / pt), via: `clone of ${p.via}`, needsBridge: p.needsBridge })
  }
```

Diff rows = lines where `|next.base − Number(receivedQtyBase)| > max(0.001, 0.5 %)`, each with `item, base unit, supplier, invoice, date, line, qty+unit, billed+unit, price, total, pack, old, next, ratio, via, needsBridge, isClone`. Write `received-qty-refreeze-diff-<stamp>.json`. Print: total lines, changed, a count per `via`, the number of `needsBridge` lines, the number of orphan clones, and — as its own loud section — **every changed line whose `via` is `printed-pack` or `item-pack`** (the rule should only ever move lines TO a weight; a pack-path change means something else shifted). `--apply`: write `received-qty-refreeze-backup-<stamp>.json` (`{ id, prev }` for the changed rows only) and update just those rows. Skip rows whose `next.base <= 0`.

- [ ] **Step 2: Type-check the script** (scripts may sit outside tsconfig's include — if so, a throwaway tsconfig in `/tmp` that `extends` the repo's and includes the one file; delete it after). `npx eslint scripts/backfill-received-qty-base.ts`.

- [ ] **Step 3: Dry run — controller only, read-only.** `npx tsx scripts/backfill-received-qty-base.ts --refreeze`. **Acceptance gates before anyone is asked to apply:**
  - the changed set is in the order of ~27 lines (7 shipped-unit + ~20 billed-weight, plus their clones);
  - **Butter, Halloumi, CHEESE CURD, Goats Cheese, Brioche Unsliced do NOT appear.** If any does, the rule is wrong — STOP, do not apply, report;
  - the "pack-path changes" section is empty;
  - bridged lines (Eggplant, Kale, Lettuce Burger) are listed with `via` and the each-measure they used — Lettuce Burger `5 lb → 0.5 each` indicates a wrong each-measure on that ITEM; flag it to the user, who may fix the item and re-run the dry run before applying.

- [ ] **Step 4: Hand the diff to the user and STOP.** Apply only on their explicit OK: `npx tsx scripts/backfill-received-qty-base.ts --refreeze --apply`. Then re-run the dry run → `0 changed`.

- [ ] **Step 5: Commit** (the script only — never the diff/backup JSON)

```bash
git add scripts/backfill-received-qty-base.ts
git commit -m "chore(scripts): --refreeze re-freezes received quantities under the current rule, clones by share"
```

---

### Task 5: Pin the existing bridge issue, document, build

**Files:**
- Test: `src/lib/__tests__/invoice-bridge.test.ts` (append; it already tests `classifyDimensionRelationship`)
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-09-21-line-first-receiving-design.md`

- [ ] **Step 1: Pin the review issue the plan relies on.** Read the top of `invoice-bridge.test.ts` for its fixture helper, then add:

```ts
it('a weight-billed line on a COUNT item with no each-measure still raises the pack bridge (line-first relies on it)', () => {
  const v = classifyDimensionRelationship(scanItem({
    rawQty: '12', rawUnit: 'lb', totalQty: '12', totalQtyUOM: 'lb', rate: '3.49', rateUOM: 'lb', pricingMode: 'per_weight',
    matchedItem: { dimension: 'COUNT', baseUnit: 'each', itemName: 'Eggplant', eachMeasureQty: null, eachMeasureUnit: null },
  }))
  expect(v.verdict).toBe('PACK_BRIDGE')
})
it('…and is IDENTICAL once the item carries an each-measure in that dimension', () => {
  const v = classifyDimensionRelationship(scanItem({
    rawQty: '12', rawUnit: 'lb', totalQty: '12', totalQtyUOM: 'lb', rate: '3.49', rateUOM: 'lb', pricingMode: 'per_weight',
    matchedItem: { dimension: 'COUNT', baseUnit: 'each', itemName: 'Eggplant', eachMeasureQty: '181.4368', eachMeasureUnit: 'g' },
  }))
  expect(v.verdict).toBe('IDENTICAL')
})
```

Adapt `scanItem(...)` to whatever builder that file uses (it may be an object literal cast to `ScanItem`). If the first test FAILS — i.e. the review UI does NOT already flag this case — stop and report: the plan's refinement #2 is wrong and the spec's info issue must be built after all.

- [ ] **Step 2: CLAUDE.md.** In the "One item, many suppliers" paragraph replace the sentence beginning "Known gap (follow-up spec):" with:

```markdown
**Line-first receiving:** `lineReceived(line, chainItem)` in [src/lib/invoice/line-qty.ts](src/lib/invoice/line-qty.ts) is THE receiving rule and returns its provenance (`via`). Order: frozen → billed weight **proven by the line's own money** (`billedWeightIsPriced`: price × weight = total and price × cases ≠ total) → the RATE branch → a shipped quantity whose own unit is a weight/volume → printed pack → the resolved chain. The item's/offer's pricing mode never overrides a weight the invoice states. Never trust a billed-weight column without the money check — Sysco per-case lines carry a stray one (Butter "2.86 kg" on 2 × 25 × 454 g). Anything that builds a `LineQtyInput` must pass `rawUnitPrice`/`rate`/`rawLineTotal`, and anything that builds a `MatchedItemLike` on the client must use `matchedLikeOf` (it carries the item's bridges) — otherwise review, approve and theoretical stock disagree about one line and an RC split is silently dropped. RC clone rows are never run through the rule: clone = parent × share.
```

Verify each named path/export exists before committing.

- [ ] **Step 3: Spec.** Set `**Status:**` to implemented and append an "As built" section listing the three deliberate refinements from the top of this plan plus whatever the dry run showed (changed-line count, any item whose each-measure was corrected).

- [ ] **Step 4: Build.** In an isolated worktree with its own `node_modules`: `npm test`, `npx tsc --noEmit -p tsconfig.json`, `npm run build` → `✓ Compiled`; `git status` clean afterwards (tsconfig not rewritten).

- [ ] **Step 5: Commit**

```bash
git add src/lib/__tests__/invoice-bridge.test.ts CLAUDE.md docs/superpowers/specs/2026-09-21-line-first-receiving-design.md
git commit -m "docs: line-first receiving — the rule, its money check, and the caller contracts"
```

---

## Self-Review Notes

- **Spec coverage:** rule steps → Task 1 · money fields + bridges at every caller → Task 2 · provenance → Task 3 · `--refreeze`, clones by share, acceptance gates → Task 4 · `needsBridge` review surface → already exists, pinned in Task 5 · testing/rollout → each task; no migration.
- **Pinned on purpose:** the zucchini line as scanned has `rawUnitPrice` equal to the line total, so both money hypotheses reconcile and it stays on today's rule (Task 1 test 5). The refreeze diff will show whether that is the stored shape; if it is, the fix is a data correction of that one line's `rawUnitPrice`, not a looser rule.
- **Type consistency:** `Received { base, via, needsBridge }` (Task 1) is what `lineReceivedCountQty` spreads into its return (Task 2), what `receivedNote` reads (Task 3) and what `--refreeze` stores in its map (Task 4). `MatchedItemLike`'s three bridge fields are optional, so the approve route's full item row and older test fixtures keep compiling.
