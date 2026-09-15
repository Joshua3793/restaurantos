# Prep — the resting row says where the job IS, and the drawer has one Method

**Date:** 2026-09-14
**Surfaces:** `/prep` To Do — the Waiting rows (`RestRow`, `RestRowMobile`) and the My-station hero (`NextUpHero`); the item drawer at both breakpoints (`PrepBoardDrawer` desktop, `PrepDrawer` mobile)
**Status:** design agreed, ready to build. Decisions recorded in §0.

Two readability problems on a staged job (a cure, a proof, a smoke):

1. **The Waiting row leads with the wrong thing.** Its big line is
   `Rinse & Rest · Cured Salmon` — the NEXT step, then the item — while the
   stage the job is actually in (`CURING · WAIT · 2/7`, "in the walk in fridge")
   is a small chip underneath. A cook scanning the ladder reads it as "go rinse
   the salmon". Working On rows already read the right way round (item name big,
   stage chip under), so only the resting rows and the hero are wrong.
2. **The drawer shows the same chain twice.** A "Stages" list (the derived
   `RecipeStage[]` with Back / Next) sits above a "Recipe & method" list whose
   method already carries the same waits inline, lights the current block, and
   advances on the last tick. Two lists, one truth, twice the height.

---

## 0 · Decisions (already made)

| Question | Decision |
|---|---|
| Resting row big line | **Item first, then stage**: `Cured Salmon · Curing`. Under it the stage's description and clock; the next step is the small subtitle. |
| Drawer | **One method list with waits inline.** The Stages list goes; the method list gains the prominent live-wait row and the Back / Next action row. `StageList.tsx` is deleted. |
| Data / API | **Unchanged.** Everything shown already arrives on `PrepItemRich.rest`, the recipe's `method`, and the live log. No lib maths change. |

---

## 1 · The resting row

### 1.1 Desktop `RestRow`

Task column, top to bottom (the ready-at column on the left and the
assignee · recipe · Next button group on the right are unchanged):

1. **Big line** — hourglass icon, then `{item.name} · {phase}` in the row's
   existing `text-[14px] font-semibold` style. `phase` is the stage's name with
   its trailing ` · wait` removed (`restPhaseName(stage)`, §4): a passive stage
   is named `${phase} · wait` by `methodToChain`, and the hourglass already says
   "wait". A stage named just `Wait` (no phase label) renders `Cured Salmon ·
   Wait`.
2. **Description line** — mono `text-[10px] text-ink-3`, wrapping: the stage
   note first when there is one, then the clock: `in the walk in fridge ·
   resting 11h17 of 24h` (or `· rested 11h17` once ready). Then the existing
   chips on the same wrapping row: `StageChip` (`CURING · WAIT · 2/7`, passive
   blue), `StationTag`, `DeadlineChip`.
3. **Subtitle** — mono `text-[10px] text-ink-4`, one line: `Next: Rinse & Rest ·
   15m hands-on`. The hands-on minutes are `rest.next.stage.minutes` (an ACTIVE
   stage's minutes are its hands-on total). When `rest.next` is null (cannot
   happen for a valid chain, which always ends ACTIVE, but the type allows it)
   the subtitle is omitted.

The Next button on the right keeps its label `Next: Rinse & Rest`; the
subtitle and the button say the same thing on purpose.

### 1.2 Mobile `RestRowMobile`

Same three lines in the row's existing sizes: big line `text-[13.5px]`,
description + chips in the existing `text-[9.5px]` wrapping row (`metaText`
becomes note-first, then clock, then station, then deadline), subtitle `Next:
Rinse & Rest · 15m` on its own line in `text-[9.5px] text-ink-4`. The 44px
arrow button keeps its `Next: …` aria-label.

### 1.3 My-station hero `NextUpHero`

- The 17px line beside the big ready-at time becomes `{item.name} · {phase}`.
- The mono meta line beneath becomes note-first: `in the walk in fridge ·
  resting 11h17 of 24h · Curing · wait · 2/7 · by TMRW 11:00`.
- A new mono line under it: `Next: Rinse & Rest · 15m hands-on`, in the hero's
  muted `#a1a1aa`.
- The `Next: Rinse & Rest` button and the `Recipe · stages` button stay; the
  latter is relabelled `Recipe · method` (the drawer no longer has a Stages
  section).

### 1.4 Not changed

`RunRow` / `RunRowMobile` (not started) and `WorkingRow` / `WorkingRowMobile`
(hands-on) already lead with the item name; untouched.

---

## 2 · The drawer: one Method section

### 2.1 What goes

- `PrepBoardDrawer` (desktop): the `Stages · <label>` section and its
  `StageList`.
- `PrepDrawer` (mobile): the `StageList` under the Status card.
- `src/components/prep/StageList.tsx`: deleted once nothing imports it.
- The header chips are untouched (`CURING · WAIT · 2/7` stays in both drawer
  headers — it is the at-a-glance state, not a list).

### 2.2 What the Method section becomes

`PrepRecipeSection` already renders: ingredients check-off, then the method —
phase labels, `StepRow` per step (tickable; the current block lit gold; past
blocks dimmed and ticked; the last step of the current block marked "tick to
move on"), and `WaitRow` after any step that carries a wait. Three changes:

1. **Section title carries the stage.** The method header line reads
   `Method · Curing · wait · 2/7` while the job is in flight (the same
   `stageLabel(index, total, stage)` the Stages header showed), else `Method ·
   tick as you go` as today. The `n / total` tick counter and progress bar on
   the right stay.
2. **The live wait is the lit row.** `WaitRow` today is a small indented mono
   line in every state. When the job is IN that wait (`live`), it becomes a
   full-width card in the list's own grid: blue background (`bg-blue-soft`),
   a hourglass badge in the number column (`bg-ink text-blue-text`, matching the
   lit step badge's `bg-ink text-gold`), a 13.5px title `Curing · wait` (the
   derived stage name), then the note on its own line, then a mono clock line
   `since 11:02 · resting 11h17 of 24h` that turns green with `· ready` once
   elapsed ≥ minutes. Waits the job is not in stay the
   small muted row they are today. This is the exact information the Stages
   list's lit row carried, now in the only list.
3. **Back / Next at the bottom of the method.** The action row moves from
   `StageList` into `PrepRecipeSection`, rendered directly under the method
   `<ol>` with the same gating the Stages list had: only when `onStage` is
   given AND the log is `IN_PROGRESS` with a stage index. `Back` (disabled at
   index 0) → `onStage(current − 1)`; `Next: <stage name>` → `onStage(current +
   1)`; on the last stage the Next slot reads `last stage — Done logs the
   yield`. The section needs the chain names for the Next label: derive them
   with `methodToChain(recipe.method)` (already the source of `chainBlocks`),
   so no new prop is required.

Ticking the last step of a block still calls `onStage(current + 1)`
(`tickMethodStep`), unchanged. Nothing advances on its own.

### 2.3 Both drawers, same section

`PrepRecipeSection` is shared, so both drawers get all three changes from one
edit. Each drawer only loses its Stages block. The mobile drawer's Status card
(pill + time / start-by) stays as it is.

---

## 3 · Edge cases

- **Untimed method (plain instructions, `method` null or `methodToChain` null):** no stage title suffix, no live wait, no Back / Next — exactly today's plain list. Nothing on `PrepItemRich.rest` either, so no resting rows exist for it.
- **Legacy recipe with `steps` but no `method`:** the fallback `recipe.steps.map(StepRow)` branch is untouched.
- **Job not in progress (row not started, or done):** the method list is plain (no lit block, no action row); the drawer opened from Smart Prep (`view === 'smart'`) passes no `onStage`, so no action row.
- **Passive stage without a note:** description line is just the clock.
- **`rest.next` null:** no subtitle, no Next button (already the case).
- **Stage named `Wait` (no phase):** big line `Cured Salmon · Wait`; the wait card title `Wait`.
- **Very long item name on a phone:** the big line wraps (`break-words`, as today); the subtitle truncates.

---

## 4 · Files

| File | Change |
|---|---|
| `src/lib/prep-stages.ts` | Add `restPhaseName(stage: RecipeStage): string` — the stage name with a trailing ` · wait` stripped (`'Curing · wait' → 'Curing'`, `'Wait' → 'Wait'`, an ACTIVE name unchanged). One unit test each. |
| `src/components/prep/runsheet/RestRow.tsx` | Big line, description line, subtitle per §1.1. |
| `src/components/prep/runsheet/RestRowMobile.tsx` | Per §1.2. |
| `src/components/prep/runsheet/NextUpHero.tsx` | Per §1.3. |
| `src/components/prep/PrepRecipeSection.tsx` | Stage-aware method title; live `WaitRow` card; Back / Next action row (§2.2). Imports `methodToChain`, `stageLabel`, `ArrowLeft`. |
| `src/components/prep/board/PrepBoardDrawer.tsx` | Remove the Stages section + `StageList` import; `stageLabel`/`stageAt` stay for the header chip. |
| `src/components/prep/PrepDrawer.tsx` | Remove the `StageList` block + import; `stageAt` stays for the header pill. |
| `src/components/prep/StageList.tsx` | Delete. |
| `CLAUDE.md` | No mention of `StageList`; no change needed unless the build says otherwise. |

---

## 5 · Verification

- `npm test` (new `restPhaseName` cases), lint on touched files, `npm run build` of the commit in an isolated worktree.
- Browser, dev server, KITCHEN To Do, the Cured Salmon job (in its curing wait):
  - Desktop Waiting row reads `Cured Salmon · Curing` / `in the walk in fridge · resting …` + chips / `Next: Rinse & Rest · 15m hands-on`; the Next button unchanged.
  - Phone: same row in `RunSheetMobile` Kitchen mode; My station hero shows the new lines and the `Recipe · method` button.
  - Drawer (desktop and phone): no Stages section; Method title `Method · Curing · wait · 2/7`; the Curing wait is the lit full-width card with note and clock; Back / Next row under the method; step 1 (Curing) ticked and dimmed.
  - Tap **Next** in the drawer → job moves to Rinse & Rest (hands-on): the row leaves Waiting for Working On, the drawer's lit row is now step 3, the action row reads `Next: Rinse & Rest · wait`. Tap **Back** → returns to the curing wait. State restored to where it was (the stage index only; `stageEnteredAt` will be re-stamped by the round trip — acceptable, note it in the PR).
