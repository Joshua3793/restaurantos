# Weight-Priced Count Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A line sold by weight on an item counted in `each` is PRICED by weight — `$3.49/lb × 0.4 lb = $1.40 per eggplant`, not `$3.49 ÷ 24 = $0.15` — by storing the supplier's real `$/lb` and deriving `$/each` through the item's each-measure at read time.

**Architecture:** One pure helper, `ratePerBase(rate, rateUnit, item)`, becomes the RATE branch of `pricePerBaseUnit` (same dimension → unchanged; COUNT↔measured via each-measure; MASS↔VOLUME via density; no bridge → 0). Offers are priced WITH their item. Approve decides "price by weight?" from how line-first receiving received the line (`via`), so quantity × price = line total by construction. A repair script rewrites the three mis-stored offers behind a reviewed dry run. Spec: `docs/superpowers/specs/2026-09-21-weight-priced-count-items-design.md`.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + Postgres (Supabase, pgBouncer transaction mode) · vitest · Tailwind (flat tokens).

## Global Constraints

- `src/lib/item-model.ts` is the pricing spine: pure, client-safe, imports only `./utils`. `pricePerBaseUnit(item)` stays THE algorithm — never add a parallel price function; never store a derived `$/each`.
- **No existing number may change.** Live data has 0 items and 0 offers with a cross-dimension RATE (verified 2026-09-21), so the same-dimension RATE branch and the PACK branch must be byte-identical in behaviour. Task 2 proves it with a before/after dump.
- A rate that cannot be bridged to the item's base unit prices as **0** ("unpriced"), never as `rate ÷ conv(rateUnit)`.
- The price basis follows the receiving basis: approve prices by weight exactly when `lineReceived(...).via` is `'billed-weight'` or `'shipped-unit'`. For those lines `received.base × newPricePerBase ≈ rawLineTotal` (±2 %).
- The Brioche shape (per-case line whose pack prints `8 × 1100 g` on a bridged COUNT item; received via `'printed-pack'`) keeps its CASE pricing exactly.
- Bridges always come from the ITEM (`eachMeasure`, `densityGPerMl`), never from an offer.
- Supplier ref everywhere: `{ supplierId, supplierName, canonicalName }` via `pickOffer`. `lineQtyOf` never carries `receivedQtyBase`.
- Prisma `Decimal` arrives as a string in JSON — `Number()` before arithmetic. Prisma singleton from `@/lib/prisma`. No `$executeRaw` tagged templates.
- vitest does NOT type-check: every task runs `npx tsc --noEmit -p tsconfig.json` (0 errors) and `npx eslint` on changed files (no NEW findings vs HEAD; lint a HEAD copy via `git show HEAD:path`, never `git stash`).
- `npm run build` only in an isolated worktree. Subagents never connect to the database, never start a dev server, never run a script against live data.
- Live DB: the only write in this plan is Task 5 `--apply`, after the user reviews the dry run.
- Tailwind flat tokens only (`ink`, `ink-2`, `ink-3`, `ink-4`, `line`, `blue-soft`, `blue-text`, `gold-soft`, `red-text` …). Sub-components at module scope.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/item-model.ts` | modify: `ratePerBase`, bridge-aware RATE branch, `validateChainItem` relaxation |
| `src/lib/__tests__/item-model.test.ts` | modify: the four RATE branches + regression lock |
| `src/lib/supplier-offers.ts` | modify: `offerPricePerBase(offer, item)`; `getSupplierOffers` loads the item's bridges |
| `src/app/api/invoices/sessions/[id]/route.ts`, `src/app/api/reports/analytics/route.ts`, `src/lib/invoice/resolution.ts` | modify: pass the item |
| `src/lib/invoice/line-format.ts` | modify: `rateOk` accepts a bridged rate |
| `scripts/audit-ppb-snapshot.ts` | create: read-only dump of every item + offer ppb (before/after proof) |
| `src/lib/invoice/approve-format.ts` | modify: `pricingBasisFor` (pure) |
| `src/app/api/invoices/sessions/[id]/approve/route.ts` | modify: hoist `received`, price by basis, bridge-aware guard + `oldPpb` |
| `src/lib/invoice/calculations.ts` | modify: `computeNormalisedPrices` bridges the invoice price to the item base |
| `src/lib/invoice/offer-copy.ts` | create: `offerPriceLabel`, `offerDerivation` (pure copy) |
| `src/components/inventory/SupplierOffersSection.tsx` | modify: real price unit + derivation line |
| `src/app/api/inventory/[id]/route.ts` | modify: never clobber a bridged RATE through a form that cannot express it |
| `scripts/repair-weight-priced-offers.ts`, `src/lib/invoice/offer-repair.ts` | create: repair + its pure decision |
| `CLAUDE.md`, spec | modify |

---

### Task 1: `ratePerBase` and the bridge-aware price formula

**Files:**
- Modify: `src/lib/item-model.ts` (`pricePerBaseUnit` ~:83, `validateChainItem` ~:160)
- Test: `src/lib/__tests__/item-model.test.ts` (append)

**Interfaces:**
- Produces:
  - `ratePerBase(rate: number, rateUnit: string, item: Pick<ChainItem, 'dimension' | 'baseUnit' | 'eachMeasure' | 'densityGPerMl'>): number`
  - `rateIsCostable(rateUnit: string, item: same Pick): boolean`
  - `pricePerBaseUnit(item)` — unchanged signature; RATE branch = `ratePerBase(p.rate, p.rateUnit, item)`

- [ ] **Step 1: Append the failing tests**

```ts
import { ratePerBase, rateIsCostable } from '@/lib/item-model'

describe('ratePerBase — a rate in another dimension prices through the ITEM bridge', () => {
  const eggplant = { dimension: 'COUNT' as const, baseUnit: 'each', eachMeasure: { qty: 0.4, unit: 'lb' }, densityGPerMl: null }
  const lettuce  = { dimension: 'COUNT' as const, baseUnit: 'each', eachMeasure: { qty: 250, unit: 'g' }, densityGPerMl: null }
  const bare     = { dimension: 'COUNT' as const, baseUnit: 'each', eachMeasure: null, densityGPerMl: null }

  it('same dimension is UNCHANGED (rate ÷ conv)', () => {
    expect(ratePerBase(25, 'kg', { dimension: 'MASS', baseUnit: 'g', eachMeasure: null, densityGPerMl: null })).toBeCloseTo(0.025)
    expect(ratePerBase(1.99, 'each', bare)).toBeCloseTo(1.99)
  })
  it('COUNT item, $/lb: $/g × g per each', () => {
    expect(ratePerBase(3.49, 'lb', eggplant)).toBeCloseTo(1.396, 3)   // 3.49 × 0.4
    expect(ratePerBase(5.25, 'lb', lettuce)).toBeCloseTo(2.894, 3)    // 5.25 / 453.592 × 250
  })
  it('the derived price moves with the each-measure, nothing stored changes', () => {
    expect(ratePerBase(5.25, 'lb', { ...lettuce, eachMeasure: { qty: 100, unit: 'g' } })).toBeCloseTo(1.157, 3)
  })
  it('measured item, $/each: rate ÷ base per each', () => {
    const limes = { dimension: 'MASS' as const, baseUnit: 'g', eachMeasure: { qty: 67, unit: 'g' }, densityGPerMl: null }
    expect(ratePerBase(0.5, 'each', limes)).toBeCloseTo(0.5 / 67, 6)
  })
  it('MASS ↔ VOLUME crosses through density, both directions', () => {
    const oil = { dimension: 'VOLUME' as const, baseUnit: 'ml', eachMeasure: null, densityGPerMl: 0.92 }
    expect(ratePerBase(10, 'kg', oil)).toBeCloseTo(0.01 * 0.92, 6)          // $/g × g/ml
    const honey = { dimension: 'MASS' as const, baseUnit: 'g', eachMeasure: null, densityGPerMl: 1.42 }
    expect(ratePerBase(14.2, 'l', honey)).toBeCloseTo(0.0142 / 1.42, 6)     // $/ml ÷ g/ml
  })
  it('no bridge → 0 (unpriced), never rate ÷ conv', () => {
    expect(ratePerBase(3.49, 'lb', bare)).toBe(0)
    expect(ratePerBase(3.49, 'lb', { ...eggplant, eachMeasure: { qty: 300, unit: 'ml' } })).toBe(0) // bridge is in the wrong dimension
    expect(ratePerBase(10, 'kg', { dimension: 'VOLUME', baseUnit: 'ml', eachMeasure: null, densityGPerMl: null })).toBe(0)
  })
  it('garbage in → 0', () => {
    expect(ratePerBase(NaN, 'lb', eggplant)).toBe(0)
    expect(ratePerBase(3.49, '', eggplant)).toBe(0)
  })
  it('rateIsCostable mirrors it', () => {
    expect(rateIsCostable('lb', eggplant)).toBe(true)
    expect(rateIsCostable('lb', bare)).toBe(false)
    expect(rateIsCostable('each', bare)).toBe(true)
  })
})

describe('pricePerBaseUnit / validateChainItem with a bridged RATE', () => {
  const item: ChainItem = {
    dimension: 'COUNT', baseUnit: 'each', packChain: [{ unit: 'case', per: 24 }],
    pricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' }, eachMeasure: { qty: 0.4, unit: 'lb' },
  }
  it('prices through the bridge', () => expect(pricePerBaseUnit(item)).toBeCloseTo(1.396, 3))
  it('is valid WITH the bridge and invalid without it', () => {
    expect(validateChainItem(item)).toEqual([])
    expect(validateChainItem({ ...item, eachMeasure: null })).toContain('RATE.rateUnit must share the item dimension (or be bridged by the item’s each-measure / density)')
  })
  it('PACK is untouched', () => {
    expect(pricePerBaseUnit({ ...item, pricing: { mode: 'PACK', purchasePrice: 70.3 } })).toBeCloseTo(70.3 / 24)
  })
})
```

The existing test at ~:108 asserts the OLD error string `'RATE.rateUnit must share the item dimension'` — update that one assertion to the new string (it is the same rule, reworded); no other existing test may change.

- [ ] **Step 2: Run.** `npx vitest run src/lib/__tests__/item-model.test.ts` → the new blocks FAIL (`ratePerBase` not exported).

- [ ] **Step 3: Implement** in `item-model.ts`, replacing the RATE branch:

```ts
type RateItem = Pick<ChainItem, 'dimension' | 'baseUnit' | 'eachMeasure' | 'densityGPerMl'>

/** Base units (g | ml) in ONE each, or 0 when the item has no each-measure. */
function basePerEach(item: RateItem): { dim: Dimension; v: number } | null {
  const em = item.eachMeasure
  if (!em || !(Number(em.qty) > 0) || !em.unit) return null
  const dim = dimensionOf(em.unit)
  if (dim === 'COUNT') return null
  return { dim, v: Number(em.qty) * getUnitConv(em.unit) }
}

/** Can a price quoted per `rateUnit` be expressed per this item's base unit? */
export function rateIsCostable(rateUnit: string, item: RateItem): boolean {
  if (!rateUnit) return false
  const rd = dimensionOf(rateUnit)
  if (rd === item.dimension) return true
  if (rd === 'COUNT' || item.dimension === 'COUNT') {
    const b = basePerEach(item)
    return !!b && b.dim === (rd === 'COUNT' ? item.dimension : rd)
  }
  return Number(item.densityGPerMl) > 0 // MASS ↔ VOLUME
}

/**
 * $ per the ITEM's base unit for a price quoted per `rateUnit`.
 *  • same dimension            → rate ÷ conv(rateUnit)              (unchanged)
 *  • COUNT item, $/lb          → $/g × g per each                   (each-measure)
 *  • measured item, $/each     → rate ÷ base per each
 *  • MASS ↔ VOLUME             → × or ÷ density (g/ml)
 *  • no bridge                 → 0: UNPRICED. Never rate ÷ conv — that is a $/g
 *                                number wearing a $/each label.
 * The supplier's real price is what is stored; $/each is DERIVED here, so it
 * follows the each-measure when a human corrects it.
 */
export function ratePerBase(rate: number, rateUnit: string, item: RateItem): number {
  const r = Number(rate)
  if (!Number.isFinite(r) || !(r > 0) || !rateUnit || !rateIsCostable(rateUnit, item)) return 0
  const conv = getUnitConv(rateUnit)
  if (!(conv > 0)) return 0
  const perRateBase = r / conv                       // $/g, $/ml or $/each
  const rd = dimensionOf(rateUnit)
  if (rd === item.dimension) return perRateBase
  if (item.dimension === 'COUNT') return perRateBase * basePerEach(item)!.v
  if (rd === 'COUNT') return perRateBase / basePerEach(item)!.v
  const d = Number(item.densityGPerMl)
  return rd === 'MASS' ? perRateBase * d : perRateBase / d   // → $/ml, or → $/g
}
```

```ts
export function pricePerBaseUnit(item: ChainItem): number {
  const p = item.pricing
  if (p?.mode === 'RATE') return ratePerBase(Number(p.rate || 0), p.rateUnit, item)
  const denom = basePerPurchase(item.packChain)
  return denom > 0 ? Number((p as { purchasePrice?: number })?.purchasePrice || 0) / denom : 0
}
```

`validateChainItem`:

```ts
  if (item.pricing?.mode === 'RATE' && !rateIsCostable(item.pricing.rateUnit, item))
    errs.push('RATE.rateUnit must share the item dimension (or be bridged by the item’s each-measure / density)')
```

**Same-dimension check to do by hand before moving on:** the old branch returned `rate / conv` for ANY rateUnit, including an unknown one (`getUnitConv` falls back to 1, and `dimensionOf` maps unknown → COUNT). With the new code a RATE `{ rateUnit: 'bunch' }` on a COUNT item is same-dimension → unchanged; on a MASS item it is now 0 instead of `rate / 1`. That is the intended "unpriced, not garbage" — note it in the report; Task 2's dump proves no live row is affected.

- [ ] **Step 4: Run** → all pass, incl. every pre-existing test (one reworded string).

- [ ] **Step 5: Verify + commit.** `npx tsc --noEmit -p tsconfig.json` → 0 (other callers of `pricePerBaseUnit` that hand-build a `ChainItem` without bridges still compile — bridges are optional); eslint; `npm test`.

```bash
git add src/lib/item-model.ts src/lib/__tests__/item-model.test.ts
git commit -m "feat(pricing): a rate in another dimension prices through the item's each-measure or density"
```

---

### Task 2: Offers are priced WITH their item; prove no live number moves

**Files:**
- Modify: `src/lib/supplier-offers.ts` (`offerPricePerBase`, `getSupplierOffers`)
- Modify: `src/app/api/invoices/sessions/[id]/route.ts` (~:42-47), `src/app/api/reports/analytics/route.ts` (~:478-480), `src/lib/invoice/resolution.ts` (`cheapestOtherOffer` ×2, the big-price-change check ~:119)
- Modify: `src/lib/invoice/line-format.ts` (`rateOk`)
- Create: `scripts/audit-ppb-snapshot.ts`
- Test: `src/lib/__tests__/supplier-offers.test.ts` (create if absent), `src/lib/__tests__/line-format.test.ts`

**Interfaces:**
- Consumes: `ratePerBase`, `rateIsCostable`, `asChainItem`, `PRICING_SELECT` (Task 1 / existing).
- Produces:
  - `type OfferItem = { dimension: string; baseUnit: string | null; eachMeasureQty?: unknown; eachMeasureUnit?: string | null; densityGPerMl?: unknown }`
  - `offerPricePerBase(offer: { packChain?: unknown; pricing?: unknown }, item: OfferItem): number` — `item` is REQUIRED

- [ ] **Step 1: Failing tests** (`supplier-offers.test.ts`; import only the pure export — if importing the module instantiates Prisma, move `offerPricePerBase` + `OfferItem` to a new pure file `src/lib/offer-price.ts`, re-export it from `supplier-offers.ts`, and test the pure file):

```ts
const eggplant = { dimension: 'COUNT', baseUnit: 'each', eachMeasureQty: '0.4', eachMeasureUnit: 'lb', densityGPerMl: null }
it('a PACK offer prices over its own chain, item irrelevant', () => {
  expect(offerPricePerBase({ packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 } }, eggplant)).toBeCloseTo(70.3 / 24)
})
it('a $/lb offer on a COUNT item prices through the item each-measure', () => {
  expect(offerPricePerBase({ packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' } }, eggplant)).toBeCloseTo(1.396, 3)
})
it('…and is UNPRICED when the item has no bridge', () => {
  expect(offerPricePerBase({ packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' } }, { ...eggplant, eachMeasureQty: null, eachMeasureUnit: null })).toBe(0)
})
it('no chain → 0, as before', () => {
  expect(offerPricePerBase({ packChain: null, pricing: { mode: 'PACK', purchasePrice: 5 } }, eggplant)).toBe(0)
})
```

`line-format.test.ts` — append:

```ts
it('a $/lb RATE offer on a bridged COUNT item is adopted and is NOT implausible', () => {
  const eggplantItem = asChainItem({ dimension: 'COUNT', baseUnit: 'each', packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 }, eachMeasureQty: 0.4, eachMeasureUnit: 'lb' })
  const r = resolveLineFormat(eggplantItem, { packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' } })
  expect(r.pricing).toEqual({ mode: 'RATE', rate: 3.49, rateUnit: 'lb' })   // $1.40 vs the item's $2.93 — a real 2× gap, not 20×
})
it('…and is ignored when the item has no bridge', () => {
  const bare = asChainItem({ dimension: 'COUNT', baseUnit: 'each', packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 } })
  expect(resolveLineFormat(bare, { packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' } }).pricing).toEqual(bare.pricing)
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.**

`offerPricePerBase`:

```ts
export function offerPricePerBase(offer: { packChain?: unknown; pricing?: unknown }, item: OfferItem): number {
  const chain = Array.isArray(offer.packChain) ? offer.packChain : null
  const pricing = offer.pricing && typeof offer.pricing === 'object' ? offer.pricing : null
  if (!chain || !chain.length || !pricing) return 0 // no chain ⇒ unpriced offer
  // The offer supplies the pack and the price; the ITEM supplies the base unit and
  // the bridges. A $/lb offer on an `each` item is only priceable through the
  // item's each-measure — which is why the item is a required argument.
  return chainPpb(asChainItem({
    dimension: item.dimension, baseUnit: item.baseUnit ?? 'each', packChain: chain, pricing,
    eachMeasureQty: item.eachMeasureQty, eachMeasureUnit: item.eachMeasureUnit ?? null, densityGPerMl: item.densityGPerMl,
  }))
}
```

Call sites — each passes the item it already has:
- session GET: `offerPricePerBase(o, si.matchedItem)` (the select spreads `PRICING_SELECT`, which includes the bridge columns).
- analytics: read ~:470-480; `inv = itemOffers[0].inventoryItem` — make sure its select includes `...PRICING_SELECT`, then `offerPricePerBase(o, inv)`.
- `getSupplierOffers`: widen the item select to `{ ...PRICING_SELECT }` and pass `item`.
- `resolution.ts` (client): `item.matchedItem` is an `InventoryMatch` and already carries the bridge fields → `offerPricePerBase(o, item.matchedItem!)` at all three sites (guard the null the same way the surrounding code does).

`line-format.ts` — replace the dimension test in `rateOk`:

```ts
  const rateOk = p?.mode === 'RATE' && usable(p.rate) && !!p.rateUnit && rateIsCostable(p.rateUnit, item)
```

(`item` is a full `ChainItem`, so it carries the bridges.)

- [ ] **Step 4: `scripts/audit-ppb-snapshot.ts`** — read-only:

```ts
/**
 * READ-ONLY. Dump $/base for every item and every supplier offer, so a change to
 * the price formula can be PROVEN to move no live number.
 *   npx tsx scripts/audit-ppb-snapshot.ts > /tmp/ppb-<label>.json
 * Run it on main and on the branch, then `diff` the two files.
 */
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '../src/lib/item-model'
import { offerPricePerBase } from '../src/lib/supplier-offers'

async function main() {
  const items = await prisma.inventoryItem.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, itemName: true, ...PRICING_SELECT, supplierPrices: { orderBy: { id: 'asc' }, select: { id: true, supplierName: true, packChain: true, pricing: true } } },
  })
  const out = items.map(i => ({
    id: i.id, item: i.itemName, ppb: +pricePerBaseUnit(asChainItem(i)).toFixed(10),
    offers: i.supplierPrices.map(o => ({ id: o.id, supplier: o.supplierName, ppb: +offerPricePerBase(o, i).toFixed(10) })),
  }))
  process.stdout.write(JSON.stringify(out, null, 1) + '\n')
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
```

On `main` `offerPricePerBase` takes ONE argument — so to snapshot main, the controller runs a copy of this script with `offerPricePerBase(o)` from a main worktree. **The implementer does not run it.**

- [ ] **Step 5: Verify.** Focused tests; `tsc` 0 errors — the compiler now lists every caller that forgot the item (that is the point of making it required); eslint; `npm test`. `grep -rn "offerPricePerBase(" src | grep -v __tests__` — every hit has two arguments.

- [ ] **Step 6: Commit**

```bash
git add src/lib src/app/api/invoices "src/app/api/reports/analytics/route.ts" scripts/audit-ppb-snapshot.ts
git commit -m "feat(pricing): an offer is priced with its item, so a \$/lb offer on an each-item uses the each-measure"
```

- [ ] **Step 7 (controller, read-only):** snapshot main vs branch, `diff` → **must be empty**. Any difference is a regression: stop.

---

### Task 3: Approve prices a line the way it was received

**Files:**
- Modify: `src/lib/invoice/approve-format.ts`
- Test: `src/lib/__tests__/approve-format.test.ts`
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts` (the UPDATE_PRICE / ADD_SUPPLIER block: `isUomMode` ~:222, rate-unit resolution ~:263-277, guard ~:398, `oldPpb` ~:438, freeze ~:614)

**Interfaces:**
- Consumes: `lineReceived`, `Received`, `ReceivedVia` (`line-qty.ts`); `ratePerBase`, `rateIsCostable` (Task 1).
- Produces: `pricingBasisFor(a: { via: ReceivedVia; ocrPerWeight: boolean; itemHasEachMeasure: boolean }): 'WEIGHT' | 'CASE'`

- [ ] **Step 1: Failing tests** (append to `approve-format.test.ts`):

```ts
import { pricingBasisFor } from '@/lib/invoice/approve-format'
import { lineReceived } from '@/lib/invoice/line-qty'
import { asChainItem, ratePerBase } from '@/lib/item-model'

describe('pricingBasisFor — the price basis follows the receiving basis', () => {
  it('received by weight → WEIGHT, even on a bridged COUNT item (eggplant)', () => {
    expect(pricingBasisFor({ via: 'billed-weight', ocrPerWeight: true, itemHasEachMeasure: true })).toBe('WEIGHT')
    expect(pricingBasisFor({ via: 'shipped-unit', ocrPerWeight: false, itemHasEachMeasure: true })).toBe('WEIGHT')
  })
  it('Brioche: a per-case line whose pack prints a weight, on a bridged COUNT item → CASE', () => {
    expect(pricingBasisFor({ via: 'printed-pack', ocrPerWeight: true, itemHasEachMeasure: true })).toBe('CASE')
  })
  it('an UNBRIDGED per-weight line keeps today’s UOM path', () => {
    expect(pricingBasisFor({ via: 'rate', ocrPerWeight: true, itemHasEachMeasure: false })).toBe('WEIGHT')
    expect(pricingBasisFor({ via: 'item-pack', ocrPerWeight: true, itemHasEachMeasure: false })).toBe('WEIGHT')
  })
  it('a plain case line → CASE', () => {
    expect(pricingBasisFor({ via: 'printed-pack', ocrPerWeight: false, itemHasEachMeasure: false })).toBe('CASE')
    expect(pricingBasisFor({ via: 'item-pack', ocrPerWeight: false, itemHasEachMeasure: true })).toBe('CASE')
  })
})

describe('money invariant: received quantity × $/base = line total (real North Arm Farms lines)', () => {
  const cases = [
    { name: 'eggplant 12 lb @ 3.49', em: { q: 0.4, u: 'lb' }, qty: 12, rate: 3.49, total: 41.88 },
    { name: 'kale 5 lb @ 5.99',      em: { q: 0.5, u: 'lb' }, qty: 5,  rate: 5.99, total: 29.95 },
    { name: 'lettuce 7.5 lb @ 5.25', em: { q: 250, u: 'g' },  qty: 7.5, rate: 5.25, total: 39.38 },
  ]
  for (const c of cases) it(c.name, () => {
    const item = asChainItem({ dimension: 'COUNT', baseUnit: 'each', packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 50 }, eachMeasureQty: c.em.q, eachMeasureUnit: c.em.u })
    const got = lineReceived({ rawQty: c.qty, rawUnit: 'lb', totalQty: c.qty, totalQtyUOM: 'lb', rate: c.rate, rateUOM: 'lb', rawUnitPrice: c.rate, rawLineTotal: c.total }, item)
    expect(['billed-weight', 'shipped-unit']).toContain(got.via)
    const ppb = ratePerBase(c.rate, 'lb', item)
    expect(Math.abs(got.base * ppb - c.total)).toBeLessThanOrEqual(Math.max(0.02, c.total * 0.02))
  })
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** in `approve-format.ts`:

```ts
import type { ReceivedVia } from '@/lib/invoice/line-qty'

/**
 * Price a line by WEIGHT or by CASE? It follows how the line was RECEIVED, which
 * line-first receiving has already decided with proof (the line's own money):
 *  • received by weight (`billed-weight` / `shipped-unit`) → WEIGHT, whatever the
 *    item is. Quantity × price then equals the line total by construction.
 *  • otherwise the old rule: a per-weight line → WEIGHT, EXCEPT on an item with an
 *    each-measure, where a printed weight is the SIZE of one each (Brioche
 *    "8 × 1100 g" per case), not the quantity sold → CASE.
 */
export function pricingBasisFor(a: { via: ReceivedVia; ocrPerWeight: boolean; itemHasEachMeasure: boolean }): 'WEIGHT' | 'CASE' {
  if (a.via === 'billed-weight' || a.via === 'shipped-unit') return 'WEIGHT'
  return a.ocrPerWeight && !a.itemHasEachMeasure ? 'WEIGHT' : 'CASE'
}
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Wire the route.** Read the whole block first. Then:

(a) Directly after `speaks` is built (it is `resolveLineFormat(itemAsChain, lineOffer)`), compute the receipt once:

```ts
        // How the line was RECEIVED decides how it is PRICED (pricingBasisFor).
        const received = lineReceived(lineQtyOf(scanItem), speaks)
```

(b) Replace `const isUomMode = derivePricingMode(scanItem as any) === 'per_weight' && !itemBridge` with:

```ts
        const isUomMode = pricingBasisFor({
          via: received.via,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ocrPerWeight: derivePricingMode(scanItem as any) === 'per_weight',
          itemHasEachMeasure: !!itemBridge,
        }) === 'WEIGHT'
```

and rewrite the comment block above it: the "bridged COUNT item is ALWAYS a count purchase" sentence becomes the Brioche-vs-eggplant distinction from the spec's Problem table.

(c) Rate-unit resolution (~:263-277): when the line was received by weight, the rate's unit is the unit the receipt was read in. Extend the fallback chain to `wv(scanItem.rateUOM) ? rateUOM : wv(scanItem.totalQtyUOM) ? totalQtyUOM : wv(scanItem.rawUnit) ? rawUnit : wv(item.baseUnit) ? baseUnit : 'kg'`. `newPurchasePrice` in UOM mode stays `scanItem.rate ?? newPrice`; add `?? rawUnitPrice` BEFORE `newPrice` when `received.via` is a weight path and `rate` is null (a `12 lb @ 3.49` line may carry the rate only in `rawUnitPrice`).

(d) `newPricePerBase` in the UOM branch: replace `newPurchasePrice / uomConv` + the manual density cross with ONE call — `ratePerBase(newPurchasePrice, resolvedRateUnit, itemForRate)` where `itemForRate` is `itemAsChain` with `densityGPerMl` overridden by the density the block resolves (learned → library → 1.0) **only for the MASS↔VOLUME case**, exactly as today. Keep persisting the resolved density on the item in the spine write. The reverse-bridge branch and the CASE branch are untouched.

(e) Guard (~:398): `!dimensionallyCostable(resolvedRateUnit, item.baseUnit)` → `!rateIsCostable(resolvedRateUnit, itemForRate)`. A bridged COUNT item now passes; an unbridged one is still skipped with the same message.

(f) `oldPpb` (~:438) hand-builds a `ChainItem` WITHOUT the bridges — once an item's own pricing can be a bridged RATE that would read 0. Replace with `pricePerBaseUnit(itemAsChain)`.

(g) The freeze (~:614) already uses `freezeFormat(speaks, newPricing)`; with a RATE `newPricing` on a bridged COUNT item `lineReceived`'s RATE branch resolves through `toBaseUnits` and the item's bridge → same quantity as `received.base`. Assert nothing else: do not recompute.

(h) Offer upsert: in UOM mode it already stores `{ RATE, rate: offerLastPrice, rateUnit: resolvedRateUnit }` and `offerLastPrice = newPurchasePrice`. Confirm by reading that the offer's `packChain` on this path is the supplier's existing chain (or the item's) — unchanged — and that `packSize/packUOM` provenance is what the brief for #133 set. No edit expected; say so in the report.

- [ ] **Step 6: Verify.** `npx tsc --noEmit` 0; eslint (the route has 17 pre-existing `no-explicit-any` — no NEW ones); `npm test`. In the report, walk these through the CODE with numbers: (1) eggplant `12 lb @ 3.49`, NAF non-primary → offer `RATE 3.49/lb`, no spine write, freeze 30 each; (2) Brioche `1 CS` pack `8×1100 g` $/case → CASE, identical to before; (3) bison `41.025` unit-less on a RATE item → identical; (4) a `$/kg` line on an UNBRIDGED `each` item → skipped, identical; (5) Cilantro FARM (NAF PRIMARY, line prints `8 each @ 4.99` AND `15.98/lb`, received via billed-weight) → now RATE 15.98/lb on the item: $/each = 15.98 × 0.3 = $4.79 vs $4.99 before — state the PriceAlert it would raise.

- [ ] **Step 7: Commit**

```bash
git add src/lib/invoice/approve-format.ts src/lib/__tests__/approve-format.test.ts "src/app/api/invoices/sessions/[id]/approve/route.ts"
git commit -m "feat(invoices): approve prices a line the way it was received — by weight when it was received by weight"
```

---

### Task 4: Show the real price and its derivation; keep the form from clobbering it

**Files:**
- Create: `src/lib/invoice/offer-copy.ts`; Test: `src/lib/__tests__/offer-copy.test.ts`
- Modify: `src/components/inventory/SupplierOffersSection.tsx` (~:98-100)
- Modify: `src/lib/invoice/calculations.ts` (`computeNormalisedPrices` ~:87-112); Test: the existing calculations test file if one exists, else `src/lib/__tests__/normalised-prices.test.ts`
- Modify: `src/app/api/inventory/[id]/route.ts` (PUT)

**Interfaces:**
- Produces:
  - `offerPriceLabel(o: { lastPrice: number; pricing: unknown }): string` → `"$3.49/lb"` for RATE, `"$70.30/case"` for PACK
  - `offerDerivation(o: { pricing: unknown }, item: { baseUnit: string | null; eachMeasureQty?: unknown; eachMeasureUnit?: string | null }, ppb: number): string | null`

- [ ] **Step 1: Failing tests**

```ts
import { offerPriceLabel, offerDerivation } from '@/lib/invoice/offer-copy'
const lettuce = { baseUnit: 'each', eachMeasureQty: '250', eachMeasureUnit: 'g' }
it('labels a RATE offer with its real unit and a PACK offer per case', () => {
  expect(offerPriceLabel({ lastPrice: 5.25, pricing: { mode: 'RATE', rate: 5.25, rateUnit: 'lb' } })).toBe('$5.25/lb')
  expect(offerPriceLabel({ lastPrice: 46.4, pricing: { mode: 'PACK', purchasePrice: 46.4 } })).toBe('$46.40/case')
})
it('explains a bridged price, and says why an unbridged one is unpriced', () => {
  expect(offerDerivation({ pricing: { mode: 'RATE', rate: 5.25, rateUnit: 'lb' } }, lettuce, 2.894)).toBe('$5.25/lb × 250 g each = $2.89/each')
  expect(offerDerivation({ pricing: { mode: 'RATE', rate: 5.25, rateUnit: 'lb' } }, { baseUnit: 'each', eachMeasureQty: null, eachMeasureUnit: null }, 0))
    .toBe('Unpriced — add a weight per each to this item')
  expect(offerDerivation({ pricing: { mode: 'PACK', purchasePrice: 46.4 } }, lettuce, 1.93)).toBe(null)
  expect(offerDerivation({ pricing: { mode: 'RATE', rate: 25, rateUnit: 'kg' } }, { baseUnit: 'g' }, 0.025)).toBe(null) // same dimension: nothing to explain
})
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `offer-copy.ts` (pure; use `formatCurrency` from `@/lib/invoice/formatters` if it is pure, else `'$' + n.toFixed(2)`; decide "bridged" with `dimensionOf(rateUnit) !== dimensionOf(item.baseUnit)`).

- [ ] **Step 4: `SupplierOffersSection.tsx`.** Replace the hard-coded `{formatCurrency(o.lastPrice)}/case` with `offerPriceLabel(o)`, and under it render `offerDerivation(o, item, o.pricePerBaseUnit)` when non-null (`text-[10.5px] text-ink-3`; the "Unpriced" sentence in `text-red-text`). The section receives `itemId` + `baseUnit` today — read how the drawer mounts it and pass the item's `eachMeasureQty/eachMeasureUnit` down as props (the drawer's item already has them via `PRICING_SELECT`; if its `Item` type lacks them, add the two optional fields). An offer with `pricePerBaseUnit === 0` must be excluded from the "cheapest" computation — it already filters `p > 0`; confirm.

- [ ] **Step 5: `computeNormalisedPrices`.** Today it returns `null` when the invoice price's SI base (`g` for `$/lb`) differs from the item's base (`each`) — so the review card shows NO price comparison for these lines. When they differ, convert with `ratePerBase(costPerUOM.value, costPerUOM.uom, asChainItem-like(item.matchedItem))` and proceed when the result is `> 0`; otherwise return `null` as today. Test: eggplant line (`$3.49/lb`, item `$2.93/each`, each-measure 0.4 lb) → `invoicePPB ≈ 1.396`, `pctDiff ≈ −52 %`; same line on an item with no each-measure → `null` (unchanged).

- [ ] **Step 6: The edit form must not clobber a bridged RATE.** Read `PUT` in `src/app/api/inventory/[id]/route.ts` and `formToChain` (`src/lib/item-model-form.ts`). The inventory form builds pricing from legacy-shaped fields and its rate-unit choices are limited to the item's dimension (`DIM_UNITS[dimension]` in `ItemChainEditor.tsx`), so it cannot express `$/lb` on an `each` item. Rule: if the STORED pricing is a RATE whose unit is another dimension than the item (`dimensionOf(rateUnit) !== item.dimension`) AND the incoming payload's price fields are unchanged from what the form was loaded with (compare the payload's purchasePrice / priceType / pack fields against values derived from the stored row — describe exactly which fields you compared in the report), keep the stored `pricing` instead of overwriting it with `formToChain`'s. If the user DID change the price in the form, their edit wins (they are re-pricing the item by case on purpose). Put the decision in a pure helper `keepBridgedRate(stored, incoming): boolean` with tests for both directions. If the route's structure makes this impossible without a larger refactor, STOP and report — do not guess.

- [ ] **Step 7: Verify + commit.** Focused tests, `tsc`, eslint, `npm test`. List in the report a 4-step manual click-through (item drawer → Eggplant → offers; review card of a NAF eggplant line).

```bash
git add src/lib/invoice/offer-copy.ts src/lib/invoice/calculations.ts src/lib/__tests__ src/components/inventory "src/app/api/inventory/[id]/route.ts"
git commit -m "feat(inventory): show a by-weight offer at its real price with the per-each derivation"
```

---

### Task 5: Repair the mis-stored offers

**Files:**
- Create: `src/lib/invoice/offer-repair.ts`; Test: `src/lib/__tests__/offer-repair.test.ts`
- Create: `scripts/repair-weight-priced-offers.ts`

**Interfaces:**
- Produces: `planOfferRepair(a: { offer: { pricing: unknown; lastPrice: number; isPrimary: boolean }; item: ChainItem; lastLine: LineQtyInput & { rate?: unknown; rateUOM?: string | null; totalQtyUOM?: string | null; rawUnit?: string | null; rawUnitPrice?: unknown } | null }): { action: 'rewrite'; pricing: Pricing; lastPrice: number } | { action: 'skip'; reason: string } | { action: 'human'; reason: string }`

Rules (all pure, all tested): no `lastLine` → skip; the line was NOT received by weight (`lineReceived(lastLine, item).via` not billed-weight / shipped-unit) → skip; the offer is ALREADY a RATE in a measure unit → skip; the item has no bridge for the rate unit (`!rateIsCostable`) → skip with reason; the offer `isPrimary` → **human** (rewriting it re-prices the item and every recipe using it — Cilantro FARM); otherwise rewrite to `{ mode: 'RATE', rate, rateUnit }` with `rate = Number(lastLine.rate) || Number(lastLine.rawUnitPrice)` and `rateUnit = rateUOM ?? totalQtyUOM ?? rawUnit`, `lastPrice = rate`. `packChain` and the provenance triple are never touched.

- [ ] **Step 1: Failing tests** — one per rule, using the real eggplant / kale / lettuce rows (offer `PACK $3.49` over `[{case,24}]`, item each-measure 0.4 lb, line `12 lb @ 3.49`, total 41.88 → `rewrite` to `RATE 3.49/lb`), Cilantro (primary → `human`), a Sysco case offer (→ skip: not received by weight), an item with no each-measure (→ skip).

- [ ] **Step 2–4:** RED → implement → GREEN.

- [ ] **Step 5: The script.** Same conventions as `scripts/backfill-received-qty-base.ts`: `parseMode`-style flag parsing that refuses anything but no-flags (dry run) or `--apply`; read every COUNT item that has an each-measure AND ≥ 1 offer, with each offer's most recent approved non-clone line from that supplier (`session.supplierId` / canonical name → `pickOffer` in reverse: match the line's session to the offer by the same three-field ref); run `planOfferRepair`; print a table (item, supplier, stored pricing → new pricing, stored $/each → new $/each via `offerPricePerBase`, the line it was derived from) plus separate `HUMAN` and `SKIPPED (reason)` sections; write `offer-repair-diff-<stamp>.json`; with `--apply` write `offer-repair-backup-<stamp>.json` (`{ id, prev: { pricing, lastPrice } }`) BEFORE the first update, then update only `rewrite` rows. **The implementer never runs it.**

- [ ] **Step 6: Verify + commit.** `tsc`, eslint, `npm test`.

```bash
git add src/lib/invoice/offer-repair.ts src/lib/__tests__/offer-repair.test.ts scripts/repair-weight-priced-offers.ts
git commit -m "chore(scripts): repair by-weight offers stored as a case price, dry-run first"
```

- [ ] **Step 7 (controller, read-only dry run):** expected `rewrite` = Eggplant, Kale, Lettuce Burger (North Arm Farms); `human` = Cilantro FARM; nothing else. Anything else in `rewrite` → stop and look. Hand the diff to the user; `--apply` only on their OK.

---

### Task 6: Docs and build

- [ ] **Step 1: CLAUDE.md.** In "The spine" section, after the `pricePerBaseUnit(item)` bullet, add:

```markdown
- A `RATE` may be quoted in ANOTHER dimension than the item when the ITEM carries the bridge: `$3.49/lb` on an item counted in `each` prices as `$/g × g per each` through `eachMeasure`; MASS↔VOLUME crosses through `densityGPerMl`; with no bridge it is **0 — unpriced**, never `rate ÷ conv` (`ratePerBase` / `rateIsCostable` in item-model.ts). The supplier's real price is what is stored; `$/each` is derived at read time, so it follows the each-measure when a human corrects it — never store the derived number. Offers are priced WITH their item: `offerPricePerBase(offer, item)`.
```

In the "Line-first receiving" paragraph, append: "**Pricing follows receiving** (`pricingBasisFor` in approve-format.ts): approve prices a line by weight exactly when `lineReceived` received it by weight, so quantity × price = line total; a per-case line whose pack merely prints a weight (Brioche `8 × 1100 g`) is received via `printed-pack` and stays on the CASE path."

- [ ] **Step 2: Spec.** `**Status:**` → implemented; append "As built" with any deviation and the dry-run results of Tasks 2 and 5.

- [ ] **Step 3: Build** in an isolated worktree with its own `node_modules`: `npm test`, `npx tsc --noEmit -p tsconfig.json`, `npm run build` → `✓ Compiled`; tree clean.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-21-weight-priced-count-items-design.md
git commit -m "docs: a rate in another dimension prices through the item's bridge; pricing follows receiving"
```

---

## Self-Review Notes

- **Spec coverage:** §1 formula + validator → Task 1 · §2 offers + `resolveLineFormat` → Task 2 · §3 approve + invariant → Task 3 · §4 drawer, form, review comparison → Task 4 · §5 repair → Task 5 · rollout step 1's "no number moves" proof → Task 2 Step 7 · docs → Task 6.
- **Found while planning, beyond the spec:** approve's `oldPpb` hand-builds a `ChainItem` without bridges (Task 3f); the review's `computeNormalisedPrices` returns `null` for these lines today, so there is NO price comparison to fix — it has to be added (Task 4 Step 5); the offers section hard-codes "/case" (Task 4 Step 4).
- **Type consistency:** `ratePerBase` / `rateIsCostable` take the same `Pick<ChainItem, …>`; `offerPricePerBase`'s `OfferItem` is the ROW shape (`eachMeasureQty` …) and converts through `asChainItem`; `pricingBasisFor` consumes `ReceivedVia` from `line-qty.ts`.
- **Deliberately not decided here:** Cilantro FARM (primary supplier, line prints both $/each and $/lb) is routed to a human by the repair script AND will re-price to $4.79/each on its next approve — Task 3's report must state that so the user sees it before merge.
