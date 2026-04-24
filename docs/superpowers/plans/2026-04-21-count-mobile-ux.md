# Count Page Mobile UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Count page for mobile — fix text overlap in the session list, replace the 3-row filter stack with a single row + bottom sheet, replace cramped item cards with thin status-dot rows, and make the review view's 5-column table readable on small screens.

**Architecture:** All changes are mobile-only additions inside `src/app/count/page.tsx`. Each existing desktop block gets a `hidden sm:block` / `hidden sm:flex` guard; a new mobile block rendered before it uses `block sm:hidden` / `flex sm:hidden`. No new files, no API changes, no schema changes.

**Tech Stack:** Next.js 14 App Router · TypeScript · Tailwind CSS · Lucide icons · existing `varColor`, `fmtDate`, `formatCurrency`, `StatusBadge`, `Pill`, `Empty` helpers already in the file.

---

### Task 1: Mobile session list cards

**Files:**
- Modify: `src/app/count/page.tsx` (state block ~line 122, session list block ~lines 523–591)

**Context:** The session list currently renders one desktop-only row per session — date | name+progress | status badge | 3 icon buttons. On mobile the text overlaps. The fix is a left-accent card with the actions behind a ⋯ dropdown.

- [ ] **Step 1: Add `sessionMenuId` state after the existing state block (line ~122)**

Find the line:
```tsx
  const [editDate,      setEditDate]      = useState('')
```
Add immediately after:
```tsx
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null)
```

- [ ] **Step 2: Add `hidden sm:block` to the existing desktop session list wrapper**

Find (line ~524):
```tsx
        <div className="space-y-2">
```
Change to:
```tsx
        <div className="hidden sm:block space-y-2">
```

- [ ] **Step 3: Add the mobile session list above the desktop list**

Find the comment and element you just changed:
```tsx
        <div className="hidden sm:block space-y-2">
```
Insert the entire mobile list before it:
```tsx
        {/* Mobile session list */}
        <div className="flex sm:hidden flex-col gap-2">
          {sessions.map(s => {
            const counts = s.counts ?? { total: 0, counted: 0, skipped: 0 }
            const accentColor: Record<string, string> = {
              IN_PROGRESS:    '#3b82f6',
              PENDING_REVIEW: '#f59e0b',
              FINALIZED:      '#22c55e',
              CANCELLED:      '#d1d5db',
            }
            const handleCardTap = () => {
              setSessionMenuId(null)
              if (s.status === 'IN_PROGRESS' || s.status === 'PENDING_REVIEW') openSession(s, 'count')
              else if (s.status === 'FINALIZED') openSession(s, 'review')
            }
            return (
              <div key={s.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 border-l-4 overflow-hidden relative"
                style={{ borderLeftColor: accentColor[s.status] ?? '#d1d5db' }}>
                {/* Card body — tappable to navigate */}
                <div className="px-4 py-3 cursor-pointer" onClick={handleCardTap}>
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-sm font-semibold text-gray-900 truncate">
                      {s.label || (s.type === 'FULL' ? 'Full count' : 'Partial count')}
                    </span>
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="flex items-center justify-between mt-1.5 gap-2">
                    <span className="text-xs text-gray-400 truncate">
                      {fmtDate(s.sessionDate)} · {s.countedBy} ·{' '}
                      {s.status === 'FINALIZED'
                        ? `${counts.total} items · ${formatCurrency(Number(s.totalCountedValue))}`
                        : `${counts.counted}/${counts.total} items`}
                    </span>
                    {s.status === 'IN_PROGRESS'    && <span className="text-xs font-bold text-blue-600 shrink-0">Continue →</span>}
                    {s.status === 'PENDING_REVIEW' && <span className="text-xs font-bold text-amber-600 shrink-0">Review →</span>}
                    {s.status === 'FINALIZED'      && <span className="text-xs font-bold text-green-700 shrink-0">Report</span>}
                  </div>
                </div>
                {/* ⋯ menu trigger */}
                <div className="relative" style={{ position: 'absolute', top: 8, right: 8 }}>
                  <button
                    onClick={e => { e.stopPropagation(); setSessionMenuId(sessionMenuId === s.id ? null : s.id) }}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100"
                  >
                    <MoreHorizontal size={16} />
                  </button>
                  {sessionMenuId === s.id && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setSessionMenuId(null)} />
                      <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
                        <button
                          onClick={e => { e.stopPropagation(); setSessionMenuId(null); openEditModal(s) }}
                          className="flex items-center gap-2 w-full px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 border-b border-gray-100"
                        >
                          <Pencil size={13} /> Edit metadata
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); setSessionMenuId(null); handleReopenAndEdit(s) }}
                          className="flex items-center gap-2 w-full px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 border-b border-gray-100"
                        >
                          <ClipboardList size={13} /> {s.status === 'FINALIZED' ? 'Reopen & edit' : 'Edit counts'}
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); setSessionMenuId(null); setDeleteTarget(s) }}
                          className="flex items-center gap-2 w-full px-4 py-3 text-sm text-red-500 hover:bg-red-50"
                        >
                          <Trash2 size={13} /> Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <div className="hidden sm:block space-y-2">
```

- [ ] **Step 4: Add `MoreHorizontal` to the lucide import at the top of the file**

Find:
```tsx
import {
  AlertCircle, ArrowLeft, Check, CheckCircle2, ChevronDown,
  Circle, ClipboardList, Minus, Pencil, Plus, SkipForward, Trash2, X,
} from 'lucide-react'
```
Change to:
```tsx
import {
  AlertCircle, ArrowLeft, Check, CheckCircle2, ChevronDown,
  Circle, ClipboardList, Minus, MoreHorizontal, Pencil, Plus, SkipForward, Trash2, X,
} from 'lucide-react'
```

- [ ] **Step 5: Verify build passes**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```
Expected: `✓ Compiled successfully` with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && git add src/app/count/page.tsx && git commit -m "feat: add mobile session list cards to count page"
```

---

### Task 2: Mobile count mode filter row + bottom sheet

**Files:**
- Modify: `src/app/count/page.tsx` (state block ~line 129, filter pills block ~lines 869–901)

**Context:** The existing filter area has up to 3 pill rows (category, location, status). On mobile this collapses to one row: `All · Uncounted · Counted` status pills + a `⧉ Filter` button that opens a bottom sheet with category and location chips.

- [ ] **Step 1: Add `showCountFilterSheet` state after the existing count-mode state (line ~129)**

Find:
```tsx
  const [statusFilter,  setStatusFilter]  = useState<'all' | 'uncounted' | 'counted'>('all')
```
Add immediately after:
```tsx
  const [showCountFilterSheet, setShowCountFilterSheet] = useState(false)
```

- [ ] **Step 2: Add `hidden sm:block` to the existing filter pills wrapper**

Find (line ~870):
```tsx
        {/* ── Filter pills ───────────────────────────────────────────────────── */}
        <div className="px-4 pt-3 pb-2 space-y-2">
```
Change to:
```tsx
        {/* ── Filter pills ───────────────────────────────────────────────────── */}
        <div className="hidden sm:block px-4 pt-3 pb-2 space-y-2">
```

- [ ] **Step 3: Insert mobile filter row + bottom sheet before the desktop pills**

Find the updated comment+element:
```tsx
        {/* ── Filter pills ───────────────────────────────────────────────────── */}
        <div className="hidden sm:block px-4 pt-3 pb-2 space-y-2">
```
Insert immediately before it:
```tsx
        {/* ── Mobile filter row ──────────────────────────────────────────────── */}
        <div className="flex sm:hidden items-center gap-2 px-3 pt-2 pb-1.5">
          {(['all', 'uncounted', 'counted'] as const).map(f => (
            <Pill key={f} active={statusFilter === f} onClick={() => setStatusFilter(f)}>
              {f === 'all' ? 'All' : f === 'uncounted' ? 'Uncounted' : 'Counted'}
            </Pill>
          ))}
          <div className="flex-1" />
          <button
            onClick={() => setShowCountFilterSheet(true)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              catFilter || locFilter
                ? 'bg-blue-50 text-blue-700 border-blue-200'
                : 'bg-white text-gray-600 border-gray-200'
            }`}
          >
            Filter{(catFilter ? 1 : 0) + (locFilter ? 1 : 0) > 0 && ` · ${(catFilter ? 1 : 0) + (locFilter ? 1 : 0)}`}
          </button>
        </div>

        {/* ── Mobile filter bottom sheet ──────────────────────────────────────── */}
        {showCountFilterSheet && (
          <div className="fixed inset-0 z-50 flex items-end sm:hidden" onClick={() => setShowCountFilterSheet(false)}>
            <div className="absolute inset-0 bg-black/40" />
            <div className="relative bg-white w-full rounded-t-2xl p-5 pb-8" onClick={e => e.stopPropagation()}>
              <div className="w-9 h-1 bg-gray-200 rounded-full mx-auto mb-4" />
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-gray-900">Filter</h3>
                <button onClick={() => setShowCountFilterSheet(false)}><X size={18} className="text-gray-400" /></button>
              </div>
              <div className="space-y-4">
                <div>
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Category</div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setCatFilter(null)}
                      className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${catFilter === null ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200'}`}
                    >All</button>
                    {categories.map(([cat]) => (
                      <button key={cat}
                        onClick={() => setCatFilter(cat)}
                        className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${catFilter === cat ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200'}`}
                      >{cat}</button>
                    ))}
                  </div>
                </div>
                {locations.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Location</div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => setLocFilter(null)}
                        className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${locFilter === null ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200'}`}
                      >All</button>
                      {locations.map(loc => (
                        <button key={loc}
                          onClick={() => setLocFilter(loc)}
                          className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${locFilter === loc ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200'}`}
                        >{loc}</button>
                      ))}
                    </div>
                  </div>
                )}
                <button
                  onClick={() => { setCatFilter(null); setLocFilter(null); setShowCountFilterSheet(false) }}
                  className="w-full py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600 font-medium"
                >Clear filters</button>
              </div>
            </div>
          </div>
        )}

```

- [ ] **Step 4: Verify build passes**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```
Expected: `✓ Compiled successfully`

- [ ] **Step 5: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && git add src/app/count/page.tsx && git commit -m "feat: add mobile filter row and bottom sheet to count mode"
```

---

### Task 3: Mobile count mode item rows

**Files:**
- Modify: `src/app/count/page.tsx` (after `renderLine` definition ~line 835, items block ~line 903)

**Context:** The existing `renderLine` renders desktop-style expand-cards with category badge + location on the same row as the item name — these overlap on narrow screens. `renderMobileLine` renders thin status-dot rows with name + subtitle, tap to expand the same stepper inline.

- [ ] **Step 1: Add `renderMobileLine` immediately after the closing brace of `renderLine` (~line 836)**

Find the closing brace of renderLine and the return statement that starts the count view JSX:
```tsx
    }

    return (
      <div className="max-w-2xl pb-28">
```
Insert `renderMobileLine` between them:
```tsx
    const renderMobileLine = (line: Line) => {
      const isOpen    = openId === line.id
      const isCounted = line.countedQty !== null && !line.skipped
      const isSkipped = line.skipped
      const locLabel  = line.inventoryItem.location ?? line.inventoryItem.storageArea?.name
      const subtitle  = [line.inventoryItem.category, locLabel].filter(Boolean).join(' · ')

      const liveVar = isOpen && Number(line.expectedQty) > 0
        ? ((inputQty - Number(line.expectedQty)) / Number(line.expectedQty)) * 100
        : null

      const dotColor = isSkipped
        ? 'bg-gray-300'
        : isCounted
          ? (line.variancePct !== null && Math.abs(Number(line.variancePct)) > 15 ? 'bg-amber-400' : 'bg-green-500')
          : 'bg-gray-300'

      const rowBg = isSkipped
        ? 'bg-gray-50 border-gray-100 opacity-60'
        : isCounted
          ? (line.variancePct !== null && Math.abs(Number(line.variancePct)) > 15
              ? 'bg-amber-50/60 border-amber-200'
              : 'bg-green-50/60 border-green-200')
          : isOpen
            ? 'border-green-400 border-2 bg-white'
            : 'bg-white border-gray-200'

      return (
        <div key={`m-${line.id}`}
          ref={el => { cardRefs.current[line.id] = el }}
          className={`rounded-xl border ${rowBg} overflow-hidden`}
        >
          <div
            className="flex items-center gap-3 px-3 py-2.5 cursor-pointer"
            onClick={() => setOpenId(isOpen ? null : line.id)}
          >
            <div className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-medium truncate ${isSkipped ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                {line.inventoryItem.itemName}
              </div>
              {subtitle && <div className="text-xs text-gray-400 mt-0.5">{subtitle}</div>}
            </div>
            <div className="text-right shrink-0">
              {isSkipped ? (
                <span className="text-xs text-gray-400">Skipped</span>
              ) : isCounted ? (
                <>
                  <div className="text-sm font-semibold text-gray-900">
                    {Number(line.countedQty).toFixed(1)} {line.selectedUom}
                  </div>
                  {line.variancePct !== null && (
                    <div className={`text-xs ${varColor(line.variancePct)}`}>
                      {Number(line.variancePct) >= 0 ? '+' : ''}{Number(line.variancePct).toFixed(1)}%
                    </div>
                  )}
                </>
              ) : (
                <span className="text-xs text-gray-300">— —</span>
              )}
            </div>
          </div>

          {isOpen && (
            <div className="px-3 pb-3 pt-1 border-t border-gray-100">
              <div className="text-xs text-gray-500 mb-2 flex items-center gap-1.5">
                <span>Expected: {Number(line.expectedQty).toFixed(2)} {line.selectedUom}</span>
                {liveVar !== null && (
                  <span className={`font-medium ${varColor(liveVar)}`}>
                    · {liveVar > 0 ? '+' : ''}{liveVar.toFixed(1)}%
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 mb-2">
                <button
                  onClick={() => setInputQty(v => Math.max(0, Math.round((v - 1) * 100) / 100))}
                  className="w-12 h-14 rounded-xl bg-gray-100 flex items-center justify-center"
                >
                  <Minus size={18} className="text-gray-700" />
                </button>
                <input
                  type="number"
                  value={inputQty}
                  onChange={e => setInputQty(parseFloat(e.target.value) || 0)}
                  className="flex-1 h-14 text-center text-2xl font-bold border-2 border-green-400 rounded-xl focus:outline-none"
                  min={0} step={0.1}
                />
                <button
                  onClick={() => setInputQty(v => Math.round((v + 1) * 100) / 100)}
                  className="w-12 h-14 rounded-xl bg-gray-100 flex items-center justify-center"
                >
                  <Plus size={18} className="text-gray-700" />
                </button>
              </div>
              <div className="text-center text-xs text-gray-500 mb-3">{line.selectedUom}</div>
              <div className="flex gap-2">
                <button
                  onClick={() => confirmLine(line, inputQty)}
                  className="flex-1 h-11 bg-green-500 text-white rounded-xl font-semibold text-sm flex items-center justify-center gap-1.5"
                >
                  <Check size={15} /> Confirm
                </button>
                <button
                  onClick={() => skipLine(line)}
                  className="px-4 h-11 border border-gray-200 rounded-xl text-sm text-gray-500 flex items-center gap-1.5"
                >
                  <SkipForward size={13} /> Skip
                </button>
              </div>
            </div>
          )}
        </div>
      )
    }

```

- [ ] **Step 2: Add `hidden sm:block` to the existing desktop items wrapper**

Find (line ~904):
```tsx
        {/* ── Items ──────────────────────────────────────────────────────────── */}
        <div className="pt-1">
```
Change to:
```tsx
        {/* ── Items ──────────────────────────────────────────────────────────── */}
        <div className="hidden sm:block pt-1">
```

- [ ] **Step 3: Insert the mobile items list before the desktop items wrapper**

Find:
```tsx
        {/* ── Items ──────────────────────────────────────────────────────────── */}
        <div className="hidden sm:block pt-1">
```
Insert before it:
```tsx
        {/* ── Mobile items list ──────────────────────────────────────────────── */}
        <div className="block sm:hidden px-3 pt-1 pb-28 space-y-1.5">
          {catFilter ? (
            filteredLines.length === 0 ? <Empty /> : filteredLines.map(renderMobileLine)
          ) : (
            !grouped || Object.keys(grouped).length === 0 ? <Empty /> :
            Object.entries(grouped)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([cat, lines]) => {
                const catDone = lines.filter(l => l.countedQty !== null || l.skipped).length
                return (
                  <div key={`mc-${cat}`}>
                    <div className="flex items-center gap-2 py-2 px-1">
                      <span className="text-xs font-bold uppercase tracking-wider text-gray-500">{cat}</span>
                      <span className="text-xs text-gray-400">{catDone}/{lines.length}</span>
                      <div className="flex-1 max-w-[60px] h-1 bg-gray-100 rounded-full">
                        <div className="h-1 bg-green-400 rounded-full"
                          style={{ width: `${lines.length > 0 ? (catDone / lines.length) * 100 : 0}%` }} />
                      </div>
                    </div>
                    {lines.map(renderMobileLine)}
                  </div>
                )
              })
          )}
        </div>

```

- [ ] **Step 4: Verify build passes**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```
Expected: `✓ Compiled successfully`

- [ ] **Step 5: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && git add src/app/count/page.tsx && git commit -m "feat: add mobile item rows to count mode"
```

---

### Task 4: Mobile review view

**Files:**
- Modify: `src/app/count/page.tsx` (review view ~lines 949–1054)

**Context:** The review view has a 5-column variance table that overflows on mobile, and the footer buttons sit at the bottom of a scrolling page. On mobile: compact 3-tile KPI strip, stacked variance cards, and the Approve button fixed above the nav bar.

- [ ] **Step 1: Add `hidden sm:grid` to the existing stats grid and insert a mobile KPI strip before it**

Find (line ~973):
```tsx
        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-6">
```
Change the grid class and insert a mobile strip before it:
```tsx
        {/* Stats — mobile compact strip */}
        <div className="flex sm:hidden gap-2 mb-4">
          {[
            { val: countedLines.length.toString(),   label: 'Counted',  cls: 'bg-blue-50 text-blue-700'   },
            { val: flagged.length.toString(),         label: 'Flagged',  cls: flagged.length > 0 ? 'bg-amber-50 text-amber-700' : 'bg-gray-50 text-gray-500' },
            { val: formatCurrency(totalValue),        label: 'Value',    cls: 'bg-green-50 text-green-700' },
          ].map(s => (
            <div key={s.label} className={`flex-1 rounded-xl py-2 px-3 text-center ${s.cls}`}>
              <div className="text-base font-bold leading-tight">{s.val}</div>
              <div className="text-[10px] font-medium mt-0.5 opacity-80">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Stats — desktop */}
        <div className="hidden sm:grid grid-cols-3 gap-3 mb-6">
```

- [ ] **Step 2: Add `hidden sm:block` to the existing variance table and insert mobile variance cards before it**

Find (line ~988):
```tsx
        {/* Variance table */}
        {sorted.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden mb-6">
```
Change to wrap the whole block with a `hidden sm:block` div and add the mobile cards above it:
```tsx
        {/* Variance cards — mobile */}
        {sorted.length > 0 && (
          <div className="block sm:hidden space-y-2 mb-24">
            {sorted.map(l => {
              const vPct  = Number(l.variancePct ?? 0)
              const vCost = Number(l.varianceCost ?? 0)
              const large = Math.abs(vPct) > 15
              return (
                <div key={l.id}
                  className={`bg-white rounded-xl border overflow-hidden ${large ? 'border-l-4 border-amber-400 border-t-gray-100 border-r-gray-100 border-b-gray-100' : 'border-gray-100'}`}
                >
                  <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-50">
                    {large && <AlertCircle size={13} className="text-amber-500 shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-gray-900 truncate">{l.inventoryItem.itemName}</div>
                      <div className="text-xs text-gray-400">{l.inventoryItem.category}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 divide-x divide-gray-50">
                    <div className="px-3 py-2">
                      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">Expected</div>
                      <div className="text-sm text-gray-700">{Number(l.expectedQty).toFixed(1)} {l.selectedUom}</div>
                    </div>
                    <div className="px-3 py-2">
                      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">Counted</div>
                      <div className="text-sm font-semibold text-gray-900">{Number(l.countedQty).toFixed(1)} {l.selectedUom}</div>
                    </div>
                    <div className="px-3 py-2 border-t border-gray-50">
                      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">Variance</div>
                      <div className={`text-sm font-semibold ${varColor(vPct)}`}>
                        {vPct >= 0 ? '+' : ''}{vPct.toFixed(1)}%
                      </div>
                    </div>
                    <div className="px-3 py-2 border-t border-gray-50">
                      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">Cost impact</div>
                      <div className={`text-sm font-semibold ${vCost >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {vCost >= 0 ? '+' : ''}{formatCurrency(vCost)}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Variance table — desktop */}
        {sorted.length > 0 && (
          <div className="hidden sm:block bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden mb-6">
```

- [ ] **Step 3: Add `hidden sm:flex` to the existing footer buttons and add a mobile fixed footer**

Find (line ~1031):
```tsx
        {/* Footer */}
        {!isFinalized ? (
          <div className="flex gap-3">
```
Change to add `hidden sm:flex` to the desktop footer and insert a mobile fixed bar:
```tsx
        {/* Footer — mobile fixed bar */}
        {!isFinalized && (
          <div className="fixed sm:hidden bottom-20 inset-x-0 bg-white border-t border-gray-100 px-4 py-3 z-30">
            <div className="flex gap-3">
              <button onClick={() => setView('count')}
                className="flex-1 py-3 border border-gray-200 rounded-2xl text-sm font-medium text-gray-600"
              >
                ← Back
              </button>
              <button onClick={handleFinalize} disabled={finalizing}
                className="flex-[2] py-3 bg-green-600 text-white rounded-2xl text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <Check size={15} /> {finalizing ? 'Updating…' : 'Approve & update'}
              </button>
            </div>
          </div>
        )}

        {/* Footer — desktop */}
        {!isFinalized ? (
          <div className="hidden sm:flex gap-3">
```

- [ ] **Step 4: Verify build passes**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```
Expected: `✓ Compiled successfully`

- [ ] **Step 5: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && git add src/app/count/page.tsx && git commit -m "feat: add mobile review view to count page"
```
