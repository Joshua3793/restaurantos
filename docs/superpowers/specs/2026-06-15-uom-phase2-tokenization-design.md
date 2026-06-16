# UOM Phase-2: Tokenize purchaseUnit / countUOM / selectedUom — Design

**Date:** 2026-06-15
**Status:** Approved (design), pending implementation plan
**Builds on:** the Phase-1 backbone hardening (`UNIT_FACTORS` + `CONTAINER_UNITS` + `isKnownUnit`/`assertKnownUnit`, commit ce63048).

## Problem

`InventoryItem.purchaseUnit`, `InventoryItem.countUOM`, and `CountLine.selectedUom` store **free-text display
strings** — `"case (6×2.84 l)"`, `"5 kg"`, `"454 g"` — not tokens. These were left as the documented Phase-2
follow-up: Phase-1 made the system numerically safe (0 unknown in conversion columns; the count fallbacks
resolve all 119 items with 0 collapse), but the safety rests on fragile string-matching in `count-uom.ts`
(`convertCountQtyToBase` matches `selectedUom` against the `purchaseUnit` display string).

`InventoryItem` already has the **authoritative structured pack** (`qtyPerPurchaseUnit`, `innerQty`, `packSize`,
`packUOM`), so the display string is **redundant — and sometimes stale**: e.g. *coconut milk* stores
`purchaseUnit="case (6×2.84 l)"` while its columns say `12 × 400 ml` (they disagree).

## Goal

Make every unit column store a **canonical token**; derive all display strings from the token + the structured
columns; replace the string-matching in the count flow with exact token-matching. This is a **representation
change, not a math change** — counted→base quantities must be identical before and after.

## Decisions (locked with the user)

- **Approach A** — full tokenization in one spec (purchaseUnit + countUOM + selectedUom together).
- **Reuse existing columns** — `qtyPerPurchaseUnit`/`innerQty`/`packSize`/`packUOM` stay authoritative; no new
  columns, no schema change. Display is always derived.
- **Bare-weight packs → `each`** — a purchase with no container word (`"5 kg"`, `"454 g"`; `packSize=5, packUOM=kg`)
  becomes token `each`; the weight stays in `packSize`/`packUOM`; display derives back to `5 kg`.
- Numbers come only from the structured columns; strings are always derived.

## Architecture

### 1. Derive-display helper — `src/lib/count-uom.ts`

`formatPurchaseDisplay(item)` — given the token (`purchaseUnit`) + `qtyPerPurchaseUnit`/`innerQty`/`packSize`/
`packUOM`, render the human string (`case (12×400 ml)`, `5 kg`, `each`). Consolidates today's
`buildPurchaseDescription` and the `display` logic inside `getCountableUoms`.

`getCountableUoms(item)` returns `{ token, display, toBase, hint }` (today's `label` becomes the clean `token`).
`toBase` (base units per 1 of the token) is unchanged — it already derives from the structured columns.

### 2. Write paths store tokens

`purchaseUnit` is set to a canonical token — a container (`case`/`carton`/`tin`/`bag`/`pack`/`box`/`jug`/`sleeve`/
`tray`/`clamshell`/`flat`) or `each` — never a composed string. The pack numbers go in the existing columns.
- `src/components/inventory/InventoryItemDrawer.tsx`: the unit picker emits a token; `normalizePurchaseUnit`
  becomes "→ canonical token".
- `src/app/api/inventory/route.ts` + `[id]/route.ts`: `assertKnownUnit(purchaseUnit, 'purchaseUnit')` (now a token).
- `src/app/api/invoices/sessions/[id]/approve/route.ts` `CREATE_NEW`, and `applyInvoiceFormat`
  (`src/lib/invoice-format.ts`): store the token.

### 3. Count flow matches tokens — `src/lib/count-uom.ts`

`convertCountQtyToBase` / `resolveCountUom` already compare `selectedUom` against `item.purchaseUnit`; both are
now tokens, so the comparison is exact-token. The display-string-specific branches (the `isWV`/`fmtWV` string
formatting used to BUILD labels) move into `formatPurchaseDisplay`; the conversion keeps resolving through the
same `toBase` math. `selectedUom`/`countUOM` store tokens.

### 4. Display sweep

Every site rendering `purchaseUnit`/a composed pack string routes through `formatPurchaseDisplay(item)`:
`src/app/inventory/page.tsx`, `src/components/inventory/InventoryItemDrawer.tsx`,
`src/components/inventory/QuickCountSheet.tsx`, `src/app/count/page.tsx`,
`src/components/invoices/v2/card.tsx`, `src/components/invoices/v2/InvoiceReviewDrawer.tsx`, and the server
`formatPackSummary` (`src/lib/invoice/formatters.ts`). The plan enumerates exact lines via grep; the helper is
the single source so a missed site is visibly a bare token.

### 5. Migration — `scripts/tokenize-uom-strings.ts` (idempotent)

Structured columns are already correct; only the unit strings are rewritten. Run in this ORDER:
1. `InventoryItem.purchaseUnit`: `canonicalUom(leadingWord(value))` → if it lands in `CONTAINER_UNITS`, use that
   container token; else `each` (bare-weight/measurement). Leave qty/packSize/packUOM untouched (authoritative).
   Stale displays (coconut milk) self-correct because display now re-derives from the numbers.
2. `InventoryItem.countUOM` + `CountLine.selectedUom`: derive a token by **parsing the stored string itself**
   (not by display-equality against `getCountableUoms`, which would miss stale displays): if the value already
   canonicalizes to a known measurement/container token → use it; else if it equals (or its leading word
   canonicalizes to) the item's now-tokenized `purchaseUnit` → use that token; else `each`/`baseUnit`.
   (Historical lines — token affects display only; recorded `stockOnHand` is already in baseUnit.)
- Reports unparseable values; safe to re-run.

## Verification

- Extended `scripts/audit-uom-backbone.ts`: `purchaseUnit`/`countUOM`/`selectedUom` move from "exempt" to
  "guarded" — assert **0 display-strings** (all measurement/container tokens).
- Count-conversion regression: for every active item, `convertCountQtyToBase(1, resolveCountUom(item), item)`
  still equals the pack content (re-run the Phase-1 "0 collapse" check — no number may move).
- `npm run build` clean; preview spot-check that inventory/count render `case (12×400 ml)`, not bare `case`.

## Out of scope

- The numeric columns (`qtyPerPurchaseUnit`/`packSize`/`packUOM`/`innerQty`) — unchanged and authoritative.
- Any schema change.
- Invoice OCR unit fields (`rawUnit`/`totalQtyUOM`/…) — already handled in Phase-1 (flag-on-read + pack fallback).

## Expected outcome

Every unit column holds a canonical token; all pack displays derive from the structured columns (no drift); the
`count-uom.ts` matching is exact-token instead of free-string; and the audit shows 0 display-strings anywhere a
unit is stored. No counted→base quantity changes.
