# Prep Stations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make stations visible on every prep row, filterable from the page header, and groupable in Plan mode — and keep the station list in sync after settings save.

**Architecture:** All changes are confined to two files: `PrepItemRow.tsx` (badges) and `prep/page.tsx` (state, filter logic, grouping logic, settings fetch, and UI). No schema or API changes required.

**Tech Stack:** Next.js 14 App Router, React hooks (useState/useMemo/useCallback/useEffect), TypeScript, Tailwind CSS.

---

## File Map

| File | What changes |
|---|---|
| `src/components/prep/PrepItemRow.tsx` | Add station badge to plan-mode Row 2 and today-mode subtitle |
| `src/app/prep/page.tsx` | Add `stations` + `filterStation` state, `loadSettings()`, update `filtered` memo, update `planGroups` memo, extend `planSort` to `'station'`, update filter UI, update sort toggle, update `onSaved` |

---

## Task 1: Station badge on PrepItemRow

**Files:**
- Modify: `src/components/prep/PrepItemRow.tsx:146-201` (plan mode row)
- Modify: `src/components/prep/PrepItemRow.tsx:257-303` (today mode name block)

There is no automated test suite. Verification is: `npm run build` passes, then manual visual check in browser.

- [ ] **Step 1: Add station badge to plan-mode Row 2**

Open `src/components/prep/PrepItemRow.tsx`. Find the plan-mode Row 2 block at line ~180. It currently reads:

```tsx
{/* Row 2: stock + priority chips */}
<div className="flex items-center gap-2 mt-1.5 pl-9">
  <span className="shrink-0 text-xs text-gray-400">
    {item.onHand % 1 === 0 ? item.onHand.toFixed(0) : item.onHand.toFixed(1)}
    <span className="text-gray-300">/{item.parLevel % 1 === 0 ? item.parLevel.toFixed(0) : item.parLevel.toFixed(1)} {item.unit}</span>
  </span>

  <div className="flex items-center gap-1 ml-auto" onClick={e => e.stopPropagation()}>
```

Replace it with:

```tsx
{/* Row 2: stock + station badge + priority chips */}
<div className="flex items-center gap-2 mt-1.5 pl-9">
  <span className="shrink-0 text-xs text-gray-400">
    {item.onHand % 1 === 0 ? item.onHand.toFixed(0) : item.onHand.toFixed(1)}
    <span className="text-gray-300">/{item.parLevel % 1 === 0 ? item.parLevel.toFixed(0) : item.parLevel.toFixed(1)} {item.unit}</span>
  </span>
  {item.station && (
    <span className="shrink-0 text-[10px] font-medium bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded-full">
      {item.station}
    </span>
  )}

  <div className="flex items-center gap-1 ml-auto" onClick={e => e.stopPropagation()}>
```

- [ ] **Step 2: Add station badge to today-mode name block**

In the same file, find the today-mode "Name + status label" block at line ~276. It currently reads:

```tsx
{/* Name + status label for completed, suggested qty for active */}
<div className="flex-1 min-w-0 cursor-pointer" onClick={onClick}>
  <div className={`text-sm font-medium truncate ${isDone ? 'text-green-900' : isPartial ? 'text-yellow-900' : 'text-gray-800'}`}>
    {item.name}
  </div>
  {isCompleted ? (
```

Replace it with:

```tsx
{/* Name + station badge + status label for completed, suggested qty for active */}
<div className="flex-1 min-w-0 cursor-pointer" onClick={onClick}>
  <div className={`text-sm font-medium truncate ${isDone ? 'text-green-900' : isPartial ? 'text-yellow-900' : 'text-gray-800'}`}>
    {item.name}
  </div>
  {item.station && (
    <span className="text-[10px] font-medium bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded-full mt-0.5 inline-block">
      {item.station}
    </span>
  )}
  {isCompleted ? (
```

- [ ] **Step 3: Verify build passes**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
npm run build 2>&1 | tail -20
```

Expected: `✓ Compiled successfully` with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/components/prep/PrepItemRow.tsx
git commit -m "feat(prep): add station badge to today and plan mode rows

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Load settings and add station + filter state to prep page

**Files:**
- Modify: `src/app/prep/page.tsx`

- [ ] **Step 1: Add `stations` and `filterStation` state declarations**

Open `src/app/prep/page.tsx`. Find the Filters state block at line ~42:

```ts
// Filters
const [search,         setSearch]         = useState('')
const [filterPriority, setFilterPriority] = useState('ALL')
const [filterStatus,   setFilterStatus]   = useState('ALL')
const [filterCategory, setFilterCategory] = useState('ALL')
const [activeOnly,     setActiveOnly]     = useState(true)
const [viewMode,       setViewMode]       = useState<'today' | 'plan' | 'history'>('today')
```

Replace it with:

```ts
// Filters
const [search,         setSearch]         = useState('')
const [filterPriority, setFilterPriority] = useState('ALL')
const [filterStatus,   setFilterStatus]   = useState('ALL')
const [filterCategory, setFilterCategory] = useState('ALL')
const [filterStation,  setFilterStation]  = useState<'ALL' | 'UNASSIGNED' | string>('ALL')
const [activeOnly,     setActiveOnly]     = useState(true)
const [viewMode,       setViewMode]       = useState<'today' | 'plan' | 'history'>('today')

// Settings — station list for filter dropdown and plan grouping
const [stations, setStations] = useState<string[]>([])
```

- [ ] **Step 2: Add `loadSettings` function**

Find the `load` callback (starts at line ~59). Directly after its closing `}, [activeOnly])`, add:

```ts
const loadSettings = useCallback(async () => {
  try {
    const res = await fetch('/api/prep/settings')
    if (res.ok) {
      const data = await res.json()
      setStations((data.stations ?? []).filter(Boolean))
    }
  } catch { /* silent degradation — stations stays [] */ }
}, [])
```

- [ ] **Step 3: Call `loadSettings` on mount and after settings save**

Find the mount `useEffect` at line ~89:

```ts
useEffect(() => {
  // Initialise offline state and any pending mutations left from a previous session
  setIsOffline(!navigator.onLine)
  setPendingCount(loadQueue().length)
  load()
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [])
```

Replace it with:

```ts
useEffect(() => {
  // Initialise offline state and any pending mutations left from a previous session
  setIsOffline(!navigator.onLine)
  setPendingCount(loadQueue().length)
  load()
  loadSettings()
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [])
```

Find the `PrepSettingsModal` render at line ~990:

```tsx
{showSettings && (
  <PrepSettingsModal
    onClose={() => setShowSettings(false)}
    onSaved={() => { load(); setShowSettings(false) }}
  />
)}
```

Replace it with:

```tsx
{showSettings && (
  <PrepSettingsModal
    onClose={() => setShowSettings(false)}
    onSaved={() => { load(); loadSettings(); setShowSettings(false) }}
  />
)}
```

- [ ] **Step 4: Verify build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
npm run build 2>&1 | tail -20
```

Expected: `✓ Compiled successfully`.

- [ ] **Step 5: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/prep/page.tsx
git commit -m "feat(prep): add stations state and loadSettings — syncs on mount and after settings save

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Station filter — logic and UI

**Files:**
- Modify: `src/app/prep/page.tsx`

- [ ] **Step 1: Add station filter to `filtered` memo**

Find the `filtered` useMemo at line ~161:

```ts
const filtered = useMemo(() => items.filter(item => {
  if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
  if (filterPriority !== 'ALL' && item.priority !== filterPriority)     return false
  if (filterCategory !== 'ALL' && item.category !== filterCategory)     return false

  if (viewMode === 'plan') {
```

Replace it with:

```ts
const filtered = useMemo(() => items.filter(item => {
  if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
  if (filterPriority !== 'ALL' && item.priority !== filterPriority)     return false
  if (filterCategory !== 'ALL' && item.category !== filterCategory)     return false
  if (filterStation === 'UNASSIGNED') {
    if (item.station && item.station.trim() !== '') return false
  } else if (filterStation !== 'ALL') {
    if (item.station !== filterStation) return false
  }

  if (viewMode === 'plan') {
```

Also update the dependency array at the end of the same memo. Find:

```ts
}), [items, search, filterPriority, filterCategory, filterStatus, viewMode, planView])
```

Replace with:

```ts
}), [items, search, filterPriority, filterCategory, filterStation, filterStatus, viewMode, planView])
```

- [ ] **Step 2: Update `activeFilterCount` to include station filter**

Find at line ~435:

```ts
const activeFilterCount = [filterPriority !== 'ALL', filterStatus !== 'ALL', filterCategory !== 'ALL'].filter(Boolean).length
```

Replace with:

```ts
const activeFilterCount = [filterPriority !== 'ALL', filterStatus !== 'ALL', filterCategory !== 'ALL', filterStation !== 'ALL'].filter(Boolean).length
```

- [ ] **Step 3: Add station `<select>` to the desktop filter bar**

Find the desktop filter bar block at line ~648. It currently ends with the category select:

```tsx
<select className={selCls} value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
  <option value="ALL">All Categories</option>
  {categories.map(c => <option key={c} value={c}>{c}</option>)}
</select>
```

Directly after that `</select>` (still inside the same `<div className="flex items-center gap-2 flex-wrap">`), add:

```tsx
<select className={selCls} value={filterStation} onChange={e => setFilterStation(e.target.value)}>
  <option value="ALL">All Stations</option>
  <option value="UNASSIGNED">Unassigned</option>
  {stations.map(s => <option key={s} value={s}>{s}</option>)}
</select>
```

- [ ] **Step 4: Add station filter to the mobile filter sheet**

Find the mobile collapsible filters block at line ~515. It currently ends with the category select:

```tsx
<select className={selCls + ' w-full'} value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
  <option value="ALL">All Categories</option>
  {categories.map(c => <option key={c} value={c}>{c}</option>)}
</select>
```

Directly after that `</select>` (still inside the collapsible `<div>`), add:

```tsx
<select className={selCls + ' w-full'} value={filterStation} onChange={e => setFilterStation(e.target.value)}>
  <option value="ALL">All Stations</option>
  <option value="UNASSIGNED">Unassigned</option>
  {stations.map(s => <option key={s} value={s}>{s}</option>)}
</select>
```

- [ ] **Step 5: Verify build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
npm run build 2>&1 | tail -20
```

Expected: `✓ Compiled successfully`.

- [ ] **Step 6: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/prep/page.tsx
git commit -m "feat(prep): add station filter to desktop and mobile filter UI

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: "By Station" grouping in Plan mode

**Files:**
- Modify: `src/app/prep/page.tsx`

- [ ] **Step 1: Extend `planSort` state type to include `'station'`**

Find at line ~32:

```ts
const [planSort,   setPlanSort]   = useState<'az' | 'category'>('category')
```

Replace with:

```ts
const [planSort,   setPlanSort]   = useState<'az' | 'category' | 'station'>('category')
```

- [ ] **Step 2: Update `planGroups` memo to handle station grouping**

Find the `planGroups` useMemo at line ~194:

```ts
const planGroups = useMemo(() => {
  if (viewMode !== 'plan' || planSort !== 'category') return null
  const map = new Map<string, typeof filtered>()
  for (const cat of [...new Set(planSorted.map(i => i.category))].sort()) map.set(cat, [])
  for (const item of planSorted) map.get(item.category)!.push(item)
  return Array.from(map.entries()).filter(([, rows]) => rows.length > 0)
}, [filtered, planSorted, viewMode, planSort])
```

Replace with:

```ts
const planGroups = useMemo(() => {
  if (viewMode !== 'plan') return null

  if (planSort === 'category') {
    const map = new Map<string, typeof filtered>()
    for (const cat of [...new Set(planSorted.map(i => i.category))].sort()) map.set(cat, [])
    for (const item of planSorted) map.get(item.category)!.push(item)
    return Array.from(map.entries()).filter(([, rows]) => rows.length > 0)
  }

  if (planSort === 'station') {
    const groups: [string, typeof filtered][] = []
    // Named station buckets in settings order
    for (const station of stations) {
      const rows = planSorted.filter(i => i.station === station)
      if (rows.length > 0) groups.push([station, rows])
    }
    // Unassigned bucket at the bottom
    const unassigned = planSorted.filter(i => !i.station || i.station.trim() === '')
    if (unassigned.length > 0) groups.push(['Unassigned', unassigned])
    return groups.length > 0 ? groups : null
  }

  return null
}, [filtered, planSorted, viewMode, planSort, stations])
```

- [ ] **Step 3: Add "By Station" button to the plan-mode sort toggle**

Find the sort toggle at line ~744:

```tsx
{/* Sort toggle: A–Z / By Category — only in All Items view */}
{planView === 'all' && (
  <div className="flex items-center gap-1 bg-indigo-100 rounded-lg p-0.5">
    {([['az', 'A – Z'], ['category', 'By Category']] as const).map(([mode, label]) => (
      <button
        key={mode}
        onClick={() => setPlanSort(mode)}
        className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
          planSort === mode ? 'bg-white text-indigo-800 shadow-sm' : 'text-indigo-500 hover:text-indigo-700'
        }`}
      >
        {label}
      </button>
    ))}
  </div>
)}
```

Replace with:

```tsx
{/* Sort toggle: A–Z / By Category / By Station — only in All Items view */}
{planView === 'all' && (
  <div className="flex items-center gap-1 bg-indigo-100 rounded-lg p-0.5">
    {([['az', 'A – Z'], ['category', 'By Category'], ['station', 'By Station']] as const).map(([mode, label]) => (
      <button
        key={mode}
        onClick={() => setPlanSort(mode)}
        className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
          planSort === mode ? 'bg-white text-indigo-800 shadow-sm' : 'text-indigo-500 hover:text-indigo-700'
        }`}
      >
        {label}
      </button>
    ))}
  </div>
)}
```

- [ ] **Step 4: Verify build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
npm run build 2>&1 | tail -20
```

Expected: `✓ Compiled successfully`.

- [ ] **Step 5: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/prep/page.tsx
git commit -m "feat(prep): add By Station grouping in plan mode

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Manual verification checklist (do after all tasks)

Open `http://localhost:3000/prep` in the browser.

**Station badge:**
- [ ] Assign a station to a prep item (via the detail panel or add form) — its badge appears in the today and plan mode rows
- [ ] Items with no station show no badge

**Station filter:**
- [ ] Desktop: "All Stations" dropdown appears in the filter bar; selecting a station name filters rows correctly
- [ ] "Unassigned" shows only items with no station
- [ ] Mobile: Filter sheet includes the same station select

**By Station grouping:**
- [ ] Plan mode → All Items view → "By Station" button appears
- [ ] Clicking "By Station" groups rows under station headers
- [ ] Station bucket order matches the order in Prep Settings
- [ ] Items with no station appear in an "Unassigned" bucket at the bottom
- [ ] Stations with no items are not shown

**Settings sync:**
- [ ] Open Prep Settings, add a new station, save — the station immediately appears in the filter dropdown and "By Station" groups without a page reload
