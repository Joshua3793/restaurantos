# Temp History — equipment views & charts

**Date:** 2026-06-11
**Status:** Approved design (pending spec review)
**Surface:** `/temps` → History tab (desktop + mobile)

## Problem

The Temps History view today groups readings **by day** as flat tables. There's no
way to see how a single piece of equipment (or a hot-held food item) has behaved
*over time* — you can't spot a fridge that keeps drifting warm, or review a week/
month of a unit at a glance. Export is a single flat readings dump.

## Goal

Add a **By equipment** view alongside the existing **By day** view in History, with
a per-unit trend **chart** (week / month / etc.), and make the Excel/CSV export
**view-aware** so it can produce either the daily-readings record or an
equipment-focused record.

## Scope & decisions

- **"Product" = hot-hold units.** Hot-holding `TempUnit`s already represent specific
  foods being held. No new data model; everything stays per `TempUnit`
  (fridge / freezer / hot-hold). Fridges/freezers/hot-holds all flow through the
  same equipment view.
- **Location:** entirely within Temps → History. **No** new `/reports` sub-page.
- **Chart data:** plot **every reading** chronologically; out-of-range points marked
  red. (Not daily-averaged — averaging can hide brief excursions, which matters for
  food safety.)
- **Equipment export:** per-unit **summary block** + **detail rows grouped by unit**.
- **Both renderers:** desktop and mobile both get the toggle + charts (dual-renderer
  pattern). Chart card component is shared.

Out of scope: probe/product temperature logging as a new model; a `/reports` page;
real multi-sheet `.xlsx` (stay with the existing BOM'd CSV approach).

## Data — no schema changes

Uses existing models:
- `TempUnit { id, name, type: FRIDGE|FREEZER|HOT, safeMin?, safeMax?, revenueCenterId?, isActive, sortOrder }`
- `TempReading { id, unitId, logDate 'YYYY-MM-DD', time 'HH:MM', temp, recordedBy?, createdAt }`

Existing `GET /api/temps/readings?rcId=&from=&to=&unitId=` already returns the flat
`HistoryReading[]` (each carries its unit's name/type/safeMin/safeMax) the new view
needs. **No API changes required** — the equipment view derives everything client-side
from the same history payload that By-day already loads, honoring the existing
range selector (7/14/30/all) and unit filter.

## Components & boundaries

### `src/components/temps/temp-utils.ts` — pure helpers (add)

```ts
// One chronological point per reading, plus rollup stats for one unit.
interface UnitSeriesPoint { ts: number; label: string; logDate: string; time: string; temp: number; safe: boolean | null }
interface UnitSeries {
  unit: HistoryReading['unit']
  points: UnitSeriesPoint[]
  min: number | null; max: number | null; avg: number | null
  outCount: number; total: number; pct: number   // pct = % of readings in range
}
function computeUnitSeries(history: HistoryReading[], unit): UnitSeries
```

- `ts` is a sortable timestamp built from `logDate + 'T' + time` for the x-axis;
  `label` is a short human axis tick (e.g. `2 Jun` or `2 Jun 14:00`).
- Reuses existing `isSafe`, `fmtTemp`, `rangeText`, `TEMP_TYPES`, `groupOf`.

```ts
// Equipment-focused CSV: summary block, blank line, detail grouped by unit.
function exportTempByEquipmentCSV(history: HistoryReading[], units: TempUnit[], filename?): void
```

CSV shape (single file, UTF-8 BOM, opens in Excel):

```
SUMMARY
Unit, Type, Safe range, Readings, Min (°C), Max (°C), Avg (°C), Out of range, % OK
Walk-in Fridge, Fridge, 0–4°C, 42, 1.2, 5.1, 3.0, 1, 98%
...

DETAIL
Unit, Type, Date, Time, Temp (°C), Status
Walk-in Fridge, Fridge, 2026-06-05, 08:00, 3.1, OK
...   (sorted by unit, then date, then time)
```

The existing `exportTempCSV` (flat by-day record) stays unchanged for the By-day view.

### `src/components/temps/TempUnitChart.tsx` — single chart card (new, shared)

- Props: `series: UnitSeries`. Renders one small-multiple card:
  header (unit name · type label · `rangeText`), a recharts `LineChart` in a
  `ResponsiveContainer`, and stat chips (min / max / avg / out / % OK).
- Safe band: `ReferenceArea y1={safeMin} y2={safeMax}` (one-sided when a bound is
  null — clamp to chart domain). Out-of-range points: custom `dot` renderer colors
  `safe === false` red; in-range use the type color from `TEMP_TYPES`.
- Empty state when `points.length === 0`.
- Uses recharts (already a dependency, v3.8.1) following the
  `src/components/wastage/WastageCharts.tsx` pattern.

### `src/components/temps/TempEquipmentView.tsx` — small-multiples list (new, shared)

- Props: `units`, `history`, `histUnit` (filter). Filters to active units (optionally
  a single selected unit), groups/orders by `TEMP_GROUPS` (Refrigeration → Freezers
  → Hot holding), and renders a `TempUnitChart` per unit via `computeUnitSeries`.
- Used by both renderers: desktop renders it inline in History; mobile renders it
  inside the History `Sheet`.

### `src/components/temps/TempDesktop.tsx` — wire toggle (edit)

- In the History view, add a **By day | By equipment** segmented toggle next to the
  existing unit/range selectors.
- When `histView === 'equipment'`, render `<TempEquipmentView … />` instead of the
  day-grouped tables. Export button calls the same `onExport` (page branches).

### `src/components/temps/TempMobile.tsx` — wire toggle (edit)

- Add the same **By day | By equipment** segmented toggle inside the History `Sheet`
  (`HistoryBody`). Equipment mode stacks `TempUnitChart` cards.
- Add a compact **range selector** (7/14/30/all) to the mobile History sheet — today
  the sheet has none and silently uses the default 7 days; week/month review needs it.
  This sets the same `histRange` the page already owns.

### `src/app/temps/page.tsx` — state + export branch (edit)

- Add `histView: 'day' | 'equipment'` state (default `'day'`); pass `histView` /
  `setHistView` to both `TempDesktop` and `TempMobile`.
- `onExport` branches: `histView === 'equipment'` →
  `exportTempByEquipmentCSV(data, units)`; else existing `exportTempCSV(data)`.
  (Both still fetch the full record for the current RC, independent of filter window,
  as today.)

## Data flow

```
page.tsx (rcId, histRange, histUnit, histView)
  └─ GET /api/temps/readings?rcId=&from=  → HistoryReading[]  (unchanged)
       ├─ By day  → existing day-grouped tables
       └─ By equipment → TempEquipmentView
              → computeUnitSeries(history, unit) per unit → TempUnitChart (recharts)
  └─ onExport → branch on histView → exportTempCSV | exportTempByEquipmentCSV
```

## Error handling & edge cases

- **No readings in range:** view-level empty state (mirrors current By-day empty
  state); per-unit empty state inside a card if one unit has none.
- **One-sided safe range** (e.g. HOT `safeMax = null`): draw the band from the bound
  to the chart edge; export shows the open bound as today (`≥ 63°C`).
- **Decimal serialization:** API already coerces Prisma `Decimal` → JS number; helpers
  assume numbers (consistent with existing temp-utils).
- **Single reading:** chart renders a single dot (line needs ≥1 point); stats still compute.
- **RC scoping:** unchanged — readings already filtered by `rcId` (incl. shared `null`).

## Testing / verification

No automated test suite in this repo. Verify via `npm run build` (type-check) and the
preview server:
- By day view unchanged; By equipment shows one chart per unit, correctly grouped/scaled.
- Out-of-range readings render red points; safe band matches each unit's range.
- Range selector (7/14/30/all) and unit filter drive both views.
- Export: By-day produces the existing CSV; By-equipment produces summary + grouped detail.
- Mobile: toggle + stacked charts + range selector in the History sheet.
```
