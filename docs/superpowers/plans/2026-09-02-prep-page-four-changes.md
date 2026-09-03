# Prep Page — Four Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the To Do "Working On" band into full-width list rows, add an instant remove from the kitchen's list, make Smart Prep survive offline, and put ±0.25× steppers on the cook-along upscale bar.

**Architecture:** Four independent changes in `/prep`. Two are pure presentation (new run-sheet row components replacing the horizontal rails; stepper buttons on an existing slider). One adds a single atomic API route plus its optimistic client handler. One extends the existing `localStorage` queue in `src/lib/prep-offline.ts` with three mutation types and makes the item cache authoritative when the network fails.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma/PostgreSQL · Tailwind (flat tokens) · Lucide icons · vitest

**Spec:** `docs/superpowers/specs/2026-09-02-prep-page-four-changes-design.md`

## Global Constraints

- **Tailwind colours are flat tokens only.** `bg-red`, `text-red-text`, `bg-gold-soft`, `text-gold-2`, `bg-ink`, `text-paper`, `border-line`. Numbered classes (`bg-red-500`) are broken in this repo — never emit them.
- **Prisma singleton.** Import `prisma` from `@/lib/prisma`. Never `new PrismaClient()`.
- **Every mutating route needs `export const dynamic = 'force-dynamic'`** or non-GET methods return 405.
- **API routes guard themselves.** Middleware excludes `/api`. Each handler calls `requireSession(minRole?)` from `@/lib/auth` and catches `AuthError` into `NextResponse.json({ error }, { status })`.
- **Sub-components at module scope.** A component defined inside another component's body remounts every render and loses focus/state.
- **Prisma `Decimal` arrives as a string in JSON.** Wrap with `Number()` before arithmetic.
- **`npm run build` is the type check.** `npm test` covers the pure libs and runs in <1s.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## File Structure

**Create:**
- `src/components/prep/runsheet/WorkingRow.tsx` — desktop in-progress row (Task 2)
- `src/components/prep/runsheet/WorkingRowMobile.tsx` — mobile in-progress row (Task 3)
- `src/app/api/prep/plan/remove-item/route.ts` — atomic un-post + un-draft of one item (Task 4)
- `src/lib/__tests__/prep-offline.test.ts` — queue dedup/merge/flush tests (Task 6)

**Delete:**
- `src/components/prep/runsheet/InProgressRail.tsx` (Task 2)
- `src/components/prep/runsheet/InProgressRailMobile.tsx` (Task 3)

**Modify:**
- `src/components/prep/PrepRecipeSection.tsx` — ± steppers (Task 1)
- `src/components/prep/runsheet/RunSheet.tsx` — rail → stacked rows (Task 2); thread `onRemove` (Task 5)
- `src/components/prep/runsheet/RunSheetMobile.tsx` — rail → stacked rows (Task 3); thread `onRemove` (Task 5)
- `src/components/prep/runsheet/RunRow.tsx` — `×` button (Task 5)
- `src/components/prep/runsheet/RunRowMobile.tsx` — `×` button (Task 5)
- `src/components/prep/PrepToast.tsx` — optional action button (Task 5)
- `src/lib/prep-offline.ts` — three new mutation types, merge dedup, `ensureLogId`, plan cache (Task 6)
- `src/app/prep/page.tsx` — remove handler (Task 5), offline enqueues (Task 7), cache-first paint (Task 8)
- `src/components/prep/PrepDoneSheet.tsx`, `src/components/prep/runsheet/NextUpHero.tsx` — stale comments referencing the deleted rails (Task 3)

---

## Task 1: ± steppers on the upscale bar

Smallest, fully independent change. Ship it first.

**Files:**
- Modify: `src/components/prep/PrepRecipeSection.tsx:32-33` (constants), `:263-272` (the slider row)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks rely on.

**Context:** This is the cook-along scale control used by `PrepDrawer` and `PrepBoardDrawer`. `makeQty` is held by the parent and is always in the **prep item's** unit; `baseInUnit` converts one recipe batch into that unit; `factor = makeQty / baseInUnit`. The slider already steps 0.25 within `[0.25, 5]` but is drag-only.

`factor` is derived, so it can sit off-grid (1.13×). A stepper that adds 0.25 to 1.13 gives 1.38 — still off-grid. Snap to the neighbouring quarter instead so every press lands on a quarter and always moves.

- [ ] **Step 1: Add the step helper above the component**

Insert directly after the existing `clamp` helper (around `src/components/prep/PrepRecipeSection.tsx:35`):

```ts
/**
 * Next/previous 0.25 step for an off-grid factor.
 *
 * `factor` is derived (makeQty / baseInUnit), so it is frequently NOT a
 * multiple of 0.25 — a plain `f + 0.25` would keep an off-grid value off-grid
 * forever. Floor/ceil onto the quarter grid instead: from 1.13, `+` lands on
 * 1.25 and `-` on 1.00, and from an on-grid 1.25 they land on 1.5 and 1.0.
 * Always moves, always lands on a quarter.
 */
function stepFactor(factor: number, dir: 1 | -1): number {
  const q = factor * 4
  const next = dir === 1 ? Math.floor(q + 1) : Math.ceil(q - 1)
  return clamp(next / 4, SLIDER_MIN, SLIDER_MAX)
}
```

- [ ] **Step 2: Import the icons**

`src/components/prep/PrepRecipeSection.tsx` — add `Minus` and `Plus` to the existing `lucide-react` import. If the file has no `lucide-react` import yet, add:

```ts
import { Minus, Plus } from 'lucide-react'
```

- [ ] **Step 3: Wrap the slider with the two buttons**

Replace the `<input type="range" … />` element at `src/components/prep/PrepRecipeSection.tsx:263-272` with:

```tsx
        <button
          type="button"
          onClick={() => onMakeQtyChange(stepFactor(factor, -1) * baseInUnit)}
          disabled={sliderValue <= SLIDER_MIN}
          aria-label="Decrease batch by a quarter"
          className="w-8 h-8 shrink-0 rounded-full border border-[#fed7aa] bg-paper grid place-items-center text-gold-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Minus size={14} />
        </button>
        <input
          type="range"
          min={SLIDER_MIN}
          max={SLIDER_MAX}
          step={0.25}
          value={sliderValue}
          onChange={(e) => onMakeQtyChange(parseFloat(e.target.value) * baseInUnit)}
          className="flex-1 accent-gold"
        />
        <button
          type="button"
          onClick={() => onMakeQtyChange(stepFactor(factor, 1) * baseInUnit)}
          disabled={sliderValue >= SLIDER_MAX}
          aria-label="Increase batch by a quarter"
          className="w-8 h-8 shrink-0 rounded-full border border-[#fed7aa] bg-paper grid place-items-center text-gold-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus size={14} />
        </button>
```

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: build completes, no TypeScript errors.

- [ ] **Step 5: Verify in the browser**

Open the prep page preview, open any To Do item's drawer with a linked recipe, and confirm on the "Making" row:
- `−` / `+` flank the slider.
- Each press moves `×N.NN of base` by exactly 0.25 and the `{qty} {unit}` readout tracks it.
- `−` is disabled at ×0.25, `+` is disabled at ×5.
- The "This batch $N" cost line updates with each press.

- [ ] **Step 6: Commit**

```bash
git add src/components/prep/PrepRecipeSection.tsx
git commit -m "feat(prep): 0.25x stepper buttons on the cook-along upscale bar

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Working On row — desktop

**Files:**
- Create: `src/components/prep/runsheet/WorkingRow.tsx`
- Delete: `src/components/prep/runsheet/InProgressRail.tsx`
- Modify: `src/components/prep/runsheet/RunSheet.tsx:15` (import), `:344-348` (the band)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `WorkingRow` — props
  `{ item: PrepItemRich; nowMs: number; cooks: Cook[]; onClaim?: (item: PrepItemRich, cookId: string | null) => void; onLog: (item) => void; onStop: (item) => void; onOpenRecipe: (item) => void }`.
  Task 3 mirrors this shape for mobile.

**Context:** The band already exists and is already positioned above the ladder (so above **Late to start** in Time grouping and **Critical-Start Service** in Priority grouping). Only the row format changes: horizontal-scroll cards become a stacked list on RunRow's grid.

- [ ] **Step 1: Create the component**

Create `src/components/prep/runsheet/WorkingRow.tsx`:

```tsx
'use client'
// Prep run-sheet — desktop in-progress row.
//
// Replaces the old horizontal-scroll InProgressRail: an item being worked on is
// part of the list, not a widget beside it, so it uses RunRow's grid and reads
// as one more line above the ladder. Gold contrast marks it as live.
//
// The 64px column that carries start-by on a RunRow carries the live timer here
// — start-by is meaningless once a job has started, and elapsed/remaining is the
// number a cook actually wants.
import { useRef, useState } from 'react'
import { Flame, RotateCcw } from 'lucide-react'
import { draftQty, batchLabel } from '@/lib/prep-plan'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { AssigneeChip, ClaimPopover } from './assignee'
import { StationTag } from './atoms'
import { IcCheck, IcRecipe } from '@/components/prep/icons'
import { minutesBetween, fmtMins } from '@/lib/prep-runsheet'

// Same rounding rule as RunRow/RunSheet: kg/L show one decimal only when
// fractional, everything else rounds to a whole number.
function fmtQty(q: number, u: string): string {
  const v = (u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)
  return `${v} ${u}`
}

export function WorkingRow({
  item,
  nowMs,
  cooks,
  onClaim,
  onLog,
  onStop,
  onOpenRecipe,
}: {
  item: PrepItemRich
  nowMs: number
  cooks: Cook[]
  onClaim?: (item: PrepItemRich, cookId: string | null) => void
  onLog: (item: PrepItemRich) => void
  /** Abandon an in-progress prep (no yield logged) → back onto the run sheet. */
  onStop: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  const [claimOpen, setClaimOpen] = useState(false)
  const claimAnchor = useRef<HTMLDivElement>(null)

  const startedAt = item.todayLog?.startedAt
  const elapsed = startedAt ? minutesBetween(new Date(startedAt).getTime(), nowMs) : 0
  const remaining = (item.activeMinutes ?? 0) + (item.passiveMinutes ?? 0) - elapsed
  const qty = draftQty(item) || (item.targetToday ?? item.parLevel)
  const batch = batchLabel(item, qty)

  // Same lg: stacking rule the ladder rows follow — below lg the action cluster
  // drops to its own line rather than squeezing the name column.
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] lg:grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 bg-gold-soft border border-[#fcd34d] border-l-[3px] border-l-gold rounded-[11px] py-[13px] px-4">
      {/* live timer — where start-by sits on a RunRow */}
      <div className="self-start lg:self-center">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse shrink-0" />
          <span className="font-mono text-[14px] font-semibold tracking-[-0.01em] text-ink">
            {fmtMins(elapsed)}
          </span>
        </div>
        <div
          className={`font-mono text-[9px] mt-0.5 whitespace-nowrap ${
            remaining >= 0 ? 'text-gold-2' : 'text-red-text font-semibold'
          }`}
        >
          {remaining >= 0 ? `~${fmtMins(remaining)} to go` : `over by ${fmtMins(-remaining)}`}
        </div>
      </div>

      {/* task — the name never truncates; it is the one thing a cook must read. */}
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-[22px] h-[22px] rounded-[7px] bg-ink grid place-items-center shrink-0">
            <Flame size={13} className="text-gold" />
          </span>
          <span
            onClick={() => onOpenRecipe(item)}
            title="Open recipe"
            className="text-[14px] font-semibold tracking-[-0.015em] break-words cursor-pointer underline decoration-[#fcd34d] underline-offset-[3px]"
          >
            {item.name}
          </span>
        </div>
        <div className="flex items-center gap-x-3.5 gap-y-1 flex-wrap mt-1">
          <span className="font-mono text-[11px] text-gold-2">
            {batch ? `${batch} · ${fmtQty(qty, item.unit)}` : fmtQty(qty, item.unit)}
          </span>
          {item.station && <StationTag>{item.station}</StationTag>}
        </div>
      </div>

      {/* claim · recipe · stop · done */}
      <div className="col-start-2 lg:col-start-3 flex items-center gap-[7px] justify-start lg:justify-end">
        {onClaim ? (
          <div ref={claimAnchor} className="relative shrink-0">
            <AssigneeChip cook={item.assignedCook} onClick={() => setClaimOpen(o => !o)} />
            {claimOpen && (
              <ClaimPopover
                anchorRef={claimAnchor}
                cooks={cooks}
                currentId={item.assignedCook?.id ?? null}
                onPick={cookId => {
                  onClaim(item, cookId)
                  setClaimOpen(false)
                }}
                onClose={() => setClaimOpen(false)}
              />
            )}
          </div>
        ) : (
          <AssigneeChip cook={item.assignedCook} />
        )}
        <button
          onClick={() => onOpenRecipe(item)}
          title="Recipe"
          className="w-[34px] h-[34px] rounded-[9px] bg-paper border border-[#fcd34d] grid place-items-center cursor-pointer shrink-0 text-ink-2"
        >
          <IcRecipe size={15} />
        </button>
        <button
          onClick={() => onStop(item)}
          title="Stop prep — back to the run sheet"
          className="inline-flex items-center gap-[5px] bg-paper text-ink-2 border border-[#fcd34d] rounded-[9px] px-3 py-2 text-[12.5px] font-semibold cursor-pointer shrink-0 hover:border-ink-3"
        >
          <RotateCcw size={13} /> Stop
        </button>
        <button
          onClick={() => onLog(item)}
          className="inline-flex items-center gap-1.5 bg-ink text-paper border-none rounded-[9px] px-3.5 py-2 text-[12.5px] font-semibold cursor-pointer shrink-0"
        >
          <IcCheck size={13} className="text-gold" strokeWidth={2.8} /> Done
        </button>
      </div>
    </div>
  )
}
```

Note there is deliberately **no** `×` on this row. A job in flight is Stopped first, then removed — the destructive action stays away from an item someone is standing over.

- [ ] **Step 2: Swap the band in RunSheet**

In `src/components/prep/runsheet/RunSheet.tsx`, replace the import at line 15:

```ts
import { InProgressRail } from './InProgressRail'
```

with:

```ts
import { WorkingRow } from './WorkingRow'
```

Then replace the in-progress band (around `:344-349`):

```tsx
      {/* in-progress rail */}
      {doing.length > 0 && (
        <>
          <GroupHead dot="bg-gold" title="Working On" count={doing.length} sub="parallel timers — mark done to log yield" />
          <InProgressRail items={doing} nowMs={nowMs} cooks={cooks} onClaim={onClaim} onLog={onLog} onStop={onStop} onOpenRecipe={onOpenRecipe} />
        </>
      )}
```

with:

```tsx
      {/* Working On — full-width rows on the ladder's own grid, above every
          ladder group in all three groupings. */}
      {doing.length > 0 && (
        <>
          <GroupHead dot="bg-gold" title="Working On" count={doing.length} sub="parallel timers — mark done to log yield" />
          <div className="flex flex-col gap-2">
            {doing.map(i => (
              <WorkingRow
                key={i.id}
                item={i}
                nowMs={nowMs}
                cooks={cooks}
                onClaim={onClaim}
                onLog={onLog}
                onStop={onStop}
                onOpenRecipe={onOpenRecipe}
              />
            ))}
          </div>
        </>
      )}
```

- [ ] **Step 3: Fix the stale comment in RunSheet**

`src/components/prep/runsheet/RunSheet.tsx:26` reads:

```
// Local port of the prototype's `ptFmtQ` (same rule as RunRow/InProgressRail):
```

Change `InProgressRail` to `WorkingRow`.

- [ ] **Step 4: Delete the rail**

```bash
git rm src/components/prep/runsheet/InProgressRail.tsx
```

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: build completes. A failure naming `InProgressRail` means a leftover import — grep for it and remove.

- [ ] **Step 6: Verify in the browser**

At desktop width on `/prep` → To do, start two preps and confirm:
- Both appear as full-width gold rows stacked vertically under `Working On`, nothing scrolls sideways.
- The band sits above the first ladder group in Time, Station **and** Priority grouping.
- Timer counts up; Claim popover, Recipe, Stop and Done all work.
- Narrow the window below `lg` — the action cluster drops to a second line and the name stays whole.

- [ ] **Step 7: Commit**

```bash
git add -A src/components/prep/runsheet/
git commit -m "feat(prep): Working On band becomes full-width rows on desktop

Replaces the horizontal-scroll InProgressRail with WorkingRow on the
ladder's own grid. The 64px start-by column carries the live timer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Working On row — mobile

**Files:**
- Create: `src/components/prep/runsheet/WorkingRowMobile.tsx`
- Delete: `src/components/prep/runsheet/InProgressRailMobile.tsx`
- Modify: `src/components/prep/runsheet/RunSheetMobile.tsx:15` (import), `:270-279` (the band)
- Modify: `src/components/prep/PrepDoneSheet.tsx:8`, `src/components/prep/runsheet/NextUpHero.tsx:12` (stale comments)

**Interfaces:**
- Consumes: the visual language established by `WorkingRow` in Task 2.
- Produces: `WorkingRowMobile` — props
  `{ item: PrepItemRich; nowMs: number; onClaim?: (item: PrepItemRich) => void; onLog: (item) => void; onStop: (item) => void; onOpenRecipe: (item) => void }`.
  Note `onClaim` takes **one** argument here (the parent's `claimTap` closes over the current cook), unlike the desktop two-argument form.

**Context:** `RunRowMobile` carries a single 44px action button. The working row needs two — Stop and Done. There is no room for a fourth, so **recipe opens by tapping the name**, which is already the recipe-open target on `RunRowMobile`. This is a deliberate tradeoff, not an omission.

- [ ] **Step 1: Create the component**

Create `src/components/prep/runsheet/WorkingRowMobile.tsx`:

```tsx
'use client'
// Prep run-sheet — mobile in-progress row.
//
// Mobile twin of WorkingRow: replaces the horizontal-scroll InProgressRailMobile
// so a live job reads as one more line in the list. Shape mirrors RunRowMobile
// (44px left column, flex-1 name + meta with the claim chip riding the meta
// line), with the timer in the left column instead of start-by.
//
// RunRowMobile has room for ONE 44px action button; this row needs two (Stop and
// Done), so there is no room for a recipe button — the name is the recipe-open
// target, exactly as it is on RunRowMobile.
import { Flame, RotateCcw } from 'lucide-react'
import { draftQty, batchLabel } from '@/lib/prep-plan'
import type { PrepItemRich } from '@/components/prep/types'
import { AssigneeChip } from './assignee'
import { IcCheck } from '@/components/prep/icons'
import { minutesBetween, fmtMins } from '@/lib/prep-runsheet'

function fmtQty(q: number, u: string): string {
  const v = (u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)
  return `${v} ${u}`
}

export function WorkingRowMobile({
  item,
  nowMs,
  onClaim,
  onLog,
  onStop,
  onOpenRecipe,
}: {
  item: PrepItemRich
  nowMs: number
  /** Tap-to-claim (the parent's claimTap closes over the current cook). */
  onClaim?: (item: PrepItemRich) => void
  onLog: (item: PrepItemRich) => void
  /** Abandon an in-progress prep (no yield logged) → back onto the run sheet. */
  onStop: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  const startedAt = item.todayLog?.startedAt
  const elapsed = startedAt ? minutesBetween(new Date(startedAt).getTime(), nowMs) : 0
  const remaining = (item.activeMinutes ?? 0) + (item.passiveMinutes ?? 0) - elapsed
  const qty = draftQty(item) || (item.targetToday ?? item.parLevel)
  const batch = batchLabel(item, qty)

  return (
    <div className="flex items-center gap-3 bg-gold-soft border border-[#fcd34d] border-l-[3px] border-l-gold rounded-[11px] py-[11px] px-[13px]">
      {/* live timer — where start-by sits on a RunRowMobile */}
      <div className="w-11 shrink-0">
        <div className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse shrink-0" />
          <span className="font-mono text-[12.5px] font-semibold tracking-[-0.01em] text-ink">
            {fmtMins(elapsed)}
          </span>
        </div>
        <div
          className={`font-mono text-[8.5px] mt-px whitespace-nowrap ${
            remaining >= 0 ? 'text-gold-2' : 'text-red-text font-semibold'
          }`}
        >
          {remaining >= 0 ? `${fmtMins(remaining)} left` : `over ${fmtMins(-remaining)}`}
        </div>
      </div>

      {/* task — tapping the name opens the recipe (no room for a recipe button) */}
      <div onClick={() => onOpenRecipe(item)} className="flex-1 min-w-0 cursor-pointer">
        <div className="flex items-center gap-1.5">
          <span className="w-5 h-5 rounded-[6px] bg-ink grid place-items-center shrink-0">
            <Flame size={12} className="text-gold" />
          </span>
          <div className="text-[13.5px] font-semibold tracking-[-0.01em] break-words min-w-0">
            {item.name}{' '}
            <span className="font-mono text-[10.5px] font-normal text-gold-2 whitespace-nowrap">
              {batch ? `${batch} · ${fmtQty(qty, item.unit)}` : fmtQty(qty, item.unit)}
            </span>
          </div>
        </div>
        {/* stopPropagation so tapping the chip claims the item instead of opening
            the recipe (the whole block above is the recipe-open target). */}
        <div className="flex items-center gap-2 flex-wrap font-mono text-[9.5px] text-gold-2 mt-[3px]">
          {item.station && <span>{item.station}</span>}
          <span onClick={e => e.stopPropagation()}>
            <AssigneeChip cook={item.assignedCook} size="sm" onClick={onClaim ? () => onClaim(item) : undefined} />
          </span>
        </div>
      </div>

      <button
        onClick={() => onStop(item)}
        title="Stop prep — back to the run sheet"
        aria-label="Stop prep"
        className="w-11 h-11 rounded-[10px] bg-paper border border-[#fcd34d] grid place-items-center cursor-pointer shrink-0 text-ink-2"
      >
        <RotateCcw size={15} />
      </button>
      <button
        onClick={() => onLog(item)}
        aria-label="Done — log yield"
        className="w-11 h-11 rounded-[10px] bg-ink border-none grid place-items-center cursor-pointer shrink-0"
      >
        <IcCheck size={15} className="text-gold" strokeWidth={2.8} />
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Swap the band in RunSheetMobile**

In `src/components/prep/runsheet/RunSheetMobile.tsx`, replace the import at line 15:

```ts
import { InProgressRailMobile } from './InProgressRailMobile'
```

with:

```ts
import { WorkingRowMobile } from './WorkingRowMobile'
```

Then replace the band (around `:270-279`):

```tsx
      {/* in-progress rail */}
      {doing.length > 0 && (
        <>
          <GroupHead dot="bg-gold" title="Working On" count={doing.length} sub="tap done to log yield" />
          {/* full-bleed horizontal scroll rail */}
          <div className="-mx-4 px-4">
            <InProgressRailMobile items={doing} nowMs={nowMs} onClaim={claimTap} onLog={onLog} onStop={onStop} onOpenRecipe={onOpenRecipe} />
          </div>
        </>
      )}
```

with:

```tsx
      {/* Working On — full-width rows, above every ladder group. */}
      {doing.length > 0 && (
        <>
          <GroupHead dot="bg-gold" title="Working On" count={doing.length} sub="tap done to log yield" />
          <div className="flex flex-col gap-2">
            {doing.map(i => (
              <WorkingRowMobile
                key={i.id}
                item={i}
                nowMs={nowMs}
                onClaim={claimTap}
                onLog={onLog}
                onStop={onStop}
                onOpenRecipe={onOpenRecipe}
              />
            ))}
          </div>
        </>
      )}
```

- [ ] **Step 3: Delete the mobile rail**

```bash
git rm src/components/prep/runsheet/InProgressRailMobile.tsx
```

- [ ] **Step 4: Fix the two stale comments**

`src/components/prep/PrepDoneSheet.tsx:8` reads:

```
 * rail "Log" button (desktop InProgressRail / mobile InProgressRailMobile) and
```

Change to:

```
 * "Done" button on a Working On row (WorkingRow / WorkingRowMobile) and
```

`src/components/prep/runsheet/NextUpHero.tsx:12` reads:

```
// RunRow.tsx / InProgressRail.tsx.
```

Change `InProgressRail.tsx` to `WorkingRow.tsx`.

Also check `src/components/prep/runsheet/RunRowMobile.tsx:16`, which reads
`// RunRow.tsx/InProgressRail.tsx; kept local since no shared helper matches it.` —
change `InProgressRail.tsx` to `WorkingRow.tsx`.

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: build completes. Any error naming `InProgressRailMobile` means a leftover import.

Then confirm no dangling references:

Run: `grep -rn "InProgressRail" src/`
Expected: no output.

- [ ] **Step 6: Verify in the browser**

Resize the preview to mobile (375×812) and reload, then on `/prep` → To do:
- Start two preps: both render as full-width gold rows stacked vertically, nothing scrolls sideways.
- Tapping the name opens the drawer/recipe; tapping the assignee chip claims without opening it.
- Stop and Done both work; the timer ticks.
- Check both `My station` and `Kitchen` modes.

- [ ] **Step 7: Commit**

```bash
git add -A src/components/prep/
git commit -m "feat(prep): Working On band becomes full-width rows on mobile

Mirrors WorkingRow. Recipe opens by tapping the name — a phone row has
room for two 44px buttons (Stop, Done), not three.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: `POST /api/prep/plan/remove-item`

**Files:**
- Create: `src/app/api/prep/plan/remove-item/route.ts`

**Interfaces:**
- Consumes: `livePost`, `ensureLiveLogs`, `postedOpenWhere` from `@/lib/prep-plan-server`; `resolveActive` from `@/lib/prep-runsheet`; `assertRcWritable` from `@/lib/rc-scope`.
- Produces: `POST /api/prep/plan/remove-item` accepting
  `{ revenueCenterId: string; prepItemId: string; restore?: boolean }` and returning `{ ok: true }`.
  Tasks 5, 6 and 7 call it.

**Context — three things this route must get right:**

1. `isOnList: false` alone does **not** take a row off To Do. `todayItems` in `src/app/prep/page.tsx:379` keeps any row with `todayLog.postedAt != null`. Both have to change.
2. `postedOpenWhere` is `{ postedAt: { not: null }, status: { in: OPEN_PREP_STATUSES } }`. It **cannot** find the row a removal just cleared, so `restore` must resolve the log a different way — `ensureLiveLogs`, which is also the helper that keeps the one-live-log-per-item invariant.
3. `PostedBand` renders `{itemCount} item(s) · {activeMinutes} hands-on`. Leave the `PrepPost` header alone and the band misreports the list it sits on. Adjust both counters.

The default direction mirrors exactly what `POST /api/prep/plan/post` already does to items `notIn draftIds` — this route is a shortcut to a state the app can already reach, not a new one.

- [ ] **Step 1: Write the route**

Create `src/app/api/prep/plan/remove-item/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { resolveActive } from '@/lib/prep-runsheet'
import { livePost, ensureLiveLogs, postedOpenWhere } from '@/lib/prep-plan-server'

export const dynamic = 'force-dynamic'

// Take ONE item off the kitchen's To Do without the Smart Prep → remove →
// re-post round trip, or put it back (`restore`).
//
// The end state is exactly what a re-post produces: `POST /api/prep/plan/post`
// already clears postedAt for every item `notIn draftIds`. This is a shortcut to
// a state the app can already reach, not a new one.
//
// Deliberately NOT here: any inventory write. No PrepLog status change, no
// theoretical-stock invalidation, no InventoryTransaction. The prep is simply
// not on today's list.
//
// Deliberately NOT here: markPlanDirty. The removal is already reflected on the
// line, so flagging the post as "chef has unposted changes" would be a lie.
export async function POST(req: NextRequest) {
  let user
  try { user = await requireSession('LEAD') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => null)
  const revenueCenterId: string | undefined = body?.revenueCenterId
  const prepItemId: string | undefined = body?.prepItemId
  const restore: boolean = body?.restore === true
  if (!revenueCenterId) return NextResponse.json({ error: 'revenueCenterId is required' }, { status: 400 })
  if (!prepItemId) return NextResponse.json({ error: 'prepItemId is required' }, { status: 400 })

  try { await assertRcWritable(user, revenueCenterId) }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  // Minutes this item contributes to the posted header's hands-on total — the
  // same expression POST /api/prep/plan/post sums when it builds that total.
  const item = await prisma.prepItem.findUnique({
    where: { id: prepItemId },
    select: {
      id: true, estimatedPrepTime: true,
      activeMinutesOverride: true, passiveMinutesOverride: true, passiveNoteOverride: true,
      linkedRecipe: { select: { activeMinutes: true, passiveMinutes: true, passiveNote: true } },
    },
  })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const itemMinutes = resolveActive(item) ?? item.estimatedPrepTime ?? 0

  const post = await livePost(revenueCenterId)

  if (restore) {
    // postedOpenWhere requires postedAt != null, so it cannot find the row the
    // removal just cleared. ensureLiveLogs resolves (or creates) the item's ONE
    // live log — the same primitive the post route uses, and what keeps the
    // one-live-log-per-item invariant.
    const liveLogs = await ensureLiveLogs([prepItemId], revenueCenterId)
    const logId = liveLogs.get(prepItemId)
    if (!logId) return NextResponse.json({ error: 'Could not resolve a live log for this item' }, { status: 409 })

    await prisma.$transaction([
      prisma.prepLog.update({ where: { id: logId }, data: { postedAt: new Date() } }),
      prisma.prepItem.update({ where: { id: prepItemId }, data: { isOnList: true } }),
      ...(post ? [prisma.prepPost.update({
        where: { id: post.id },
        data: { itemCount: post.itemCount + 1, activeMinutes: post.activeMinutes + itemMinutes },
      })] : []),
    ])
    return NextResponse.json({ ok: true })
  }

  await prisma.$transaction([
    // Any day, not just today: a carried job's row is exactly what holds it on
    // the list. Scoped to this RC so a removal cannot empty another's To Do.
    prisma.prepLog.updateMany({
      where: { revenueCenterId, prepItemId, ...postedOpenWhere },
      data: { postedAt: null },
    }),
    prisma.prepItem.update({ where: { id: prepItemId }, data: { isOnList: false } }),
    // Keep the posted header honest — PostedBand renders both of these. Floored
    // at 0: a header can predate this item joining the list. The row itself is
    // never deleted; emptying the whole list is what Recall is for.
    ...(post ? [prisma.prepPost.update({
      where: { id: post.id },
      data: {
        itemCount: Math.max(0, post.itemCount - 1),
        activeMinutes: Math.max(0, post.activeMinutes - itemMinutes),
      },
    })] : []),
  ])

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Type-check and confirm the route is dynamic**

Run: `npm run build`
Expected: build completes, and the route table lists `/api/prep/plan/remove-item` as `ƒ (Dynamic)`, not `○ (Static)`. A `○` means the `dynamic` export is missing and every POST will 405.

- [ ] **Step 3: Exercise the route against the dev server**

With the dev server running and signed in as a LEAD+ user, from the browser console on `/prep` (substitute a real posted item id and the active RC id):

```js
await fetch('/api/prep/plan/remove-item', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ revenueCenterId: '<rcId>', prepItemId: '<itemId>' }),
}).then(r => r.json())
```

Expected: `{ ok: true }`. Reload — the item is gone from To Do, is back in Smart Prep's suggestions, and the posted band's item count and hands-on total have each dropped by that item's share.

Then run the same call with `restore: true` and reload: the item is back on To Do and the band's counters are restored.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/prep/plan/remove-item/route.ts
git commit -m "feat(prep): POST /api/prep/plan/remove-item

Atomic un-post + un-draft of one item, with the inverse behind
restore:true. Adjusts PrepPost.itemCount/activeMinutes so PostedBand
does not misreport the list. No inventory write, no markPlanDirty.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: The `×` button, the Undo toast, and the client handler

**Files:**
- Modify: `src/components/prep/PrepToast.tsx` (whole file)
- Modify: `src/components/prep/runsheet/RunRow.tsx` (props + button)
- Modify: `src/components/prep/runsheet/RunRowMobile.tsx` (props + button)
- Modify: `src/components/prep/runsheet/RunSheet.tsx` (prop passthrough)
- Modify: `src/components/prep/runsheet/RunSheetMobile.tsx` (prop passthrough)
- Modify: `src/app/prep/page.tsx` (handler + wiring)

**Interfaces:**
- Consumes: `POST /api/prep/plan/remove-item` from Task 4.
- Produces:
  - `usePrepToast()` → `{ toast(msg: string, action?: { label: string; onClick: () => void }): void; toastNode: JSX.Element }`
  - `RunRow` / `RunRowMobile` gain optional `onRemove?: (item: PrepItemRich) => void`; the `×` renders only when it is supplied.
  - `RunSheet` / `RunSheetMobile` gain optional `onRemove?: (item: PrepItemRich) => void`, passed straight through.
  - `handleRemoveFromToDo(item: PrepItemRich, restore?: boolean)` in `src/app/prep/page.tsx` — Task 7 adds its offline branch.

**Context:** `usePrepToast` is currently message-only. `canPlan` already exists in `src/app/prep/page.tsx` (LEAD+, writable RC, not read-only) and is the gate — a STAFF session never sees the `×`. Omitting `onRemove` is what hides the button, so the gate lives in one place.

- [ ] **Step 1: Give the toast an optional action**

Replace the whole of `src/components/prep/PrepToast.tsx`:

```tsx
'use client'
import { useCallback, useRef, useState } from 'react'
import { IcCheck } from './icons'

interface ToastAction { label: string; onClick: () => void }
interface ToastState { msg: string; action?: ToastAction }

// A plain toast reads and vanishes; one carrying an action has to be readable
// AND reachable, so it holds more than twice as long.
const PLAIN_MS = 2600
const ACTION_MS = 6000

export function usePrepToast() {
  const [state, setState] = useState<ToastState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toast = useCallback((m: string, action?: ToastAction) => {
    setState({ msg: m, action })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState(null), action ? ACTION_MS : PLAIN_MS)
  }, [])

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    setState(null)
  }, [])

  const toastNode = (
    <div className={`fixed left-1/2 -translate-x-1/2 z-[120] bottom-6 transition-all duration-200 ${state ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5 pointer-events-none'}`}>
      <div className="bg-ink text-paper text-sm font-medium px-[18px] py-[11px] rounded-[11px] shadow-2xl flex items-center gap-2.5">
        <IcCheck className="text-green w-[15px] h-[15px]" /> {state?.msg}
        {state?.action && (
          <button
            type="button"
            onClick={() => { state.action?.onClick(); dismiss() }}
            className="ml-1.5 pl-3 border-l border-ink-3 text-gold font-semibold cursor-pointer"
          >
            {state.action.label}
          </button>
        )}
      </div>
    </div>
  )

  return { toast, toastNode }
}
```

- [ ] **Step 2: Add the `×` to the desktop ladder row**

In `src/components/prep/runsheet/RunRow.tsx`, add `X` to the `lucide-react` import (it currently imports `Zap`):

```ts
import { Zap, X } from 'lucide-react'
```

Add to the props type, after `onClaim`:

```ts
  /** Take this item straight off the kitchen's list. Omitted (not just
   *  disabled) for anyone who cannot plan — that is what hides the button. */
  onRemove?: (item: PrepItemRich) => void
```

and to the destructured parameter list, after `onClaim,`:

```ts
  onRemove,
```

Then insert this button in the action cluster, immediately **before** the existing Recipe `<button>`:

```tsx
        {onRemove && (
          <button
            onClick={() => onRemove(item)}
            title="Remove from the list"
            aria-label={`Remove ${item.name} from the list`}
            className="w-[34px] h-[34px] rounded-[9px] bg-paper border border-line-2 grid place-items-center cursor-pointer shrink-0 text-ink-4 hover:text-red hover:border-red"
          >
            <X size={15} />
          </button>
        )}
```

- [ ] **Step 3: Add the `×` to the mobile ladder row**

In `src/components/prep/runsheet/RunRowMobile.tsx`, add `X` to the `lucide-react` import (it currently imports `Zap`):

```ts
import { Zap, X } from 'lucide-react'
```

Add to the props type, after `onStart`:

```ts
  /** Take this item straight off the kitchen's list. Omitted for non-planners. */
  onRemove?: (item: PrepItemRich) => void
```

and to the destructured parameter list, after `onStart,`:

```ts
  onRemove,
```

Then insert immediately **before** the existing Start `<button>`:

```tsx
      {onRemove && (
        <button
          onClick={() => onRemove(item)}
          aria-label={`Remove ${item.name} from the list`}
          className="w-9 h-11 grid place-items-center cursor-pointer shrink-0 text-ink-4 bg-transparent border-none"
        >
          <X size={16} />
        </button>
      )}
```

- [ ] **Step 4: Thread the prop through both run sheets**

In `src/components/prep/runsheet/RunSheet.tsx`, add to the props type after `onClaim`:

```ts
  /** LEAD+ only — omitted for cooks, which is what hides the row's × button. */
  onRemove?: (item: PrepItemRich) => void
```

add `onRemove,` to the destructured parameter list, and extend `rowProps` (around `:167`):

```ts
  const rowProps = { nowMin, cooks, onStart, onOpenRecipe, onClaim, onRemove }
```

In `src/components/prep/runsheet/RunSheetMobile.tsx`, add the same prop to the type and the destructured list, then pass it on the `<RunRowMobile … />` at `:159-168`:

```tsx
          onRemove={onRemove}
```

Note: `NextUpHero` (mobile station mode's hero card) deliberately does **not** get a `×` — it is the "do this next" card, not a list row.

- [ ] **Step 5: Add the handler in the page**

In `src/app/prep/page.tsx`, add this function next to `handleToggleOnList` (after `src/app/prep/page.tsx:792`):

```ts
  // Take one item straight off the kitchen's To Do — no Smart Prep round trip,
  // no inventory write. `restore` is the Undo. The optimistic patch mirrors what
  // the route does: postedAt cleared (that is what todayItems filters on — see
  // `todayItems`) AND isOnList false.
  async function handleRemoveFromToDo(item: PrepItemRich, restore = false) {
    const rcId = item.revenueCenterId ?? activeRcId
    if (!rcId) { setActionError('Select a revenue center (not "All") to change the list.'); return }

    mutationSeq.current++
    const stamp = restore ? new Date().toISOString() : null
    setItems(prev => prev.map(i => (
      i.id === item.id
        ? {
            ...i,
            isOnList: restore,
            todayLog: i.todayLog ? { ...i.todayLog, postedAt: stamp } : i.todayLog,
          }
        : i
    )))

    try {
      const res = await fetch('/api/prep/plan/remove-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revenueCenterId: rcId, prepItemId: item.id, restore }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Could not update the list — try again.')
      if (!restore) {
        toast(`${item.name} removed`, { label: 'Undo', onClick: () => { handleRemoveFromToDo(item, true) } })
      }
      loadPlan()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not update the list — try again.')
      load()
    }
  }
```

- [ ] **Step 6: Wire the handler into both run sheets**

In `src/app/prep/page.tsx`, on the desktop `<RunSheet … />` (around `:1379`) add, after `onClaim={handleClaim}`:

```tsx
              onRemove={canPlan ? (item) => handleRemoveFromToDo(item) : undefined}
```

Add the identical line to the `<RunSheetMobile … />` call (around `:1472`).

`canPlan` is already defined at `src/app/prep/page.tsx:289` — passing `undefined` for anyone else is what hides the button.

- [ ] **Step 7: Type-check**

Run: `npm run build`
Expected: build completes with no errors.

- [ ] **Step 8: Verify in the browser**

On `/prep` → To do as a LEAD+ user:
- Each ladder row shows a `×` alongside the recipe/Start cluster. A Working On row does **not**.
- Clicking `×` removes the row immediately with no modal, and the posted band's item count drops by one.
- The toast offers **Undo**; clicking it puts the row back where it was, and the band's count returns.
- Let a toast expire without clicking, then check Smart Prep — the item is in the suggestions pane, re-addable.
- Confirm no `PrepLog` status changed and no stock moved (the item drawer's movement track shows nothing new).
- Repeat at mobile width.

- [ ] **Step 9: Commit**

```bash
git add src/components/prep/ src/app/prep/page.tsx
git commit -m "feat(prep): instant remove from the To Do list, with Undo

A LEAD+ row gets an x that clears postedAt and isOnList in one call —
no Smart Prep round trip, no inventory write. usePrepToast grows an
optional action button to carry the Undo.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Extend the offline queue library

Pure library work, covered by `npm test`. Write the tests first.

**Files:**
- Create: `src/lib/__tests__/prep-offline.test.ts`
- Modify: `src/lib/prep-offline.ts`

**Interfaces:**
- Consumes: `POST /api/prep/plan/remove-item` from Task 4 (the flush target).
- Produces, all exported from `src/lib/prep-offline.ts`:
  - `interface DraftPatch { requiredQty?: number; note?: string; assignedTo?: string | null; listOrder?: number }`
  - `OfflineMutation['type']` gains `'draft_edit' | 'post' | 'remove_item'`
  - `OfflineMutation` gains `patch?: DraftPatch` and `restore?: boolean`
  - `savePrepCache(items: PrepItemRich[], opts?: { fetchedAt?: number }): void`
  - `savePlanCache(post: PrepPostInfo | null): void`
  - `loadPlanCache(): { post: PrepPostInfo | null; ts: number } | null`
  - `deduplicateQueue(queue: OfflineMutation[]): OfflineMutation[]` — **newly exported** so it can be tested directly
  Task 7 and Task 8 consume all of these.

**Context — four behaviours to get right:**

1. **`draft_edit` merges, it does not replace.** The existing rule (last mutation per item per type wins) would drop a qty edit when a note edit follows it. Merge the `patch` objects field-by-field in enqueue order instead.
2. **Merging is bounded by `post` boundaries.** Edits made *before* a post belong to that post; edits made *after* it are unposted changes. Merging across a post would fold a later edit into an earlier post. Segment the queue on each `post` and merge within a segment.
3. **Relative order is the whole ordering guarantee.** `deduplicateQueue` already preserves the order of survivors, so a `post` enqueued after its edits flushes after them and the server builds from a correct draft. No phase machinery.
4. **Existing bug to fix.** The current `status` flush reads `if (!logId)` — it does **not** check the `_opt_` prefix that `OfflineMutation.logId`'s own doc comment defines as "not yet on server". An `_opt_` id therefore gets `PUT /api/prep/logs/_opt_abc` and 404s. The shared `ensureLogId` helper fixes it for both types.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/prep-offline.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  enqueueMutation, loadQueue, clearQueue, deduplicateQueue, flushQueue,
  savePrepCache, loadPrepCache, savePlanCache, loadPlanCache,
  type OfflineMutation,
} from '../prep-offline'
import type { PrepItemRich, PrepPostInfo } from '@/components/prep/types'

// Minimal localStorage stand-in — the suite runs in node, not jsdom.
function installLocalStorage() {
  const store = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } as Storage
}

/** Capture the request bodies flushQueue sends, in order. */
function mockFetch(logId = 'srv-log-1') {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = []
  const fn = vi.fn(async (url: string, init: { method: string; body: string }) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ id: logId }) } as unknown as Response
  })
  ;(globalThis as unknown as { fetch: typeof fn }).fetch = fn
  return calls
}

/** A draft_edit entry as the page would enqueue it. */
function draftEdit(itemId: string, patch: Record<string, unknown>, logId: string | null = 'log-1') {
  return { type: 'draft_edit' as const, itemId, logId, revenueCenterId: 'rc-1', patch }
}

describe('prep offline queue — draft_edit merging', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('merges patches for one item field-by-field instead of keeping only the last', () => {
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }))
    enqueueMutation(draftEdit('item-1', { note: 'double batch' }))

    const out = deduplicateQueue(loadQueue())

    expect(out).toHaveLength(1)
    expect(out[0].patch).toEqual({ requiredQty: 4, note: 'double batch' })
  })

  it('lets a later edit of the same field win', () => {
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }))
    enqueueMutation(draftEdit('item-1', { requiredQty: 6 }))

    const out = deduplicateQueue(loadQueue())

    expect(out).toHaveLength(1)
    expect(out[0].patch).toEqual({ requiredQty: 6 })
  })

  it('keeps different items separate', () => {
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }))
    enqueueMutation(draftEdit('item-2', { requiredQty: 9 }))

    const out = deduplicateQueue(loadQueue())

    expect(out.map(m => m.itemId)).toEqual(['item-1', 'item-2'])
  })

  it('does not merge across a post — edits after a post stay after it', () => {
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }))
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })
    enqueueMutation(draftEdit('item-1', { requiredQty: 9 }))

    const out = deduplicateQueue(loadQueue())

    expect(out.map(m => m.type)).toEqual(['draft_edit', 'post', 'draft_edit'])
    expect(out[0].patch).toEqual({ requiredQty: 4 })
    expect(out[2].patch).toEqual({ requiredQty: 9 })
  })

  it('orders a merged edit before the post that follows it', () => {
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }))
    enqueueMutation(draftEdit('item-1', { note: 'sub the herbs' }))
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })

    const out = deduplicateQueue(loadQueue())

    expect(out.map(m => m.type)).toEqual(['draft_edit', 'post'])
  })
})

describe('prep offline queue — post and remove_item', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('keeps only the last post per revenue center', () => {
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-2' })

    const out = deduplicateQueue(loadQueue())

    expect(out).toHaveLength(2)
    expect(out.map(m => m.revenueCenterId)).toEqual(['rc-1', 'rc-2'])
  })

  it('keeps only the last remove_item per item, so remove-then-undo cancels out', () => {
    enqueueMutation({ type: 'remove_item', itemId: 'item-1', revenueCenterId: 'rc-1' })
    enqueueMutation({ type: 'remove_item', itemId: 'item-1', revenueCenterId: 'rc-1', restore: true })

    const out = deduplicateQueue(loadQueue())

    expect(out).toHaveLength(1)
    expect(out[0].restore).toBe(true)
  })

  it('flushes a remove_item to the remove-item route', async () => {
    const calls = mockFetch()
    enqueueMutation({ type: 'remove_item', itemId: 'item-1', revenueCenterId: 'rc-1' })

    await flushQueue()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/prep/plan/remove-item')
    expect(calls[0].body).toEqual({ revenueCenterId: 'rc-1', prepItemId: 'item-1', restore: false })
  })

  it('flushes a post to the plan post route', async () => {
    const calls = mockFetch()
    enqueueMutation({ type: 'post', itemId: '', revenueCenterId: 'rc-1' })

    await flushQueue()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/prep/plan/post')
    expect(calls[0].body).toEqual({ revenueCenterId: 'rc-1' })
  })
})

describe('prep offline queue — log resolution', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('PUTs a draft_edit straight to a real log id', async () => {
    const calls = mockFetch()
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }, 'log-real'))

    await flushQueue()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/prep/logs/log-real')
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].body).toEqual({ requiredQty: 4 })
  })

  it('creates the log first when there is no id, carrying the patch in the POST', async () => {
    const calls = mockFetch('srv-99')
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }, null))

    await flushQueue()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/prep/logs')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toEqual({ prepItemId: 'item-1', revenueCenterId: 'rc-1', requiredQty: 4 })
  })

  it('treats an _opt_ id as "not on the server yet" rather than PUTting to it', async () => {
    const calls = mockFetch('srv-99')
    enqueueMutation(draftEdit('item-1', { requiredQty: 4 }, '_opt_item-1'))

    await flushQueue()

    expect(calls.map(c => c.url)).not.toContain('/api/prep/logs/_opt_item-1')
    expect(calls[0].url).toBe('/api/prep/logs')
  })

  it('does the same for a status mutation carrying an _opt_ id', async () => {
    const calls = mockFetch('srv-99')
    enqueueMutation({ type: 'status', itemId: 'item-1', logId: '_opt_item-1', status: 'DONE', actualQty: 3, revenueCenterId: 'rc-1' })

    await flushQueue()

    expect(calls[0].url).toBe('/api/prep/logs')
    expect(calls[1].url).toBe('/api/prep/logs/srv-99')
    expect(calls[1].body).toEqual({ status: 'DONE', actualPrepQty: 3 })
  })
})

describe('prep offline queue — existing types still dedupe', () => {
  beforeEach(() => { installLocalStorage(); clearQueue() })

  it('keeps the last isOnList toggle, status and priority per item', () => {
    enqueueMutation({ type: 'isOnList_toggle', itemId: 'a', isOnList: true })
    enqueueMutation({ type: 'isOnList_toggle', itemId: 'a', isOnList: false })
    enqueueMutation({ type: 'priority', itemId: 'a', priority: 'PASS' })
    enqueueMutation({ type: 'priority', itemId: 'a', priority: 'MID' })

    const out = deduplicateQueue(loadQueue())

    expect(out).toHaveLength(2)
    expect(out.find(m => m.type === 'isOnList_toggle')?.isOnList).toBe(false)
    expect(out.find(m => m.type === 'priority')?.priority).toBe('MID')
  })
})

describe('prep caches', () => {
  beforeEach(() => { installLocalStorage() })

  const item = { id: 'i1', name: 'Aioli' } as unknown as PrepItemRich

  it('stamps a fetch time when one is given', () => {
    savePrepCache([item], { fetchedAt: 1_000 })
    expect(loadPrepCache()?.ts).toBe(1_000)
  })

  it('preserves the existing fetch time on an optimistic re-save', () => {
    savePrepCache([item], { fetchedAt: 1_000 })
    savePrepCache([item, { id: 'i2', name: 'Salsa' } as unknown as PrepItemRich])

    const cached = loadPrepCache()
    expect(cached?.ts).toBe(1_000)
    expect(cached?.items).toHaveLength(2)
  })

  it('round-trips the plan post header', () => {
    const post = { id: 'p1', postedAt: '2026-09-02T10:00:00.000Z', postedByName: 'Chef', itemCount: 3, activeMinutes: 90, dirty: false } as PrepPostInfo
    savePlanCache(post)
    expect(loadPlanCache()?.post).toEqual(post)
  })

  it('round-trips a null post', () => {
    savePlanCache(null)
    expect(loadPlanCache()?.post).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- prep-offline`
Expected: FAIL. The import line alone should error — `deduplicateQueue`, `savePlanCache` and `loadPlanCache` are not exported yet.

- [ ] **Step 3: Extend the types and the caches**

In `src/lib/prep-offline.ts`, replace the header (imports through the `loadPrepCache` function) with:

```ts
import type { PrepItemRich, PrepPostInfo } from '@/components/prep/types'

const CACHE_KEY = 'prep_items_v1'
const QUEUE_KEY = 'prep_queue_v1'
const PLAN_KEY  = 'prep_plan_v1'

// ── Types ──────────────────────────────────────────────────────────────────────

/** The planner draft fields a chef can edit on a PrepLog. */
export interface DraftPatch {
  requiredQty?: number
  note?:        string
  assignedTo?:  string | null
  listOrder?:   number
}

export interface OfflineMutation {
  id:         string
  ts:         number
  type:       'isOnList_toggle' | 'status' | 'priority' | 'draft_edit' | 'post' | 'remove_item'
  /** '' for `post`, which is RC-scoped rather than item-scoped. */
  itemId:     string
  isOnList?:  boolean         // for isOnList_toggle
  logId?:     string | null   // null or '_opt_<itemId>' = not yet on server
  status?:    string
  actualQty?: number
  priority?:  string
  revenueCenterId?: string | null   // active RC captured at enqueue time
  patch?:     DraftPatch      // for draft_edit
  restore?:   boolean         // for remove_item — true puts the item back
}

// ── Cache ──────────────────────────────────────────────────────────────────────

/**
 * Persist the item list.
 *
 * `ts` is the last time this data came from the SERVER, not the last time it was
 * written. Optimistic re-saves (which happen on every draft edit, so the chef's
 * work survives a reload in a dead zone) omit `fetchedAt` and inherit the stored
 * ts — otherwise "data from 40m ago" would reset to "just now" every keystroke
 * and the age stamp would lie.
 */
export function savePrepCache(items: PrepItemRich[], opts?: { fetchedAt?: number }): void {
  try {
    const ts = opts?.fetchedAt ?? loadPrepCache()?.ts ?? Date.now()
    localStorage.setItem(CACHE_KEY, JSON.stringify({ items, ts }))
  } catch { /* quota exceeded or private browsing */ }
}

export function loadPrepCache(): { items: PrepItemRich[]; ts: number } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed?.items)) return null
    return parsed as { items: PrepItemRich[]; ts: number }
  } catch { return null }
}

/** The posted-list header, so PostedBand and the dirty pill render offline. */
export function savePlanCache(post: PrepPostInfo | null): void {
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify({ post, ts: Date.now() }))
  } catch { /* graceful degradation */ }
}

export function loadPlanCache(): { post: PrepPostInfo | null; ts: number } | null {
  try {
    const raw = localStorage.getItem(PLAN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!('post' in parsed)) return null
    return parsed as { post: PrepPostInfo | null; ts: number }
  } catch { return null }
}
```

Leave `enqueueMutation`, `loadQueue` and `clearQueue` exactly as they are.

- [ ] **Step 4: Replace the dedup function**

Replace the whole `// ── Deduplication ──` section of `src/lib/prep-offline.ts` (the comment block and `deduplicateQueue`) with:

```ts
// ── Deduplication ──────────────────────────────────────────────────────────────
//
// Three rules, one pass, order preserved:
//
//  · isOnList_toggle / status / priority — keep the LAST per item. The final
//    value is the only one that matters.
//  · post — keep the LAST per revenue center.
//  · draft_edit — MERGE per item, field by field, in enqueue order. Keeping only
//    the last mutation would drop a qty edit as soon as a note edit followed it.
//  · remove_item — keep the LAST per item, so a remove immediately undone
//    collapses to the undo.
//
// draft_edit merging is bounded by `post` boundaries: an edit made before a post
// belongs to that post, an edit made after it is an unposted change. Merging
// across a post would fold a later edit into an earlier post.
//
// Preserving the relative order of survivors is the entire ordering guarantee the
// flush needs — a post enqueued after its edits flushes after them, so the server
// builds the post from a draft that is already correct.

export function deduplicateQueue(queue: OfflineMutation[]): OfflineMutation[] {
  // Which post-delimited segment each mutation sits in.
  let segment = 0
  const segmentOf = new Map<OfflineMutation, number>()
  for (const m of queue) {
    segmentOf.set(m, segment)
    if (m.type === 'post') segment++
  }

  const keyOf = (m: OfflineMutation): string =>
    m.type === 'post' ? `post|${m.revenueCenterId ?? ''}`
    : m.type === 'draft_edit' ? `draft_edit|${segmentOf.get(m)}|${m.itemId}`
    : `${m.type}|${m.itemId}`

  // First pass — the survivor for each key, and (for draft_edit) the merged patch.
  const winner = new Map<string, OfflineMutation>()
  const merged = new Map<string, DraftPatch>()
  const anchor = new Map<string, OfflineMutation>()
  for (const m of queue) {
    const k = keyOf(m)
    if (m.type === 'draft_edit') {
      // The merged entry takes the position of the segment's FIRST edit for this
      // item, so it lands before any post that follows it.
      if (!anchor.has(k)) anchor.set(k, m)
      merged.set(k, { ...(merged.get(k) ?? {}), ...(m.patch ?? {}) })
    }
    winner.set(k, m)
  }

  // Second pass — emit each key once, in the order its representative appears.
  const emitted = new Set<string>()
  const result: OfflineMutation[] = []
  for (const m of queue) {
    const k = keyOf(m)
    if (emitted.has(k)) continue
    if (m.type === 'draft_edit') {
      if (anchor.get(k) !== m) continue
      const last = winner.get(k) as OfflineMutation
      emitted.add(k)
      // Fields from the LAST edit (freshest logId / RC), patch from the merge.
      result.push({ ...last, id: m.id, ts: m.ts, patch: merged.get(k) })
      continue
    }
    if (winner.get(k) !== m) continue
    emitted.add(k)
    result.push(m)
  }

  return result
}
```

- [ ] **Step 5: Replace the flush**

Replace the whole `// ── Flush ──` section of `src/lib/prep-offline.ts` with:

```ts
// ── Flush ──────────────────────────────────────────────────────────────────────

/**
 * Resolve the server-side PrepLog id for a mutation, creating the log when the
 * client only ever had an optimistic one.
 *
 * The `_opt_` check matters: `logId` is documented as "null or '_opt_<itemId>' =
 * not yet on server", but an `_opt_` id used to fall through to
 * `PUT /api/prep/logs/_opt_abc`, which 404s and silently loses the mutation.
 *
 * `POST /api/prep/logs` is an upsert on (prepItem, day) and takes the draft
 * fields directly, so a create can carry the patch in the same request —
 * `applied` says whether it did, so the caller can skip the follow-up PUT.
 */
async function ensureLogId(
  m: OfflineMutation,
  extra: Record<string, unknown> = {},
): Promise<{ id: string | null; applied: boolean }> {
  if (m.logId && !m.logId.startsWith('_opt_')) return { id: m.logId, applied: false }
  const res = await fetch('/api/prep/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prepItemId: m.itemId, revenueCenterId: m.revenueCenterId ?? null, ...extra }),
  })
  if (!res.ok) return { id: null, applied: false }   // e.g. RC-less Shared item
  const log = await res.json()
  return { id: log.id as string, applied: Object.keys(extra).length > 0 }
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export async function flushQueue(): Promise<{ synced: number; failed: number }> {
  const queue = loadQueue()
  if (queue.length === 0) return { synced: 0, failed: 0 }

  const deduped = deduplicateQueue(queue)
  let synced = 0
  let failed = 0

  for (const m of deduped) {
    try {
      if (m.type === 'isOnList_toggle') {
        await fetch(`/api/prep/items/${m.itemId}`, json('PUT', { isOnList: m.isOnList }))
        synced++

      } else if (m.type === 'priority') {
        await fetch(`/api/prep/items/${m.itemId}`, json('PUT', { manualPriorityOverride: m.priority }))
        synced++

      } else if (m.type === 'status') {
        const { id: logId } = await ensureLogId(m)
        if (!logId) { failed++; continue }
        // PUT triggers the inventory transaction for DONE/PARTIAL.
        await fetch(`/api/prep/logs/${logId}`, json('PUT', {
          status: m.status,
          ...(m.actualQty !== undefined ? { actualPrepQty: m.actualQty } : {}),
        }))
        synced++

      } else if (m.type === 'draft_edit') {
        const patch = m.patch ?? {}
        const { id: logId, applied } = await ensureLogId(m, patch)
        if (!logId) { failed++; continue }
        if (!applied) await fetch(`/api/prep/logs/${logId}`, json('PUT', patch))
        synced++

      } else if (m.type === 'remove_item') {
        await fetch('/api/prep/plan/remove-item', json('POST', {
          revenueCenterId: m.revenueCenterId ?? null,
          prepItemId: m.itemId,
          restore: m.restore === true,
        }))
        synced++

      } else if (m.type === 'post') {
        await fetch('/api/prep/plan/post', json('POST', { revenueCenterId: m.revenueCenterId ?? null }))
        synced++
      }
    } catch {
      failed++
    }
  }

  clearQueue()
  return { synced, failed }
}
```

- [ ] **Step 6: Run the tests**

Run: `npm test -- prep-offline`
Expected: PASS, all cases green.

- [ ] **Step 7: Run the whole suite and type-check**

Run: `npm test`
Expected: PASS — in particular the existing `count-offline` tests are untouched.

Run: `npm run build`
Expected: build completes.

- [ ] **Step 8: Commit**

```bash
git add src/lib/prep-offline.ts src/lib/__tests__/prep-offline.test.ts
git commit -m "feat(prep): offline queue handles draft edits, posts and removals

draft_edit merges field-by-field within post-delimited segments rather
than last-write-wins, so a qty edit survives a following note edit.
Adds post and remove_item. Shared ensureLogId fixes an existing bug
where an _opt_ log id was PUT to a URL that 404s.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Wire the page's offline enqueues

**Files:**
- Modify: `src/app/prep/page.tsx` — `handleDraftEdit` (`:824-869`), `handlePost` (`:940-962`), `handleRemoveFromToDo` (added in Task 5)

**Interfaces:**
- Consumes: `enqueueMutation`, `savePlanCache` from Task 6; `handleRemoveFromToDo` from Task 5.
- Produces: nothing further tasks depend on.

**Context:** `handleDraftEdit` currently bails on line 840 with
`if (!navigator.onLine) { markSaving(item.id, false); return } // planner edits are online-only`
— the optimistic update paints and then dies on reload. `handlePost` isn't queued at all and depends on `data.post.postedAt` from the response, which offline has to be synthesised.

- [ ] **Step 1: Extend the offline import**

In `src/app/prep/page.tsx:12`, replace:

```ts
import { savePrepCache, loadPrepCache, loadQueue, enqueueMutation, flushQueue } from '@/lib/prep-offline'
```

with:

```ts
import { savePrepCache, loadPrepCache, savePlanCache, loadPlanCache, loadQueue, enqueueMutation, flushQueue } from '@/lib/prep-offline'
```

- [ ] **Step 2: Queue draft edits instead of dropping them**

In `handleDraftEdit`, replace line `src/app/prep/page.tsx:840`:

```ts
    if (!navigator.onLine) { markSaving(item.id, false); return } // planner edits are online-only
```

with:

```ts
    // Offline, the edit queues and replays on reconnect. The optimistic patch
    // above is already in `items`, and the items-cache effect persists it, so it
    // also survives a reload in a dead zone.
    if (!navigator.onLine) {
      enqueueMutation({
        type: 'draft_edit',
        itemId: item.id,
        logId: item.todayLog?.id ?? null,
        revenueCenterId: item.revenueCenterId ?? activeRcId,
        patch,
      })
      setPendingCount(n => n + 1)
      markSaving(item.id, false)
      return
    }
```

- [ ] **Step 3: Put `user` in scope**

`src/app/prep/page.tsx:49` currently destructures only the role:

```ts
  const { role } = useUser()
```

The offline post needs the poster's name for its local header. Change it to:

```ts
  const { role, user } = useUser()
```

`user` is `{ email: string; name: string | null; role: UserRole } | null` — see `src/contexts/UserContext.tsx`.

- [ ] **Step 4: Queue the post**

In `handlePost`, insert this block immediately after the `if (!activeRcId) { … return }` guard (`src/app/prep/page.tsx:941`):

```ts
    // Offline: stamp the post locally and queue it. The queued draft edits that
    // preceded this flush FIRST (deduplicateQueue preserves order), so the
    // server builds the post from the chef's own numbers.
    //
    // Known and accepted: a post queued at 06:00 and replayed at 14:00 posts a
    // list whose quantities are the chef's, but whose stock evidence is as old
    // as the queue.
    if (!navigator.onLine) {
      const stamp = new Date().toISOString()
      const drafted = items.filter(i => i.isOnList)
      mutationSeq.current++
      setItems(prev => prev.map(i => {
        if (i.isOnList) return { ...i, todayLog: i.todayLog ? { ...i.todayLog, postedAt: stamp } : seedLog(i, { postedAt: stamp }) }
        if (i.todayLog?.postedAt) return { ...i, todayLog: { ...i.todayLog, postedAt: null } }
        return i
      }))
      const localPost: PrepPostInfo = {
        id: `_opt_post_${activeRcId}`,
        postedAt: stamp,
        postedByName: user?.name ?? user?.email ?? 'Chef',
        itemCount: drafted.length,
        // Same sum RunSheet's `handsOn` shows. Deliberately NOT
        // computeWorkloadMinutes — that sums estimatedPrepTime, while the post
        // route sums `resolveActive(d) ?? d.estimatedPrepTime ?? 0`. This header
        // is a local stand-in either way: the server's real one replaces it on
        // the next loadPlan after the queue flushes.
        activeMinutes: drafted.reduce((a, i) => a + (i.activeMinutes ?? 0), 0),
        dirty: false,
        listDate: `${prepDayKey()}T00:00:00.000Z`,
      }
      setPlan({ post: localPost })
      savePlanCache(localPost)
      enqueueMutation({ type: 'post', itemId: '', revenueCenterId: activeRcId })
      setPendingCount(n => n + 1)
      toast('Posted — will sync when back online')
      return
    }
```

`prepDayKey` is already imported at `src/app/prep/page.tsx:32` and `PrepPostInfo` at `:39`. `user` comes from Step 3.

- [ ] **Step 5: Cache the plan header on every successful load and post**

In `loadPlan` (`src/app/prep/page.tsx:281-287`), replace:

```ts
      if (res.ok) setPlan(await res.json())
```

with:

```ts
      if (res.ok) {
        const data = await res.json()
        setPlan(data)
        savePlanCache(data.post ?? null)
      }
```

In the online branch of `handlePost`, immediately after `setPlan({ post: data.post })`, add:

```ts
      savePlanCache(data.post)
```

In `handleRecall`, immediately after `setPlan({ post: null })`, add:

```ts
      savePlanCache(null)
```

- [ ] **Step 6: Queue the removal**

In `handleRemoveFromToDo` (added in Task 5), insert immediately after the optimistic `setItems(...)` call and before the `try {`:

```ts
    if (!navigator.onLine) {
      enqueueMutation({ type: 'remove_item', itemId: item.id, revenueCenterId: rcId, restore })
      setPendingCount(n => n + 1)
      if (!restore) {
        toast(`${item.name} removed`, { label: 'Undo', onClick: () => { handleRemoveFromToDo(item, true) } })
      }
      return
    }
```

- [ ] **Step 7: Type-check**

Run: `npm run build`
Expected: build completes with no errors.

- [ ] **Step 8: Commit**

```bash
git add src/app/prep/page.tsx
git commit -m "feat(prep): queue draft edits, posts and removals when offline

Replaces handleDraftEdit's online-only bail. An offline post stamps
postedAt locally and caches a synthetic header so the To Do fills.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Cache-first paint and unconditional fallback

**Files:**
- Modify: `src/app/prep/page.tsx` — `load` (`:218-254`), a new mount effect, a new items-cache effect, the offline banner (`:1300-1322`)

**Interfaces:**
- Consumes: `savePrepCache(items, opts?)`, `loadPrepCache`, `loadPlanCache` from Task 6.
- Produces: nothing further tasks depend on.

**Context — three problems in `load()`:**

1. `if (!navigator.onLine) throw new Error('offline')` then a catch that only consults the cache when `!navigator.onLine`. A flaky-signal fetch failure while the browser still reports itself online falls through to `setItems([])` — a blank list.
2. A cold load spins even when a good cache exists.
3. `savePrepCache` runs only on a successful fetch, so an optimistic draft edit never reaches the cache and dies on reload.

- [ ] **Step 1: Add the hydration ref**

In `src/app/prep/page.tsx`, next to the existing `mutationSeq` ref declaration, add:

```ts
  // Set once the cache has painted, so `load` does not slam the full-screen
  // spinner over a list the cook is already reading.
  const hydratedFromCache = useRef(false)
```

- [ ] **Step 2: Paint from cache on mount**

Add this effect immediately **before** the existing `useEffect(() => { load() }, [load])` (around `src/app/prep/page.tsx:308`), so it runs first:

```ts
  // Cache-first paint: the list a cook had a moment ago beats a spinner. The
  // fetch below replaces it as soon as it lands.
  useEffect(() => {
    const cached = loadPrepCache()
    if (cached && cached.items.length > 0) {
      hydratedFromCache.current = true
      setItems(cached.items)
      setCacheAge(Math.round((Date.now() - cached.ts) / 60000))
      setLoading(false)
    }
    const cachedPlan = loadPlanCache()
    if (cachedPlan) setPlan({ post: cachedPlan.post })
  }, [])
```

- [ ] **Step 3: Rewrite `load`**

Replace the body of `load` (`src/app/prep/page.tsx:218-254`) with:

```ts
  const load = useCallback(async (silent = false) => {
    if (!silent && !hydratedFromCache.current) setLoading(true)
    const seqAtStart = mutationSeq.current
    try {
      const res  = await fetch(`/api/prep/items?active=${activeOnly}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const fetched = Array.isArray(data) ? data : []
      // Discard a stale snapshot: if the user mutated an item while this slow fetch
      // was in flight (poll, mount load, or manual refresh), its data predates that
      // change and applying it would revert the optimistic update — e.g. a
      // just-completed item snapping back to "in progress". The mutation's own write
      // already made the server authoritative; the next quiet load will reconcile.
      if (mutationSeq.current !== seqAtStart) return
      setItems(fetched)
      savePrepCache(fetched, { fetchedAt: Date.now() })
      hydratedFromCache.current = true
      setIsOffline(false)
      setCacheAge(null)
    } catch (e) {
      // ANY failure falls back to the cache — not just navigator.onLine === false.
      // A flaky signal fails the fetch while the browser still calls itself online,
      // and blanking the list mid-shift is the worst possible answer. The list is
      // never empty because of the network.
      const cached = loadPrepCache()
      if (cached && cached.items.length > 0) {
        // Only fills an empty list — never clobbers what is already on screen
        // (including an optimistic edit made while this fetch was in flight).
        // The check lives in the updater, but nothing is ASSIGNED inside it:
        // a state updater must stay pure or StrictMode's double-invoke makes it lie.
        setItems(prev => (prev.length === 0 ? cached.items : prev))
        hydratedFromCache.current = true
        setCacheAge(Math.round((Date.now() - cached.ts) / 60000))
      } else if (!silent) {
        setItems([])
      }
      setIsOffline(!navigator.onLine)
      console.error('Failed to load prep items', e)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [activeOnly])
```

Note the removed `if (!navigator.onLine) throw new Error('offline')` short-circuit. A queued fetch that fails instantly while offline lands in the same catch, so the behaviour is unchanged for a truly-offline device and now also correct for a flaky one.

- [ ] **Step 4: Persist every optimistic change**

Add this effect just after the mount effect from Step 2:

```ts
  // Every optimistic mutation reaches the cache, so a reload in a dead zone
  // still shows the chef's draft. `savePrepCache` without `fetchedAt` preserves
  // the last SERVER fetch time, so the age stamp keeps telling the truth.
  useEffect(() => {
    if (items.length === 0) return
    savePrepCache(items)
  }, [items])
```

- [ ] **Step 5: Say when the list is stale**

Serving cache while nominally online has to be visible or it is a silent lie. Replace the banner condition at `src/app/prep/page.tsx:1300`:

```tsx
      {(isOffline || pendingCount > 0) && (
```

with:

```tsx
      {(isOffline || pendingCount > 0 || cacheAge !== null) && (
```

and replace the status line inside it:

```tsx
              {offlineSyncing ? 'Syncing changes…' : isOffline ? `Offline${cacheAge !== null ? ` — data from ${cacheAge < 1 ? 'just now' : `${cacheAge}m ago`}` : ''}` : 'Back online'}
```

with:

```tsx
              {offlineSyncing
                ? 'Syncing changes…'
                : isOffline
                  ? `Offline${cacheAge !== null ? ` — data from ${cacheAge < 1 ? 'just now' : `${cacheAge}m ago`}` : ''}`
                  : cacheAge !== null
                    // Online by the browser's reckoning, but the fetch did not land.
                    ? `Showing the saved list — data from ${cacheAge < 1 ? 'just now' : `${cacheAge}m ago`}`
                    : 'Back online'}
```

- [ ] **Step 6: Type-check**

Run: `npm run build`
Expected: build completes with no errors.

- [ ] **Step 7: Full offline verification in the browser**

This is the acceptance run for Tasks 6–8. On `/prep` as a LEAD+ user with a revenue center selected (not "All"):

1. Load the page online so the cache warms. Note the posted band's item count.
2. DevTools → Network → **Offline**.
3. Smart prep tab: add an item to the draft, change its qty, add a note, assign a cook. Each shows the pending count rising in the banner.
4. **Reload the page.** Expected: items paint immediately with no spinner, the banner reads `Offline — data from Nm ago`, and every edit from step 3 is still there.
5. Press **Post**. Expected: a toast says it will sync, the To Do tab fills, and `PostedBand` renders with the local header.
6. Go to To do, remove a row with `×`, then Undo it.
7. DevTools → Network → **Online**. Expected: the banner switches to syncing, then clears.
8. Hard-reload. Expected: the server's state matches — the draft carries the edited qty and note, the assignee stuck, the list is posted, and the removed-then-undone row is present exactly once.
9. Now test the flaky path: set Network throttling to **Offline** *without* letting the browser fire an `offline` event (or block `/api/prep/items` via a request-blocking rule), then hit Refresh in the page header. Expected: the list stays on screen and the banner reads `Showing the saved list — data from Nm ago`. It must never go blank.

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/app/prep/page.tsx
git commit -m "feat(prep): cache-first paint, and never blank the list on a failed fetch

The cache was only consulted when navigator.onLine was false, so a
flaky-signal failure emptied the list mid-shift. Any failure now falls
back to it, a cold load paints from it instead of spinning, and every
optimistic change is persisted so a dead-zone reload keeps the draft.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `npm test` — full suite passes.
- [ ] `npm run build` — clean, and `/api/prep/plan/remove-item` shows `ƒ (Dynamic)`.
- [ ] `npm run lint` — clean. If lint reports a mass of unrelated errors, the `.bin` shims are stale: `rm -rf node_modules/.bin && npm rebuild` (a plain `npm install` does not fix it).
- [ ] `grep -rn "InProgressRail" src/` — no output.
- [ ] Desktop and mobile walkthrough of the four changes together on one page load.
