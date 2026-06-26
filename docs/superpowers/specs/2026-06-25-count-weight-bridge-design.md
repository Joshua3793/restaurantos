# Count↔Weight Unit Bridge — Design

**Date:** 2026-06-25
**Status:** Approved (design); pending implementation plan

## Problem

The same physical product is sold by different suppliers in different *dimensions*, which the
pack-chain model cannot represent on a single item. Concrete case:

- **Brioche Unsliced** from **Sysco**: `8 × 1100 g` → parsed as **MASS**
- **Brioche Unsliced** from **Snowcap**: `1 × 8 each` → parsed as **COUNT**

An `InventoryItem` has one `dimension` (MASS | VOLUME | COUNT), derived from its base unit, and
**every** supplier offer must resolve to it. The invoice conflict check
([predicates.ts:55 `hasDimensionConflict`](../../../src/lib/invoice/predicates.ts)) does a hard
`offer.dimension !== item.dimension`, and MASS↔COUNT has no bridge
([uom.ts `dimensionallyCostable`](../../../src/lib/uom.ts) only tolerates weight↔volume). So
whichever dimension the item is *not* in conflicts on **every** scan. The learned format rule
([InvoiceMatchRule](../../../prisma/schema.prisma)) caches the pack numbers but does **not** suppress
the dimension check, so approving once does not stop the conflict recurring. The only "change the
item" resolver today is the destructive `AdoptFormatModal`, which rewrites `dimension` + `packChain`,
zeroes on-hand stock, and re-costs every recipe using the item.

## Decisions (from brainstorming)

1. **These are not two dimensions.** A brioche loaf is one physical thing (COUNT / loaves). Sysco's
   `1100 g` is the *per-loaf weight*, not a different costing dimension. Canonical model =
   **COUNT base** (1 each = 1 loaf) with a per-each weight bridge.
2. **Canonical weight lives on the item** (single source of truth). Suppliers do not each carry their
   own bridge weight.
3. **Recipes sometimes reference these items by weight** (e.g. `200 g brioche`), so the bridge must
   work in **recipe costing**, not only at invoice ingest.
4. **Prefer the explicit count.** When an invoice line already states a clean count (`8 × 1100 g` →
   `packQty = 8`), use the count directly and never divide. Only divide a **bare total weight** by the
   bridge, and round those to whole units.
5. **Representation = dedicated nullable field on `InventoryItem`** (Approach A), not embedded in the
   untyped `packChain` JSON (read in ~46 places) and not per-supplier.

## Scope

In scope: a per-each measure on COUNT items, a bridged converter, and making the four bridge-aware
sites (recipe costing, invoice conflict check, invoice normalization, approve guard) consult it; UI to
set the bridge; a non-destructive conflict resolver; migration + targeted backfill.

Out of scope: per-supplier bridge weights; fractional-count stock for discrete goods; any change to
items that do not set a bridge (they behave exactly as today).

## 1. Data model & core converter

**Schema — two nullable columns on `InventoryItem`:**

- `eachMeasureQty Decimal?` — measure of one base count unit, e.g. `1100`
- `eachMeasureUnit String?` — its unit, canonicalized to base (`g` or `ml`)

Only meaningful when `dimension = COUNT`. Both null = no bridge (today's behavior, untouched).
Migration applied via `$executeRawUnsafe` over the pooler (direct DB host is unreachable; never run a
full-schema `migrate diff`). Expand-only and nullable, so the columns can be deployed before any code
reads them.

**Bridge type** (`src/lib/item-model.ts`):

```ts
type EachMeasure = { qty: number; unit: string }   // 1 each = qty·unit
```

A helper reads it off an item: `eachMeasureOf(item): EachMeasure | null` (null when either column is
null or `dimension !== COUNT`).

**One new converter** (`src/lib/uom.ts` or `item-model.ts`):

```ts
convertQtyBridged(qty: number, fromUnit: string, toUnit: string, bridge?: EachMeasure | null): number
```

- Same dimension → delegates to `convertQty` (no behavior change).
- Cross count↔(mass|volume) **with** a bridge:
  - measured→count: `convertQty(qty, fromUnit, bridge.unit) / bridge.qty`
  - count→measured: `convertQty(qty × bridge.qty, bridge.unit, toUnit)`
- Cross-dimension **without** a bridge → identical to today (`convertQty`'s current
  throw/passthrough); callers keep their current handling.

Only the four bridge-aware sites switch to `convertQtyBridged`. Every other `convertQty` caller is
unchanged.

## 2. Recipe costing (count↔weight)

`computeRecipeCost` in [recipeCosts.ts](../../../src/lib/recipeCosts.ts) currently maps each
ingredient:

```
lineCost = convertQty(qtyBase, unit, inventoryItem.baseUnit) × pricePerBaseUnit
```

Change to `convertQtyBridged(qtyBase, unit, baseUnit, eachMeasureOf(inventoryItem))`. Worked example:
`200 g brioche`, item base `each`, spine `$/each` → `200 / 1100 = 0.1818 each × $/each`.

Guards:

- **No bridge present** but recipe crosses count↔weight → keep today's behavior (passthrough/zero +
  existing ingredient flag). Nothing silently changes for items not yet set up.
- Bridge is read from the already-fetched item. Confirm `eachMeasureQty` / `eachMeasureUnit` are added
  to the existing `select` in `fetchRecipeWithCost` (and any other costing fetch) — no extra query.

## 3. Invoice ingest, conflict check & approve

**(a) Conflict check** — [predicates.ts `hasDimensionConflict`](../../../src/lib/invoice/predicates.ts):
today `offer.dimension !== itemDim` → conflict. New: if `itemDim === COUNT`, the item has a bridge,
and `offer.dimension` equals the bridge unit's dimension (e.g. MASS), it is **bridgeable, not a
conflict**.

**(b) Normalization ("prefer the explicit count")** at the matcher/offer boundary
([offer.ts `buildOffer`](../../../src/lib/invoice/offer.ts) /
[invoice-matcher.ts](../../../src/lib/invoice-matcher.ts)). When a weight-format line lands on a
bridged COUNT item:

- Line states a clean count (`8 × 1100 g` → `packQty = 8`) → **use 8 each directly; never divide.**
  The `1100 g` is recorded as provenance and confirms the bridge.
- Line is a bare total weight (`8.8 kg`, no count) → `convertQtyBridged(8800, 'g', 'each', bridge) =
  8 each`, rounded to whole.
- Resulting offer resolves to **$/each**: `lineTotal / count`. The supplier offer keeps its native
  `8 × 1100 g` format (`packQty/packSize/packUOM` + `packChain`) for provenance and per-supplier
  memory, so the next Sysco scan auto-applies.

**(c) Approve guard** — [approve route](../../../src/app/api/invoices/sessions/[id]/approve/route.ts)
around the `dimensionallyCostable(resolvedRateUnit, item.baseUnit)` check: make it bridge-aware so a
MASS rate against a COUNT base **with a bridge** is costable (converted to `$/each` before the spine
write) instead of being skipped.

Net effect: set Brioche's bridge once (1 each = 1100 g, COUNT base); Sysco weight invoices and Snowcap
count invoices both approve, both write `$/each` to the spine, and the conflict never re-appears.

## 4. UI

**Inventory item form / drawer** (the shared `ItemChainEditor` plus the item drawer): when
`dimension = COUNT`, show an optional **"Weight/volume per unit"** field → numeric (`1100`) + unit
dropdown (`g` / `ml`). Empty = no bridge. Hidden for MASS/VOLUME items.

**Conflict resolver** — [issues.tsx](../../../src/components/invoices/v2/issues.tsx): for a weight
line on a COUNT item, add a **non-destructive primary action**:

> "Set 1 each = 1100 g and receive as 8 each"

One click writes the bridge to the item (if not already set) and normalizes the line — no dimension
flip, no stock reset, no recipe cascade. The destructive `AdoptFormatModal` remains as a fallback for
genuine "modeled in the wrong dimension" cases.

## 5. Migration & backfill

- **Schema:** add the two nullable columns via `$executeRawUnsafe` over the pooler. Expand-only,
  nullable, deployable before any reader.
- **Backfill:** one-off `scripts/assign-each-measure.ts`. It lists candidate items — those with a
  COUNT chain **and** weight-format offers or match-rules (a current/latent dimension mismatch) — for
  the user to confirm per-each weights rather than guessing. Only confirmed items get a bridge.
- **No destructive change:** existing items stay null-bridge and behave exactly as today.

## 6. Testing & verification

No test suite; verification is `npm run build` (type-check) + targeted manual checks via dev preview.

Worked examples (baked into the implementation as assertions/comments):
`8 × 1100 g → 8 each`; bare `8.8 kg → 8 each`; recipe `200 g → 0.1818 each × $/each`;
null-bridge item → identical cost pre/post.

Live flow:

1. Set Brioche's bridge (1 each = 1100 g, COUNT base).
2. Scan a Sysco weight invoice → no conflict, receives as 8 each, spine = `$/each`.
3. Scan a Snowcap count invoice → still clean.
4. Open a weight-based recipe using Brioche → cost non-zero and correct.
5. Equivalence: a null-bridge item produces identical costs pre/post (no regression across the ~46
   spine readers).

## Touch sites (for the plan)

- `prisma/schema.prisma` + raw migration — two columns
- `src/lib/item-model.ts` — `EachMeasure` type, `eachMeasureOf`
- `src/lib/uom.ts` — `convertQtyBridged`; bridge-aware `dimensionallyCostable`
- `src/lib/recipeCosts.ts` — bridged line cost + `select` additions
- `src/lib/invoice/predicates.ts` — bridge-aware `hasDimensionConflict`
- `src/lib/invoice/offer.ts` / `src/lib/invoice-matcher.ts` — weight→count normalization
- `src/app/api/invoices/sessions/[id]/approve/route.ts` — bridge-aware cost guard + `$/each` write
- `src/components/.../ItemChainEditor` + item drawer — bridge input
- `src/components/invoices/v2/issues.tsx` — non-destructive resolver action; new/extended API call
- `scripts/assign-each-measure.ts` — backfill
