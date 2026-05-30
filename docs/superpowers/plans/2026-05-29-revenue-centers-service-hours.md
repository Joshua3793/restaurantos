# Revenue Centers — Service Hours & Timing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each revenue center its own per-day service hours, scheduling mode, and prep lead; wire those into the preshift "to service" countdown and the prep deadline; and redesign the Revenue Centers setup page with the mockup's KPI strip, per-card running food cost %, and spend-allocation rail.

**Architecture:** Three new fields on `RevenueCenter` (`schedulingMode`, `prepLeadMinutes`, `serviceSchedule` JSON). A new pure helper lib `src/lib/service-hours.ts` computes the next service window / prep deadline from a center. A new `/api/insights/revenue-centers` endpoint returns per-center WTD spend, running food cost %, and item counts (reusing the cost-chrome computation, grouped by center). The setup page, preshift, and prep all read these.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Tailwind. **No test suite** — `npm run build` is the type-check + correctness gate (per CLAUDE.md). Each task verifies with `npm run build` plus targeted manual checks, then commits.

**Spec:** [docs/superpowers/specs/2026-05-29-revenue-centers-service-hours-design.md](../specs/2026-05-29-revenue-centers-service-hours-design.md)

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add 3 fields to `RevenueCenter` |
| `src/lib/service-hours.ts` | Create | Pure next-window / prep-deadline / formatting helpers + shared types |
| `src/contexts/RevenueCenterContext.tsx` | Modify | Extend `RevenueCenter` interface |
| `src/app/api/revenue-centers/route.ts` | Modify | Validate + persist new fields on POST |
| `src/app/api/revenue-centers/[id]/route.ts` | Modify | Validate + persist new fields on PATCH |
| `src/lib/rc-schedule.ts` | Create | Shared server-side validation/normalization for `serviceSchedule` + mode + prep lead |
| `src/app/api/insights/revenue-centers/route.ts` | Create | Per-center WTD spend, running food cost %, item count, totals |
| `src/app/setup/revenue-centers/page.tsx` | Modify | Redesign: form scheduling section, card service row + running %, KPI strip, rail, 2-col layout, data fetch |
| `src/app/preshift/page.tsx` | Modify | Replace hardcoded `nextServiceCutoff` with active-RC `nextServiceStart` |
| `src/app/prep/page.tsx` | Modify | Add prep-deadline banner from active-RC `prepDeadline` |

---

## Task 1: Schema — add service-hours fields to RevenueCenter

**Files:**
- Modify: `prisma/schema.prisma` (model `RevenueCenter`, lines 483–505)

- [ ] **Step 1: Add the three fields**

In `model RevenueCenter`, after the `type` field (line ~494), add:

```prisma
  schedulingMode    String            @default("FIXED")
  prepLeadMinutes   Int?
  serviceSchedule   Json?
```

- [ ] **Step 2: Create + apply the migration**

Run: `npx prisma migrate dev --name rc_service_hours`
Expected: migration created and applied; `npx prisma generate` runs automatically. No data loss (all new columns nullable / defaulted).

- [ ] **Step 3: Verify the client picks up the fields**

Run: `npm run build`
Expected: build succeeds; `RevenueCenter` Prisma type now includes `schedulingMode`, `prepLeadMinutes`, `serviceSchedule`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(rc): add schedulingMode, prepLeadMinutes, serviceSchedule to RevenueCenter"
```

---

## Task 2: `src/lib/service-hours.ts` — the next-window / prep-deadline brain

**Files:**
- Create: `src/lib/service-hours.ts`

Day index convention: **0 = Monday … 6 = Sunday**. JS `Date.getDay()` is 0=Sunday, so convert with `(getDay() + 6) % 7`.

- [ ] **Step 1: Write the full module**

```ts
// src/lib/service-hours.ts
// Pure helpers — no DB. Compute the next service window and prep deadline for a
// revenue center from its weekly service schedule. Day index: 0=Mon … 6=Sun.

export type ServiceWindow = { label: string; start: string; end: string } // start/end = "HH:MM"
export type ServiceSchedule = Record<string, ServiceWindow[]>             // keys "0".."6"

/** Minimal shape this lib needs from a revenue center. */
export interface SchedulableRc {
  schedulingMode: string                 // "FIXED" | "ON_DEMAND"
  prepLeadMinutes: number | null
  serviceSchedule: ServiceSchedule | null
}

/** Our Monday-first day index for a Date (0=Mon … 6=Sun). */
export function dayIndex(d: Date): number {
  return (d.getDay() + 6) % 7
}

function parseHM(hm: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!match) return null
  const h = Number(match[1]); const m = Number(match[2])
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return { h, m }
}

/** Windows for a given Monday-first day index, sorted by start time. */
function windowsForDay(rc: SchedulableRc, idx: number): ServiceWindow[] {
  const list = rc.serviceSchedule?.[String(idx)] ?? []
  return [...list].sort((a, b) => a.start.localeCompare(b.start))
}

function atTime(base: Date, hm: string): Date | null {
  const p = parseHM(hm)
  if (!p) return null
  const out = new Date(base)
  out.setHours(p.h, p.m, 0, 0)
  return out
}

/**
 * Next service window START strictly after `now`. Scans today's remaining
 * windows, then following days, wrapping up to 7 days. null for ON_DEMAND,
 * no schedule, or an entirely empty week.
 */
export function nextServiceStart(rc: SchedulableRc, now: Date): { start: Date; label: string } | null {
  if (rc.schedulingMode !== 'FIXED' || !rc.serviceSchedule) return null
  for (let offset = 0; offset < 7; offset++) {
    const day = new Date(now)
    day.setDate(now.getDate() + offset)
    const idx = dayIndex(day)
    for (const w of windowsForDay(rc, idx)) {
      const start = atTime(day, w.start)
      if (start && start.getTime() > now.getTime()) {
        return { start, label: w.label }
      }
    }
  }
  return null
}

/**
 * The window in progress right now (start <= now < end), if any. Windows whose
 * end <= start are treated as crossing midnight (end on the next day).
 */
export function currentWindow(rc: SchedulableRc, now: Date): { window: ServiceWindow; end: Date } | null {
  if (rc.schedulingMode !== 'FIXED' || !rc.serviceSchedule) return null
  // Check today and yesterday (a window started yesterday may still be running past midnight).
  for (let offset = -1; offset <= 0; offset++) {
    const day = new Date(now)
    day.setDate(now.getDate() + offset)
    const idx = dayIndex(day)
    for (const w of windowsForDay(rc, idx)) {
      const start = atTime(day, w.start)
      let end = atTime(day, w.end)
      if (!start || !end) continue
      if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 24 * 3_600_000)
      if (start.getTime() <= now.getTime() && now.getTime() < end.getTime()) {
        return { window: w, end }
      }
    }
  }
  return null
}

/** nextServiceStart minus the center's prep lead. null if no upcoming start. */
export function prepDeadline(rc: SchedulableRc, now: Date): Date | null {
  const next = nextServiceStart(rc, now)
  if (!next) return null
  const lead = rc.prepLeadMinutes ?? 0
  return new Date(next.start.getTime() - lead * 60_000)
}

/** "2h 30m", "45m", "1d 2h". Clamps negatives to "0m". */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return '0m'
  const totalMin = Math.floor(ms / 60_000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function fmtWindow(w: ServiceWindow): string {
  return `${w.start}–${w.end}`
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: build succeeds (module compiles, unused-by-anyone yet is fine — it's imported next tasks).

- [ ] **Step 3: Commit**

```bash
git add src/lib/service-hours.ts
git commit -m "feat(rc): add service-hours helpers (next window, prep deadline, formatting)"
```

---

## Task 3: Extend the RevenueCenter context interface

**Files:**
- Modify: `src/contexts/RevenueCenterContext.tsx` (interface `RevenueCenter`, lines 4–16)

- [ ] **Step 1: Add the new fields + import the schedule type**

At the top of the file, add the import (line ~2):

```ts
import type { ServiceSchedule } from '@/lib/service-hours'
```

In the `RevenueCenter` interface, after `notes: string | null` (line ~14), add:

```ts
  schedulingMode: string                       // "FIXED" | "ON_DEMAND"
  prepLeadMinutes: number | null
  serviceSchedule: ServiceSchedule | null      // Prisma Json → real object (not a string)
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/contexts/RevenueCenterContext.tsx
git commit -m "feat(rc): expose service-hours fields on RevenueCenter context type"
```

---

## Task 4: Shared schedule validation — `src/lib/rc-schedule.ts`

**Files:**
- Create: `src/lib/rc-schedule.ts`

This normalizes/validates the three new fields from a request body. Used by both POST and PATCH so the rules live in one place.

- [ ] **Step 1: Write the module**

```ts
// src/lib/rc-schedule.ts
// Server-side validation + normalization for revenue-center scheduling fields.
import type { ServiceSchedule, ServiceWindow } from '@/lib/service-hours'

export const SCHEDULING_MODES = ['FIXED', 'ON_DEMAND'] as const

const HM_RE = /^(\d{1,2}):(\d{2})$/

function validHM(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const m = HM_RE.exec(s.trim())
  if (!m) return false
  const h = Number(m[1]); const min = Number(m[2])
  return h >= 0 && h <= 23 && min >= 0 && min <= 59
}

function normalizeWindow(raw: unknown): ServiceWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const label = typeof w.label === 'string' ? w.label.trim() : ''
  if (!label) return null
  if (!validHM(w.start) || !validHM(w.end)) return null
  return { label, start: (w.start as string).trim(), end: (w.end as string).trim() }
}

/**
 * Returns a clean ServiceSchedule (keys "0".."6", windows sorted by start) or
 * null. Drops invalid windows and empty days. Throws Error('bad-schedule') only
 * on a non-object top-level value.
 */
export function normalizeSchedule(raw: unknown): ServiceSchedule | null {
  if (raw == null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad-schedule')
  const out: ServiceSchedule = {}
  for (let idx = 0; idx < 7; idx++) {
    const key = String(idx)
    const dayRaw = (raw as Record<string, unknown>)[key]
    if (!Array.isArray(dayRaw)) continue
    const windows = dayRaw.map(normalizeWindow).filter((w): w is ServiceWindow => w !== null)
    windows.sort((a, b) => a.start.localeCompare(b.start))
    if (windows.length) out[key] = windows
  }
  return Object.keys(out).length ? out : null
}

export function normalizeMode(raw: unknown): 'FIXED' | 'ON_DEMAND' {
  return raw === 'ON_DEMAND' ? 'ON_DEMAND' : 'FIXED'
}

export function normalizePrepLead(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}

/**
 * Build the persistable subset of scheduling fields from a request body.
 * `mode` ON_DEMAND forces serviceSchedule to null.
 */
export function buildScheduleFields(body: Record<string, unknown>): {
  schedulingMode: 'FIXED' | 'ON_DEMAND'
  prepLeadMinutes: number | null
  serviceSchedule: ServiceSchedule | null
} {
  const schedulingMode = normalizeMode(body.schedulingMode)
  const prepLeadMinutes = normalizePrepLead(body.prepLeadMinutes)
  const serviceSchedule = schedulingMode === 'ON_DEMAND'
    ? null
    : normalizeSchedule(body.serviceSchedule)
  return { schedulingMode, prepLeadMinutes, serviceSchedule }
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/lib/rc-schedule.ts
git commit -m "feat(rc): shared validation for scheduling mode, prep lead, service schedule"
```

---

## Task 5: Persist new fields on POST (create)

**Files:**
- Modify: `src/app/api/revenue-centers/route.ts`

- [ ] **Step 1: Import the builder + apply it in POST**

Add the import near the top (after the `RC_COLORS` import, line ~3):

```ts
import { buildScheduleFields } from '@/lib/rc-schedule'
```

In `POST`, after `const resolvedType = ...` (line ~29), add:

```ts
  let scheduleFields
  try { scheduleFields = buildScheduleFields(body) }
  catch { return NextResponse.json({ error: 'Invalid service schedule' }, { status: 400 }) }
```

Then inside `tx.revenueCenter.create({ data: { ... } })`, after the `notes:` line (line ~45), add:

```ts
        schedulingMode:  scheduleFields.schedulingMode,
        prepLeadMinutes: scheduleFields.prepLeadMinutes,
        serviceSchedule: scheduleFields.serviceSchedule ?? undefined,
```

> Note: `serviceSchedule ?? undefined` — Prisma `Json?` writes `null` for `Prisma.JsonNull`, but passing `undefined` leaves it unset (defaults to NULL on create), which is what we want.

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Manual smoke (optional, if dev server up)**

`POST /api/revenue-centers` with body `{"name":"Test","schedulingMode":"FIXED","prepLeadMinutes":150,"serviceSchedule":{"0":[{"label":"Lunch","start":"11:30","end":"15:00"}]}}` → 201 with the fields echoed back.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/revenue-centers/route.ts
git commit -m "feat(rc): persist scheduling fields on create"
```

---

## Task 6: Persist new fields on PATCH (edit)

**Files:**
- Modify: `src/app/api/revenue-centers/[id]/route.ts`

- [ ] **Step 1: Import the builder + apply it in PATCH**

Add the import (after `RC_COLORS`, line ~3):

```ts
import { buildScheduleFields } from '@/lib/rc-schedule'
import { Prisma } from '@prisma/client'
```

In `PATCH`, the scheduling fields should only be written when the client actually sends them. After the `resolvedType` block (line ~25), add:

```ts
  const sendsSchedule = 'schedulingMode' in body || 'prepLeadMinutes' in body || 'serviceSchedule' in body
  let scheduleFields: ReturnType<typeof buildScheduleFields> | null = null
  if (sendsSchedule) {
    try { scheduleFields = buildScheduleFields(body) }
    catch { return NextResponse.json({ error: 'Invalid service schedule' }, { status: 400 }) }
  }
```

Inside `tx.revenueCenter.update({ ... data: { ... } })`, after the `notes` spread line (line ~42), add:

```ts
        ...(scheduleFields ? {
          schedulingMode:  scheduleFields.schedulingMode,
          prepLeadMinutes: scheduleFields.prepLeadMinutes,
          serviceSchedule: scheduleFields.serviceSchedule ?? Prisma.JsonNull,
        } : {}),
```

> On update we use `Prisma.JsonNull` (not `undefined`) so that switching a center to ON_DEMAND, or clearing its schedule, actually writes NULL rather than leaving the old schedule in place.

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/revenue-centers/[id]/route.ts
git commit -m "feat(rc): persist scheduling fields on edit"
```

---

## Task 7: Per-center insights endpoint

**Files:**
- Create: `src/app/api/insights/revenue-centers/route.ts`

Reuses the exact WTD computation from [cost-chrome](../../../src/app/api/insights/cost-chrome/route.ts) (Monday week start; food sales = Σ `totalRevenue × foodSalesPct`; spend = Σ approved `invoiceScanItem.rawLineTotal` by `session.revenueCenterId`), grouped by center.

- [ ] **Step 1: Write the route**

```ts
// src/app/api/insights/revenue-centers/route.ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/insights/revenue-centers
 * Per-center week-to-date spend, running food cost %, and item count, plus
 * roll-up totals for the KPI strip. Mirrors cost-chrome's WTD math, grouped by RC.
 */
export async function GET() {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const weekStart = startOfWeek(new Date())

  const [rcs, sales, scanItems, allocCounts] = await Promise.all([
    prisma.revenueCenter.findMany({ select: { id: true, isActive: true, targetFoodCostPct: true } }),
    prisma.salesEntry.findMany({
      where: { date: { gte: weekStart } },
      select: { revenueCenterId: true, totalRevenue: true, foodSalesPct: true },
    }),
    prisma.invoiceScanItem.findMany({
      where: { approved: true, session: { approvedAt: { gte: weekStart } } },
      select: { rawLineTotal: true, session: { select: { revenueCenterId: true } } },
    }),
    prisma.stockAllocation.groupBy({ by: ['revenueCenterId'], _count: { _all: true } }),
  ])

  // Σ food sales per RC
  const foodSalesByRc = new Map<string, number>()
  for (const s of sales) {
    if (!s.revenueCenterId) continue
    const add = Number(s.totalRevenue) * Number(s.foodSalesPct)
    foodSalesByRc.set(s.revenueCenterId, (foodSalesByRc.get(s.revenueCenterId) ?? 0) + add)
  }

  // Σ approved spend per RC (by the session's RC, matching cost-chrome)
  const spendByRc = new Map<string, number>()
  for (const it of scanItems) {
    const rcId = it.session?.revenueCenterId
    if (!rcId) continue
    spendByRc.set(rcId, (spendByRc.get(rcId) ?? 0) + Number(it.rawLineTotal ?? 0))
  }

  const itemCountByRc = new Map<string, number>()
  for (const a of allocCounts) itemCountByRc.set(a.revenueCenterId, a._count._all)

  const centers: Record<string, { spendWTD: number; runningFoodCostPct: number | null; itemCount: number }> = {}
  for (const rc of rcs) {
    const spendWTD = spendByRc.get(rc.id) ?? 0
    const foodSales = foodSalesByRc.get(rc.id) ?? 0
    centers[rc.id] = {
      spendWTD,
      runningFoodCostPct: foodSales > 0 ? (spendWTD / foodSales) * 100 : null,
      itemCount: itemCountByRc.get(rc.id) ?? 0,
    }
  }

  // Totals
  const activeCenters = rcs.filter(rc => rc.isActive)
  const activeCount = activeCenters.length
  const totalCount = rcs.length
  const allocatedWTD = rcs.reduce((sum, rc) => sum + (centers[rc.id]?.spendWTD ?? 0), 0)

  // Spend-weighted blended target over active centers that have a target.
  const withTarget = activeCenters.filter(rc => rc.targetFoodCostPct != null)
  let blendedTargetPct: number | null = null
  if (withTarget.length) {
    const weightSum = withTarget.reduce((s, rc) => s + (centers[rc.id]?.spendWTD ?? 0), 0)
    if (weightSum > 0) {
      blendedTargetPct = withTarget.reduce(
        (s, rc) => s + Number(rc.targetFoodCostPct) * (centers[rc.id]?.spendWTD ?? 0), 0,
      ) / weightSum
    } else {
      // No spend yet — fall back to a simple average.
      blendedTargetPct = withTarget.reduce((s, rc) => s + Number(rc.targetFoodCostPct), 0) / withTarget.length
    }
  }

  return NextResponse.json(
    { centers, totals: { activeCount, totalCount, blendedTargetPct, allocatedWTD } },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

function startOfWeek(d: Date): Date {
  // Monday as week start. Returns local 00:00 of that Monday.
  const out = new Date(d)
  const day = out.getDay() || 7 // Sun = 0 → 7
  if (day !== 1) out.setHours(-24 * (day - 1))
  out.setHours(0, 0, 0, 0)
  return out
}
```

- [ ] **Step 2: Type-check + confirm dynamic**

Run: `npm run build`
Expected: build succeeds; in the route list, `/api/insights/revenue-centers` shows `ƒ (Dynamic)`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/insights/revenue-centers/route.ts
git commit -m "feat(rc): per-center insights endpoint (WTD spend, running %, item count, totals)"
```

---

## Task 8: Page — form state + the weekly schedule editor

**Files:**
- Modify: `src/app/setup/revenue-centers/page.tsx`

This task only touches the form's data model + a new `ServiceScheduleEditor` sub-component (defined at module scope per CLAUDE.md). Card/KPI/rail come in later tasks.

- [ ] **Step 1: Add imports + day labels + types**

At the top of the file, extend the lucide import (line 3) to include `Clock`, `Copy`, `X`, and import the schedule types + formatters:

```ts
import { Plus, Pencil, Trash2, Star, User, Target, ChevronDown, ChevronUp, Clock, Copy, X } from 'lucide-react'
import type { ServiceSchedule, ServiceWindow } from '@/lib/service-hours'
```

After `RC_TYPES` (line ~13), add:

```ts
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const EMPTY_WINDOW: ServiceWindow = { label: '', start: '17:00', end: '22:00' }
```

- [ ] **Step 2: Extend `RcFormData` + `EMPTY_FORM`**

Replace the `RcFormData` interface (lines 15–25) with:

```ts
interface RcFormData {
  name: string
  color: string
  isDefault: boolean
  isActive: boolean
  type: string
  description: string
  managerName: string
  targetFoodCostPct: string
  notes: string
  schedulingMode: 'FIXED' | 'ON_DEMAND'
  prepLeadH: string          // hours portion of prep lead (UI)
  prepLeadM: string          // minutes portion of prep lead (UI)
  schedule: ServiceSchedule  // working copy, keys "0".."6"
}
```

Replace `EMPTY_FORM` (lines 27–30) with:

```ts
const EMPTY_FORM: RcFormData = {
  name: '', color: 'blue', isDefault: false, isActive: true,
  type: 'other', description: '', managerName: '', targetFoodCostPct: '', notes: '',
  schedulingMode: 'FIXED', prepLeadH: '', prepLeadM: '', schedule: {},
}
```

- [ ] **Step 3: Initialize form state from an existing center**

In `RcFormModal`, replace the `useState<RcFormData>(initial ? {...} : EMPTY_FORM)` initializer (lines 41–55) so the mapped object also seeds the new fields:

```ts
  const [form, setForm] = useState<RcFormData>(
    initial
      ? {
          name:              initial.name,
          color:             initial.color,
          isDefault:         initial.isDefault,
          isActive:          initial.isActive,
          type:              initial.type || 'other',
          description:       initial.description       ?? '',
          managerName:       initial.managerName       ?? '',
          targetFoodCostPct: initial.targetFoodCostPct != null ? String(parseFloat(initial.targetFoodCostPct)) : '',
          notes:             initial.notes             ?? '',
          schedulingMode:    (initial.schedulingMode === 'ON_DEMAND' ? 'ON_DEMAND' : 'FIXED'),
          prepLeadH:         initial.prepLeadMinutes != null ? String(Math.floor(initial.prepLeadMinutes / 60)) : '',
          prepLeadM:         initial.prepLeadMinutes != null ? String(initial.prepLeadMinutes % 60) : '',
          schedule:          initial.serviceSchedule ?? {},
        }
      : EMPTY_FORM
  )
```

- [ ] **Step 4: Add the `ServiceScheduleEditor` component at module scope**

Add this above `RcFormModal` (so it's defined before use; module scope per CLAUDE.md client-component rule):

```tsx
function ServiceScheduleEditor({
  schedule,
  onChange,
}: {
  schedule: ServiceSchedule
  onChange: (next: ServiceSchedule) => void
}) {
  const dayWindows = (idx: number): ServiceWindow[] => schedule[String(idx)] ?? []

  const setDay = (idx: number, windows: ServiceWindow[]) => {
    const next = { ...schedule }
    if (windows.length) next[String(idx)] = windows
    else delete next[String(idx)]
    onChange(next)
  }

  const addWindow = (idx: number) => setDay(idx, [...dayWindows(idx), { ...EMPTY_WINDOW }])
  const removeWindow = (idx: number, wi: number) => setDay(idx, dayWindows(idx).filter((_, i) => i !== wi))
  const editWindow = (idx: number, wi: number, key: keyof ServiceWindow, val: string) =>
    setDay(idx, dayWindows(idx).map((w, i) => (i === wi ? { ...w, [key]: val } : w)))

  const copyMondayToAll = () => {
    const mon = dayWindows(0)
    const next: ServiceSchedule = {}
    for (let i = 0; i < 7; i++) if (mon.length) next[String(i)] = mon.map(w => ({ ...w }))
    onChange(next)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-xs font-medium text-gray-600">Weekly service hours</label>
        <button type="button" onClick={copyMondayToAll}
          className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-700">
          <Copy size={11} /> Copy Mon → all
        </button>
      </div>
      {DAY_LABELS.map((label, idx) => {
        const windows = dayWindows(idx)
        return (
          <div key={label} className="border border-gray-100 rounded-xl p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-700 w-10">{label}</span>
              {windows.length === 0 && <span className="text-[11px] text-gray-400">Closed</span>}
              <button type="button" onClick={() => addWindow(idx)}
                className="flex items-center gap-1 text-[11px] text-gold hover:text-[#a88930]">
                <Plus size={11} /> Window
              </button>
            </div>
            {windows.map((w, wi) => (
              <div key={wi} className="flex items-center gap-1.5 mt-2">
                <input
                  value={w.label}
                  onChange={e => editWindow(idx, wi, 'label', e.target.value)}
                  placeholder="Lunch"
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-gold"
                />
                <input type="time" value={w.start} onChange={e => editWindow(idx, wi, 'start', e.target.value)}
                  className="border border-gray-200 rounded-lg px-1.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-gray-400 text-xs">–</span>
                <input type="time" value={w.end} onChange={e => editWindow(idx, wi, 'end', e.target.value)}
                  className="border border-gray-200 rounded-lg px-1.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-gold" />
                <button type="button" onClick={() => removeWindow(idx, wi)}
                  className="p-1 text-gray-300 hover:text-red-500">
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: build succeeds. (Editor is defined but not yet rendered — fine.)

- [ ] **Step 6: Commit**

```bash
git add src/app/setup/revenue-centers/page.tsx
git commit -m "feat(rc): form state + weekly service-hours editor component"
```

---

## Task 9: Page — render the scheduling section + send fields on submit

**Files:**
- Modify: `src/app/setup/revenue-centers/page.tsx`

- [ ] **Step 1: Serialize prep lead + scheduling fields in submit**

In `handleSubmit`, replace the `payload` object (lines ~63–69) with:

```ts
    const prepLeadMinutes =
      form.prepLeadH === '' && form.prepLeadM === ''
        ? null
        : (parseInt(form.prepLeadH || '0', 10) * 60) + parseInt(form.prepLeadM || '0', 10)
    const payload = {
      ...form,
      targetFoodCostPct: form.targetFoodCostPct !== '' ? parseFloat(form.targetFoodCostPct) : null,
      description:  form.description  || null,
      managerName:  form.managerName  || null,
      notes:        form.notes        || null,
      prepLeadMinutes,
      serviceSchedule: form.schedulingMode === 'ON_DEMAND' ? null : form.schedule,
    }
```

> The payload still spreads `form`, which carries `schedulingMode`, plus the UI-only `prepLeadH`/`prepLeadM`/`schedule` — harmless extras the API ignores; `prepLeadMinutes` and `serviceSchedule` (the canonical fields) are set explicitly after the spread.

- [ ] **Step 2: Render the Scheduling section in the form**

In the form JSX, insert this block **after** the Notes `<div>` (closes ~line 185) and **before** the Toggles block (`{/* Toggles */}`, ~line 187):

```tsx
            {/* Scheduling */}
            <div className="pt-2 border-t border-gray-100 space-y-3">
              <div className="flex items-center gap-1.5">
                <Clock size={13} className="text-gray-400" />
                <span className="text-xs font-semibold text-gray-700">Service hours &amp; prep timing</span>
              </div>

              {/* Mode toggle */}
              <div className="flex gap-1.5">
                {(['FIXED', 'ON_DEMAND'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => f('schedulingMode', mode)}
                    className={`flex-1 py-2 text-xs font-medium rounded-xl border transition-colors ${
                      form.schedulingMode === mode
                        ? 'border-gold bg-gold/10 text-gray-900'
                        : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    {mode === 'FIXED' ? 'Fixed hours' : 'On-demand / by booking'}
                  </button>
                ))}
              </div>

              {/* Prep lead */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Prep lead before service</label>
                <div className="flex items-center gap-2">
                  <input type="number" min="0" value={form.prepLeadH}
                    onChange={e => f('prepLeadH', e.target.value)} placeholder="0"
                    className="w-16 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  <span className="text-xs text-gray-400">h</span>
                  <input type="number" min="0" max="59" value={form.prepLeadM}
                    onChange={e => f('prepLeadM', e.target.value)} placeholder="0"
                    className="w-16 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                  <span className="text-xs text-gray-400">m</span>
                </div>
              </div>

              {/* Weekly editor (Fixed only) */}
              {form.schedulingMode === 'FIXED' && (
                <ServiceScheduleEditor
                  schedule={form.schedule}
                  onChange={next => setForm(prev => ({ ...prev, schedule: next }))}
                />
              )}
            </div>
```

> `f(key, val)` is the existing setter at line ~80; it accepts `string | boolean`. `'schedulingMode'` values `'FIXED'`/`'ON_DEMAND'` are strings, so this works as-is.

- [ ] **Step 3: Type-check + manual**

Run: `npm run build`
Expected: build succeeds.
Manual (dev server): open New Revenue Center → see mode toggle, prep lead, and (Fixed) the 7-day editor; add a Lunch window on Mon, "Copy Mon → all", Save → reopen Edit and confirm the windows + prep lead persisted.

- [ ] **Step 4: Commit**

```bash
git add src/app/setup/revenue-centers/page.tsx
git commit -m "feat(rc): scheduling section in the form + persist on submit"
```

---

## Task 10: Page — card service row + running food cost block

**Files:**
- Modify: `src/app/setup/revenue-centers/page.tsx`

This task adds the per-card service chips, prep-lead chip, item count, and target-vs-running block. It needs the live insights, threaded in as a prop.

- [ ] **Step 1: Add an insights type + import formatters**

Near the top (after the type imports added in Task 8), add:

```ts
import { fmtWindow, fmtDuration, dayIndex } from '@/lib/service-hours'

interface RcInsight { spendWTD: number; runningFoodCostPct: number | null; itemCount: number }
```

- [ ] **Step 2: Extend `RcCard` signature + render service/running**

Change the `RcCard` signature (line ~234) to accept an optional insight:

```tsx
function RcCard({ rc, insight, onEdit, onDelete }: {
  rc: RevenueCenter; insight?: RcInsight; onEdit: () => void; onDelete: () => void
}) {
```

At the top of `RcCard`'s body (after the existing `const hasDetails = ...`, line ~237), add the derived service display:

```tsx
  const todayIdx = dayIndex(new Date())
  const todayWindows = rc.schedulingMode === 'FIXED' ? (rc.serviceSchedule?.[String(todayIdx)] ?? []) : []
  const prepLeadLabel = rc.prepLeadMinutes != null ? fmtDuration(rc.prepLeadMinutes * 60_000) : null
  const target = rc.targetFoodCostPct != null ? parseFloat(rc.targetFoodCostPct) : null
  const running = insight?.runningFoodCostPct ?? null
  const runningColor = target == null || running == null
    ? 'text-gray-400'
    : running <= target ? 'text-green-600' : running <= target + 2 ? 'text-amber-600' : 'text-red-500'
```

Then, inside the `rc-main` column, **after** the existing "Key info row" `<div className="flex flex-wrap gap-3 mt-2">…</div>` (closes ~line 285), add the item-count chip into that same row and a new service row beneath. Concretely, add this immediately after that key-info `</div>`:

```tsx
            {/* Service row */}
            <div className="flex items-center gap-2 mt-2.5 flex-wrap">
              <span className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-gray-400 font-medium">
                <Clock size={11} /> Service
              </span>
              {rc.schedulingMode === 'ON_DEMAND' ? (
                <span className="inline-flex items-center gap-1.5 bg-gray-50 border border-gray-100 rounded-lg px-2 py-1 text-[11.5px] text-gray-500">
                  By booking
                </span>
              ) : todayWindows.length === 0 ? (
                <span className="text-[11.5px] text-gray-400">Closed today</span>
              ) : (
                todayWindows.map((w, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 bg-gray-50 border border-gray-100 rounded-lg px-2 py-1 text-[11.5px] text-gray-600">
                    <span className="font-semibold text-gray-700">{w.label}</span>
                    <span className="text-gray-400 font-mono text-[11px]">{fmtWindow(w)}</span>
                  </span>
                ))
              )}
              {prepLeadLabel && (
                <span className="inline-flex items-center gap-1.5 bg-gray-50 border border-gray-100 rounded-lg px-2 py-1 text-[11.5px] text-gray-400">
                  Prep lead {prepLeadLabel}
                </span>
              )}
              {insight && (
                <span className="inline-flex items-center gap-1 text-[11.5px] text-gray-400">
                  · {insight.itemCount} items
                </span>
              )}
            </div>

            {/* Target vs running */}
            {target != null && (
              <div className="mt-2.5">
                <div className="flex items-center justify-between text-[11px] text-gray-400 mb-1">
                  <span>Target food cost <b className="text-gray-700">{target}%</b></span>
                  <span>Running{' '}
                    <b className={runningColor}>{running != null ? `${running.toFixed(1)}%` : '—'}</b>
                  </span>
                </div>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden relative">
                  <div className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, running ?? target)}%`,
                      backgroundColor: running == null ? '#d1d5db' : running <= target ? '#16a34a' : '#d97706',
                    }} />
                  <div className="absolute top-0 bottom-0 w-px bg-gray-900/40" style={{ left: `${Math.min(100, target)}%` }} />
                </div>
              </div>
            )}
```

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: build succeeds. (Cards still rendered without `insight` until Task 11 — `insight` is optional, so the running block shows `—`.)

- [ ] **Step 4: Commit**

```bash
git add src/app/setup/revenue-centers/page.tsx
git commit -m "feat(rc): card service-hours row + target-vs-running block"
```

---

## Task 11: Page — fetch insights, KPI strip, rail, 2-column layout

**Files:**
- Modify: `src/app/setup/revenue-centers/page.tsx` (the default export `RevenueCentersPage`, lines ~325–383)

- [ ] **Step 1: Add `useEffect`/`useState` import + rc-colors hex helper**

Ensure the React import (line 2) includes `useEffect`:

```ts
import { useState, useEffect } from 'react'
```

(`RC_COLORS, rcHex` are already imported at line 4.)

- [ ] **Step 2: Add the insights fetch + KPI/rail to the page**

Replace the entire `RevenueCentersPage` default export (lines ~325–383) with:

```tsx
interface RcInsightsResponse {
  centers: Record<string, RcInsight>
  totals: { activeCount: number; totalCount: number; blendedTargetPct: number | null; allocatedWTD: number }
}

function fmtMoney(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${Math.round(n).toLocaleString()}`
}

export default function RevenueCentersPage() {
  const { revenueCenters, reload } = useRc()
  const [editTarget, setEditTarget] = useState<RevenueCenter | null>(null)
  const [showForm, setShowForm]     = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [insights, setInsights] = useState<RcInsightsResponse | null>(null)

  const loadInsights = async () => {
    try {
      const res = await fetch('/api/insights/revenue-centers')
      if (res.ok) setInsights(await res.json())
    } catch { /* non-fatal: cards fall back to target-only */ }
  }
  useEffect(() => { loadInsights() }, [])

  const refreshAll = async () => { await reload(); await loadInsights() }

  const handleDelete = async (rc: RevenueCenter) => {
    if (!confirm(`Delete "${rc.name}"?`)) return
    const res = await fetch(`/api/revenue-centers/${rc.id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json(); setDeleteError(d.error || 'Failed to delete'); return }
    setDeleteError('')
    refreshAll()
  }

  const openAdd  = () => { setEditTarget(null); setShowForm(true) }
  const openEdit = (rc: RevenueCenter) => { setEditTarget(rc); setShowForm(true) }

  const totals = insights?.totals
  const activeCenters = revenueCenters.filter(rc => rc.isActive)
  const spendShare = activeCenters
    .map(rc => ({ rc, spend: insights?.centers[rc.id]?.spendWTD ?? 0 }))
    .filter(x => x.spend > 0)
  const spendTotal = spendShare.reduce((s, x) => s + x.spend, 0)

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Revenue Centers</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {revenueCenters.length} center{revenueCenters.length !== 1 ? 's' : ''}
            {totals && <> · each center&apos;s target drives its workspace cost-chrome</>}
          </p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 bg-gold text-white px-3 py-2 rounded-xl text-sm font-semibold hover:bg-[#a88930]"
        >
          <Plus size={16} /> Add
        </button>
      </div>

      {/* KPI strip */}
      {totals && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white border border-gray-100 rounded-2xl p-4">
            <div className="text-[10px] font-mono uppercase tracking-wide text-gray-400">Centers · Active</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">
              {totals.activeCount}<span className="text-base text-gray-400 font-medium"> / {totals.totalCount}</span>
            </div>
          </div>
          <div className="bg-white border border-gray-100 rounded-2xl p-4">
            <div className="text-[10px] font-mono uppercase tracking-wide text-gray-400">Blended Target</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">
              {totals.blendedTargetPct != null ? totals.blendedTargetPct.toFixed(1) : '—'}
              <span className="text-base text-gold font-semibold">%</span>
            </div>
          </div>
          <div className="bg-white border border-gray-100 rounded-2xl p-4">
            <div className="text-[10px] font-mono uppercase tracking-wide text-gray-400">Allocated · WTD</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">{fmtMoney(totals.allocatedWTD)}</div>
          </div>
        </div>
      )}

      {deleteError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          {deleteError}
        </div>
      )}

      {/* 2-column: list + rail (rail stacks below on mobile) */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4 items-start">
        <div className="space-y-3">
          {revenueCenters.map(rc => (
            <RcCard
              key={rc.id}
              rc={rc}
              insight={insights?.centers[rc.id]}
              onEdit={() => openEdit(rc)}
              onDelete={() => handleDelete(rc)}
            />
          ))}
        </div>

        {/* Rail */}
        <div className="space-y-3">
          {spendShare.length > 0 && (
            <div className="bg-white border border-gray-100 rounded-2xl p-4">
              <h4 className="text-sm font-semibold text-gray-900 mb-3">Spend allocation · WTD</h4>
              <div className="h-2 rounded-full bg-gray-100 overflow-hidden flex mb-3">
                {spendShare.map(({ rc, spend }) => (
                  <span key={rc.id} style={{ background: rcHex(rc.color), width: `${(spend / spendTotal) * 100}%` }} />
                ))}
              </div>
              {spendShare.map(({ rc, spend }) => (
                <div key={rc.id} className="flex items-center gap-2.5 py-1.5 border-b border-dashed border-gray-100 last:border-0">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: rcHex(rc.color) }} />
                  <span className="flex-1 text-xs text-gray-600 truncate">{rc.name}</span>
                  <span className="font-mono text-xs font-semibold text-gray-900">{fmtMoney(spend)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="bg-white border border-gray-100 rounded-2xl p-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-2">Service hours drive timing</h4>
            <p className="text-xs text-gray-500 leading-relaxed">
              Each center&apos;s service windows and prep lead feed the day&apos;s countdowns — the Pre-shift
              &ldquo;to service&rdquo; banner and the Prep deadline both read from here.
            </p>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-2">Why centers matter</h4>
            <p className="text-xs text-gray-500 leading-relaxed">
              Each center owns its target food cost. The live cost-chrome strip reads the active workspace&apos;s
              target — switch the workspace pill and every Cost, Variance, and Menu screen re-baselines.
            </p>
          </div>
        </div>
      </div>

      {showForm && (
        <RcFormModal
          initial={editTarget}
          onClose={() => setShowForm(false)}
          onSaved={refreshAll}
        />
      )}
    </div>
  )
}
```

> Note: `onSaved` now points at `refreshAll` (was `reload`) so the KPIs/rail refresh after create/edit too.

- [ ] **Step 3: Type-check + manual**

Run: `npm run build`
Expected: build succeeds.
Manual (dev server): page shows the 3 KPI tiles, cards render today's windows + running %, and the rail shows spend allocation. Create/edit a center → KPIs + rail refresh.

- [ ] **Step 4: Commit**

```bash
git add src/app/setup/revenue-centers/page.tsx
git commit -m "feat(rc): KPI strip, spend-allocation rail, 2-column layout, live insights fetch"
```

---

## Task 12: Wire preshift "to service" countdown to the active center

**Files:**
- Modify: `src/app/preshift/page.tsx`

- [ ] **Step 1: Import the helper + pull the full active RC**

Replace the `useRc` import line (line 9) with:

```ts
import { useRc } from '@/contexts/RevenueCenterContext'
import { nextServiceStart, currentWindow, fmtDuration } from '@/lib/service-hours'
```

Change the hook destructure (line ~81) from `const { activeRcId } = useRc()` to:

```ts
  const { activeRcId, activeRc } = useRc()
```

- [ ] **Step 2: Replace the hardcoded cutoff computation**

Replace lines ~253–256 (`const cutoff = nextServiceCutoff(...)` through the `remM` line) with:

```ts
  const now = new Date()
  const inService = activeRc ? currentWindow(activeRc, now) : null
  const next = activeRc ? nextServiceStart(activeRc, now) : null
  const serviceCountdown = inService
    ? 'in service'
    : next ? fmtDuration(next.start.getTime() - now.getTime()) : null
  const serviceLabel = inService ? inService.window.label : next?.label ?? null
```

- [ ] **Step 3: Pass the new values into `ProgressBand`**

Replace the `remH={remH} remM={remM}` props (lines ~295–296) with:

```tsx
          serviceCountdown={serviceCountdown}
          serviceLabel={serviceLabel}
```

- [ ] **Step 4: Update `ProgressBand` to render the new props**

Change the `ProgressBand` signature (lines ~374–376) — drop `remH`/`remM`, add the two new props:

```tsx
function ProgressBand({ done, total, pct, blockersOpen, lineCount, serviceCountdown, serviceLabel }: {
  done: number; total: number; pct: number; blockersOpen: number; lineCount: number
  serviceCountdown: string | null; serviceLabel: string | null
}) {
```

Replace the right-hand countdown block (lines ~405–408) with:

```tsx
      <div className="shrink-0 text-right border-l border-line pl-6">
        <div className="text-[22px] font-semibold tracking-[-0.03em] font-mono">
          {serviceCountdown ?? 'No window'}
        </div>
        <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em] mt-[3px]">
          {serviceCountdown == null ? 'no fixed service' : serviceLabel ? `to ${serviceLabel}` : 'to service'}
        </div>
      </div>
```

- [ ] **Step 5: Delete the dead `nextServiceCutoff` helper**

Remove the `nextServiceCutoff` function (lines ~590–595) entirely — it's now unused.

- [ ] **Step 6: Type-check + manual**

Run: `npm run build`
Expected: build succeeds with no "unused variable" errors (confirm `remH`/`remM`/`nextServiceCutoff` are fully removed).
Manual: with a FIXED active center, the band shows e.g. "5h 20m / to Dinner"; switch the workspace pill to an ON_DEMAND center → shows "No window / no fixed service"; during a window → "in service".

- [ ] **Step 7: Commit**

```bash
git add src/app/preshift/page.tsx
git commit -m "feat(preshift): drive 'to service' countdown from active center's service hours"
```

---

## Task 13: Add the prep deadline banner

**Files:**
- Modify: `src/app/prep/page.tsx`

- [ ] **Step 1: Import the helpers + active RC**

Add to the imports at the top of the file:

```ts
import { useRc } from '@/contexts/RevenueCenterContext'
import { prepDeadline, fmtDuration } from '@/lib/service-hours'
```

Inside the component (near the other hooks at the top of the default export body), add:

```ts
  const { activeRc } = useRc()
```

- [ ] **Step 2: Add a module-scope `PrepDeadlineBanner` component**

Define this at module scope (per CLAUDE.md client-component rule), above the default export:

```tsx
function PrepDeadlineBanner({ rc }: { rc: import('@/contexts/RevenueCenterContext').RevenueCenter | null }) {
  if (!rc) return null
  const now = new Date()
  const onDemand = rc.schedulingMode === 'ON_DEMAND'
  const leadLabel = rc.prepLeadMinutes != null ? fmtDuration(rc.prepLeadMinutes * 60_000) : null
  const deadline = onDemand ? null : prepDeadline(rc, now)
  const countdown = deadline ? fmtDuration(deadline.getTime() - now.getTime()) : null
  const deadlineTime = deadline
    ? deadline.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : null

  return (
    <div className="flex items-center gap-2 bg-gold/10 border border-gold/30 rounded-xl px-3 py-2 text-xs">
      <Clock size={14} className="text-gold shrink-0" />
      {onDemand ? (
        <span className="text-gray-600">
          On-demand · {leadLabel ? <>prep lead <b className="text-gray-800">{leadLabel}</b></> : 'no prep lead set'}
        </span>
      ) : deadline ? (
        <span className="text-gray-600">
          Prep by <b className="text-gray-900">{deadlineTime}</b>
          <span className="text-gray-400"> · {countdown} left</span>
        </span>
      ) : (
        <span className="text-gray-400">No fixed service window today</span>
      )}
    </div>
  )
}
```

> `Clock` is already imported in prep page's lucide import — verify; if absent, add it to that import.

- [ ] **Step 3: Render the banner at the top of the page**

In the main `return (`, immediately inside the outer `<div className="space-y-3 md:space-y-5">` (line ~652), add as the first child:

```tsx
      <PrepDeadlineBanner rc={activeRc} />
```

- [ ] **Step 4: Type-check + manual**

Run: `npm run build`
Expected: build succeeds (confirm `Clock` is imported in this file).
Manual: with a FIXED active center that has windows + a prep lead, the prep page shows "Prep by 2:30 PM · 5h left"; an ON_DEMAND center shows "On-demand · prep lead 1d".

- [ ] **Step 5: Commit**

```bash
git add src/app/prep/page.tsx
git commit -m "feat(prep): show per-center prep-deadline banner from service hours"
```

---

## Task 14: Final verification

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: clean build. In the route table, confirm `ƒ (Dynamic)` for `/api/revenue-centers`, `/api/revenue-centers/[id]`, and `/api/insights/revenue-centers`.

- [ ] **Step 2: End-to-end manual pass (dev server)**

Run: `npm run dev`, then:
1. Create a FIXED center "Restaurant" — windows Mon–Sat (Lunch 11:30–15:00, Dinner 17:00–22:30), prep lead 2h 30m, target 28% → card shows today's windows + "Prep lead 2h 30m"; running % renders (or "—" if no sales this week).
2. Create an ON_DEMAND center "Catering" — prep lead 1d → card shows "By booking" chip.
3. KPI strip shows active/total, blended target (spend-weighted), allocated WTD; rail shows spend allocation if there's approved invoice spend this week.
4. Set the active workspace pill to "Restaurant" → Pre-shift band shows the real "to {window}" countdown; switch to "Catering" → "No window / no fixed service".
5. Prep page shows "Prep by HH:MM · countdown" for Restaurant, "On-demand · prep lead 1d" for Catering.

- [ ] **Step 3: Final commit (if any stray changes)**

```bash
git add -A
git commit -m "chore(rc): service-hours feature complete" || echo "nothing to commit"
```

---

## Notes for the implementer

- **No test runner exists** — do not scaffold Jest/Vitest. `npm run build` is the type-check + correctness gate per CLAUDE.md. Restart the dev server after changes (per user memory).
- **Prisma `Json` ≠ Decimal**: `serviceSchedule` comes back as a real object, not a string — no `Number()` wrapping. `targetFoodCostPct` is still a Decimal-as-string; keep the existing `parseFloat`.
- **Day index is Monday-first (0=Mon)** everywhere — `service-hours.ts`, the editor, and the card all agree. Don't reintroduce JS `getDay()` (Sunday-first) without the `(getDay()+6)%7` conversion.
- **Mobile**: the form modal is already a bottom sheet; the page's 2-column grid collapses to one column at `<lg` so the rail stacks below the list.
```
