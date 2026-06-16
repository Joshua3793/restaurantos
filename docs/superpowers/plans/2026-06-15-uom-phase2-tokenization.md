# UOM Phase-2 Tokenization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store canonical unit tokens in `purchaseUnit` / `countUOM` / `selectedUom`, derive every pack-display string from the authoritative structured columns, and make the count flow match exact tokens — with no change to any counted→base quantity.

**Architecture:** One `formatPurchaseDisplay(item)` helper becomes the single source for pack-display strings (`case (12×400 ml)`, `5 kg`, `each`), fed only by `qtyPerPurchaseUnit`/`innerQty`/`packSize`/`packUOM`. Render sites call it instead of the raw `purchaseUnit`. A migration rewrites the stored unit strings to tokens. `getCountableUoms` emits token labels; `convertCountQtyToBase` already matches `selectedUom` against `purchaseUnit`, so once both are tokens that match is exact.

**Tech Stack:** Next.js 14, TypeScript, Prisma/Postgres, ts-node verification scripts. No unit-test framework — gates are `npm run build` + ts-node scripts.

**Spec:** `docs/superpowers/specs/2026-06-15-uom-phase2-tokenization-design.md`

---

## Conventions (every task)

`node`/`npm` aren't on PATH. Prefix Node commands:
```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"
```
**Build:** `… && npm run build` (use `dangerouslyDisableSandbox: true`; pipe to a log, grep `Compiled successfully` / `Type error`). Stop the preview before building.
**Run a `@/`-importing script:**
```bash
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && \
TS_NODE_BASEURL=./ TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS","baseUrl":"./","paths":{"@/*":["./src/*"]}}' \
node --env-file=.env -r ts-node/register -r tsconfig-paths/register scripts/<file>.ts
```
(`dangerouslyDisableSandbox: true`; live DB; redirect to a log on ENOSPC.)

---

## File Structure

- `src/lib/count-uom.ts` — add `formatPurchaseDisplay`; refactor `getCountableUoms` first-option display + token label (Task 1). Token-matching cleanup (Task 5).
- 6 render sites + `src/lib/invoice/formatters.ts` — call `formatPurchaseDisplay` (Task 2).
- `scripts/tokenize-uom-strings.ts` — migration (Task 3).
- inventory API + `InventoryItemDrawer.tsx` + invoice approve/`invoice-format.ts` — token writes + guard (Task 4).
- `scripts/audit-uom-backbone.ts`, `scripts/verify-count-conversion.ts` — verification (Tasks 3 & 5).

---

## Task 1: `formatPurchaseDisplay` helper + token-aware `getCountableUoms`

**Files:**
- Modify: `src/lib/count-uom.ts`
- Create: `scripts/verify-format-purchase-display.ts`

- [ ] **Step 1: Write the verification script**

Create `scripts/verify-format-purchase-display.ts`:
```ts
import { prisma } from '../src/lib/prisma'
import { formatPurchaseDisplay } from '../src/lib/count-uom'
let fail = 0
const check = (n: string, c: boolean, d = '') => { console.log(`${c?'✓':'✗'} ${n}${d?' — '+d:''}`); if(!c) fail++ }
async function main() {
  // coconut milk: structured cols 12×400 ml — display must derive from numbers, not the stale string.
  const coco = await prisma.inventoryItem.findFirst({ where: { itemName: { contains: 'coconut milk', mode: 'insensitive' } } })
  if (coco) {
    const d = formatPurchaseDisplay({ purchaseUnit: coco.purchaseUnit, qtyPerPurchaseUnit: Number(coco.qtyPerPurchaseUnit), innerQty: coco.innerQty != null ? Number(coco.innerQty) : null, packSize: Number(coco.packSize), packUOM: coco.packUOM, qtyUOM: coco.qtyUOM, baseUnit: coco.baseUnit })
    check('coconut milk display derives from structured cols (12×400 ml, not stale 6×2.84 l)', /12.*400.*ml/.test(d) || /4\.8.*l/.test(d), `got "${d}"`)
  } else check('coconut milk fixture', false)
  await prisma.$disconnect(); process.exit(fail ? 1 : 0)
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
```

- [ ] **Step 2: Run it — expect FAIL** (`formatPurchaseDisplay` not exported yet). Run the script command from Conventions.

- [ ] **Step 3: Add `formatPurchaseDisplay` and refactor `getCountableUoms`**

In `src/lib/count-uom.ts`, add the import `canonicalUom`, `CONTAINER_UNITS` from `./uom` (alongside the existing `convertQty` import), then add this exported function ABOVE `getCountableUoms`:

```ts
/**
 * Human-readable pack display derived ONLY from the structured columns (never a stored
 * string). The leading word of purchaseUnit gives the container token; the numbers come
 * from qtyPerPurchaseUnit/innerQty/packSize/packUOM. Used everywhere a pack label is shown.
 */
export function formatPurchaseDisplay(item: ItemDims): string {
  const token = canonicalUom((item.purchaseUnit ?? '').trim().split(/[\s(]/)[0])
  const isContainerTok = CONTAINER_UNITS.has(token)
  const qtyUOM = item.qtyUOM ?? 'each'
  const qty = Number(item.qtyPerPurchaseUnit)
  const ps = Number(item.packSize ?? 0)
  const pu = item.packUOM ?? 'each'
  const innerQty = item.innerQty != null ? Number(item.innerQty) : null
  const fmtWV = (val: number, unit: string) => {
    const x = (unit || '').toLowerCase()
    const n = Number.isInteger(val) ? val.toString() : parseFloat(val.toFixed(2)).toString()
    return `${n}${x === 'l' || x === 'lt' ? 'L' : x}`
  }
  // Build the "(…)" pack detail from the numbers.
  let detail = ''
  if (qtyUOM === 'pack' && innerQty && innerQty > 0) detail = `${fmtNum(qty)} pkg`
  else if (isMeasuredUnit(qtyUOM) && qty > 1) detail = fmtWV(qty, qtyUOM)
  else if (isMeasuredUnit(pu) && ps > 0) detail = qty > 1 ? `${fmtNum(qty)} × ${fmtWV(ps, pu)}` : fmtWV(ps, pu)
  else if ((pu ?? 'each').toLowerCase() === 'each' && ps > 1) detail = `${fmtNum(qty > 1 ? qty * ps : ps)} each`

  if (isContainerTok) return detail ? `${token} (${detail})` : token   // "case (12×400 ml)"
  // Bare-weight / each: show the weight if there is one, else the token.
  if (detail && !isContainerTok) return detail                          // "5 kg", "454 g"
  return token || 'each'
}
```

Then in `getCountableUoms`, change the first option so its `label` is the **token** and its `display` uses the helper. Replace the existing first `uoms.push({ label: item.purchaseUnit, … })` block (the one with `display: isContainer ? \`case (${caseFmt})\` : item.purchaseUnit`) with:

```ts
  uoms.push({
    label: canonicalUom((item.purchaseUnit ?? 'each').trim().split(/[\s(]/)[0]) || 'each',
    toBase: purchaseToBase,
    hint: buildCaseHint(item),
    display: formatPurchaseDisplay(item),
  })
```

(The `isContainer`/`caseFmt`/`fmtWV` locals above that block become unused for the first option — leave the remaining options as-is; if `caseFmt`/`isContainer` become entirely unused, delete them to satisfy the build.)

- [ ] **Step 4: Build** — `✓ Compiled successfully`.

- [ ] **Step 5: Run the verification script — expect PASS** (coconut milk display derives `12×400 ml`).

- [ ] **Step 6: Commit**
```bash
git add src/lib/count-uom.ts scripts/verify-format-purchase-display.ts
git commit -m "feat(uom): formatPurchaseDisplay derives pack display from structured cols

Single helper renders 'case (12×400 ml)' / '5 kg' / 'each' from the authoritative
qtyPerPurchaseUnit/packSize/packUOM (not the stored, sometimes-stale string), using the
real container token (fixes the 'always shows case' display bug). getCountableUoms now
emits a token label + derived display.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Display sweep — render sites use `formatPurchaseDisplay`

**Files (confirm exact lines with grep first):**
- Modify: `src/app/inventory/page.tsx`, `src/components/inventory/InventoryItemDrawer.tsx`, `src/components/inventory/QuickCountSheet.tsx`, `src/app/count/page.tsx`, `src/components/invoices/v2/card.tsx`, `src/components/invoices/v2/InvoiceReviewDrawer.tsx`, `src/lib/invoice/formatters.ts`

- [ ] **Step 1: Find every raw render of `purchaseUnit` / composed pack string**
```bash
grep -rn "\.purchaseUnit\b" src/app/inventory/page.tsx src/components/inventory/InventoryItemDrawer.tsx src/components/inventory/QuickCountSheet.tsx src/app/count/page.tsx src/components/invoices/v2/card.tsx src/components/invoices/v2/InvoiceReviewDrawer.tsx | grep -v "purchaseUnit:" | grep -v "purchaseUnit =" 
grep -n "buildPurchaseDescription\|formatPackSummary" src/lib/invoice/formatters.ts
```
List each JSX/string site that DISPLAYS the unit (vs. passes it as data to an API/dims object — those keep the raw token).

- [ ] **Step 2: Route each display site through the helper**

For each site that renders the unit for humans, import `formatPurchaseDisplay` from `@/lib/count-uom` and replace `item.purchaseUnit` (or the local composed string) with `formatPurchaseDisplay(item)` — where `item` is the inventory item (or a `{purchaseUnit, qtyPerPurchaseUnit, innerQty, packSize, packUOM, qtyUOM, baseUnit}` subset already in scope). Do NOT change sites that pass `purchaseUnit` as DATA (into `dims`, API bodies, `getCountableUoms` input) — those must stay the token. If `formatPackSummary` builds the pack string, have it delegate to `formatPurchaseDisplay`.

- [ ] **Step 3: Build** — `✓ Compiled successfully`.

- [ ] **Step 4: Preview spot-check**

`preview_start` "RestaurantOS (Next.js)"; open `/inventory`; `preview_snapshot` and confirm an item like coconut milk shows `case (12×400 ml)` (a derived string), not a bare `case`. `preview_stop`.

- [ ] **Step 5: Commit**
```bash
git add -A src/app src/components src/lib/invoice/formatters.ts
git commit -m "refactor(uom): render pack displays via formatPurchaseDisplay

All inventory/count/invoice sites that show a pack unit now derive the display from the
structured columns instead of the raw purchaseUnit string. Data-passing sites keep the token.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Migration — tokenize the stored strings

**Files:**
- Create: `scripts/tokenize-uom-strings.ts`
- Modify: `scripts/audit-uom-backbone.ts` (move the 3 columns to "guarded")

- [ ] **Step 1: Write the migration**

Create `scripts/tokenize-uom-strings.ts`:
```ts
/** Idempotent: rewrite purchaseUnit/countUOM/selectedUom display strings to canonical tokens.
 * Structured columns (qty/packSize/packUOM/innerQty) are authoritative and untouched. */
import { prisma } from '../src/lib/prisma'
import { canonicalUom, CONTAINER_UNITS, isKnownUnit } from '../src/lib/uom'

const tokenOf = (raw: string | null, fallbackBase?: string): string => {
  const v = (raw ?? '').trim()
  if (!v) return 'each'
  if (isKnownUnit(v)) return canonicalUom(v)               // already a token (measurement/container)
  const lead = canonicalUom(v.split(/[\s(]/)[0])            // leading word, e.g. "case (6×2.84 l)" → "case"
  if (CONTAINER_UNITS.has(lead)) return lead
  return fallbackBase ?? 'each'                             // bare-weight / unparseable → each
}

async function main() {
  // 1) purchaseUnit
  const items = await prisma.inventoryItem.findMany({ select: { id: true, purchaseUnit: true } })
  let p = 0
  for (const it of items) { const t = tokenOf(it.purchaseUnit); if (t !== it.purchaseUnit) { await prisma.inventoryItem.update({ where: { id: it.id }, data: { purchaseUnit: t } }); p++ } }
  console.log(`purchaseUnit: ${p} tokenized`)

  // 2) countUOM (token; fall back to item's purchaseUnit token, then baseUnit)
  const items2 = await prisma.inventoryItem.findMany({ select: { id: true, countUOM: true, purchaseUnit: true, baseUnit: true } })
  let c = 0
  for (const it of items2) {
    const t = tokenOf(it.countUOM, isKnownUnit(it.countUOM) ? undefined : (tokenOf(it.purchaseUnit) || it.baseUnit))
    if (t !== it.countUOM) { await prisma.inventoryItem.update({ where: { id: it.id }, data: { countUOM: t } }); c++ }
  }
  console.log(`countUOM: ${c} tokenized`)

  // 3) CountLine.selectedUom (join to item for the fallback token)
  const lines = await prisma.countLine.findMany({ select: { id: true, selectedUom: true, inventoryItem: { select: { purchaseUnit: true, baseUnit: true } } } })
  let s = 0
  for (const l of lines) {
    const fb = l.inventoryItem ? (tokenOf(l.inventoryItem.purchaseUnit) || l.inventoryItem.baseUnit) : 'each'
    const t = tokenOf(l.selectedUom, isKnownUnit(l.selectedUom) ? undefined : fb)
    if (t !== l.selectedUom) { await prisma.countLine.update({ where: { id: l.id }, data: { selectedUom: t } }); s++ }
  }
  console.log(`selectedUom: ${s} tokenized`)
  console.log('Done (idempotent).')
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
```

- [ ] **Step 2: Run it.** Report the counts. Re-run once to confirm it reports `0 / 0 / 0` (idempotent).

- [ ] **Step 3: Make `audit-uom-backbone.ts` assert these columns are now tokens**

In `scripts/audit-uom-backbone.ts`, change the three `audit(...)` calls for `InventoryItem.countUOM`, `InventoryItem.purchaseUnit`, and `CountLine.selectedUom` to pass `feedsConversion = true` (so they appear in the "must be 0 unknown" summary). Re-run the audit and confirm the SUMMARY shows **no UNKNOWN** for `purchaseUnit`/`countUOM`/`selectedUom` (only `InvoiceScanItem.totalQtyUOM: 325g` remains, the OCR case).

- [ ] **Step 4: Commit**
```bash
git add scripts/tokenize-uom-strings.ts scripts/audit-uom-backbone.ts
git commit -m "chore(uom): tokenize stored purchaseUnit/countUOM/selectedUom on the live DB

Rewrites display strings to canonical tokens (container word or 'each'); structured
columns untouched. Idempotent. Audit now guards these three columns (0 unknown).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Token write paths + guard `purchaseUnit`

**Files:**
- Modify: `src/app/api/inventory/route.ts`, `src/app/api/inventory/[id]/route.ts`, `src/components/inventory/InventoryItemDrawer.tsx`, `src/app/api/invoices/sessions/[id]/approve/route.ts`, `src/lib/invoice-format.ts`

- [ ] **Step 1: Guard `purchaseUnit` on the inventory API**

In `src/app/api/inventory/route.ts` (POST) and `src/app/api/inventory/[id]/route.ts` (PUT), where `purchaseUnit` is read from the body (`rest.purchaseUnit ?? 'each'`), wrap it with `assertKnownUnit` (already imported) and store the returned token:
```ts
let purchaseUnitTok: string
try { purchaseUnitTok = assertKnownUnit(rest.purchaseUnit ?? 'each', 'purchaseUnit') }
catch (e) { if (e instanceof UnitError) return NextResponse.json({ error: e.message }, { status: 400 }); throw e }
```
and use `purchaseUnit: purchaseUnitTok` in the create/update `data` (replace `rest.purchaseUnit ?? 'each'`). Ensure `...rest` no longer also sets `purchaseUnit` (destructure it out of `rest` if needed).

- [ ] **Step 2: Drawer emits a token**

In `src/components/inventory/InventoryItemDrawer.tsx`, change `normalizePurchaseUnit(...)` to return `canonicalUom(leadingWord(value))` (import `canonicalUom` from `@/lib/utils`), so the form's stored/sent `purchaseUnit` is a token. The pack numbers already go in the qty/packSize/packUOM fields. Confirm the unit picker's options are tokens (container set + `each`).

- [ ] **Step 3: Invoice paths emit tokens**

In `src/app/api/invoices/sessions/[id]/approve/route.ts` `CREATE_NEW` (`purchaseUnit: newData.purchaseUnit || scanItem.rawUnit || 'each'`), wrap with `canonicalUom(leadingWord(...))` → token. In `src/lib/invoice-format.ts` `applyInvoiceFormat`, when it sets `purchaseUnit`, store a token (canonicalize the leading word).

- [ ] **Step 4: Build** — `✓ Compiled successfully`.

- [ ] **Step 5: Verify a bad purchaseUnit is rejected**

With the preview running, `preview_eval`:
```js
fetch('/api/inventory', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ itemName:'t', purchaseUnit:'tray-ish', qtyPerPurchaseUnit:1, packSize:1, packUOM:'kg' })}).then(r=>r.status)
```
Expected: `400`.

- [ ] **Step 6: Commit**
```bash
git add src/app/api/inventory src/components/inventory/InventoryItemDrawer.tsx "src/app/api/invoices/sessions/[id]/approve/route.ts" src/lib/invoice-format.ts
git commit -m "feat(uom): write purchaseUnit as a canonical token + guard it

Inventory API, the item drawer, invoice CREATE_NEW, and applyInvoiceFormat all store a
canonical purchaseUnit token; the inventory API rejects an unknown unit (400).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Count-flow token matching cleanup + final verification

**Files:**
- Modify: `src/lib/count-uom.ts` (`convertCountQtyToBase`, `resolveCountUom`)
- Create: `scripts/verify-count-conversion.ts`

- [ ] **Step 1: Write the count-conversion regression (the "no number moves" gate)**

Create `scripts/verify-count-conversion.ts`:
```ts
/** Every active item: 1 of its resolved count unit must still expand to the pack content
 * (no measured item collapses to ~1 base unit). Guards that tokenization didn't move a number. */
import { prisma } from '../src/lib/prisma'
import { convertCountQtyToBase, resolveCountUom } from '../src/lib/count-uom'
import { getUnitConv } from '../src/lib/utils'
let collapse = 0
async function main() {
  const items = await prisma.inventoryItem.findMany({ where: { isActive: true },
    select: { itemName: true, baseUnit: true, purchaseUnit: true, qtyPerPurchaseUnit: true, qtyUOM: true, innerQty: true, packSize: true, packUOM: true, countUOM: true } })
  for (const it of items) {
    const dims = { baseUnit: it.baseUnit, purchaseUnit: it.purchaseUnit, qtyPerPurchaseUnit: Number(it.qtyPerPurchaseUnit), qtyUOM: it.qtyUOM, innerQty: it.innerQty != null ? Number(it.innerQty) : null, packSize: Number(it.packSize), packUOM: it.packUOM, countUOM: it.countUOM }
    const base1 = convertCountQtyToBase(1, resolveCountUom(dims), dims)
    const packContent = Number(it.packSize) * getUnitConv(it.packUOM) * Number(it.qtyPerPurchaseUnit)
    if ((it.baseUnit === 'g' || it.baseUnit === 'ml') && base1 <= 1.0001 && packContent > 5) { collapse++; console.log(`  ⚠ ${it.itemName}: 1 ${resolveCountUom(dims)} = ${base1} ${it.baseUnit} (pack ${packContent})`) }
  }
  console.log(collapse === 0 ? '✓ 0 collapse — conversions intact' : `✗ ${collapse} collapsed`)
  await prisma.$disconnect(); process.exit(collapse === 0 ? 0 : 1)
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
```

- [ ] **Step 2: Run it BEFORE the cleanup — expect PASS (0 collapse)** (it already passes; this records the baseline the cleanup must preserve).

- [ ] **Step 3: Simplify `convertCountQtyToBase` / `resolveCountUom` to token comparison**

In `src/lib/count-uom.ts`, both functions compare `selectedUom`/`countUOM` against `item.purchaseUnit`. Now that all three are tokens, ensure the comparisons use canonical tokens on both sides (wrap each side in `canonicalUom(...)` where a raw `.toLowerCase()` compare is done), and remove any branch that only existed to handle a display-string purchaseUnit (e.g. parsing `(…)` out of it). Keep the pack-math (`itemBaseUnits`, `packBaseUnits`, the purchaseUnit/pack/each branches) exactly. Do NOT change the numeric results.

- [ ] **Step 4: Build** — `✓ Compiled successfully`.

- [ ] **Step 5: Run the regression AFTER — expect PASS (still 0 collapse).** If any item now collapses, the cleanup changed a number — revert Step 3 and narrow it.

- [ ] **Step 6: Final audit** — run `scripts/audit-uom-backbone.ts`; confirm `purchaseUnit`/`countUOM`/`selectedUom` are 0-unknown and contain only tokens.

- [ ] **Step 7: Commit**
```bash
git add src/lib/count-uom.ts scripts/verify-count-conversion.ts
git commit -m "refactor(uom): count flow matches canonical tokens

convertCountQtyToBase/resolveCountUom compare canonical tokens on both sides; dropped the
display-string handling now that purchaseUnit/selectedUom are tokens. Regression confirms
0 collapse — no counted→base quantity changed.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `npm run build` clean.
- [ ] `scripts/audit-uom-backbone.ts`: `purchaseUnit`/`countUOM`/`selectedUom` 0-unknown, tokens only.
- [ ] `scripts/verify-count-conversion.ts`: 0 collapse.
- [ ] Preview: `/inventory` + `/count` show derived pack displays (`case (12×400 ml)`), not bare tokens.
- [ ] Push the branch.
