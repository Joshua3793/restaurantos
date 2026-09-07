# Recipes — one Method, with waits (steps and stages merged)

**Date:** 2026-09-06
**Surfaces:** recipe panel (`/recipes`), item drawer cook-along (`/prep`), run sheet and planner (unchanged behaviour, new source of truth)
**Status:** design agreed, ready to build. Decisions recorded in §0.
**Supersedes:** the authoring half of `2026-09-06-staged-prep-and-cadence-suggestions-design.md` (§2.1 model, §2.6 authoring). The run-sheet, pipeline and cadence halves of that spec stand.

A PREP recipe today carries two lists that do not know about each other:
`steps` (free text for the cook-along) and `stages` (the run-sheet chain of
hands-on / unattended checkpoints). A chef has to tell the same story twice and
has to know that a stage is a *tap*, not a paragraph. Smoked Brisket, authored
under that model, ended up with three hands-on stages hiding a 12-hour cure and
an 8-hour smoke, its method in the stage notes, and an empty Steps list.

This design replaces both lists with **one ordered Method** where any step can
carry a **wait** (an unattended span that follows it). The run-sheet chain is
**derived** from the method, so the machinery built for stages — rest rows,
the pipeline, start-by, the stage history — keeps working unchanged on the
derived chain.

---

## 0 · Decisions (already made)

| Question | Decision |
|---|---|
| Steps vs stages | **One list**: `Recipe.method`. `steps` and `stages` are retired (kept read-only for one release, then dropped). |
| Where a wait lives | **On the step it follows**: `MethodStep.wait`. There is no "unattended step"; "unattended" simply means "there is a wait here". |
| Phases | **Free-text labels** on a step (`phase`), grouping the steps under it until the next label. Optional. No fixed vocabulary; the run sheet does not colour by phase. |
| The chain | **Derived, never authored.** `methodToChain(method)` yields the same `RecipeStage[]` shape the run sheet already reads, alternating hands-on blocks and waits. |
| Live log | **Unchanged.** `PrepLog.stageIndex` indexes the derived chain; `stageEnteredAt` / `stageHistory` keep their meaning. One live log per item. |
| Advancing | **Ticking the last step of a block is the Next tap.** Nothing advances on its own; a wait that runs out reads "ready". |
| Stock | **DONE stays the only stock credit**; the last block always ends in the yield log. |
| Individual step ticks | Client state, as today. Only block boundaries persist. |

---

## 1 · Audit — what exists today

Verified against the tree on 2026-09-06 (main at 153ca5c).

**Data.** `Recipe.steps String[]` (free text) and `Recipe.stages Json?` (`RecipeStage[]`: key · name · kind ACTIVE/PASSIVE · minutes · note). `Recipe.{activeMinutes,passiveMinutes,passiveNote}` are the unstaged timing; when a chain exists `resolveActive`/`resolvePassive` in `src/lib/prep-runsheet.ts` derive Σ from it. `PrepLog.{stageIndex,stageEnteredAt,stageHistory}` carry a live log's place in the chain.

**Consumers of `steps`.** `PATCH /api/recipes/[id]` and `POST /api/recipes` accept it; `POST /api/recipes/[id]/save-scale` copies it; `fetchRecipeWithCost` returns it; the recipe panel edits it (`shared.tsx` Method · steps block); the item drawer's `openDrawer` (`src/app/prep/page.tsx`) reads it and, when empty, **parses numbered instructions out of `notes`** as a fallback; `PrepRecipeSection` renders it as tickable `StepRow`s with client-only ticks.

**Consumers of `stages`.** `src/lib/prep-stages.ts` (parse / validate / resolve / totals / current / next / readyAt / rest state / remaining chain / history), `src/lib/prep-plan.ts` (rest rows, pipeline, `stageFieldsForStatus`, `applyStageToItem`), `PUT /api/prep/logs/[id]` (Start / Next / Back / Stop / Done stamps), `/api/prep/items` (exposes `linkedRecipe.stages`), the run-sheet rows (`WorkingRow*`, `RestRow*`, `NextUpHero`, `CrewStrip`), both drawers via `StageList`, the History tab, and the recipe panel's `StagesEditor`.

**Findings that drive this spec**

- Two lists, one story. A chef writes the method in Steps and then has to re-express it as Stages to get timing. The stage `note` became the place instructions went (Smoked Brisket).
- The kind toggle is the wrong question. "Is this hands-on or unattended?" is not how a cook thinks; "after this, it sits for 12 hours" is.
- A stage that mixes hands-on and unattended work (fire the smoker, then smoke for 4 hours) has to be split into two stages by hand, or it gets authored as one hands-on stage and paints red.
- The last-stage-must-be-ACTIVE rule surfaces as a validation error the chef has to understand, when all it means is "the job ends with the yield log".
- The `notes` fallback parser in `openDrawer` exists because Steps were often empty; with one Method that becomes the canonical place, and the fallback can go.

---

## 2 · Model

### 2.1 Data (additive; old columns retained one release)

```prisma
model Recipe {
  // ...
  method Json?   // MethodStep[] — see src/lib/recipe-method.ts; null = no method authored
  // steps String[] and stages Json? stay until the migration in §6 has run everywhere; then dropped.
}
```

```ts
// src/lib/recipe-method.ts (pure, vitest-covered)
export interface MethodWait {
  minutes: number        // integer ≥ 1 — the expected unattended span, not a hard limit
  note?: string          // "uncovered in the walk-in", "in the cooler"
}

export interface MethodStep {
  key: string            // stable id (nanoid); used in the chain keys and the log's history
  text: string           // the instruction — required, trimmed, non-empty
  phase?: string         // free-text label; groups this step and the following ones until the next phase
  minutes?: number       // hands-on minutes for THIS step; integer ≥ 0; absent = untimed (0)
  wait?: MethodWait      // an unattended span AFTER this step
}
```

A method with no `minutes` and no `wait` anywhere is a plain instruction list and the recipe behaves exactly as an unstaged recipe does today (its timing comes from `activeMinutes` / `passiveMinutes`).

### 2.2 Validation (in the lib, applied by the recipe routes)

- `method` is an array; may be empty (`[]` or `null` clears it).
- Every step: non-empty `text` after trimming; `minutes` absent or an integer ≥ 0; `wait.minutes` an integer ≥ 1; keys unique (a missing key is assigned).
- A `wait` on the **last** step is rejected with: *"A wait can't be the last thing — add the step that finishes the job (it ends with the yield log)."* This is the old last-stage-ACTIVE rule, stated as the chef sees it.
- Two consecutive steps that both carry a `wait` with no hands-on work between them are allowed — they become one merged wait in the chain (Σ minutes, notes joined). This replaces the old "no two consecutive PASSIVE" error: the chef is never told to restructure their method.
- `phase` is trimmed; empty becomes absent.

### 2.3 Derivation — `methodToChain(method): RecipeStage[] | null`

Returns `null` when the method has **no waits and no timed steps** (unstaged). Otherwise:

1. Walk the steps in order. Consecutive steps up to and including a step that carries a `wait` form a **hands-on block**; the block's `minutes` is Σ of their `minutes`; its `name` is the block's `phase` if one is set on or before its first step, else the first step's text (truncated to 40 chars); its `key` is the first step's key.
2. Each `wait` becomes an **unattended stage** right after its block: `name` = `"Wait"` prefixed by the phase when set (e.g. `"Curing · wait"`), `minutes` = the wait's minutes, `note` = the wait's note, `key` = `${step.key}:wait`. Adjacent waits merge (§2.2).
3. The steps after the final wait form the last hands-on block. If nothing follows the last wait the validation in §2.2 has already refused it.
4. A hands-on block whose Σ minutes is 0 still exists (a checkpoint with negligible time), so the cook still taps through it.

The result is a valid `RecipeStage[]` under the existing rules (≥ 1 stage, last ACTIVE, no back-to-back PASSIVE), so **`resolveStages(recipe)` becomes: `methodToChain(recipe.method) ?? parseStages(recipe.stages)`** and every existing consumer is untouched. `stageTotals` of the derived chain gives the Timing block's read-only totals.

`chainBlocks(method)` additionally returns, per chain index, the step keys it covers — what the cook-along needs to light the steps of the current block.

### 2.4 Worked example — Smoked Brisket

Method as the chef writes it (phase · text · hands-on · wait):

| # | phase | step | hands-on | wait |
|---|---|---|---|---|
| 1 | Curing | Trim the brisket, leaving a ¼" fat cap | 25 | |
| 2 | | Coat generously with Coffee Rub, massage in | 15 | 12h · uncovered in the walk-in |
| 3 | Smoking | Fire the smoker to 225°F, load fat side up | 20 | 4h · until deep mahogany bark, ~65°C internal |
| 4 | | Wrap in butcher paper with 4 tbsp tallow per piece | 10 | 4h · until 93°C internal |
| 5 | Resting | Unwrap for 30 min to stop the cook, re-wrap | 5 | 2h · in the cooler |
| 6 | | Slice against the grain, portion, log the yield | 30 | |

Derived chain: **Curing 40** → *Curing · wait 720* → **Smoking 20** → *Smoking · wait 240* → **Wrap 10** → *Smoking · wait 240* → **Resting 5** → *Resting · wait 120* → **Slice 30**. Nine stages, hands-on 105 min, unattended 1320 min. The run sheet counts start-by back over all of it; while it smokes the row reads "resting 3h of 4h", never late; the planner lists it under "Start today for …" when a Thursday deadline needs a Wednesday start. None of that code changes.

(The block after step 3 is named "Wrap…" from its first step because no new phase was set; the chef can add a phase label to step 4 if they want it to read "Smoking" again.)

---

## 3 · Authoring — the Method editor

Replaces both the Method · steps block and the Stages editor in the recipe panel (`RecipePanel` in `src/components/recipes/shared.tsx`), PREP recipes only. MENU recipes keep a plain text-only method (the same editor with the timing controls hidden).

- **One list, one "+ Add step".** Each row: step number · phase label (optional, shown as a small heading above the row when set) · instruction textarea · hands-on minutes (small optional field, placeholder "min") · **"+ wait after this"**. Toggling the wait reveals `minutes` and a note field inline under the row, drawn as a muted hourglass line so the method reads as prose interrupted by waits.
- Reorder with up/down, remove with ×. Rows keyed by step key, inputs uncontrolled, commit on blur (as the current editors do).
- **Local draft, save when valid.** Same rule as `StagesEditor`: the list is held locally; each change validates; a valid method PATCHes; an invalid one shows the sentence from §2.2 under the list and does not save. The one reachable invalid state is a wait on the last step.
- **Timing block** shows derived totals read-only ("Hands-on 1h45 · Unattended 22h · from the method") whenever the chain resolves; otherwise the two manual fields as today.
- **Phase label affordance.** A small "Phase" chip on each row; clicking sets the label for that row (and by rule, the rows after it). Free text, with the recipe's existing labels offered as suggestions.

The recipe print view and `RecipeViewModal` render the method as numbered prose with waits as italic lines ("— wait 12h, uncovered in the walk-in —").

---

## 4 · Cook-along and run sheet

**Drawer (`PrepRecipeSection`, both drawers).** The method renders grouped by phase, every step tickable. When the item's live log is IN_PROGRESS, the steps of the current chain block are lit and the ones before are shown done; the current wait (if the log is in one) shows its clock and note. **Ticking the last step of a block is Next** — it calls the same `onStage(item, index + 1)` the run-sheet button calls, so the log enters the wait and the row moves to the ladder as a rest row. The explicit Back / Next row from `StageList` stays for corrections. Untimed intermediate ticks remain client state.

**Run sheet.** Unchanged. The stage chip shows the derived stage name (phase-aware), the rest row's note is the wait's note, `RestRow` / `WorkingRow` / `NextUpHero` / `CrewStrip` / the pipeline and cadence code read the derived chain through `resolveStages`.

**History.** Unchanged: events are keyed by chain keys, which are stable because they derive from step keys.

**Log route.** `PUT /api/prep/logs/[id]` resolves the chain via `resolveStages` as today; no change.

**`/api/prep/items`** exposes `linkedRecipe.stages` as the derived chain (already goes through `resolveStages`); adds nothing.

**`openDrawer`** reads `recipe.method` and drops the `notes` parsing fallback. `RecipeStepsData.steps` becomes `method: MethodStep[]`; the cook-along's `StepRow` takes a `MethodStep`.

---

## 5 · API

- `PATCH /api/recipes/[id]` and `POST /api/recipes` accept `method` (validated by the lib; `null` / `[]` clears). `steps` and `stages` remain accepted for one release and are written through untouched (no cross-conversion on write).
- `POST /api/recipes/[id]/save-scale` copies `method` alongside the fields it copies today.
- `fetchRecipeWithCost` returns `method` (and keeps returning `steps` / `stages` for the release). This response is hand-built — the omission of `stages` there is what broke the Stages editor in #112; `method` must be listed explicitly.
- Types: `RecipeStepsData.method`, `Recipe.method` in `shared.tsx`.

---

## 6 · Migration

1. **Schema**: `Recipe.method Json?` — additive, `IF NOT EXISTS`, hand-written SQL under `prisma/migrations/<ts>_recipe_method/`.
2. **Data script** `scripts/migrate-recipe-method.ts` (idempotent, dry-run by default, backup JSON in the repo root like the prep-log repairs):
   - `stages` present → one `MethodStep` per ACTIVE stage (`text` = stage name, `minutes` = stage minutes, the stage `note` becomes the step text's second line when present, since chefs put instructions there) and each PASSIVE stage becomes a `wait` on the preceding step (`minutes`, `note`). Existing `steps` are appended as untimed steps after the last stage's step only if they are not already represented.
   - `stages` absent, `steps` present → untimed steps.
   - Both absent, `notes` matching the numbered-instructions pattern the `openDrawer` fallback parses → untimed steps from the parse (the recipe's `notes` are left as they are).
   - Otherwise `method` stays null.
   - Live logs: `stageIndex` values are preserved because ACTIVE→PASSIVE ordering is preserved one-to-one by the conversion. The script asserts `methodToChain(converted).length === stages.length` per recipe and refuses to write on mismatch.
3. **Deploy order**: migration → deploy code that reads `method` first and falls back to `stages` → run the data script → later release drops `steps` / `stages` and the fallback.

The deploy pipeline runs no `migrate deploy`; the SQL is applied by hand over the session pooler and recorded with `migrate resolve`, as for `20260906000000_prep_stages`.

---

## 7 · Non-goals

- No auto-advance of a wait (decided in the staged-prep spec).
- No per-step persistence of ticks; no per-cook progress.
- No fixed phase vocabulary and no phase colouring.
- No change to what credits stock or when, to `autoUrgency`, to the one-live-log rule, or to the cadence layer.
- No timers for individual hands-on steps; a block's timer is the sum.

---

## 8 · Build order and verification

Each phase: `npm test` after any `src/lib` change, `npm run build` after anything else, and the acceptance checks. Existing tests in `prep-stages`, `prep-plan-stages`, `prep-plan-pipeline`, `prep-plan-cadence` stay unchanged — the derived chain must satisfy them as-is.

**Phase 1 — model + derivation.** Prisma column + migration SQL; `src/lib/recipe-method.ts` with `parseMethod`, `validateMethod`, `methodToChain`, `chainBlocks`, `methodTotals` + tests (validation sentences, the brisket example deriving to the nine-stage chain, adjacent-wait merging, untimed method → null, key stability); `resolveStages` reads `method` first; recipe routes accept `method`; `fetchRecipeWithCost` returns it.
Accept: a recipe with a method saves and reloads; its derived chain equals the hand-authored stages for the same content; unstaged recipes untouched.

**Phase 2 — editor.** The Method editor replaces both blocks in the recipe panel; Timing derives; print/view render waits.
Accept: author Smoked Brisket as in §2.4 in one pass; the run sheet shows the same behaviour as the hand-authored chain; a wait on the last step shows the sentence and does not save.

**Phase 3 — cook-along.** `openDrawer` reads `method` (fallback parser removed); `PrepRecipeSection` groups by phase, lights the current block, ticking the last step of a block calls `onStage`.
Accept: start brisket → tick both Curing steps → the row moves to the ladder as "Curing · wait" resting 12h → after readyAt it reads ready → open the drawer, tick the Smoking step → resting again → … → Done logs the yield exactly as before.

**Phase 4 — data migration.** Run the script (dry-run, then apply) on the live db; verify per-recipe chain equality; then a follow-up PR drops `steps` / `stages` and the fallback in `resolveStages`.

---

## 9 · Repo conventions that apply

- Flat Tailwind tokens; Lucide icons; sub-components at module scope; `md:` dual renderer; no `backdrop-blur` on scrims.
- Mutating routes export `dynamic = 'force-dynamic'`; polled GETs are `no-store`.
- Prisma singleton; Decimal serialises as string — `Number()`.
- One live log per item via `ensureLiveLogs`; `isLiveLog` / completion re-dating / `postedAt` clearing untouched.
- Migrations written by hand; never applied from a build session; applied by hand over the session pooler and recorded with `migrate resolve`.
