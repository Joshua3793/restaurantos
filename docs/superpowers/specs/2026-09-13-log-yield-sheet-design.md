# Prep — the Log yield sheet (one window, entered by unit or by batches)

**Date:** 2026-09-13
**Surfaces:** `/prep` — Working On rows (desktop + mobile), the item drawer (`PrepDrawer`), the board drawer (`PrepBoardDrawer`), Smart Prep quick-done
**Status:** design agreed, ready to build. Decisions recorded in §0.

Logging what a cook actually made is the one moment the prep system learns
something true: `PrepLog.actualPrepQty` is the only credit to theoretical
stock. Today that moment is a bare number field in the item's unit, painted
three slightly different ways (a quick bottom sheet, the item drawer's inline
field, the board drawer's input), none of them on-brand, and none of them
letting a cook say the thing a cook actually knows — *"I made a batch and a
half"*. This spec replaces all three with one sheet that takes the amount
either way and shows the consequence before it is logged.

---

## 0 · Decisions (already made)

| Question | Decision |
|---|---|
| Which surfaces | **All three.** One component replaces `PrepDoneSheet`, the item drawer's "How much did you make?" field, and the board drawer's quantity input. The drawers keep their Done button; it opens the sheet. |
| Batches vs unit | **One number, two handles** (option B). No mode toggle. The sheet holds one value, the unit amount; the batch slider/stepper and the unit field are two views of it, always in sync. |
| Batch range and step | **0 to 10 batches in 0.25 steps** on the slider and the ± buttons. A typed unit amount may exceed 10 batches; the slider pins, the readout tells the truth. |
| Done vs Partial | **Automatic, but shown.** `qty ≥ planned → DONE`, else `PARTIAL` — the rule the prep page already applies for the drawer (`onDrawerComplete`). The sheet previews it live on the caption and the button. The quick sheet's current "always DONE" is replaced by the same rule. |
| Stored value | **Unchanged.** `actualPrepQty` stays the UOM amount; batches are display and entry only (`batchYield` / `batchCount` / `batchesToQty` in `prep-plan.ts`). No API or schema change. |
| Prefill | Cook-along yield from the drawer when the cook set one, else the planned amount (half-batch-ceiled batches for batch items, `suggestedQty` otherwise), else empty. |
| Non-batch items | Items with no usable batch yield (no recipe, zero yield, cross-dimension yield, or `unit === 'batch'`) get the unit field only. Behaviour is otherwise identical. |

---

## 1 · Anatomy

One component, `LogYieldSheet`. On phones (< `md`) a bottom sheet over a plain
dim scrim — **no backdrop blur** (the prep page's spinning loader + the nav's
own filter made a blurred scrim re-blur the page every frame and froze weaker
laptops; `PrepDoneSheet` and both drawers already carry this rule). On desktop
a centred 440 px dialog with the same body.

Top to bottom:

1. **Header.** Green check tile (32 px, `bg-green`, white `IcCheck`), the item
   name in Geist Sans 16 px semibold, and one mono caption under it:
   `Planned ×1.5 batch · 9 l` (batch items) or `Planned 9 l` (others). Close
   button top-right, 32 px, `border-line`.
2. **Batch row** — batch items only.
   - A large mono readout `×1.5` (28 px, `text-ink`) with `batch` in 11 px mono
     `text-ink-3` beside it. When the value is off the quarter grid (typed unit
     amount) it reads the exact equivalent, e.g. `×1.13`.
   - `−` and `+` buttons either side, 40 × 40 px, `bg-bg-2 border-line`, stepping
     0.25.
   - Under it a slider, 0 → 10, quarter steps, full width, 44 px touch height.
     Custom track and thumb (no browser-default range styling): track `bg-bg-2`,
     filled portion `bg-gold`, thumb `bg-ink` 20 px with a `paper` ring; tick
     marks at whole batches, labels `0`, `5`, `10` in 9.5 px mono `text-ink-4`.
3. **Unit row.** One wide input, mono 18 px, `inputMode="decimal"`, with the
   unit as a fixed suffix inside the field (`9 │ l`). Always editable, always in
   sync with the batch row. For non-batch items this row is the whole body and
   receives autofocus; for batch items focus starts on the slider.
4. **Quick chips.** Ghost pills 32 px high, mono 10.5 px uppercase:
   **PLANNED** · **×1 BATCH** · **½ BATCH**. Tapping one sets the value. The chip
   matching the current value is filled (`bg-ink text-gold`, like the planner's
   batch toggle). Non-batch items show **PLANNED** only.
5. **Outcome line + button.** A mono caption stating the consequence —
   `Records Done · at or above plan` or `Records Partial · below plan` — then
   the full-width green button, 48 px, `Log 9 l · Done`. At zero the button is
   disabled and the caption reads `Enter how much you made`.

Tokens throughout are the run sheet's: `paper` surface, `line` borders, ink
scale for type, gold only on the slider fill and the selected chip, green only
on the confirm button. Radius 16 px on the sheet, 10 px on the field and
chips. Nothing here is a new pattern — it is the planner's `QtyStepper` and
`DraftRow` chips scaled up into a single-purpose sheet.

---

## 2 · Behaviour

### 2.1 One value, two views

The sheet's state is `qty: number` in the item's unit. Everything else is
derived:

| Gesture | Effect |
|---|---|
| Slider drag / arrow keys, `−` / `+`, a batch chip | `qty = batchesToQty(item, n)` with `n` on the quarter grid. |
| Typing in the unit field | `qty` set directly. Readout shows `batchCount(item, qty)` exactly (`×1.13`); the thumb parks at the nearest quarter **without** changing `qty`. |
| Next slider or ± gesture after a typed value | Snaps onto the grid from the parked position (`snapBatches`). |
| Typed amount above 10 batches | Allowed. Readout `×12`, thumb pinned at 10. `−` from there lands on 10. |
| Zero | Allowed as a state, not as a submission: button disabled. |

Batch step is **0.25** everywhere in this sheet (the planner's stepper keeps
its 0.5). Unit amounts round to two decimals. Batches format as `×1`, `×1.25`,
`×1.5`, `×1.75` (no trailing zeros); the unit amount formats with the run
sheet's `fmtQty` (one decimal for kg / l when fractional, whole numbers
otherwise).

### 2.2 Prefill

```
yieldPrefill(item, cookAlongQty?) → number
  1. cookAlongQty      — the drawer's upscale-slider yield (PrepLog.progress.makeQty),
                          only when the cook changed it (non-null)
  2. planned           — todayLog.requiredQty                          (the quantity the
                          chef posted on the live log, when there is one)
                          batchesToQty(item, suggestedBatches(item))   (batch items;
                          half-batch CEILED, identical to the planner's seed)
                          suggestedQty                                  (others)
  3. 0                 — nothing known (button disabled until typed)
```

The plan (`planned`) is the quantity the chef posted on the live log
(`todayLog.requiredQty`) when there is one, else the batch suggestion, else
`suggestedQty` — "Done means you made what the row asked for; the stock
suggestion moves under the row between posting and completion."

`planned` is also what the **PLANNED** chip and the Done/Partial rule use.
Reopening an already-done item prefills the logged `actualPrepQty` and the
button reads `Update 9 l · Done`.

### 2.3 Outcome

`yieldStatus(qty, planned) = qty >= planned ? 'DONE' : 'PARTIAL'` — moved out
of `onDrawerComplete` into the shared lib so the caption, the button and the
submit all read one function. A planned amount of 0 (at par, made anyway) is
Done for any positive amount. The quick-done path, which today hard-codes
`'DONE'`, adopts the rule.

### 2.4 Validation

`yieldWarning(qty, item)` mirrors the server's `validatePrepQty` (the
`MAX_PLAUSIBLE_BATCHES_PER_LOG = 50` unit-mix-up guard) and renders inline
under the unit field in `text-red-text` mono 11 px, with the button disabled
while it shows. The server keeps its guard; the sheet just stops the request
from being sent in the first place.

### 2.5 Keyboard and touch

Enter submits from the unit field. Escape closes. Slider: arrow keys step a
quarter, Shift+arrow a whole batch, Home / End go to 0 / 10. The slider is a
native `<input type="range" min=0 max=10 step=0.25>` for accessibility, with
its appearance reset and a custom track/thumb painted on top; `aria-valuetext`
reads `×1.5 batch · 9 l`.

---

## 3 · Integration

### 3.1 Files

| File | Change |
|---|---|
| `src/lib/prep-yield.ts` | **New.** Pure: `yieldPrefill`, `snapBatches`, `clampBatches`, `yieldStatus`, `yieldWarning`, `fmtBatches`. No React, no Prisma. |
| `src/components/prep/LogYieldSheet.tsx` | **New.** Renders only; every number comes from `prep-yield.ts` and `prep-plan.ts`. Props: `{ item: PrepItemRich; cookAlongQty?: number \| null; onClose(); onConfirm(item, qty, status) }`. |
| `src/components/prep/PrepDoneSheet.tsx` | **Deleted.** Not wrapped, not aliased. |
| `src/app/prep/page.tsx` | `doneSheetItem` state becomes `{ item, cookAlongQty }`. `onDrawerComplete` and the quick-done confirm collapse into one `onYieldLogged(item, qty, status)` that calls `handleStatusChange(item.id, status, qty)` and toasts. |
| `src/components/prep/PrepDrawer.tsx` | The inline "How much did you make?" field and `makeQty` prop go. Its Done button calls `onLogYield(item, drawerMakeQty)`; the upscale slider stays as the cook-along control and is what feeds `cookAlongQty`. |
| `src/components/prep/board/PrepBoardDrawer.tsx` | Same: the `type="number"` input and `makeQty` / `onMakeQtyChange` go; Done opens the sheet with the drawer's yield. |
| `WorkingRow`, `WorkingRowMobile`, `RunSheetMobile` | Unchanged call shape (`onLog(item)`); they never carried a quantity. |

### 3.2 Data flow

```
row Done ─┐
drawer Done ┼─▶ setYieldTarget({ item, cookAlongQty }) ─▶ <LogYieldSheet>
board Done ─┘                                                  │
                                              onConfirm(item, qty, status)
                                                               │
                                       handleStatusChange(item.id, status, qty)
                                                               │
                                PUT /api/prep/logs/[id] { status, actualPrepQty }   (unchanged)
```

No API change. The server still numberises `actualPrepQty`, still runs
`validatePrepQty`, still clears cook-along progress and the priority override
on completion, still invalidates the theoretical cache.

### 3.3 Edge cases

- **No usable batch yield** (`batchYield(item) == null`): no batch row, no
  `×1` / `½` chips, unit field autofocused. `yieldStatus` and prefill work from
  `suggestedQty`.
- **Offline:** unchanged — the optimistic status path already takes a qty and
  queues the PUT.
- **Cross-dimension recipe yield** (recipe yields kg, item counts each): treated
  as non-batch, exactly as `batchYield` does today.
- **Reopen after Done:** prefill the logged amount; button label `Update`.
- **Planned = 0:** Done for any positive amount; the PLANNED chip is hidden.
- **Reopen after Done — the prefill and `Update` label are implemented, but no
  surface opens the sheet on a completed log yet** (Done rows offer Reopen →
  In progress). Follow-up.

---

## 4 · Testing

`src/lib/__tests__/prep-yield.test.ts` (vitest, pure):

- prefill order: cook-along yield beats planned beats zero; planned batches are
  half-batch ceiled and equal `defaultDraftQty`;
- `snapBatches`: on-grid values unchanged, `1.13 → 1.25`, `1.12 → 1.0`, typed
  overflow pins the thumb at 10 while the readout keeps the exact count;
- `clampBatches`: `−` from 12 lands on 10, `+` at 10 stays at 10, floor at 0;
- `yieldStatus`: equal to planned is Done, one hundredth under is Partial,
  planned 0 is Done for any positive qty;
- `yieldWarning` agrees with `validatePrepQty` on both sides of the 50-batch
  line;
- `fmtBatches`: `×1`, `×1.25`, `×1.5`, `×12`.

Browser check (dev server): open the sheet from a Working On row, from the
item drawer, and from the board drawer; phone width and desktop; confirm the
toast and the run sheet's Done row show the same amount and status.

---

## 5 · Out of scope

- Changing the planner's 0.5-batch stepper.
- Logging a yield in a unit other than the item's.
- A per-stage yield for staged jobs — DONE remains the single credit point.
