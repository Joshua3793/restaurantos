# Prep To Do — Step Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A started prep job stays in one "On the go" lane, moves one method step at a time with a Next button whose look says work vs wait, has Back in the drawer, keeps its place on Stop, and rings an alarm when a wait ends.

**Architecture:** A pure lib flattens a recipe method into a *cook sequence* (STEP items and WAIT items). The live `PrepLog` gains a step cursor (`stepKey`, `stepEnteredAt`); every cursor move also keeps the existing chain fields (`stageIndex`/`stageEnteredAt`/`stageHistory`) in sync through one pure function used by both the API route and the optimistic client, so ladder timing, rest info, pipeline and the start page keep working untouched. The run sheet replaces Working On + Waiting with one lane of job cards; the drawer gains a cook-mode block; a client hook drives the wait alarm.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Tailwind (flat tokens) · Lucide · vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-prep-todo-step-flow-design.md` · design board https://claude.ai/artifact/XoEFyrr2PTyWdBX32gRpPh

## Global Constraints

- Branch from **origin/main** in an isolated worktree (local `main` is stale; `npm run build` bogus-fails in the main checkout while dev runs).
- Toolchain: `export PATH="$HOME/Desktop/node-install/bin:$PATH"`; env: `set -a && . ./.env; set +a`.
- Migrations: NOT `prisma migrate dev` (shadow DB broken). Use `migrate diff` → `db execute` → `migrate resolve --applied`, with the **session-mode pooler** URL (`$DATABASE_URL`, port 6543→5432, drop `pgbouncer`). The migration is additive (two nullable columns) and is applied to the **live** database — get Joshua's yes before running `db execute`.
- The local dev server talks to the **live** database. Browser checks that tap Start / Next / Stop write real prep logs: ask Joshua which item to use first, and Stop + reopen state afterwards.
- Tailwind: flat tokens only (`bg-blue-soft`, `text-green-text`, `border-line-2`…); numbered colour classes are broken.
- No `backdrop-blur` on any fixed full-screen scrim.
- Sub-components at module scope (never defined inside a component body).
- Wait keys use the chain convention `${stepKey}:wait`.
- Copy (exact): `Next step`, `Next: <phase>`, `Start wait: <phase>`, `Resting · <left> left`, `Ready early? Open to move on`, `Move on early`, `Log yield`, `Stop for now`, `Mute alarms on this device`, section title `On the go`, sub `stays here until done`.
- Nothing ever credits stock except DONE/PARTIAL through the Log yield sheet (unchanged).
- Run `npm test` after each lib task; `npm run build` after each UI task.

## Review Focus

1. **Jobs already in flight when this ships** (`stageIndex` set, `stepKey` null) must resume at the first step of their current block, not step 1 → Task 1 test `cursorOf falls back to the stage block`.
2. **Recipe edited mid-job** (saved `stepKey` no longer in the method) → fall back to the stage block, then 0; never throw → Task 1 test `cursorOf ignores an unknown stepKey`.
3. **Merged waits** (Smoked Pork Belly: a 0-minute "temper" step with a wait straight after another wait) → the WAIT item's own minutes drive its timer; the chain stays on the merged PASSIVE block → Task 1 tests on the merged fixture.
4. **Offline / rapid taps** — Next twice offline, or Next then Log yield fast, replay in tap order and land on the right step → Task 3 test `replays step moves in order`.
5. **Sound blocked or missing** (no `AudioContext`, iPhone silent switch, autoplay blocked before the first tap) → banner still shows, no error thrown; the repeat schedule is pure → Task 4 tests on `alarmShouldRing`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/prep-steps.ts` (new) | Cook sequence, cursor, Next action copy, the one cursor-move function |
| `src/lib/prep-on-the-go.ts` (new) | Lane order + alarm due/repeat rules (pure) |
| `prisma/schema.prisma` + new migration | `PrepLog.stepKey`, `PrepLog.stepEnteredAt` |
| `src/app/api/prep/logs/[id]/route.ts` | Accept `stepKey`; Stop keeps place; clear cursor on finish |
| `src/app/api/prep/plan/remove-item/route.ts` | Clear cursor with progress |
| `src/lib/prep-items-server.ts`, `src/components/prep/types.ts` | Ship `linkedRecipe.method`; log type gains cursor |
| `src/lib/prep-plan.ts` | `stageFieldsForStatus`: NOT_STARTED keeps place |
| `src/lib/prep-offline.ts`, `src/app/prep/page.tsx` | `'step'` mutation + `handleStepChange` |
| `src/components/prep/runsheet/step-ui.tsx` (new) | `StepTrack`, `NextButton`, `JobMenu` |
| `src/components/prep/runsheet/JobCard.tsx`, `JobCardMobile.tsx` (new) | On-the-go cards |
| `src/components/prep/runsheet/useWaitAlarms.ts`, `AlarmBanner.tsx` (new) | Alarm hook + banner |
| `src/components/prep/runsheet/RunSheet.tsx`, `RunSheetMobile.tsx` | One lane, banner, hairline, remembered cook, caption |
| `src/components/prep/CookMode.tsx` (new), `PrepDrawer.tsx`, `PrepRecipeSection.tsx` | Drawer cook mode; no auto-advance on tick |
| Delete after Task 6: `WorkingRow.tsx`, `WorkingRowMobile.tsx`, `RestRow.tsx`, `RestRowMobile.tsx` | (grep first — delete only if nothing imports them) |

---

### Task 1: Cook sequence and the cursor move (pure)

**Files:**
- Create: `src/lib/prep-steps.ts`
- Test: `src/lib/__tests__/prep-steps.test.ts`

**Interfaces:**
- Consumes: `MethodStep`, `chainBlocks`, `methodToChain` (`src/lib/recipe-method.ts`); `restState`, `appendStageEvent`, `StageEvent`, `RestState` (`src/lib/prep-stages.ts`); `fmtMins` (`src/lib/prep-runsheet.ts`).
- Produces:
```ts
export type CookItem =
  | { kind: 'STEP'; key: string; stepKey: string; number: number; text: string; phase: string | null; minutes: number; chainIndex: number | null; chainKey: string | null }
  | { kind: 'WAIT'; key: string; stepKey: string; minutes: number; note: string | null; phase: string | null; chainIndex: number | null; chainKey: string | null }
export function cookSequence(method: MethodStep[] | null | undefined): CookItem[] | null
export interface CursorLog { status?: string; stepKey?: string | null; stepEnteredAt?: string | null; stageIndex?: number | null; stageEnteredAt?: string | null; stageHistory?: unknown }
export function cursorOf(seq: CookItem[], log: CursorLog | null | undefined): number
export interface WaitClock { readyAtMs: number; leftMin: number; state: RestState }
export function waitClock(item: CookItem & { kind: 'WAIT' }, log: CursorLog, nowMs: number): WaitClock | null
export type NextKind = 'work' | 'wait' | 'held' | 'ready' | 'log'
export interface NextAction { kind: NextKind; to: number | null; label: string; sub: string }
export function nextAction(seq: CookItem[], pos: number, clock: WaitClock | null): NextAction
export interface StepMove { stepKey: string; stepEnteredAt: string; stageIndex?: number; stageEnteredAt?: string; stageHistory?: StageEvent[] }
export function stepMoveFields(seq: CookItem[], log: CursorLog, stepKey: string, nowIso: string, byCookId?: string | null): StepMove | null
```

Rules the tests pin:
- `cookSequence`: null for null/empty method. One STEP per method step in order, `number` = 1-based step number, `phase` = phase in effect (carried down), `minutes` = `step.minutes ?? 0`; a step with `wait` is followed by a WAIT item, `key = ${stepKey}:wait`, `phase` = phase in effect. `chainIndex`/`chainKey` come from `chainBlocks`/`methodToChain`: a STEP maps to the ACTIVE block listing its key, else (merged-wait case) the PASSIVE block listing it; a WAIT maps to the PASSIVE block listing its step. Untimed method (no minutes, no waits) → items with `chainIndex: null`, `chainKey: null`.
- `cursorOf`: position of `log.stepKey` if found; else the first item whose `chainIndex === log.stageIndex`; else 0.
- `waitClock`: null unless `log.stepEnteredAt`; `readyAtMs = stepEnteredAt + minutes·60 000`; `leftMin = ceil(max(0, readyAt − now)/60 000)`; `state = restState(readyAtMs, nowMs)`.
- `nextAction`: last item → `{kind:'log', to:null, label:'Log yield', sub:''}` (the card fills the qty). Current is WAIT: clock state `resting` → `held`, label `Resting · ${fmtMins(left)} left`, sub `Ready early? Open to move on`; otherwise `ready`, label/sub as for `work`. Next item WAIT → `wait`, label `Start wait: ${phase ?? 'Wait'}`, sub `fmtMins(minutes)`. Next item STEP → `work`, label `Next step` when its phase equals the current item's phase, else `Next: ${phase ?? 'next step'}`; sub `Hands-on · ${fmtMins(minutes)}`, or `Hands-on` when minutes is 0. `to` = pos + 1.
- `stepMoveFields`: null when `stepKey` is not in `seq`. Always sets `stepKey`, `stepEnteredAt = nowIso`. When the target's `chainIndex` is non-null and differs from `log.stageIndex`, also sets `stageIndex`, `stageEnteredAt = nowIso`, `stageHistory = appendStageEvent(log.stageHistory, { index, key: chainKey, enteredAt: nowIso, ...(byCookId ? { byCookId } : {}) })`.

- [ ] **Step 1: Write the failing tests.** Fixtures: `SOURDOUGH` = first 6 steps of the real recipe (step1 5m + wait 30 "loosely covered" phase Autolyse; step2 5m phase Mix; step3 5m; step4 3m; step5 2m phase "Bulk Ferment" + wait 30; step6 1m); `PORK` = `[a 5m + wait 1440, b 0m + wait 30, c 10m + wait 165, d 10m]` (b's wait merges into a's PASSIVE block); `PLAIN` = 3 steps, no minutes, no waits. Tests:
  - `cookSequence(SOURDOUGH)` keys = `['s1','s1:wait','s2','s3','s4','s5','s5:wait','s6']`; `[2].phase === 'Mix'`, `[3].phase === 'Mix'` (carried); `[1].chainIndex === 1`, `[2].chainIndex === 2`.
  - merged: `cookSequence(PORK)` — STEP `b` and WAIT `b:wait` both have `chainIndex === 1` (the PASSIVE block) and `b:wait.minutes === 30`.
  - `cookSequence(PLAIN)` → 3 STEP items, all `chainIndex === null`; `cookSequence([])` and `cookSequence(null)` → null.
  - `cursorOf falls back to the stage block`: `{ stageIndex: 2 }` on SOURDOUGH → 2 (`s2`).
  - `cursorOf ignores an unknown stepKey`: `{ stepKey: 'gone', stageIndex: 2 }` → 2; `{ stepKey: 'gone' }` → 0.
  - `waitClock` on `s1:wait` entered at 10:00, now 10:12 → `leftMin 18`, `state 'resting'`; now 10:31 → `'ready'`; now 11:31 → `'overdue'`.
  - `nextAction` at `s2` → `{kind:'work', label:'Next step', sub:'Hands-on · 5m'}`; at `s4` → `{kind:'work', label:'Next: Bulk Ferment'}`; at `s5` → `{kind:'wait', label:'Start wait: Bulk Ferment', sub:'30m'}`; at `s5:wait` with resting clock → `kind 'held'`, `label 'Resting · 18m left'`; with ready clock → `kind 'ready'`, `label 'Next step'`… (s6 shares the Bulk Ferment phase); at last item → `kind 'log'`. (`fmtMins` prints `5m`, `30m`, `4h`, `2h45`.)
  - `stepMoveFields` `s2`→`s3` (same block): no `stageIndex` key; `s5`→`s5:wait`: `stageIndex 3`, history gains `{index:3, key:'s5:wait'}`; unknown key → null; PLAIN move → only `stepKey`/`stepEnteredAt`.
- [ ] **Step 2: Run** `npx vitest run src/lib/__tests__/prep-steps.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** the signatures above in `src/lib/prep-steps.ts`.
- [ ] **Step 4: Run** the same command — expect PASS; then `npm test` — all green.
- [ ] **Step 5: Commit** `feat(prep): cook sequence — one cursor per method step`

---

### Task 2: Store the cursor; Stop keeps the place

**Files:**
- Modify: `prisma/schema.prisma` (model `PrepLog`, next to `stageHistory`)
- Create: `prisma/migrations/20261116000000_prep_log_step_cursor/migration.sql`
- Modify: `src/app/api/prep/logs/[id]/route.ts`, `src/app/api/prep/plan/remove-item/route.ts`, `src/lib/prep-items-server.ts:264-273`, `src/components/prep/types.ts:18-46,82-89`, `src/lib/prep-plan.ts:340`
- Test: `src/lib/__tests__/prep-plan-stages.test.ts`

**Interfaces:**
- Consumes: `cookSequence`, `stepMoveFields` (Task 1); `parseMethod` (`recipe-method.ts`).
- Produces: `PrepLog.stepKey String?`, `PrepLog.stepEnteredAt DateTime?`; `PrepLogData.stepKey?: string | null`, `PrepLogData.stepEnteredAt?: string | null`; `PrepItemRich.linkedRecipe.method?: MethodStep[] | null`; route body field `stepKey: string`.

- [ ] **Step 1: Update the test** in `prep-plan-stages.test.ts`: `stageFieldsForStatus(item at stageIndex 3, 'NOT_STARTED')` returns `{}` (was `{stageIndex:null, stageEnteredAt:null}`), and a new test: Start after Stop (`status NOT_STARTED`, `stageIndex 3`) → `stageIndex 3` with a fresh `stageEnteredAt`.
- [ ] **Step 2: Run** `npx vitest run src/lib/__tests__/prep-plan-stages.test.ts` — expect FAIL on the NOT_STARTED case.
- [ ] **Step 3: Change** `stageFieldsForStatus` so `NOT_STARTED` returns `{}`. Readers already gate on `status === 'IN_PROGRESS'` (`pipelineOf`, `restInfo`, `isResting`, cook-start `isDoing`, `PrepRecipeSection` `inFlight`) — re-grep `stageIndex` and confirm none treats a NOT_STARTED log with a stage as in flight.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Schema + migration.** Add `stepKey String?` and `stepEnteredAt DateTime?` with a comment `// cook-along cursor: a CookItem key (src/lib/prep-steps.ts); kept on Stop, cleared on finish`. Generate SQL with `npx prisma migrate diff --from-url "$SESSION_URL" --to-schema-datamodel prisma/schema.prisma --script` into the migration file; it must contain only two `ALTER TABLE "PrepLog" ADD COLUMN` lines. **Stop and get Joshua's yes**, then `npx prisma db execute --url "$SESSION_URL" --file …`, `DIRECT_URL="$SESSION_URL" npx prisma migrate resolve --applied 20261116000000_prep_log_step_cursor`, `npx prisma generate`.
- [ ] **Step 6: Route.** In `PUT /api/prep/logs/[id]`: read `stepKey` from the body; load `linkedRecipe { stages, method }` (extend the existing `owner` query); when `stepKey !== undefined`: `seq = cookSequence(parseMethod(method))`, no seq → 400 `This item has no method`; `fields = stepMoveFields(seq, existing, stepKey, nowIso, existing.assignedTo)`, null → 400 `Unknown step`; merge `fields` into the update and force `IN_PROGRESS` on an open log exactly as the `stageIndex` branch does. `status === 'NOT_STARTED'`: stop clearing `stageIndex`/`stageEnteredAt` (keep the place; history untouched). `IN_PROGRESS` from not-in-progress: keep the existing resume, and also stamp `stepEnteredAt = now` when `existing.stepKey` is set (fresh clock). Completion or SKIPPED: set `stepKey: null, stepEnteredAt: null` alongside the progress clear. Update the block comment at line 47 to say Stop keeps the place. In `remove-item`, add `stepKey: null, stepEnteredAt: null` next to `progress: Prisma.DbNull`.
- [ ] **Step 7: Payload + types.** `prep-items-server.ts`: add `method: parseMethod(item.linkedRecipe.method)` to the `linkedRecipe` object (the `todayLog` spread already carries the new columns). `types.ts`: add the two log fields and `method?: MethodStep[] | null`.
- [ ] **Step 8: Run** `npm test` and `npm run build` — both pass; `/api/prep/logs/[id]` still `ƒ (Dynamic)`.
- [ ] **Step 9: Commit** `feat(prep): store the step cursor; Stop keeps the job's place`

---

### Task 3: Move the cursor from the client (optimistic + offline)

**Files:**
- Modify: `src/lib/prep-offline.ts:20,375`, `src/app/prep/page.tsx:766-830` (add beside `handleStageChange`)
- Modify: `src/lib/prep-steps.ts` (add `applyStepToItem`)
- Test: `src/lib/__tests__/prep-offline-step.test.ts` (new, modelled on `prep-offline-stage.test.ts`), `src/lib/__tests__/prep-steps.test.ts`

**Interfaces:**
- Consumes: `cookSequence`, `stepMoveFields` (Task 1); `withPipeline` (`prep-plan.ts`).
- Produces: `applyStepToItem<T extends { linkedRecipe?: { method?: MethodStep[] | null } | null; todayLog?: (CursorLog & { id: string; startedAt?: string | null }) | null }>(item: T, stepKey: string, nowIso: string): T` — sets `status: 'IN_PROGRESS'`, `startedAt ??= nowIso`, and the `stepMoveFields` result; returns `item` unchanged when the move is null or there is no log. Offline mutation `{ type: 'step', itemId, logId, stepKey, revenueCenterId }`. Page handler `handleStepChange(item: PrepItemRich, stepKey: string): Promise<void>`, passed to the run sheets and drawer as `onStep`.

- [ ] **Step 1: Write failing tests:** `applyStepToItem` moves a NOT_STARTED log to IN_PROGRESS at `s3` and keeps `startedAt` if set; unknown key returns the same object (`toBe`). Offline: `replays step moves in order` — queue `step s2` then `step s2:wait` for a log never sent → replay POSTs the log once, then PUTs `{stepKey:'s2'}` then `{stepKey:'s2:wait'}` in that order.
- [ ] **Step 2: Run** both test files — expect FAIL.
- [ ] **Step 3: Implement** `applyStepToItem`; add `'step'` to the mutation `type` union and a replay branch that mirrors the `'stage'` branch with body `{ stepKey: m.stepKey }`; add `handleStepChange` to the page as a copy of `handleStageChange`'s shape (RC guard, `mutationSeq`, seeded `_opt_` log, `withPipeline({...applyStepToItem(seeded, stepKey, now), isOnList: true})`, offline enqueue, per-item op chain, error text `Step move failed — try again.`).
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(prep): Next/Back move one step — optimistic and offline-safe`

---

### Task 4: Lane order and alarm rules (pure)

**Files:**
- Create: `src/lib/prep-on-the-go.ts`
- Test: `src/lib/__tests__/prep-on-the-go.test.ts`

**Interfaces:**
- Consumes: `cookSequence`, `cursorOf`, `waitClock`, `CookItem`, `WaitClock` (Task 1).
- Produces:
```ts
export type GoState = 'ready' | 'working' | 'waiting'
export interface GoRow<T> { item: T; seq: CookItem[] | null; pos: number; cur: CookItem | null; clock: WaitClock | null; state: GoState }
export function onTheGo<T extends { id: string; todayLog?: CursorLog | null; linkedRecipe?: { method?: MethodStep[] | null } | null }>(items: T[], nowMs: number): GoRow<T>[]
export const ALARM_REPEAT_MIN = 5
export function alarmShouldRing(readyAtMs: number, lastRangAtMs: number | null, nowMs: number): boolean
```
- `onTheGo` keeps only `todayLog.status === 'IN_PROGRESS'`; `state` = `ready` when the current item is a WAIT whose clock is not `resting`, `waiting` when it is `resting`, else `working` (also for items with no method). Order: ready (earliest `readyAtMs` first) → working (earliest `stepEnteredAt ?? startedAt` first) → waiting (soonest `readyAtMs` first).
- `alarmShouldRing`: false before `readyAtMs`; true when `lastRangAtMs` is null; else true once `nowMs − lastRangAtMs ≥ ALARM_REPEAT_MIN·60 000`.

- [ ] **Step 1: Write failing tests** for: three items (one ready, one hands-on, one resting) come back in `ready, working, waiting` order; a NOT_STARTED log is excluded; an IN_PROGRESS item with no method is `working` with `seq null`; `alarmShouldRing` at readyAt−1 ms → false, at readyAt with null → true, 4 min after last ring → false, 5 min → true.
- [ ] **Step 2: Run** `npx vitest run src/lib/__tests__/prep-on-the-go.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `npm test` green.
- [ ] **Step 5: Commit** `feat(prep): on-the-go order and wait-alarm rules`

---

### Task 5: Shared UI parts — step track, Next button, job menu

**Files:**
- Create: `src/components/prep/runsheet/step-ui.tsx`

**Interfaces:**
- Consumes: `CookItem`, `NextAction` (Task 1).
- Produces:
```tsx
export function StepTrack(p: { seq: CookItem[]; pos: number; ready: boolean; size?: 'sm' | 'lg'; window?: number }): JSX.Element
export function NextButton(p: { action: NextAction; size?: 'row' | 'big'; sub?: string; onClick: () => void; disabled?: boolean }): JSX.Element
export function JobMenu(p: { onStop: () => void; onHandOver?: () => void; muted: boolean; onToggleMute: () => void; onRemove?: () => void }): JSX.Element
```
Look (from the design board): STEP = square (sm 12 px / lg 16 px, radius 3–4); WAIT = capsule, dashed `border-blue`, width `round(14 + 6·log2(minutes/10))` px (min 14); done = `bg-green`; current STEP = `bg-ink` with a gold ring; current WAIT = `bg-blue-soft` with a blue ring, or solid `bg-green` with a green ring when `ready`. `window` shows only items `pos−3 … pos+7` with a short green dash before and a grey dash after when cut. Next button kinds: `work` ink + gold square glyph; `wait` white + 1.5 px dashed blue border + capsule glyph, blue text; `ready` green; `held` `bg-bg-2` `text-ink-3`; `log` ink + green dot. Label 13 px/600 (big: 15 px, full width, min-height 54 px); sub line mono 9.5 px uppercase. **Text wraps — never `whitespace-nowrap`**, label span `min-w-0`; row size min-height 44 px. `JobMenu` = 36 px `⋯` button opening a small list: `Stop for now` (sub `keeps the step — Start carries on from here`), `Hand to another cook`, `Mute alarms on this device` / `Turn alarms back on`, `Remove from the list` (red text; only when `onRemove`).

- [ ] **Step 1: Implement** the three components.
- [ ] **Step 2: Run** `npm run build` — PASS.
- [ ] **Step 3: Commit** `feat(prep): step track, Next button and job menu`

---

### Task 6: One "On the go" lane with job cards

**Files:**
- Create: `src/components/prep/runsheet/JobCard.tsx`, `src/components/prep/runsheet/JobCardMobile.tsx`
- Modify: `src/components/prep/runsheet/RunSheet.tsx`, `src/components/prep/runsheet/RunSheetMobile.tsx`, `src/app/prep/page.tsx` (pass `onStep`)
- Delete (if nothing else imports them): `WorkingRow.tsx`, `WorkingRowMobile.tsx`, `RestRow.tsx`, `RestRowMobile.tsx`

**Interfaces:**
- Consumes: `onTheGo`, `GoRow` (Task 4); `nextAction`, `cookSequence` (Task 1); `StepTrack`, `NextButton`, `JobMenu` (Task 5); `onStep(item, stepKey)` (Task 3); existing `onLog`, `onStop`, `onClaim`, `onOpenRecipe`, `onRemove`.
- Produces: `JobCard({ row, cooks, onStep, onLog, onStop, onClaim, onOpenRecipe, muted, onToggleMute })`; mobile variant same props. RunSheet/RunSheetMobile gain prop `onStep` and drop `onStage`.

Card content: clock column (working: `fmtMins(elapsed)` since `stepEnteredAt ?? stageEnteredAt ?? startedAt` + `of <step minutes>` or `of <job hands-on>` when no method; waiting: `<left>` in `text-blue-text` + `left · ready hh:mm`; ready: `READY` in `text-green-text` + `since hh:mm`; overdue: `<n> past ready` in `text-red-text`); item name (opens drawer) + qty/batch; current line (`Step n of N · <phase>` mono label + the step text; WAIT: `Wait · <phase>` + note + `Up next: <next step text>`); `StepTrack` (desktop full, phone `window`); `NextButton` (phone: `size="big"` full width, under the content; no button on a resting card); `JobMenu`. Ready card: `border-green` + 1 px green ring; resting card: `bg-bg`. No method: clock = elapsed since `startedAt`, button = `Log yield`. Next on `log` → `onLog(item)`; otherwise `onStep(item, seq[action.to].key)`.

RunSheet: delete the Waiting and Working On sections; add `<GroupHead dot="bg-ink" title="On the go" count sub="stays here until done" />` rendering `onTheGo(items, nowMs)` (respecting the station / my-station scope exactly as `doing` did). Hairline: green = done, gold = working, blue = waiting. `readyN` counts `state === 'ready'`. Same in RunSheetMobile, which also drops its separate Waiting/Working sections.

- [ ] **Step 1: Implement** the cards and wire both run sheets; pass `onStep={handleStepChange}` from the page.
- [ ] **Step 2: Grep** for `WorkingRow`, `RestRow` imports; delete the four files if unused.
- [ ] **Step 3: Run** `npm test` and `npm run build` — PASS.
- [ ] **Step 4: Browser check** (ask Joshua for a test item first — live data): start a recipe with waits; tap Next through hands-on steps into a wait; confirm the card stays in On the go the whole time, the button changes from solid to dashed blue before the wait and to grey during it. Screenshot desktop and 375 px phone width.
- [ ] **Step 5: Commit** `feat(prep): one On the go lane — the card stays put, the track moves`

---

### Task 7: The wait alarm

**Files:**
- Create: `src/components/prep/runsheet/useWaitAlarms.ts`, `src/components/prep/runsheet/AlarmBanner.tsx`
- Modify: `RunSheet.tsx`, `RunSheetMobile.tsx` (banner on top; `muted`/`onToggleMute` into `JobMenu`)

**Interfaces:**
- Consumes: `onTheGo`, `alarmShouldRing`, `ALARM_REPEAT_MIN` (Task 4); `NextButton` (Task 5).
- Produces: `useWaitAlarms(rows: GoRow<PrepItemRich>[]): { due: GoRow<PrepItemRich>[]; muted: boolean; setMuted: (m: boolean) => void }`; `AlarmBanner({ rows, onNext })`.

Hook: own 15 s interval; `due` = rows with `state === 'ready'`, oldest `readyAtMs` first; a `useRef<Map<logId, lastRangAtMs>>` feeds `alarmShouldRing`; when any due row should ring and not muted: one chime (Web Audio — two 0.15 s sine tones, 880 Hz then 660 Hz, gain 0.2; create the `AudioContext` lazily; wrap every call in try/catch), `navigator.vibrate?.([200, 100, 200])`, and when `document.hidden && Notification?.permission === 'granted'` a `new Notification('<item> is ready', { body: '<phase> done. Next: <next label>' })`. Mute lives in `localStorage['prep.alarms.muted']` (try/catch; default off). `JobMenu` gets `Turn on notifications` that calls `Notification.requestPermission()` only when permission is `default`. Banner: green soft box with a bell, title `<item> — <phase> is done`, mono line `READY SINCE hh:mm · NEXT: <label>`, and the `ready` NextButton; one banner per due row.

- [ ] **Step 1: Implement** hook and banner; wire both run sheets.
- [ ] **Step 2: Run** `npm run build` — PASS.
- [ ] **Step 3: Browser check:** with a job in a short wait (ask Joshua which test item; a 1-minute wait on a scratch recipe is ideal), confirm banner + chime at ready, a second chime 5 min later, none when muted, and no console errors when audio is blocked (load the page and wait without tapping).
- [ ] **Step 4: Commit** `feat(prep): alarm when a wait is over — banner, chime, buzz`

---

### Task 8: Drawer cook mode

**Files:**
- Create: `src/components/prep/CookMode.tsx`
- Modify: `src/components/prep/PrepDrawer.tsx`, `src/components/prep/PrepRecipeSection.tsx`, `src/app/prep/page.tsx` (pass `onStep`)

**Interfaces:**
- Consumes: `cookSequence`, `cursorOf`, `waitClock`, `nextAction` (Task 1); `StepTrack`, `NextButton`, `JobMenu` (Task 5); `onStep` (Task 3); existing `onLogYield`, `onStatusChange`, `onRemove`.
- Produces: `CookMode({ item, seq, pos, clock, nowMs })` (the body block) and `CookFooter({ seq, pos, action, onBack, onNext })`. `PrepDrawer` prop `onStage` is replaced by `onStep?: (item, stepKey) => void`.

When `status === 'IN_PROGRESS'` and `seq` exists: the drawer body opens with `CookMode` — label `<phase> · step n of N` + `ready about hh:mm` (sum of remaining minutes), `StepTrack size="lg"`, the current item large (STEP: ink-bordered card, pill `Now · hands-on`, `<elapsed> of <minutes>`, text 21 px/600; WAIT: blue-soft dashed card with the big `left` time, `ready at hh:mm · <note>`, line `Walk away. You get a chime when it is time.`; ready WAIT: green card `Time is up`), then an `Up next` box (dashed blue for a wait, plain for a step). Below it, the existing recipe section with the scale/cost, ingredients and stock blocks **collapsed by default** (a header row with `SHOW`), the method list read-only-highlighted as today. The footer becomes `CookFooter`: `← Back` (80 px phone / 150 px desktop; sub = previous item's phase; disabled at pos 0) and `NextButton size="big"` (held state label `Move on early`, sub `Skip the rest of the wait`). Log yield, Stop and Remove move into `JobMenu` in the drawer header. Not-started and done footers are unchanged.

In `PrepRecipeSection`: delete the auto-advance in `tickMethodStep` (ticking only toggles) and the `tick to move on` label (`advances` prop goes); drop the `onStage` prop.

- [ ] **Step 1: Implement** `CookMode`/`CookFooter`; wire `PrepDrawer` and the page.
- [ ] **Step 2: Run** `npm test` and `npm run build` — PASS.
- [ ] **Step 3: Browser check** (Joshua's test item): open the drawer mid-job → it opens on the current step; Back then Next returns to the same step; ticking a step does not move the job; Stop from the menu then Start resumes on the same step. Screenshot drawer desktop + phone.
- [ ] **Step 4: Commit** `feat(prep): item drawer becomes cook mode — Back and Next, method first`

---

### Task 9: Tidy — remembered cook, caption, start page

**Files:**
- Modify: `RunSheet.tsx`, `RunSheetMobile.tsx`; check `src/lib/cook-start.ts` + its `/today` card for anything that read Working/Rest rows.

- [ ] **Step 1:** My station: initial cook = `localStorage['prep.todo.cook']` if that id is in `cooks`, else `cooks[0]`; write it on every pick (try/catch). Mobile caption becomes two lines: line 1 `<done>/<total> done · <n> on the go`, line 2 `NOW hh:mm · <service caption> · Posted <when>`.
- [ ] **Step 2:** Grep `/today` (`src/components/mobile/today/`) for Next/stage buttons; if it moves stages, switch it to `onStep` with `nextAction` so both screens move one step at a time (otherwise leave it).
- [ ] **Step 3: Run** `npm test`, `npm run lint`, `npm run build` — PASS.
- [ ] **Step 4: Commit** `feat(prep): To Do remembers the cook; caption in two lines`

---

### Task 10: Final check and hand-off

- [ ] **Step 1:** Full walkthrough on the dev server at desktop and 375 px with Joshua's chosen item: start → three Nexts across a wait → alarm → Back → Stop → Start (same step) → Log yield. Confirm no button text is clipped at 375 px.
- [ ] **Step 2:** `npm test`, `npm run lint`, `npm run build` — all PASS; API routes `ƒ (Dynamic)`.
- [ ] **Step 3:** Update CLAUDE.md's prep paragraph: the run sheet is one On the go lane; the cursor is `PrepLog.stepKey` (cook sequence in `src/lib/prep-steps.ts`), kept in sync with the chain; Stop keeps the place; ticking never moves a job.
- [ ] **Step 4:** Open the PR (squash merge; never reuse the branch). Note in the PR that phone notifications with the app fully closed are a follow-up.
