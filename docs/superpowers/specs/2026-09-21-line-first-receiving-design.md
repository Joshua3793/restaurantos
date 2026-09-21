# Line-first receiving — a weight on the invoice is the weight received

**Date:** 2026-09-21
**Status:** design, not implemented
**Follows:** `2026-09-20-item-consolidation-design.md` (spec 1). Weighted-average costing (spec 2) should come after this, because its weights are received quantities.

## Problem

Receiving decides "by pack or by weight?" from the **item** (or, since spec 1, the supplier's offer) — never from the **invoice line**. `lineReceivedBaseUnits` (`src/lib/invoice/line-qty.ts`) reads the billed weight only when the resolved pricing mode is `RATE`; otherwise it multiplies the shipped quantity by a pack.

An item's mode is set by whichever invoice created it. Heirloom Tomato was created from a Sysco case, so it is `PACK`. When North Arm Farms sells the same tomato as `8 lb @ $6.49`, the line says `lb` on its face, the scanner tagged it `per_weight` — and receiving credits 8 × a 10 lb case.

Spec 1 fixed the lines whose supplier **offer** happened to be stored as `RATE`. It cannot fix:

- an offer stored as `PACK` (zucchini, Independent Grocer: billed 3.02 kg → credited 250 g);
- an item counted in `each` (eggplant: `12 lb` → credited **288 each**; the item's each-measure says 30).

The pack chain is meaningless for a purchase made by weight. A weight printed on the invoice is what was received.

## Evidence (live DB, read-only, 2026-09-20/21)

Scripts and output: `docs/audits/2026-09-20-line-first-receiving/`.

**1. What a naive "billed weight always wins" rule would change** (`compare-line-first.ts`, against the 1,881 frozen receipts): 34 lines.

| Group | Lines | Example | Naive rule is… |
|---|---|---|---|
| Shipped quantity's own unit is a weight | 7 | Eggplant `12 lb` 288 → 30 each; Kale `5 lb` 120 → 10 each | right |
| Cases + a billed weight, priced by weight | 20 | Sausage `2 CS`, billed 14.6 kg: 14,000 → 14,600 g; zucchini `1 ea`, billed 3.02 kg: 250 → 3,020 g | right |
| Cases + a "billed weight", priced by case | 5 | **Butter `2 CS` of 25×454 g, "2.86 kg": 22,700 → 2,860 g**; Halloumi, Cheese Curd, Goats Cheese, Brioche | **wrong** |

So the rule cannot be "weight wins". On those Sysco lines the billed-weight column is not the quantity that was priced.

**2. What separates the second group from the third** (`money-check.ts`, all 1,773 countable approved lines): whether **price × billed weight reproduces the line total**.

| Container qty + a billed weight | Lines | price × billed = total | price × cases = total |
|---|---|---|---|
| scanned `per_weight` | 178 | 178 | — |
| scanned `per_case` | 7 | 2 (also reconcile by case) | 7 |
| no mode recorded (older scans) | 25 | 25 | — |

Zero disagreements between the scanner's pricing mode and the arithmetic. The arithmetic is the better test: it also covers the 25 lines with no recorded mode, it does not depend on the scanner's judgment, and it is checkable by a person reading the invoice.

## The rule

`lineReceivedBaseUnits` gains two steps **ahead of** the existing logic. The frozen value still wins over everything.

0. `receivedQtyBase > 0` → that value (unchanged).
1. **Shipped unit is a measure.** `rawQty > 0` and `rawUnit` is a weight/volume unit in `UNIT_FACTORS` (not a count unit, not a container word) → received = `rawQty rawUnit`, converted to the item's base unit. (158 approved lines have this shape; 151 already receive exactly this through the RATE branch, the 7 that do not are the eggplant/kale/lettuce lines above, and none of the 158 carries a printed pack that disagrees.)
2. **Billed weight, proven by the money.** `totalQty > 0`, `totalQtyUOM` is a weight/volume unit, and the line is **priced by that weight**:
   - `price × totalQty` equals `rawLineTotal` within `max($0.02, 2 %)`, where `price` is `rate` when present, else `rawUnitPrice`; **and**
   - `rawUnitPrice × rawQty` does **not** also equal the total within the same tolerance (if both reconcile the line is ambiguous → step 2 does not apply).
   - When `rateUOM` is present it must be the same dimension as `totalQtyUOM`.
   → received = `totalQty totalQtyUOM`, converted to the item's base unit.
3. Otherwise → today's rule, unchanged (RATE branch for unit-less billed quantities such as bison `41.025`, then printed pack, then the resolved chain).

**Conversion** uses the existing `toBaseUnits`: same dimension → plain conversion; cross dimension → only through a bridge the **item** carries (each-measure, density). If step 1 or 2 applies but no bridge spans the gap, the step yields nothing and the rule falls through to step 3 — it never credits a number wearing the wrong unit. That case is surfaced (below), not hidden.

Steps 1–2 ignore the item's and the offer's pricing mode and every pack chain. `resolveLineFormat` still matters for step 3.

### What this deliberately does not do

- **No tolerance band against the printed pack.** The 25 % idea from the first analysis is dropped: the sausage line with a mis-scanned `1×1 kg` pack (billed 28.7 kg, ratio 7×) is correct by the money and would have been rejected by a band.
- **No change to pricing.** Approve's price derivation already keys on the line (`derivePricingMode`). Only received quantity changes.
- **No change to `resolveLineFormat`, the pack guard, the merge code, or the matcher.**

## Provenance: say how a quantity was received

Today nobody can see *why* a line credited what it did. Add, beside `lineReceivedBaseUnits`:

`lineReceived(line, chainItem): { base: number; via: ReceivedVia; needsBridge: boolean }`

`ReceivedVia = 'frozen' | 'shipped-unit' | 'billed-weight' | 'rate' | 'printed-pack' | 'item-pack'`

`lineReceivedBaseUnits` becomes `lineReceived(...).base`, so there is still exactly one rule. `needsBridge` is true when step 1 or 2 matched but the item has no bridge to convert through.

- **Approved-invoice report / review card:** show the provenance next to the stock effect — "Received 3.02 kg (billed weight)", "Received 30 each (12 lb ÷ 0.4 lb each)". For a bridged conversion always show the arithmetic: the result is only as good as the item's each-measure (Lettuce Burger `5 lb` → 0.5 each suggests its each-measure is wrong — a human needs to see that).
- **Review, before approve:** a line with `needsBridge` gets an info issue — "Billed by weight, but <item> is counted in each with no weight per each. Add an each-measure to receive this correctly." It does not block approval (today's behaviour is no worse), it names the fix.

`LineQtyInput` gains `rawUnitPrice`, `rate`, `rawLineTotal` (all already on `InvoiceScanItem` and already in the session GET payload). Every caller that builds a `LineQtyInput` by hand must pass them: `buildPurchaseMap` (`count-expected.ts`), the approve route's `lineQtyOf`, the backfill script, the client callers via `ScanItem`. A caller that omits them simply never takes step 2 — safe, but wrong — so the plan must grep every construction site.

## Frozen receipts and history

`receivedQtyBase` is frozen at approve, so the new rule affects **new approvals only** until history is deliberately re-frozen.

- `scripts/backfill-received-qty-base.ts` gains `--refreeze`: recompute every approved line under the current rule *ignoring* the stored value, write the dry-run diff (old frozen → new, with `via`), and with `--apply` back up and update only the lines that change.
- Expected diff from the evidence: ~27 lines (7 shipped-unit + 20 billed-weight); the 5 per-case Sysco lines must **not** appear. If they do, the rule is wrong — stop.
- The user reviews the diff before `--apply`, as in spec 1. Bridged lines (eggplant, kale, lettuce burger) are listed separately with the each-measure used, because the user may want to fix the each-measure first.
- **RC clone rows are never run through the rule.** At approve a clone's frozen value is the parent's × the clone's share (spec 1), and `--refreeze` does the same: recompute the PARENT (the row whose `splitToSessionId` points at the clone's session, same `rawDescription` + `sortOrder`), then set each clone to `parent × (clone.rawLineTotal / parent.rawLineTotal)`. Running the rule on a clone directly is unsafe: a parent with a null `rawQty` clones to `rawQty = share`, which can make "price × cases" reconcile by accident and flip the clone to step 3 while its parent took step 2.

## Testing

Pure vitest in `src/lib/__tests__/line-qty.test.ts`, fixtures taken from the real lines:

- Step 1: eggplant `12 lb` on a COUNT item with an each-measure → via `shipped-unit`, bridged; the same line on an item with **no** each-measure → falls through, `needsBridge: true`, value = today's.
- Step 2: sausage `2 CS`, billed 14.6 kg, rate reconciles → 14,600 g via `billed-weight`; the mis-scanned `1×1 kg` pack line → 28,700 g; zucchini `1 ea` + 3.02 kg on a **PACK** offer → 3,020 g; a no-mode legacy line that reconciles → billed weight.
- Step 2 must refuse: Butter `2 CS` 25×454 g "2.86 kg" (reconciles by case only) → 22,700 g via `printed-pack`; a line where both reconcile → step 3; `rateUOM` in another dimension than `totalQtyUOM` → step 3; missing price or total → step 3.
- Regression locks: every existing test in the file passes unchanged; a RATE item with a unit-less billed quantity still resolves through the priced unit; a frozen value still wins.
- `lineReceived(...).base === lineReceivedBaseUnits(...)` for every fixture.

## Rollout

1. `lineReceived` + the two steps + tests (pure; no behaviour change for lines that match neither step).
2. Thread `rawUnitPrice` / `rate` / `rawLineTotal` through every `LineQtyInput` construction site; approve now freezes under the new rule.
3. Provenance in the approved report and review card; the `needsBridge` info issue.
4. `--refreeze` dry run → user reviews → `--apply`.

Each step ships alone. No migration.

## Out of scope

- Fixing wrong each-measures (Lettuce Burger) — data, surfaced by step 3's arithmetic display.
- The zucchini / Independent Grocer **offer** being stored as `PACK $19.96` over a `lb › 250` chain — a data oddity from an older approve; the received quantity no longer depends on it.
- Cross-unit merges; weighted-average costing (spec 2).
