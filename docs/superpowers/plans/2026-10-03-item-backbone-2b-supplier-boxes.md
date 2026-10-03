# Item backbone — Stage 2b: supplier boxes can be added, edited and removed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manager can add a supplier box to any item, change a box's pack format, price and product code, and remove a box — from the item drawer — and the item follows its main (primary) box (R4). This closes the gap left by Stage 1d (176 box-less items could only get a supplier through an invoice) and lets the invoice review screen's "use the invoice's format" fix the right box.

**Architecture:** Three new routes under `/api/inventory/[id]/suppliers`: `POST` (add), `PATCH /[offerId]` (edit), `DELETE /[offerId]` (remove); one shared pure validator `validateBox(item, box)` (the box's chain and pricing are validated against the ITEM's dimension, base unit and bridges with `validateChainItem(…, { requirePositivePrice: item.isStocked })`); the existing `setPrimaryOffer`/`syncPrimaryOfferToItem`/`ensurePrimary` keep the item equal to its primary box; every box write carries `expectedLastUpdated` (the box's own `lastUpdated` for edit/remove, the item's for add). The drawer's `SupplierOffersSection` gains an "Add supplier box" form and per-box Edit/Remove, reusing `PackChainEditor` + `PricingEditor`. `AdoptFormatModal` writes the invoice supplier's box when the item has boxes.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma, vitest, `npm run build`.

**Spec:** `docs/superpowers/specs/2026-10-03-item-backbone-design.md` §3 R4 (and R5 on boxes). Stage 2a (`feat/safe-edit-rules`) must be merged first.

## Global Constraints

- Branch off `origin/main` after 2a merges. Worktree `.claude/worktrees/supplier-boxes`, branch `worktree-supplier-boxes`, pushed as `feat/supplier-boxes`. One PR, squash-merged. **No migration, no live-data writes.**
- `node`/`npm` are not on the sandbox PATH: prefix every command with `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" &&` (Bash `dangerouslyDisableSandbox: true`). `node_modules`/`.env` symlinked. After `EnterWorktree`, `git fetch origin && git reset --hard origin/main`.
- Invariant (from `src/lib/primary-offer.ts`): an item with ≥1 box has exactly one primary, and the item's `packChain`/`pricing` EQUAL the primary box's. Every route here that touches the primary (add-as-primary, edit primary, remove primary) ends by `syncPrimaryOfferToItem` + `propagatePrepCostChanges([itemId])`.
- Uniqueness: `(inventoryItemId, supplierId, COALESCE(supplierItemCode,''))` — a duplicate → 409 `DUPLICATE_BOX` ("This supplier already has a box for this product. Edit that box instead."). Codes: `STALE` 409, `DUPLICATE_BOX` 409, `ZERO_PRICE` 400, `INVALID` 400, `PREP_OWNED` 409 (a recipe-made item has no boxes: "A recipe-made item has no supplier boxes."), `BAD_FIELD` 400, `NOT_FOUND` 404. Plain-English sentences.
- `lastPrice` is still NOT NULL (until Stage 1e): every box CREATE fills `lastPrice: offerListedPrice({ pricing })`; EDIT also writes it (so the column never lags while it exists); nothing reads it.
- Role gates: all three routes MANAGER+. Prisma `Decimal` → `Number()`.
- Tests: `npm test` green; `npm run build` green; lint identical to `main`.

---

### Task 1: `validateBox` + the box routes

**Files:**
- Create: `src/lib/box-rules.ts`
- Modify: `src/app/api/inventory/[id]/suppliers/route.ts` (add `POST`)
- Create: `src/app/api/inventory/[id]/suppliers/[offerId]/route.ts` (`PATCH`, `DELETE`)
- Tests: `src/lib/__tests__/box-rules.test.ts`, `src/app/api/inventory/__tests__/box-routes.test.ts`

**Interfaces:**
```ts
// src/lib/box-rules.ts (pure)
export interface BoxInput { supplierId: string; supplierItemCode?: string | null; packChain: PackLink[]; pricing: Pricing }
export function validateBox(item: ChainRowLike /* dimension, baseUnit, bridges, isStocked */, box: BoxInput): string[]  // [] when valid; uses validateChainItem on { ...itemFacts, packChain: box.packChain, pricing: box.pricing }, requirePositivePrice: item.isStocked
export function normalizeCode(code: string | null | undefined): string | null  // trim+upper via normItemCode; '' → null
```
Routes:
- `POST /api/inventory/[id]/suppliers` body `{ supplierId, supplierItemCode?, packChain, pricing, makePrimary?: boolean, expectedLastUpdated /* item's */ }` → creates the box (`supplierName` = Supplier.name; `isPrimary` = `makePrimary` or the item had no box; `lastInvoiceSessionId: null`; `packQty/packSize/packUOM: null`), then if it is primary `syncPrimaryOfferToItem` + propagate; returns `getSupplierOffers(id)`.
- `PATCH /api/inventory/[id]/suppliers/[offerId]` body `{ packChain?, pricing?, supplierItemCode?, expectedLastUpdated /* box's */ }` → validates the merged box; writes; if the box is primary → sync + propagate; returns the offers.
- `DELETE /api/inventory/[id]/suppliers/[offerId]` body `{ expectedLastUpdated /* box's */ }` → deletes; if it was primary → `ensurePrimary` promotes the most recently updated remaining box and `syncPrimaryOfferToItem` + propagate; if it was the last box, the item keeps its chain/pricing (now editable again via `/pricing`); returns the offers.

- [ ] **Step 1: Failing tests** — `box-rules.test.ts`: a $0 PACK box on a stocked `g` item → `['price must be above $0']`; a `$/lb` RATE box on an `each` item with no each-measure → the rateIsCostable error; the same with `eachMeasureQty 453.6 g` → `[]`; `normalizeCode(' abc ')` → `'ABC'`, `''`/`null` → `null`. `box-routes.test.ts` (mock prisma: `inventoryItem.findUnique`, `supplier.findUnique`, `inventorySupplierPrice.{findFirst,findMany,create,update,delete,count,updateMany}`, mock `@/lib/supplier-offers` `getSupplierOffers`, mock `@/lib/recipeCosts` propagate, mock `@/lib/primary-offer` `syncPrimaryOfferToItem`/`ensurePrimary` as spies): POST on a box-less item creates a PRIMARY box and calls sync; POST with `makePrimary: false` on an item with a primary creates a non-primary and does NOT call sync; POST duplicate (findFirst finds one) → 409 `DUPLICATE_BOX`; POST on a recipe-made item → 409 `PREP_OWNED`; PATCH stale → 409 `STALE`; PATCH primary's pricing → update + sync + propagate; DELETE non-primary → delete, no sync; DELETE primary with another box left → `ensurePrimary` + sync; LEAD → 403 on all three.
- [ ] **Step 2: Implement** per the interfaces (reuse the try/catch role-gate shape; `tombstonedRows` check; `expectedLastUpdated` compared with `getTime()`; `updateMany` with `lastUpdated` in the `where` for the edit to close the race).
- [ ] **Step 3: `npm test`, build, lint; commit** `feat(offers): supplier boxes can be added, edited and removed; the item follows its main box`.

---

### Task 2: The drawer — add / edit / remove boxes

**Files:**
- Modify: `src/components/inventory/SupplierOffersSection.tsx` (add form + per-row Edit/Remove; `canEdit` prop = MANAGER+; re-fetch after each write; show server error sentences; `onRepriced` after any primary change)
- Modify: `src/components/inventory/InventoryItemDrawer.tsx` (render the section even when the item has no boxes — with the "Add supplier box" button — and pass `canEdit`; after a box change, `refreshItem()` so `offerCount`/price refresh and the price editors hide/show correctly)
- Reuse: `PackChainEditor`, `PricingEditor`, `DimensionToggle` NOT shown (the box takes the item's dimension), supplier `Combobox` (the drawer's local copy — move it to `src/components/inventory/Combobox.tsx` and import it in both places)

UI (plain words everywhere): section header "Supplier boxes · n"; each row keeps ★ main, supplier, pack, code, $/base, label; MANAGER+ sees "Edit" (inline form: pack chain editor, pricing editor, product code, Save/Cancel) and "Remove" (confirm: "Remove Sysco's box for Goats Cheese? Recipes keep costing from the main box." — if it IS the main box and others exist: "…the next most recent box becomes main."; if it is the only box: "…the item keeps its current price until a new box or invoice sets one."). "+ Add supplier box" opens the same form with a supplier picker and a "Make this the main box" checkbox (checked and locked when the item has no boxes).

- [ ] **Step 1: Pure helper + test** — `src/lib/box-copy.ts` `removeBoxMessage({ supplierName, itemName, isPrimary, otherBoxes })` with the three sentences above; test the three branches.
- [ ] **Step 2: Build the UI**; `npm run build`; lint.
- [ ] **Step 3: Commit** `feat(inventory): add, edit and remove supplier boxes from the item drawer`.

---

### Task 3: "Use the invoice's format" fixes the right box

**Files:**
- Modify: `src/components/invoices/v2/AdoptFormatModal.tsx`: when the item has boxes (`item.offerCount > 0`), PATCH the INVOICE SUPPLIER's box (`session.supplierId` — pass it in as a prop from `InvoiceReviewDrawer.tsx` ~1607) via `PATCH /api/inventory/[id]/suppliers/[offerId]` (find the box id from `GET /api/inventory/[id]/suppliers` by `supplierId` + the line's `supplierItemCode`, same rule as `pickOffer`); if that supplier has no box yet, POST one (`makePrimary: false`) built from the line; when the item has NO boxes, keep today's `/pricing` PATCH. Copy: "This updates Sysco's box for Goats Cheese (and the item's price, since it is the main box)." / "(the item keeps its main box's price)". The cross-measure refusal stays (Stage 2c).
- Test: `src/lib/__tests__/adopt-target.test.ts` for a pure `adoptTarget({ offers, supplierId, itemCode })` → `{ kind: 'box', offerId } | { kind: 'new-box' } | { kind: 'item' }`.
- [ ] Commit `feat(invoices): adopting an invoice's format updates that supplier's box`.

---

### Task 4: Smoke, PR, merge

- [ ] Preview from the worktree (port 3117): on Croissant Plain (box-less) add a Snow Cap box at $2.70 → it becomes main, the item's price follows; edit the box to $2.80 → item follows; add a second supplier's box (not main) → item unchanged; remove the main box → the other becomes main; remove the last box → price editors reappear. (These ARE live writes on a real item — use a test item instead: create "ZZ Test Item" via the add form first, exercise, then deactivate it and note its id in the PR; or run the whole sequence on the preview against a dry item.) Open an invoice in review with a pack conflict and confirm the adopt modal names the box.
- [ ] Push `feat/supplier-boxes`, PR with Before/After ("Before: a new item only got a supplier from its first invoice. After: add a supplier box in the drawer; the item takes the main box's price."), merge after the final review passes.

## Self-review
- **Spec coverage:** R4 fully (add/edit/remove + item follows primary); R5 on boxes via `requirePositivePrice`; R8 on boxes via `expectedLastUpdated`. The remeasure flow (R3 guided fix) is Stage 2c.
- **Placeholders:** none beyond the UI copy, which is given.
- **Type consistency:** `validateBox`, `normalizeCode`, `removeBoxMessage`, `adoptTarget` as named; routes as listed.
