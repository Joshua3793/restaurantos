# Prep Stations — Design Spec

**Date:** 2026-05-21

## Goal

Make stations a first-class concept on the Prep List page: every prep item can display its station, users can filter by station, and plan mode can group items by station. Station creation and modification work correctly via Prep Settings.

---

## Background

`PrepItem.station` is a nullable `String` field. `PrepSettings.stations` holds the list of valid station names (stored as `text[]` in PostgreSQL). The settings API and modal already exist. The three gaps are:

1. No station badge visible on prep item rows
2. No station filter on the page
3. Plan mode only groups Flat or By Category — no By Station option

---

## Architecture

All changes are confined to:

- `src/app/prep/page.tsx` — filter state, grouping logic, loadSettings
- `src/components/prep/PrepItemRow.tsx` — station badge
- `src/components/prep/PrepSettingsModal.tsx` — `onSaved` already wired; no changes needed here

No schema changes, no new API routes.

---

## Feature 1 — Station Badge on PrepItemRow

### What

A small coloured pill showing the station name appears on each row, in both today-mode and plan-mode renderers.

### Where

`src/components/prep/PrepItemRow.tsx` — the badge sits inline with the item name (or just below it on mobile) wherever the category badge is currently displayed. The pattern mirrors the existing category badge.

### Behaviour

- If `item.station` is `null` or `""`: no badge rendered (never show "Unassigned" on the row itself).
- Badge text: `item.station` value verbatim.
- Styling: `bg-blue-50 text-blue-700 text-[10px] font-medium px-1.5 py-0.5 rounded-full` — visually distinct from the amber category badge.

---

## Feature 2 — Station Filter

### State

```ts
const [filterStation, setFilterStation] = useState<'ALL' | 'UNASSIGNED' | string>('ALL')
```

Initialises to `'ALL'`.

### Filter logic (applied alongside existing `filterCategory` and search)

```ts
const stationMatch =
  filterStation === 'ALL'      ? true
  : filterStation === 'UNASSIGNED' ? (!item.station || item.station.trim() === '')
  : item.station === filterStation
```

The three filters (search, category, station) are ANDed.

### Desktop filter bar

A `<select>` added to the existing filter bar (between the category filter and the Grouped/Flat toggle):

```
All Stations | Unassigned | <station names from settings.stations>
```

Class identical to the existing `categoryFilter` select: `border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold bg-white`

### Mobile filter sheet

A station row added to the existing mobile filter sheet below the category row, same chip-button style.

### Settings reload

Add a `loadSettings` function to `src/app/prep/page.tsx`:

```ts
async function loadSettings() {
  try {
    const res = await fetch('/api/prep/settings')
    if (res.ok) {
      const data = await res.json()
      setStations((data.stations ?? []).filter(Boolean))
    }
  } catch { /* silent — degrades gracefully */ }
}
```

Call `loadSettings()` inside the `useEffect` on mount, and pass it as the `onSaved` callback to `PrepSettingsModal` (replacing or supplementing the existing callback).

---

## Feature 3 — "By Station" Grouping in Plan Mode

### Current state

Plan mode has a two-way toggle: **Flat** | **By Category**. Controlled by `groupBy: 'flat' | 'category'`.

### New state

Extend to three-way: `groupBy: 'flat' | 'category' | 'station'`

### Toggle UI

Three buttons in the existing toggle strip (desktop and mobile plan-mode header), same styling as the current two:

```
Flat | By Category | By Station
```

### Grouping logic

When `groupBy === 'station'`:

1. Items are bucketed by `item.station`.
2. Bucket order follows `settings.stations` array order.
3. Items with `null` or `""` station go into a final **"Unassigned"** bucket, rendered at the bottom.
4. Each bucket renders with a section header (same style as category group headers).
5. Empty buckets (station in settings but no items) are not rendered.

### Interaction with filter

Station grouping is independent of the station filter. A user can show only items for "Grill" via the filter, then group By Station — they will see one group: "Grill". This is correct and consistent.

---

## Data Flow

```
mount → loadSettings() → setState({ stations })
                                       ↓
               filter bar renders station <select> with settings.stations
               plan mode "By Station" groups follow settings.stations order

PrepSettingsModal.onSaved → loadSettings() re-runs → filter list and groups update
```

---

## Error Handling

- `loadSettings()` failure: silently degrades — `stations` stays `[]`, filter select shows only "All Stations" and "Unassigned", plan mode "By Station" groups only an "Unassigned" bucket.
- No new error states visible to the user for the filter/grouping itself; the existing prep-page error state covers API failures.

---

## Out of Scope

- Bulk-assigning stations to multiple items at once.
- Reordering stations from the prep page (only from Prep Settings).
- Colour-coding stations (beyond the fixed blue badge).
