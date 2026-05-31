# Mobile App — Design Spec

**Date:** 2026-05-30
**Status:** Approved for planning
**Source design:** Controla OS mobile prototype (Claude Design handoff bundle, 13 chat transcripts + `m-*.jsx` screens)
**Target codebase:** Fergie's OS (Next.js 14 App Router, TypeScript, Tailwind, Prisma/Supabase)

---

## 1. Background & framing

A mobile prototype ("Controla OS — Mobile") was designed in HTML/CSS/JS and exported for implementation. After analysis, three facts shape this spec:

1. **The prototype's design system is already our production design system.** The prototype's `m-kit.jsx` tokens are identical to `tailwind.config.ts`: `bg #fafaf9`, `paper #fff`, `ink #09090b`, accent `#d97706 / #b45309 / #fef3c7`, line `#e4e4e7`, the zinc ink ramp, and Geist + Geist Mono fonts. This is **not a rebrand**.
2. **The app already has the mobile machinery the prototype assumes:** the dual-renderer pattern (`block sm:hidden` / `hidden sm:block`) across 11+ pages, bottom sheets (`fixed inset-0 flex items-end sm:hidden` + `rounded-t-2xl` + `pb-safe`), safe-area utilities, an offline count queue (`src/lib/count-offline.ts`), and `MobileRcBar`.
3. **The prototype's real contribution is information architecture and a few hero interactions**, not visual style.

Therefore: we **integrate** the prototype's IA and screens into the existing Next.js app, binding to real APIs and contexts. We do **not** build a separate app, a `/m` route group, or a native shell.

### User intent (from chat transcripts)

- Mobile is a **phone-native companion to the desktop app, not a port** — built for "a chef to use with the phone," in the field/kitchen, between tickets.
- **Role-adaptive home:** manager sees oversight; chef sees execution.
- **Daily core** = Today, Prep, Count, Capture. These are the most-tapped kitchen-floor surfaces.
- The single most-emphasized priority: **non-linear count item-picking** — "being able to pick a specific item and input the amount is priority and it has to be with the best ux possible." Forced linear counting was explicitly rejected.
- **Prep elevated to near-desktop parity** — "most of the job is done from the phone when planning the prep list."
- **Offline-first** for the write-heavy surfaces (count, prep, waste), with queued sync.
- **Explicitly cut:** Briefing and End-of-day ("needs to be wired to other apps and api that i cannot implement yet").

---

## 2. Architecture

### 2.1 Navigation shell

A mobile bottom nav **already exists** in `src/components/Navigation.tsx` (`md:hidden fixed bottom-0`, rendered via the `Navigation` component mounted in `layout.tsx`). Its current five slots are `Pass · Prep · [Pages drawer] · Count · Invoices`, with a full-screen "All Pages" drawer behind the center button. Phase 1 **refactors this in place** into `Today · Prep · ＋ · Count · More` rather than adding a second bar. Navigation remains **URL-based** — tabs are `next/link` `Link`s to real routes — so deep links, the browser back button, and `src/middleware.ts` auth all keep working.

- **Top of screen (`< sm`):** keep the existing `MobileRcBar` (revenue-center switch + alerts bell). The app is multi-revenue-center; the prototype was single-venue, so this is an intentional divergence from the prototype.
- **Bottom (`< sm`):** refactored bar, five slots: `Today · Prep · ＋ · Count · More`.
  - `Pass` slot → **Today** (new route, §2.2/Phase 1).
  - center `[Pages]` button → **＋ quick-add sheet** (not a route).
  - `Invoices` slot → **More** — opens the existing "All Pages" drawer, which becomes the More-hub foundation (Phase 5). Invoices moves *into* the More hub / Inbox.
  - The More tab carries a dot indicator when there are pending inbox items (the existing badge-polling in `Navigation.tsx` already fetches `/api/invoices/kpis`).
- **Note on `<sm>` vs `<md>`:** the existing mobile chrome uses the `md` breakpoint (`md:hidden`), not `sm`. Phase 1 follows the existing `md` convention for the nav bar to stay consistent with `MobileRcBar` and the current bottom nav, even though per-page dual renderers use `sm`. (Tablet `sm`–`md` widths keep the mobile nav; acceptable.)
- **Active-tab logic:** the bar highlights based on the current pathname. Routes outside the four core tabs (e.g. `/inventory`, `/recipes`, `/wastage`, `/signals`) highlight "More", mirroring the prototype's `tabActive` logic.
- **Content offset:** the existing `pb-20 md:pb-0` bottom padding on main content already reserves space; verify it clears the tab bar height (prototype uses 84px incl. home-indicator gutter) and adjust the utility if needed.

The prototype's `m-kit` primitives become thin Tailwind components reusing existing tokens and `components/ui/*`:

| Prototype primitive | Implementation |
|---|---|
| `Screen`, `PageHead` | layout wrappers using existing type scale |
| `Card`, `Pill`, `Bar`, `ChipRow`, `SectionLabel` | map to `ui-card`, `components/ui/Pill`, `Chip`, etc. |
| `CostChrome` | **reuse existing** `src/components/layout/CostChrome.tsx` (make it render on mobile, not just `hidden md:flex`) |
| `Sheet` | existing bottom-sheet pattern |
| `BigStepper` | new shared component (count + prep + waste all use it) |
| `Avatar`, `Icon` | `Avatar` new/trivial; icons via existing Lucide usage |

New shared mobile components live in `src/components/mobile/`.

### 2.2 Roles

Map real auth roles (`ADMIN > MANAGER > STAFF`, from `UserContext` / `src/lib/auth.ts`) to the prototype's two Today variants:

- **STAFF → chef Today**
- **MANAGER / ADMIN → manager Today**

The prototype's avatar role-**toggle** is a demo affordance and is **dropped** — role comes from auth. (A manager who also cooks still sees the manager home; we do not add a personal override in this initiative.)

---

## 3. Phased breakdown

Each phase is independently shippable and ordered so later phases depend only on earlier ones.

### Phase 1 — Navigation shell + Today home + quick-add launcher

The backbone every other screen hangs off.

- **Refactor the existing mobile bottom nav** in `Navigation.tsx` into `Today · Prep · ＋ · Count · More` as in §2.1 (extract to `src/components/mobile/MobileTabBar.tsx` for focus).
- **Quick-add launcher** (`Sheet`): Log waste · Capture invoice · Scan item · Start a count. Each routes to the relevant flow (some land in later phases; until then they route to the closest existing screen).
- **`/today` route** (mobile renderer; desktop can redirect or show the existing pass). The root `/` mobile redirect lands here instead of the current STAFF→`/count` / MANAGER→`/pass` split.
  - **Manager Today:** `CostChrome` strip (reused), "Needs you" queue, prep overview (read-only progress rows → `/prep`), 2×2 quick actions.
  - **Chef Today:** resume-count banner (if an in-progress count exists), my-prep cards, service countdown, 2×2 quick actions.
- **Data binding:**
  - Cost chrome → existing `/api/insights/cost-chrome`.
  - "Needs you" → existing `/api/invoices/kpis` (review count, price-alert count) + signals data; each item deep-links to the relevant page.
  - Prep overview → prep items/logs endpoints.
  - Resume-count / service countdown → count session state + active RC service hours (the `feat/rc-service-hours` work).

### Phase 2 — Count stepper redesign (user's #1 priority)

- **Area picker** (`/count` mobile): resume card + storage-area list (counted/active/done state, value, drift). Already partially exists; align to prototype.
- **Count session (full-screen overlay):** sticky header (area · proteins, online/offline state, progress); sticky search + category chips (with counted/total per category); scrollable list grouped by category (or flat when searching); "uncounted only" toggle; finalize bar.
- **Quick-count sheet:** unit toggle (e.g. Bottle/Case/Weight), `BigStepper`, optional "+ unopened cases" stepper, live variance vs theoretical, save/clear.
- **Offline:** extend `src/lib/count-offline.ts` (already exists) — queued counts, offline indicator, "syncs on reconnect" toast.
- Non-linear: any item, any order, searchable — the explicit requirement.

### Phase 3 — Prep mobile parity

- **Three modes:** To-do, Smart prep, History (segmented control).
- **To-do:** progress overview, In-progress (live timer, Done→log sheet), To-do (Start), Done (struck, undo).
- **Smart prep:** urgency grouping (Critical/Needed/Looking good) from theoretical-stock vs par; suggestion cards with on-hand/par/`%of par` bar, add-to-plan, inline priority control; group-by station/category.
- **History:** logged yield vs par.
- **Sheets:** plan-amount (`BigStepper` "qty to make" + depletes preview), recipe + start/done (scaled ingredients + method), log-yield, new-prep-item.
- **Offline:** new `src/lib/prep-offline.ts` mirroring `count-offline.ts`; shared `SyncBar` component.
- Reuse `PrepKpiStrip`, `RecipeViewModal`, prep components where possible.

### Phase 4 — Capture flow

- **Full-screen capture overlay:** mode selector (Barcode / Invoice / Receipt), viewfinder with edge-detect reticles + scan-line animation, shutter, page-stack thumbnail. Wraps the existing `src/components/CameraCapture.tsx`.
- **Invoice review screen:** summary (lines/matched/to-review/total), extracted lines with match status, unmatched-lines warning, approve. Binds to existing invoice session APIs (`/api/invoices/sessions/*`) — approval remains the canonical spine writer; we do not add a new write path.
- **Barcode result card:** EAN, item, price/par, price-spike alert, actions (count / open in inventory / log waste).

### Phase 5 — Inbox / Signals + More hub

- **Inbox** (`/signals` or a new mobile inbox): tabbed (All/Invoices/Prices/Variance/Exceptions), item cards with impact + age, signal drill-in sheet (price spike → affected recipes), invoice match exceptions route to capture/desktop.
- **More hub:** grouped directory — Library (Inventory, Recipes, Menu), Insights (Wastage, Signals + Variance/Sales/Cost tagged **"open on desktop"**), Inbox, Setup (Suppliers/Settings tagged "open on desktop"). Venue/user card with online/offline pill.

### Phase 6 — Polish

- Wastage mobile log sheet (reason chips, station, cost-impact stepper) + offline waste queue.
- Inventory/Recipes detail-sheet alignment to prototype.
- Larger-touch density toggle (the prototype's `bigTouch`), if desired.

---

## 4. Data, offline & spine discipline

- **Real data from day one.** Every prototype mock number binds to an existing endpoint. No parallel cost storage — read `pricePerBaseUnit` at query time (CLAUDE.md spine rule). The mobile cost chrome reuses `/api/insights/cost-chrome`.
- **Offline pattern:** `count-offline.ts` is the template. Add `prep-offline.ts` and `waste-offline.ts` with the same shape (localStorage queue, pending counter, flush-on-reconnect). A shared `SyncBar` surfaces state across all three.
- **Prisma Decimal caution:** wrap `pricePerBaseUnit`, `variancePct`, etc. with `Number()` before arithmetic — they serialize as strings (CLAUDE.md).
- **Dynamic routes:** any new mutating API route must `export const dynamic = 'force-dynamic'` (CLAUDE.md infra gotcha). Most mobile work reuses existing routes, so this mainly applies if Phase 3 adds prep-sync endpoints.

---

## 5. Out of scope

- **Briefing** and **End-of-day** screens — cut by the user (depend on external integrations not yet available).
- **Native / Capacitor shell** — deferred; only camera capture would benefit and the web flow is sufficient.
- **Desktop-canonical screens** — Variance, Sales, Cost, Suppliers, Settings are **not** rebuilt on mobile. They are listed in the More hub with an "open on desktop" tag, exactly as the prototype does.
- **The role toggle** — replaced by real auth role.

---

## 6. Success criteria

- On a phone, a chef can land on Today, resume or start a count, pick any item in any order and log it (offline-capable), and plan/log prep — without touching the desktop.
- A manager can land on Today, see live food-cost chrome and the "Needs you" queue, and drill into what needs attention.
- Navigation is one thumb-reachable bottom bar; the center ＋ logs anything fast from anywhere.
- Every cost/number shown traces to `pricePerBaseUnit` via existing endpoints — no divergence bugs.
- `npm run build` passes (the only automated correctness check); each phase verified in the mobile preview.

---

## 7. Component & file inventory (new vs reused)

**New (`src/components/mobile/`):** `MobileTabBar`, `QuickAddSheet`, `BigStepper`, `SyncBar`, `Avatar`, Today screens (`TodayManager`, `TodayChef`), count session overlay + quick-count sheet, prep mode screens + sheets, capture overlay + review, inbox + signal sheet, more hub.

**New libs:** `src/lib/prep-offline.ts`, `src/lib/waste-offline.ts`.

**Reused:** `CostChrome`, `SpineAuditDrawer`, `MobileRcBar`, `CameraCapture`, `PrepKpiStrip`, `RecipeViewModal`, recipes `shared.tsx`, `InventoryItemDrawer`, `count-offline.ts`, `components/ui/*`, `RevenueCenterContext`, `UserContext`, all existing APIs.

**Modified:** `src/components/Navigation.tsx` (refactor mobile bottom nav → `Today · Prep · ＋ · Count · More`, extract to `MobileTabBar`; "All Pages" drawer → More-hub seed), `CostChrome.tsx` + `CostChromeGate.tsx` (allow mobile render on `/today`), root `/` redirect (→ `/today` for all roles on mobile), `globals.css` (tab-bar clearance if needed).
