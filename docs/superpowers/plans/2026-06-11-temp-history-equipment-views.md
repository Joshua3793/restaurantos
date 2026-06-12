# Temp History — Equipment Views & Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **By day | By equipment** toggle to the Temps → History view (desktop + mobile), where By-equipment shows a per-unit recharts trend chart over the selected range, and make the CSV export view-aware.

**Architecture:** No schema or API changes — the equipment view derives entirely from the existing `GET /api/temps/readings` payload (`HistoryReading[]`). Pure helpers in `temp-utils.ts` compute per-unit chart series + stats and the new export. A shared `TempUnitChart` (recharts) and `TempEquipmentView` (grouping) render in both the desktop History view and the mobile History sheet. The page owns a new `histView` state and branches the export.

**Tech Stack:** Next.js 14 App Router · TypeScript · recharts v3.8.1 (already a dependency) · Tailwind. No test runner in this repo — **verification is `npm run build` (type-check) + preview-server visual checks**.

---

## Verification notes (read first)

- This repo has **no unit-test suite**; `npm run build` is the only automated check. Each task's verification step runs the build (type-check) and, where UI changed, a preview check.
- **The build deadlocks while the preview/dev server is running.** Stop the preview server before `npm run build`, then restart it for visual checks. (`node`/`npm` may not be on PATH — use the project's node install path if `npm` is not found.)
- Commit after each task.

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src/components/temps/temp-utils.ts` | Pure helpers: chart series + stats, equipment CSV, shared CSV download | Modify |
| `src/components/temps/TempUnitChart.tsx` | One unit's recharts chart card + stat chips (shared) | Create |
| `src/components/temps/TempEquipmentView.tsx` | Group units by type, render a `TempUnitChart` per unit (shared) | Create |
| `src/components/temps/TempDesktop.tsx` | Desktop History: By day/By equipment toggle + render equipment view | Modify |
| `src/components/temps/TempMobile.tsx` | Mobile History sheet: toggle + range selector + equipment view | Modify |
| `src/app/temps/page.tsx` | `histView` state, range-aware history load, export branch | Modify |

---

## Task 1: Pure helpers in `temp-utils.ts`

**Files:**
- Modify: `src/components/temps/temp-utils.ts`

Adds `UnitSeriesPoint` / `UnitSeries` types, `computeUnitSeries`, a shared `downloadCSV`, and `exportTempByEquipmentCSV`. Refactors the existing `exportTempCSV` to use `downloadCSV` (DRY).

- [ ] **Step 1: Add series types + `computeUnitSeries`**

Append to `src/components/temps/temp-utils.ts` (after `computeDayMetrics`, before the `TempHandlers` interface or at end of the rollup section — anywhere at module scope):

```ts
// ── per-unit chart series (By equipment view) ────────────────────────────────
export interface UnitSeriesPoint {
  ts: number // sortable timestamp (logDate + time), used only for ordering
  label: string // short x-axis tick, e.g. "2 Jun 14:00"
  logDate: string
  time: string
  temp: number
  safe: boolean | null
}

export interface UnitSeries {
  unit: { id: string; name: string; type: TempType; safeMin: number | null; safeMax: number | null }
  points: UnitSeriesPoint[]
  min: number | null
  max: number | null
  avg: number | null
  outCount: number
  total: number
  pct: number // % of readings in range
}

const seriesLabel = (logDate: string, time: string) =>
  `${new Date(logDate + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`

// Build one chronological point per reading for a single unit, plus rollup stats.
// `history` may contain readings for other units — they are filtered out by unit.id.
export function computeUnitSeries(
  history: HistoryReading[],
  unit: { id: string; name: string; type: TempType; safeMin: number | null; safeMax: number | null },
): UnitSeries {
  const rows = history
    .filter(r => r.unitId === unit.id)
    .sort((a, b) => (a.logDate === b.logDate ? a.time.localeCompare(b.time) : a.logDate.localeCompare(b.logDate)))

  const points: UnitSeriesPoint[] = rows.map(r => ({
    ts: new Date(`${r.logDate}T${r.time}:00`).getTime(),
    label: seriesLabel(r.logDate, r.time),
    logDate: r.logDate,
    time: r.time,
    temp: r.temp,
    safe: isSafe(unit, r.temp),
  }))

  const temps = points.map(p => p.temp)
  const total = points.length
  const outCount = points.filter(p => p.safe === false).length
  return {
    unit,
    points,
    min: total ? Math.min(...temps) : null,
    max: total ? Math.max(...temps) : null,
    avg: total ? Math.round((temps.reduce((s, t) => s + t, 0) / total) * 10) / 10 : null,
    outCount,
    total,
    pct: total ? Math.round(((total - outCount) / total) * 100) : 0,
  }
}
```

- [ ] **Step 2: Extract a shared `downloadCSV` and refactor `exportTempCSV`**

In `src/components/temps/temp-utils.ts`, replace the body of the existing `exportTempCSV` function (the CSV-serialize + Blob/anchor block, lines ~180-197) so the serialization lives in a reusable helper. Add this helper above `exportTempCSV`:

```ts
// Serialize rows → CSV (RFC-4180 quoting), prepend a UTF-8 BOM, trigger download.
function downloadCSV(rows: (string | number)[][], filename: string) {
  const csv = rows
    .map(r =>
      r
        .map(c => {
          const s = String(c)
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
        })
        .join(','),
    )
    .join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}
```

Then make `exportTempCSV` build its rows and delegate:

```ts
export function exportTempCSV(readings: HistoryReading[], filename?: string) {
  const rows: (string | number)[][] = [
    ['Date', 'Unit', 'Type', 'Safe min (°C)', 'Safe max (°C)', 'Time', 'Temp (°C)', 'Status'],
  ]
  const sorted = [...readings].sort((a, b) =>
    a.logDate === b.logDate ? a.time.localeCompare(b.time) : a.logDate.localeCompare(b.logDate),
  )
  sorted.forEach(r => {
    const safe = isSafe(r.unit, r.temp)
    rows.push([
      r.logDate,
      r.unit.name,
      TEMP_TYPES[r.unit.type].label,
      r.unit.safeMin ?? '',
      r.unit.safeMax ?? '',
      r.time,
      fmtTemp(r.temp),
      safe === false ? 'OUT OF RANGE' : 'OK',
    ])
  })
  downloadCSV(rows, filename || `temp-charts-${ymd(new Date())}.csv`)
}
```

(Note: the `'﻿'` BOM literal replaces the existing `'﻿'` literal; behavior is identical.)

- [ ] **Step 3: Add `exportTempByEquipmentCSV`**

Append to `src/components/temps/temp-utils.ts`:

```ts
// Equipment-focused export: a per-unit SUMMARY block, then DETAIL rows grouped
// by unit (group order = TEMP_GROUPS, then unit name). Single CSV file.
export function exportTempByEquipmentCSV(history: HistoryReading[], filename?: string) {
  const byUnit = new Map<string, { unit: HistoryReading['unit']; rows: HistoryReading[] }>()
  history.forEach(r => {
    const g = byUnit.get(r.unitId) ?? { unit: r.unit, rows: [] }
    g.rows.push(r)
    byUnit.set(r.unitId, g)
  })

  const groupRank = (t: TempType) => {
    const i = TEMP_GROUPS.findIndex(g => g.type === t)
    return i === -1 ? TEMP_GROUPS.length : i
  }
  const units = [...byUnit.values()].sort((a, b) =>
    groupRank(a.unit.type) === groupRank(b.unit.type)
      ? a.unit.name.localeCompare(b.unit.name)
      : groupRank(a.unit.type) - groupRank(b.unit.type),
  )

  const rows: (string | number)[][] = []
  rows.push(['SUMMARY'])
  rows.push(['Unit', 'Type', 'Safe range', 'Readings', 'Min (°C)', 'Max (°C)', 'Avg (°C)', 'Out of range', '% OK'])
  units.forEach(({ unit, rows: r }) => {
    const s = computeUnitSeries(r, unit)
    rows.push([
      unit.name,
      TEMP_TYPES[unit.type].label,
      rangeText(unit),
      s.total,
      s.min ?? '',
      s.max ?? '',
      s.avg ?? '',
      s.outCount,
      `${s.pct}%`,
    ])
  })

  rows.push([])
  rows.push(['DETAIL'])
  rows.push(['Unit', 'Type', 'Date', 'Time', 'Temp (°C)', 'Status'])
  units.forEach(({ unit, rows: r }) => {
    [...r]
      .sort((a, b) => (a.logDate === b.logDate ? a.time.localeCompare(b.time) : a.logDate.localeCompare(b.logDate)))
      .forEach(rd => {
        const safe = isSafe(unit, rd.temp)
        rows.push([
          unit.name,
          TEMP_TYPES[unit.type].label,
          rd.logDate,
          rd.time,
          fmtTemp(rd.temp),
          safe === false ? 'OUT OF RANGE' : 'OK',
        ])
      })
  })

  downloadCSV(rows, filename || `temp-by-equipment-${ymd(new Date())}.csv`)
}
```

- [ ] **Step 4: Type-check**

Stop the preview server, then run: `npm run build`
Expected: build succeeds (no type errors). If `npm` is not found, use the project's node install path.

- [ ] **Step 5: Commit**

```bash
git add src/components/temps/temp-utils.ts
git commit -m "feat(temps): add per-unit series + equipment CSV helpers"
```

---

## Task 2: `TempUnitChart` component

**Files:**
- Create: `src/components/temps/TempUnitChart.tsx`

A single small-multiple card: header (unit · type · range), a recharts line chart with a shaded safe band and red out-of-range dots, and stat chips. Pure presentational — takes a `UnitSeries`.

- [ ] **Step 1: Create the component**

Create `src/components/temps/TempUnitChart.tsx`:

```tsx
'use client'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceArea, CartesianGrid,
} from 'recharts'
import { TEMP_TYPES, rangeText, fmtTemp, type UnitSeries } from './temp-utils'

export function TempUnitChart({ series }: { series: UnitSeries }) {
  const { unit, points } = series
  const color = TEMP_TYPES[unit.type].color

  // y-domain padded around the data AND the safe bounds so the band is visible.
  const temps = points.map(p => p.temp)
  const lo = Math.min(...temps, unit.safeMin ?? Infinity, unit.safeMax ?? Infinity)
  const hi = Math.max(...temps, unit.safeMin ?? -Infinity, unit.safeMax ?? -Infinity)
  const pad = Math.max(1, (hi - lo) * 0.15)
  const domain: [number, number] = points.length ? [Math.floor(lo - pad), Math.ceil(hi + pad)] : [0, 10]
  const bandY1 = unit.safeMin ?? domain[0]
  const bandY2 = unit.safeMax ?? domain[1]

  return (
    <div className="bg-paper border border-line rounded-xl p-3.5">
      <div className="flex items-baseline gap-2 mb-2">
        <b className="text-[13.5px] tracking-[-0.01em]">{unit.name}</b>
        <span className="font-mono text-[10px] text-ink-3">{TEMP_TYPES[unit.type].label} · {rangeText(unit)}</span>
      </div>

      {points.length === 0 ? (
        <div className="font-mono text-[10.5px] text-ink-4 text-center py-8">NO READINGS IN RANGE</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={points} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
              <ReferenceArea y1={bandY1} y2={bandY2} fill="#22c55e" fillOpacity={0.1} stroke="none" />
              <XAxis dataKey="label" tick={{ fontSize: 9 }} interval="preserveStartEnd" minTickGap={28} />
              <YAxis domain={domain} tick={{ fontSize: 9 }} width={34} unit="°" allowDecimals={false} />
              <Tooltip
                formatter={(v: number) => [`${fmtTemp(v)}°C`, 'Temp']}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
              <Line
                type="monotone"
                dataKey="temp"
                stroke={color}
                strokeWidth={1.6}
                isAnimationActive={false}
                dot={(props: { cx?: number; cy?: number; index?: number }) => {
                  const i = props.index ?? 0
                  const bad = points[i]?.safe === false
                  return (
                    <circle
                      key={i}
                      cx={props.cx}
                      cy={props.cy}
                      r={bad ? 3.2 : 2}
                      fill={bad ? '#dc2626' : color}
                      stroke="none"
                    />
                  )
                }}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>

          <div className="flex gap-1.5 mt-2 flex-wrap">
            <Chip>min {fmtTemp(series.min)}°</Chip>
            <Chip>max {fmtTemp(series.max)}°</Chip>
            <Chip>avg {fmtTemp(series.avg)}°</Chip>
            {series.outCount > 0 ? (
              <Chip tone="bad">{series.outCount} out of range</Chip>
            ) : (
              <Chip tone="ok">all OK</Chip>
            )}
            <Chip>{series.pct}% OK</Chip>
          </div>
        </>
      )}
    </div>
  )
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: 'ok' | 'bad' }) {
  const cls =
    tone === 'bad'
      ? 'bg-red-soft text-red-text'
      : tone === 'ok'
        ? 'bg-green-soft text-green-text'
        : 'bg-bg-2 text-ink-3'
  return <span className={`font-mono text-[9.5px] px-2 py-[3px] rounded-full ${cls}`}>{children}</span>
}
```

- [ ] **Step 2: Type-check**

Stop the preview server, then run: `npm run build`
Expected: build succeeds. (The component is unused so far — this confirms it type-checks against recharts + `UnitSeries`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/temps/TempUnitChart.tsx
git commit -m "feat(temps): add TempUnitChart trend card"
```

---

## Task 3: `TempEquipmentView` component

**Files:**
- Create: `src/components/temps/TempEquipmentView.tsx`

Groups the shown units by type (Refrigeration → Freezers → Hot holding) and renders a `TempUnitChart` per unit. Shared by both renderers.

- [ ] **Step 1: Create the component**

Create `src/components/temps/TempEquipmentView.tsx`:

```tsx
'use client'
import { TEMP_GROUPS, groupOf, computeUnitSeries, type TempUnit, type HistoryReading } from './temp-utils'
import { TempUnitChart } from './TempUnitChart'

export function TempEquipmentView({
  units,
  history,
  histUnit,
}: {
  units: TempUnit[]
  history: HistoryReading[]
  histUnit?: string
}) {
  const shown = units.filter(u => !histUnit || u.id === histUnit)
  const groups = TEMP_GROUPS.map(g => ({
    ...g,
    units: shown.filter(u => groupOf(u.type) === g.key),
  })).filter(g => g.units.length > 0)

  if (shown.length === 0) {
    return <div className="text-center py-[60px] font-mono text-[11px] text-ink-4">NO UNITS</div>
  }

  return (
    <div className="space-y-6">
      {groups.map(g => (
        <div key={g.key}>
          <p className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em] mb-2.5 px-0.5">{g.title}</p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {g.units.map(u => (
              <TempUnitChart key={u.id} series={computeUnitSeries(history, u)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

Stop the preview server, then run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/temps/TempEquipmentView.tsx
git commit -m "feat(temps): add TempEquipmentView small-multiples grid"
```

---

## Task 4: Page state — `histView`, range-aware load, export branch

**Files:**
- Modify: `src/app/temps/page.tsx`

Adds `histView` state, makes history loading accept a range override (so the mobile range selector can fetch immediately without a stale-closure read), branches the export, and passes the new props to both renderers.

- [ ] **Step 1: Import the equipment export + add `histView` state**

In `src/app/temps/page.tsx`, update the `temp-utils` import to add `exportTempByEquipmentCSV`:

```ts
import {
  computeDayMetrics, exportTempCSV, exportTempByEquipmentCSV, ymd,
  type TempUnit, type TempHandlers, type HistoryReading,
} from '@/components/temps/temp-utils'
```

Add the state next to the other history state (after the `histRange` line ~32):

```ts
  const [histView, setHistView] = useState<'day' | 'equipment'>('day')
```

- [ ] **Step 2: Make `loadHistory` / `ensureHistory` accept a range override**

Replace the existing `loadHistory` useCallback (lines ~57-76) with a version that accepts an optional range argument:

```ts
  const loadHistory = useCallback(async (rangeArg?: string) => {
    setHistLoading(true)
    try {
      const days = Number(rangeArg ?? histRange)
      const qs = new URLSearchParams()
      if (rcId) qs.set('rcId', rcId)
      if (days > 0) {
        const c = new Date()
        c.setDate(c.getDate() - days + 1)
        qs.set('from', ymd(c))
      }
      const res = await fetch(`/api/temps/readings?${qs.toString()}`)
      const data = await res.json()
      setHistory(Array.isArray(data) ? data : [])
    } catch {
      /* noop */
    } finally {
      setHistLoading(false)
    }
  }, [rcId, histRange])
```

Replace `ensureHistory` (lines ~84-86) to forward the override:

```ts
  // mobile: load on demand when the history sheet opens (optionally with a new range)
  const ensureHistory = useCallback((rangeArg?: string) => {
    loadHistory(rangeArg)
  }, [loadHistory])
```

(The desktop effect `useEffect(() => { if (view === 'history') loadHistory() }, [view, loadHistory])` is unchanged — `loadHistory`'s identity still changes when `histRange` changes, so desktop reloads as before.)

- [ ] **Step 3: Branch the export on `histView`**

Replace the `onExport` function (lines ~141-151) with:

```ts
  // Export the full record (independent of the History filter window). Shape
  // follows the active History sub-view: daily readings vs equipment-focused.
  const onExport = async () => {
    try {
      const qs = new URLSearchParams()
      if (rcId) qs.set('rcId', rcId)
      const res = await fetch(`/api/temps/readings?${qs.toString()}`)
      const data: HistoryReading[] = await res.json()
      const list = Array.isArray(data) ? data : []
      if (histView === 'equipment') exportTempByEquipmentCSV(list)
      else exportTempCSV(list)
    } catch {
      showToast('Export failed — try again')
    }
  }
```

- [ ] **Step 4: Pass new props to both renderers**

In the `<TempDesktop … />` JSX (lines ~155-173), add after `setHistRange={setHistRange}`:

```tsx
        histView={histView}
        setHistView={setHistView}
```

In the `<TempMobile … />` JSX (lines ~175-185), add after `history={history}`:

```tsx
        histView={histView}
        setHistView={setHistView}
        histRange={histRange}
        setHistRange={setHistRange}
```

(`TempMobile` already receives `ensureHistory` and `onExport`.)

- [ ] **Step 5: Type-check**

This will FAIL until Tasks 5 and 6 add the new props to the component prop types — that is expected. Stop the preview server, then run: `npm run build`
Expected: type errors on `histView`/`setHistView`/`histRange`/`setHistRange` props for `TempDesktop`/`TempMobile`. Proceed to Task 5 (do not commit yet).

---

## Task 5: Desktop — toggle + equipment view in History

**Files:**
- Modify: `src/components/temps/TempDesktop.tsx`

- [ ] **Step 1: Add props + import**

In `src/components/temps/TempDesktop.tsx`, add to the `temp-utils` import (line ~6-10) `computeUnitSeries` is NOT needed here; add the component import below the existing imports (after line 10):

```tsx
import { TempEquipmentView } from './TempEquipmentView'
```

Add to `TempDesktopProps` (after `histRange` / `setHistRange`, ~line 40):

```ts
  histView: 'day' | 'equipment'
  setHistView: (v: 'day' | 'equipment') => void
```

- [ ] **Step 2: Add the segmented toggle + branch in `HistoryView`**

In `HistoryView` (starts ~line 476), replace the filter row `<div className="flex items-center gap-2.5 mb-4">…</div>` (lines ~488-503) with a version that adds the By day/By equipment segmented control as the first element:

```tsx
      <div className="flex items-center gap-2.5 mb-4">
        <div className="inline-flex rounded-[9px] border border-line bg-paper p-0.5">
          <SubToggle active={p.histView === 'day'} onClick={() => p.setHistView('day')}>By day</SubToggle>
          <SubToggle active={p.histView === 'equipment'} onClick={() => p.setHistView('equipment')}>By equipment</SubToggle>
        </div>
        <select value={p.histUnit} onChange={e => p.setHistUnit(e.target.value)} className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 outline-none cursor-pointer">
          <option value="">All units</option>
          {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select value={p.histRange} onChange={e => p.setHistRange(e.target.value)} className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 outline-none cursor-pointer">
          <option value="7">Last 7 days</option>
          <option value="14">Last 14 days</option>
          <option value="30">Last 30 days</option>
          <option value="0">All time</option>
        </select>
        <span className="flex-1" />
        <button onClick={p.onExport} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] text-[13px] font-medium border border-line bg-paper text-ink-2 hover:border-ink-3">
          <Download size={13} className="text-ink-3" /> Export Excel
        </button>
      </div>
```

Then, immediately after that filter row and before the `{p.histLoading ? (…)}` block, add the equipment branch. Wrap the existing loading/empty/day-table block so it only renders in `day` mode. Concretely, change:

```tsx
      {p.histLoading ? (
```

to:

```tsx
      {p.histView === 'equipment' ? (
        p.histLoading ? (
          <div className="text-center py-16 font-mono text-[11px] text-ink-4">LOADING…</div>
        ) : (
          <TempEquipmentView units={units} history={history} histUnit={p.histUnit} />
        )
      ) : p.histLoading ? (
```

The remainder of the existing day-mode rendering (the `dates.length === 0 ? … : dates.map(…)`) stays unchanged after this point.

- [ ] **Step 3: Add the `SubToggle` helper**

Add near the `Tab` helper (after line ~140) in `src/components/temps/TempDesktop.tsx`:

```tsx
function SubToggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-[7px] text-[12.5px] font-medium transition-colors ${
        active ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'
      }`}
    >
      {children}
    </button>
  )
}
```

- [ ] **Step 4: Type-check**

Stop the preview server, then run: `npm run build`
Expected: desktop type errors resolved. (Mobile prop errors from Task 4 may remain — fixed in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add src/app/temps/page.tsx src/components/temps/TempDesktop.tsx
git commit -m "feat(temps): By day/By equipment toggle + charts in desktop History"
```

---

## Task 6: Mobile — toggle + range selector + equipment view

**Files:**
- Modify: `src/components/temps/TempMobile.tsx`

- [ ] **Step 1: Add props + import**

In `src/components/temps/TempMobile.tsx`, add the import after the existing imports (after line ~9):

```tsx
import { TempEquipmentView } from './TempEquipmentView'
```

Add to the `TempMobile` props type (the `MobileProps`-style interface/inline type around lines ~20-28 — locate the object containing `history`, `histLoading`, `ensureHistory`, `onExport`) these fields:

```ts
  histView: 'day' | 'equipment'
  setHistView: (v: 'day' | 'equipment') => void
  histRange: string
  setHistRange: (v: string) => void
```

- [ ] **Step 2: Thread the new props into `HistoryBody`**

Find where the history sheet renders `HistoryBody` (line ~114):

```tsx
          <HistoryBody units={units} history={p.history} loading={p.histLoading} today={p.today} onExport={p.onExport} />
```

Replace with:

```tsx
          <HistoryBody
            units={units}
            history={p.history}
            loading={p.histLoading}
            today={p.today}
            onExport={p.onExport}
            histView={p.histView}
            setHistView={p.setHistView}
            histRange={p.histRange}
            setHistRange={p.setHistRange}
            ensureHistory={p.ensureHistory}
          />
```

- [ ] **Step 3: Update `HistoryBody` signature + add toggle, range selector, and equipment branch**

Replace the `HistoryBody` function signature (line ~383) with:

```tsx
function HistoryBody({
  units, history, loading, today, onExport, histView, setHistView, histRange, setHistRange, ensureHistory,
}: {
  units: TempUnit[]
  history: HistoryReading[]
  loading: boolean
  today: string
  onExport: () => void
  histView: 'day' | 'equipment'
  setHistView: (v: 'day' | 'equipment') => void
  histRange: string
  setHistRange: (v: string) => void
  ensureHistory: (rangeArg?: string) => void
}) {
```

Then, inside `HistoryBody`, immediately after the unit-pills row `</div>` (the `flex gap-1.5 overflow-x-auto …` block ends ~line 403) and before the Export button, insert the segmented toggle + range selector:

```tsx
      <div className="flex items-center gap-2 mt-3">
        <div className="inline-flex rounded-[9px] border border-line bg-paper p-0.5">
          <button
            onClick={() => setHistView('day')}
            className={`px-3 py-1.5 rounded-[7px] text-[12.5px] font-medium ${histView === 'day' ? 'bg-ink text-paper' : 'text-ink-3'}`}
          >By day</button>
          <button
            onClick={() => setHistView('equipment')}
            className={`px-3 py-1.5 rounded-[7px] text-[12.5px] font-medium ${histView === 'equipment' ? 'bg-ink text-paper' : 'text-ink-3'}`}
          >By equipment</button>
        </div>
        <select
          value={histRange}
          onChange={e => { setHistRange(e.target.value); ensureHistory(e.target.value) }}
          className="ml-auto bg-paper border border-line rounded-[9px] px-2.5 py-1.5 text-[12.5px] text-ink-2 outline-none"
        >
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
          <option value="0">All</option>
        </select>
      </div>
```

Then replace the content branch. Change:

```tsx
      {loading ? (
        <div className="font-mono text-[11px] text-ink-4 text-center py-10">LOADING…</div>
      ) : dates.length === 0 ? (
```

to:

```tsx
      {histView === 'equipment' ? (
        loading ? (
          <div className="font-mono text-[11px] text-ink-4 text-center py-10">LOADING…</div>
        ) : (
          <div className="mt-3">
            <TempEquipmentView units={units} history={history} histUnit={unit} />
          </div>
        )
      ) : loading ? (
        <div className="font-mono text-[11px] text-ink-4 text-center py-10">LOADING…</div>
      ) : dates.length === 0 ? (
```

The rest of the day-mode rendering (`dates.map(…)`) stays unchanged. (`unit` is the existing local pill-filter state in `HistoryBody`, reused as `histUnit` for the equipment view.)

- [ ] **Step 4: Type-check**

Stop the preview server, then run: `npm run build`
Expected: build succeeds with no type errors (all Task 4 prop errors now resolved).

- [ ] **Step 5: Commit**

```bash
git add src/components/temps/TempMobile.tsx
git commit -m "feat(temps): By day/By equipment toggle + charts in mobile History"
```

---

## Task 7: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Build passes**

Stop the preview server, then run: `npm run build`
Expected: success; `/temps` route still listed. Restart the preview server afterward.

- [ ] **Step 2: Desktop visual check**

Open the preview at `/temps` (desktop width ≥ 1024). Click the **History** tab, then toggle **By equipment**. Verify:
- One chart card per active unit, grouped Refrigeration → Freezers → Hot holding.
- Each chart shows a green shaded safe band; any out-of-range reading is a red dot.
- Stat chips show min / max / avg / out-of-range / % OK.
- Unit dropdown filters to a single card; range selector (7/14/30/all) changes the window.
- Toggle back to **By day** — the original day-grouped tables are unchanged.

Use `preview_console_logs` (level error) to confirm no runtime errors.

- [ ] **Step 3: Export check (both views)**

- In **By equipment**, click **Export Excel** → downloads `temp-by-equipment-<date>.csv` with a SUMMARY block (one row per unit) and a DETAIL block grouped by unit.
- In **By day**, click **Export Excel** → downloads the existing flat readings CSV.

- [ ] **Step 4: Mobile visual check**

`preview_resize` to mobile (375×812). Open `/temps`, tap **History**. Verify the By day/By equipment toggle and range selector appear in the sheet; **By equipment** stacks chart cards; changing the range reloads; **By day** is unchanged.

- [ ] **Step 5: Final commit (if any verification fixes were made)**

```bash
git add -A
git commit -m "fix(temps): verification fixes for equipment views"
```

(Skip if no changes were needed.)

---

## Self-review notes

- **Spec coverage:** By day/By equipment toggle (Tasks 5,6) ✓; per-unit charts, every reading + red excursions + safe band (Task 2) ✓; week/month range (existing selector, threaded to mobile in Tasks 4,6) ✓; grouped small-multiples ordered by type (Task 3) ✓; view-aware export with summary + grouped detail (Tasks 1,4) ✓; both renderers (Tasks 5,6) ✓; no schema/API change ✓.
- **Type consistency:** `histView: 'day' | 'equipment'` used identically in page, `TempDesktop`, `TempMobile`. `computeUnitSeries(history, unit)` and `exportTempByEquipmentCSV(history, filename?)` signatures match all call sites. `UnitSeries` produced by `computeUnitSeries`, consumed by `TempUnitChart`.
- **No placeholders:** every code step contains full code.
- **Note vs spec:** `exportTempByEquipmentCSV` takes `(history, filename?)` (groups from the readings' own `unit` metadata) rather than the spec's `(history, units)` — the export reflects exactly what was logged in range; no behavioral difference for active units.
