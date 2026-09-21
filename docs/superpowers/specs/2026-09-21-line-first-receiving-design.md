# Line-first receiving — a weight on the invoice is the weight received

**Date:** 2026-09-21
**Status:** implemented 2026-09-21 on `feat/line-first-receiving` — see "As built" at the end
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

## As built (2026-09-21) — where the implementation deliberately differs

- **The proof is the printed rate, not "price × cases must fail".** The first refreeze dry run moved ZERO lines through the billed-weight step. Cause: the scanner reads `rate` off the page but DERIVES `unitPrice = lineTotal ÷ qtyShipped`, so "unitPrice × cases = total" held on 176 of 178 per-weight lines and the ambiguity clause above refused them all. Decided by the user: a printed `rate × billed weight = line total` is proof on its own; the ambiguity clause applies only when there is NO rate (then `rawUnitPrice` stands in as the price). Consequence: **Goats Cheese and Cheese Curd** — assumed wrong in the evidence table above — carry a $/kg rate that reproduces their total exactly and now receive their billed catch weight (2.64 kg, 6.59 kg). Butter, Halloumi and Brioche have no reconciling rate and stay on their pack; the script's guard names exactly those three moving TO a billed weight.
- **A rate unit that is not a weight/volume can never prove a weight** ($/case, unknown token) — refused before multiplying. A rate in another unit of the same dimension ($/kg, billed in lb) is converted first.
- **Step order:** frozen → billed weight (proven) → the existing RATE branch, unchanged (billed before shipped — catch weight) → shipped unit is a measure → printed pack → chain. No RATE item changed behaviour.
- **No new review issue.** `classifyDimensionRelationship` already raises the blocking "Needs a unit bridge" for a weight line on a COUNT item with no each-measure (pinned in `invoice-bridge.test.ts`). `needsBridge` is reported in the approved report and the refreeze diff.
- **Callers.** The client's hand-built matched item dropped the item's bridges at three sites → one `matchedLikeOf`. A hand-linked line staged a PARTIAL item (no bridges, no supplier offers) → `linkExistingItem` now awaits the PATCH, drops the staged copy and refreshes. The RC-split target read the frozen value while its validator and approve read live → both use `liveLineOf`. `export-purchase-valuation.ts` now reads a line the way the app does.
- **Refreeze.** Clones are never run through the rule (parent × share); ambiguous/missing parents are orphans and left alone; unknown flags are refused; `--apply` backs up first and aborts on the guard. Dry run on live data: 1,881 lines, 33 changed, all via billed weight, pack-path section empty, guard clean — sausage ×18, zucchini, the two cheeses, eggplant/kale/cilantro, and two RC-clone rows whose earlier frozen values (1,000 g, 30 g) were nonsense because a clone row does not carry its parent's billed weight.
- **Data the diff surfaced (not code):** "Lettuce Burger" has an each-measure of 10 lb per each, so a 5 lb frisée line becomes 0.5 each — the item setup or the match needs a human.
- **A derived rate is accepted when a human derived it.** The review's mismatch panel can write `rate = total ÷ weight`; that is a person confirming the line, not the scanner guessing. Only the scanner/matcher are forbidden from deriving `rate`.
- **`--apply` aborts on ANY pack-path change**, not just the named-item guard: it recomputes from today's data rather than replaying the reviewed diff, so a pack edit between dry run and apply must stop it.

### Follow-ups from the final review (not built)
1. A failed save is dropped from the pending queue, so a later success resets the error chip and `handleApprove` cannot see it — re-queue failed patches and abort approve when the flush fails (pre-existing on main).
2. Toggling a line to per-case should clear `rate` / `rateUOM` / `totalQty` / `totalQtyUOM` (or `lineReceived` should honour an explicit per-case) — today a mis-scanned case line a reviewer corrects still receives by weight. Needs a decision first: Goats Cheese / Cheese Curd are scanner-`per_case` lines whose printed rate IS the proof.
3. Cheap mis-scan guard in `billedWeightIsPriced`: refuse when `totalQty == rawQty`, `rawUnit` is a container, and a printed pack disagrees with the billed weight by more than 2×.
4. Provenance never shows on the approved report (every approved line is `via: 'frozen'`) — persist `via` at freeze, or compute a live label when live == frozen.
5. **Pricing** for weight-billed lines on COUNT items with an each-measure (eggplant, kale): approve still prices them through the CASE path, so purchase valuation reads too low now that the quantity is right. Needs its own spec.
6. A unit-less billed weight with a weight `rateUOM` on a PACK item should fall back to `rateUOM` (0 such lines today).
7. An unpriced line (no price, no total) should raise a review warning — invoice 202516 "Veal Bones 501 lb/cs" credits 227 kg from a line with no money. Do not silently zero it: free replacements do deliver stock.
8. `parseValidSplit` reads pre-write pricing while the freeze reads post-write (narrowed by this work to lines whose printed rate does not reconcile).
