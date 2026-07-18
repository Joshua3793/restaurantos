# Prep To-Do → Run Sheet Redesign — Design Spec

**Date:** 2026-07-18
**Status:** Approved (design), ready for implementation planning
**Surface:** `/prep` (desktop + mobile), plus a new Setup sub-page and roster.
**Source design:** Claude Design project `prep-todo/` ("Controla OS — Prep To-Do Redesign · Run Sheet"), files `data.js`, `shared.jsx`, `desktop.jsx`, `mobile.jsx`, and handoff `prep-todo/design_handoff_recipe_view/README.md`.

---

## 1. Overview

Today's Prep To-Do surface is organized around **par vs. on-hand**: a "Smart Prep" intake pane suggests what's below par, and a "Today" board (`src/components/prep/board/`) groups committed items by station/category. This redesign replaces the **Today board surface** with a **time-ordered run sheet**: every task's position is derived from a computed **start-by time**, so a cook reads the list top-to-bottom in the order things must actually be started to be ready for service.

The organizing formula is the spine of the whole feature:

```
startBy = serviceTime − handsOnMinutes − unattendedMinutes
```

- **serviceTime** — the time the item must be ready (Brunch / Lunch / Dinner …), from a new per-RC **Service** model.
- **handsOnMinutes** (`active`) — attended prep time.
- **unattendedMinutes** (`passive`) — oven / reduce / chill / brine time the cook is not actively working, with a short note ("oven", "reduce", "chill").

Both time components are authored on the **Recipe** (shared everywhere it's used), with an optional per-**PrepItem** override for items that have no recipe or need a one-off.

### What stays the same
- **Smart Prep is unchanged** as the intake mechanism. Items still reach the day via `isOnList` + today's `PrepLog`. The run sheet is the committed "Today" view, not a new way to add items.
- **Priority is unchanged.** The existing `computePriority()` (`src/lib/prep-utils.ts`) already yields `911 | NEEDED_TODAY | LATER`, which maps exactly onto the design's **critical (STOCK OUT) / needed / later**. No new priority field.
- **RC scoping is preserved.** Prep is scoped per revenue center; `PrepLog` already carries `revenueCenterId`.
- **The cost/recipe libraries are untouched** (`recipeCosts.ts`, `item-model.ts`, the spine). This feature only reads computed costs/allergens.

### Goals
1. A desktop **run sheet** ordered by start-by time, with Kitchen ↔ My-Station modes, a crew load strip, an "on the stove" live-timer rail, claim/assign, and time/station/priority grouping.
2. A mobile **"my station"** screen: next-up hero, queue, kitchen mode, in-progress rail.
3. A shared **recipe view** (desktop right-drawer / mobile full-screen sheet) with **batch upscaling** that live-scales every ingredient to the quantity the cook needs to make.
4. **Yield logging** on completion (already partially modeled) surfaced through the new surfaces.

### Non-goals (YAGNI)
- No change to how items are suggested/added (Smart Prep intake logic).
- No change to costing, allergens, or the pricing spine.
- The prototype's dev-only "tweaks" (density, urgency-bold, clock slider) are **not** shipped as end-user controls. Density = comfortable, urgency = subtle are fixed defaults. Group-by **is** a real user control (time default / station / priority).
- Cooks are **not** wired to auth (`User`) accounts.

---

## 2. Data model (Prisma — all additive & nullable; no destructive migration)

> Migration guidance: follow the project's pooler-safe workflow (see memory `project_prisma_migrate_shadow_broken` / CLAUDE.md "pgBouncer transaction mode"). All new columns are nullable or defaulted so existing rows are valid without backfill.

### 2.1 `Recipe` — authored prep times
Add:
```prisma
activeMinutes   Int?      // hands-on / attended minutes
passiveMinutes  Int?      // unattended minutes (oven/reduce/chill/brine)
passiveNote     String?   // short label for the passive phase, e.g. "oven"
```

### 2.2 `PrepItem` — service target + time overrides
Add:
```prisma
targetServiceId        String?   // the Service this item must be ready for
activeMinutesOverride  Int?      // overrides recipe.activeMinutes when set
passiveMinutesOverride Int?      // overrides recipe.passiveMinutes when set
passiveNoteOverride    String?   // overrides recipe.passiveNote when set
targetService          Service?  @relation("PrepItemService", fields: [targetServiceId], references: [id])
```
- **Effective time** = `override ?? linkedRecipe.value ?? null`. Effective active/passive are computed server-side in the items route.
- Existing `estimatedPrepTime` is **retained** and used as the backfill source for `activeMinutesOverride` where a prep item has no recipe (see §7 Migration). It is otherwise deprecated for display; the run sheet reads effective active/passive.

### 2.3 New `Service` model (per-RC)
```prisma
model Service {
  id              String        @id @default(cuid())
  revenueCenterId String
  name            String        // "Brunch", "Lunch", "Dinner"
  timeMinutes     Int           // minutes past local midnight (e.g. 690 = 11:30)
  sortOrder       Int           @default(0)
  isActive        Boolean       @default(true)
  revenueCenter   RevenueCenter @relation("ServiceRC", fields: [revenueCenterId], references: [id])
  prepItems       PrepItem[]    @relation("PrepItemService")
  @@index([revenueCenterId])
}
```
Managed in a new **Setup → Services** sub-page (ADMIN). `RevenueCenter` gains the back-relation `services Service[] @relation("ServiceRC")`.

### 2.4 New `Cook` roster (global, lightweight)
```prisma
model Cook {
  id          String   @id @default(cuid())
  name        String
  initials    String   // 2–3 chars, e.g. "MIA"
  homeStation String?  // one of PrepSettings.stations
  isActive    Boolean  @default(true)
  sortOrder   Int      @default(0)
}
```
Not tied to `User`. Managed in **Setup → Kitchen crew** (ADMIN). `PrepLog.assignedTo` stores a `Cook.id` going forward (kept as a plain `String`, not a hard FK, to avoid migrating legacy free-text rows; the UI treats an `assignedTo` that resolves to no `Cook` as "unknown/legacy" and shows it as unassigned).

### 2.5 `PrepLog` — start/finish timestamps
Add:
```prisma
startedAt   DateTime?   // set when a task is Started (status → IN_PROGRESS)
completedAt DateTime?   // set when Marked done (status → DONE) alongside actualPrepQty
```
These drive the live "on the stove" **elapsed** (`now − startedAt`) and **remaining** (`active + passive − elapsed`) readouts. Status vocabulary is unchanged (`NOT_STARTED | IN_PROGRESS | DONE | PARTIAL | BLOCKED | SKIPPED`); the run sheet maps `IN_PROGRESS`→"doing", `DONE`→"done", `blockedReason`→"blocked", else "todo".

---

## 3. Domain logic (new lib: `src/lib/prep-runsheet.ts`)

Pure, unit-testable helpers ported from the prototype's `shared.jsx`. These are the run-sheet analogues of the prototype's `pt*` helpers, adapted to the app's real data shapes and its `uom.ts` formatting where applicable.

- `effectiveActive(item)` / `effectivePassive(item)` / `effectivePassiveNote(item)` → resolve override ?? recipe.
- `startByMinutes(item, service)` → `service.timeMinutes − effectiveActive − effectivePassive` (missing service or times → `null`, and such tasks sort after timed ones / render without a start-by).
- `runState(item, nowMin)` → `'blocked' | 'overdue' | 'soon' | 'later'` (soon = start-by within 60 min).
- `elapsedMinutes(log, nowMin)` / `remainingMinutes(item, log, nowMin)`.
- `fmtClock(min)` `HH:MM`, `fmtDuration(min)` `1h20`/`45m`.
- **Batch scaling** (recipe view): `scaleRound(value, unit)` and `scaleQtyLabel(qty, scale, unit)` implementing the exact rounding rules below; `stepFor(unit)` (kg/L → 0.5, ea/loaves → 5, else 50).

**Rounding rules (`scaleRound`)** — copied verbatim from the design so scaled quantities read identically:
- `kg`/`L`: ≥10 → nearest 0.5; else → nearest 0.01.
- `ea`/`loaves`: nearest integer.
- default (`g`/`ml` …): ≥100 → nearest 5; else → nearest integer.

**Scale-label formatting (`scaleQtyLabel`)**: kg/L show up to 2dp (<10) or 1dp (≥10), trailing zero trimmed; other units integer.

These live in a lib with a vitest suite (consistent with `src/lib/__tests__/`), since they are pure math and the project's testing convention covers exactly this kind of code.

---

## 4. API changes

All prep routes remain `force-dynamic` (they mutate / must run live) and no-store (polled) per existing conventions.

### 4.1 `GET /api/prep/items` (extend response)
Each item gains (computed server-side):
- `activeMinutes`, `passiveMinutes`, `passiveNote` — effective values.
- `service` — `{ id, name, timeMinutes } | null` for `targetServiceId`.
- `startByMinutes` — computed (or null).
- `assignedCook` — `{ id, initials, name, homeStation } | null` resolved from `todayLog.assignedTo`.
- `todayLog` continues to carry `status`, `actualPrepQty`, `blockedReason`, and now `startedAt` / `completedAt`.

### 4.2 `PrepLog` mutations
- **Start:** `PATCH /api/prep/logs/[id]` (or POST upsert) with `{ status: 'IN_PROGRESS', startedAt: <server now> }`. Server stamps `startedAt` when transitioning into IN_PROGRESS if not already set.
- **Finish / log yield:** `{ status: 'DONE', actualPrepQty, completedAt: <server now> }`. Existing yield/inventory-adjust behavior preserved.
- **Claim / assign:** `{ assignedTo: <cookId | null> }` — already supported; now interpreted as a Cook id.
- **Reopen:** `{ status: 'IN_PROGRESS', completedAt: null }` (undo from Done).
- **Batch write-back (approved):** when the cook confirms a scaled batch in the recipe view via **Start this batch**, the chosen target is written to `PrepItem.targetToday` (existing field) via `PATCH /api/prep/items/[id]`, so the run sheet qty, timers, and yield-log default reflect the scaled batch.

### 4.3 New routes
- `GET/POST /api/services`, `PATCH/DELETE /api/services/[id]` — per-RC service CRUD (ADMIN for writes; reads follow prep read auth). Ordered by `sortOrder`, then `timeMinutes`.
- `GET/POST /api/prep/cooks`, `PATCH/DELETE /api/prep/cooks/[id]` — roster CRUD (ADMIN for writes).

---

## 5. Component architecture

New tree: `src/components/prep/runsheet/`. The existing `src/components/prep/board/` tree (`PrepBoard`, `PrepBlock`, `PrepRow`, `PrepLater`, `PrepBoardDrawer`, `PrepSummaryLine`, `prep-board-utils.ts`) is **retired** for the Today surface and removed once the run sheet is wired in. Smart Prep components are untouched.

Styling: port the prototype's spacing/radii/typography exactly, but express colors via the app's **flat Tailwind tokens** (`bg-red`, `text-red-text`, gold/ink tokens — see memory `project_tailwind_color_tokens`; numbered classes are broken here), and icons via **Lucide** (`book-open`, `layers`, `plus`, `minus`, `check`, `zap`, `lock`, `alert-triangle`, `x`, `arrow-left`, `flame`, `timer`, `undo-2`, `users`). Sub-components defined at **module scope** (never inside a client-component body — see CLAUDE.md focus/remount rule). Dual-renderer split at the **`md:` breakpoint** (redesigned pages use `md:`, per CLAUDE.md).

| File | Responsibility |
|---|---|
| `runsheet/RunSheet.tsx` | Desktop frame: title + status band, Kitchen/My-Station toggle, crew strip / cook picker, station filter, in-progress rail, grouped ladder, Done section. Owns run-sheet local UI state (mode, cook, grouping, recipe/log open). |
| `runsheet/RunSheetMobile.tsx` | Mobile frame: header, mode toggle, cook picker, in-progress rail, My-Station hero + queue / Kitchen time sections, Done. |
| `runsheet/RunRow.tsx` | One ladder row (desktop): start-by time + late/in, task name (opens recipe) + qty + station tag + STOCK OUT/BLOCKED badges, hands-on/passive runway, "→ LUNCH" need, assignee chip + claim popover, book + Start actions. |
| `runsheet/RunRowMobile.tsx` | Mobile row variant. |
| `runsheet/InProgressRail.tsx` | "On the stove" horizontal rail of live-timer cards (desktop + mobile variants), Done button → log yield. |
| `runsheet/CrewStrip.tsx` | Kitchen-mode per-cook load cards (doing / queued / hands-on / late). |
| `runsheet/GroupHead.tsx`, `runsheet/NowLine.tsx` | Section headers + the pulsing "NOW · HH:MM" divider. |
| `runsheet/RecipeSheet.tsx` | **Shared** recipe view, `variant='drawer' \| 'sheet'`. Batch stepper + quick-multiplier chips, live-scaled ingredients, method, "on the pass" meta (start-by/ready-for/shelf-life/allergens), state-dependent footer (Start / Mark done / Blocked). **Replaces `RecipeViewModal.tsx`** (and folds in the batch-scaling it already does). |
| `runsheet/LogYield.tsx` | Yield stepper body, hosted in a desktop modal + mobile bottom sheet. Supersedes the log path in the current board. |
| `runsheet/assignee.tsx` | `AssigneeChip` + claim popover (dark initials when claimed / dashed "+ CLAIM" when open). |

Shared primitives (station tag, need chip, runway bar, segmented control) live alongside as small module-scope components or in `runsheet/atoms.tsx`.

`src/app/prep/page.tsx` swaps the Today board render for `<RunSheet>` / `<RunSheetMobile>`, passing the already-loaded items, cooks, services, and the existing `api`-style mutation callbacks. Smart Prep and history panes remain.

---

## 6. Interactions & behavior

- **Modes:** Desktop defaults to **Kitchen** (whole brigade); mobile defaults to **My Station**. Toggle via segmented control. My-Station scopes to the picked cook: `assignee === cook OR (unassigned AND item.station === cook.homeStation)`.
- **Grouping (desktop):** user control — **time** (default: Late-to-start → NOW line → within-the-hour → later-this-morning → afternoon), **station**, or **priority** (critical/needed/later). Mobile: My-Station = hero + "Coming up"; Kitchen = time sections.
- **In-progress rail:** items with `status = IN_PROGRESS` show elapsed + remaining (or "over by") computed from `startedAt` and effective active+passive; Done button opens Log Yield.
- **Claim/assign:** row assignee chip opens a cook popover (desktop) / taps to claim-to-me (mobile). Writes `assignedTo = cookId`.
- **Open recipe:** clicking a task name (underlined), the book button, a rail card, or the mobile hero's "Recipe · scale batch" sets the open recipe to that task id; the view reads the **live** task from state.
- **Recipe / batch scale:** `target` local to the view, initialized to the task's effective qty (`targetToday ?? suggestedQty ?? qty`). Stepper ± snaps to `stepFor(unit)` and clamps to ≥ one step; chips = `Today`, `½×`, `1×`, `2×`, `3×` (× base yield); a chip is active when `|target − chipValue| < 0.01`. Every ingredient qty, the "scaled to …" heading, and the "×base" pill recompute synchronously.
- **Footer actions (recipe view):** `blocked` → non-interactive BLOCKED notice; `doing` → "Mark done · log yield" (opens Log Yield); `todo` → "Start this batch" → writes the scaled `target` to `targetToday`, calls start, closes the view.
- **Animations:** desktop drawer slide-in-from-right 0.26s cubic-bezier(.32,.72,.35,1); mobile sheet slide-up 0.26s; scrim fade 0.18s. Backdrops must **not** use `backdrop-blur` on a fixed inset-0 scrim (see memory `project_backdrop_blur_freeze`).
- **Clock source:** real wall-clock (Pacific business-local, consistent with EOD business-date handling), refreshed on an interval so timers advance. The prototype's clock slider is dev-only and not shipped.

---

## 7. Migration & backfill

1. Add nullable columns + new tables (pooler-safe migration).
2. Backfill script: for each `PrepItem` with `estimatedPrepTime` and no linked-recipe `activeMinutes`, set `activeMinutesOverride = estimatedPrepTime`. Recipes' `activeMinutes`/`passiveMinutes` start null and are authored over time in the recipe editor (a follow-up; run sheet degrades gracefully — a task with no times has `startBy = service.timeMinutes` and no runway bar).
3. Seed one default service set per active RC (e.g. Lunch 11:30, Dinner 17:00) so the run sheet is immediately time-ordered; editable in Setup.
4. Existing `PrepLog.assignedTo` free-text values that don't resolve to a `Cook` render as unassigned (non-destructive).

---

## 8. Design tokens (reference)

Ported to the app's token system. Palette (prototype → app token intent): surfaces `#fafaf9`/`#f4f4f5`/`#fff`; ink `#09090b`/`#27272a`/`#71717a`/`#a1a1aa`; lines `#e4e4e7`/`#d4d4d8`; gold `#d97706`/`#b45309`/`#fef3c7`/accent `#fcd34d`; red `#dc2626`/`#fee2e2`/`#991b1b`; green `#16a34a`/`#dcfce7`/`#166534`. Typography: Geist (sans) + Geist Mono (all times/quantities/labels/tags). Key sizes: h2 title 25/22px·600·−0.03em; batch number 38px·600·−0.04em; ingredient qty 13.5px·600 mono; section head 10.5px·600 mono uppercase 0.06em. Radii 8–14, pills 99. Drawer shadow `-24px 0 60px -20px rgba(0,0,0,0.3)`.

---

## 9. Phasing (for the implementation plan)

- **Phase 1 — Data + API + Setup:** schema migration, `prep-runsheet.ts` lib + tests, extend `GET /api/prep/items`, add start/finish timestamps, `Service` + `Cook` CRUD routes, Setup → Services and Setup → Kitchen crew sub-pages, backfill + seed.
- **Phase 2 — Desktop run sheet:** `RunSheet` and its sub-components; swap the Today board on `/prep` desktop.
- **Phase 3 — Mobile run sheet:** `RunSheetMobile` + mobile rows/rail; swap the mobile Today surface.
- **Phase 4 — Recipe sheet + yield:** `RecipeSheet` (drawer+sheet) with batch scaling and write-back, `LogYield`, retire `RecipeViewModal`; final removal of the old `board/` tree.

Each phase ends with `npm run build` green (type-check) and `npm test` green for the lib; UI phases verified in the browser preview.

---

## 10. Verification

- `npm test` — new `prep-runsheet` suite (start-by, run-state, scaling/rounding, formatting).
- `npm run build` — type-check + dynamic-route check (`ƒ` not `○` on all mutating routes).
- Browser preview: run sheet orders by start-by; NOW line placed correctly; Kitchen/My-Station scoping; claim; start → rail timer advances; recipe drawer/sheet scales ingredients and chips activate; Start writes back `targetToday`; Mark done logs yield; Done/reopen round-trips.
