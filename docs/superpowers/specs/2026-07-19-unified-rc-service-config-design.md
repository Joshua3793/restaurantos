# Unified RC Service Configuration — Design

**Date:** 2026-07-19
**Status:** Approved, ready for implementation planning

## Problem

Service configuration lives in **two independent systems** that have drifted out of sync:

| System | Shape | Configured in | Read by |
|---|---|---|---|
| `Service` model | Per-RC rows: `name` + `timeMinutes` (a single minute-of-day) | `/setup/services` | Prep run sheet (`PrepItem.targetServiceId` → `item.service`) |
| `RevenueCenter.serviceSchedule` | JSON: per-weekday windows `{ label, start, end }` + `schedulingMode` + `prepLeadMinutes` | RC editor (`/setup/revenue-centers`) | `/pass`, `/preshift`, prep header (via `service-hours.ts` → `buildPrepCountdown`) |

The divergence is user-visible. The KITCHEN RC was configured as **Brunch 9–4** in the `Service` model, but its `serviceSchedule` JSON still held a stale evening window. So the prep header read *"dinner service in 7h 32m"* while the run sheet — three inches below it — correctly read *"ALL SERVICES STARTED."*

An interim fix already pointed the prep page at the `Service` model. `/pass` and `/preshift` still read the stale JSON.

**Goal:** one service configuration, set in RC setup, that every page reads.

## Decisions

1. **Structure:** multiple service periods per RC (e.g. `Brunch 9–16` and `Dinner 17–22`). No per-weekday variation — the legacy JSON supported it, nothing used it.
2. **Location:** configured inside the RC editor (`/setup/revenue-centers`). The standalone `/setup/services` page is retired.
3. **RC scheduling settings:** the explicit `FIXED`/`ON_DEMAND` toggle is dropped — an RC with **zero active services is on-demand**, derived. `prepLeadMinutes` is kept as an optional RC setting for the coarse "prep by" deadline on `/pass` and `/preshift`.

## Approach

**Extend `Service`; retire `serviceSchedule`.**

`Service` is already a per-RC list with a name and a start time, and — critically — `PrepItem.targetServiceId` is a foreign key to it. Building on it leaves the run sheet (the newest, most complex consumer) untouched. It only lacks an end time.

**Rejected alternatives:**
- *Make `serviceSchedule` the source, derive services from it.* The JSON windows have no stable IDs, so `PrepItem.targetServiceId` would break. Highest risk, hits the newest feature.
- *Introduce a fresh `ServicePeriod` table.* Unnecessary churn — `Service` already covers ~90% of the need.

## Data model

### `Service` — the single source of truth

| Field | Meaning |
|---|---|
| `name` | The service **type** — "Brunch", "Lunch", "Dinner" |
| `timeMinutes` | Service **start**, minute-of-day. Already the run sheet's count-back anchor (`startBy = service − handsOn − passive`) |
| `endMinutes` *(new, nullable)* | Service **end**, minute-of-day. `endMinutes < timeMinutes` means the service crosses midnight |
| `isActive` | Existing — disable a service without deleting it |
| `sortOrder` | Existing — display order |

`endMinutes` is nullable so Step 1 can ship additively; the RC editor prompts to fill it.

### `RevenueCenter`

- **Drop:** `serviceSchedule` (JSON), `schedulingMode`
- **Keep:** `prepLeadMinutes` (optional)
- **Derived:** on-demand ⇔ the RC has no active services

After migration, KITCHEN is a single row: `Brunch, 09:00 → 16:00`.

## Shared helper

The root cause of the divergence was that no two pages asked the same question the same way. `src/lib/service-hours.ts` is rewritten to operate on `Service` rows and becomes the one module every surface calls.

```ts
export interface RcService {
  id: string
  name: string
  timeMinutes: number        // start, minute-of-day
  endMinutes: number | null  // end, minute-of-day; < start ⇒ crosses midnight
}

/** Next service whose start is after `nowMin`. null when all have started. */
export function nextService(services: RcService[], nowMin: number): RcService | null

/** Service in progress (start ≤ now < end), handling midnight crossing. */
export function currentService(services: RcService[], nowMin: number): RcService | null

/** Coarse prep deadline: next service start − lead. null when none upcoming. */
export function prepDeadlineMinutes(
  services: RcService[], nowMin: number, leadMinutes: number | null,
): number | null

/** The single answer every header renders. */
export function serviceStatus(
  services: RcService[], nowMin: number, leadMinutes: number | null,
):
  | { kind: 'upcoming'; service: RcService; minsUntil: number; prepByMin: number | null }
  | { kind: 'underway'; service: RcService }
  | { kind: 'none' }   // no services configured → on-demand
```

Removed: `nextServiceStart`, `currentWindow`, `prepDeadline`, `SchedulableRc`, `ServiceSchedule`, `ServiceWindow`, and `buildPrepCountdown` (in `prep-utils.ts`). `fmtDuration` is kept.

**Active filtering:** the RC API returns only `isActive` services, so every consumer receives an already-filtered list and the helper never needs to know about `isActive`. That is why `RcService` has no `isActive` field. The RC editor is the one surface that fetches inactive rows too (via `/api/services?includeInactive=true`) so they can be re-enabled.

## Consumers

| Surface | Today | After |
|---|---|---|
| Prep header (`/prep`) | Interim inline `nextService` from `item.service` | `serviceStatus(...)` |
| Prep run sheet | `item.service` (already correct) | Unchanged; may additionally display hours |
| `/pass` | `buildPrepCountdown(rc)` → stale JSON | `serviceStatus(...)` |
| `/preshift` | Same stale JSON | `serviceStatus(...)` |
| RC editor | Per-weekday `serviceSchedule` window UI | Service-period editor: name + start + end, add/remove, active toggle |
| `/setup/services` | Standalone per-RC services page | Retired — redirect to the RC editor |

**Data delivery:** `/api/revenue-centers` and `/api/revenue-centers/[id]` include each RC's `services` inline, so no consumer needs a second fetch. Service writes reuse the existing `/api/services` CRUD, invoked from the RC editor.

**Rendering rules** (consistent everywhere):
- `upcoming` → "{name} service in {duration}"
- `underway` → "{name} service underway"
- `none` → "on-demand" (no countdown)

## Migration & rollout

Staged so the application is fully working after every step. The old system keeps running until the new one is proven.

**Step 1 — Additive schema (safe).**
`ALTER TABLE "Service" ADD COLUMN "endMinutes" INTEGER;` — nullable. `serviceSchedule` and `schedulingMode` remain. Applied as hand-written SQL via `DIRECT_URL`, then recorded with `prisma migrate resolve --applied`.
⚠️ Hand-written SQL only: a full-schema `prisma migrate diff` would attempt to drop the pack-chain columns (standing repo gotcha).

**Step 2 — Backfill script (idempotent, non-destructive).**
For each RC: fill each Service's `endMinutes` from its matching `serviceSchedule` window (match by label, else nearest start); create Service rows for any window without one. Prints a per-RC before/after table. Deletes nothing. KITCHEN is set explicitly to `Brunch 09:00 → 16:00`, since its stale JSON holds a dinner window rather than Brunch.

**Step 3 — Shared helper + readers (code only).**
Rewrite `service-hours.ts` on `RcService` with vitest coverage; surface `services` on the RC API; switch the prep header, `/pass`, and `/preshift` to `serviceStatus`. After this only the RC editor touches `serviceSchedule`.

**Step 4 — RC editor + retire `/setup/services`.**
Replace the per-weekday window UI with the service-period editor; redirect the old page. Nothing reads or writes `serviceSchedule` after this.

**Step 5 — Drop the dead columns (destructive; separate; last).**
`ALTER TABLE "RevenueCenter" DROP COLUMN "serviceSchedule", DROP COLUMN "schedulingMode";`
Only after Steps 3–4 ship and are verified, and only with explicit confirmation — Step 2 has already carried that configuration into `Service`, so nothing is lost, but the drop is irreversible.

`PrepItem.targetServiceId` is never touched at any step, so the run sheet keeps working throughout.

## Testing

`service-hours.ts` stays pure, so it is unit-tested with vitest (matching the repo's pure-lib pattern — `npm test`):

- No services → `{ kind: 'none' }`
- All services already started → `underway` for the one in progress, `none` once the last has ended
- Upcoming service → correct `minsUntil` and `prepByMin`
- Service crossing midnight (`endMinutes < timeMinutes`) → `currentService` resolves correctly before and after midnight
- `prepLeadMinutes` null vs set → `prepByMin` null vs `start − lead`
- Multiple services → the *earliest upcoming* one wins

Manual verification after Step 3: the prep header, `/pass`, and `/preshift` all show the same service and countdown for the same RC at the same moment — the specific inconsistency that motivated this work.

## Risks

- **Live database.** Steps 1 and 2 are additive; Step 5 is destructive and gated on explicit confirmation. `DIRECT_URL` is reachable in this environment and is the required path (the pgBouncer pooler rejects Prisma's migrate tooling).
- **RCs with no services after backfill** become on-demand. This matches the previous `ON_DEMAND` behavior, but the backfill report should make any such RC obvious so it can be configured.
- **`endMinutes` left null** on a service means "start known, end unknown": `currentService` cannot resolve it as underway. The RC editor should require an end time on save; the helper treats a null end as "not underway."

## Out of scope

- Making the run sheet's time-bucket labels ("Later this morning", "Afternoon") service-aware — they are time-of-day descriptors and are already free of hardcoded service names.
- Per-weekday service variation (explicitly not needed).
- Any change to `PrepItem.targetServiceId` semantics or the run sheet's start-by math.
