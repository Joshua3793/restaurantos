# Smart Prep Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Smart Prep planner opens on the whole prep list by category, gives one honest "to make" number, flags wrong pars instead of acting on them, plans timing against the cooks actually on, protects bulk actions with Undo, and reviews changes before posting. The phone becomes one scroll.

**Architecture:** All new decisions live in one pure, tested library (`src/lib/prep-smart.ts`): par flags, to-make, row kinds and ordering, amounts, grid stepping, crew capacity and schedule, plan changes, cook grouping. Components only render what it returns. Crew is stored per kitchen per prep day in a new `PrepCrewDay` table behind one small route. Everything else reuses existing routes (item toggle, log edit, recipe prep PATCH, post).

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma/Postgres, Tailwind (flat tokens only), vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-smart-prep-redesign-design.md`

## Global Constraints

- Worktree `/Users/joshua/dev/fergies-os-smartprep`, branch `feat/smart-prep-redesign` (from `origin/main` de29d22d). Node: `export PATH="$HOME/Desktop/node-install/bin:$PATH"`.
- The local dev server reads and writes the **live** database. No live write (migration, crew save, par save, adding to a real list) without Joshua's yes.
- `prisma migrate dev` is broken (shadow DB). Migration = write SQL by hand → `npx prisma db execute --file … --url "$SESSION_URL"` → `npx prisma migrate resolve --applied <name>`, where `SESSION_URL` is `DATABASE_URL` with port 6543→5432 and the `pgbouncer` parameter removed.
- Tailwind: flat colour tokens only (`bg-gold-soft`, `text-red-text`); numbered colour classes are broken. Never use the class `block` inside the prep page (`.pb .block` paints a white card); use `flex`/`grid`/inline styles.
- Sub-components at module scope (never defined inside a component body).
- Pure maths in `src/lib`, covered by vitest; route files `export const dynamic = 'force-dynamic'`.
- Planner text 11 px or larger. Touch targets 44 px on phone.
- Thresholds (exact): `PAR_MAX_BATCHES = 20`, `PAR_MIN_BASE = 10` (g or ml), Undo window `10000` ms.
- Copy (exact): flags "Par looks wrong", "No par set", "Start today", "On the go"; buttons "Fix par", "Set par", "Add all N to make", "Reset N quantities to suggested", "Empty the list…", "Review & post", "Post N changes" / "Post N items", "Keep editing"; group label "Start today — needed <when>"; passed deadline "Now".
- Commit after each task; end commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A wrong par must never leak into an action**: a flagged item reached through "Add all", the step view, a search or the phone must not be added with its 376-batch quantity. (Task 1 test `isToMake excludes flagged`; Task 6 test `addAllToMake ids never include a flagged item`.)
2. **Undo after the server already changed**: emptying the list, then Undo, must restore each item's quantity, note, cook and order, including items whose request failed. (Task 6 test `snapshot restores every field`.)
3. **No crew ticked / no services today**: crew capacity and won't-fit must go quiet, not show "0 min of hands" or divide by zero. (Task 4 tests `null without crew`, `null without ctx`.)
4. **Cooking jobs**: an IN_PROGRESS item on the draft must not appear as a draft row, in reset, in empty, or as won't fit, and must still appear in the On the go strip. (Task 4 test `crewSchedule skips pipeline`; Task 6 test `emptyList keeps cooking jobs`.)
5. **Units across the formatter change**: 0.5 l, 17055 g, 1250 ml, 49 each and a `batch`-unit item must all format correctly, and stepping a `batch`-unit item must still go by 1. (Task 2 tests.)

---

### Task 1: Par flags, "to make", row kinds and category sections

**Files:**
- Create: `src/lib/prep-smart.ts`
- Test: `src/lib/__tests__/prep-smart.test.ts`

**Interfaces:**
- Consumes: `BatchFields`, `batchYield`, `suggestedDraftQty`, `mustStartToday`, `effectiveUrgency`, `URGENCY_ORDER`, `PlanDayContext` from `prep-plan.ts` / `prep-utils.ts`; `UNIT_FACTORS` from `uom.ts`.
- Produces:
  - `export const PAR_MAX_BATCHES = 20`, `export const PAR_MIN_BASE = 10`
  - `export type ParFlag = 'WRONG' | 'NONE' | null`
  - `export function parFlag(t: BatchFields): ParFlag`
  - `export type SmartItem = BatchFields & { id: string; name: string; category: string; isOnList: boolean; prepEnabled?: boolean }`
  - `export function isToMake(t: SmartItem, ctx: PlanDayContext | null, nowMin: number): boolean`
  - `export function toMakeCount(items: SmartItem[], ctx: PlanDayContext | null, nowMin: number): number`
  - `export type RowKind = 'MAKE' | 'FLAG' | 'LISTED' | 'COOKING' | 'ATPAR'`
  - `export function rowKind(t: SmartItem, ctx, nowMin): RowKind`
  - `export type PrepFilter = 'ALL' | 'MAKE' | 'FIX' | 'NOPAR'`
  - `export function matchesFilter(t: SmartItem, f: PrepFilter, ctx, nowMin): boolean`
  - `export function filterCounts(items: SmartItem[], ctx, nowMin): Record<PrepFilter, number>`
  - `export interface PrepSection<T> { key: string; label: string; rows: T[]; toMake: number; listed: number; cooking: number; flagged: number }`
  - `export function prepListSections<T extends SmartItem>(items: T[], opts: { ctx: PlanDayContext | null; nowMin: number; ord?: (t: T) => number }): PrepSection<T>[]`

Rules:
- `parFlag`: `NONE` when `parLevel <= 0` and no `targetToday > 0`. `WRONG` when (a) `batchYield(t)` is known and `parLevel / batchYield > PAR_MAX_BATCHES`, or (b) the unit is weight or volume and `parLevel × UNIT_FACTORS[unit].toBase` is below `PAR_MIN_BASE` (and above 0). Otherwise null.
- `isToMake`: `prepEnabled !== false && !isOnList && !pipeline && parFlag === null && (suggestedDraftQty(t) > 0 || mustStartToday(t, ctx, nowMin))`.
- `rowKind` precedence: COOKING (pipeline) → LISTED (isOnList) → FLAG (parFlag) → MAKE (isToMake) → ATPAR.
- `matchesFilter`: ALL is true; MAKE is `isToMake`; FIX is `parFlag === 'WRONG'`; NOPAR is `parFlag === 'NONE'`.
- Sections: one per category, alphabetical. Row order MAKE → FLAG → LISTED → COOKING → ATPAR. MAKE sorts by `URGENCY_ORDER.indexOf(effectiveUrgency(t))`, then `ord`. The rest sort by `ord`, then name.

- [ ] **Step 1: Write the failing tests.** Fixtures copy live values:
  - Kimchi: par 5000 kg, yield 13.25 kg → `WRONG`.
  - Hollandaise: 4 g, no recipe yield → `WRONG`.
  - Pickle Apples: 0.002 kg → `WRONG`.
  - Caramelized Pumpkin Base: 2000 g, yield 350 g → `null`.
  - Charred Corn: par 0 → `NONE`.
  - par 0 with `targetToday` 2 → `null`.
  - Buttermilk Biscuits: 100 each, yield 49 each → `null`.
  - `isToMake excludes flagged`: Kimchi with onHand 13.6 → false.
  - `isToMake excludes on-list, cooking, switched-off`.
  - `toMakeCount` over a mixed list equals the hand count.
  - `prepListSections` puts Baked Goods before Base Preparations, and orders [Adobo (MAKE, PASS), Dashi (MAKE, TMRW), Sourdough Starter (FLAG), Biscuits (LISTED), Focaccia (COOKING), Beef Tallow (ATPAR)] in that order inside one category.
  - `filterCounts` returns `{ALL, MAKE, FIX, NOPAR}`.
- [ ] **Step 2:** Run `npx vitest run src/lib/__tests__/prep-smart.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement the Produces list in `src/lib/prep-smart.ts`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(prep): Smart Prep par flags, to-make and category sections`.

### Task 2: Readable amounts and grid stepping

**Files:**
- Modify: `src/lib/prep-smart.ts` (add), `src/lib/prep-plan.ts` (private `fmtQ` at ~:205 → `fmtAmount`/`fmtAmountOf`), `src/components/prep/planner/atoms.tsx` (`fmtUom`, `QtyStepper`), `src/components/prep/planner/DraftRow.tsx` and `SuggestionRow.tsx` (local `fmtQ`)
- Test: `src/lib/__tests__/prep-smart.test.ts`; update string expectations in `prep-plan.test.ts`, `prep-plain-reason.test.ts`, `prep-plan-shortfall.test.ts` only where the new formatting changes them

**Interfaces:**
- Produces:
  - `export function fmtAmount(q: number, unit: string): string`
  - `export function fmtAmountOf(have: number, need: number, unit: string): string`
  - `export function stepOnGrid(val: number, step: number, dir: 1 | -1): number`
  - `export function onGrid(val: number, step: number): boolean`

Rules:
- `fmtAmount`:
  - g ≥ 1000 → kg; ml ≥ 1000 → L; `l` prints as `L`.
  - kg/L show at most one decimal, trailing `.0` dropped.
  - g/ml/each/portion are rounded, with a thousands separator.
  - Examples: 17055 g → `17.1 kg`; 2000 g → `2 kg`; 900 g → `900 g`; 0.5 l → `0.5 L`; 13 l → `13 L`; 49 each → `49 each`; 12.9 kg → `12.9 kg`.
- `fmtAmountOf`: picks the display unit from the larger of the two values, so 17055 of 2000 g → `17.1 of 2 kg`.
- `stepOnGrid`:
  - up: `(floor(val/step + 1e-9) + 1) × step`
  - down: `max(step, (ceil(val/step − 1e-9) − 1) × step)`
  - the result is cleaned with `+x.toFixed(2)`
  - Examples: 1.3/0.5 up → 1.5; 1.5 up → 2; 1.3 down → 1; 0.5 down → 0.5; 430/25 up → 450; 7/1 down → 6.
- `onGrid`: `abs(val/step − round(val/step)) < 1e-6`.

- [ ] **Step 1: Write the failing tests** for each example above, plus `stepOnGrid` with a `batch`-unit item (step 1).
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3:** Implement the helpers. Then wire them in:
  - In `prep-plan.ts`, `plainReason`/`whyLabel` use `fmtAmountOf`/`fmtAmount` in place of the private `fmtQ`.
  - Remove the local `fmtQ`/`fmtUom` copies and use `fmtAmount`.
  - In `QtyStepper`, −/+ call `set(stepOnGrid(val, step, ∓1))`. The value shows `text-gold-2` when `!onGrid(val, step)` (in addition to the existing overridden tint).
- [ ] **Step 4:** Run `npm test`. Expected: all pass. Update only the string expectations the formatting changed, e.g. `0 of 2000 g` → `0 of 2 kg`, and keep each test's intent.
- [ ] **Step 5:** Commit `feat(prep): readable amounts and half-batch grid stepping`.

### Task 3: Deadline words — "Start today — needed …" and "Now"

**Files:**
- Modify: `src/lib/prep-plan.ts` (`planGroups` urgency branch ~:775; add helpers), `src/components/prep/planner/atoms.tsx` (`UrgPicker` deadline text)
- Test: `src/lib/__tests__/prep-plan-cadence.test.ts` (the long-lead describe at :95)

**Interfaces:**
- Produces:
  - `export function fmtDeadlineWords(m: number, fmtClock: (min: number) => string): string`: `today 15:00` / `tomorrow 15:00` / `in 3 days 15:00`.
  - `export function deadlineLabel(m: number, nowMin: number, fmtClock): string`: `Now` when `m <= nowMin`, else `fmtDeadline(m, fmtClock)`.
- `planGroups` START group: `label = 'Start today — needed ' + fmtDeadlineWords(first, fmtClock)` (plus `' and later'` when they differ). Remove the "runway" sub.

- [ ] **Step 1:** Add the failing tests.
  - The label for a cure due tomorrow 15:00 is `Start today — needed tomorrow 15:00`.
  - `deadlineLabel(540, 700, …)` → `Now`.
  - `deadlineLabel(900, 700, …)` → `15:00`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the helpers. `UrgPicker` shows `deadlineLabel(...)` (it needs a `nowMin` prop, passed from the planners).
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(prep): plain deadline words on Smart Prep`.

### Task 4: Crew capacity, crew schedule, cook groups, plan changes

**Files:**
- Modify: `src/lib/prep-plan.ts` (extract the per-row timing `planSchedule` uses into `export function slotInputs(t, ctx): { active: number; passive: number; earliest: number; deadline: number }`; `planSchedule` calls it, behaviour unchanged), `src/lib/prep-smart.ts`
- Test: `src/lib/__tests__/prep-smart.test.ts`; the existing `deadlines + schedule` and pipeline schedule tests must stay green untouched

**Interfaces:**
- Produces:
  - `export interface CrewCapacity { hands: number; needs: number; fits: boolean }`
  - `export function crewCapacity(draft: SmartItem[], crewSize: number, ctx: PlanDayContext | null): CrewCapacity | null`
    - null when `crewSize < 1` or no ctx
    - `hands = crewSize × max(0, ctx.close − ctx.shiftStart)`
    - `needs` = Σ active minutes (pipeline rows: `remainingActiveMinutes`)
  - `export function crewSchedule(draft: SmartItem[], crewSize: number, ctx: PlanDayContext | null, nowMin: number, ord?): Map<string, PlanSlot>`
    - empty map when `crewSize < 1` or no ctx
    - one pool of `crewSize` cursors starting at `shiftStart`, ordered like `planSchedule` (deadline, urgency, earliest, ord)
    - pipeline rows and rows with `deadline <= nowMin` get `fits: true, over: 0` but still use a cursor
  - `export function wontFitText(slot: PlanSlot, crewSize: number, fmtClock): string`: `won't be ready by 15:00 — 1 h 20 min over with 2 cooks` (uses `fmtDur` from `prep-steps.ts`; "1 cook" singular)
  - `export function cookGroups<T extends SmartItem & { todayLog?: { assignedTo?: string | null } | null }>(draft: T[], cooks: { id: string; name: string }[], crewIds: string[]): Array<{ key: string; label: string; rows: T[] }>`: crew members first in `crewIds` order, then other assigned cooks, then `Open` last; empty groups dropped
  - `export interface PlanChanges<T> { added: T[]; removed: T[]; unchanged: number; cooking: T[] }`
  - `export function planChanges<T extends SmartItem & { todayLog?: { postedAt?: string | null; status?: string } | null }>(all: T[]): PlanChanges<T>`
    - added = on list, not cooking, no `postedAt`
    - removed = `postedAt` set, not on list, status not DONE/PARTIAL/SKIPPED
    - cooking = on list with pipeline
    - unchanged = on list, posted, not cooking

- [ ] **Step 1: Write the failing tests.**
  - `crewCapacity`: null without crew; null without ctx; 2 cooks from 11:40 to 15:00 → hands 400, needs Σ, fits.
  - `crewSchedule`: skips pipeline; a passed deadline never fails; an over-long Focaccia gets `over = 80` with 2 cooks.
  - `wontFitText` gives the exact string.
  - `cookGroups` order.
  - `planChanges` with one item of each kind.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Extract `slotInputs` and implement.
- [ ] **Step 4:** Run `npm test`. Expected: all pass, including the untouched schedule tests.
- [ ] **Step 5:** Commit `feat(prep): crew capacity and schedule for Smart Prep`.

### Task 5: Who's on today — storage and route

**Files:**
- Modify: `prisma/schema.prisma` (add `PrepCrewDay` + the back-relation on `RevenueCenter`)
- Create: `prisma/migrations/20261117000000_prep_crew_day/migration.sql`, `src/app/api/prep/plan/crew/route.ts`
- Test: `src/app/api/prep/plan/crew/__tests__/route.test.ts` (light harness like `logs/__tests__/route.test.ts`: `vi.mock('@/lib/prisma')`, `@/lib/auth`, `@/lib/rc-scope`)

**Interfaces:**
- Produces:
  - `model PrepCrewDay { id String @id @default(uuid()); revenueCenterId String; listDate DateTime; cookIds Json @default("[]"); updatedAt DateTime @updatedAt; revenueCenter RevenueCenter @relation(...); @@unique([revenueCenterId, listDate]) }`
  - `GET /api/prep/plan/crew?rc=<id>` → `{ cookIds: string[] }`: `requireSession()`; `[]` when there is no row; `listDate = prepDayStart()`.
  - `PUT /api/prep/plan/crew` body `{ revenueCenterId: string; cookIds: string[] }` → `{ cookIds }`:
    - auth: `requireSession()` + `assertRcWritable(user, rcId)`
    - validates `cookIds`: an array of at most 50 unique strings, each an active `Cook` id (unknown ids are dropped)
    - upsert on `(revenueCenterId, listDate)`
  - Both handlers: `export const dynamic = 'force-dynamic'`; `AuthError` → its status.

- [ ] **Step 1:** Write the failing route tests.
  - GET with no row → `[]`.
  - PUT stores the deduped, known ids.
  - PUT with a non-array → 400.
  - A read-only RC → 403 (`assertRcWritable` throws).
  - Unknown ids are dropped.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Add the model, then `npx prisma generate`. Write `migration.sql`: CREATE TABLE plus the unique index and foreign key, matching what `npx prisma migrate diff --from-schema-datamodel <origin schema> --to-schema-datamodel prisma/schema.prisma --script` prints. Implement the route.
- [ ] **Step 4:** Run the route tests and `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(prep): store who's on today per kitchen`.
- [ ] **Step 6: STOP — ask Joshua** before applying the migration to the live database. It is additive: one new empty table. After his yes, run `db execute` + `migrate resolve --applied 20261117000000_prep_crew_day`. Verify with a GET from the dev server returning `{"cookIds":[]}`.

### Task 6: Page wiring — counts, crew, bulk with Undo, Fix par

**Files:**
- Modify: `src/app/prep/page.tsx` (handlers ~:1295–1341 and `plannerHandlers` ~:1485; badges :1746 and :1823), `src/components/prep/PrepToast.tsx` (`ACTION_MS = 10000`), `src/components/prep/planner/PlannerDesktop.tsx` (`PlannerHandlers`)
- Create: `src/lib/prep-bulk.ts` (pure snapshot and selection helpers)
- Test: `src/lib/__tests__/prep-bulk.test.ts`

**Interfaces:**
- Produces in `prep-bulk.ts`:
  - `export function addAllToMakeIds(items: SmartItem[], ctx, nowMin): string[]`
  - `export interface DraftSnapshot { id: string; isOnList: boolean; requiredQty: number | null; note: string | null; assignedTo: string | null; listOrder: number | null }`
  - `export function snapshotDraft(items: Array<SmartItem & { todayLog?: … }>): DraftSnapshot[]`
  - `export function resetTargets(draft, …): Array<{ id: string; from: number; to: number }>`: only rows where `|requiredQty − defaultDraftQty| > 0.01` and not cooking; uses `longLeadQty` when `mustStartToday`
  - `export function emptyListIds(draft): string[]`: excludes cooking
- `PlannerHandlers` changes:
  - `onAcceptSuggested` → `onResetQuantities`
  - `onAddAllCritical` → `onAddAllToMake`
  - `onClearDraft` → `onEmptyList`
  - adds `onFixPar(item, parLevel: number): Promise<boolean>` and `onCrewChange(cookIds: string[]): void`
- `canFixPar = canSwitch` (lead and above, the existing prep-switch gate at page.tsx:308) is passed to both planners.
- Page state: `crewIds: string[]`, loaded on RC change. `toMake = toMakeCount(items, dayCtx, nowMin)` feeds both tab badges and the planners.
- Undo toasts (exact):
  - `Added N to your list`
  - `N quantities reset to suggested`
  - `List emptied — N taken off`
  - each with an `Undo` action that replays the snapshot through `handleToggleOnList`/`handleDraftEdit`
- Any failed request → `toast("Couldn't save every change — the list was reloaded")` + `load(true)`.
- `onFixPar`:
  1. Optimistically set `parLevel` on the item.
  2. Send `PATCH /api/recipes/{linkedRecipeId}` with `{ prep: { parLevel } }`.
  3. On failure, revert and show `toast("Par not saved")`.
  4. Call `load(true)`.

- [ ] **Step 1: Write the failing tests** for `prep-bulk.ts`:
  - `addAllToMakeIds never includes a flagged item`
  - `emptyList keeps cooking jobs`
  - `snapshot restores every field` (round-trip of qty, note, cook, order)
  - `resetTargets skips equal rows`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `prep-bulk.ts`, then wire the page handlers, badges, crew GET/PUT (optimistic, reverting on failure) and the toast duration.
- [ ] **Step 4:** Run `npm test` and `npm run build`. Expected: green; API routes `ƒ (Dynamic)`.
- [ ] **Step 5:** Commit `feat(prep): one to-make count, crew, safe bulk actions with Undo, Fix par`.

### Task 7: Computer view — prep list pane, rows, par editor, crew bar, your list

**Files:**
- Create: `src/components/prep/planner/PrepListPane.tsx`, `ParEditor.tsx`, `CrewBar.tsx`, `GoStrip.tsx`
- Modify: `SuggestionRow.tsx` (becomes the five-kind `PrepRow`, export renamed), `PlannerDesktop.tsx`, `DraftRow.tsx`, `atoms.tsx` (`AssignPill` gets `crewIds?: string[]`)
- Delete: `SuggestionList.tsx`, and `LoadStrip` from `PlannerDesktop.tsx`

**Interfaces:**
- `PrepListPane` props:
  - `items: PrepItemRich[]`, `hidden: PrepItemRich[]`
  - `view: 'CATEGORY' | 'STEP'`, `onView`
  - `filter: PrepFilter`, `onFilter`
  - `ctx`, `nowMin`, `ord`
  - `locked: boolean`, `canFixPar: boolean`
  - `showJump: boolean`, `compact: boolean`
  - `handlers: Pick<PlannerHandlers, 'onOpen' | 'onAdd' | 'onRemove' | 'onFixPar'>`
- `PrepListPane` renders:
  - chips: Everything / To make / Par to fix / No par set, with `filterCounts`
  - the Category | Step switch
  - the category jump row (when `showJump`; scrolls to `#cat-<slug>`)
  - in CATEGORY view: `prepListSections`
  - in STEP view: `planGroups(..., 'urgency', { startToday })`, with at-par rows folded into `+ N at par · Show` per group and flagged rows in their own "Par to fix" group
  - `HiddenGroup` last
- `PrepRow` kinds, per spec:
  - MAKE: the gold 44 px + (`h-11 w-11`)
  - FLAG: the flag and Fix par / Set par (when `canFixPar`, otherwise the flag only)
  - LISTED: "✓ On your list"; a tap removes it
  - COOKING: a gold row with the ready time
  - ATPAR: one line, with a quiet + that adds
  - the reason line always visible (`plainReason`)
- `ParEditor`:
  - a popover anchored to the button
  - stepper using `stepOnGrid` with `prepStep(unit)`; the number is typeable
  - `was <fmtAmount(old)>`
  - the result sentence:
    - at par: `With <new>, <name> reads at par (<onHand> on hand) — nothing to make.`
    - otherwise: `With <new>, Smart Prep suggests <batches or amount>.`
  - Save calls `onFixPar` and closes on success
- `CrewBar` props: `cooks`, `crewIds`, `onCrewChange`, `capacity: CrewCapacity | null`, `ctx`, `locked`.
  - Chips: crew first, then the next names up to 6, then "+ more" (a popover with every cook).
  - Text: `<fmtDur(hands)> of hands until <close> · list needs <fmtDur(needs)> — fits` or `— N h M min short`.
  - With no crew: `Tick who's on to check timing`.
- `GoStrip`: draft items with `pipeline`, as chips `<name> · ready HH:MM` or `wait done`. Opens the drawer.
- `PlannerDesktop` Your list:
  - `GoStrip` on top
  - rows exclude pipeline items
  - group switch By step | By cook (`cookGroups`)
  - `WontFit` uses `crewSchedule` + `wontFitText`
  - footer `N changes not posted` + names (from `planChanges`) + Review & post
  - bulk buttons with live counts: Add all N to make, Reset N quantities to suggested (hidden at 0), Empty the list… (opens a confirm: `Take N off the list? Jobs on the go stay.`)

- [ ] **Step 1:** Run `npm run build`. Expected: PASS before the change (baseline).
- [ ] **Step 2:** Implement the components and the PlannerDesktop changes. Before writing a class name, grep `prep-board.css` and `globals.css` for it to avoid style clashes.
- [ ] **Step 3:** Run `npm run build` and `npm test`. Expected: green.
- [ ] **Step 4:** Run the dev server from the worktree (launch.json entry `Smart prep worktree`, port 3115). Open `/prep` → Smart Prep and check by reading only (no clicks that save):
  - it opens on Category with Everything
  - Kimchi, Hollandaise, Sourdough Starter and Pickle Apples show "Par looks wrong"
  - the 9 par-0 items show "No par set"
  - the tab badge equals the "To make" chip
  - Apple Sauerkraut (if cooking) sits in On the go
  - with no crew there are no won't-fit lines
- [ ] **Step 5:** Commit `feat(prep): Smart Prep computer view — whole list by category, crew, on the go`.

### Task 8: Review before posting

**Files:**
- Modify: `src/components/prep/planner/PostDialog.tsx`, the callers in `PlannerDesktop.tsx` / `PlannerMobile.tsx`

**Interfaces:**
- `PostDialog` props become `{ all: PrepItemRich[]; draft: PrepItemRich[]; cooks: Cook[]; crewIds: string[]; ctx; nowMin: number; reposting: boolean; onClose; onConfirm: (dues: PostDue[]) => void }`. `PostDue` and the dues computation are unchanged.
- Renders:
  - **What changes · N**, from `planChanges`:
    - `+` rows for added (qty in batches, deadline label, cook or "open")
    - `−` rows for removed
    - `= N unchanged`
    - `● N jobs on the go — stay exactly as the cooks left them`
  - **Before you post** alerts:
    - green fits / red short (from `crewCapacity`), or neutral `Tick who's on to check timing`
    - gold `N jobs have no cook — anyone can claim them from the To Do`
    - red `N pars look wrong (names) — they stay off the list until fixed`
  - the line `Quantity and note changes already show on the To Do.`
  - buttons: `Post N changes` (reposting) / `Post N items` (first post), and `Keep editing`

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `npm run build`. Expected: PASS.
- [ ] **Step 3:** On the dev server, open Review & post and read the sheet. Don't post.
- [ ] **Step 4:** Commit `feat(prep): review what changes before posting`.

### Task 9: Phone — one scroll

**Files:**
- Modify: `src/components/prep/planner/PlannerMobile.tsx`

**Interfaces:**
- Remove the `tab` state and the `Segmented` control.
- Order of sections:
  1. header: date, title, `N more to make. M changes not posted.`
  2. `CrewBar` (compact)
  3. Your list pane: first 2 rows, then `+ N more · M on the go`, then `Open ▾` to expand to the full list with the `GoStrip`
  4. `PrepListPane` (compact, no jump row; the view switch is a `Category ▾` menu)
- Reorder arrows are 44×44 (`h-11 w-11`). The remove X is 44×44.
- The post bar stays fixed. The scroll content ends with a spacer of the bar's height, so the bar never covers the last card.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `npm run build`. Expected: PASS.
- [ ] **Step 3:** On the dev server, set the phone size (375×812). Check:
  - one scroll
  - the last card can scroll fully above the post bar
  - no horizontal scroll
  - every button is at least 44 px (`javascript_tool`: list buttons under 44 px in the planner)
- [ ] **Step 4:** Commit `feat(prep): Smart Prep phone is one scroll`.

### Task 10: Text sizes sweep and final checks

**Files:**
- Modify: every file in `src/components/prep/planner/`

- [ ] **Step 1:** Run `grep -nE "text-\[(8|8\.5|9|9\.5|10|10\.5)px\]" src/components/prep/planner/*.tsx`. Raise each match to `text-[11px]` or larger, keeping the hierarchy. Expected after the change: no output.
- [ ] **Step 2:** Run `npm test` and `npm run build`. Expected: all green; API routes `ƒ (Dynamic)`.
- [ ] **Step 3:** On the dev server (computer and phone sizes), use the measure script from the design-board check: no text overflowing a button or chip, no label wrapping inside a chip, contrast at least 4.5:1 on text. Fix any finding.
- [ ] **Step 4:** Commit `style(prep): Smart Prep labels 11 px and up`.
- [ ] **Step 5:** Whole-branch review (fresh reviewer), one fix pass, then hand to Joshua for the live test: crew, Fix par, add, reset, empty with Undo, and post on a quiet hour, on one item he names.
