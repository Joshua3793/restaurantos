# Create-New Product Dimension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Creating a product from a by-weight invoice line yields a weight item (or a COUNT item with a required each-measure), never `COUNT / [{lb:1}] / RATE $/each`; the four items already mis-created are repaired with their receipts and counts re-frozen.

**Architecture:** A pure `seedFromScanLine(line)` reads the line's measure unit so `formToChain` derives MASS/VOLUME; the modal requires an each-measure when the chef flips to COUNT; approve writes the each-measure and refuses the bad shape via pure `validateCreateNew`. A read-only audit and a dry-run-first repair script rewrite a named item to a weight item and re-freeze its receipts (`lineReceived`) and count lines (`lineCountedBase`, the count reader's own resolution) with snapshot refresh.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma · vitest · Tailwind flat tokens.

Spec: `docs/superpowers/specs/2026-09-22-create-new-product-dimension-design.md`.

## Global Constraints

- **`formToChain` is not changed.** The fix is what the modal (and approve's legacy fallback) FEED it. A per-case line seeds exactly as today, field for field.
- A line is **by weight** iff `pricingMode === 'per_weight'` or `lineMeasureUnit(line) !== null`; its measure unit is the first of `rateUOM`, `totalQtyUOM`, `rawUnit` whose `canonicalUom` is in `UNIT_FACTORS` with `dim !== 'count'`. Tokens are canonicalised (`LB`, `LBS` → `lb`); container tokens (`CS`, `case`, `each`, `PC`) are never measure units.
- By-weight seed, verbatim: `{ priceType: 'UOM', purchaseUnit: <measure>, qtyUOM: <measure>, packUOM: <measure>, qtyPerPurchaseUnit: 1, packSize: 1, innerQty: null, purchasePrice: Number(rate ?? rawUnitPrice ?? newPrice ?? 0), countUOM: <measure> }` → `formToChain` gives `dimension` MASS/VOLUME, `pricing { mode: 'RATE', rate, rateUnit: <measure> }`, `packChain [{ unit: <measure>, per: conv }]`, `countUnit <measure>`.
- UI copy, verbatim: `Billed by weight ({rate}/{unit})` · `Bought by weight but counted as units — how much does one weigh?` · Save disabled until `eachMeasureQty > 0` in that case. Approve error, verbatim: `Bought by weight but the product is counted as units — add how much one weighs, or make it a weight item.`
- `newItemData` gains `eachMeasureQty: number | null`, `eachMeasureUnit: string | null`; approve writes them on `inventoryItem.create`. Approve's existing writes for non-`CREATE_NEW` lines are untouched.
- Repair: only named items (`--item <id>`); rewrite `{ dimension, baseUnit: g|ml, packChain: [{ unit: <measure>, per: conv }], pricing: { mode: 'RATE', rate: <unchanged number>, rateUnit: <measure> }, countUnit: <measure> }`; receipts re-frozen through `lineReceived(lineQtyOf(line), corrected)` (clones by `cloneShare`); count lines re-frozen through `lineCountedBase({ ...line, countedQtyBase: null }, corrected)` — never a re-implemented unit resolution; snapshots' `qtyOnHand`/`unit`/`totalValue` refreshed (`pricePerBaseUnit` recomputed from the corrected item). Dry run by default; `--apply` backs up before the first write and refuses when a row changed since planning. Unknown flags refused.
- The four known targets and expected outcomes (must appear in the dry run): Potatoes Kennebec O/S receipt 200 → 90,718.4 g, count 0 stays 0; TRSM Sour Tuscan Salami receipt 3.74 → 1,696.4 g, counts 0 / 3.135 lb → 1,422.0 g / 3.135 "each" → see note; Fennel O/S receipt 12 → 5,443.1 g; Kohlrabi Green chain `[{lb:1}]` → `[{lb:453.592}]`, count 10 lb → 4,535.9 g, receipts unchanged (already grams). Note: Salami's third count was entered as `3.135 each` after the item was COUNT — the corrected item has no `each` level, so `lineCountedBase` resolves it through `resolveUnitBase`; the dry run must show what it becomes and the controller decides (likely: treat as lb like the count before it, via an explicit `--count-unit-override`, or leave).
- No migration. No live-DB write by any subagent; the controller runs the audit (read-only) and the repair dry run; `--apply` only after the user reviews.
- Prisma `Decimal` → `Number()`; Prisma singleton; no `$executeRaw`; Tailwind flat tokens; sub-components at module scope; `'use client'` files import only types from server modules.
- vitest does NOT type-check: every task runs `npx tsc --noEmit -p tsconfig.json` (0) and `npx eslint` on changed files (no NEW findings vs HEAD via `git show HEAD:path`; never `git stash`). No dev server, no `npm run build` by subagents.
- `export PATH="$HOME/Desktop/node-install/bin:$PATH"`. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: `create-new-seed.ts` — the seed and the validator

**Files:**
- Create: `src/lib/invoice/create-new-seed.ts`
- Test: `src/lib/__tests__/create-new-seed.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SeedLine { pricingMode?: string | null; rateUOM?: string | null; totalQtyUOM?: string | null; rawUnit?: string | null; rate?: unknown; rawUnitPrice?: unknown; newPrice?: unknown; invoicePackQty?: unknown; invoicePackSize?: unknown; invoicePackUOM?: string | null }
  export function lineMeasureUnit(line: SeedLine): string | null
  export function isByWeightLine(line: SeedLine): boolean
  export function seedFromScanLine(line: SeedLine): ItemFormInput
  export function validateCreateNew(a: { line: SeedLine; dimension: string; eachMeasureQty: unknown }): { ok: true } | { ok: false; error: string }
  export const CREATE_NEW_COUNT_NEEDS_EACH = 'Bought by weight but the product is counted as units — add how much one weighs, or make it a weight item.'
  ```

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { lineMeasureUnit, isByWeightLine, seedFromScanLine, validateCreateNew, CREATE_NEW_COUNT_NEEDS_EACH } from '@/lib/invoice/create-new-seed'
import { formToChain } from '@/lib/item-model-form'

// The four real lines (read-only dump 2026-09-22)
const kennebec = { pricingMode: 'per_weight', rawUnit: 'lb', totalQtyUOM: 'lb', rateUOM: 'lb', rate: '1.99', rawUnitPrice: '1.99', invoicePackQty: null, invoicePackSize: null, invoicePackUOM: null }
const salami   = { ...kennebec, rate: '22.08', rawUnitPrice: '22.08' }
const fennel   = { ...kennebec, rate: '5.49', rawUnitPrice: '5.49' }
const kohlrabi = { ...kennebec, rate: '3.99', rawUnitPrice: '3.99' }
const sysco    = { pricingMode: 'per_case', rawUnit: 'CS', totalQtyUOM: null, rateUOM: null, rate: null, rawUnitPrice: '70.30', invoicePackQty: '1', invoicePackSize: '24', invoicePackUOM: 'each' }

describe('lineMeasureUnit', () => {
  it('takes rateUOM, then totalQtyUOM, then rawUnit; canonicalises; ignores containers', () => {
    expect(lineMeasureUnit({ rateUOM: 'LB', totalQtyUOM: 'kg', rawUnit: 'CS' })).toBe('lb')
    expect(lineMeasureUnit({ rateUOM: null, totalQtyUOM: 'KG', rawUnit: 'lb' })).toBe('kg')
    expect(lineMeasureUnit({ rateUOM: 'CS', totalQtyUOM: null, rawUnit: 'LBS' })).toBe('lb')
    expect(lineMeasureUnit({ rateUOM: 'each', totalQtyUOM: 'PC', rawUnit: 'case' })).toBeNull()
    expect(lineMeasureUnit({})).toBeNull()
  })
})

describe('isByWeightLine', () => {
  it('per_weight or any measure unit', () => {
    expect(isByWeightLine(kennebec)).toBe(true)
    expect(isByWeightLine({ pricingMode: 'per_case', rawUnit: 'kg' })).toBe(true)
    expect(isByWeightLine(sysco)).toBe(false)
  })
})

describe('seedFromScanLine', () => {
  it.each([['kennebec', kennebec, 1.99], ['salami', salami, 22.08], ['fennel', fennel, 5.49], ['kohlrabi', kohlrabi, 3.99]])(
    '%s → a weight item priced per lb, chain 1 lb = 453.592 g, counted in lb', (_n, line, rate) => {
      const seed = seedFromScanLine(line)
      expect(seed).toEqual({ priceType: 'UOM', purchaseUnit: 'lb', qtyUOM: 'lb', packUOM: 'lb', qtyPerPurchaseUnit: 1, packSize: 1, innerQty: null, purchasePrice: rate, countUOM: 'lb' })
      const chain = formToChain(seed)
      expect(chain.dimension).toBe('MASS'); expect(chain.baseUnit).toBe('g')
      expect(chain.pricing).toEqual({ mode: 'RATE', rate, rateUnit: 'lb' })
      expect(chain.packChain).toEqual([{ unit: 'lb', per: 453.592 }])
      expect(chain.countUnit).toBe('lb')
    })
  it('a per-case line seeds exactly as today', () => {
    expect(seedFromScanLine(sysco)).toEqual({ purchaseUnit: 'case', purchasePrice: 70.3, qtyPerPurchaseUnit: 1, qtyUOM: 'each', innerQty: null, packSize: 24, packUOM: 'each', priceType: 'CASE', countUOM: 'each' })
  })
})

describe('validateCreateNew', () => {
  it('COUNT from a by-weight line without an each-measure is refused with the exact sentence', () => {
    expect(validateCreateNew({ line: kennebec, dimension: 'COUNT', eachMeasureQty: null })).toEqual({ ok: false, error: CREATE_NEW_COUNT_NEEDS_EACH })
    expect(validateCreateNew({ line: kennebec, dimension: 'COUNT', eachMeasureQty: 0 }).ok).toBe(false)
  })
  it('COUNT with an each-measure, MASS from a by-weight line, and COUNT from a per-case line all pass', () => {
    expect(validateCreateNew({ line: kennebec, dimension: 'COUNT', eachMeasureQty: '200' })).toEqual({ ok: true })
    expect(validateCreateNew({ line: kennebec, dimension: 'MASS', eachMeasureQty: null })).toEqual({ ok: true })
    expect(validateCreateNew({ line: sysco, dimension: 'COUNT', eachMeasureQty: null })).toEqual({ ok: true })
  })
})
```

The per-case expectation must equal the CURRENT modal seed exactly: read `AddNewItemModal`'s `formToChain({...})` call (`InvoiceReviewDrawer.tsx` ~:1555-1565) and reproduce its field mapping (`purchaseUnit: canonicalUom(rawUnit) || 'case'`, `purchasePrice: Number(rate ?? rawUnitPrice ?? newPrice ?? 0)`, `qtyPerPurchaseUnit: Number(invoicePackQty) || 1`, `qtyUOM: 'each'`, `innerQty: null`, `packSize: Number(invoicePackSize) || 1`, `packUOM: invoicePackUOM ?? 'each'`, `priceType: pricingMode === 'per_weight' ? 'UOM' : 'CASE'`, `countUOM: 'each'`) — adjust the test literal to whatever those lines say, and say so in the report.

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// The seed for "Create new product" from an invoice line. A by-weight line
// (per_weight, or any weight/volume unit on it) must reach formToChain with its
// MEASURE unit, or the form derives COUNT and the item is born as
// `[{lb:1}] / RATE $/each` — the shape that broke Kennebec, Salami and Fennel.
import { canonicalUom, UNIT_FACTORS } from '@/lib/uom'
import type { ItemFormInput } from '@/lib/item-model-form'

export interface SeedLine { /* as in Interfaces */ }

const isMeasure = (u: string | null | undefined) => { if (!u) return false; const f = UNIT_FACTORS[canonicalUom(u)]; return !!f && f.dim !== 'count' }

export function lineMeasureUnit(line: SeedLine): string | null {
  for (const u of [line.rateUOM, line.totalQtyUOM, line.rawUnit]) if (isMeasure(u)) return canonicalUom(u!)
  return null
}
export function isByWeightLine(line: SeedLine): boolean {
  return line.pricingMode === 'per_weight' || lineMeasureUnit(line) !== null
}
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

export function seedFromScanLine(line: SeedLine): ItemFormInput {
  const price = num(line.rate ?? line.rawUnitPrice ?? line.newPrice ?? 0)
  const measure = isByWeightLine(line) ? lineMeasureUnit(line) : null
  if (measure) {
    return { priceType: 'UOM', purchaseUnit: measure, qtyUOM: measure, packUOM: measure, qtyPerPurchaseUnit: 1, packSize: 1, innerQty: null, purchasePrice: price, countUOM: measure }
  }
  // Per-case: exactly the seed the modal has always built.
  return {
    purchaseUnit: canonicalUom(line.rawUnit ?? '') || 'case', purchasePrice: price,
    qtyPerPurchaseUnit: Number(line.invoicePackQty) || 1, qtyUOM: 'each', innerQty: null,
    packSize: Number(line.invoicePackSize) || 1, packUOM: line.invoicePackUOM ?? 'each',
    priceType: line.pricingMode === 'per_weight' ? 'UOM' : 'CASE', countUOM: 'each',
  }
}

export const CREATE_NEW_COUNT_NEEDS_EACH = 'Bought by weight but the product is counted as units — add how much one weighs, or make it a weight item.'
export function validateCreateNew(a: { line: SeedLine; dimension: string; eachMeasureQty: unknown }): { ok: true } | { ok: false; error: string } {
  if (isByWeightLine(a.line) && String(a.dimension).toUpperCase() === 'COUNT' && !(num(a.eachMeasureQty) > 0)) return { ok: false, error: CREATE_NEW_COUNT_NEEDS_EACH }
  return { ok: true }
}
```

(A `per_weight` line with NO measure unit anywhere — e.g. an unparseable unit — has `measure === null` and falls to the per-case seed with `priceType: 'UOM'`, exactly as today; `validateCreateNew` still treats it as by-weight, so COUNT needs an each-measure. State this in a comment.)

- [ ] **Step 4: Run** → PASS; `tsc`; eslint.

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoice/create-new-seed.ts src/lib/__tests__/create-new-seed.test.ts
git commit -m "feat(invoices): a by-weight line seeds a new product as a weight item; COUNT needs an each-measure"
```

---

### Task 2: The modal

**Files:**
- Modify: `src/components/invoices/v2/InvoiceReviewDrawer.tsx` (`AddNewItemModal` ~:1518-1640: the `seed` useMemo, state, the dimension toggle area, the save payload, the Save button)

**Interfaces:**
- Consumes Task 1 (`seedFromScanLine`, `isByWeightLine`, `lineMeasureUnit`, `validateCreateNew` — pure, safe in a client file).
- Produces: `newItemData` JSON gains `eachMeasureQty: number | null`, `eachMeasureUnit: string | null`.

- [ ] **Step 1.** Replace the inline `formToChain({...})` seed with `formToChain(seedFromScanLine(item))`. Add state `eachMeasureQty: number | null` (null) and `eachMeasureUnit: string` (default `'g'`). Compute `byWeight = isByWeightLine(item)` and `measure = lineMeasureUnit(item)`.

- [ ] **Step 2.** Under `DimensionToggle`: when `byWeight`, `<p className="text-[11px] text-ink-4 mt-1">Billed by weight ({formatCurrency(seedRate)}/{measure})</p>` (rate from `seed.pricing` when RATE). When `byWeight && dimension === 'COUNT'`, render the each-measure input pair exactly like `InventoryItemDrawer`'s (number input + unit select with `g`/`ml` plus the stored unit if outside; module-scope sub-component `EachMeasureField`) with the caption `Bought by weight but counted as units — how much does one weigh?`.

- [ ] **Step 3.** `const gate = validateCreateNew({ line: item, dimension, eachMeasureQty })`; Save `disabled={saving || !gate.ok}`; show `gate.error` under the button in `text-[11px] text-red-text` when disabled for that reason. Save payload adds `eachMeasureQty`, `eachMeasureUnit` (null when dimension is not COUNT or qty not > 0).

- [ ] **Step 4.** When the chef flips COUNT → MASS/VOLUME, the existing toggle handler rewrites the chain/pricing for the new dimension — confirm that a by-weight line flipped BACK to a weight dimension gets `rateUnit: measure` (not `kg` default): if the existing handler picks `DIM_UNITS[d][0]`, prefer `measure` when it is in `DIM_UNITS[d]`.

- [ ] **Step 5.** `tsc`, eslint, `npm test`. Report a 4-step click-through (open Create on a per-lb line → MASS/$/lb prefilled + caption; flip to COUNT → each-measure field + Save disabled; fill 200 g → Save enabled; a Sysco per-case line → unchanged).

- [ ] **Step 6: Commit** — `feat(invoices): the create-new modal opens a by-weight line as a weight item and asks for an each-measure on COUNT`

---

### Task 3: Approve

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts` (CREATE_NEW block ~:850-925)
- Test: `src/lib/__tests__/create-new-seed.test.ts` (append a test for the legacy-fallback seed if it is extracted as a pure helper)

- [ ] **Step 1.** Before `inventoryItem.create`: `const gate = validateCreateNew({ line: scanItem, dimension: newChain.dimension, eachMeasureQty: newData.eachMeasureQty })`; on `!gate.ok` → `console.error(`[approve] Skipping "${scanItem.rawDescription}" — ${gate.error}`)`, `skippedLines++`, `continue` (the line stays un-approved and visible, as an uncostable rate does today).

- [ ] **Step 2.** Add to the `create` data: `eachMeasureQty: Number(newData.eachMeasureQty) > 0 ? Number(newData.eachMeasureQty) : null`, `eachMeasureUnit: Number(newData.eachMeasureQty) > 0 && newData.eachMeasureUnit ? canonicalUom(newData.eachMeasureUnit) : null`.

- [ ] **Step 3.** Legacy fallback branch (`formToChain({ … qtyUOM: 'each' … })`): replace with `formToChain({ ...seedFromScanLine(scanItem), ...(newData.purchaseUnit ? { purchaseUnit: newData.purchaseUnit } : {}), ...(newData.purchasePrice ? { purchasePrice: Number(newData.purchasePrice) } : {}), ...(newData.baseUnit ? { baseUnit: newData.baseUnit } : {}) })` — the line's measure unit wins for a by-weight line; the legacy fields still override price/purchase unit when present. Keep `deriveBaseUnit` import only if still used.

- [ ] **Step 4.** Everything else in the block (undo capture, receipt freeze through `asChainItem(created)`) unchanged. `tsc`, eslint, `npm test`. In the report: confirm no `data:` payload outside the CREATE_NEW block changed (diff vs HEAD).

- [ ] **Step 5: Commit** — `feat(invoices): approve writes the each-measure a new product was given and refuses a counted item bought by weight without one`

---

### Task 4: Audit + repair scripts

**Files:**
- Create: `src/lib/invoice/create-new-repair.ts` (pure planner); Test: `src/lib/__tests__/create-new-repair.test.ts`
- Create: `scripts/audit-create-new-shape.ts` (read-only), `scripts/repair-create-new-shape.ts`

**Interfaces:**
- Produces:
  ```ts
  export function isSelfContradictory(item: { dimension: string; baseUnit: string | null; packChain: unknown; pricing: unknown }): string[]   // reasons, [] when fine
  export function planItemRewrite(a: { item: ChainItemRow; measure: string }): { dimension: 'MASS' | 'VOLUME'; baseUnit: 'g' | 'ml'; packChain: PackLink[]; pricing: Pricing; countUnit: string }
  export function planReceiptRefreeze(lines: ReceiptLine[], corrected: ChainItem): Array<{ id: string; old: number | null; next: number; via: string }>
  export function planCountRefreeze(lines: CountLineRow[], corrected: ChainItem, ppb: number): Array<{ id: string; old: number | null; next: number; snapshot?: { id: string; qtyOnHand: number; unit: string; totalValue: number } }>
  ```

- [ ] **Step 1: Failing tests** — `isSelfContradictory` on the four real shapes (reasons `'COUNT with a measure-unit chain link'`, `'RATE per each'`, `'measure link per 1'`) and on a correct MASS item (`[]`); `planItemRewrite` for Kennebec (`{ MASS, g, [{lb:453.592}], RATE 1.99/lb, lb }`) and for a `kg` line (VOLUME for `l`/`ml` too); `planReceiptRefreeze` on the four lines → 90,718.4 / 1,696.4 / 5,443.1 / unchanged for Kohlrabi; `planCountRefreeze` for Salami's `3.135 lb` → 1,422.0 g with `totalValue = 1422.0 × ppb`, `0 each` → 0; Kohlrabi `10 lb` → 4,535.9 g; and a count entered in `each` on an item with no `each` level → whatever `lineCountedBase` resolves (assert the number and mark it `needsDecision: true` when the selected UOM's dimension ≠ the corrected item's and there is no bridge).

- [ ] **Step 2: Implement** the planner using `lineReceived`/`lineQtyOf` (`src/lib/invoice/line-qty.ts`), `cloneShare` (`refreeze.ts`), `lineCountedBase` (`src/lib/count-uom.ts`, called with `countedQtyBase: null` so the frozen value is ignored), `pricePerBaseUnit`/`asChainItem` (`item-model.ts`), `UNIT_FACTORS` for `conv`.

- [ ] **Step 3: Scripts** modelled on `scripts/repair-weight-priced-offers.ts` (flag parsing that refuses unknown flags; `--item <id>` repeatable; `--count-unit-override <lineId>=<unit>` for the "counted in each" decision; dry run prints per item: rewrite before → after, each receipt old → next (via), each count line old → next with its snapshot; `--apply` writes `create-new-repair-backup-<stamp>.json` `{ items, lines, countLines, snapshots }` BEFORE the first write, re-reads each row and refuses when changed, updates `InventoryItem`, `InvoiceScanItem.receivedQtyBase`, `CountLine.countedQtyBase`, `InventorySnapshot.{qtyOnHand,unit,pricePerBaseUnit,totalValue}`; ORM only). The audit script lists every active item with `isSelfContradictory(...).length > 0` plus counts of recipes/count lines/receipts, writes `create-new-shape-audit-<stamp>.json`. **The implementer never runs either.**

- [ ] **Step 4.** `tsc` (scripts included the way sibling scripts are type-checked), eslint, `npm test`. **Commit** — `chore(scripts): audit and repair products created with the wrong dimension, dry-run first`

- [ ] **Step 5 (controller):** run the audit (read-only; expect exactly the four), then the repair dry run for the four; decide Salami's `3.135 each` count (recommend `--count-unit-override <id>=lb`); hand the diff to the user; `--apply` on their OK.

---

### Task 5: Docs and build

**Files:**
- Modify: `CLAUDE.md` (invoice-processing list: add to step 1/2 area or the "Line-first receiving" paragraph), the spec (`Status`, "As built")

- [ ] **Step 1: CLAUDE.md**, appended to the invoice-processing section:

```markdown
**Creating a product from a line** (`AddNewItemModal` → `newItemData` → approve `CREATE_NEW`): the form is seeded by `seedFromScanLine` (`src/lib/invoice/create-new-seed.ts`) — a by-weight line (per_weight, or a weight/volume unit on the rate, billed or shipped quantity) seeds the line's MEASURE unit, so `formToChain` derives MASS/VOLUME, `RATE $/lb`, chain `[{lb: 453.592}]`; a per-case line seeds as before. Flipping to COUNT requires an each-measure (the #135 model) — `validateCreateNew` gates Save in the modal AND the approve route (a failing line stays un-approved). Approve writes `eachMeasureQty/Unit` from `newItemData`. `scripts/audit-create-new-shape.ts` lists items born with the contradictory shape; `scripts/repair-create-new-shape.ts --item <id>` (dry-run first) rewrites one and re-freezes its receipts (`lineReceived`) and counts (`lineCountedBase`).
```

- [ ] **Step 2: Spec** → implemented; "As built" with deviations + a placeholder `_Repair: (controller fills in after the run)_`.
- [ ] **Step 3 (controller):** isolated `npm run build` (sandbox off for fonts); fill the repair line after the apply.
- [ ] **Step 4: Commit** — `docs: a product created from a by-weight line is a weight item`

---

## Self-Review Notes

- **Spec coverage:** §1 seed/modal → Tasks 1–2 · §2 approve guard + each-measure write + legacy fallback → Task 3 · §3 audit/repair with receipts, counts, snapshots → Task 4 · §4 tests/rollout → each task + Task 5.
- **Type consistency:** `SeedLine` accepts the `ScanItem` client type and the Prisma row (all optional/nullable); `validateCreateNew` takes `{ line, dimension, eachMeasureQty }` in both the modal (Task 2) and approve (Task 3); the planner's `ChainItemRow` is `Parameters<typeof asChainItem>[0]`.
- **Known decision left to the controller:** Salami's `3.135 each` count line (entered while the item was COUNT). The dry run shows it; the override flag exists.
