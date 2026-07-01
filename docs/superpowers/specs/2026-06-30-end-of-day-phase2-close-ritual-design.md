# End-of-Day Phase 2 — Close Ritual (design spec)

**Status:** Approved design, pending implementation plan.
**Builds on:** Phase 1 MVP (PR #30, `/end-of-day` read-only recap). This phase replaces the Phase 1 placeholder blocks (closing checklist, gate ring, "Close the day", handover note) with a live, server-backed close ritual, and adds an admin editor.

## Goal

Turn the End-of-day page into a working nightly "close the day" ritual: a per-revenue-center checklist (with a food-safety temps gate reused from the existing Temps subsystem), a completion gate, a manager sign-off that writes an immutable compliance record + snapshot, and a handover note that surfaces on the next day's Pass.

## Locked decisions

1. **Sign-off = compliance record + snapshot.** No day-lock. The app already writes actuals continuously (sales → theoretical stock, counts → real stock), so sign-off does NOT re-write stock/cost. It records: checklist completion, who/when signed off, a frozen snapshot of the day's numbers, and the handover note. Value = accountability, food-safety audit trail, handover, a real "done" gate.
2. **Grain = per-revenue-center.** Templates and closes are per-RC (mirrors `PrepTask`). Kitchen and Bar each close on their own list. A close requires a specific active RC.
3. **Full ritual + admin editor in one phase.**
4. **Temps reuse the existing subsystem** (`TempUnit`/`TempReading`, `computeDayMetrics`, `SafetyTempsSummary`) exactly as pre-shift does — read-only rollup that deep-links to `/temps` to log. No temp fields on checklist items; no new temp models.

## Architecture

Two clean API families + reuse of the temps subsystem:
- `/api/eod/checklist*` — per-RC template CRUD (admin editor). Mirrors `/api/prep/tasks`.
- `/api/eod/close*` — per-day live state + sign-off (the ritual).
- `/api/temps/units` + `/temps` page — reused as-is for the temps gate.
- `/api/eod/handover` — read the latest closed handover for Pass.

### Data model (3 new tables)

**`EodCheckItem`** — per-RC checklist template (admin-editable; pure checkbox/blocker, NO temp fields):
```
id                String   @id @default(uuid())
revenueCenterId   String
section           String            // free-form grouping, seeded with the 4 default sections
title             String
meta              String?           // sub-line, e.g. "all stations · dated buckets emptied"
sortOrder         Int      @default(0)
isBlocker         Boolean  @default(false)   // hard gate item
isActive          Boolean  @default(true)    // soft-delete; preserves history
createdAt         DateTime @default(now())
updatedAt         DateTime @updatedAt
revenueCenter     RevenueCenter @relation("EodCheckItemRC", fields: [revenueCenterId], references: [id])
entries           EodCheckEntry[]
@@index([revenueCenterId, isActive])
```

**`EodClose`** — one row per RC per business day (live draft → finalized record):
```
id              String   @id @default(uuid())
revenueCenterId String
businessDate    String            // 'YYYY-MM-DD' local day (matches TempReading.logDate)
status          String   @default("DRAFT")   // 'DRAFT' | 'CLOSED'
handoverNote    String?
signedOffBy     String?           // user id/email
signedOffByName String?
signedOffAt     DateTime?
snapshot        Json?             // frozen at sign-off
createdAt       DateTime @default(now())
updatedAt       DateTime @updatedAt
revenueCenter   RevenueCenter @relation("EodCloseRC", fields: [revenueCenterId], references: [id])
entries         EodCheckEntry[]
@@unique([revenueCenterId, businessDate])
```

**`EodCheckEntry`** — per-item state within a close (server-shared across devices):
```
id            String   @id @default(uuid())
closeId       String
itemId        String
done          Boolean  @default(false)
updatedByName String?
updatedAt     DateTime @updatedAt
close         EodClose      @relation(fields: [closeId], references: [id], onDelete: Cascade)
item          EodCheckItem  @relation(fields: [itemId], references: [id], onDelete: Cascade)
@@unique([closeId, itemId])
```

### Gate logic (server-authoritative, mirrors pre-shift + the mock)

Computed in a shared `src/lib/eod-close.ts` so the `close` GET and `signoff` endpoints agree byte-for-byte:
- A checklist item is **done** if its entry `done === true`.
- A checklist item is **blocking** if not done AND `isBlocker`.
- **Temps** contribute as one gate item. The **server** computes `tempsReady` by querying `TempUnit` + today's `TempReading` for the RC (same data `/temps` uses) and applying the pre-shift rule: `tempsReady = total === 0 || (logged === total && flagged === 0)`. This must be server-side because `signoff` re-validates `ready` and cannot trust the client.
- `doneCount = checklistDone + (tempsReady ? 1 : 0)`; `totalCount = activeItems + (hasTempUnits ? 1 : 0)`; `blockersOpen = checklistBlockersOpen + (tempsReady ? 0 : 1)`.
- **Ready to close** = every active checklist item done AND `tempsReady`.
- The End-of-day page still fetches `/api/temps/units` directly for the `SafetyTempsSummary` *display* (exactly as pre-shift does), but the authoritative `ready` flag comes from the `close` endpoints' `progress`.

### API endpoints (all MANAGER-gated, `force-dynamic`)

Template (admin editor):
- `GET  /api/eod/checklist?rcId=` — active items for an RC, grouped by section, ordered by `sortOrder`.
- `POST /api/eod/checklist` — create item `{revenueCenterId, section, title, meta?, isBlocker?}` (appends to end of section).
- `PATCH  /api/eod/checklist/[id]` — edit `{section?, title?, meta?, isBlocker?}`.
- `DELETE /api/eod/checklist/[id]` — soft-delete (`isActive = false`).
- `POST /api/eod/checklist/reorder` — `{rcId, orderedIds[]}` → rewrite `sortOrder`.

Ritual (daily state):
- `GET   /api/eod/close?rcId=` — returns `{ template: sections[], close, entries, progress: {done,total,blockers,ready} }`. Lazily creates today's `DRAFT` `EodClose` if none. `progress` is computed server-side via `eod-close.ts` and already folds in `tempsReady` (the page fetches `/api/temps/units` separately only for the `SafetyTempsSummary` display).
- `PATCH /api/eod/close/entry` — `{rcId, itemId, done}` → upsert `EodCheckEntry`, recompute, return `progress`.
- `PATCH /api/eod/close` — `{rcId, handoverNote}` → save handover on today's close.
- `POST  /api/eod/close/signoff` — `{rcId}` → re-validate `ready` server-side; if ready, set `status=CLOSED`, `signedOffBy/Name/At`, capture `snapshot`; else 409. Returns finalized close.
- `POST  /api/eod/close/reopen` — `{rcId}` → clear sign-off fields + snapshot, `status=DRAFT`.

Handover (for Pass):
- `GET /api/eod/handover?rcId=` — the most recent `CLOSED` close before today for the RC → `{ handoverNote, signedOffByName, businessDate }` or null.

### Snapshot contents (frozen at sign-off)

Reuse the `/api/eod/summary` computation for the RC/today, stored as JSON:
`{ netSales, covers, foodCostDollars, foodCostPct, checklist: {done, total}, tempsReady, signedOffByName, signedOffAt }`. Immutable — preserves what was true at close even if later data shifts.

## UI

### End-of-day page (`/end-of-day`) — replaces Phase 1 placeholders

- **Close-down section:** the checklist grouped by `section` (checkbox rows; blocker rows accented), plus a reused `SafetyTempsSummary` row (status from `computeDayMetrics`, "Log temps →" deep-links to `/temps`). Ticking a box → `PATCH /api/eod/close/entry` → server returns fresh `progress`.
- **Gate ring (right rail):** shows `done/total` %, colored by state (blockers → red, all-but-not-blocked → amber, ready → green). "Close the day" enabled only when `ready`. On click → `POST /api/eod/close/signoff` → redirect to `/pass`.
- **Closed state:** if today's close is `CLOSED`, the gate shows "Day closed · signed off by {name} · {HH:MM}" + the snapshot, with a **Reopen** button (`POST /api/eod/close/reopen`).
- **Handover note:** live textarea (debounced `PATCH /api/eod/close`), replacing the disabled Phase 1 placeholder.
- **No specific RC (scope = All/Location):** the recap (KPIs, day-in-review) still renders aggregated; the checklist/gate area shows an **RC picker** ("Pick a revenue center to close: Kitchen · Bar").

### Pass page (`/pass`) — handover surface

A small **"Handover from last close"** card reads `GET /api/eod/handover?rcId=` and shows the note + who signed off + when. Hidden when null.

### Admin editor — new Setup card → `/setup/eod-checklist`

- New card on the Setup grid ("End-of-day checklist — Close-down checklist items per revenue center").
- Pick an RC (tabs) → its checklist grouped by section.
- Add / edit-inline / reorder (up-down or drag, via `/api/eod/checklist/reorder`) / soft-delete items; set section (free-form, seeded with defaults) and blocker flag.
- Temp units are NOT managed here (they live on `/temps`).

## Seeding

Migration + idempotent seed of the design's default checklist **per active RC** (only if that RC has zero `EodCheckItem` rows), so every RC has a working list; admins prune per-RC. Defaults (checkbox/blocker only — temp items are handled by the temps gate, not seeded here):

- **Food safety & close-down:** Hot food blast-chilled & date-labelled; Food-safety log signed off *(blocker)*.
- **Clean-down:** Line & prep surfaces sanitised; Grill/fryer/flat-top cleaned; Floors mopped, bins & recycling out; Dishwasher run, emptied & drained; Extraction, gas & equipment off *(blocker)*.
- **Cash & POS close:** Z-report run & filed; Cash drawer counted & reconciled; Tips pooled & recorded; Safe drop logged & sealed; Sales synced.
- **Prep & storage for tomorrow:** Proteins pulled to thaw; Mise rotated FIFO & dated; 86 board updated; Delivery & dry store secured; Alarm set & premises locked *(blocker)*.

(The design's temperature rows — walk-in/freezer close temps — are covered by the reused temps gate, not seeded as checklist items.)

## Migration mechanics

`prisma migrate dev` is broken in this repo (P3006 shadow-DB drift) and writes go through the pgBouncer transaction pooler. Use the established workaround: author the schema change, generate SQL via `prisma migrate diff`, apply with `prisma db execute` (or `$executeRawUnsafe` for any array writes), then `prisma migrate resolve --applied`. Do NOT run a full-schema migrate diff. Regenerate the client after.

## Auth

All new routes `requireSession('MANAGER')`; `/end-of-day` and `/setup/*` are already MANAGER/ADMIN-gated in middleware. (Line staff logging temps directly is a future loosening — for now the manager runs the close, and temp logging happens on `/temps` under its own gating.)

## Out of scope (later phases)

- A distinct close-specific (PM) temp reading requirement — for now temps follow the pre-shift "logged today + in range" rule.
- Prep-for-tomorrow queue → prep board, below-par order drafting, 86 board writes (Phase 3).
- Forecast baselines, comps/discounts via Toast sync, labour input, print/email-owner report (Phase 4).

## Verification

No automated test suite — `npm run build` is the correctness check. Preview-server checks: tick/untick items update the gate; blocker + temps-not-ready block sign-off; sign-off writes `CLOSED` + snapshot and redirects to Pass; reopen returns to `DRAFT`; handover saved and appears on Pass; admin editor add/edit/reorder/soft-delete round-trips; no-RC scope shows the RC picker.

## New/changed files (anticipated)

- `prisma/schema.prisma` — 3 new models + relations on `RevenueCenter`.
- Seed: `prisma/seed.ts` or a dedicated `scripts/seed-eod-checklist.ts`.
- `src/lib/eod-close.ts` — shared gate/progress computation + snapshot builder.
- `src/app/api/eod/checklist/route.ts`, `.../[id]/route.ts`, `.../reorder/route.ts`.
- `src/app/api/eod/close/route.ts`, `.../entry/route.ts`, `.../signoff/route.ts`, `.../reopen/route.ts`.
- `src/app/api/eod/handover/route.ts`.
- `src/app/end-of-day/page.tsx` + `eod-components.tsx` — wire checklist/gate/handover; reuse `SafetyTempsSummary`.
- `src/app/setup/eod-checklist/page.tsx` + components; add Setup card.
- `src/app/pass/page.tsx` — handover card.
