# Item backbone — Stage 5: invoice accuracy fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An approved invoice puts exactly what was delivered into stock, every time. Three faults found by the 2026-10-04 backbone audit (`scratchpad/audit/backbone-audit-2026-10-04.md` §5) stop:
- **A — unit-less weight.** A per-weight line that prints "15.775 @ $25" with no unit is read in the unit the supplier's box is priced in (kg for Cleveland's bison), not the item's base unit (g). The reviewer sees which unit was assumed, and a line whose price works out 20× or more away from the box's price is flagged before approve.
- **B — guard-blocked lines silently unreceived.** A line the approve guards refuse (pack disagreement, a rate the item cannot be costed in, no price) no longer vanishes inside an "approved" invoice. Approve refuses with a 409 and a list of the blocked lines; the session stays in review; the reviewer fixes each line or chooses "Receive the stock, keep the old price".
- **C — new product on an RC-split invoice.** The RC copy of a create-new line carries the new product, so the purchase lands on it.

Plus the one-time repairs for the history (dry-run → owner's yes → apply with a JSON backup) and an owner checklist of data tidy-ups.

**Architecture:** One pure per-line decision, `decideLinePrice()` in `src/lib/invoice/approve-outcome.ts`, is lifted out of the approve route (today's inline code, `approve/route.ts` ~232–538) and is used by (1) the approve route's per-line loop, (2) a new **preflight** in the route's `POST` before the REVIEW→APPROVING claim, and (3) the review screen's `lineReasons` — so the screen, the 409 and the approval can never disagree about whether a line is blocked. The unit rule for unit-less weights is its own pure function, `weightUnitFor()` in `src/lib/invoice/weight-unit.ts`, used by the decision AND by the review card's "assumed kg" note and weight-unit dropdown default. Bug C is a two-line fix inside the clone block plus a guard. History is repaired by one script with three explicit modes over pure planners.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma, vitest, `npm run build`.

**Evidence (read-only, live DB, 2026-10-04; scripts in `scratchpad/audit/p-stage5.ts`, `q-stage5-a.ts`, `r-stage5-tidy.ts`, `s-stage5-blocked.ts`, `t-stage5-boxes.ts`, `u-stage5-offers.ts`):**

| Fault | Historical lines | Spend | Notes |
|---|---|---|---|
| A | 5 (bison, Cleveland 1147–1151) | $2,322.51 | frozen 92.9 g, should be 92,900 g; the 3 older unit-less bison lines (1108, 1115, 1130, $2,084.38) froze correctly in Aug and are untouched |
| B | 60 non-split lines all-time: 31 in the last 30 days ($1,420.47) + 29 older ($1,817.01) | $3,237.48 | all on active, unmerged items, all with a linked supplier; ALL 60 are receivable through their own printed pack. Replayed against today's boxes: 44 still trip the pack guard (Cilantro, Pineapple, Jalapeño, Cucumber, Egg Yolk… — real case-size differences, mostly on the MAIN box), 1 has no price at all (Limes, `newPrice` null — a fourth silent path, see Task 2), 15 would pass. Plus 5 split parents ($354.06) whose RC copies already count — excluded. |
| C | 21 clone lines | $3,095.88 | 3 in the last 30 days ($907.54: Venison, Arctic Char, Rice Arborio), 18 older ($2,188.34). All are WHOLE moves (clone total = parent total); all 21 parents are found by (parent session, rawDescription, sortOrder), are matched to the created item and have a frozen receipt; 20 clones lack a receipt, 1 (Venison) has one; 1 linked item is switched off (B11NV DARK CHOC CALLETS 54%). Only 1 of 21 has an `ITEM_CREATED` undo record (records start 22 Sep), so the parent's `matchedItemId` is the primary link and the undo record a cross-check. |

All repaired lines are dated before the last full counts (29 Sep – 1 Oct), so **today's theoretical stock does not move**. What moves: September/August purchases and COGS (up by the repaired spend), and the 30-day average (more lines in it). The owner must hear that before any month is closed.

`src/app/api/invoices/sessions/[id]/split/route.ts` is the photo-grouping split (one upload → several invoices), not the RC copy. **It is not touched.** The RC copies are built inside the approve route's clone block (~1153–1282).

## Global Constraints

- Branch off `origin/main` **after Stage 4 merges**. Worktree `.claude/worktrees/invoice-accuracy`, branch `worktree-invoice-accuracy`, pushed as `feat/invoice-accuracy`. One PR, squash-merged.
- **No migration.** Nothing new is stored: the blocked-line list is a 409 response, the reviewer's "receive, keep the price" choice is a request field, the assumed unit is derived, and the receive-only outcome is recorded in the session's existing `errorMessage`.
- `node`/`npm` are not on the sandbox PATH: prefix every command with `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" &&` (Bash `dangerouslyDisableSandbox: true`). `node_modules`/`.env` symlinked. After `EnterWorktree`, `git fetch origin && git reset --hard origin/main`.
- **Every live repair:** dry run first (default, writes nothing); `--apply` writes `invoice-accuracy-<mode>-backup-<stamp>.json` (every row's previous values) BEFORE the first write, and the backup is copied to the main checkout root (`/Users/joshua/dev/fergies-os/`). `--apply` runs ONLY after the owner's yes on that mode's dry-run output, quoted in the PR.
- Invariants that must still hold after this stage (and are asserted in tests): an item with ≥1 box equals its primary box; only the primary box re-prices the item; `received × price = line total` on the weight path; a frozen receipt is never echoed back into its own recompute; RC copies are read as `parent × (clone total ÷ parent total)`, never through the rule.
- Plain English in every sentence a person sees (409 messages, issue text, session note, script output). No "dimension", "base unit", "chain" in UI copy.
- Role gates unchanged (approve MANAGER+). Prisma `Decimal` → `Number()`.
- `npm test` green; `npm run build` green; lint **19 files** (the `main` baseline) — no new ones.

---

### Task 1: `weightUnitFor` — the unit of an unlabelled weight

**Files:**
- Create: `src/lib/invoice/weight-unit.ts`
- Test: `src/lib/__tests__/weight-unit.test.ts`

**Interfaces:**
```ts
// src/lib/invoice/weight-unit.ts (pure, client-safe)
export type WeightUnitSource = 'line-rate' | 'line-weight' | 'box' | 'count-unit' | 'base-unit' | 'fallback'
export interface WeightUnit { unit: string /* canonical token: 'kg', 'lb', 'g', 'l'… */; source: WeightUnitSource; assumed: boolean }
export function weightUnitFor(a: {
  rateUOM: string | null | undefined
  totalQtyUOM: string | null | undefined
  rawUnit: string | null | undefined
  /** lineReceived(...).via is 'billed-weight' | 'shipped-unit' */
  pricedByWeight: boolean
  /** The pricing of the format this line SPEAKS: resolveLineFormat(item, thisSupplier'sBox).pricing —
   *  the box's when it is plausible, else the item's own (box-less item, or a corrupt box). */
  boxPricing: Pricing | null | undefined
  item: { countUnit: string | null | undefined; baseUnit: string | null | undefined }
}): WeightUnit
export function assumedUnitNote(w: WeightUnit, ctx: { supplierName: string | null; itemName: string }): string | null
```

**The rule (exact order; steps 1–3 are today's code unchanged, only the fallback changes):**
1. `rateUOM` is a weight/volume (`isMeasureUnit`) → it. `source 'line-rate'`, not assumed.
2. `pricedByWeight` and `totalQtyUOM` is a weight/volume → it. `'line-weight'`, not assumed.
3. `pricedByWeight` and `rawUnit` is a weight/volume → it. `'line-weight'`, not assumed.
4. `boxPricing.mode === 'RATE'` and `boxPricing.rateUnit` is a weight/volume → it. `'box'`, **assumed**.
5. `item.countUnit` is a weight/volume → it. `'count-unit'`, assumed.
6. `item.baseUnit` is a weight/volume → it. `'base-unit'`, assumed.
7. `'kg'`. `'fallback'`, assumed.
Always returned canonical (`canonicalUom`).

**Plain-English note** (`assumedUnitNote`, null when not assumed): box → "assumed kg — the invoice shows no unit; Cleveland Meats' box is priced per kg"; count-unit → "assumed kg — the invoice shows no unit; bison burger is counted in kg"; base-unit → "assumed g — the invoice shows no unit"; fallback → "assumed kg — the invoice shows no unit. Check it."

- [ ] **Step 1: Failing tests** — bison: `{ rateUOM: null, totalQtyUOM: null, rawUnit: null, pricedByWeight: false, boxPricing: RATE 25/kg, item: { countUnit: 'kg', baseUnit: 'g' } }` → `{ unit: 'kg', source: 'box', assumed: true }` (today's code gives `g`); the same with `boxPricing: PACK` → `count-unit kg`; countUnit `case` + base `g` → `base-unit g`; base `each`, countUnit `each`, PACK → `fallback kg`; `rateUOM 'LBS'` → `line-rate lb` (not assumed) even with a kg box; `pricedByWeight` + `totalQtyUOM 'KG'` → `line-weight kg`; NOT pricedByWeight + `totalQtyUOM 'kg'` + kg box → `box` (step 2 needs proof, as today); box `RATE $3.49/lb` on an `each` item (bridged) → `box lb`; box `RATE x/each` → skipped (not a measure). `assumedUnitNote` — the four sentences; null for steps 1–3.
- [ ] **Step 2: Implement** (reuse `isMeasureUnit` from `approve-format.ts`; no Prisma).
- [ ] **Step 3: `npm test`; commit** `feat(invoices): an unlabelled weight is read in the unit its supplier's box is priced in`.

---

### Task 2: `decideLinePrice` — one per-line decision for the screen, the preflight and approve

**Files:**
- Create: `src/lib/invoice/approve-outcome.ts`
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts` (replace the inline decision ~232–538 with a call; behaviour identical except the Bug A fallback and the "no price at all" path)
- Tests: `src/lib/__tests__/approve-outcome.test.ts`, `src/lib/__tests__/approve-outcome-parity.test.ts`

**Interfaces:**
```ts
// src/lib/invoice/approve-outcome.ts (pure, client-safe — no Prisma, no '@/lib/supplier-offers')
export type BlockReason =
  | 'PACK_DISAGREES'     // printed case ≠ this supplier's box (or the item's) by > 25 %  (packFormatsDisagree)
  | 'RATE_UNCOSTABLE'    // a $/kg rate on an item that can't take it (rateIsCostable false)
  | 'NO_PRICE'           // the line works out at $0 / NaN, or carries no price at all
  | 'PRICE_IMPLAUSIBLE'  // per-weight line ≥ 20× (IMPLAUSIBLE_PRICE_RATIO) above or below the box's current $/base
  | 'NOT_LINKED'         // UPDATE_PRICE / ADD_SUPPLIER with no matched item
  | 'CREATE_NEW_NOT_SET_UP' | 'CREATE_NEW_NAME' | 'CREATE_NEW_SHAPE'   // today's three CREATE_NEW refusals

export interface ApproveLineInput { /* the scan-line fields lineQtyOf + derivePricingMode + the reverse bridge read:
  rawQty, rawUnit, rawUnitPrice, rawLineTotal, newPrice, totalQty, totalQtyUOM, rate, rateUOM, pricingMode,
  qtyOrdered, invoicePackQty, invoicePackSize, invoicePackUOM, supplierItemCode, rawDescription, action, matchedItemId, newItemData */ }
export interface ApproveItemInput { /* id, itemName, dimension, baseUnit, countUnit, packChain, pricing, eachMeasureQty, eachMeasureUnit, densityGPerMl */ }

export type LineDecision =
  | { ok: true
      speaks: ChainItem; received: Received; pricedByWeight: boolean; isUomMode: boolean
      weightUnit: WeightUnit | null            // set on the weight path
      resolvedRateUnit: string; density: number; itemForRate: ChainItem
      reverseBridge: boolean; reverseBasePerCase: number
      newPurchasePrice: number; newPricePerBase: number; spineNewPpb: number | null; newPricing: Pricing
      implausible: { ratio: number; currentPpb: number } | null }   // non-null ⇒ PRICE_IMPLAUSIBLE unless confirmed
  | { ok: false; reason: Exclude<BlockReason, 'PRICE_IMPLAUSIBLE'>; message: string
      speaks: ChainItem | null; received: Received | null; receivable: boolean; receiveBase: number }

export function decideLinePrice(a: {
  line: ApproveLineInput; item: ApproveItemInput
  lineOffer: OfferFormat | null     // pickOffer(offers, { supplierId, supplierName, canonicalName, itemCode })
  itemHasOffers: boolean; sessionHasSupplier: boolean; supplierName: string | null
}): LineDecision

export interface BlockedLine {
  scanItemId: string; description: string; itemName: string | null
  reason: BlockReason; message: string
  canReceiveWithoutPrice: boolean   // true for PACK_DISAGREES, RATE_UNCOSTABLE, NO_PRICE, PRICE_IMPLAUSIBLE
  canConfirmPrice: boolean          // true only for PRICE_IMPLAUSIBLE
}
/** The preflight: every line approve would refuse, minus the ones the reviewer already decided. */
export function approveBlocks(a: {
  lines: Array<ApproveLineInput & { id: string; matchedItem: ApproveItemInput | null }>
  offersByItem: Map<string, OfferFormat[]>; supplier: SupplierRef & { id: string | null }
  receiveWithoutPrice: Set<string>; priceConfirmed: Set<string>
}): BlockedLine[]
```

**Exact rules inside `decideLinePrice`** (lifted verbatim from the route; the only behaviour changes are marked NEW):
- `speaks = resolveLineFormat(asChainItem(item), lineOffer)`; `received = lineReceived(lineQtyOf(line), speaks)`; `pricedByWeight = via ∈ {billed-weight, shipped-unit}`; `isUomMode = pricingBasisFor(...) === 'WEIGHT'`; the reverse bridge exactly as today.
- NEW: weight path rate unit = `weightUnitFor({ …line, pricedByWeight, boxPricing: speaks.pricing, item })` instead of today's `… : wv(item.baseUnit) ? item.baseUnit : 'kg'`. Everything downstream (density cross, `weightBasisRate`, `ratePerBase`, `newPricing.rateUnit`, the offer chain, `freezeFormat`) reads this one unit, so the price written and the receipt frozen agree. Bison: `RATE $25/kg`, receipt 15,775 g.
- Guards in today's order: CASE-path `PACK_DISAGREES` (`packReference` + `packFormatsDisagree`), then `RATE_UNCOSTABLE`, then `NO_PRICE`.
- NEW: a priced action (`UPDATE_PRICE`/`ADD_SUPPLIER`) with a matched item but **no price input at all** (`rawUnitPrice`, `rate` and `newPrice` all null) → `NO_PRICE`. Today it falls through every branch of the loop: never approved, never counted as skipped (Limes, invoice 444324576).
- NEW: `implausible` — only when `isUomMode` (per-weight, as asked): `currentPpb = pricePerBaseUnit(speaks)` (the box's when plausible, else the item's); when both > 0 and `newPricePerBase / currentPpb` > 20 or < 1/20 → `{ ratio, currentPpb }`. Old bison rule: $25/g vs $0.025/g → ratio 1000 → flagged; new rule → ratio 1 → clear.
- `receiveBase` on a refusal = `pricedByWeight ? received.base : lineReceivedBaseUnits(lineQtyOf(line), speaks)` (the receiving rule through the PRE-write format — no price is written, so no `freezeFormat`); `receivable = receiveBase > 0`.
- CREATE_NEW: `approveBlocks` runs today's three checks (`newItemData` missing; `createNewName(...).ok === false`; `validateCreateNew(...).ok === false`) and reports them with `canReceiveWithoutPrice: false` (there is no product to receive into).

**Messages (plain English, built here, shown by the 409 and the screen):**
- PACK_DISAGREES: "Sysco's box for Cilantro is a case of 4 × 1 lb (1.81 kg). This line says 1 × 1 lb (454 g). Fix the case size, or receive the stock and keep the old price." (box vs item wording: "Cilantro's box" when the reference is the item's own).
- RATE_UNCOSTABLE: "This line is priced per kg, but Pineapple is counted in each and has no weight per each. Set how much one weighs, or receive the stock and keep the old price."
- NO_PRICE: "This line has no price. Enter the price, or receive the stock and keep the old price."
- PRICE_IMPLAUSIBLE: "Price looks about 1,000× off — check the unit. This line works out at $25.00 per g; Cleveland Meats' box is $0.025 per g." (ratio rounded to 2 significant figures; prices per the item's base unit shown in the friendliest unit — per kg / per lb / per L / each — via the existing formatter).
- NOT_LINKED: "This line isn't linked to a product. Link it, create a product, or skip it."
- CREATE_NEW_*: today's sentences (`skippedCreateNew` reasons), without "Delete this invoice and scan it again" — the reviewer can now fix it in place.

- [ ] **Step 1: Failing unit tests** (`approve-outcome.test.ts`): bison unit-less → ok, `RATE 25/kg`, `received.base` read through `freezeFormat` = 15,775 g, `implausible: null`; same line forcing the OLD fallback (box PACK, countUnit `case`, base `g`) → `weightUnit.source 'base-unit'` and `implausible.ratio ≈ 1000` vs a `$0.025/g` item; Baking-Powder pack change (3 kg box, line 1 × 20 kg) → `PACK_DISAGREES`, `receivable`, `receiveBase 20000`; Cilantro (box 4 × 1 lb, line 1 × 1 lb) → `PACK_DISAGREES`, `receiveBase 453.592`; `$/kg` on an each-item with no each-measure → `RATE_UNCOSTABLE`; with each-measure 400 g → ok; `$0` rawUnitPrice → `NO_PRICE`; all three price fields null → `NO_PRICE`; a new supplier with no box on an item that has boxes → no pack guard (as today); `approveBlocks` drops a blocked id present in `receiveWithoutPrice`, drops a PRICE_IMPLAUSIBLE id present in `priceConfirmed`, keeps a CREATE_NEW refusal even when its id is in `receiveWithoutPrice`.
- [ ] **Step 2: Parity tests** (`approve-outcome-parity.test.ts`): a table of 10 recorded line shapes taken from the existing fixtures in `approve-format.test.ts` / `line-qty.test.ts` (Butter 2 CS with stray 2.86 kg; Sausage billed 14.6 kg @ $15.95/kg; Eggplant 12 lb @ $3.49 on a bridged each-item; Brioche 8 × 1100 g; reverse bridge 1 cs = 70 each on a g item; 18.4 KG first per-weight invoice on a case item; Tamari 1 × 1.89 L vs 6 × 1.89 L; per-case rate `rateUOM 'CS'` 41.88 shipped 12 LB; density cross $/kg on an ml item; non-primary supplier with its own case) → assert `newPricing`, `newPricePerBase`, `spineNewPpb` and the frozen base equal what the CURRENT route computes for them (snapshot the expected numbers from `main` before refactoring — write them as literals in the test).
- [ ] **Step 3: Implement** `approve-outcome.ts`; replace the route's inline block with `const d = decideLinePrice({...})`. The route keeps every WRITE where it is (offer upsert, primary sync, spine write, alert, undo); it only reads `d.*` instead of locals. `skippedLines++ / continue` for the three guards is replaced in Task 3.
- [ ] **Step 4: `npm test`, build, lint; commit** `refactor(invoices): one per-line approve decision, shared by the route and (next) the review screen; an unlabelled weight follows its box's unit`.

---

### Task 3: Approve refuses blocked lines (409); "receive, keep the price"; RC copy of a new product

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts`
- Test: `src/app/api/invoices/__tests__/approve-preflight.test.ts` (new folder), `src/lib/__tests__/approve-session-note.test.ts`
- Create: `src/lib/invoice/approve-note.ts` (pure session-note builder)

**Decision (Bug B):** **409 + stay in REVIEW**, with a per-line opt-in to receive without the price.
Why: the reviewer has the invoice open at that moment and is the only person who can tell a real case-size change from an OCR misread; a silent receive-only default would hide 44 of 60 historical lines that are real price signals (Sysco changed Cilantro's case). But a blanket refusal would block every Sysco produce invoice until someone edits the box, so each blocked line also offers "Receive the stock, keep the old price" — the delivery still lands, the price simply doesn't move. Receive-only is also the server's last line of defence if the snapshot changes between preflight and the write: **no approval path may leave a delivery unreceived again.**

**Request body (all optional):** `{ force?: boolean, receiveWithoutPrice?: string[], priceConfirmed?: string[] }` — scan-item ids. Unknown/foreign ids are ignored.

**POST order** (unchanged steps kept): auth → load session (`include: { scanItems: { include: { matchedItem: true } } }`) → 404/REVIEW check → RC write-scope guard → duplicate gate (409 now also carries `code: 'DUPLICATE'`, keeps `duplicate: true`) → **NEW preflight** → atomic claim → alias learn → `waitUntil(doApprove(...))`.

**Preflight:** load the offers snapshot ONCE (the query now at the top of `doApprove`, moved into a `loadApproveSnapshot(session)` helper in the route file that returns `{ offerRows, offersByItem, offerSupplierName }`), run `approveBlocks(...)`. Non-empty → 
```json
HTTP 409
{ "code": "LINES_BLOCKED",
  "error": "2 lines can't be approved yet. Fix each one, or choose “Receive the stock, keep the old price”.",
  "blocked": [ { "scanItemId": "…", "description": "CILANTRO CLEAN WASH FRES", "itemName": "Cilantro",
                 "reason": "PACK_DISAGREES", "message": "Sysco's box for Cilantro is a case of 4 × 1 lb …",
                 "canReceiveWithoutPrice": true, "canConfirmPrice": false } ] }
```
The session is untouched (still REVIEW, no `errorMessage` written). The snapshot is passed into `doApprove` so the run reads exactly what the preflight judged.

**`doApprove` per line (priced actions, now gated on `matchedItemId` only — not `newPrice !== null`):**
- `d.ok` and (`!d.implausible` or id ∈ `priceConfirmed`) → today's writes, unchanged.
- `d.ok === false` with `d.receivable`, or `d.implausible` and not confirmed (only reachable on a race) → **receive-only**: `freezeQty(d.receiveBase)`, `invoiceScanItem.update { approved: true, receivedQtyBase }`, `registerLineAllocs`; NO offer upsert, NO `ensurePrimary`, NO spine write, NO PriceAlert, NO undo record (the scan rows are deleted with the session on DELETE anyway); push `{ description, itemName, message }` to `receivedWithoutPrice`.
- `d.ok === false` and not receivable (receive base 0) → today's skip, kept as `skippedLines` (preflight blocks it first; unreachable except on a race).
- Aliases are still learned for receive-only lines (the match is confirmed; only the price was in doubt).

**Session note** (`approve-note.ts`, replaces the inline `skipParts` text): `buildApproveNote({ receivedWithoutPrice, skippedPrice, skippedCreateNew, createNewNameRefused })` →
- "2 lines were received without a price change: Cilantro — the invoice's case (1 × 1 lb) differs from Sysco's box (4 × 1 lb); Pineapple — … The stock is in; the prices were left as they were." 
- Today's CREATE_NEW sentence stays for the race-only path.
Written to `errorMessage` exactly as today (null when nothing to say).

**Bug C (clone block):**
- Keep `createdByLine = new Map<scanItemId, string /* created item id */>()`, set right after `prisma.inventoryItem.create` in the CREATE_NEW branch.
- `scaledCopy`: `matchedItemId: createdByLine.get(item.id) ?? item.matchedItemId`. The frozen receipt already travels (`frozenByLine` is filled by the CREATE_NEW `freezeQty`), scaled by `factor`.
- Guard: a CREATE_NEW line that created nothing (`!createdByLine.has(id)`) is NOT copied into an RC clone (today it is copied as an approved, unmatched row).
- A create-new line can only move WHOLE (factor 1): the review screen already blocks a quantity split on an unlinked line (`hasInvalidRcSplit` returns true without `matchedItem`), and `parseValidSplit` needs `matchedItem`. Stated in a comment; no change.
- Rollback is already safe: `loadItemRefs` excludes the session's own clones from the reference check, so DELETE still removes the created product.

- [ ] **Step 1: Failing route tests** (`approve-preflight.test.ts`; mock `@/lib/prisma` (`invoiceSession.findUnique/findFirst/updateMany/update/create/findMany/deleteMany`, `revenueCenter.findFirst`, `inventorySupplierPrice.findMany/findFirst/create/update`, `invoiceScanItem.update/updateMany/createMany`, `inventoryItem.create/update`, `invoiceApproveUndo.deleteMany`, `$transaction`), `@vercel/functions` `waitUntil` (capture the promise and await it in the test), `@/lib/auth` `requireSession`, `@/lib/rc-scope` `assertRcWritable`, `@/lib/supplier-matcher` `learnAlias`, `@/lib/invoice-matcher` `saveAlias`, `@/lib/recipeCosts`, `@/lib/recipe-costs`, `@/lib/primary-offer` `ensurePrimary`):
  1. a session with a Cilantro pack-disagreement line → 409 `LINES_BLOCKED`, one entry, `reason PACK_DISAGREES`, `canReceiveWithoutPrice true`; `invoiceSession.updateMany` (the claim) NOT called; no `errorMessage` write.
  2. same with `receiveWithoutPrice: [id]` → 200 `{ ok, queued }`; after `waitUntil` settles: the line updated `{ approved: true, receivedQtyBase: 453.592 }`; `inventorySupplierPrice.create/update` and `inventoryItem.update` NOT called for it; session `errorMessage` contains "received without a price change".
  3. bison unit-less line, box `RATE 25/kg` → 200; scan line frozen at 15,775; offer written with `pricing { RATE, 25, 'kg' }`.
  4. bison line under a box `PACK` and an item counted in `g` with a `$0.025/g` price → 409 `PRICE_IMPLAUSIBLE`, `canConfirmPrice true`; with `priceConfirmed: [id]` → 200 and the price is written.
  5. a CREATE_NEW line with no `newItemData` → 409 `CREATE_NEW_NOT_SET_UP`, `canReceiveWithoutPrice false`; still 409 when its id is in `receiveWithoutPrice`.
  6. a priced line with all price fields null (Limes) → 409 `NO_PRICE`.
  7. duplicate invoice → 409 `code 'DUPLICATE'`, `duplicate: true` (unchanged for the client).
  8. Bug C: a CREATE_NEW line with `revenueCenterId` = a non-default RC → `invoiceScanItem.createMany` receives a copy with `matchedItemId` = the id `inventoryItem.create` returned and `receivedQtyBase` = the frozen value; the parent is flagged `splitToSessionId`.
  9. a refused CREATE_NEW (race path, simulate by mutating the input after preflight) is not copied into the clone.
- [ ] **Step 2: `approve-session-note.test.ts`** — the three sentences, singular/plural, trailing full stops.
- [ ] **Step 3: Implement**; `npm test`, build (check `approve` stays `ƒ (Dynamic)`), lint.
- [ ] **Step 4: Commit** `fix(invoices): approve refuses blocked lines instead of silently dropping them; a reviewer can receive stock without the price; a new product on a split invoice gets its purchase`.

---

### Task 4: The review screen — blocked lines, the unit check, the assumed unit

**Files:**
- Modify: `src/lib/invoice/resolution.ts` (`lineReasons` gains two reasons; `ResolveOpts` gains `receiveOnly`, `unitConfirmed`, `serverBlock`)
- Create: `src/lib/invoice/approve-outcome-client.ts` — `decisionForScanItem(item: ScanItem, ref: SupplierRef): LineDecision | null` (adapter: `matchedLikeOf(item.matchedItem)` → `ApproveItemInput`, `offerForSupplier(item, ref)` → `lineOffer`, `itemHasOffers = (item.matchedItem.supplierPrices ?? []).length > 0`)
- Modify: `src/components/invoices/v2/atoms.tsx` (`IssueKind` += `'blocked' | 'unit'`; `ISSUE_BADGE` entries with flat tokens `bg-red-soft text-red-text` / `bg-gold-soft text-gold-2`)
- Modify: `src/components/invoices/v2/issues.tsx` (two issue blocks), `src/components/invoices/v2/card.tsx` (~276: the received-weight line), `src/components/invoices/v2/composites.tsx` (`InvoiceMathFields` ~385: the weight-unit default), `src/components/invoices/v2/InvoiceReviewDrawer.tsx` (state, body, 409 handling)
- Tests: `src/lib/__tests__/resolution-approve-block.test.ts`

**Reasons (`lineReasons`, which already feeds the strip, badges, progress and the Approve gate):**
- `kind 'blocked'` when `decisionForScanItem(...)` is `ok: false` (or the server sent a block for this id): title by reason — "Case size changed" / "Priced by weight, counted by each" / "No price" / "Not linked" / "New product not set up"; summary = the decision's message. **Resolved** when the line no longer blocks, or `opts.receiveOnly` (only offered when `canReceiveWithoutPrice`).
- `kind 'unit'` when `decision.ok && decision.implausible`: title "Price looks {ratio}× off"; summary "Check the unit. This line works out at $25.00 per g; Cleveland Meats' box is $0.025 per g." **Resolved** when the unit is changed so the ratio clears, or `opts.unitConfirmed` ("The price is right").

**Issue blocks (`issues.tsx`):**
- `ApproveBlockIssue({ item, reason, onReceiveOnly, onAdoptFormat })`: the message + buttons. PACK_DISAGREES: "Use this invoice's case for {Supplier}'s box" (opens the existing `AdoptFormatModal`, which since Stage 2b writes that supplier's box) and "Receive the stock, keep the old price". RATE_UNCOSTABLE: "Set how much one weighs" (opens the existing bridge editor) + receive-only. NO_PRICE: focus the price field + receive-only. Others: the existing link/create controls.
- `UnitCheckIssue({ item, suggestion, onSetUnit, onConfirm })`: "It's per {box unit}" quick fix (stages `rateUOM` = the box's rate unit, and `totalQtyUOM` = the same when `totalQty` is set and has no unit — a normal staged edit flushed by `flushPendingEdits`) + "The price is right".

**Assumed unit:** `InvoiceMathFields` initial `weightUOM` = `rateUOM ?? totalQtyUOM ?? qtyOrderedUOM ?? weightUnitFor(...).unit` (was `'lb'` — a unit-less bison line showed "lb" here while the server assumed "g"); under the unit dropdown and on the card's received line (card.tsx ~276, also `'lb'` today) show `assumedUnitNote(...)` in small muted text while the line has no unit of its own. Choosing a unit in the dropdown writes it to the line (existing behaviour), which ends the assumption.

**Approve (`InvoiceReviewDrawer.handleApprove`):** state `receiveOnlyLines: Set<string>`, `unitConfirmedLines: Set<string>`, `serverBlocks: Map<string, BlockedLine>`. Body: `{ force, receiveWithoutPrice: [...receiveOnlyLines ∩ lines still blocked], priceConfirmed: [...unitConfirmedLines ∩ lines still flagged] }`. On `409 && code === 'LINES_BLOCKED'`: no `alert`; set `serverBlocks`, focus the first blocked line (`focusLine`), and show one line above the footer: "{n} lines need a decision before this invoice can be approved." On `409 && (code === 'DUPLICATE' || duplicate)`: today's confirm. Clear `serverBlocks[id]` when that line is edited.

- [ ] **Step 1: Failing tests** (`resolution-approve-block.test.ts`, ScanItem fixtures): Cilantro pack line → one unresolved `blocked`; with `receiveOnly` → resolved; after staging pack 4 × 1 lb → no `blocked`; unit-less bison under a PACK box → unresolved `unit`; staging `rateUOM: 'kg'` → no `unit`; `unitConfirmed` → resolved; a clean line → neither; `lineUnresolved` true/false accordingly (so the Approve gate follows).
- [ ] **Step 2: Build the UI**; `npm run build`; lint.
- [ ] **Step 3: Commit** `feat(invoices): the review screen shows lines approve would refuse, a price that looks 1000× off, and the unit it assumed`.

---

### Task 5: One-time repair script (three modes)

**Files:**
- Create: `src/lib/invoice/accuracy-repair.ts` (pure planners)
- Create: `scripts/repair-invoice-accuracy.ts`
- Test: `src/lib/__tests__/accuracy-repair.test.ts`

**Usage:**
```
npx tsx scripts/repair-invoice-accuracy.ts --mode unitless-weight [--apply]
npx tsx scripts/repair-invoice-accuracy.ts --mode blocked [--with-box-refresh] [--apply]
npx tsx scripts/repair-invoice-accuracy.ts --mode split-create-new [--apply]
```
Dry run is the default and prints one row per line (invoice, date, supplier, item, line $, old → new receipt, what else it would write) plus totals. `--apply` writes `invoice-accuracy-<mode>-backup-<stamp>.json` (every touched row's previous values) first, then each line in its own `prisma.$transaction`, then prints the `cp` command to copy the backup to `/Users/joshua/dev/fergies-os/`. `--apply` RECOMPUTES (never replays the dry-run file) and refuses to run if the candidate set differs from what a fresh dry-run would list by more than the rows already applied (same pattern as `backfill-received-qty-base.ts --refreeze`). Unknown flags → usage + exit 1. A bare `--apply` with no `--mode` → exit 1.

**Mode `unitless-weight` (Bug A history).** Candidates: approved lines in APPROVED, non-clone sessions, matched, whose decision takes the weight path with `weightUnit.assumed`. For each: recompute `decideLinePrice` against TODAY's item and box (bison's Cleveland box is `RATE $25/kg` again since the 20:45 hand fix) and freeze `pricedByWeight ? received.base : lineReceivedBaseUnits(line, freezeFormat(speaks, newPricing))`. Write only when `isMaterialChange(prev, next)` AND `next / prev` is a pure unit factor (`unitFactorBetween(prev, next)` ∈ {1000, 1/1000, 453.592, 1/453.592, 28.3495, 1/28.3495, 2.20462, 1/2.20462} within 0.5 %) — anything else is listed as "needs a look", never written. RC copies of a changed line: `parent × cloneShare(parent total, clone total)` (none exist for bison today).
**Expected dry run (2026-10-04):** 5 lines change — Cleveland 1147 30.585 → 30,585 g; 1148 15.86 → 15,860; 1149 15.775 → 15,775; 1150 10.41 → 10,410; 1151 20.27 → 20,270 (92.9 g → 92,900 g, $2,322.51). 1108 / 1115 / 1130 unchanged.
**Must NOT:** touch any item, box, price, alert, undo record or session; touch a line whose change isn't a pure unit factor.

**Mode `blocked` (Bug B history).** Candidates: `approved = false`, action `UPDATE_PRICE`/`ADD_SUPPLIER`, matched, in an APPROVED session with no `parentSessionId`, `splitToSessionId IS NULL`. For each:
- receipt = `lineReceived(lineQtyOf(line), resolveLineFormat(asChainItem(item), pickOffer(offers, { supplierId, supplierName, canonicalName, itemCode })))`.base (the frozen value deliberately not passed in); listed "cannot receive" when 0 (none today).
- write `{ approved: true, receivedQtyBase }`.
- membership: `ItemRevenueCenter` for the line's RC (else the session's) if missing; `StockAllocation` (quantity 0) for a non-default RC if missing — the same pair approve registers.
- session note: append " Stock for {n} line(s) was received on {date} by the invoice-accuracy repair; prices were left as they were." to `errorMessage`.
- box refresh — ONLY with `--with-box-refresh`, ONLY for a box that (1) exists and is NOT the primary, (2) the line's decision is `ok` against today's box, (3) no approved line from the same supplier for the same item has a later purchase date, (4) the box's own source invoice (`lastInvoiceSessionId`) has an earlier purchase date than this line, and (5) `box.lastUpdated` ≤ this line's session `approvedAt`. Writes that box's `packChain`/`pricing`/`packQty/packSize/packUOM`/`lastInvoiceSessionId`/`lastUpdated` exactly as the approve route would (the decision's `newPricing` and offer-chain rule). Expected: 2 boxes (BLUEBERRY FRESH / Snow Cap from invoice 72703054; Yellow potato / Your Independent Grocer from 02 4518); Burger Bun Sliced fails (a newer Snow Cap invoice exists).
**Expected dry run:** 60 lines, $3,237.48 (31 / $1,420.47 in the last 30 days; 29 / $1,817.01 older); all 60 receivable; today's guard verdicts: 44 case-size, 1 no price, 15 clear. 5 split parents ($354.06) listed as "already counted through its RC copy — skipped".
**Must NOT:** re-price any item (`InventoryItem.pricing`/`packChain`), touch or create a primary box, create any box (on a box-less item that would break "≥1 box ⇒ exactly one primary"), call `ensurePrimary`/`syncPrimaryOfferToItem`, fire `PriceAlert`/`RecipeAlert` or re-cost recipes, write undo records, change a session's status/`approvedAt`/`purchaseDate`, touch split parents or RC copies, or touch a line on a switched-off or merged item (0 today; listed if any appear).

**Mode `split-create-new` (Bug C history).** Candidates: approved clone lines (`session.parentSessionId` set) with `action = 'CREATE_NEW'` and `matchedItemId IS NULL`. Parent line = same parent session, same `rawDescription`, same `sortOrder` (exactly one, else "needs a look"). Created item = the parent's `matchedItemId`; cross-check: when the parent session has an `ITEM_CREATED` undo record, its `targetId` must equal it (else "needs a look"). Writes: `matchedItemId` = that item; `receivedQtyBase` = `parent.receivedQtyBase × cloneShare(parent.rawLineTotal, clone.rawLineTotal)` when the clone has none; a clone that already has one keeps it (listed if it differs by more than `isMaterialChange`); `ItemRevenueCenter` (clone's RC) if missing.
**Expected dry run:** 21 lines, $3,095.88 (3 / $907.54 in the last 30 days: Venison Striploin $444.15, Arctic Char Fillet $378.00, RICE ARBORIO $85.39; 18 / $2,188.34 older); all shares 1.0; 20 receipts written, 1 kept (Venison, 7,050 g); 1 linked item is switched off (B11NV DARK CHOC CALLETS 54%) — linked anyway, flagged in the output.
**Must NOT:** touch the parent line, the created item, its boxes, prices or aliases; touch a clone whose parent can't be found uniquely.

- [ ] **Step 1: Failing tests** for the pure planners: `unitFactorBetween(15.775, 15775) === 1000`, `(10, 13)` → null; `planUnitless` writes bison, lists a 3× change as "needs a look"; `planBlocked` (rows in, writes out): non-split line → write; split parent → skipped; inactive item → listed; box-refresh conditions (each of the five failing alone blocks the refresh; primary never refreshed; box-less item never gets a box); `planSplitCreateNew`: unique parent → link + share; two parents with the same description+sortOrder → "needs a look"; undo-record mismatch → "needs a look"; clone already frozen → kept.
- [ ] **Step 2: Implement** script + planners; run each mode DRY against live and paste the three summaries into the PR description.
- [ ] **Step 3: Commit** `chore(scripts): invoice-accuracy repair — unit-less weights, blocked lines, new products on split invoices (dry-run by default)`.
- [ ] **Step 4 (after merge, after the owner's yes per mode, in this order):** zucchini box tidy (Task 6 item 3) → `--mode unitless-weight --apply` → `--mode split-create-new --apply` → `--mode blocked --apply` (with `--with-box-refresh` only if he says yes to that line separately). Copy each backup to the main checkout root. Re-run `scratchpad/audit/p-stage5.ts`: expect 0 unapproved priced lines outside split parents, 0 unmatched CREATE_NEW clones, 0 bison receipts under 1 kg.

---

### Task 6: Owner checklist — data tidy-ups (each needs his yes; done in the app where a screen exists)

No new code. Each item is one sentence to the owner, his answer recorded in the PR.

1. **Bison receipts** — "Five Cleveland bison invoices (1147–1151) recorded 92.9 g instead of 92.9 kg. Fix them to 92.9 kg? September's purchases go up by that amount; today's stock doesn't change." → Task 5 `unitless-weight`.
2. **11 stocked items priced $0** — ask for a price or "switch it off":
   | Item | Main supplier / last invoice | Used in |
   |---|---|---|
   | Beef Fat Trim | Legends Haul box, $0 | Beef Tallow → GF Beef Gravy |
   | Beef Tallow (made from a recipe) | follows Beef Fat Trim | GF Beef Gravy |
   | TRSM Spicy Pork Pepperoni, Cold Smoked | Two Rivers box $0/g; last invoice TR469697 (26 Jun, $72.77) — price can be read off that line | — |
   | Cracked coriander seed | no supplier | 2 recipes |
   | Kalamata olive brine | no supplier | 1 recipe |
   | Yuzu juice | no supplier | 1 recipe |
   | sunchokes | no supplier | 1 recipe |
   | sweet potato · Fennel brew creek · duck fat · thai vhilis | no supplier | none — propose switching these four off |
   Entered through the item drawer (box Edit for boxed items; the item's own price for box-less ones).
3. **Farm Squash Zuchinni — Sysco box** (`545f76cc-5b18-44d4-8a23-8ee67db6caba`): its case is stored as "1 lb = 1 each = 1 g", so $49.78 reads as $49.78 per gram. The invoices say 1 case = 10 lb. Proposed: edit the box to **1 case = 10 lb (4,535.92 g), $49.78** → $4.98/lb, through the drawer's box Edit. Do this BEFORE the `blocked` repair: four of the five blocked Sysco zucchini lines (1 × 10 lb) then pass the case check; the fifth (444313391, 1 × 5 lb) stays receive-only.
4. **Chili flakes** (switched off, broken $0 setup) is still in 3 active recipes: Pickle Red Onions, Pickled Cucumber B&B, Pork, Fennel & Chilli Sausage. Ask: "Replace it with Crushed chili (active) in those three, or switch Chili flakes back on and give it a price?" Done in the recipe editor.
5. **Dangling recipe lines** (no item, no recipe, no name): Side Fries 220 g (`d76b3768-…`, the known severed fries line) and Dukkah 175 g + 2 tbsp (`23847ca3-…`, `f9f72305-…`). Ask: "Delete these three lines, or tell me which product each was?" (For Side Fries, re-linking to the fries prep is the better fix if he names it — deleting leaves Side Fries with no ingredients.) Done in the recipe editor.
6. **60 boxed items with no main-supplier wording** — no action; each learns its wording on its next approved invoice (24 of them have been bought before; 36 never).

Out of scope here (listed so nobody assumes they're done): Halloumi/Ricotta stale Kitchen allocations; the 8 supplier wordings that point at switched-off items (the matcher should skip inactive targets — Stage 4's call); Fennel O/S create-new shape candidate.

---

### Task 7: Smoke, PR, merge

- [ ] Preview from the worktree on **port 3121** (add a `invoice-accuracy` entry to the worktree's `.claude/launch.json`; never the main checkout's preview). Live DB, **throwaway data only**: `scripts/smoke-invoice-accuracy.ts --create` makes a REVIEW session for a supplier "ZZ Smoke Supplier" with items "ZZ Smoke Bison" (box `RATE $25/kg`, counted in kg), "ZZ Smoke Herbs" (box 4 × 1 lb case), and one CREATE_NEW line assigned to a non-default RC; `--cleanup` deletes the session through `DELETE /api/invoices/sessions/[id]` (so rollback removes what approve created) and then deletes the ZZ items/supplier if nothing references them. Run only after the owner OKs creating the ZZ rows.
  1. Open the session: the bison line (no unit) shows "assumed kg — … box is priced per kg"; its weight dropdown shows kg.
  2. Change the ZZ bison box to PACK in the drawer → the line now shows "Price looks about 1,000× off — check the unit"; "It's per kg" clears it.
  3. The herbs line printed 1 × 1 lb shows "Case size changed"; Approve is disabled; tick "Receive the stock, keep the old price" → Approve enables.
  4. Approve → session APPROVED; herbs line approved with 453.592 g, box price unchanged; session note says "received without a price change"; bison receipt 15,775 g; the CREATE_NEW clone line in the RC copy carries the new product and its receipt.
  5. Force the server path: with the herbs choice cleared, call `POST …/approve` directly → 409 `LINES_BLOCKED`, session still REVIEW.
  6. `--cleanup`; confirm no ZZ rows remain.
- [ ] Push `feat/invoice-accuracy`; PR with Before/After ("Before: an invoice line the app couldn't price was dropped — the invoice said approved, the stock never arrived. After: approve stops and shows the line; fix it or receive the stock and keep the old price.") and the three dry-run summaries. Merge after the final review passes; then Task 5 Step 4 with the owner's yeses.

## Self-review

- **Spec coverage:** A — rule in `weightUnitFor` (box rate unit → weight count unit → base unit), used by approve, the receipt and the screen; reviewer sees the assumed unit; the 20× guard on per-weight lines reuses `IMPLAUSIBLE_PRICE_RATIO` and is enforced on the screen AND the server. B — 409 chosen and justified; response shape given; per-line "receive, keep the price"; receive-only is also the race fallback, so no path leaves a delivery unreceived; the newly found fourth silent path (priced line with no price, Limes) is closed; repair counted (60 lines, 31 recent) with its NOT list. C — `createdByLine` in the clone, no clone for an uncreated product; repair counted (21 lines, $3,095.88) linking via the parent, cross-checked with `ITEM_CREATED`. Tidy-ups — checklist with ids and owner questions. Tests — pure helpers in `weight-unit.ts` / `approve-outcome.ts` / `accuracy-repair.ts`, route tests for the 409, parity tests guarding the refactor, smoke on 3121 with throwaway data.
- **Decisions to flag for review:** (1) the 20× check is per-weight lines only, as asked — extending it to case lines is one condition in `decideLinePrice` and would also catch an OCR'd $4,319 case price; (2) `--with-box-refresh` is off by default because a non-primary box written from a weeks-old invoice is the riskiest write in the repair and only 2 boxes qualify; (3) the preflight runs the whole decision for every line in `POST` — cheap (pure, one offers query that already ran in `doApprove`).
- **Placeholders:** none; UI copy is given; the parity numbers are snapshotted from `main` in Task 2 Step 2.
- **Type consistency:** `weightUnitFor`, `WeightUnit`, `assumedUnitNote`; `decideLinePrice`, `LineDecision`, `approveBlocks`, `BlockedLine`, `BlockReason`; `decisionForScanItem`; `buildApproveNote`; `unitFactorBetween`, `planUnitless`, `planBlocked`, `planSplitCreateNew` — as named above.
