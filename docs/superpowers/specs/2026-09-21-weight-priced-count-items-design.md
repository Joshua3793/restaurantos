# Pricing weight-billed lines on count items

**Date:** 2026-09-21
**Status:** design, not implemented
**Follows:** `2026-09-21-line-first-receiving-design.md` (quantity). This spec is the price half. Weighted-average costing (spec 2 of the item-consolidation series) comes after it.

## Problem

Line-first receiving made the QUANTITY right for a line sold by weight on an item counted in `each`: North Arm Farms eggplant, `12 lb @ $3.49/lb`, now receives 30 each through the item's each-measure (0.4 lb per eggplant).

The PRICE is still wrong. The approve route has a deliberate rule (`approve/route.ts` ~:212-222):

> *"A bridged COUNT item is ALWAYS a count purchase — the printed weight (e.g. Brioche '8×1100g') is the per-each size, not a $/weight billing rate."*

so `isUomMode = per_weight && !itemBridge` is forced false, and the line's `rawUnitPrice` — which is the **$/lb rate** — is priced as if it were a **case price** over the item's chain: `$3.49 ÷ 24 each = $0.145/each`. The true price is `$3.49/lb × 0.4 lb = $1.396/each`. Before line-first the two errors cancelled in money (288 each × $0.145 ≈ $41.88); now the quantity is right and the price is ~10× low.

That rule is correct for Brioche and wrong for eggplant. They are different lines:

| | Brioche | Eggplant |
|---|---|---|
| Line | `1 CS`, pack `8 × 1100 g`, $/case | `12 lb @ $3.49/lb`, total $41.88 |
| What the weight is | the size of one each | the quantity sold |
| Received via (line-first) | `printed-pack` | `billed-weight` / `shipped-unit` |
| Right price basis | $/case ÷ each per case | $/lb × weight of one each |

Line-first receiving already tells them apart, with proof. Pricing does not ask.

## Evidence (live DB, read-only, 2026-09-21)

Scripts: `docs/audits/2026-09-21-weight-priced-count-items/`.

**`wb-price.ts` — COUNT items that receive weight-billed lines: 7.**

| Item | Each-measure | Supplier (role) | Stored offer | Stored $/each | True $/each |
|---|---|---|---|---|---|
| Eggplant | 0.4 lb | North Arm Farms (non-primary) | `PACK $3.49` over 24/case | $0.145 | $1.40 (and $2.00 on the $4.99/lb invoice) |
| Kale | 0.5 lb | North Arm Farms (non-primary) | `PACK $5.99` over 24/case | $0.250 | $3.00 |
| Lettuce Burger | 250 g | North Arm Farms (non-primary) | `PACK $5.25` over 24/case | $0.219 | $2.89 |
| Cilantro FARM | 0.3 lb | North Arm Farms (**primary**) | `PACK $4.99` over 1 each | $4.99 | $4.79 (line also prints $4.99/each — see below) |
| Potatoes Kennebec O/S, TRSM Salami, Fennel O/S | **none** | created from the line | `RATE $x / each`, chain `[{lb: 1}]` | — | not costable: these are weight goods mis-created as `each` (out of scope, below) |

In every bridged case the wrong supplier is **non-primary**, so the item's costing spine — and therefore every recipe — is untouched today. What is wrong: the supplier comparison ("cheapest other offer", supplier-switch note), the `IMPLAUSIBLE_PRICE_RATIO` guard (it fires on these offers — a 20× gap — and discards their pricing), any future promotion of that supplier to primary (the item would re-cost at $0.15), and spec 2's inputs.

**`wb-cross.ts` — blast radius of touching the price formula: zero.** Of 487 active items, **0 items and 0 offers** carry a `RATE` whose unit is another dimension than the item. 10 COUNT items have an each-measure.

**Today's session is itself evidence.** The user corrected Lettuce Burger's each-measure twice (10 lb → 100 g → 250 g). A price stored as a derived `$/each` would have been stale after each correction. A price stored as the supplier's real `$5.25/lb` re-derives correctly the moment the each-measure changes.

## Decisions

1. **The price basis follows the receiving basis.** Approve prices a line by weight exactly when line-first receiving received it by weight (`via` is `billed-weight` or `shipped-unit`), and by case otherwise. One decision, already proven by the line's money, used twice — so `received quantity × price per base = line total` holds by construction. The "bridged COUNT item is always a count purchase" override is removed; the Brioche shape keeps its behaviour because it is received via `printed-pack`.
2. **Store the supplier's real price, derive `$/each` at read time.** The offer (and the item, when that supplier is primary) stores `{ mode: 'RATE', rate: 3.49, rateUnit: 'lb' }`. `pricePerBaseUnit` becomes bridge-aware. Rejected: storing a derived `$/each` — it goes stale when the each-measure is corrected, it destroys the supplier's price history (`$3.49/lb → $4.99/lb` becomes two unrelated per-each numbers), and it is exactly the "parallel price" the spine forbids.
3. **An unbridgeable rate is unpriced (0), never garbage.** Today a cross-dimension `RATE` returns `rate ÷ conv(rateUnit)` — a $/g number labelled $/each. With no bridge it must return 0, which every reader already treats as "no price".

## Design

### 1. `pricePerBaseUnit` is bridge-aware (`src/lib/item-model.ts`)

`RATE` branch, in order:

- `dimensionOf(rateUnit) === item.dimension` → `rate ÷ conv(rateUnit)` — **unchanged**.
- COUNT item, measured `rateUnit`, and `item.eachMeasure` in that same dimension → `rate ÷ conv(rateUnit) × base(eachMeasure)` — $/g × g per each. (`$3.49/lb ÷ 453.592 × 181.4368 = $1.396`.)
- MASS ↔ VOLUME and `item.densityGPerMl > 0` → cross through density (`densityCrossedPpb` in `src/lib/invoice/density-bridge.ts`, today called only by the approve route — call it from here so the stored spine and the alert basis finally agree — closes the "RATE + density" follow-up from the line-first review).
- otherwise → **0**.

`ChainItem` already carries `eachMeasure` and `densityGPerMl`, and `asChainItem` fills them, so every reader that does `pricePerBaseUnit(asChainItem(row))` gets this for free. No reader changes.

The measured-item ↔ count-rate direction (`$2.00/each` on a gram item with an each-measure) is symmetric and included: `rate ÷ base(eachMeasure)`.

`validateChainItem`: the rule "RATE.rateUnit must share the item dimension" relaxes to "…or a bridge on the item spans the two dimensions" (reuse `dimensionallyCostable(unitA, unitB, bridge)` from `uom.ts`, extended with density).

### 2. Offers need their item (`src/lib/supplier-offers.ts`)

`offerPricePerBase(offer)` reads only the offer's chain + pricing and has no bridges. New signature: `offerPricePerBase(offer, item)` where `item` supplies `dimension`, `baseUnit`, `eachMeasure`, `densityGPerMl`. Six call sites in four files: the session GET route (`api/invoices/sessions/[id]/route.ts`), `api/reports/analytics/route.ts`, `getSupplierOffers` in `supplier-offers.ts`, and three in `invoice/resolution.ts` (`cheapestOtherOffer` ×2 and the big-price-change check). Each already has the item in hand or one select away. The parameter is REQUIRED so a caller cannot silently price an offer without its bridge.

`resolveLineFormat` (`line-format.ts`): `rateOk` accepts a RATE whose unit is bridged to the item, by the same predicate. The implausible-price guard then compares real numbers and stops discarding these offers.

### 3. Approve prices by how the line was received (`approve/route.ts`)

- Compute `received = lineReceived(lineQtyOf(scanItem), speaks)` once, **before** the pricing branch (it is computed later today for the freeze; hoist it).
- `pricedByWeight = received.via === 'billed-weight' || received.via === 'shipped-unit'`. For a RATE item (`via: 'rate'`) the existing UOM path is already right and unchanged.
- `isUomMode = pricedByWeight || (derivePricingMode === 'per_weight' && !itemBridge)` — i.e. the old condition still covers unbridged per-weight lines, and a bridged COUNT item joins the UOM path only when the line was genuinely received by weight.
- In UOM mode on a bridged COUNT item: `rate` = `scanItem.rate ?? rawUnitPrice`, `resolvedRateUnit` = `rateUOM ?? totalQtyUOM ?? rawUnit`; `newPricePerBase` via the bridge-aware formula (one function, §1); `newPricing = { mode: 'RATE', rate, rateUnit }`; the offer upsert stores that RATE with the supplier's existing chain untouched; `offerLastPrice` = the rate.
- The dimension-conflict guard (`dimensionallyCostable(resolvedRateUnit, item.baseUnit)`) passes the item's bridge.
- Primary supplier: the spine write stores the RATE on the item (chain untouched, as today). Every cost reader derives through the bridge.
- `freezeFormat(speaks, newPricing)` keeps working: a RATE format on a bridged COUNT item resolves through `toBaseUnits` with the bridge.
- A line received by weight whose item has NO bridge is already blocked in review ("Needs a unit bridge") and skipped by approve's guard — unchanged.

**Invariant, asserted in a test:** for a weight-received line, `received.base × newPricePerBase ≈ rawLineTotal` (±2 %).

### 4. Where a person sees it

- **Item drawer / supplier offers:** a bridged RATE offer shows its real price and the derivation: `$5.25 / lb  →  $2.89 / each (250 g each)`. When the each-measure is missing the offer shows "unpriced — add a weight per each". This is the only place the dependency on the each-measure is visible, and it needs to be: the cost per each is now only as good as that number.
- **Inventory item form:** a RATE in another dimension is accepted when the item has the bridge (today the form's validation would refuse to save such an item). Read `ItemChainEditor` / `formToChain` in the plan — if the form cannot express it, the item stays editable for everything else and the pricing block renders read-only with the derivation.
- **Review card / price-change issue:** compares per-base through the same function, so a `$3.49 → $4.99 /lb` move reads as +43 %, not as nonsense.

### 5. Repair the stored offers

`scripts/repair-weight-priced-offers.ts` — dry run by default, `--apply` with a JSON backup first, explicit flags only (same conventions as `backfill-received-qty-base.ts`). For every offer on a bridged COUNT item whose **most recent approved line from that supplier was received by weight** (recompute `lineReceived` on it; `via` ∈ billed-weight / shipped-unit): rewrite `pricing` to `{ RATE, rate, rateUnit }` from that line and `lastPrice` to the rate; leave `packChain` and the provenance triple alone. Never touches a primary offer's item spine except through `syncPrimaryOfferToItem` when the offer IS primary (Cilantro FARM) — and that one is listed separately for a human, because its line prints both `$4.99/each` and `$15.98/lb`. Expected today: 3 offers (eggplant, kale, lettuce burger) + Cilantro for review.

## Testing

Pure vitest:

- `item-model.test.ts`: the four RATE branches (same-dimension unchanged; COUNT via each-measure in g and in lb; MASS↔VOLUME via density both directions; no bridge → 0); `validateChainItem` accepts a bridged cross-dimension RATE and still rejects an unbridged one; a regression lock that every existing fixture's ppb is unchanged.
- `supplier-offers`: `offerPricePerBase(offer, item)` with and without the bridge.
- `line-format.test.ts`: a bridged RATE offer is adopted and is no longer "implausible".
- A new pure helper for approve's decision (`approve-format.ts`: `pricingBasisFor(received, ocrMode, hasBridge)`), tested for: eggplant (weight), brioche (case), unbridged per-weight (UOM as today), RATE item (unchanged), and the **money invariant** above on the real eggplant / kale / lettuce lines.
- The each-measure dependency: changing `eachMeasure` from 100 g to 250 g changes the derived $/each and nothing stored.

## Rollout

1. §1 + §2 (pure; with zero cross-dimension RATE rows in the DB this changes no existing number — assert that with a read-only before/after dump of every item's and offer's ppb, reviewed before merge).
2. §3 approve + the pure basis helper.
3. §4 UI.
4. §5 repair script → dry run → user reviews → apply.

No migration.

## Out of scope

- **Weight goods mis-created as `each`** (Potatoes Kennebec O/S, TRSM Sour Tuscan Salami, Fennel O/S): created from a per-lb line as COUNT items with chain `[{lb: 1}]` and `RATE $/each`, where "each" secretly means a pound. They need to become MASS items (and Kennebec is a merge candidate — a cross-unit merge, also out of scope). The create-new path choosing the wrong dimension for a weight-billed line is its own small spec.
- Weighted-average costing (spec 2). Note it is independent of how an offer's price is stored: its inputs are `rawLineTotal` and `receivedQtyBase`, both now trustworthy.
- The other line-first follow-ups (failed-save queue, per-case toggle, mis-scan guard, provenance on the approved report, unpriced-line warning).
