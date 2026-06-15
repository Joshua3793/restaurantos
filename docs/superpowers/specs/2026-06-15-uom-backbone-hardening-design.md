# UOM Backbone Hardening — Design

**Date:** 2026-06-15
**Status:** Implemented (2026-06-15). `plate`/`bowl` were also added to `UNIT_FACTORS` (count, 1) so the
guard accepts MENU yield units. Data cleanup ran on the live DB (87 countUOM + others normalized).
**Scope:** Perimeter hardening only (full tokenization of `selectedUom`/`purchaseUnit` is a documented Phase-2 follow-up).

## Problem

The app has a canonical UOM backbone (`UNIT_FACTORS` in `src/lib/uom.ts`) of **measurement** units
with fixed conversion factors. But the *perimeter isn't enforced*: a value that `canonicalUom()`
can't resolve into the backbone silently becomes factor **1** in `getUnitConv`/`convertQty` — i.e. it
defaults to "each", risking large miscalculations.

An audit of every unit-bearing column (`scripts/audit-uom-backbone.ts`) found:
- **Core costing columns are clean** (`baseUnit`, `packUOM`, `RecipeIngredient.unit`, `yieldUnit`, … all resolve).
- `countUOM`/`CountLine.selectedUom` store container words and display strings (`pkg`, `case`, `CS`, `box`,
  `"case (6×2.84 l)"`, `"5 kg"`) — but `convertCountQtyToBase` resolves all 119 non-backbone items
  correctly (**0 collapse to each**) via pack-matching. No active miscalc; fragile.
- `InventoryItem.purchaseUnit` is free-text display labels (130 distinct) — the source of the above.
- **Invoice OCR fields** (`rawUnit`, `totalQtyUOM`, `qtyOrderedUOM`) carry supplier abbreviations the
  backbone doesn't know (`CS`, `PK`, `clamshell`, `flat`, `tray`, malformed `325g`). One UOM-priced line
  ("Beef Digital", billed `CS`) was actively miscounting — **already fixed** (commit 3efaa72:
  `buildPurchaseMap` routes container-billed UOM lines through the pack structure).

**Root issue:** the backbone models *measurement* units but not *container* units, and nothing validates
inputs against it, so the "silent default to each" failure mode is one code change away.

## Goal

Make it structurally impossible for an unrecognized unit to silently become "each":
1. Model container units explicitly (they convert via pack, never a factor).
2. Reject unknown units on controlled writes (forms/import); flag them on uncontrolled ingest (OCR).
3. Normalize existing stored token values so the data matches the enforced model.

## Decisions (locked with the user)

- **Perimeter hardening**, not full tokenization. Keep `selectedUom`/`purchaseUnit` as free-text labels.
- **Hybrid enforcement:** hard-reject (400) unknown units on user-facing writes; flag (not block) on invoice OCR ingest.
- **Approach A:** all unit knowledge + the guard live in `src/lib/uom.ts` (single source of truth).
- Container conversion is **always pack-derived** (`1 container = qtyPerPurchaseUnit × packSize × packUOM`,
  or `1 each` with no pack) — codifying what `calcConversionFactor`/`convertCountQtyToBase`/`buildPurchaseMap` already do.

## Architecture

### 1. Unit model — `src/lib/uom.ts`

- **`UNIT_FACTORS` (measurement, unchanged)** plus one addition: `dozen: { dim: 'count', toBase: 12 }`
  (a fixed multiplier, so it's measurement, not container — `1 dozen → 12 each`).
- **`CONTAINER_UNITS` (new)** — a `Set<string>` of canonical container tokens with NO fixed factor:
  `case, pack, box, bag, tray, jug, sleeve, pallet, clamshell, flat, carton, tin`.
- **Extended `canonicalUom` aliases:** `cs→case`, `pk→pack`, `pkg→pack`, `ctn→carton`, and each container
  word maps to itself.
- **New exported APIs (the entire enforcement surface):**
  ```ts
  export type UnitKind = 'measurement' | 'container' | 'unknown'
  export function unitKind(uom: string | null | undefined): UnitKind
  export function isKnownUnit(uom: string | null | undefined): boolean        // kind !== 'unknown'
  export class UnitError extends Error {}
  export function assertKnownUnit(uom: string | null | undefined, field?: string): string // returns canonical token, throws UnitError if unknown
  ```
  `unitKind` canonicalizes, then: in `UNIT_FACTORS` → `measurement`; in `CONTAINER_UNITS` → `container`;
  else `unknown`. `assertKnownUnit` returns the canonical token (so callers normalize + validate in one call).

**Conversion rule (codified, mostly already true):** measurement → factor (`convertQty`/`getUnitConv`);
container → pack structure; unknown → never silently 1 (callers must flag or reject).

### 2. Write-time guard (forms/import → 400)

API write-handlers canonicalize + `assertKnownUnit` before storing these **token columns** (all sourced
from constrained dropdowns / derivation, so a rejection means a real bug):
- `InventoryItem`: `baseUnit`, `packUOM`, `qtyUOM`
  — `src/app/api/inventory/route.ts` (POST), `src/app/api/inventory/[id]/route.ts` (PUT)
- `RecipeIngredient.unit`, `Recipe.yieldUnit`, `Recipe.portionUnit` — the recipe write routes
- `src/lib/inventory-import.ts` (CSV) — the mapped units

On `UnitError`, the route returns `NextResponse.json({ error }, { status: 400 })` with a clear message
(`Unrecognized unit 'tray' for packUOM`). Store the returned canonical token (normalizes `KG→kg`, `CS→case`).

**Exempt from the hard-reject guard** (resolved by `convertCountQtyToBase` / pack-matching, never fed to
`getUnitConv` directly; audit: 0 collapse):
- `InventoryItem.countUOM` — `resolveCountUom` can legitimately set it to a `purchaseUnit` *display label*
  (e.g. `"5 kg"`), so it can't be hard-token-guarded without breaking valid edits. It is still **normalized**
  by the data-cleanup pass (token values → canonical; display labels left as-is). Hard-guarding it is Phase-2
  (after `resolveCountUom` is changed to return a token).
- `InventoryItem.purchaseUnit`, `CountLine.selectedUom` — free-text display labels by design.

### 3. Invoice OCR flag (on-read, no schema change)

- New predicate `hasUnknownUom(scanItem)` in `src/lib/invoice/predicates.ts`: `!isKnownUnit` on any of
  the line's billed/pack units (`rawUnit`, `totalQtyUOM`, `invoicePackUOM`).
- The v2 review drawer surfaces a **"needs UOM review"** badge on flagged lines (alongside existing issue badges).
- Approval is **not** blocked. `buildPurchaseMap` already falls back to the pack structure for
  container/unknown billed units (no silent ×1). The badge nudges correction for exactness.

### 4. Data cleanup (one idempotent script)

`scripts/canonicalize-uom-columns.ts`: for the token columns (`baseUnit`, `packUOM`, `qtyUOM`, `countUOM`),
rewrite each stored value to `canonicalUom(value)` where it differs and the result is known
(`pkg→pack`, `CS→case`, `KG→kg`, `L→l`, …). Skip values that are already canonical or genuinely unknown
(report those). Leaves `selectedUom`/`purchaseUnit` untouched. Run once; idempotent.

## Verification

- Extend `scripts/audit-uom-backbone.ts`: assert **0 unknown** across the guarded columns
  (`baseUnit`, `packUOM`, `qtyUOM`, `RecipeIngredient.unit`, `yieldUnit`, `portionUnit`) post-migration;
  `countUOM` (post-normalization), `selectedUom`, `purchaseUnit` reported separately as may-contain-display-labels.
- API/unit checks (script, since no test framework): `unitKind('g')='measurement'`, `unitKind('CS')='container'`,
  `unitKind('325g')='unknown'`, `assertKnownUnit('dozen')` → returns `'dozen'`, `convertQty(1,'dozen','each')=12`;
  `POST /api/inventory` with `packUOM:'tray'` → 400.
- `npm run build` clean.

## Out of scope (documented Phase-2 follow-up)

- Tokenizing `CountLine.selectedUom` / `InventoryItem.purchaseUnit` (store token + structured pack; derive display).
- Removing the `count-uom.ts` string-matching fallbacks.
- Any schema change. This hardening is code + one data-normalization pass only.

## Expected outcome

Controlled inputs can no longer persist a unit the backbone doesn't understand; uncontrolled (OCR) inputs are
visibly flagged while staying numerically safe by construction; and the "silent default to each" failure mode
is eliminated for every conversion column.
