# Item backbone — Stage 4: the library drawer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The item drawer becomes a read-first "library card" for one product, in the order a manager thinks: what it is → what it costs → who sells it (boxes) → how it converts (bridges) → what suppliers call it (wordings) → how much is on hand → what happened to it. Every edit stays behind the rules Stage 2 shipped; nothing new is computed or stored.

**Architecture:** `InventoryItemDrawer.tsx` (1,150 lines) is split into a thin shell plus one file per section under `src/components/inventory/drawer/`. The shell keeps the data loading (one `GET /api/inventory/[id]` + the existing price-history / stock-movements / boxes / aliases / merges / remeasures reads), edit mode (unchanged form, now in `EditForm.tsx`), and the sheets (QuickCount, Merge, Remeasure). Sections are pure presentational components fed from the already-loaded item. All copy goes through `src/lib/drawer-copy.ts` (pure, tested) so the sentences are plain and consistent. Mobile is the same component (bottom sheet under `sm:`), with the header pinned and sections collapsible.

**Tech Stack:** Next.js 14 App Router, React, Tailwind (flat colour tokens only — numbered classes are broken in this repo), Lucide icons, vitest for the copy helpers, `npm run build`.

**Spec:** `docs/superpowers/specs/2026-10-03-item-backbone-design.md` §5. Depends on Stage 2b (boxes), 2c (remeasure sheet + `RemeasuredRow`), Stage 3 (`SupplierWordingsSection`, aliases routes).

## Global Constraints

- Branch off `origin/main` after Stage 3 merges. Worktree `.claude/worktrees/library-drawer`, branch `worktree-library-drawer`, pushed as `feat/library-drawer`. One PR, squash-merged. `git fetch origin && git reset --hard origin/main` after `EnterWorktree`; symlink `node_modules` and `.env`.
- `node`/`npm` are not on the sandbox PATH: prefix every command with `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" &&` (Bash `dangerouslyDisableSandbox: true`). Restore `tsconfig.json` after a build. Lint baseline on `main` = 20 files; add none.
- **No migration, no API behaviour change, no live-data writes.** The drawer reads what the routes already return. If a section needs a field the GET lacks, add it to `GET /api/inventory/[id]` (read-only, computed at read) and say so in the report.
- **Role redaction stays exactly as today:** below LEAD no money; below MANAGER no Edit/Count/Merge/Remeasure/boxes-write/wordings-delete; the shell passes `canEdit`/`canSeeMoney` down and sections render nothing money-shaped when `canSeeMoney` is false.
- **Edit mode is unchanged in behaviour** (allow-list PUT + `/pricing` for box-less items + R7 bridge confirm + STALE handling). Only moved into `drawer/EditForm.tsx`.
- **Copy rules (CLAUDE.md "Talking to Joshua" applies to UI text too):** restaurant words, no code words; money `$0.00`; dates "28 Sep"; every empty state says what to do next.
- Sections, top to bottom (spec §5), with their data source — this order is binding:
  1. **Header** — name · category pill · storage area · badges (Not stocked / Inactive / Recipe-made) · actions (Count, Merge, Edit — MANAGER+; Edit opens `/recipes?item=` for a recipe-made item).
  2. **Cost line** — two sentences from `item.costBasis` (AVG_30D) and `pricePerBaseUnit` (LAST): "Recipes cost this at **$0.42 / each** (30-day average, 4 deliveries)" / "Counts value it at **$0.46 / each** (last paid, Sysco, 28 Sep)". Fallback reasons in plain words ("no deliveries in 30 days — recipes use the last price"). Hidden below LEAD.
  3. **Supplier boxes** — the existing `SupplierOffersSection` restyled as cards: supplier · code · human pack · box price · **$/base** · last delivery · ★ main; sorted main first then $/base ascending; Edit / Remove / Make main / + Add (MANAGER+). Recipe-made item → "Cost comes from the recipe →" link.
  4. **Bridges** — "1 each = 85 g" and/or "1 ml weighs 1.03 g" with "used by 3 recipes" (`bridgeUsedBy` from the GET); none → "No bridge — add one if this item is bought by weight but counted" (MANAGER+ link opens Edit at the bridge field). "Change how it's measured" (Stage 2c sheet) lives here.
  5. **Supplier wordings** — Stage 3's `SupplierWordingsSection` as-is (MANAGER+).
  6. **Stock** — on hand per revenue center (existing `RcAllocationPanel`), last count (date + qty), theoretical now, "Count now" (R2), and the movement track with the `unbridged` tally (existing rows).
  7. **History** — price history list (existing read), merged-from items (`MergedItemsRow`), measure changes (`RemeasuredRow`), recent invoice lines (last 5 from price-history's lines, if the route returns them; else omit the sub-list and say so in the report).
- Mobile: header pinned (`sticky top-0`), sections 2–7 are `<details>`-style collapsibles open by default except History; the sheet keeps today's `h-[92vh]` bottom layout; no horizontal scroll at 375 px.
- Tests: copy helpers under `npm test`; `npm run build` green.

---

### Task 1: Split the drawer into a shell + section files (no visual change yet)

**Files:**
- Create `src/components/inventory/drawer/`: `Header.tsx`, `CostLine.tsx`, `BoxesSection.tsx` (wraps `SupplierOffersSection`), `BridgesSection.tsx`, `StockSection.tsx`, `HistorySection.tsx`, `EditForm.tsx`, `types.ts` (the `InventoryItem` drawer type and `EditForm` type moved out of the big file), `index.ts`.
- Modify: `src/components/inventory/InventoryItemDrawer.tsx` → the shell (data loading, mode, sheets, section order).
- Keep every existing helper (`formatDay`, `chainFromItem`, `chainChanged`, `buildEditForm`, `normalizeItem`, `baseToDisplay`, `displayStock`, `unbridgedAdvice`, `CostBasisRow`) — move, don't rewrite; module scope only (no components defined inside components).

- [ ] **Step 1:** move code file by file; after each move `npm run build` must pass; keep props explicit (no context).
- [ ] **Step 2:** open the drawer in the preview for a boxed item, a box-less item, a recipe-made item and an inactive item; `get_page_text` shows the same sections as before the split.
- [ ] **Step 3:** commit `refactor(inventory): split the item drawer into a shell and section files (no behaviour change)`.

### Task 2: Copy helpers + the cost line + header

**Files:**
- Create `src/lib/drawer-copy.ts` + `src/lib/__tests__/drawer-copy.test.ts`:
```ts
export function recipeCostSentence(cb: ItemCostBasis, baseUnit: string): string
//  avg present: "Recipes cost this at $0.42 / each (30-day average, 4 deliveries)."
//  fallbackReason 'no-purchases': "Recipes cost this at $0.46 / each (no deliveries in 30 days — using the last price)."
//  'implausible': "… (the recent deliveries looked wrong, so the last price is used)."  'prep-linked': "Cost comes from the recipe."
export function countValueSentence(last: number, baseUnit: string, supplierName: string | null, lastDelivery: string | null): string
//  "Counts value it at $0.46 / each (last paid, Sysco, 28 Sep)." · no supplier: "(last price set by hand)" · no date: omit the date
export function badgeList(item: { isActive: boolean; isStocked: boolean; recipe: unknown }): string[]   // ['Inactive'] | ['Not stocked'] | ['Recipe-made']
export function bridgeSentence(b: { eachQty?: number|null; eachUnit?: string|null; densityGPerMl?: number|null }, usedBy: number): string[]
//  ["1 each = 85 g · used by 3 recipes", "1 ml weighs 1.03 g"]; empty → []
```
- Modify `drawer/Header.tsx`, `drawer/CostLine.tsx` to use them; `CostLine` renders nothing when `!canSeeMoney`.
- [ ] tests → build → preview check (`get_page_text` contains both sentences for Goats Cheese) → commit `feat(inventory): drawer header and cost line in plain words`.

### Task 3: Box cards, bridges, stock, history

**Files:** `drawer/BoxesSection.tsx` (card layout over `SupplierOffersSection`'s data: pass a `variant="cards"` prop to the section rather than duplicating its write logic), `drawer/BridgesSection.tsx` (sentences + the Remeasure button + "edit bridge" link), `drawer/StockSection.tsx` (existing pieces re-ordered: RC allocations → last count → theoretical → movement track; "Count now" button), `drawer/HistorySection.tsx` (price history + `MergedItemsRow` + `RemeasuredRow` + recent lines).
- [ ] Build each; preview check per section (text-based); commit `feat(inventory): boxes as cards, bridges, stock and history sections`.

### Task 4: Mobile pass + smoke + PR

- [ ] `resize_window` mobile (375×812): header pinned; sections collapsible; no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`); dark mode untouched (the app has none).
- [ ] Screenshots of the drawer (desktop + mobile) for Joshua, taken with the pane visible; attach to the PR.
- [ ] Push `feat/library-drawer`, PR (Before: "the drawer was a form with facts scattered around it. After: a library card — name, what it costs, who sells it, how it converts, what suppliers call it, what is on hand, what happened"), merge after the final review.

## Self-review
- **Spec coverage:** §5 sections 1–7 ✔, mobile ✔, redaction unchanged ✔. Out of scope: alias add-by-hand (§7).
- **Placeholders:** none — sentences are in the copy helpers; data sources named.
- **Type consistency:** `recipeCostSentence`, `countValueSentence`, `badgeList`, `bridgeSentence`, the section component names, `variant="cards"`.
