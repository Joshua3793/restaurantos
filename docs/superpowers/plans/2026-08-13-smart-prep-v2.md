# Smart Prep v2 — Prep-List Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `/prep` Smart Prep tab as a two-pane planner (suggestions → draft prep list) with a chef **post** step that publishes a provenance-stamped list to the To Do run sheet — and fix the stale-priority-pill bug (items returning to Smart Prep still marked Critical after completion brought them to par).

**Architecture:** Priority is *always computed* from `(onHand, par, targetToday, override)` — never trusted from a stale snapshot; a pure `src/lib/prep-plan.ts` holds the planner math (vitest-covered), including the completion-recompute that fixes the bug. Additive Prisma schema: `PrepLog.listOrder`/`PrepLog.postedAt` + new `PrepPost` (one row per RC per day, provenance + dirty flag). Draft state (qty/note/assignee/order) rides the existing per-day `PrepLog`; posting stamps `postedAt` on the draft's logs in one transaction. The To Do run sheet switches membership from `isOnList` to `postedAt` and gains a posted-provenance band. New `src/components/prep/planner/` tree renders desktop + mobile planners, replacing the Smart Prep board/cards.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Tailwind (flat tokens) · Lucide icons · vitest.

**Design source (Claude Design project `f8ab4c5f-9275-47be-9045-1bd226c26792`):** `prep-plan/Smart Prep v2.html` (composition + captions), `prep-plan/plan-data.js` (priority/suggest/why model — mirrors live `computePriority`), `prep-plan/planner.jsx` (desktop split view, `PPPrioPicker`, `PPAssign`, `PPPostDialog`), `prep-plan/planner-mobile.jsx` (mobile tabs + sticky post bar), `prep-todo/*` (base To Do the band sits above). Port faithfully; substitute tokens/icons per Global Constraints. The demo's **forecast band (covers) is OUT OF SCOPE** — the app has no covers-forecast model; the existing service-status header/band stays.

## Global Constraints

- **Branch:** new work branches from `main` → `feat/smart-prep-v2`. Do NOT build on `fix/count-frozen-base` (PR #90). Use an isolated worktree (`superpowers:using-git-worktrees`).
- **Colors:** app's **flat Tailwind tokens** only (`bg-red`, `text-red-text`, `bg-gold`, `text-gold-2`, `bg-green`, `text-green-text`, `bg-ink`, `text-ink-2/3/4`, `bg-bg`, `bg-bg-2`, `bg-paper`, `border-line`, `border-line-2`, soft variants `bg-red-soft`/`bg-gold-soft`/`bg-green-soft`). Numbered classes (`bg-red-500`) are BROKEN in this repo.
- **Icons:** Lucide only — `Sparkles` (spark), `Zap` (flash), `Check`, `Plus`, `Minus`, `X`, `Lock`, `Users`, `Undo2`, `AlertTriangle`, `ChevronDown`, `GripVertical`, `Pencil`, `ChefHat`, `Package` (box).
- **Client components:** `'use client'` at top; every sub-component at **module scope** (never inside another component body — remount/focus-loss bug).
- **Dual renderer:** split at `md:` (`md:hidden` / `hidden md:block`) — matches prep/count/today.
- **Route handlers:** every new/mutated route exports `const dynamic = 'force-dynamic'`; polled GETs return `Cache-Control: no-store`.
- **Prisma:** singleton import from `@/lib/prisma`; **Decimal serializes as string** in JSON — wrap `Number()` before arithmetic (`requiredQty`, `actualPrepQty`).
- **Migrations:** shadow-DB `migrate dev` is broken here. Use: `prisma migrate diff --from-url $DIRECT_URL --to-schema-datamodel prisma/schema.prisma --script` → save SQL under `prisma/migrations/<ts>_smart_prep_plan/migration.sql` → `prisma db execute --file … --url $DIRECT_URL` → `prisma migrate resolve --applied <name>` → `prisma generate`. All columns additive/nullable — safe on the live DB.
- **Auth:** `requireSession(minRole)` from `@/lib/auth`, catch `AuthError` → JSON `{error},{status}`. **Planner writes (draft membership, priority override, qty/note/order, post, recall) = `LEAD`+**; cook actions (claim, start, done) stay session-only. Client role via `useUser()` + `atLeast` from `@/lib/roles`.
- **No `backdrop-blur`** on fixed inset-0 scrims.
- **Verify each task:** `npm test` after any `src/lib` change; `npm run build` (in the detached build worktree — building in the main checkout while `next dev` runs gives bogus failures); UI tasks verified in the browser preview (`preview_start`, which serves the MAIN checkout — check out the feature branch there or verify after merge back).
- **Existing behavior that must not regress:** offline queue (`prep-offline.ts` mutation types unchanged), per-item op chaining (`opChains`), `mutationSeq` stale-snapshot guard, PrepTask checklist slots on both tabs, the item drawer (`PrepBoardDrawer`/`PrepDrawer`) opening from both tabs, History tab.

---

# Phase 1 — Priority-pill correctness (shippable alone)

### Task 1: Pure planner lib + completion recompute (`prep-plan.ts`)

**Files:**
- Create: `src/lib/prep-plan.ts`
- Test: `src/lib/__tests__/prep-plan.test.ts`

**Interfaces:**
- Consumes: `computePriority`, `computeSuggestedQty`, `PrepPriority` from `@/lib/prep-utils`.
- Produces (used by Tasks 2, 6–9):
  - `PLAN_PRIORITY_ORDER: PrepPriority[]`
  - `PLAN_PRIO_META: Record<PrepPriority, { label; sub; dotClass; softClass; textClass; barClass }>`
  - `autoPriority(t) / effectivePriority(t): PrepPriority` for `t: PlanFields`
  - `prepStep(unit): number`, `roundPrepQty(v, unit): number`, `suggestedDraftQty(t): number`
  - `whyLabel(t): string`
  - `applyStatusToItem<T>(item: T, newStatus: string, actualQty?: number): T` — the bug fix
  - `draftQty(t): number` — planned qty for a draft row (`todayLog.requiredQty ?? suggestedDraftQty`)
  - `type PlanFields = { onHand: number; parLevel: number; minThreshold: number; targetToday: number | null; manualPriorityOverride: string | null; unit: string }`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/__tests__/prep-plan.test.ts
import { describe, it, expect } from 'vitest'
import {
  effectivePriority, autoPriority, prepStep, roundPrepQty,
  suggestedDraftQty, whyLabel, applyStatusToItem, draftQty,
} from '../prep-plan'

const base = {
  onHand: 0, parLevel: 8, minThreshold: 0, targetToday: null as number | null,
  manualPriorityOverride: null as string | null, unit: 'kg',
  priority: '911' as const, suggestedQty: 8,
  todayLog: null as { status: string; actualPrepQty: number | null } | null,
}

describe('effectivePriority', () => {
  it('stock out → 911', () => expect(effectivePriority({ ...base })).toBe('911'))
  it('under target → 911 even when above par', () =>
    expect(effectivePriority({ ...base, onHand: 9, targetToday: 12 })).toBe('911'))
  it('below par → NEEDED_TODAY', () =>
    expect(effectivePriority({ ...base, onHand: 3 })).toBe('NEEDED_TODAY'))
  it('at par → LATER', () => expect(effectivePriority({ ...base, onHand: 8 })).toBe('LATER'))
  it('override wins', () =>
    expect(effectivePriority({ ...base, onHand: 8, manualPriorityOverride: '911' })).toBe('911'))
  it('autoPriority ignores the override', () =>
    expect(autoPriority({ ...base, onHand: 8, manualPriorityOverride: '911' })).toBe('LATER'))
})

describe('steps + rounding', () => {
  it('kg/L step 0.5, g/ml step 25, count units step 1', () => {
    expect(prepStep('kg')).toBe(0.5); expect(prepStep('L')).toBe(0.5)
    expect(prepStep('g')).toBe(25);   expect(prepStep('ml')).toBe(25)
    expect(prepStep('each')).toBe(1); expect(prepStep('batch')).toBe(1)
  })
  it('roundPrepQty snaps to the step', () => {
    expect(roundPrepQty(6.3, 'kg')).toBe(6.5)
    expect(roundPrepQty(1740, 'g')).toBe(1750)
    expect(roundPrepQty(4.4, 'each')).toBe(4)
  })
  it('suggestedDraftQty: 0 when at/above par, else rounded and at least one step', () => {
    expect(suggestedDraftQty({ ...base, onHand: 8 })).toBe(0)
    expect(suggestedDraftQty({ ...base, onHand: 7.9 })).toBe(0.5)   // raw 0.1 → floor to step
    expect(suggestedDraftQty({ ...base, onHand: 1.8 })).toBe(6)     // raw 6.2 → 6.0
  })
})

describe('whyLabel', () => {
  it('names the reason', () => {
    expect(whyLabel({ ...base })).toBe('stock out')
    expect(whyLabel({ ...base, onHand: 9, targetToday: 12 })).toBe("under today's target 12 kg")
    expect(whyLabel({ ...base, onHand: 3 })).toBe('below par by 5 kg')
    expect(whyLabel({ ...base, onHand: 8 })).toBe('at par')
    expect(whyLabel({ ...base, manualPriorityOverride: 'LATER' })).toBe('chef override')
  })
})

describe('applyStatusToItem — the stale-pill fix', () => {
  it('completing credits onHand, clears the override, recomputes priority + suggestion', () => {
    const item = { ...base, onHand: 0, manualPriorityOverride: '911' }
    const next = applyStatusToItem(item, 'DONE', 9)
    expect(next.onHand).toBe(9)
    expect(next.manualPriorityOverride).toBeNull()
    expect(next.priority).toBe('LATER')          // was Critical, now above par
    expect(next.suggestedQty).toBe(0)
  })
  it('PARTIAL below par lands on NEEDED_TODAY, not the old 911', () => {
    const next = applyStatusToItem({ ...base }, 'PARTIAL', 3)
    expect(next.priority).toBe('NEEDED_TODAY')
    expect(next.suggestedQty).toBe(5)
  })
  it('re-logging a completed item applies only the qty delta', () => {
    const item = { ...base, onHand: 9, todayLog: { status: 'DONE', actualPrepQty: 9 } }
    const next = applyStatusToItem(item, 'DONE', 6)
    expect(next.onHand).toBe(6)
  })
  it('reopening a done item takes its credit back', () => {
    const item = { ...base, onHand: 9, priority: 'LATER' as const, todayLog: { status: 'DONE', actualPrepQty: 9 } }
    const next = applyStatusToItem(item, 'IN_PROGRESS')
    expect(next.onHand).toBe(0)
    expect(next.priority).toBe('911')
  })
  it('plain start does not move stock', () => {
    const next = applyStatusToItem({ ...base, onHand: 3 }, 'IN_PROGRESS')
    expect(next.onHand).toBe(3)
    expect(next.priority).toBe('NEEDED_TODAY')
  })
})

describe('draftQty', () => {
  it('prefers the chef-set requiredQty (Decimal-as-string safe), else the rounded suggestion', () => {
    expect(draftQty({ ...base, onHand: 1.8, todayLog: { status: 'NOT_STARTED', actualPrepQty: null, requiredQty: '4.5' as unknown as number } })).toBe(4.5)
    expect(draftQty({ ...base, onHand: 1.8 })).toBe(6)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npm test -- prep-plan` → FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/prep-plan.ts`**

```ts
// Smart Prep v2 — pure planner math. Priority is ALWAYS computed from stock
// (computePriority), never trusted from a snapshot: the stale-pill bug was the
// client keeping a server-computed `priority` after a completion changed onHand.
import { computePriority, computeSuggestedQty, type PrepPriority } from './prep-utils'

export interface PlanFields {
  onHand: number
  parLevel: number
  minThreshold: number
  targetToday: number | null
  manualPriorityOverride: string | null
  unit: string
}

export const PLAN_PRIORITY_ORDER: PrepPriority[] = ['911', 'NEEDED_TODAY', 'LATER']

export const PLAN_PRIO_META: Record<PrepPriority, {
  label: string; sub: string
  dotClass: string; softClass: string; textClass: string; barClass: string
}> = {
  '911':          { label: 'Critical', sub: 'stock out, or under today’s target', dotClass: 'bg-red',   softClass: 'bg-red-soft',   textClass: 'text-red-text',   barClass: 'bg-red' },
  'NEEDED_TODAY': { label: 'Needed',   sub: 'below par level',                    dotClass: 'bg-gold',  softClass: 'bg-gold-soft',  textClass: 'text-gold-2',     barClass: 'bg-gold' },
  'LATER':        { label: 'Later',    sub: 'at or above par — no make needed',   dotClass: 'bg-green', softClass: 'bg-green-soft', textClass: 'text-green-text', barClass: 'bg-green' },
}

export const autoPriority = (t: PlanFields): PrepPriority =>
  computePriority(t.onHand, t.parLevel, t.minThreshold, t.targetToday, null)

export const effectivePriority = (t: PlanFields): PrepPriority =>
  computePriority(t.onHand, t.parLevel, t.minThreshold, t.targetToday, t.manualPriorityOverride)

/** Sensible stepper increment per unit (design ppStep, adapted to app units). */
export function prepStep(unit: string): number {
  const u = (unit || '').toLowerCase()
  if (u === 'kg' || u === 'l') return 0.5
  if (u === 'g' || u === 'ml') return 25
  return 1 // each, ea, batch, loaves, bunch, portion…
}

/** Snap a quantity to the unit's step (float-cleaned). */
export function roundPrepQty(v: number, unit: string): number {
  const step = prepStep(unit)
  return +(Math.round(v / step) * step).toFixed(2)
}

/** Rounded make-suggestion: 0 at/above par, otherwise ≥ one step. */
export function suggestedDraftQty(t: PlanFields): number {
  const raw = computeSuggestedQty(t.onHand, t.parLevel, t.targetToday)
  if (raw <= 0) return 0
  return Math.max(prepStep(t.unit), roundPrepQty(raw, t.unit))
}

const fmtQ = (q: number, u: string) => `${q % 1 === 0 ? q : +q.toFixed(2)} ${u}`

/** One-line reason a suggestion carries its priority (design ppWhy). */
export function whyLabel(t: PlanFields): string {
  if (t.manualPriorityOverride) return 'chef override'
  if (t.onHand <= 0 && t.parLevel > 0) return 'stock out'
  if (t.targetToday != null && t.onHand < t.targetToday) return `under today's target ${fmtQ(t.targetToday, t.unit)}`
  if (t.onHand < t.parLevel) return `below par by ${fmtQ(+(t.parLevel - t.onHand).toFixed(2), t.unit)}`
  return 'at par'
}

const COMPLETE = new Set(['DONE', 'PARTIAL'])

/**
 * Optimistically re-derive an item after a status change: move onHand by the
 * yield delta, clear the override on completion (mirrors the server rule in
 * /api/prep/logs/[id]), and recompute priority + suggestedQty. This is the fix
 * for "done items drop back to Smart Prep still wearing a Critical pill".
 */
export function applyStatusToItem<T extends PlanFields & {
  priority: PrepPriority
  suggestedQty: number
  todayLog?: { status: string; actualPrepQty: number | null } | null
}>(item: T, newStatus: string, actualQty?: number): T {
  const completing = COMPLETE.has(newStatus)
  const prevQty = item.todayLog && COMPLETE.has(item.todayLog.status)
    ? Number(item.todayLog.actualPrepQty ?? 0)
    : 0
  let onHand = item.onHand
  if (completing) onHand += (actualQty ?? prevQty) - prevQty
  else onHand -= prevQty
  const manualPriorityOverride = completing ? null : item.manualPriorityOverride
  return {
    ...item,
    onHand,
    manualPriorityOverride,
    priority: computePriority(onHand, item.parLevel, item.minThreshold, item.targetToday, manualPriorityOverride),
    suggestedQty: computeSuggestedQty(onHand, item.parLevel, item.targetToday),
  }
}

/** Planned qty for a draft row: chef-set requiredQty wins, else rounded suggestion. */
export function draftQty(t: PlanFields & { todayLog?: { requiredQty?: number | string | null } | null }): number {
  const rq = t.todayLog?.requiredQty
  if (rq != null && Number(rq) > 0) return Number(rq)
  return suggestedDraftQty(t)
}
```

- [ ] **Step 4: Run tests** — `npm test -- prep-plan` → all PASS. Run the full suite `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prep-plan.ts src/lib/__tests__/prep-plan.test.ts
git commit -m "feat(prep): pure planner math lib — computed priority, steps, completion recompute"
```

### Task 2: Wire the completion recompute into `/prep` (the bug fix)

**Files:**
- Modify: `src/app/prep/page.tsx` (`handleStatusChange` optimistic block, ~line 744)

**Interfaces:**
- Consumes: `applyStatusToItem` from Task 1.
- Produces: after any Done/Partial/reopen, the local item carries recomputed `onHand`/`priority`/`suggestedQty` — every pill and bucket re-sorts instantly.

- [ ] **Step 1: Replace the optimistic item patch in `handleStatusChange`.** Current code (page.tsx ~748):

```ts
    setItems(prev => prev.map(i => {
      if (i.id !== itemId) return i
      const existingLog = i.todayLog
      return {
        ...i,
        isOnList: nextOnList,
        ...(completingNow && { manualPriorityOverride: null }),
        todayLog: existingLog ? { ...existingLog, status: ... } : { ...seed },
      }
    }))
```

becomes (import `applyStatusToItem` from `@/lib/prep-plan`; keep the existing `now`/`completingNow`/`nextOnList` lines and the todayLog seed object exactly as they are):

```ts
    setItems(prev => prev.map(i => {
      if (i.id !== itemId) return i
      const existingLog = i.todayLog
      // Recompute BEFORE swapping the log in: applyStatusToItem reads the OLD
      // todayLog to know what a re-log/reopen must un-credit.
      const recomputed = applyStatusToItem(i, newStatus, actualQty)
      return {
        ...recomputed,
        isOnList: nextOnList,
        todayLog: existingLog
          ? { ...existingLog, status: newStatus as PrepLogData['status'], ...(actualQty !== undefined ? { actualPrepQty: actualQty } : {}) }
          : { /* unchanged seed object from the current code */ },
      }
    }))
```

- [ ] **Step 2: Type-check** — `npm run build` in the build worktree → green.

- [ ] **Step 3: Browser-verify the bug is dead.** `preview_start` the dev server; on `/prep`: add a Critical item to the list, post-less flow (still old To Do at this point), mark it Done with a yield ≥ par. Confirm it reappears under Smart Prep with a **green/Later** pill and "at par" — no Critical pill, without waiting for a poll.

- [ ] **Step 4: Commit**

```bash
git add src/app/prep/page.tsx
git commit -m "fix(prep): recompute priority/onHand/suggestion optimistically on completion — stale Critical pill after done"
```

---

# Phase 2 — Schema + plan API

### Task 3: Schema — `PrepLog.listOrder/postedAt`, new `PrepPost`

**Files:**
- Modify: `prisma/schema.prisma` (`PrepLog`, `RevenueCenter`; add `PrepPost`)
- Create: `prisma/migrations/<ts>_smart_prep_plan/migration.sql`
- Modify: `src/components/prep/types.ts` (`PrepLogData` + new `PrepPostInfo`)

**Interfaces:**
- Produces: `PrepLog.listOrder: Int?`, `PrepLog.postedAt: DateTime?`; `PrepPost { id, revenueCenterId, listDate, postedAt, postedByName, itemCount, activeMinutes, dirty }` unique on `(revenueCenterId, listDate)`; TS `PrepLogData.listOrder/postedAt`, `interface PrepPostInfo { id; postedAt: string; postedByName: string; itemCount: number; activeMinutes: number; dirty: boolean }`.

- [ ] **Step 1: Edit `PrepLog`** — add after `completedAt`:

```prisma
  // ── Smart Prep v2 planner ──
  listOrder  Int?       // chef's order within a priority bucket (per-day draft)
  postedAt   DateTime?  // set when the chef posts the list; membership in the kitchen's To Do
```

- [ ] **Step 2: Add `PrepPost`** (below `PrepSettings`) and the back-relation on `RevenueCenter`:

```prisma
// One row per RC per day: the chef's posted prep list (provenance for the To Do
// band). `dirty` = the draft changed after posting — the kitchen still sees the
// posted version until the chef re-posts. Membership itself lives on
// PrepLog.postedAt; this row is the header, not a snapshot (no duplicated state).
model PrepPost {
  id              String        @id @default(uuid())
  revenueCenterId String
  listDate        DateTime
  postedAt        DateTime
  postedByName    String
  itemCount       Int
  activeMinutes   Int           @default(0)
  dirty           Boolean       @default(false)
  revenueCenter   RevenueCenter @relation("PrepPostRC", fields: [revenueCenterId], references: [id])

  @@unique([revenueCenterId, listDate])
}
```

In `RevenueCenter`, add alongside the other relation lists: `prepPosts PrepPost[] @relation("PrepPostRC")`.

- [ ] **Step 3: Generate + apply the migration** (shadow DB is broken — use the recorded workaround):

```bash
mkdir -p prisma/migrations/20260813000000_smart_prep_plan
npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script \
  > prisma/migrations/20260813000000_smart_prep_plan/migration.sql
# Inspect: must contain ONLY the two ALTER TABLE "PrepLog" ADD COLUMN lines and the
# CREATE TABLE/INDEX/FK for "PrepPost". NEVER a full-schema diff.
npx prisma db execute --file prisma/migrations/20260813000000_smart_prep_plan/migration.sql --url "$DIRECT_URL"
npx prisma migrate resolve --applied 20260813000000_smart_prep_plan
npx prisma generate
```

- [ ] **Step 4: Extend the TS types** in `src/components/prep/types.ts` — add to `PrepLogData`:

```ts
  listOrder: number | null
  postedAt: string | null
```

and export:

```ts
export interface PrepPostInfo {
  id: string
  postedAt: string
  postedByName: string
  itemCount: number
  activeMinutes: number
  dirty: boolean
}
```

(The items GET already returns the full `PrepLog` row as `todayLog`, so the new columns flow through with no route change.)

- [ ] **Step 5: Verify + commit** — `npm run build` green.

```bash
git add prisma/schema.prisma prisma/migrations/20260813000000_smart_prep_plan src/components/prep/types.ts
git commit -m "feat(prep): schema for posted prep lists — PrepLog.listOrder/postedAt + PrepPost"
```

### Task 4: Plan API — GET/post/recall/reorder + dirty hooks + LEAD gates

**Files:**
- Create: `src/lib/prep-plan-server.ts`
- Create: `src/app/api/prep/plan/route.ts` (GET)
- Create: `src/app/api/prep/plan/post/route.ts` (POST)
- Create: `src/app/api/prep/plan/recall/route.ts` (POST)
- Create: `src/app/api/prep/plan/reorder/route.ts` (PATCH)
- Modify: `src/app/api/prep/items/[id]/route.ts` (LEAD gate + dirty on `isOnList`/`manualPriorityOverride`)
- Modify: `src/app/api/prep/logs/route.ts` (POST accepts `requiredQty`/`note`/`listOrder` seeds)
- Modify: `src/app/api/prep/logs/[id]/route.ts` (PUT accepts `requiredQty`/`listOrder`; LEAD gate on planner fields; dirty hook)

**Interfaces:**
- Consumes: Task 3 schema; `requireSession`, `assertRcWritable`, `resolveActive` (from `@/lib/prep-runsheet`).
- Produces:
  - `GET /api/prep/plan?rcId=<id>` → `{ post: PrepPostInfo | null }` (no-store)
  - `POST /api/prep/plan/post { revenueCenterId }` → `{ post: PrepPostInfo }` — stamps today's draft
  - `POST /api/prep/plan/recall { revenueCenterId }` → `{ ok: true }`
  - `PATCH /api/prep/plan/reorder { revenueCenterId, orders: [{ prepItemId, listOrder }] }` → `{ ok: true }`
  - `prepDayStart(): Date`, `prepDayRange(): { gte; lt }`, `markPlanDirty(rcId: string | null): Promise<void>` from `prep-plan-server.ts`

- [ ] **Step 1: `src/lib/prep-plan-server.ts`**

```ts
import { prisma } from '@/lib/prisma'

/** Same day convention as every PrepLog write: server-local midnight. */
export function prepDayStart(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

export function prepDayRange(): { gte: Date; lt: Date } {
  const gte = prepDayStart()
  return { gte, lt: new Date(gte.getTime() + 86_400_000) }
}

/**
 * A draft edit after posting means the kitchen is looking at a stale list —
 * flag today's post(s) so both surfaces can say "CHEF HAS UNPOSTED CHANGES".
 * rcId null (a Shared item) can sit on any RC's plan → flag all of today's posts.
 */
export async function markPlanDirty(rcId: string | null): Promise<void> {
  const listDate = prepDayStart()
  await prisma.prepPost.updateMany({
    where: rcId ? { revenueCenterId: rcId, listDate } : { listDate },
    data: { dirty: true },
  })
}
```

- [ ] **Step 2: `GET /api/prep/plan`** — `src/app/api/prep/plan/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { prepDayStart } from '@/lib/prep-plan-server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const rcId = new URL(req.url).searchParams.get('rcId')
  if (!rcId) return NextResponse.json({ post: null }, { headers: { 'Cache-Control': 'no-store' } })
  const row = await prisma.prepPost.findUnique({
    where: { revenueCenterId_listDate: { revenueCenterId: rcId, listDate: prepDayStart() } },
  })
  const post = row ? {
    id: row.id, postedAt: row.postedAt.toISOString(), postedByName: row.postedByName,
    itemCount: row.itemCount, activeMinutes: row.activeMinutes, dirty: row.dirty,
  } : null
  return NextResponse.json({ post }, { headers: { 'Cache-Control': 'no-store' } })
}
```

- [ ] **Step 3: `POST /api/prep/plan/post`** — `src/app/api/prep/plan/post/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { resolveActive } from '@/lib/prep-runsheet'
import { prepDayStart, prepDayRange } from '@/lib/prep-plan-server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let user
  try { user = await requireSession('LEAD') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const body = await req.json().catch(() => null)
  const revenueCenterId: string | undefined = body?.revenueCenterId
  if (!revenueCenterId) return NextResponse.json({ error: 'revenueCenterId is required' }, { status: 400 })
  try { await assertRcWritable(user, revenueCenterId) }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const listDate = prepDayStart()
  const day = prepDayRange()

  // The draft = active on-list items visible to this RC (its own + Shared).
  const draft = await prisma.prepItem.findMany({
    where: {
      isActive: true, isOnList: true,
      OR: [{ revenueCenterId: null }, { revenueCenterId }],
    },
    select: {
      id: true, estimatedPrepTime: true,
      activeMinutesOverride: true, passiveMinutesOverride: true, passiveNoteOverride: true,
      linkedRecipe: { select: { activeMinutes: true, passiveMinutes: true, passiveNote: true } },
      logs: { where: { logDate: day }, take: 1, select: { id: true } },
    },
  })
  if (draft.length === 0) return NextResponse.json({ error: 'Nothing on the list to post' }, { status: 400 })

  const draftIds = draft.map(d => d.id)
  const activeMinutes = draft.reduce(
    (a, d) => a + (resolveActive(d) ?? d.estimatedPrepTime ?? 0), 0)
  const now = new Date()
  const postedByName = user.name ?? user.email ?? 'Chef'
  const missing = draft.filter(d => d.logs.length === 0)

  const [, , , post] = await prisma.$transaction([
    // Items posted earlier but since removed from the draft leave the kitchen's list.
    prisma.prepLog.updateMany({
      where: { logDate: day, postedAt: { not: null }, prepItemId: { notIn: draftIds } },
      data: { postedAt: null },
    }),
    // Ensure every draft item has today's log (unique prepItemId+logDate absorbs races).
    prisma.prepLog.createMany({
      data: missing.map(d => ({ prepItemId: d.id, revenueCenterId, logDate: listDate, status: 'NOT_STARTED' })),
      skipDuplicates: true,
    }),
    prisma.prepLog.updateMany({
      where: { prepItemId: { in: draftIds }, logDate: day },
      data: { postedAt: now },
    }),
    prisma.prepPost.upsert({
      where: { revenueCenterId_listDate: { revenueCenterId, listDate } },
      update: { postedAt: now, postedByName, itemCount: draft.length, activeMinutes, dirty: false },
      create: { revenueCenterId, listDate, postedAt: now, postedByName, itemCount: draft.length, activeMinutes, dirty: false },
    }),
  ])

  return NextResponse.json({
    post: {
      id: post.id, postedAt: post.postedAt.toISOString(), postedByName: post.postedByName,
      itemCount: post.itemCount, activeMinutes: post.activeMinutes, dirty: post.dirty,
    },
  })
}
```

Note: `resolveActive` in `@/lib/prep-runsheet` takes `{ activeMinutesOverride, linkedRecipe }`-shaped input — check its exact signature before wiring and adapt the call (it may want `{ activeMinutesOverride, passiveMinutesOverride, passiveNoteOverride, linkedRecipe }`, which the select above provides).

- [ ] **Step 4: `POST /api/prep/plan/recall`** — `src/app/api/prep/plan/recall/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { prepDayStart, prepDayRange } from '@/lib/prep-plan-server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let user
  try { user = await requireSession('LEAD') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const body = await req.json().catch(() => null)
  const revenueCenterId: string | undefined = body?.revenueCenterId
  if (!revenueCenterId) return NextResponse.json({ error: 'revenueCenterId is required' }, { status: 400 })
  try { await assertRcWritable(user, revenueCenterId) }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const listDate = prepDayStart()
  await prisma.$transaction([
    prisma.prepLog.updateMany({ where: { logDate: prepDayRange(), postedAt: { not: null } }, data: { postedAt: null } }),
    prisma.prepPost.deleteMany({ where: { revenueCenterId, listDate } }),
  ])
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 5: `PATCH /api/prep/plan/reorder`** — `src/app/api/prep/plan/reorder/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { prepDayRange, prepDayStart, markPlanDirty } from '@/lib/prep-plan-server'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest) {
  let user
  try { user = await requireSession('LEAD') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const body = await req.json().catch(() => null)
  const revenueCenterId: string | undefined = body?.revenueCenterId
  const orders: Array<{ prepItemId: string; listOrder: number }> = Array.isArray(body?.orders) ? body.orders : []
  if (!revenueCenterId || orders.length === 0) {
    return NextResponse.json({ error: 'revenueCenterId and orders are required' }, { status: 400 })
  }
  try { await assertRcWritable(user, revenueCenterId) }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const day = prepDayRange()
  await prisma.$transaction([
    prisma.prepLog.createMany({
      data: orders.map(o => ({ prepItemId: o.prepItemId, revenueCenterId, logDate: prepDayStart(), status: 'NOT_STARTED' })),
      skipDuplicates: true,
    }),
    ...orders.map(o => prisma.prepLog.updateMany({
      where: { prepItemId: o.prepItemId, logDate: day },
      data: { listOrder: o.listOrder },
    })),
  ])
  await markPlanDirty(revenueCenterId)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 6: Gate + dirty in `items/[id]` PUT.** In `src/app/api/prep/items/[id]/route.ts` PUT, after the JSON-body guard add:

```ts
  // Planner fields are the chef's: draft membership + priority override = LEAD+.
  if (body.isOnList !== undefined || body.manualPriorityOverride !== undefined) {
    try { await requireSession('LEAD') }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  }
```

and after the `prisma.prepItem.update(...)` call:

```ts
  if (body.isOnList !== undefined || body.manualPriorityOverride !== undefined) {
    await markPlanDirty(item.revenueCenterId)
  }
```

(import `markPlanDirty` from `@/lib/prep-plan-server`).

- [ ] **Step 7: Logs POST seeds + PUT planner fields.** In `src/app/api/prep/logs/route.ts` POST, add optional pass-through when creating the log: `requiredQty: body.requiredQty != null ? parseFloat(String(body.requiredQty)) : undefined`, `note: body.note ?? undefined`, `listOrder: body.listOrder ?? undefined` (read the file first and mirror its existing upsert/create shape). In `src/app/api/prep/logs/[id]/route.ts` PUT:
  - destructure `requiredQty` and `listOrder` from the body;
  - if `requiredQty !== undefined || listOrder !== undefined || note !== undefined` → require LEAD (same inline pattern as Step 6) — **`assignedTo` stays session-only (cooks claim)**;
  - add to the update data: `...(requiredQty !== undefined && { requiredQty: parseFloat(String(requiredQty)) })`, `...(listOrder !== undefined && { listOrder })`;
  - after the update, when any of `requiredQty`/`note`/`listOrder` changed: `await markPlanDirty(existing.revenueCenterId)`.
  - The status→isOnList side-effect block stays exactly as is (cook completions must NOT mark the plan dirty).

- [ ] **Step 8: Verify + commit** — `npm run build` green; `curl` sanity is impractical (auth), rely on Task 7/9 browser verification.

```bash
git add src/lib/prep-plan-server.ts src/app/api/prep/plan src/app/api/prep/items/[id]/route.ts src/app/api/prep/logs
git commit -m "feat(prep): plan API — post/recall/reorder, dirty tracking, LEAD gates on planner writes"
```

---

# Phase 3 — Planner UI

### Task 5: Planner atoms — bucket head, priority picker, assign pill, post dialog

**Files:**
- Create: `src/components/prep/planner/atoms.tsx` (`BucketHead`, `PrioPill`, `PrioPicker`, `AssignPill`, `Popover`)
- Create: `src/components/prep/planner/PostDialog.tsx`

**Interfaces:**
- Consumes: `PLAN_PRIO_META`, `PLAN_PRIORITY_ORDER`, `effectivePriority`, `autoPriority`, `draftQty` (Task 1); `Cook` type from `@/components/prep/runsheet/assignee`; `PrepItemRich`.
- Produces:
  - `BucketHead({ p, count, mins?, warn? })`
  - `PrioPicker({ item, locked, onChange(prio: string) })` — `onChange('')` = back to smart
  - `AssignPill({ cookId, cooks, locked, onAssign(id: string | null) })`
  - `PostDialog({ draft, cooks, reposting, onClose, onConfirm })` where `draft: PrepItemRich[]`

- [ ] **Step 1: `atoms.tsx`** — port `PPBucketHead` / `PPPrioPill` / `PPPrioPicker` / `PPAssign` / `PPPop` from `planner.jsx` to Tailwind tokens:

```tsx
'use client'
import { useState } from 'react'
import { Pencil, ChevronDown, Undo2 } from 'lucide-react'
import type { PrepPriority } from '@/lib/prep-utils'
import { PLAN_PRIO_META, PLAN_PRIORITY_ORDER, effectivePriority, autoPriority } from '@/lib/prep-plan'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'

export function Popover({ children, onClose, w = 'w-48' }: { children: React.ReactNode; onClose: () => void; w?: string }) {
  return (
    <>
      <span className="fixed inset-0 z-40" onClick={onClose} />
      <div className={`absolute right-0 top-[calc(100%+5px)] z-50 ${w} bg-paper border border-line-2 rounded-xl shadow-[0_14px_34px_-10px_rgba(9,9,11,0.28)] p-1.5`}>{children}</div>
    </>
  )
}

export const popItemCls = (active: boolean) =>
  `flex items-center gap-2 w-full text-left rounded-lg px-2.5 py-2 text-[12.5px] cursor-pointer ${active ? 'bg-bg-2 font-semibold' : 'font-medium'} text-ink-2 hover:bg-bg-2`

export function BucketHead({ p, count, mins, warn }: { p: PrepPriority; count: number; mins?: number | null; warn?: boolean }) {
  const m = PLAN_PRIO_META[p]
  return (
    <div className="flex items-center gap-2 mt-3.5 mb-1.5 mx-0.5">
      <span className={`w-[7px] h-[7px] rounded-full ${m.dotClass}`} />
      <span className="font-mono text-[10.5px] font-bold uppercase tracking-[0.05em] text-ink">{m.label}</span>
      <span className="font-mono text-[9.5px] text-ink-4">· {count}{mins != null ? ` · ${Math.floor(mins / 60) ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}` : `${mins}m`}` : ''}</span>
      {warn
        ? <span className="ml-auto font-mono text-[9px] font-bold uppercase bg-red-soft text-red-text px-2 py-0.5 rounded-full">Change the priority to move it</span>
        : <span className="ml-auto font-mono text-[9px] text-ink-4">{m.sub}</span>}
    </div>
  )
}

export function PrioPill({ p, override, sm }: { p: PrepPriority; override?: boolean; sm?: boolean }) {
  const m = PLAN_PRIO_META[p]
  return (
    <span className={`inline-flex items-center gap-1.5 ${m.softClass} ${m.textClass} rounded-full font-mono font-bold ${sm ? 'text-[9px] px-2 py-0.5' : 'text-[9.5px] px-2.5 py-1'} whitespace-nowrap`}>
      <span className={`w-[5px] h-[5px] rounded-full ${m.dotClass}`} />{m.label.toUpperCase()}
      {override && <Pencil size={9} />}
    </span>
  )
}

export function PrioPicker({ item, locked, onChange }: { item: PrepItemRich; locked: boolean; onChange: (prio: string) => void }) {
  const [open, setOpen] = useState(false)
  const p = effectivePriority(item)
  const auto = autoPriority(item)
  const m = PLAN_PRIO_META[p]
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => !locked && setOpen(v => !v)}
        title={locked ? 'Chef only' : 'Set priority'}
        className={`inline-flex items-center gap-1.5 w-[92px] ${m.softClass} ${m.textClass} border ${item.manualPriorityOverride ? 'border-current' : 'border-transparent'} rounded-lg px-2 py-1.5 font-mono text-[9.5px] font-bold ${locked ? 'cursor-default' : 'cursor-pointer'}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${m.dotClass} shrink-0`} />
        <span className="flex-1 text-left">{m.label.toUpperCase()}</span>
        {item.manualPriorityOverride ? <Pencil size={10} /> : !locked && <ChevronDown size={10} />}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} w="w-52">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em] text-ink-4 px-2.5 pt-1.5 pb-2">Override priority</div>
          {PLAN_PRIORITY_ORDER.map(k => (
            <button key={k} onClick={() => { onChange(k === auto ? '' : k); setOpen(false) }} className={popItemCls(p === k)}>
              <span className={`w-[7px] h-[7px] rounded-full ${PLAN_PRIO_META[k].dotClass}`} />
              {PLAN_PRIO_META[k].label}
              {k === auto && <span className="ml-auto font-mono text-[9px] font-semibold text-ink-4 uppercase">Smart</span>}
            </button>
          ))}
          {item.manualPriorityOverride && (
            <button onClick={() => { onChange(''); setOpen(false) }} className={`${popItemCls(false)} border-t border-line rounded-none mt-1 pt-2.5 !text-gold-2`}>
              <Undo2 size={13} /> Back to smart ({PLAN_PRIO_META[auto].label})
            </button>
          )}
        </Popover>
      )}
    </div>
  )
}

export function AssignPill({ cookId, cooks, locked, onAssign, sm }: {
  cookId: string | null; cooks: Cook[]; locked: boolean; onAssign: (id: string | null) => void; sm?: boolean
}) {
  const [open, setOpen] = useState(false)
  const c = cookId ? cooks.find(x => x.id === cookId) ?? null : null
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => !locked && setOpen(v => !v)}
        className={`inline-flex items-center gap-1.5 rounded-full font-mono text-[9.5px] font-bold whitespace-nowrap ${sm ? 'px-2 py-0.5' : 'px-2.5 py-1.5'} ${c ? 'bg-ink text-paper border border-ink' : 'bg-paper text-ink-3 border border-dashed border-line-2'} ${locked ? 'cursor-default' : 'cursor-pointer'}`}
      >
        {c ? <><span className="w-[5px] h-[5px] rounded-full bg-gold" />{c.initials}</> : '+ ASSIGN'}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)}>
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em] text-ink-4 px-2.5 pt-1.5 pb-2">Assign to</div>
          {cooks.map(x => (
            <button key={x.id} onClick={() => { onAssign(x.id); setOpen(false) }} className={popItemCls(cookId === x.id)}>
              <span className="font-mono text-[10px] font-bold bg-bg-2 rounded px-1.5 py-0.5">{x.initials}</span>
              {x.name}
              <span className="ml-auto font-mono text-[9.5px] text-ink-4 font-medium">{x.homeStation ?? ''}</span>
            </button>
          ))}
          {cookId && <button onClick={() => { onAssign(null); setOpen(false) }} className={`${popItemCls(false)} !text-ink-3`}>Leave open</button>}
        </Popover>
      )}
    </div>
  )
}
```

- [ ] **Step 2: `PostDialog.tsx`** — port `PPPostDialog` (stats row: items / hands-on / first start; priority pills; per-station rows with assignee chips; unassigned warning; Keep editing / Post N items):

```tsx
'use client'
import { Zap, Check, AlertTriangle } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import type { PrepPriority } from '@/lib/prep-utils'
import { PLAN_PRIO_META, PLAN_PRIORITY_ORDER, effectivePriority } from '@/lib/prep-plan'
import { fmtClock, fmtMins } from '@/lib/prep-runsheet'

const activeOf = (i: PrepItemRich) => i.activeMinutes ?? i.estimatedPrepTime ?? 0

export function PostDialog({ draft, cooks, stations, reposting, onClose, onConfirm }: {
  draft: PrepItemRich[]; cooks: Cook[]; stations: string[]
  reposting: boolean; onClose: () => void; onConfirm: () => void
}) {
  const byPrio = PLAN_PRIORITY_ORDER
    .map(p => [p, draft.filter(t => effectivePriority(t) === p).length] as [PrepPriority, number])
    .filter(([, n]) => n > 0)
  const stationKeys = [...stations, 'Unassigned']
  const byStation = stationKeys
    .map(s => [s, draft.filter(t => (t.station ?? 'Unassigned') === s)] as [string, PrepItemRich[]])
    .filter(([, rows]) => rows.length > 0)
  const open = draft.filter(t => !t.assignedCook && !t.todayLog?.assignedTo).length
  const mins = draft.reduce((a, t) => a + activeOf(t), 0)
  const first = draft.filter(t => t.startByMinutes != null).sort((a, b) => a.startByMinutes! - b.startByMinutes!)[0]
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-3">
      <div onClick={onClose} className="absolute inset-0 bg-[rgba(9,9,11,0.45)]" />
      <div className="relative w-full max-w-[456px] max-h-[92vh] flex flex-col bg-paper rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2.5 px-5 pt-4 pb-3.5 border-b border-line">
          <span className="w-[30px] h-[30px] rounded-[9px] bg-ink grid place-items-center shrink-0"><Zap size={15} className="text-gold" /></span>
          <div>
            <div className="text-[16.5px] font-semibold tracking-[-0.02em]">{reposting ? 'Update the To Do list' : 'Post today’s prep list'}</div>
            <div className="font-mono text-[9.5px] font-medium uppercase tracking-[0.05em] text-ink-3">{reposting ? 'Replaces what the kitchen sees now' : 'Goes live on every cook’s To Do'}</div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 pt-4 pb-1">
          <div className="flex gap-2">
            {[['Items', String(draft.length)], ['Hands-on', fmtMins(mins)], ['First start', first?.startByMinutes != null ? fmtClock(first.startByMinutes) : '—']].map(([l, v]) => (
              <div key={l} className="flex-1 bg-bg border border-line rounded-[11px] px-3 py-2.5">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em] text-ink-3 mb-1">{l}</div>
                <div className="text-[20px] font-semibold tracking-[-0.03em] font-mono">{v}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {byPrio.map(([p, n]) => (
              <span key={p} className={`inline-flex items-center gap-1.5 ${PLAN_PRIO_META[p].softClass} ${PLAN_PRIO_META[p].textClass} rounded-full px-2.5 py-1 font-mono text-[10px] font-bold`}>
                <span className={`w-[5px] h-[5px] rounded-full ${PLAN_PRIO_META[p].dotClass}`} />{n} {PLAN_PRIO_META[p].label.toUpperCase()}
              </span>
            ))}
          </div>
          <div className="mt-3.5 border-t border-line pt-3">
            {byStation.map(([s, rows]) => (
              <div key={s} className="flex items-center gap-2 py-1.5">
                <span className="text-[12.5px] font-medium text-ink-2 w-[92px] truncate">{s}</span>
                <span className="font-mono text-[10.5px] text-ink-3 w-[58px]">{rows.length} items</span>
                <span className="font-mono text-[10.5px] text-ink-3 w-[52px]">{fmtMins(rows.reduce((a, r) => a + activeOf(r), 0))}</span>
                <span className="flex gap-1 ml-auto">
                  {[...new Set(rows.map(r => r.todayLog?.assignedTo ?? null))].map(id => {
                    const c = id ? cooks.find(x => x.id === id) : null
                    return <span key={id ?? 'open'} className={`font-mono text-[9px] font-bold rounded-full px-2 py-0.5 ${c ? 'bg-ink text-paper' : 'bg-paper text-ink-4 border border-dashed border-line-2'}`}>{c ? c.initials : 'OPEN'}</span>
                  })}
                </span>
              </div>
            ))}
          </div>
          {open > 0 && (
            <div className="flex items-center gap-2 bg-gold-soft border border-gold-soft rounded-[10px] px-3 py-2 mt-3">
              <AlertTriangle size={14} className="text-gold-2 shrink-0" />
              <span className="text-[12px] text-gold-2 font-medium"><b>{open}</b> item{open > 1 ? 's' : ''} unassigned — cooks can claim them from the run sheet.</span>
            </div>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2 px-5 py-4">
          <span className="flex-1" />
          <button onClick={onClose} className="px-3.5 py-2 rounded-[9px] border border-line-2 bg-paper text-ink-2 text-[12.5px] font-semibold">Keep editing</button>
          <button onClick={onConfirm} className="inline-flex items-center gap-2 bg-ink text-paper rounded-[10px] px-[18px] py-[11px] text-[13.5px] font-semibold">
            <Check size={14} className="text-gold" /> {reposting ? 'Update To Do' : `Post ${draft.length} items`}
          </button>
        </div>
      </div>
    </div>
  )
}
```

(Check `fmtClock`/`fmtMins` exports in `@/lib/prep-runsheet` first — the run sheet already imports them; reuse whatever the real names are.)

- [ ] **Step 3: Verify + commit** — `npm run build` green.

```bash
git add src/components/prep/planner
git commit -m "feat(prep): planner atoms — bucket heads, priority picker, assign pill, post dialog"
```

### Task 6: Desktop planner (`PlannerDesktop`) + page wiring

**Files:**
- Create: `src/components/prep/planner/SuggestionRow.tsx`
- Create: `src/components/prep/planner/DraftRow.tsx`
- Create: `src/components/prep/planner/PlannerDesktop.tsx`
- Modify: `src/app/prep/page.tsx` (desktop `smartprep` block; new plan state + handlers)

**Interfaces:**
- Consumes: Tasks 1, 4, 5. Existing page handlers: `handleToggleOnList`, `handlePriorityChange`, `openDrawer`, `cooks`, `stations`, `filteredSmart`.
- Produces page-level:
  - `plan: { post: PrepPostInfo | null } | null` + `loadPlan()` (fetched with `load()` and after post/recall)
  - `canPlan: boolean` — `role != null && atLeast(role, 'LEAD') && !isReadOnly`
  - `handleDraftEdit(item, patch: { requiredQty?: number; note?: string; assignedTo?: string | null })` — ensure-log + PUT (op-chained like `handleClaim`)
  - `handleAddToDraft(item)` — `handleToggleOnList(id, true)` + seed `requiredQty: suggestedDraftQty(item)`
  - `handleAcceptSuggested()`, `handleAddAllCritical()`, `handleClearDraft()`, `handleAssignStation(station, cookId)`
  - `handleReorder(orders: { prepItemId, listOrder }[])` — optimistic `todayLog.listOrder` patch + `PATCH /api/prep/plan/reorder`
  - `handlePost()` / `handleRecall()` — POST endpoints, then `setPlan`, toast, and `load(true)`
- `PlannerDesktop` props:

```ts
{
  items: PrepItemRich[]            // filteredSmart
  allItems: PrepItemRich[]         // unfiltered — draft pane must not hide rows on search
  stations: string[]
  cooks: Cook[]
  canPlan: boolean
  post: PrepPostInfo | null
  search: string; onSearch: (v: string) => void
  station: string; onStation: (v: string) => void
  onOpen: (item: PrepItemRich) => void
  onAdd: (item: PrepItemRich) => void
  onRemove: (item: PrepItemRich) => void
  onQty: (item: PrepItemRich, qty: number) => void
  onNote: (item: PrepItemRich, note: string) => void
  onAssign: (item: PrepItemRich, cookId: string | null) => void
  onAssignStation: (station: string, cookId: string) => void
  onPriorityChange: (id: string, prio: string) => void
  onReorder: (orders: Array<{ prepItemId: string; listOrder: number }>) => void
  onAcceptSuggested: () => void
  onAddAllCritical: () => void
  onClearDraft: () => void
  onPost: () => void
  onRecall: () => void
  tasksSlot?: React.ReactNode
}
```

- [ ] **Step 1: `SuggestionRow.tsx`** — port `PPSuggRow`: grid `[1fr_64px_72px_28px]`, left accent = priority color (muted when on list), name + short-ingredient warning (`AlertTriangle` when `ingredientShortCount`), meta line `{category} · {station} · {whyLabel(item)}`, on-hand/par fill bar (`Math.min(100, onHand/par*100)`, bar `PLAN_PRIO_META[p].barClass`), right-aligned mono suggestion (`suggestedDraftQty` > 0 ? qty : green `at par`), and the add/added button (dark `+` with gold icon → green `Check` when `isOnList`; disabled when `!canPlan`). Row opacity 0.6 + `bg-bg` when already on list. Clicking the name calls `onOpen(item)`.

- [ ] **Step 2: `DraftRow.tsx`** — port `PPDraftRow`: `GripVertical` drag handle (HTML5 `draggable={canPlan}`), name + `station` tag + BLOCKED pill (`item.isBlocked`), qty stepper (`draftQty(item)` ± `prepStep(item.unit)`, min one step; gold text when overridden vs suggestion), `PrioPicker`, `AssignPill` (from `todayLog?.assignedTo`), remove `X`; second line: note input (`defaultValue={item.todayLog?.note ?? ''}`, `onBlur` → `onNote`) + right mono meta `SUGG {q} ↺` reset button when overridden else `SMART QTY`, `· START {fmtClock(startByMinutes)} · {fmtMins(active)}` when available. Drag-over shows a top edge (`shadow-[0_-2px_0_#09090b]`); dropping on a row in a different bucket triggers the bucket-head warning instead of moving (state lives in `PlannerDesktop`).

- [ ] **Step 3: `PlannerDesktop.tsx`** — the split frame (`hidden md:grid grid-cols-[440px_1fr] gap-3.5`, both panes `bg-paper border border-line rounded-[14px] flex flex-col min-h-0` with a fixed height of `calc(100vh-*)` or `h-[820px]`):
  - **Left pane** header: gold-soft `Sparkles` chip, "Suggestions", mono sub `{items.length} ACTIVE PREP ITEMS · FROM PAR + LAST COUNT`, small search input (`search/onSearch`); station chip row (`all` + stations → `onStation`); bulk row: `Add all criticals · N` (`AlertTriangle`, disabled when 0 or `!canPlan`) + `Accept suggested qty` (`Sparkles`); scrollable body grouped by `effectivePriority` via `BucketHead` + `SuggestionRow`s.
  - **Right pane** header: dark `ChefHat` chip, "Prep list" + status pill (`DRAFT` dark / `POSTED` green-soft / `UNPOSTED CHANGES` dark) driven by `post`/`post.dirty`, mono sub `{draft.length} ITEMS · {fmtMins(mins)} HANDS-ON · {open} UNASSIGNED`; `Assign a station` popover (stations → first cook whose `homeStation` matches; row disabled when no cook or no draft rows for it); `Clear`. Body: empty-state (`Package` icon, "Nothing on today's list yet / ADD FROM SUGGESTIONS ON THE LEFT") or buckets of `DraftRow`s sorted by `todayLog?.listOrder ?? 9999` then name. Drag state (`drag`, `over`, `warn`) lives here; a successful drop rebuilds the bucket's id list and calls `onReorder(list.map((id, i) => ({ prepItemId: id, listOrder: i })))`.
  - **Footer**: `!canPlan` → lock note "Cooks claim, start and finish. Adding, removing and re-prioritising is the chef's."; `post && !post.dirty` → green `Live on To Do` + mono `POSTED {time} BY {name} · {n} ITEMS` + `Recall to draft` (`Undo2`); else → left text ("Cooks see nothing until you post" / "The kitchen is still on the last posted version") + dark CTA `Review & post to To Do` / `Update To Do` (`Zap`, gold icon; disabled when draft empty).
  - Draft membership derives from `allItems.filter(i => i.isOnList)` — search/station filters only shape the left pane.
  - `PostDialog` renders here (state `dlg`), `onConfirm` → `onPost()`.

- [ ] **Step 4: Page wiring** in `src/app/prep/page.tsx`:
  - Imports: `useUser` from `@/contexts/UserContext`, `atLeast` from `@/lib/roles`, `applyStatusToItem` (already), `suggestedDraftQty`, `draftQty` from `@/lib/prep-plan`, `PlannerDesktop`, `PrepPostInfo`.
  - State: `const [plan, setPlan] = useState<{ post: PrepPostInfo | null }>({ post: null })`; `loadPlan = useCallback(async () => { if (!activeRcId) { setPlan({ post: null }); return } const r = await fetch(\`/api/prep/plan?rcId=${activeRcId}\`); if (r.ok) setPlan(await r.json()) }, [activeRcId])`; call in the mount effect and inside the 60 s poll.
  - `const { role } = useUser(); const canPlan = role != null && atLeast(role, 'LEAD') && !isReadOnly && !!activeRcId`
  - `handleDraftEdit(item, patch)`: mirrors `handleClaim`'s ensure-log + op-chain, PUT body = patch (bump `mutationSeq`, optimistic `todayLog` merge; seed the log optimistically exactly like `handleClaim` does).
  - `handleAddToDraft(item)`: optimistic `isOnList: true`; PUT `{ isOnList: true }`; then `handleDraftEdit(item, { requiredQty: suggestedDraftQty(item) })` **only when the log has no requiredQty yet**.
  - `handleAcceptSuggested()`: for each draft item where `suggestedDraftQty > 0` → `handleDraftEdit(item, { requiredQty: suggestedDraftQty(item) })`.
  - `handleAddAllCritical()`: `items.filter(i => effectivePriority(i) === '911' && !i.isOnList).forEach(handleAddToDraft)`.
  - `handleClearDraft()`: optimistic all `isOnList: false` + parallel PUTs (mirror `handleAddAll`).
  - `handleAssignStation(station, cookId)`: draft items with that station → `handleDraftEdit(item, { assignedTo: cookId })`.
  - `handleReorder(orders)`: optimistic `todayLog.listOrder` patch; `fetch('/api/prep/plan/reorder', { method: 'PATCH', body: JSON.stringify({ revenueCenterId: activeRcId, orders }) })`.
  - `handlePost()`: `POST /api/prep/plan/post { revenueCenterId: activeRcId }` → on ok `setPlan({ post: json.post })`, `toast('Posted to To Do')`, `load(true)`; on error surface `setActionError`.
  - `handleRecall()`: `POST /api/prep/plan/recall` → `setPlan({ post: null })`, `load(true)`.
  - Replace the desktop smartprep block (`<PrepSummaryLine>` + `<PrepBoard …>` + toolbar, page.tsx ~1438–1485) with `<PlannerDesktop …>` passing the props above and `tasksSlot={<PrepTaskLibrary asBlock … />}` (rendered above the split, preserving the checklist).
- [ ] **Step 5: Verify in the browser** — build green first, then on `/prep` → Smart prep (desktop width): suggestions bucketed with live priorities and "why" lines; add → row moves right with seeded qty; qty stepper, note, assignee, override picker persist across reload; post dialog totals correct; post → footer flips to "Live on To Do"; edit a qty → `UNPOSTED CHANGES`; recall works. As STAFF (or with `canPlan` forced false) everything is read-only.

- [ ] **Step 6: Commit**

```bash
git add src/components/prep/planner src/app/prep/page.tsx
git commit -m "feat(prep): desktop Smart Prep planner — suggestions → draft list → post"
```

### Task 7: Mobile planner (`PlannerMobile`)

**Files:**
- Create: `src/components/prep/planner/PlannerMobile.tsx`
- Modify: `src/app/prep/page.tsx` (mobile `smartprep` block)

**Interfaces:**
- Consumes: same props as `PlannerDesktop` (minus `tasksSlot`; plus nothing new).
- Produces: mobile Smart Prep surface replacing `SmartPrepCard` lists.

- [ ] **Step 1: `PlannerMobile.tsx`** — port `planner-mobile.jsx`:
  - Header strip: status pill (`DRAFT`/`POSTED`/`CHANGES`) — the page's existing mobile header stays; this component starts below the tab bar.
  - Summary card (dark `bg-ink text-paper rounded-[13px]`): `{draft.length} on the list · {fmtMins(mins)} hands-on` + `{open} unassigned` (gold when > 0). (No covers forecast.)
  - Segmented tabs `Prep list · {n}` / `Suggestions · {m}` (reuse `Segmented` from `@/components/prep/runsheet/atoms` if its API fits — `{ id, label, badge }` — else a local two-button pill).
  - Suggestions tab: bulk buttons row; `View by Priority | Category` toggle; groups → `SuggestionRow` (the desktop row works at mobile width — reuse it; category view shows per-category header with mini priority-count dots).
  - Prep list tab: buckets of a mobile draft card — same content as `DraftRow` but stacked: title row (name + BLOCKED + remove X), meta line (`station · START hh:mm`), controls row (qty stepper, `PrioPicker`, spacer, `AssignPill`), full-width note input, and **up/down arrow buttons** instead of drag (first/last disabled; `onMove(dir)` swaps within the bucket and emits the same `onReorder` payload).
  - Sticky post bar (`sticky bottom-2 z-30 mt-3`): `!canPlan` → mono lock note `CHEF POSTS THE LIST`; posted+clean → compact "Live on To Do · POSTED {t} · {n} ITEMS" + `Recall`; else full-width dark CTA `Review & post · {n}` / `Update To Do · {n}` opening `PostDialog`.
- [ ] **Step 2: Page wiring** — replace the mobile smartprep block (the `smartPrepView` urgency/category/station JSX, page.tsx ~1543–1799) with `<PlannerMobile …/>`, keeping `<PrepTaskLibrary …/>` above it. Delete the now-unused `SmartPrepCard` component, the `smartPrepView`/`priorityMenuFor`/`lookingGoodOpen` state, `spCategoryGroups`/`spStationGroups`, and the mobile smartprep toolbar (search/filter collapse stays — pass `search` through to the planner; remove the category filter UI if now unused or keep `filterCategory` wired into `filteredSmart` and expose only search + station in the planner).
- [ ] **Step 3: Verify in the browser** at mobile width (390px): tabs switch, add/remove, arrows reorder within bucket, sticky bar posts, cook view locked.

- [ ] **Step 4: Commit**

```bash
git add src/components/prep/planner/PlannerMobile.tsx src/app/prep/page.tsx
git commit -m "feat(prep): mobile Smart Prep planner — tabs, arrow reorder, sticky post bar"
```

---

# Phase 4 — To Do runs off the posted list

### Task 8: Posted membership + provenance band + empty state

**Files:**
- Create: `src/components/prep/runsheet/PostedBand.tsx`
- Modify: `src/app/prep/page.tsx` (`todayItems` membership; render band + empty state)
- Modify: `src/components/prep/runsheet/RunSheetMobile.tsx` (accept `bandSlot?: React.ReactNode` if its layout needs the band inside — otherwise render band at page level above both run sheets and skip this file)

**Interfaces:**
- Consumes: `plan.post` (Task 6), `PrepPostInfo`.
- Produces: `PostedBand({ post, dirty })`; To Do membership = `todayLog.postedAt != null || done/partial today`.

- [ ] **Step 1: `PostedBand.tsx`**

```tsx
'use client'
import { Check } from 'lucide-react'
import type { PrepPostInfo } from '@/components/prep/types'
import { fmtMins } from '@/lib/prep-runsheet'

export function PostedBand({ post }: { post: PrepPostInfo }) {
  const t = new Date(post.postedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return (
    <div className="flex items-center gap-2.5 bg-ink text-paper rounded-xl px-4 py-2.5 mb-2.5">
      <span className="w-6 h-6 rounded-[7px] bg-ink-2 grid place-items-center shrink-0"><Check size={13} className="text-green" /></span>
      <span className="text-[13px] font-semibold">Posted list</span>
      <span className="font-mono text-[10px] text-ink-4 truncate">{t} · {post.postedByName} · {post.itemCount} items · {fmtMins(post.activeMinutes)} hands-on</span>
      <span className="flex-1" />
      {post.dirty && <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.05em] bg-gold-soft text-gold-2 px-2 py-0.5 rounded-full whitespace-nowrap">Chef has unposted changes</span>}
    </div>
  )
}
```

- [ ] **Step 2: Switch To Do membership** in page.tsx:

```ts
  // The kitchen works off the POSTED list — a draft add reaches To Do only when
  // the chef posts. Completed items stay visible for the shift regardless.
  const todayItems = useMemo(() =>
    items.filter(i =>
      i.todayLog?.postedAt != null ||
      i.todayLog?.status === 'DONE' || i.todayLog?.status === 'PARTIAL'
    ),
  [items])
```

`priorityAlerts` keeps its `isOnList` predicate → change to `i.todayLog?.postedAt != null` (an alert about a non-posted item is noise).

- [ ] **Step 3: Render the band + empty state.** In both `viewMode === 'today'` blocks (desktop ~1390 and mobile ~1487): when `activeRcId && plan.post` render `<PostedBand post={plan.post} />` above the run sheet. When `!loading && todayItems.length === 0`: if `plan.post == null && activeRcId` render the design's locked empty state (dashed border panel, `Lock` icon, "Nothing posted yet", mono "THE KITCHEN'S TO DO STAYS EMPTY UNTIL THE CHEF POSTS THE LIST", plus — when `canPlan` — a button jumping to the Smart prep tab); else keep the existing empty-state.
- [ ] **Step 4: Verify in the browser** — recall → To Do shows "Nothing posted yet"; post 3 items → they appear with the band; complete one → stays in Done section; draft-edit a qty → band shows "CHEF HAS UNPOSTED CHANGES"; re-post → pill clears and membership updates (a removed item leaves the kitchen list only on re-post).
- [ ] **Step 5: Commit**

```bash
git add src/components/prep/runsheet/PostedBand.tsx src/app/prep/page.tsx src/components/prep/runsheet/RunSheetMobile.tsx
git commit -m "feat(prep): To Do runs off the posted list — provenance band, dirty pill, locked empty state"
```

---

# Phase 5 — Cleanup, verification, docs

### Task 9: Retire dead board code, full verify, docs

**Files:**
- Delete (only if truly unreferenced after Tasks 6–7 — grep first): `src/components/prep/board/PrepBoard.tsx`, `PrepBlock.tsx`, `PrepRow.tsx`, `PrepLater.tsx`, `PrepSummaryLine.tsx` (keep `PrepBoardDrawer.tsx` + `prep-board-utils.ts` if the drawer still imports it)
- Modify: `CLAUDE.md` (prep section — planner + post flow, `/api/prep/plan/*`)
- Modify: `docs/superpowers/plans/2026-08-13-smart-prep-v2.md` (check boxes)

- [ ] **Step 1:** `grep -rn "PrepBoard\b\|PrepSummaryLine\|SmartPrepCard" src/` — delete only files with zero remaining imports; `PrepBoardDrawer` stays (both drawers still mount).
- [ ] **Step 2:** `npm test` → green (all suites, not just prep-plan).
- [ ] **Step 3:** `npm run build` in the detached build worktree → green; check `/api/prep/plan*` routes all show `ƒ (Dynamic)`.
- [ ] **Step 4:** Full browser pass (desktop + 390px mobile): the Task 2 bug scenario, the Task 6/7/8 flows, History tab untouched, offline banner still renders, item drawer opens from both tabs.
- [ ] **Step 5:** Update `CLAUDE.md`: in the prep bullets describe Smart Prep planner (draft → post → To Do), `PrepPost`/`postedAt` model, LEAD gate, and add `/api/prep/plan` to the page→API map row for `/prep`.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(prep): Smart Prep v2 — cleanup, docs"
```

---

## Out of scope (explicitly)

- **Covers forecast band** (`PT_FORECAST`) — no forecast model exists; service-status band remains.
- **Per-service demand scaling** of suggestions (`ptSvcIndex`) — same reason.
- **Multi-day planning** — the plan is always "today" (matches `PrepLog` day convention).
- **Offline support for planner writes** — draft edits/post are online-only (the existing status/priority/isOnList queue keeps working).
- **The design's `PTEditItem` modal** — the app's `PrepItemForm` already covers item editing.

## Self-review notes

- Spec coverage: suggestions pane (Task 6 Step 1), draft pane with qty/prio/assign/note/reorder (6 Steps 2–3, 7), bulk actions (6 Step 4), post dialog (5 Step 2), post/recall/dirty (4, 6), posted To Do + band + empty state (8), cook lock (5–8 via `canPlan` + LEAD gates), stale-pill fix (1–2). Forecast band consciously dropped (out of scope).
- Type consistency: `PrepPostInfo` defined once in `types.ts` (Task 3), consumed in 4/6/8; `effectivePriority`/`draftQty`/`suggestedDraftQty` defined in Task 1 and used in 5–8; reorder payload `{ prepItemId, listOrder }` identical in Task 4 Step 5 and Task 6 wiring.
- Verified against the tree: `useUser` (`src/contexts/UserContext.tsx`), `atLeast` (`src/lib/roles.ts`), `assertRcWritable`/`resolveScopedRcIds` (`src/lib/rc-scope`), `resolveActive`/`startByMinutes` (`src/lib/prep-runsheet`), `requireSession(minRole)` with `LEAD` rank 1 — all exist. `PrepLog.requiredQty/note/assignedTo` already exist; only `listOrder`/`postedAt` are new.
