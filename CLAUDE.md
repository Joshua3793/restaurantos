# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # dev server at http://localhost:3000
npm run build        # production build (also used to type-check)
npm run lint         # ESLint
npm run seed         # seed the database via prisma/seed.ts

# Database
npx prisma migrate dev --name <description>   # create + apply a migration
npx prisma migrate deploy                     # apply pending migrations (CI/prod)
npx prisma generate                           # regenerate client after schema changes
npx prisma studio                             # browse database in browser
```

`npm test` runs a vitest suite over the pure cost-math libs (`src/lib/__tests__/` — uom, item-model, recipeCosts). Run it after touching unit conversion, pack chains, or costing; it's fast (<1s). For everything else, `npm run build` is the correctness check — run it after any non-trivial change.

`npm install` triggers a postinstall (`prisma generate && node scripts/copy-pdf-worker.cjs`). If Prisma types look stale after a branch switch, run `npx prisma generate`.

## Working style

Process skills (brainstorming, TDD, plan-writing ceremonies) are for multi-file features and gnarly bugs. For small fixes, direct questions, and audits, work directly — no ceremony. Debugging discipline and verification-before-completion always apply: verify every claim against the tree before asserting it, and never document a file, export, or route without checking it exists.

## Architecture

**Fergie's OS** is a restaurant back-office platform: inventory, recipe costing, invoice scanning, prep, stock counts, sales (with nightly Toast POS sync), temps, end-of-day close, kitchen tip payouts, and reports.

Stack: Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Tailwind CSS · Lucide icons · Recharts.

### Page → API map

| Page (`src/app/`) | API prefix / notes |
|---|---|
| `/today` | mobile home — role-routes to `TodayManager`/`TodayChef` (`src/components/mobile/today/`); desktop bounces to `/pass` (manager) or `/count` (staff) |
| `/pass` (MANAGER+) | manager dashboard — aggregates `/api/insights/*`, `/api/reports/*`, `/api/prep/items`, `/api/invoices/alerts` |
| `/inventory` | `/api/inventory`, `/api/categories`, `/api/suppliers`, `/api/storage-areas` |
| `/invoices` | `/api/invoices/sessions` (multi-step upload → OCR → review → approve) |
| `/recipes` (PREP) | `/api/recipes?type=PREP` |
| `/menu` (MENU) | `/api/recipes?type=MENU` |
| `/prep` | `/api/prep/{items,logs,settings,cooks,sync-from-recipes}` + `/api/prep/plan{,/post,/recall,/reorder}` (Smart Prep v2 posting) |
| `/preshift` | briefing view over `/api/prep/items` |
| `/count` | `/api/count/sessions` |
| `/sales` | `/api/sales`, `/api/toast/*` |
| `/tips` (MANAGER+) | `/api/tips/{settings,roles,roster,periods}` — periods, punches, split, envelopes |
| `/reports` (MANAGER+) | `/api/reports/*` |
| `/variance` (MANAGER+) | `/api/insights/food-cost-variance` |
| `/signals` (MANAGER+) | `/api/signals` (+ `/refresh`) |
| `/end-of-day` (MANAGER+) | `/api/eod/*` (checklist, close, orders, handover, email, summary) |
| `/temps` | `/api/temps/units`, `/api/temps/readings` |
| `/wastage` | `/api/wastage` |
| `/setup/*` (ADMIN) | hub with 9 sub-pages: categories, storage-areas, suppliers, revenue-centers, users, uom, toast, eod-checklist, general |

### Key data flows

**Invoice processing** (multi-step workflow):
1. Upload files → `InvoiceSession` created (status: UPLOADING → PROCESSING)
2. `POST /api/invoices/sessions/[id]/process` — sends images to Claude OCR (`src/lib/invoice-ocr.ts`), stores raw results as `InvoiceScanItem` rows
3. Fuzzy matcher (`src/lib/invoice-matcher.ts`) correlates each scan item to an `InventoryItem`; learned rules cached in `InvoiceMatchRule`
4. User reviews matches in UI (status: REVIEW)
5. `POST /api/invoices/sessions/[id]/approve` — marks each `InvoiceScanItem` approved (the scan item + its `InvoiceSession` ARE the purchase record; the legacy `InvoiceLineItem` table is no longer written), **freezes the line's received base quantity in `InvoiceScanItem.receivedQtyBase`**, upserts the supplier's `InventorySupplierPrice` offer with that supplier's OWN pack, and — when the line's supplier is the item's primary offer, or the item has no offers — updates the item's `pricing`; fires `PriceAlert` / `RecipeAlert` and re-costs impacted PREP recipes
6. `DELETE /api/invoices/sessions/[id]` (and the bulk route) **rolls back what the approval wrote**: approve records one `InvoiceApproveUndo { prev, next }` per row it touches (offer, item spine, primary flag, learned match rule, created item — `src/lib/invoice/approve-undo.ts`, first touch wins), and delete restores `prev` only while the row still deep-equals `next` through the same canonical selector (`planRollback` in `src/lib/invoice/rollback.ts`) — so a value a later invoice or a manual edit changed is left alone (`skipped: 'changed-since'`). One transaction per session; RC copies refuse delete (409) and are deleted with their parent; restored items are re-costed after commit; `GET …/delete-plan` previews the plan for the confirm dialog. Sessions approved before 2026-09-22 have no records and get the labelled best-effort `revertedPricing` path — exactly today's `UPDATE_PRICE`-only rule, never `ADD_SUPPLIER`: an `ADD_SUPPLIER` line is assigned precisely when it did NOT re-price the item (a non-primary supplier's line never wrote the spine), and its `previousPrice` is that supplier's own last price, not the spine's — reverting it would plant the wrong number, or (`Number(null) === 0`) zero the item outright. Never revert from `InvoiceScanItem.previousPrice` for a recorded session.

**Recipe costing** (`src/lib/recipeCosts.ts`):
- `fetchRecipeWithCost(id)` — fetches recipe + resolves linked-recipe costs
- `computeRecipeCost(recipe)` — maps each ingredient: `lineCost = convertQty(qtyBase, unit, ingredientBaseUnit) × pricePerBaseUnit` (computed — see spine)
- `syncPrepToInventory(recipeId)` — after any PREP recipe change, writes the computed cost back to the linked `InventoryItem` (canonical SI base unit + `{batch → base}` packChain) so it can be used as an ingredient in other recipes
- Returns `totalCost`, `costPerPortion`, `foodCostPct`, and per-ingredient `lineCost` + `ingredientBaseUnit`

**Unit of measure**:
- `src/lib/uom.ts` — `UNIT_FACTORS` is the ONE canonical unit→base conversion table; `convertQty()` canonicalizes units; `UOM_GROUPS` for dropdowns. Used everywhere.
- `src/lib/item-model.ts` — the pricing/pack model (see spine below).
- `src/lib/utils.ts` — legacy client-side helpers (`UNIT_CONV` derived from uom.ts, `calcPricePerBaseUnit`, `deriveBaseUnit`) — still used by the inventory page form. Server-side, `formToChain()` in `src/lib/item-model-form.ts` reproduces `calcPricePerBaseUnit` exactly and is the canonical form→chain path.

**One item, many suppliers** ([src/lib/invoice/line-format.ts](src/lib/invoice/line-format.ts)): an item's own `packChain` is only its PRIMARY supplier's pack. Every invoice line is received and priced through `resolveLineFormat(item, pickOffer(offers, { supplierId, supplierName, canonicalName }))` — a pack printed on the line wins (inside `lineReceivedBaseUnits`), then that supplier's offer chain, then the item chain. Never hand `asChainItem(item)` straight to `lineReceivedBaseUnits` for an invoice line, and always build the supplier ref with all three fields so client, approve route and stock reader pick the same offer. An offer priced more than `IMPLAUSIBLE_PRICE_RATIO` (20×) off the item's own $/base is treated as corrupt: its chain is still used, its pricing is not. `InvoiceScanItem.receivedQtyBase` is the frozen receipt (a quantity, like `CountLine.countedQtyBase` — not a cached cost): approve computes it through the pricing mode the line RESOLVED to (`freezeFormat` in [src/lib/invoice/approve-format.ts](src/lib/invoice/approve-format.ts)), RC clone rows carry their scaled share, and readers prefer it, computing live only when it is null. Approve's pack-disagreement guard compares against **the same supplier's** previous pack (`packReference`), never another supplier's.

**Line-first receiving:** `lineReceived(line, chainItem)` in [src/lib/invoice/line-qty.ts](src/lib/invoice/line-qty.ts) is THE receiving rule and returns its provenance (`via`, `needsBridge`); `lineReceivedBaseUnits` is just `.base`. Order: frozen → a billed weight **proven by the line's own money** (`billedWeightIsPriced`) → the RATE branch (billed, then shipped) → a shipped quantity whose own unit is a weight/volume → printed pack → the resolved chain. The item's/offer's pricing mode never overrides a weight the invoice states. The proof is the scanner's contract ([src/lib/invoice-ocr.ts](src/lib/invoice-ocr.ts)): on a per-weight line `rate` is READ OFF THE PAGE while `unitPrice` is DERIVED as lineTotal ÷ qtyShipped — so a printed `rate × billed weight = line total` is proof on its own, and "unitPrice × cases = total" is a tautology that proves nothing (it only disqualifies when there is NO rate). Never trust a billed-weight column without that check: per-case lines carry a stray one (Butter "2.86 kg" on 2 × 25 × 454 g). The SCANNER and the matcher must never derive `rate` from the total — that would make the proof circular. The one derived rate is a human's explicit action in the review's mismatch panel (`onRevertPrice` in [composites.tsx](src/components/invoices/v2/composites.tsx) writes `rate = total ÷ weight`; `onAcceptComputed` writes `total = rate × weight`), which counts as confirmation: a person looked at a visibly mismatched per-weight line and asserted its weight and total. Known gap: toggling a line to per-case leaves `rate`/`totalQty` on it, and `lineReceived` ignores `pricingMode`, so a mis-scanned case line a reviewer flips to per-case still receives by weight. Anything that builds a `LineQtyInput` must pass `rawUnitPrice`/`rate`/`rateUOM`/`rawLineTotal`; anything that builds a `MatchedItemLike` on the client must use `matchedLikeOf` (it carries the item's each-measure/density); the RC-split target and its validator both read `liveLineOf(item)` (never the frozen value) — otherwise review, approve and theoretical stock disagree about one line and the split is silently dropped. A hand-linked line must re-read its item from the server (`linkExistingItem` awaits the PATCH, drops the staged partial, refreshes). RC clone rows are never run through the rule: clone = parent × (clone total ÷ parent total). History is re-frozen with `scripts/backfill-received-qty-base.ts --refreeze` (dry run first; evidence in `docs/audits/2026-09-20-line-first-receiving/`). **Pricing follows receiving** (`pricingBasisFor` in approve-format.ts): approve prices a line by weight exactly when `lineReceived` received it by weight, so quantity × price = line total; a per-case line whose pack merely prints a weight (Brioche `8 × 1100 g`) is received via `printed-pack` and stays on the CASE path. On the weight path the rate is `weightBasisRate`: the printed rate only when its `rateUOM` is the measure unit it is stored per, else line total ÷ received weight; a rate printed per a container with no total is refused (line skipped). `packIsTheQuantity` keeps the supplier's existing offer chain only when the rate crosses the item's dimension. Session DELETE reverts through `revertedPricing` ([src/lib/invoice/revert-pricing.ts](src/lib/invoice/revert-pricing.ts)) — `previousPrice` is the offer's last price in the OFFER's denomination, so after a PACK→cross-dimension-RATE approve the helper decides which reading it is (a `PriceAlert` proves it; no alert ⇒ the move was < 15 %). Known gaps: offers are never rolled back on DELETE, and DELETE reverts items a non-primary line never re-priced.

**Item merge** ([src/lib/item-merge.ts](src/lib/item-merge.ts) pure planner → [src/lib/item-merge-exec.ts](src/lib/item-merge-exec.ts) executor; `POST /api/inventory/[id]/merge`, `POST /api/inventory/merges/[id]/undo`, UI in `MergeItemSheet`): a duplicate row folds into a survivor. The absorbed row becomes a tombstone (`mergedIntoId`, `isActive=false`, `stockOnHand` 0), every row pointing at it is re-pointed, its supplier offers/SKUs move across, and the `ItemMerge.manifest` replays in reverse for undo. **v1 merges same-base-unit items only** (`DIFFERENT_BASE_UNIT`); it also refuses PREP-owned items, items on an open count, and a merge that would silently re-cost a recipe line through a different each-measure/density (`BRIDGE_MISMATCH`). Invariants: the manifest is the COMPLETE record of a merge's writes (the executor never calls `ensurePrimary`); a merge never deletes or changes the survivor's primary offer, and promotes an incoming offer only when the survivor has none; legacy count lines are frozen through the ABSORBED item with the count reader's own resolver (`lineCountedBase`) — never re-implement unit resolution in the planner; planning happens inside the transaction that applies it, followed by a sweep that no row still references the absorbed id. The one un-manifested write is the optional combined-on-hand Quick Count, which also makes the merge un-undoable. **Any new table with an `inventoryItemId` FK MUST be added to the planner's re-point list and the executor's table maps**, or a merge strands its rows on the tombstone. Worklist: `scripts/audit-duplicate-items.ts`.

### The spine — `pricePerBaseUnit` (computed, not stored)

`pricePerBaseUnit` is still the **single value every cost in the app traces back to** — but it is **no longer a stored column**. `InventoryItem` stores `packChain` (Json array of `{unit, per}` links collapsing the purchase format into a canonical base unit) and `pricing` (Json: price + mode); the $/base-unit value derives from them at read time. [src/lib/item-model.ts](src/lib/item-model.ts) is the source of truth:

- `pricePerBaseUnit(item)` derives $/base from chain + pricing; `lineCost(item, qty, unit)` computes ingredient cost; `basePerUnit`, `stockValue`, `conversionFactor` build on the same chain.
- A `RATE` may be quoted in ANOTHER dimension than the item when the ITEM carries the bridge: `$3.49/lb` on an item counted in `each` prices as `$/g × g per each` through `eachMeasure`; MASS↔VOLUME crosses through `densityGPerMl`; with no bridge it is **0 — unpriced**, never `rate ÷ conv` (`ratePerBase` / `rateIsCostable` in item-model.ts). The supplier's real price is what is stored; `$/each` is derived at read time, so it follows the each-measure when a human corrects it — never store the derived number. Offers are priced WITH their item: `offerPricePerBase(offer, item)` (pure, in `src/lib/offer-price.ts`; its `OfferItem` makes the three bridge fields required so a select that forgets `PRICING_SELECT` fails to compile). Any hand-built `ChainItem` must carry `eachMeasure`/`densityGPerMl` or a bridged rate reads $0. The inventory edit form cannot express `$/lb` on an each-item, so `keepBridgedRate` (item-model-form.ts) keeps the stored pricing unless the user actually changed the price.
- **Recipe and menu costs are on the 30-day weighted average** (`src/lib/cost-basis.ts`: `windowedAvgCost` = Σ `rawLineTotal` ÷ Σ frozen `receivedQtyBase` over approved, non-split lines from all suppliers, purchases dated within the 30 days before now — the start day counted whole (`COST_WINDOW_DAYS`; `costWindow` floors the lower bound to UTC midnight because `purchaseDate` is a UTC-midnight calendar date, so the window spans up to 31 calendar days and a day is never half-counted); a line counts only when both are > 0; > 20× off the last price ⇒ ignored). Derived at read, never stored. Only `GET /api/recipes`, `/api/recipes/[id]`, `/[id]/scale`, `search-ingredients` and `GET /api/inventory/[id]` (which exposes the item drawer's `costBasis`) ask for it (the recipe routes via `fetchRecipeWithCost(id, { basis: 'AVG_30D' })`, which recurses into nested preps memoised per request); every other caller defaults to `'LAST'` and is unchanged — `syncPrepToInventory` still writes the LAST-price cost to a prep's linked item, so valuation, counts, COGS, theoretical usage and alerts never see the average. Each ingredient line carries `costBasis`; a recipe carries `basisSummary`. Never add a stored average.
- `PRICING_SELECT` is the Prisma select for the chain fields; `asChainItem(row)` normalizes a row; `withPpb(row)` attaches the computed `pricePerBaseUnit` so API responses still expose it as a field. If an API response contains `pricePerBaseUnit`, it was computed at read time.
- The one legitimate *stored* copy is `InventorySnapshot.pricePerBaseUnit` — a deliberate point-in-time valuation frozen at count finalize. Finalize writes one snapshot row per count line **flagged with `source`** (`src/lib/count-snapshot-source.ts`: `COUNTED` | `CARRIED` "Same as last" | `SKIPPED` | `THEORETICAL` for a line left blank). Only `COUNTED`/`CARRIED` are observations: `CountSession.totalCountedValue` sums those alone, and any reader that sums snapshots must filter on `source`. COGS period bounds are built **per item** (`resolveItemBound` in `src/lib/cogs-bounds.ts`): the latest FULL count fixes the item universe and date, each item takes its most recent observed snapshot from any finalized count on or before the bound.
- Offers derive the same way: `offerPricePerBase()` in `src/lib/supplier-offers.ts` (the cached `InventorySupplierPrice.pricePerBaseUnit` column was dropped).

**Mutators** (the only places that write `InventoryItem.packChain`/`pricing`):
- [src/app/api/invoices/sessions/[id]/approve/route.ts](src/app/api/invoices/sessions/[id]/approve/route.ts) — **canonical writer**; the only spine-write that fires recipe re-cost / alerts. Also creates new items with a fresh chain.
- [src/app/api/invoices/sessions/route.ts](src/app/api/invoices/sessions/route.ts) — session DELETE rolls `pricing` back to each line's `previousPrice` (format untouched).
- [src/app/api/inventory/route.ts](src/app/api/inventory/route.ts) (create) and [src/app/api/inventory/[id]/route.ts](src/app/api/inventory/[id]/route.ts) (edit) — via `formToChain`.
- [src/lib/inventory-import.ts](src/lib/inventory-import.ts) + [src/app/api/inventory/import/route.ts](src/app/api/inventory/import/route.ts) — CSV import / migration.
- [src/app/api/recipes/route.ts](src/app/api/recipes/route.ts) + [src/app/api/inventory/sync-prepd/route.ts](src/app/api/inventory/sync-prepd/route.ts) — create/backfill the linked `InventoryItem` for PREP recipes.
- [src/lib/recipeCosts.ts](src/lib/recipeCosts.ts) `syncPrepToInventory` — writes a PREP recipe's computed cost + yield chain back to its linked item.
- [src/lib/primary-offer.ts](src/lib/primary-offer.ts) `syncPrimaryOfferToItem` / `setPrimaryOffer` — for items WITH supplier offers, the item's chain/pricing is the **primary offer's** value (sticky, manually chosen; invoice approve only re-prices when the line's supplier is primary). Items with no offers author their own pricing (these helpers no-op). Invariant enforced by a partial unique index `(inventoryItemId) WHERE isPrimary`.

**Readers**: everywhere — recipes/menu/prep/wastage/count/variance/sales/cost-chrome all read the computed value for display or `lineCost`. The live cost-chrome strip reads [src/app/api/insights/cost-chrome/route.ts](src/app/api/insights/cost-chrome/route.ts) (WTD food cost %, target, 7d variance, on-hand); clicking it opens [src/components/layout/SpineAuditDrawer.tsx](src/components/layout/SpineAuditDrawer.tsx) backed by [src/app/api/insights/spine-audit/route.ts](src/app/api/insights/spine-audit/route.ts).

**Rule of thumb when adding a cost number anywhere**: don't compute or store a parallel price — derive from the chain at query time (`withPpb` / `lineCost`). If you find yourself wanting to cache a cost on a recipe/menu/sales row, you're probably building a divergence bug. The schema now enforces this: there is no column to write.

**Retained format fields (not legacy debt):** `InventorySupplierPrice.{packQty,packSize,packUOM}` and `InvoiceMatchRule.invoicePack{Qty,Size,UOM}` are kept deliberately — they store the human purchase format the normalized `packChain` collapses into base units. Costing always derives from the chain; these are display/provenance/learned-format only. Do not "migrate" them to a chain.

### Shared components

`src/components/recipes/shared.tsx` — single large file containing `RecipeCard`, `RecipePanel`, `CategoryManager`, `IngredientRow`, and related types. Both the Recipe Book page and Menu page import from here.

`src/components/prep/` — two surfaces: **Smart Prep planner** (`planner/` — `PlannerDesktop` split view, `PlannerMobile` tabs, `SuggestionRow`/`DraftRow`/`PostDialog`/`atoms`) where any signed-in cook with a writable revenue center builds a draft (qty/note/assignee/priority-override/order on today's `PrepLog`) and **posts** it (the planner routes gate on `requireSession()` only; switching an item out of prep stays LEAD+), and the **To Do run sheet** (`runsheet/` — `RunSheet`, `RunSheetMobile`; each paints its own one-line posted caption + 3 px progress hairline, no status card or crew strip) that shows ONLY posted items (`PrepLog.postedAt`; `PrepPost` is the per-RC-per-day provenance header with a `dirty` flag for unposted draft changes). **The run sheet is ONE ladder derived from the step**: `withLadderTimes`/`runSheetGroups` (`prep-plan.ts`) give each posted row its step deadline for the day and `startBy = deadline − active − passive` (overwriting the API's service-based `startByMinutes` on the run sheet only), sections are Late to start + the four steps, rows order by deadline → start-by → the chef's `listOrder` — there is no separate Time/Priority view. The planning day rolls to tomorrow only once the last service has ENDED (`planDayContext.roll`; close = last service end, 22:00 only when no service has an end), and `PrepLog.dueTime` holds the deadline label the chef posted. The planner runs on **ONE 4-step urgency scale** (`PrepUrgency` in `src/lib/prep-utils.ts`: `PASS` Critical-Start Service · `MID` Mid-service · `CLOSE` Before close · `TMRW` Tomorrow) — each step means both a deadline and a stock condition; the chef overrides the STEP (`manualPriorityOverride` stores urgency tokens; legacy 3-level tokens normalize at read), never the stock, and the stock reason (`whyLabel`) is read-only evidence. The app-wide 3-level `priority` is a **collapse** of this scale (`urgencyToPriority`: PASS→911, MID/CLOSE→NEEDED_TODAY, TMRW→LATER — byte-identical to the old rule) and is always **computed** from stock (`effectivePriority`/`applyStatusToItem` in `src/lib/prep-plan.ts`) — never trust a stored pill; completing a prep clears the override server-side AND recomputes client-side. `prep-plan.ts` also holds the batch math (display in half-batches of the linked recipe's yield; stored qty is ALWAYS UOM) and the station schedule (`planSchedule`/`stationLoad` — crew cursors vs step deadlines; "won't fit" warnings). Plus `PrepDrawer`, `PrepSettingsModal`, `board/PrepBoardDrawer` (item drawer; its Edit opens the recipe at `/recipes?item=<id>`). The prep Tasks checklist (`PrepTask`/`PrepTaskLog`) was retired from the UI and API in Sept 2026; the two tables remain until a follow-up migration drops them.

**A prep item can be switched off the prep list** (`PrepItem.prepEnabled`, the chef's "Prepped on the line" switch in the item drawer when opened from Smart Prep; off items sit in the collapsed "Not prepped" group under the suggestions, `HiddenGroup`, and are switched back on from their drawer). Off keeps the item out of `GET /api/prep/items` for every consumer unless `?includeHidden=true` (only the prep page asks), and takes it off the draft; the switch is locked while the item is on the draft or the To Do. The recipe and `isActive` (which mirrors the recipe) are untouched, and recipe sync never writes `prepEnabled` — that is the whole point: feature recipes stay recipes without cluttering prep.

**Cook-along progress persists while an item is on the To Do.** The drawer's scale, ticked ingredients and ticked method steps ride the item's ONE live log (`PrepLog.progress`, shape + helpers in `src/lib/prep-progress.ts`; keys are RecipeIngredient ids and MethodStep keys, never positions). Written by `PUT /api/prep/logs/[id] { progress }` (no LEAD gate, 500 ms debounce per log on the client, session cache in `progressRef` wins over the polled row); cleared by the same route on DONE / PARTIAL / SKIPPED and by `remove-item` — never on Stop. An item with only an offline `_opt_` log id stays ephemeral. The page paints from a cached list first, so the drawer sync effect re-seeds when the live row arrives.

**A prep item has no editor of its own.** Every `PrepItem` is created and named by recipe sync (`src/lib/prep-sync.ts`, which also mirrors the recipe's `revenueCenterId`); its line settings — `parLevel`, `shelfLifeDays`, `stations` — are edited in the recipe editor's Prep section and written through `PATCH /api/recipes/[id] { prep }`. `PUT /api/prep/items/[id]` accepts only planner state (`manualPriorityOverride`, `isOnList`, `isActive`); there is no `POST`. `stations` is a set (empty = any station): the API emits a derived `station` label for display, and filters/crew maths use `onStation`/`crewFor` in `prep-plan.ts`. Timing comes from the recipe method (`resolveActive` has no per-item override layer) and every deadline from the urgency step (`urgencyDeadline(u, ctx)` — no per-item ready-for service). The columns `targetServiceId`, `activeMinutesOverride`, `passiveMinutesOverride`, `passiveNoteOverride` are unread and nulled (`scripts/clear-prep-item-overrides.ts`); `station` is unread but still holds its old value; all five, plus the `Service` relation on `PrepItem`, are dropped by a follow-up migration after deploy.

### Important patterns

**Prisma singleton** — always import from `src/lib/prisma.ts`, never instantiate `PrismaClient` directly.

**API routes** — conventional REST shape: `GET/POST` at `/api/[resource]`, `GET/PATCH/DELETE` at `/api/[resource]/[id]`, action endpoints at `/api/[resource]/[id]/[verb]`.

**Recipe types** — a `Recipe` row has `type: 'PREP' | 'MENU'`. PREP recipes automatically create and sync a linked `InventoryItem` (via `syncPrepToInventory`) so they can be used as ingredients in other recipes. MENU recipes do not.

**PrepSettings singleton** — `PrepSettings` is a single-row table (`id = 'singleton'`); the GET route inserts the row only when it is missing. Categories and stations are stored as `String[]` columns. **Categories are managed by recipe sync** (`/api/prep/sync-from-recipes`) and are not user-editable; **only stations are user-editable** (via `PrepSettingsModal`). A prep item's category is inherited from the linked recipe. Default values live in `src/lib/prep-utils.ts` (`PREP_CATEGORIES`, `PREP_STATIONS`) — import from there, never redefine locally.

**Client components** — all interactive pages use `'use client'`. Helper components defined inside a client component body will remount on every render and lose focus/state — always define sub-components at module scope.

**Prisma Decimal fields** — Prisma `Decimal` values (e.g. `variancePct`, `varianceCost`, snapshot `pricePerBaseUnit`) are serialized as **strings** in JSON API responses, not JavaScript numbers, even when the TypeScript interface types them as `number`. Always wrap with `Number()` before calling arithmetic methods like `.toFixed()` or doing comparisons.

### Auth & roles

Auth is **Supabase Auth**. `src/middleware.ts` protects every non-`/api` route: unauthenticated users → `/login`, deactivated users → `/login?error=deactivated`. `/login` and `/auth/*` are public. A `REDIRECTS` table maps legacy paths to the v2 layout (`/settings` → `/setup`, `/suppliers` → `/setup/suppliers`, …). Role gating reads `user_metadata`: `ADMIN_PREFIXES = ['/settings', '/setup']`; `MANAGER_PREFIXES = ['/reports', '/pass', '/cost', '/variance', '/signals', '/end-of-day']`. In non-production, `DEV_AUTH_BYPASS=true` skips auth entirely.

- **Roles** — `ADMIN > MANAGER > STAFF` (`Role` enum). Strength compared via `ROLE_RANK` in `src/lib/auth.ts`.
- **API route auth** — call `requireSession(minRole?)` from `src/lib/auth.ts`; it throws `AuthError(401|403)`. Catch it and return `NextResponse.json({ error }, { status })`. API routes are excluded from middleware, so each handler must guard itself.
- **Supabase clients** — `src/lib/supabase/server.ts` (SSR, cookie-bound), `client.ts` (browser), `admin.ts` (service-role, server-only, bypasses RLS — used for inviting users).
- **Two-store sync invariant** — every user is mirrored across **Supabase Auth** (`user_metadata.{role,isActive}`, read by middleware) and the **Prisma `User` row** (`{role,isActive}`, read by `requireSession`). Both stores must be written together on every lifecycle change or the account half-locks. Supabase-side helpers live in `src/lib/users.ts`.
- **User lifecycle** (ADMIN-only, `api/settings/users`) — invite is idempotent (pending accounts re-invited fresh, accepted ones reactivated in place); `PATCH {isActive}` deactivates/reactivates reversibly in both stores; `DELETE` is a permanent hard-delete (chat history survives via `ChatConversation.userId onDelete: SetNull`). The invite email flows through `/auth/callback` (verifies token, activates the Prisma row, → `/auth/set-password`); the Supabase "Invite user" template must emit a `{{ .TokenHash }}` link pointing at `/auth/callback`.

### Other subsystems

- **Toast POS sync** — `src/lib/toast/*`, `/api/toast/*`, nightly cron `/api/cron/toast-sync` (guarded by `CRON_SECRET`). Toast rows supersede same-day manual `SalesEntry` rows; connection + mappings live in `ToastConnection`/`ToastItemMap`/`ToastRevenueCenterMap`, configured in `/setup/toast`.
- **Tip payouts** — `/tips`: a persisted 14-day kitchen tip pool. `TipPeriod` owns the run (basis, rate, cap, rounding, imported `TipPunch` rows, `TipDayAdjustment` overrides, and a frozen `snapshot` once PAID). The roster is `Cook` extended with `clockId` / `wage` / `tipRoleId` / `onTipPool` — hours match on `clockId` only, never on name. **Two things are configurable and deliberately independent of each other and of `TipPeriod.revenueCenterId`:** the *scope* (`TipSettings.salesSourceMode` LOCATION | RC — a Kitchen pool is normally funded by the whole Cafe location) and the *basis* (`poolBasis` NET_SALES | TIPS_COLLECTED — the kitchen pool is a withdrawal from the FOH tip pot, sized either off sales or off the pot itself). A workbook import overrides individual days. All split maths and the reconciliation live in pure libs (`src/lib/tips/{engine,audit,period}.ts`, covered by `npm test`) so the page recomputes in the browser as the rate changes; the server re-runs the same functions via `src/lib/tips/build.ts` to freeze a payment and build the export. **A period with unresolved audit errors cannot be marked paid** — including `overdraw`, raised when a sales-sized pool exceeds the tips customers actually left. The hour cap is per person (`Cook.dailyHourCap`, edited on the roster row or the Split tab's person detail); `TipSettings.defaultDailyHourCap` is only a prefill for new roster rows, never a live cap — there is no house-wide cap. `TipPeriod.snapshot` is a structured `{ current, history, trimmed }` payout record, not a flat blob; the paid test is `snapshot.current != null` (a reopened period keeps its snapshot with `current: null`), which is exactly equivalent to `period.status === 'PAID'`.
- **Customer tips on sales** — `SalesEntry.tipsCollected` (payment tips) and `.autoGratuity` (service charges flagged `gratuity`) are written by the Toast sync from `Check.payments[].tipAmount` and `Check.appliedServiceCharges[]`, which were always in the `ordersBulk` response and simply not modelled. **Both are nullable on purpose: `null` = no tip data, `0` = genuinely no tips**, and the tip payout treats the two very differently. They are stored separately so `TipSettings.includeAutoGratuity` can be flipped at read time without a re-sync. A tip belongs to the *check*, so it is apportioned across revenue centers by that check's routed revenue (`checkTipTotals` in `src/lib/toast/client.ts`); anything unattributable is logged, never dropped.
- **End-of-day close** — `/end-of-day`: recap, checklist with temps gate, sign-off, snapshot, handover (`EodClose`/`EodCheckItem`/`EodCheckEntry`). Business date is **Pacific local time, not UTC**. Checklist template CRUD lives in `/setup/eod-checklist`.
- **Temps** — `TempUnit`/`TempReading` models, `/api/temps/*`; feeds the EOD checklist gate.
- **Signals** — `Signal` model, `/api/signals` (+ `/refresh`); anomaly feed for `/signals` and the mobile home.
- **Scoping** — 2-level `Location` → `RevenueCenter` (leaf; the write boundary for stock). Access is global `Role` × `UserScope`. Item↔RC visibility via the `ItemRevenueCenter` join.
- **AI chat** — `/api/chat`, `ChatConversation`/`ChatMessage`.
- **Allergens** — Health Canada priority list (incl. Mustard, Sulphites; coconut is NOT a tree nut here); per-ingredient pills; PREP items inherit via `syncPrepToInventory`.
- **Mobile shell** — `src/components/mobile/` (`kit.tsx`, `MobileTabBar`, `today/`); `/today` is the mobile home.

### Where deeper docs live

Check these before re-deriving the intent of a subsystem — most features have a dated design doc:
- `docs/superpowers/plans/` + `docs/superpowers/specs/` — ~100 dated feature designs and specs (56 plans, 47 specs).
- `design-context/*.md` — design foundations, core components, and per-page design notes (`01-foundations` … `04-lib`).
- `docs/app-context-prompt.md` — product overview.
- `docs/design-refs/` — visual references.

### Infrastructure gotchas

- **Route handlers must be dynamic.** A `GET` route handler with no `request` parameter and no dynamic API usage is statically prerendered at build time — which makes every non-GET method on that route return **405**, and serves stale build-time data on GET. Any route with a mutating handler (or that must run live) must `export const dynamic = 'force-dynamic'`. Check `npm run build` output: API routes should show `ƒ (Dynamic)`, not `○ (Static)`.
- **pgBouncer transaction mode.** `DATABASE_URL` is a Supabase transaction-mode pooler — it does not support named prepared statements. Prisma ORM calls generally tolerate this, but writes to `text[]` array columns do not: never use `$executeRaw` tagged templates for array writes. Use `$executeRawUnsafe` / `$queryRawUnsafe` with hand-built literal SQL (see `toPgTextArray` in `src/app/api/prep/settings/route.ts`). When a route mixes ORM and raw SQL and fails intermittently in production, suspect this.

### Mobile UX patterns

Pages use a **dual-renderer** pattern for mobile vs desktop: a mobile layout block placed before the desktop block, both mounted simultaneously with CSS hiding the irrelevant one. Older pages split at `sm:` (`block sm:hidden` / `hidden sm:block`); redesigned pages (prep, count, today) split at `md:` — check the page you're editing before assuming the breakpoint.

**Bottom sheets** — `fixed inset-0 z-50 flex items-end sm:hidden` with a backdrop div (`fixed inset-0 z-40`) and content panel (`relative bg-white w-full rounded-t-2xl`). The `sm:hidden` on the fixed overlay suppresses it on desktop.

**`cardRefs` namespacing** (`src/app/count/page.tsx`) — when both a desktop and mobile renderer for the same list are mounted, they must write to different ref keys to avoid overwriting each other. Desktop uses `d-${id}`, mobile uses `m-${id}`; scroll-to-next logic selects the prefix at runtime from `window.innerWidth`.

(Component-specific styling fixes — stepper button sizing, left-accent card stripes, ⋯ menu placement — are documented as inline comments at their respective components.)

## Environment variables

```
DATABASE_URL                    # Supabase pgbouncer pool URL (Prisma at runtime — transaction mode)
DIRECT_URL                      # Direct PostgreSQL URL (Prisma migrations)
NEXT_PUBLIC_SUPABASE_URL        # Supabase project URL (auth — client & server)
NEXT_PUBLIC_SUPABASE_ANON_KEY   # Supabase anon key (auth — client & server)
SUPABASE_SERVICE_ROLE_KEY       # Supabase service-role key (server-only — user invites, bypasses RLS)
ANTHROPIC_API_KEY               # Claude API — invoice OCR + chat
UPLOADTHING_TOKEN               # File uploads (UPLOAD_PROVIDER selects the upload backend)
CRON_SECRET                     # Guards /api/cron/* (Toast nightly sync) — must be set in Vercel
RESEND_API_KEY                  # Email digests + EOD email
DIGEST_EMAIL                    # Recipient for the digest email
DIGEST_FROM                     # Digest sender address (must be a verified Resend domain)
NEXT_PUBLIC_APP_URL             # Public URL (used in emails/links and invite redirects)
DEV_AUTH_BYPASS                 # 'true' skips auth in non-production only
```

Environment variables are per-environment — values in local `.env` do **not** deploy. Production values must be set in the Vercel project settings, and a redeploy is required for new vars to take effect.
