# Log Yield Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One on-brand "Log yield" sheet, opened from every place a cook marks prep done, that takes the amount made either as a unit quantity or as batches (0–10 in 0.25 steps) and previews whether Done or Partial will be recorded.

**Architecture:** A pure lib (`src/lib/prep-yield.ts`) owns the numbers — prefill, quarter-grid snapping, the Done/Partial rule, the implausible-batches warning — on top of the planner's existing batch math in `prep-plan.ts`. A single React component (`src/components/prep/LogYieldSheet.tsx`) renders one value two ways (batch slider + stepper, unit field) and never computes anything itself. The prep page opens it from the Working On rows and both item drawers and forwards the result to the existing `handleStatusChange`; the API is untouched.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Tailwind (flat colour tokens: `bg-gold`, `text-ink-3`, never numbered shades), Lucide icons via `@/components/prep/icons`, vitest for the pure lib.

**Spec:** `docs/superpowers/specs/2026-09-13-log-yield-sheet-design.md`

## Global Constraints

- Stored quantity is ALWAYS the unit amount (`actualPrepQty`); batches are display/entry only via `batchYield` / `batchCount` / `batchesToQty` from `src/lib/prep-plan.ts`. No API or schema change.
- Batch slider and stepper: `min 0`, `max 10`, `step 0.25`. The planner's own stepper keeps its 0.5 step — do not touch `QtyStepper`.
- Done/Partial rule: `qty >= planned → 'DONE'`, else `'PARTIAL'`; planned `0` is Done for any positive qty.
- Scrims are a plain dim overlay — **no `backdrop-blur`** anywhere (documented freeze on weaker laptops).
- Tailwind colour classes are the flat tokens from `tailwind.config.ts` (`bg-paper`, `border-line`, `text-ink-3`, `bg-gold`, `bg-green`, `text-red-text`). Numbered shades like `bg-red-600` are broken in this project.
- Helper components live at module scope, never inside a component body.
- Commit after every task with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` as the last line.
- Work on a branch in an isolated worktree with `node_modules` and `.env` symlinked from the main checkout (see `superpowers:using-git-worktrees`); `npm run build` must run there, not in the main checkout while the dev server runs.

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/prep-yield.ts` (new) | Pure yield math: `BATCH_STEP`, `BATCH_MAX`, `fmtBatches`, `clampBatches`, `snapBatches`, `stepBatches`, `plannedQty`, `yieldPrefill`, `yieldStatus`, `yieldWarning`. |
| `src/lib/__tests__/prep-yield.test.ts` (new) | Vitest for the above. |
| `src/components/prep/LogYieldSheet.tsx` (new) | The sheet. Renders only. Exports `LogYieldSheet` (default) and `YieldTarget`. |
| `src/components/prep/PrepDoneSheet.tsx` | **Deleted.** |
| `src/app/prep/page.tsx` | `yieldTarget` state replaces `doneSheetItem`; one `onYieldLogged` handler replaces the quick-sheet confirm and `onDrawerComplete`; drawers get `onLogYield`. |
| `src/components/prep/PrepDrawer.tsx` | Drop the no-recipe "Make" input, `complete`, `doneLabel`, `onComplete`; Done buttons call `onLogYield(item)`. |
| `src/components/prep/board/PrepBoardDrawer.tsx` | Same as above for the desktop drawer. |
| `src/components/prep/runsheet/RunSheetMobile.tsx` | Comment only: the sheet it names is renamed. |

---

### Task 1: Pure yield math (`prep-yield.ts`)

**Files:**
- Create: `src/lib/prep-yield.ts`
- Test: `src/lib/__tests__/prep-yield.test.ts`

**Interfaces:**
- Consumes: `batchYield`, `batchCount`, `batchesToQty`, `suggestedBatches`, `BatchFields` from `src/lib/prep-plan.ts`; `validatePrepQty` from `src/lib/prep-utils.ts`.
- Produces (used by Task 2):
  ```ts
  export const BATCH_STEP = 0.25
  export const BATCH_MAX = 10
  export type YieldStatus = 'DONE' | 'PARTIAL'
  export interface YieldItem extends BatchFields {
    suggestedQty: number
    todayLog?: { status: string; actualPrepQty: number | null } | null
    linkedRecipe?: { baseYieldQty: number; yieldUnit: string } | null
  }
  export function fmtBatches(n: number): string            // '×1', '×1.25', '×1.13', '×12'
  export function clampBatches(n: number): number          // 0..10
  export function snapBatches(n: number): number           // nearest 0.25, clamped
  export function stepBatches(n: number, dir: 1 | -1): number
  export function plannedQty(item: YieldItem): number      // unit amount the plan asked for
  export function yieldPrefill(item: YieldItem, cookAlongQty: number | null | undefined): number
  export function yieldStatus(qty: number, planned: number): YieldStatus
  export function yieldWarning(qty: number, item: YieldItem): string | null
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/prep-yield.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  BATCH_STEP, BATCH_MAX, fmtBatches, clampBatches, snapBatches, stepBatches,
  plannedQty, yieldPrefill, yieldStatus, yieldWarning, type YieldItem,
} from '../prep-yield'
import { defaultDraftQty } from '../prep-plan'
import { validatePrepQty } from '../prep-utils'

// A 6 l recipe counted in litres: one batch = 6 l. Par 7.5 l with nothing on hand → the
// planner suggests 7.5 l (suggestedQty on an API row is always cappedSuggestedQty of the
// same fields — keep the fixture consistent) → planned ×1.5 = 9 l.
const adobo: YieldItem = {
  onHand: 0, parLevel: 7.5, minThreshold: 0, targetToday: null, manualPriorityOverride: null, unit: 'l',
  suggestedQty: 7.5,
  linkedRecipe: { baseYieldQty: 6, yieldUnit: 'l' },
}
// No recipe: batches don't apply.
const plain: YieldItem = {
  onHand: 0, parLevel: 3, minThreshold: 0, targetToday: null, manualPriorityOverride: null, unit: 'kg',
  suggestedQty: 3, linkedRecipe: null,
}

describe('constants', () => {
  it('is a quarter-step 0–10 scale', () => {
    expect(BATCH_STEP).toBe(0.25)
    expect(BATCH_MAX).toBe(10)
  })
})

describe('fmtBatches', () => {
  it('drops trailing zeros and keeps an off-grid count exact', () => {
    expect(fmtBatches(1)).toBe('×1')
    expect(fmtBatches(1.25)).toBe('×1.25')
    expect(fmtBatches(1.5)).toBe('×1.5')
    expect(fmtBatches(1.1333)).toBe('×1.13')
    expect(fmtBatches(12)).toBe('×12')
  })
})

describe('clampBatches / snapBatches', () => {
  it('clamps to the scale', () => {
    expect(clampBatches(-1)).toBe(0)
    expect(clampBatches(12)).toBe(10)
    expect(clampBatches(3.25)).toBe(3.25)
  })
  it('snaps to the nearest quarter', () => {
    expect(snapBatches(1.25)).toBe(1.25)
    expect(snapBatches(1.13)).toBe(1.25)
    expect(snapBatches(1.12)).toBe(1)
    expect(snapBatches(12)).toBe(10)
  })
})

describe('stepBatches', () => {
  it('steps a quarter from an on-grid value and clamps at both ends', () => {
    expect(stepBatches(1.25, 1)).toBe(1.5)
    expect(stepBatches(1.25, -1)).toBe(1)
    expect(stepBatches(10, 1)).toBe(10)
    expect(stepBatches(0, -1)).toBe(0)
  })
  it('snaps an off-grid (typed) value first, then steps', () => {
    expect(stepBatches(1.13, 1)).toBe(1.5)
    expect(stepBatches(1.13, -1)).toBe(1)
  })
  it('a typed overflow above 10 lands on 10 from either button', () => {
    expect(stepBatches(12, -1)).toBe(10)
    expect(stepBatches(12, 1)).toBe(10)
  })
})

describe('plannedQty', () => {
  it('is the half-batch-ceiled suggestion for a batch item — identical to the planner seed', () => {
    expect(plannedQty(adobo)).toBe(9)
    expect(plannedQty(adobo)).toBe(defaultDraftQty(adobo))
  })
  it('is suggestedQty for a non-batch item', () => {
    expect(plannedQty(plain)).toBe(3)
  })
})

describe('yieldPrefill', () => {
  it('the logged amount wins when reopening a done item', () => {
    const done = { ...adobo, todayLog: { status: 'DONE', actualPrepQty: 4 } }
    expect(yieldPrefill(done, 12)).toBe(4)
  })
  it('the cook-along yield beats the plan', () => {
    expect(yieldPrefill(adobo, 12)).toBe(12)
  })
  it('falls back to the plan, then to zero', () => {
    expect(yieldPrefill(adobo, null)).toBe(9)
    expect(yieldPrefill(adobo, 0)).toBe(9)
    expect(yieldPrefill({ ...plain, suggestedQty: 0 }, null)).toBe(0)
  })
  it('ignores an unfinished log', () => {
    const open = { ...adobo, todayLog: { status: 'IN_PROGRESS', actualPrepQty: 4 } }
    expect(yieldPrefill(open, null)).toBe(9)
  })
})

describe('yieldStatus', () => {
  it('at or above plan is Done, a hundredth under is Partial', () => {
    expect(yieldStatus(9, 9)).toBe('DONE')
    expect(yieldStatus(9.5, 9)).toBe('DONE')
    expect(yieldStatus(8.99, 9)).toBe('PARTIAL')
  })
  it('a plan of zero is Done for any positive amount', () => {
    expect(yieldStatus(0.5, 0)).toBe('DONE')
  })
})

describe('yieldWarning', () => {
  it('agrees with the server guard on both sides of the 50-batch line', () => {
    // 49 batches of 6 l = 294 l → fine; 50 batches = 300 l → the unit-mix-up message.
    expect(yieldWarning(294, adobo)).toBeNull()
    expect(yieldWarning(300, adobo)).toBe(validatePrepQty(300, 'l', 'l', 6))
    expect(yieldWarning(300, adobo)).toMatch(/unit mix-up/)
  })
  it('is silent without a recipe or at zero', () => {
    expect(yieldWarning(300000, plain)).toBeNull()
    expect(yieldWarning(0, adobo)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/prep-yield.test.ts`
Expected: FAIL — `Cannot find module '../prep-yield'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/prep-yield.ts`:

```ts
// The numbers behind the Log yield sheet — ONE value (the unit amount that is
// stored as PrepLog.actualPrepQty) shown two ways. Batches are a view on top of
// the planner's batch math (prep-plan.ts: batchYield / batchCount /
// batchesToQty); nothing here is stored in batches.
//
// Design: docs/superpowers/specs/2026-09-13-log-yield-sheet-design.md
import { batchesToQty, suggestedBatches, type BatchFields } from './prep-plan'
import { validatePrepQty } from './prep-utils'

/** The sheet's batch scale: 0 → 10 in quarter steps (the planner's stepper keeps 0.5). */
export const BATCH_STEP = 0.25
export const BATCH_MAX = 10

export type YieldStatus = 'DONE' | 'PARTIAL'

export interface YieldItem extends BatchFields {
  /** The plan's suggestion in the item's unit (the API's `suggestedQty`). */
  suggestedQty: number
  /** The item's live log, when it has one — a completed one prefills its amount. */
  todayLog?: { status: string; actualPrepQty: number | null } | null
  linkedRecipe?: { baseYieldQty: number; yieldUnit: string } | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** "×1", "×1.25", "×1.5" — and an exact "×1.13" for a typed, off-grid amount. */
export function fmtBatches(n: number): string {
  const r = round2(n)
  return `×${Number.isInteger(r) ? r : r}`
}

export function clampBatches(n: number): number {
  return Math.min(BATCH_MAX, Math.max(0, n))
}

/** Nearest quarter, clamped to the scale. */
export function snapBatches(n: number): number {
  return clampBatches(Math.round(n / BATCH_STEP) * BATCH_STEP)
}

/**
 * One press of − / +. An off-grid (typed) value snaps to its nearest quarter
 * first, so the press lands on a neighbouring grid point rather than staying
 * off-grid forever. A typed overflow above the scale is pinned at 10: either
 * button brings the value back onto the scale.
 */
export function stepBatches(n: number, dir: 1 | -1): number {
  if (n > BATCH_MAX) return BATCH_MAX
  return snapBatches(snapBatches(n) + dir * BATCH_STEP)
}

/**
 * What the plan asked for, in the item's unit: the half-batch-ceiled batch
 * suggestion for batch items (identical to the planner's draft seed), else the
 * plain suggestion.
 */
export function plannedQty(item: YieldItem): number {
  const nb = suggestedBatches(item)
  if (nb != null) return nb > 0 ? batchesToQty(item, nb) : 0
  return item.suggestedQty > 0 ? item.suggestedQty : 0
}

const COMPLETE = new Set(['DONE', 'PARTIAL'])

/**
 * The amount the sheet opens with:
 *   1. the amount already logged, when reopening a completed job;
 *   2. the cook-along yield the cook set in the drawer's upscale slider;
 *   3. the plan (see plannedQty);
 *   4. zero — nothing known, the cook types it.
 */
export function yieldPrefill(item: YieldItem, cookAlongQty: number | null | undefined): number {
  const log = item.todayLog
  if (log && COMPLETE.has(log.status) && log.actualPrepQty != null && log.actualPrepQty > 0) {
    return round2(log.actualPrepQty)
  }
  if (cookAlongQty != null && cookAlongQty > 0) return round2(cookAlongQty)
  return plannedQty(item)
}

/** The prep page's rule, in one place: at or above plan is Done, below it Partial. */
export function yieldStatus(qty: number, planned: number): YieldStatus {
  return qty >= planned ? 'DONE' : 'PARTIAL'
}

/**
 * The server's unit-mix-up guard (validatePrepQty: ≥ 50 batches in one entry),
 * run client-side so the sheet stops the request instead of showing a failed one.
 */
export function yieldWarning(qty: number, item: YieldItem): string | null {
  const r = item.linkedRecipe
  if (!r || !(qty > 0)) return null
  return validatePrepQty(qty, item.unit, r.yieldUnit, Number(r.baseYieldQty))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/prep-yield.test.ts`
Expected: PASS, 17 tests.

If `fmtBatches(1.1333)` fails, check `round2` is applied before the integer test; if `plannedQty(adobo)` is not 9, confirm `suggestedBatches` ceils 7.5 / 6 = 1.25 to 1.5.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prep-yield.ts src/lib/__tests__/prep-yield.test.ts
git commit -m "feat(prep): pure yield math for the Log yield sheet — quarter-step batches, prefill, Done/Partial rule

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The sheet component (`LogYieldSheet.tsx`)

**Files:**
- Create: `src/components/prep/LogYieldSheet.tsx`

**Interfaces:**
- Consumes: everything from Task 1; `batchYield`, `batchCount`, `batchesToQty` from `src/lib/prep-plan.ts`; `fmtQty(q: number | string, u: string)` from `src/lib/prep-runsheet.ts`; `IcCheck`, `IcX` from `src/components/prep/icons`; `PrepItemRich` from `src/components/prep/types`.
- Produces (used by Task 3):
  ```ts
  export interface YieldTarget { item: PrepItemRich; cookAlongQty: number | null }
  export default function LogYieldSheet(props: {
    target: YieldTarget | null
    onClose: () => void
    onConfirm: (item: PrepItemRich, qty: number, status: YieldStatus) => void
  }): JSX.Element | null
  ```

- [ ] **Step 1: Write the component**

Create `src/components/prep/LogYieldSheet.tsx`:

```tsx
'use client'
/**
 * LogYieldSheet — the ONE place a cook says how much they made.
 *
 * Opened from a Working On row's Done, the item drawer's Done and the board
 * drawer's Done (the host passes the drawer's cook-along yield when the cook set
 * one). One value, the unit amount that becomes PrepLog.actualPrepQty, shown two
 * ways that stay in sync: a 0–10 quarter-step batch slider with a ± stepper, and
 * the unit field. Typing a unit amount leaves the value exact (the readout says
 * "×1.13") and parks the thumb at the nearest quarter; the next slider or ± touch
 * snaps back onto the grid. The button previews the Done/Partial outcome.
 *
 * Every number comes from src/lib/prep-yield.ts and prep-plan.ts — this file only
 * renders. Design: docs/superpowers/specs/2026-09-13-log-yield-sheet-design.md
 */
import { useEffect, useRef, useState } from 'react'
import { IcCheck, IcX } from '@/components/prep/icons'
import type { PrepItemRich } from '@/components/prep/types'
import { batchYield, batchCount, batchesToQty } from '@/lib/prep-plan'
import { fmtQty } from '@/lib/prep-runsheet'
import {
  BATCH_MAX, BATCH_STEP, fmtBatches, plannedQty, snapBatches, stepBatches,
  yieldPrefill, yieldStatus, yieldWarning, type YieldStatus,
} from '@/lib/prep-yield'

export interface YieldTarget {
  item: PrepItemRich
  /** The drawer's upscale-slider yield when the cook changed it (PrepLog.progress.makeQty); null otherwise. */
  cookAlongQty: number | null
}

interface Props {
  target: YieldTarget | null
  onClose: () => void
  onConfirm: (item: PrepItemRich, qty: number, status: YieldStatus) => void
}

const COMPLETE = new Set(['DONE', 'PARTIAL'])
const near = (a: number, b: number) => Math.abs(a - b) < 0.005
/** Text for the unit field: up to 2 decimals, no trailing zeros, '' for zero. */
const qtyText = (q: number) => (q > 0 ? String(Math.round(q * 100) / 100) : '')

// ── module-scope pieces (never define these inside the component: they would remount) ──

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-8 px-3 rounded-[10px] border font-mono text-[10.5px] font-bold uppercase tracking-[0.04em] whitespace-nowrap ${
        active ? 'bg-ink text-gold border-ink' : 'bg-transparent text-ink-3 border-line'
      }`}
    >
      {label}
    </button>
  )
}

function StepButton({ label, onClick, disabled }: { label: '−' | '+'; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label === '−' ? 'Quarter batch less' : 'Quarter batch more'}
      disabled={disabled}
      onClick={onClick}
      className={`w-10 h-10 rounded-[10px] bg-bg-2 border border-line grid place-items-center text-[18px] font-mono leading-none ${
        disabled ? 'text-ink-4 cursor-not-allowed' : 'text-ink-2'
      }`}
    >
      {label}
    </button>
  )
}

export default function LogYieldSheet({ target, onClose, onConfirm }: Props) {
  const item = target?.item ?? null
  const [qty, setQty] = useState(0)
  const [text, setText] = useState('')
  const unitRef = useRef<HTMLInputElement>(null)
  const sliderRef = useRef<HTMLInputElement>(null)

  // Prefill each time a new target opens the sheet.
  useEffect(() => {
    if (!target) return
    const q = yieldPrefill(target.item, target.cookAlongQty)
    setQty(q)
    setText(qtyText(q))
    // Batch items start on the slider; unit-only items in the field.
    const t = setTimeout(() => (batchYield(target.item) != null ? sliderRef : unitRef).current?.focus(), 0)
    return () => clearTimeout(t)
  }, [target?.item.id, target?.cookAlongQty])

  // Escape closes.
  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [target, onClose])

  if (!item) return null

  const perBatch = batchYield(item)              // unit amount of one batch, null = batches don't apply
  const hasBatch = perBatch != null
  const batches = hasBatch ? (batchCount(item, qty) ?? 0) : 0
  const thumb = hasBatch ? snapBatches(batches) : 0
  const planned = plannedQty(item)
  const status = yieldStatus(qty, planned)
  const warning = yieldWarning(qty, item)
  const reopening = !!item.todayLog && COMPLETE.has(item.todayLog.status)
  const canSubmit = qty > 0 && !warning

  // ONE setter for the batch view: value in batches → unit amount.
  const setBatches = (n: number) => {
    const q = batchesToQty(item, n)
    setQty(q)
    setText(qtyText(q))
  }
  // ONE setter for the unit view: keep the raw text so "4." can be typed.
  const onUnitChange = (raw: string) => {
    setText(raw)
    const v = parseFloat(raw)
    setQty(Number.isFinite(v) && v > 0 ? v : 0)
  }
  const setUnit = (q: number) => { setQty(q); setText(qtyText(q)) }

  const submit = () => { if (canSubmit) onConfirm(item, Math.round(qty * 100) / 100, status) }

  const onSliderKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Shift+arrow = a whole batch; plain arrows, Home and End are native to the range input.
    if (!e.shiftKey) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setBatches(snapBatches(thumb + 1)) }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setBatches(snapBatches(thumb - 1)) }
  }

  const pct = (thumb / BATCH_MAX) * 100
  const plannedLabel = hasBatch && planned > 0
    ? `Planned ${fmtBatches(batchCount(item, planned) ?? 0)} batch · ${fmtQty(planned, item.unit)}`
    : planned > 0 ? `Planned ${fmtQty(planned, item.unit)}` : 'No planned amount'
  const verb = reopening ? 'Update' : 'Log'
  const outcome = qty <= 0
    ? 'Enter how much you made'
    : status === 'DONE' ? 'Records Done · at or above plan' : 'Records Partial · below plan'

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center md:p-6">
      {/* Plain dim scrim — NO backdrop-blur (documented freeze on weaker laptops). */}
      <div onClick={onClose} className="fixed inset-0 z-40 bg-[rgba(9,9,11,0.6)]" aria-hidden="true" />
      <div
        role="dialog"
        aria-label="Log yield"
        className="relative z-50 bg-paper w-full rounded-t-2xl border-t border-line px-[22px] pt-4 shadow-2xl md:w-[440px] md:rounded-2xl md:border md:pb-5"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 18px)' }}
      >
        {/* header */}
        <div className="flex items-start gap-3 mb-4">
          <span className="w-8 h-8 rounded-[9px] bg-green text-white grid place-items-center shrink-0">
            <IcCheck size={16} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-semibold tracking-[-0.02em] leading-tight truncate">{item.name}</div>
            <div className="font-mono text-[11px] text-ink-3 mt-0.5">{plannedLabel}</div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="w-8 h-8 rounded-lg border border-line grid place-items-center text-ink-2 shrink-0"
          >
            <IcX size={15} />
          </button>
        </div>

        {/* batch row — only when one batch means something in this unit */}
        {hasBatch && (
          <div className="mb-4">
            <div className="flex items-center gap-3">
              <StepButton label="−" disabled={thumb <= 0 && batches <= 0} onClick={() => setBatches(stepBatches(batches, -1))} />
              <div className="flex-1 flex items-baseline justify-center gap-1.5">
                <span className="font-mono text-[28px] font-semibold tracking-[-0.02em] text-ink leading-none">{fmtBatches(batches)}</span>
                <span className="font-mono text-[11px] text-ink-3">batch</span>
              </div>
              <StepButton label="+" disabled={batches >= BATCH_MAX} onClick={() => setBatches(stepBatches(batches, 1))} />
            </div>
            <div className="relative mt-2 h-11 flex items-center">
              <input
                ref={sliderRef}
                type="range"
                min={0}
                max={BATCH_MAX}
                step={BATCH_STEP}
                value={thumb}
                aria-label="Batches made"
                aria-valuetext={`${fmtBatches(batches)} batch · ${fmtQty(qty, item.unit)}`}
                onChange={(e) => setBatches(snapBatches(parseFloat(e.target.value)))}
                onKeyDown={onSliderKey}
                style={{ background: `linear-gradient(to right, #d97706 ${pct}%, #f4f4f5 ${pct}%)` }}
                className="w-full h-2 rounded-full appearance-none outline-none cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-ink [&::-webkit-slider-thumb]:border-[3px] [&::-webkit-slider-thumb]:border-paper [&::-webkit-slider-thumb]:shadow-md
                  [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-ink [&::-moz-range-thumb]:border-[3px] [&::-moz-range-thumb]:border-paper
                  focus-visible:ring-2 focus-visible:ring-offset-2"
              />
            </div>
            <div className="flex justify-between font-mono text-[9.5px] text-ink-4 -mt-1 px-0.5">
              <span>0</span><span>5</span><span>10</span>
            </div>
          </div>
        )}

        {/* unit row */}
        <label className="font-mono text-[10px] uppercase tracking-[0.03em] text-ink-3">
          {hasBatch ? `Or in ${item.unit}` : `How much did you make (${item.unit})`}
        </label>
        <div className="relative mt-1.5">
          <input
            ref={unitRef}
            type="number"
            inputMode="decimal"
            min={0}
            value={text}
            onChange={(e) => onUnitChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            placeholder={planned > 0 ? qtyText(planned) : 'e.g. 6.5'}
            className={`w-full border rounded-[10px] pl-3 pr-14 py-3 text-[18px] font-mono outline-none focus:border-ink-3 ${
              warning ? 'border-red' : 'border-line-2'
            }`}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[12px] text-ink-3 border-l border-line pl-3">
            {item.unit}
          </span>
        </div>
        {warning && <div className="font-mono text-[11px] text-red-text mt-1.5 leading-snug">{warning}</div>}

        {/* quick chips */}
        <div className="flex gap-2 mt-3 flex-wrap">
          {planned > 0 && <Chip label="Planned" active={near(qty, planned)} onClick={() => setUnit(planned)} />}
          {hasBatch && <Chip label="×1 batch" active={near(qty, batchesToQty(item, 1))} onClick={() => setBatches(1)} />}
          {hasBatch && <Chip label="½ batch" active={near(qty, batchesToQty(item, 0.5))} onClick={() => setBatches(0.5)} />}
        </div>

        {/* outcome + confirm */}
        <div className="font-mono text-[11px] text-ink-3 mt-4">{outcome}</div>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className={`mt-2 w-full h-12 rounded-[10px] text-[14px] font-semibold inline-flex items-center justify-center gap-2 ${
            canSubmit ? 'bg-green text-white' : 'bg-bg-2 text-ink-4 cursor-not-allowed'
          }`}
        >
          <IcCheck size={16} />
          {qty > 0 ? `${verb} ${fmtQty(qty, item.unit)} · ${status === 'DONE' ? 'Done' : 'Partial'}` : `${verb} yield`}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "^scripts/"`
Expected: no lines (errors under `scripts/` are untracked audit scripts and pre-exist). If `PrepItemRich` is not assignable to `YieldItem`, check that `PrepItemRich.linkedRecipe` carries `baseYieldQty: number` and `yieldUnit: string` (it does — see `src/components/prep/types.ts`) and that `todayLog.actualPrepQty` is typed `number | null`.

- [ ] **Step 3: Commit**

```bash
git add src/components/prep/LogYieldSheet.tsx
git commit -m "feat(prep): the Log yield sheet — one value, entered by batches or by unit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Wire the sheet into the prep page; delete the old quick sheet

**Files:**
- Modify: `src/app/prep/page.tsx` (import at line 23; state at line 102; `onDrawerComplete` at lines 1652–1665; `onLog` wiring at lines 1959 and 2062; error boundary keys at lines 2224–2230; drawer + sheet wiring at lines 2236–2292)
- Delete: `src/components/prep/PrepDoneSheet.tsx`
- Modify: `src/components/prep/runsheet/RunSheetMobile.tsx:15` (comment)

**Interfaces:**
- Consumes: `LogYieldSheet`, `YieldTarget` from Task 2; `YieldStatus` from Task 1.
- Produces (used by Tasks 4 and 5): the page passes `onLogYield={(item) => setYieldTarget({ item, cookAlongQty: drawerProgress?.makeQty ?? null })}` to both drawers, and stops passing `onComplete`.

- [ ] **Step 1: Swap the import**

In `src/app/prep/page.tsx` replace line 23:

```ts
import PrepDoneSheet from '@/components/prep/PrepDoneSheet'
```
with
```ts
import LogYieldSheet, { type YieldTarget } from '@/components/prep/LogYieldSheet'
import type { YieldStatus } from '@/lib/prep-yield'
```

- [ ] **Step 2: Replace the state**

Replace line 102:

```ts
  const [doneSheetItem, setDoneSheetItem] = useState<PrepItemRich | null>(null)
```
with
```ts
  // The item whose yield is being logged (+ the drawer's cook-along yield when it
  // came from a drawer). One sheet serves the rows and both drawers.
  const [yieldTarget, setYieldTarget] = useState<YieldTarget | null>(null)
```

- [ ] **Step 3: Replace `onDrawerComplete` with `onYieldLogged`**

Replace lines 1652–1665 (the comment block and `onDrawerComplete`) with:

```ts
  // The Log yield sheet's confirm — the ONE completion path for rows and both
  // drawers. The sheet already applied the Done/Partial rule (prep-yield.ts);
  // this just records it and closes whatever opened the sheet.
  //
  // NOT memoized — same trap as onRowStatusChange above: it calls handleStatusChange,
  // which reads the current `items`; a useCallback([]) would freeze the first-render
  // closure (items === []) and every completion would silently no-op.
  const onYieldLogged = (item: PrepItemRich, qty: number, status: YieldStatus) => {
    handleStatusChange(item.id, status, qty)
    toast(`${status === 'DONE' ? 'Done' : 'Partial'} · ${qty} ${item.unit} made`)
    setYieldTarget(null)
    if (drawerItem?.id === item.id) closeDrawer()
  }
  // Both drawers' Done buttons land here: the drawer's cook-along yield (the
  // upscale slider, persisted on the live log) is the sheet's prefill.
  const onDrawerLogYield = (item: PrepItemRich) =>
    setYieldTarget({ item, cookAlongQty: drawerProgress?.makeQty ?? null })
```

`closeDrawer` and `drawerItem` are defined earlier in the file (search `const closeDrawer`); if `closeDrawer` is declared after this point, move this block below it.

- [ ] **Step 4: Point the rows at the sheet**

At line 1959 and again at line 2062, replace

```tsx
              onLog={setDoneSheetItem}
```
with
```tsx
              onLog={(item) => setYieldTarget({ item, cookAlongQty: null })}
```
(keep each line's existing indentation).

- [ ] **Step 5: Error boundary keys**

At lines 2224–2230 replace every `doneSheetItem?.id` with `yieldTarget?.item.id` and every `setDoneSheetItem(null)` with `setYieldTarget(null)`. Three occurrences.

- [ ] **Step 6: Rewire the drawers and move the sheet last**

In the `<PrepDrawer …/>` block (starts line 2237) replace

```tsx
          onComplete={onDrawerComplete}
```
with
```tsx
          onLogYield={onDrawerLogYield}
```

Delete the whole quick-sheet block (lines 2266–2275):

```tsx
      {/* Quick yield prompt — shared by the mobile compact row and the desktop board row. */}
      <PrepDoneSheet
        item={doneSheetItem}
        onClose={() => setDoneSheetItem(null)}
        onConfirm={(item, qty) => {
          onRowStatusChange(item, 'DONE', qty)
          toast(`Done · ${qty} ${item.unit} made`)
          setDoneSheetItem(null)
        }}
      />
```

In the `<PrepBoardDrawer …/>` block replace

```tsx
          onComplete={onDrawerComplete}
```
with
```tsx
          onLogYield={onDrawerLogYield}
```

Then, immediately after the closing `</div>` of the `hidden md:block` wrapper that holds `PrepBoardDrawer`, add the sheet so it paints ABOVE both drawers (they are fixed overlays too; later in the DOM wins at equal z-index):

```tsx
      {/* Log yield — the one yield entry for the rows and both drawers. Rendered
          after both drawers so it stacks above them. */}
      <LogYieldSheet
        target={yieldTarget}
        onClose={() => setYieldTarget(null)}
        onConfirm={onYieldLogged}
      />
```

- [ ] **Step 7: Delete the old sheet and fix the stale comment**

```bash
git rm src/components/prep/PrepDoneSheet.tsx
```

In `src/components/prep/runsheet/RunSheetMobile.tsx` line 15 change `PrepDoneSheet (onLog)` to `LogYieldSheet (onLog)`.

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "^scripts/"`
Expected: exactly two errors, both `Property 'onLogYield' does not exist` on `PrepDrawer` / `PrepBoardDrawer` (plus `onComplete` missing). Tasks 4 and 5 clear them. Any other error is a wiring mistake in this task.

- [ ] **Step 9: Commit**

```bash
git add src/app/prep/page.tsx src/components/prep/runsheet/RunSheetMobile.tsx
git commit -m "feat(prep): rows and drawers open the Log yield sheet; the quick done sheet is gone

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Item drawer (`PrepDrawer.tsx`) — Done opens the sheet

**Files:**
- Modify: `src/components/prep/PrepDrawer.tsx` (props lines 28–33; destructure lines 158–162; `complete`/`doneLabel` lines 199–203; no-recipe input lines 416–430; Done buttons at lines 444–448 and 466–470)

**Interfaces:**
- Consumes: `onLogYield: (item: PrepItemRich) => void` from the page (Task 3).
- Keeps: `makeQty` / `onMakeQtyChange` — the cook-along upscale slider inside `PrepRecipeSection` still reads them.

- [ ] **Step 1: Props**

Replace lines 32–33:

```ts
  /** Complete the prep at makeQty (host decides DONE vs PARTIAL by the suggested rule). */
  onComplete: (item: PrepItemRich, qty: number) => void
```
with
```ts
  /** Open the Log yield sheet for this item — the only way a yield is recorded. */
  onLogYield: (item: PrepItemRich) => void
```

In the destructure (line 162) replace `onComplete,` with `onLogYield,`.

- [ ] **Step 2: Remove the local completion**

Delete lines 199–203:

```ts
  const complete = () => {
    if (!item) return
    onComplete(item, makeQty)
    onClose()
  }
  const doneLabel = `Done · add ${fmt(makeQty)} ${item?.unit ?? ''}`
```

- [ ] **Step 3: Remove the no-recipe "Make" input**

Delete lines 416–430 (from the `{/* No-recipe items have no upscale slider …` comment through the closing `)}` of the `{!item.linkedRecipeId && stateKey !== 'done' && stateKey !== 'skipped' && ( … )}` block).

- [ ] **Step 4: Done buttons open the sheet**

In BOTH the `not-started` and the `in-progress` branches, replace

```tsx
                    onClick={complete}
```
with
```tsx
                    onClick={() => onLogYield(item)}
```
and replace

```tsx
                    {doneLabel}
```
with
```tsx
                    Log yield
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "^scripts/"`
Expected: only the `PrepBoardDrawer` errors remain (Task 5). If `fmt` is now reported unused, it is not — the Tiles still use it; if `makeQty` is reported unused, it is not — `PrepRecipeSection` receives it.

- [ ] **Step 6: Commit**

```bash
git add src/components/prep/PrepDrawer.tsx
git commit -m "feat(prep): the item drawer's Done opens the Log yield sheet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Board drawer (`PrepBoardDrawer.tsx`) — Done opens the sheet

**Files:**
- Modify: `src/components/prep/board/PrepBoardDrawer.tsx` (props lines 21–24; signature line 42; `complete` line 67; no-recipe input lines 176–187; Done button line 240)

**Interfaces:**
- Consumes: `onLogYield: (item: PrepItemRich) => void` from the page (Task 3).
- Keeps: `makeQty` / `onMakeQtyChange` for `PrepRecipeSection`.

- [ ] **Step 1: Props and signature**

Replace lines 23–24:

```ts
  /** Complete the prep at makeQty (host decides DONE vs PARTIAL by the suggested rule). */
  onComplete: (item: PrepItemRich, qty: number) => void
```
with
```ts
  /** Open the Log yield sheet for this item — the only way a yield is recorded. */
  onLogYield: (item: PrepItemRich) => void
```

In the function signature (line 42) replace `onComplete,` with `onLogYield,`.

- [ ] **Step 2: Remove the local completion**

Delete line 67:

```ts
  const complete = () => { if (item) { onComplete(item, makeQty); onClose() } }
```

- [ ] **Step 3: Remove the no-recipe "Make" input**

Delete lines 176–187 (the comment `{/* No-recipe items have no upscale slider — a plain qty input keeps the yield editable. */}` and the `{!item.linkedRecipeId && view !== 'smart' && r.status !== 'done' && ( … )}` block).

- [ ] **Step 4: Done button opens the sheet**

Replace line 240:

```tsx
                      ? <button className="btn" style={{ background: 'var(--green)', color: '#fff', borderColor: 'var(--green)' }} title={`Add ${fmtQty(makeQty)} ${r.unit}`} onClick={complete}><span className="ic" style={{ color: '#fff' }}>✓</span> Done · {fmtQty(makeQty)} {r.unit}</button>
```
with
```tsx
                      ? <button className="btn" style={{ background: 'var(--green)', color: '#fff', borderColor: 'var(--green)' }} title="Log how much you made" onClick={() => onLogYield(item)}><span className="ic" style={{ color: '#fff' }}>✓</span> Log yield</button>
```

- [ ] **Step 5: Type-check, lint, tests**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "^scripts/"`
Expected: no output.

Run: `npm run lint`
Expected: no errors (warnings about unused imports mean a `fmtQty` or `makeQty` reference was removed that is still needed elsewhere in the file — restore it).

Run: `npm test`
Expected: all pass except the two pre-existing wall-clock failures in `prep-plan-cadence.test.ts` (`not due yet → untouched`, `planGroups lifts them above the steps…`), which also fail on `main`.

- [ ] **Step 6: Commit**

```bash
git add src/components/prep/board/PrepBoardDrawer.tsx
git commit -m "feat(prep): the board drawer's Done opens the Log yield sheet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Build and browser verification

**Files:** none new.

- [ ] **Step 1: Production build in the worktree**

Run: `npm run build 2>&1 | tail -5`
Expected: `✓ Compiled successfully`. `git diff --stat tsconfig.json` must be empty afterwards (next build sometimes rewrites it; if so, `git checkout tsconfig.json`).

- [ ] **Step 2: Serve the branch**

The Browser pane launches from the MAIN checkout, so add a temporary entry to the main checkout's `.claude/launch.json` pointing at this worktree (replace `<worktree>` with the worktree folder name, e.g. `fergies-os-yield`):

```json
{ "name": "Yield worktree", "runtimeExecutable": "node", "runtimeArgs": ["node_modules/next/dist/bin/next", "dev", "../<worktree>", "-p", "3100"], "port": 3100 }
```

Start it with `preview_start` `{ name: "Yield worktree" }`. Remove the entry when done.

- [ ] **Step 3: Check the three entry points (desktop width)**

1. Open `http://localhost:3100/prep`, To do tab. On a **Working On** row press **Done**. Confirm: sheet opens; for a recipe item the batch readout, ± and slider show; the caption reads `Planned ×N batch · X unit`; the button reads `Log X unit · Done`.
2. Drag the slider to `×0.5`: the unit field shows half a batch and the button now reads `… · Partial`; press **+** twice and confirm the readout goes `×0.75`, `×1`.
3. Type `4.3` in the unit field: the readout shows the exact `×n.nn`, the thumb sits at the nearest quarter; press **+** once and confirm it lands on the next quarter.
4. Type a huge number (e.g. `99999`): the red warning appears and the button disables. Clear it.
5. Tap **Planned**: value returns to the plan; press the button. Confirm the toast `Done · X unit made`, the row moves to the Done section with the same amount, and the sheet closes.
6. Open an item from the **item drawer** (click a row name) and press **Log yield**: the sheet opens above the drawer prefilled with the drawer's upscale-slider yield if you changed it; confirm and check the drawer closes too.
7. Repeat from the **Smart prep** tab's board drawer.
8. `read_console_messages` with `onlyErrors: true`: no new errors (the buffer may still hold errors from before the page load — compare counts).

- [ ] **Step 4: Phone width**

`resize_window` preset `mobile`, reload `/prep`. Repeat steps 1, 2 and 6 from the mobile Working On row and the mobile drawer. Confirm the sheet is a bottom sheet, the ± buttons are 40 px and the slider is easy to grab. Reset with preset `desktop`.

- [ ] **Step 5: Non-batch item**

Find an item with no linked recipe (or whose recipe yields in a different dimension) on the To do; press Done. Confirm: no batch row, only the **Planned** chip, unit field focused, button previews Done/Partial.

- [ ] **Step 6: Stop the server, remove the launch entry, open the PR**

`preview_stop`, delete the `Yield worktree` entry from `.claude/launch.json`, then:

```bash
git push -u origin <branch>
gh pr create --base main --title "feat(prep): Log yield sheet — enter what you made by batches or by unit" --body-file - <<'EOF'
## What

One "Log yield" sheet replaces the quick done sheet and both drawers' inline yield fields. It shows ONE value two ways, always in sync: a 0–10 batch slider in quarter steps with a ± stepper, and the unit field. Quick chips for Planned / ×1 / ½ batch. The button previews the outcome (`Log 9 l · Done` / `… · Partial`) using the prep page's existing rule. Stored value stays UOM; no API change.

Spec: `docs/superpowers/specs/2026-09-13-log-yield-sheet-design.md`
Plan: `docs/superpowers/plans/2026-09-13-log-yield-sheet.md`

## Why

Cooks think in batches; the old field only took litres or kilos, looked off-brand, and was painted three different ways.

## Verification

- `prep-yield.test.ts` (17 tests) + full `npm test`; `tsc`, `lint`, `build` clean.
- Dev server on the branch: Working On row, item drawer and board drawer at desktop and phone width; non-batch item; overflow warning; toast and Done row agree with the logged amount.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

---

## Self-review

- **Spec coverage:** §0 decisions → Tasks 1–5 (one sheet, one value two views, 0–10 by 0.25, automatic-but-shown Done/Partial, UOM stored, prefill order, non-batch fallback). §1 anatomy → Task 2. §2.1–2.5 behaviour → Task 1 (math) + Task 2 (gestures, keyboard, warning). §3.1 files → Tasks 2–5 (`PrepDoneSheet` deleted in Task 3). §3.2 data flow → Task 3 (`onYieldLogged` → `handleStatusChange`). §3.3 edge cases → Task 1 tests (reopen, planned 0) + Task 6 step 5 (non-batch). §4 testing → Tasks 1 and 6. §5 out of scope respected (planner stepper untouched).
- **Placeholders:** none.
- **Type consistency:** `YieldTarget { item, cookAlongQty }`, `onConfirm(item, qty, status)`, `onLogYield(item)`, `YieldStatus`, `yieldPrefill(item, cookAlongQty)` are spelled the same in every task.
