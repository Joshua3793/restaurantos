# Sales Page Redesign — Source-Aware Log

_2026-06-27. Toast sales now flow in automatically (nightly cron + backfill writing
`SalesEntry` rows with `source='toast'` for CAFE). The Sales page must surface these
as automatic, keep manual entry for CATERING, and stop double-counting when a Toast
and manual entry collide on the same day._

## Goals

- Make Toast (auto) vs manual sales obvious at a glance.
- Surface sync health (last sync, missing days) without leaving the page.
- Stop duplicate (Toast + manual, same date+RC) from double-counting; let the user clear it.
- Keep manual entry (CATERING) and the Excel importer (fallback) intact.

## Non-goals

- No schema or API changes — `/api/sales` already returns `source`.
- No changes to the sync pipeline, `/setup/toast`, or the cron.
- Not a rewrite of the 1,400-line page — additive components + a dedupe correctness fix.

## Design

### 1. Source tagging
`Sale` interface gains `source: string`. New `SourceBadge` (module scope):
- `toast` → "⚡ Toast" (gold/auto tint)
- `manual` → "✎ Manual" (neutral)
Shown on day-view rows and the detail panel. Week/month period rows show a source mix
count (e.g. "5 Toast · 2 manual") derived from their contributing dailies.

### 2. Sync-health strip
New band under the KPI cards, scoped to the selected range + active RC:
- **Last Toast sync** = max date among `source==='toast'` rows (no admin call).
- **Coverage** = synced service-days / total days in range; lists missing dates.
- **"Manage in Setup →"** link to `/setup/toast` (sync/backfill live there; not duplicated).
Only meaningful when the active RC has Toast data; hidden/quiet for CATERING-only views.

### 3. Duplicate handling (flag + prefer Toast)
- **Detection:** group sales by `${date}|${revenueCenterId}`; a group with both a
  `toast` and a `manual` entry is a collision.
- **Display:** the manual row in a collision shows a "Duplicate — Toast authoritative"
  flag + one-click **Remove** (existing `DELETE /api/sales/:id`, then refetch).
- **Correctness:** a `dedupedSales` helper keeps, per `(date, rc)`, the `toast` row when
  present (else manual). KPIs, week/month rollups, and Top Items use `dedupedSales`. The
  raw list still renders all rows (flagged) in day view so duplicates are visible/removable.
  This fixes the current double-count bug.

### 4. Manual entry
"Add Sales Day" unchanged except it defaults `revenueCenterId` to the active RC, so opening
it from CATERING pre-selects CATERING. No hard block on manual CAFE days.

### 5. Unchanged
Date-range tabs, 6 KPI cards, Top Items tab, detail panel, Excel Import button + modal.

## Components (all module-scope, per CLAUDE.md)
- `SourceBadge({ source })`
- `SyncHealthStrip({ sales, rangeStart, rangeEnd, activeRc })`
- Dedupe + collision helpers (pure functions): `dedupeSales(sales)`, `findDuplicates(sales)`

## Data flow / error handling
Client-side only. `source` already in the API payload (no explicit select narrows it).
Duplicate removal reuses the existing DELETE + `fetchSales()` refetch. Decimal fields wrapped
in `Number()` as elsewhere.

## Verification
Browser: CAFE this-week shows the Toast row badged ⚡; the 2026-06-26 manual duplicate is
flagged and removable; KPI total doesn't double-count; sync-health shows last sync + gaps.
