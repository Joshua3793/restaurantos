# Revenue Centers — Service Hours & Timing

**Date:** 2026-05-29
**Status:** Approved design → ready for implementation plan

## Problem

The Revenue Centers setup page ([src/app/setup/revenue-centers/page.tsx](../../../src/app/setup/revenue-centers/page.tsx)) captures only static general info (name, type, color, description, manager, target food cost %, notes, default/active). It has **no concept of when a center operates**.

Meanwhile the app hardcodes service timing: `nextServiceCutoff()` in [src/app/preshift/page.tsx:590](../../../src/app/preshift/page.tsx) assumes 17:00 / 11:00 for every center. Prep has a `dueTime` field on its log that is always written `null`.

We want each revenue center to carry its own **service hours** and **prep lead time**, and have the app's countdowns read from them — so "X to service" and the prep deadline reflect the *active* center's real schedule.

Redesign target (mockup): `app/RevenueCenters.html` from the Anthropic design artifact. Cards gain a Service row (window chips + prep-lead chip); the form gains a weekly schedule editor.

## Decisions (locked during brainstorming)

1. **Scope: full wiring.** Add the data + redesigned page UI **and** wire service hours into preshift's "to service" countdown **and** prep due-time/countdown.
2. **Hours model: per-day-of-week schedule.** Each weekday can have its own set of windows (e.g. brunch on weekends, dinner-only Mondays, Sunday closed).
3. **Scheduling mode: per-center.** Each center is either `FIXED` (uses the weekly window schedule) or `ON_DEMAND` (by booking / per event — no weekly schedule; carries a prep lead only).
4. **Storage: JSON column** on `RevenueCenter` (not a normalized `ServiceWindow` table). The schedule is always edited and read as a whole, so a JSON blob matches the access pattern and avoids child-table CRUD. JSON columns work fine through Prisma ORM (unlike `text[]` array columns, they are not subject to the pgBouncer prepared-statement landmine noted in CLAUDE.md).

## Data model

Three new fields on `RevenueCenter` (one Prisma migration):

```prisma
schedulingMode  String  @default("FIXED")   // "FIXED" | "ON_DEMAND"
prepLeadMinutes Int?                          // prep lead in minutes; UI shows "2h 30m"
serviceSchedule Json?                         // 7-day window map; null for ON_DEMAND / unset
```

`serviceSchedule` shape — keys `"0"`–`"6"`, where **0 = Monday … 6 = Sunday**. A missing or empty-array key means the center is closed that day:

```json
{
  "0": [{ "label": "Dinner", "start": "17:00", "end": "22:30" }],
  "5": [
    { "label": "Brunch", "start": "10:00", "end": "14:00" },
    { "label": "Dinner", "start": "17:00", "end": "23:00" }
  ]
}
```

- `label` — free text (e.g. "Lunch", "Dinner", "Brunch"), required, non-empty.
- `start` / `end` — `"HH:MM"` 24-hour strings. A window where `end <= start` is treated as crossing midnight (end is next day) for next-window math.
- Windows within a day are stored sorted by `start`.

`ON_DEMAND` centers ignore `serviceSchedule` (kept null) and use only `prepLeadMinutes`.

### Touch points for the new fields
- **Prisma schema + migration** — `npx prisma migrate dev --name rc_service_hours`.
- **API** `POST` / `PATCH` ([src/app/api/revenue-centers/route.ts](../../../src/app/api/revenue-centers/route.ts), [src/app/api/revenue-centers/[id]/route.ts](../../../src/app/api/revenue-centers/[id]/route.ts)): accept + validate the three fields. Validation: `schedulingMode` whitelisted; `prepLeadMinutes` a non-negative int or null; `serviceSchedule` — each day key `"0"`–`"6"`, each window `{ label:non-empty, start:HH:MM, end:HH:MM }`, windows sorted by start; force `serviceSchedule = null` when mode is `ON_DEMAND`.
- **Context interface** ([src/contexts/RevenueCenterContext.tsx](../../../src/contexts/RevenueCenterContext.tsx)): add `schedulingMode: string`, `prepLeadMinutes: number | null`, `serviceSchedule: ServiceSchedule | null` to the `RevenueCenter` interface. (Prisma `Json` serializes as a real object, not a string — no `Number()` wrapping needed, unlike Decimal fields.)

## The brain — `src/lib/service-hours.ts` (new, shared, pure)

No DB access; operates on a `RevenueCenter` object + a `now: Date`.

```ts
export type ServiceWindow = { label: string; start: string; end: string }
export type ServiceSchedule = Record<string, ServiceWindow[]>  // "0".."6" (Mon..Sun)

// FIXED only: next window start at or after `now`, scanning today's remaining
// windows then following days, wrapping up to 7 days. null for ON_DEMAND / empty.
export function nextServiceStart(rc, now): { start: Date; label: string } | null

// The window currently in progress (start <= now < end), if any — lets banners
// distinguish "in service" from "to service".
export function currentWindow(rc, now): { window: ServiceWindow; end: Date } | null

// nextServiceStart.start minus prepLeadMinutes (null if no next start).
export function prepDeadline(rc, now): Date | null

// Formatting helpers.
export function fmtDuration(ms: number): string   // "2h 30m", "45m", "1d 2h"
export function fmtWindow(w: ServiceWindow): string // "11:30–15:00"
```

Day-of-week mapping: JS `Date.getDay()` is 0 = Sunday; convert to our 0 = Monday index with `(getDay() + 6) % 7`. Centralize this conversion in the lib.

## Wiring

### preshift ([src/app/preshift/page.tsx](../../../src/app/preshift/page.tsx))
- Delete the hardcoded `nextServiceCutoff()` (line ~590).
- Switch `useRc()` from `{ activeRcId }` to also pull `activeRc`.
- Compute `nextServiceStart(activeRc, new Date())`; the "to service" banner (currently `cutoff` / `remMs` at lines ~253–254) shows the real next window start + label.
- If `activeRc` is `ON_DEMAND`, has no schedule, or `nextServiceStart` returns null → banner shows **"No fixed service window"** instead of a clock countdown. No fabricated number.
- When `currentWindow` is non-null → banner reads "in service" rather than a countdown.
- When `activeRcId` is "all" / null (no single active center) → fall back to "No fixed service window".

### prep ([src/app/prep/page.tsx](../../../src/app/prep/page.tsx))
- Compute `prepDeadline(activeRc, now)` = next service start − center prep lead.
- Surface a **"Prep by HH:MM · {countdown}"** banner (mirrors preshift's banner styling).
- v1 granularity: **one shared deadline per center** — all of today's prep items share the center's prep deadline (no per-item lead offsets this round).
- `ON_DEMAND` or no schedule → show the center's prep lead as informational text ("Prep lead 2h 30m"), no clock countdown.

## Redesigned page UI

Adapt the mockup's structure to the app's existing Tailwind + `gold`/`rcHex` system — **do not** import the mockup's raw CSS (Geist/CSS-vars). Preserve the existing mobile bottom-sheet modal pattern.

### Cards ([RcCard])
Add to the existing card (keeps color accent, default/inactive/type badges, manager, target food cost):
- **Service row**: window chips for *today's* windows — `Lunch 11:30–15:00` — plus a muted **`Prep lead 2h 30m`** chip. `ON_DEMAND` centers show a single **`By booking`** chip.
- **Item count** chip — count of `StockAllocation` rows for the center (cheap; fetched alongside the RC list or via a small count include).

### Form modal ([RcFormModal])
Add a **Scheduling** section below the existing fields:
- **Mode toggle**: Fixed hours / On-demand.
- **Prep lead** input: hours + minutes → serialized to `prepLeadMinutes`.
- **Weekly editor** (Fixed mode only): 7 day rows (Mon–Sun), each with an open/closed toggle and a list of window editors (`label` text + `start`/`end` `<input type="time">`), add/remove window per day, plus a **"Copy Monday to all days"** shortcut. Hidden entirely in On-demand mode.
- The modal becomes a taller scrolling sheet; existing `max-h-[90vh] overflow-y-auto` already supports this.

`RcFormData` / `EMPTY_FORM` extend with `schedulingMode`, `prepLeadMinutes` (as h/m UI state), and a working `serviceSchedule` object. Submit serializes to the API payload shape above.

## Out of scope (deferred to a follow-up)

The mockup's right rail + KPI strip — **blended target**, **spend allocation WTD**, **running food cost % per center**, **spend-by-center bar** — require live per-RC spend aggregates (a new insights endpoint joining sales/invoice allocation by center). Excluded from this round to keep focus on "fill the info + wire the timing." Cards show the stored **target** food cost but **not** a "running %" yet.

Also out of scope: a true booking/event entity to give `ON_DEMAND` centers a concrete per-event service time. For now on-demand centers surface prep lead informationally only.

## Testing / verification

No automated test suite — `npm run build` is the correctness gate (also type-checks). After implementation:
- `npm run build` clean.
- Manual: create/edit a FIXED center with multiple windows across days; confirm cards render today's windows + prep-lead chip; confirm preshift "to service" banner reflects the active center's next window and re-baselines when switching the workspace pill; confirm an ON_DEMAND center shows "No fixed service window" in preshift and "By booking" on its card; confirm prep banner shows the derived prep deadline.
- Confirm RC API routes still show `ƒ (Dynamic)` in build output.
