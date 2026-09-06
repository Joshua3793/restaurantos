# Prep — staged jobs and cadence-aware suggestions

**Date:** 2026-09-06
**Surfaces:** `/prep` (Smart Prep planner, To Do run sheet, item drawer), recipe panel (`/recipes`)
**Status:** design agreed, ready to build. Decisions recorded in §0.

Two features, specified together because they share the lead-time math and the
run-sheet row model. Build in the order of §5; each phase is shippable alone.

1. **Staged prep** — a job whose method spans days (cure, proof, rest, hang) is
   modelled as a chain of stages. The cook advances it stage by stage; the run
   sheet shows what it is doing now and when the next hands-on step is due; it
   is never painted late while it is legitimately resting.
2. **Cadence and effort aware suggestions** — Smart Prep reads the make history
   and the lead time, not only on-hand vs par, so it can say "usually every 3
   days, last made 4 days ago", cap a suggestion at shelf life, and tell the
   chef that a long-lead item must start today for a later service.

---

## 0 · Decisions (already made)

| Question | Decision |
|---|---|
| Where stages live | On the **recipe**, as a Json array column (`Recipe.stages`). No separate table, no per-PrepItem stage override in this pass. |
| Where a resting job shows | In the **ladder**, as a row at the time its next hands-on stage is due. Working On holds hands-on stages only. |
| Stage transitions | **Never automatic.** A stage's timer reaching zero paints the row "ready"; a cook taps to advance. |
| Recipes without stages | Behave **exactly as today**: one implicit hands-on job carrying `activeMinutes + passiveMinutes`. The stage system switches on per recipe only when stages are authored. |
| Yield and stock | **DONE stays the only point** that logs `actualPrepQty` and credits stock. Stages never touch the theoretical-stock engine. |
| Logs | **One live log per item**, as today (`isLiveLog` / `pickLiveLogs`). Stage progress rides that log. Never one log per stage. |

---

## 1 · Audit — what the prep page is today

Read before changing anything; every claim was verified against the tree on 2026-09-06.

**Structure.** `src/app/prep/page.tsx` (≈2100 lines) owns all state and renders three
tabs: `today` (run sheet — `components/prep/runsheet/`), `smartprep` (planner —
`components/prep/planner/`), `history` (per-day log table). Dual renderer split at `md:`.

**Suggestion engine.** `autoUrgency(onHand, parLevel, targetToday)` in
`src/lib/prep-utils.ts` picks one of four steps (PASS / MID / CLOSE / TMRW);
`computeSuggestedQty` is the gap to par. `onHand` is theoretical stock
(`getTheoreticalStockMapCached`) converted into the prep unit. `whyLabel` in
`src/lib/prep-plan.ts` is the read-only evidence caption. The chef overrides the
step (`PrepItem.manualPriorityOverride`), never the stock.

**Time model.** `Recipe.{activeMinutes,passiveMinutes,passiveNote}` with per-item
overrides on `PrepItem`; resolved by `src/lib/prep-runsheet.ts`. The ladder
(`ladderTimes`) computes `startBy = deadline − active − passive`.

**Status machine.** `PrepLog.status`: NOT_STARTED → IN_PROGRESS → DONE | PARTIAL
(SKIPPED / BLOCKED exist but the run sheet does not drive them). `PUT
/api/prep/logs/[id]` stamps `startedAt` / `completedAt`, re-dates a carried log to
today on completion, clears older posted rows, invalidates the stock cache, and
clears the priority override.

**Findings that drive this spec**

- No history feeds the suggestion. `/api/prep/items` computes `lastMadeAt` per item
  but nothing reads it. Interval between makes, typical batch, and depletion rate
  are derivable from `PrepLog` and the stock ledger and unused.
- `shelfLifeDays` appears only in `whyLabel`. It never limits a suggestion.
- The time model cannot describe a multi-day method. A 3-day cure either has a
  passive of 0 (reads "over by 2d" the next morning) or a passive of 3 days
  (start-by lands two days before doors, so the row is red before it is started).
- IN_PROGRESS is one flat state. `WorkingRow` / `WorkingRowMobile` compute
  `remaining = active + passive − elapsed` and paint "over by" red. That is the
  false "Late" on curing / proofing items.
- `CrewStrip` elapsed uses minute-of-day only (`nowMin − minuteOfDay(startedAt)`
  clamped at 0), so a job started last evening reads 0 elapsed this morning.
- A job in flight is still a stock-out to the planner: stock is credited at DONE
  only, so a curing item keeps its PASS step in the suggestions pane and in the
  shift band's critical count, and `planSchedule` slots it again from shift start.
- Recipe `steps` are free text; cook-along ticks in `PrepRecipeSection` are client
  state and reset on close. Nothing persists "where in the method a job is".
- `PrepDoneSheet` pre-fills `suggestedQty`, not the planned qty.

---

## 2 · Staged prep

### 2.1 Data model (additive, nullable)

```prisma
model Recipe {
  // ...
  stages Json?   // RecipeStage[] — see src/lib/prep-stages.ts; null = no stages
}

model PrepLog {
  // ...
  stageIndex     Int?       // index into the resolved stage chain; null when not staged
  stageEnteredAt DateTime?  // when the current stage began
  stageHistory   Json?      // StageEvent[] — [{ index, key, enteredAt, byCookId? }]
}
```

```ts
// src/lib/prep-stages.ts (pure, vitest-covered)
export type StageKind = 'ACTIVE' | 'PASSIVE'
export interface RecipeStage {
  key: string          // stable id within the recipe (nanoid or slug); used in history
  name: string         // "Mix", "Bulk rest", "Shape", "Proof", "Bake", "Cure", "Rinse & hang"
  kind: StageKind
  minutes: number      // ≥ 0; PASSIVE minutes are the expected rest, not a hard limit
  note?: string        // "overnight in the walk-in"
}
```

Examples the recipe editor should make easy to author:

- Sourdough: Mix (ACTIVE 30) → Bulk (PASSIVE 240) → Shape (ACTIVE 20) → Proof (PASSIVE 720) → Bake (ACTIVE 60)
- Cure: Rub (ACTIVE 20) → Cure (PASSIVE 4320) → Rinse & hang (ACTIVE 15)

Validation (in the lib, applied by the recipe PATCH route): ≥ 1 stage; the **last
stage must be ACTIVE** (the job ends with hands-on work and the yield log); no two
consecutive PASSIVE stages (merge them); minutes integer ≥ 0; keys unique.

### 2.2 Resolution

`resolveStages(recipe, item): RecipeStage[] | null`

- `recipe.stages` non-empty → return them.
- Otherwise `null` → the item is **unstaged** and every existing code path runs
  unchanged. Do NOT synthesize a two-stage chain from `passiveMinutes`; that would
  change the behaviour of every existing item that has a passive note.

When stages exist, `resolveActive` / `resolvePassive` in `prep-runsheet.ts` derive
from the chain (Σ ACTIVE, Σ PASSIVE) **unless** the item carries an explicit
override, which still wins. `startBy` therefore counts back the whole chain.

Derived per live log: `currentStage(stages, log)`, `stageReadyAt(log, stage) =
stageEnteredAt + stage.minutes` (epoch ms, NOT minute-of-day), `nextActiveStage`.

### 2.3 State machine

| Action | From | Effect |
|---|---|---|
| Start | NOT_STARTED | status IN_PROGRESS, `startedAt` (as today). Staged: `stageIndex = 0`, `stageEnteredAt = now`, history `[ {0, key, now} ]`. |
| Next stage | IN_PROGRESS, `stageIndex < last` | `stageIndex + 1`, `stageEnteredAt = now`, append history. Status unchanged. |
| Back a stage | IN_PROGRESS, `stageIndex > 0` | `stageIndex − 1`, `stageEnteredAt = now`, append history (a correction is recorded, not erased). |
| Done | IN_PROGRESS on the last stage (or any stage — the cook decides) | as today: yield required, credits stock, re-dates the log, clears older posted rows, clears override. Also appends a terminal history event. |
| Stop | IN_PROGRESS | as today (NOT_STARTED); clear `stageIndex`, `stageEnteredAt`. Keep history. |

Transport: extend `PUT /api/prep/logs/[id]` with an optional `stageIndex` field.
Server validates range against the resolved chain, stamps `stageEnteredAt`,
appends to `stageHistory`, forces `status: 'IN_PROGRESS'` when a stage index is
set on an open log. No new route. `numOrNull`-style coercion, LEAD not required
(cooks advance their own jobs, like Start / Done).

Optimistic client: extend `applyStatusToItem` (or a sibling `applyStageToItem`)
so the row moves instantly; the offline queue (`prep-offline.ts`) gets a
`stage` mutation type mirroring `status`.

### 2.4 Run sheet

**Working On** — hands-on stages only. Row shows a stage chip (`Mix · 1/5`), the
stage's own timer (`elapsed` vs `stage.minutes`; "over by" applies to the stage,
not the job), and the primary button reads **Next: Bulk rest** (or **Done** on the
last stage). Unstaged items keep today's row exactly.

**Ladder** — a job whose current stage is PASSIVE leaves Working On and appears
in the ladder as a **rest row** in its item's step group:

- Time column: `readyAt` in place of start-by, formatted with `fmtStartBy` (day
  offset shown when not today).
- Name line: `Bake · Sourdough` (next active stage · item), stage chip
  `Proofing · 3/5`, and `resting 6h of 12h` while the timer runs.
- State: `resting` (muted, blue-grey accent) until `readyAt`; then `ready`
  (green accent, "ready since 07:30"); then `overdue` only after
  `readyAt + REST_GRACE_MINUTES` (lib constant, default 60). A row never
  auto-advances — the button is **Next: Bake**, and the cook taps it.
- Sort: `ladderOrder` uses `readyAt` where a todo row uses `startByMinutes`.
  "Late to start" lifts a rest row only when it is `overdue` by the rule above.
- Remove (×) is not offered on a rest row (same rule as Working On).

`runSheetGroups` / `withLadderTimes` in `prep-plan.ts` gain the rest-row case;
`RunSheet` / `RunSheetMobile` filter `doing` to active-stage jobs and pass rest
rows into the ladder. Status band gains **N ready to move** (rest rows past
`readyAt`). `NextUpHero` on mobile may be a rest row when it sorts first.

**Crew strip** — a cook's "doing" is an ACTIVE-stage job only; a resting job does
not hold a cook. Fix the elapsed clock at the same time: compare epoch ms
(`startedAt` / `stageEnteredAt` vs `nowMs`), never minute-of-day.

**Drawer / cook-along** — header shows the stage chip and the stage list with the
current one highlighted; the action row mirrors the run-sheet buttons.
Method `steps` stay the free-text method; do not derive stages from them.

### 2.5 Planner

A staged job in flight is **pipeline stock**, not a stock-out:

- `/api/prep/items` returns `pipeline: { qty, readyAt, stageName } | null` for an
  item with a live IN_PROGRESS log (staged or not — any started job is in the
  pipeline). `qty` = the log's planned qty (`draftQty`).
- `whyLabel` says `in the pipeline · ready Thu 07:30` and the suggestion row
  shows a pipeline chip instead of the stock-out triangle.
- "Add all critical" and the shift band's critical count exclude pipeline items.
- `planSchedule` / `stationLoad` charge only the remaining ACTIVE minutes of a
  job already in flight, and slot them from `readyAt`, not from shift start.
- `autoUrgency` itself is unchanged in this pass (stock is still stock); the
  pipeline is evidence and exclusion, not a stock credit.

### 2.6 Authoring

Recipe panel in `src/components/recipes/shared.tsx`, a **Stages** block beside
Method steps: ordered rows (name · Active/Passive toggle · minutes · note), add /
remove / reorder, persisted through the existing `patchRecipe` → `PATCH
/api/recipes/[id]`. When a recipe has stages, the Active / Passive minute fields
become read-only derived totals with a caption "from stages".

---

## 3 · Cadence and effort aware suggestions

### 3.1 Layer A — cadence (build first)

`src/lib/prep-cadence.ts` (pure, vitest-covered):

```ts
export interface CadenceStats {
  makes: number               // completed logs in the window
  medianIntervalDays: number | null
  medianQty: number | null
  lastMadeAt: string | null
  dueByCadenceAt: string | null   // lastMadeAt + medianInterval
  usagePerDayEst: number | null   // medianQty / medianIntervalDays (proxy until Layer B)
}
export function cadenceStats(logs: Array<{ logDate: string; actualPrepQty: number | null }>, now: Date): CadenceStats
export function cadenceNudge(auto: PrepUrgency, stats: CadenceStats, now: Date): { urgency: PrepUrgency; reason: string | null }
export function shelfLifeCap(suggested: number, shelfLifeDays: number | null, usagePerDay: number | null): number
```

Rules:

- Window: last 60 days of DONE / PARTIAL logs with `actualPrepQty > 0`. Need ≥ 3
  makes for a median; otherwise stats are null and nothing changes.
- `cadenceNudge`: only ever **raises** TMRW → CLOSE when `dueByCadenceAt ≤ now`,
  with reason `usually every 3d · last made 4d ago`. Never touches PASS / MID /
  CLOSE, never lowers, never overrides a manual step. Existing urgency tests stay
  byte-identical because the nudge is a separate function applied after
  `autoUrgency`.
- `shelfLifeCap`: when both `shelfLifeDays` and a usage estimate exist, cap the
  suggested qty at `usagePerDay × shelfLifeDays` (never below one `prepStep`).
  Evidence: `capped to 2d shelf life`.

API: in `/api/prep/items`, replace the `lastMadeAt` groupBy with one `findMany`
over the window (select `prepItemId, logDate, actualPrepQty`), compute stats per
item, and return `cadence: CadenceStats` on each row (`lastMadeAt` stays for
compatibility). `PrepItemRich.cadence` added.

UI: `whyLabel` appends the nudge reason; `SuggestionRow` shows a small clock
chip when cadence raised the step.

### 3.2 Layer C(1) — lead-time promotion (build with §2, shares its math)

In the planner, an item whose full lead (`Σ stages`, or `active + passive`)
exceeds the runway to its step deadline **must start today**, whatever its stock:

- `mustStartToday(item, ctx, nowMin)`: `startBy < nowMin` for the item's own step
  deadline, or — for TMRW items — `startBy` for *tomorrow's* doors is already
  behind now.
- Suggestions pane: a **Start today for …** group above the step groups listing
  these, captioned with the deadline day. "Add all critical" adds them too.
- For long-lead items the suggested qty is the shelf-life-capped maximum, not the
  par gap (the effort is per batch, so make the most that will keep).

### 3.3 Layer B — days of cover (later; needs live sales)

Replace the half-par heuristic with `daysOfCover = onHand / usagePerDay`, where
usage comes from the stock ledger (SALE + PREP_IN draws on the prep item's
inventory item over the last 14–28 days, see `buildConsumptionMap` /
`buildPrepMap` in `src/lib/count-expected.ts`). Map cover onto the four steps;
keep par as the fallback when no usage history exists; flag a par that no longer
matches burn. Out of scope until the Toast sync is live again.

---

## 4 · Non-goals

- No auto-advance of stages (decided).
- No per-PrepItem stage override; no separate stage table.
- No change to what credits stock or when.
- No change to `autoUrgency` thresholds (cadence is a nudge layered after it).
- No change to the History tab beyond showing stage events on a log row.

---

## 5 · Build order and verification

Each phase: `npm test` after any `src/lib` change, `npm run build` after
anything else, and the acceptance checks listed.

**Phase 1 — stages model + lib + authoring.** Prisma columns (additive SQL
migration under `prisma/migrations/<ts>_prep_stages/`, then `npx prisma
generate`), `src/lib/prep-stages.ts` + tests (validation, resolution, readyAt,
derived totals), recipe PATCH validation, Stages editor in the recipe panel.
Accept: a recipe with stages saves and reloads; Active / Passive totals derive;
an unstaged recipe is untouched.

**Phase 2 — log stage fields + run sheet.** `PUT /api/prep/logs/[id]` stage
handling, optimistic client + offline mutation, `WorkingRow(Mobile)` stage chip
and Next button, rest rows in the ladder (`prep-plan.ts` + tests), status band
"ready to move", crew strip fix, drawer stage list.
Accept: start a 3-stage recipe → Working On shows stage 1 with its own timer →
Next moves it to the ladder at `readyAt` with a muted rest row → after `readyAt`
it reads "ready" (not red) → Next brings it back to Working On → Done logs yield
exactly as before. A job started yesterday shows the right elapsed in the crew
strip. Unstaged items look and behave exactly as before.

**Phase 3 — planner awareness.** Pipeline field in `/api/prep/items`, suggestion
chip + whyLabel, critical-count exclusions, schedule charging remaining active
minutes from `readyAt`.
Accept: a curing item no longer appears as a stock-out to "Add all critical" and
shows "in the pipeline · ready Thu".

**Phase 4 — cadence Layer A + lead-time promotion.** `prep-cadence.ts` + tests,
API stats, whyLabel / chip, shelf-life cap, "Start today for …" group.
Accept: an item made every 3 days and last made 4 days ago at par shows Before
Close with the cadence reason; a suggestion above `usage × shelf life` is capped;
a 3-day cure needed for Thursday appears under "Start today for Thu".

**Phase 5 — days of cover.** When sales are live.

---

## 6 · Repo conventions that apply

- Flat Tailwind tokens only; Lucide icons; `'use client'`; sub-components at
  module scope; dual renderer split at `md:`; no `backdrop-blur` on scrims.
- Every route handler that mutates exports `const dynamic = 'force-dynamic'`;
  polled GETs return `Cache-Control: no-store`.
- Prisma singleton; Decimal serializes as string — wrap `Number()`.
- Do not create a second live log per item; go through `ensureLiveLogs`.
- Keep `isLiveLog` / completion re-dating / `postedAt` clearing untouched.
- Migrations: write the SQL file by hand or via `prisma migrate diff`; do not
  run against a live database from a build session.
