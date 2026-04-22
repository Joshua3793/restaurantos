# Inventory Mobile UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the inventory page for mobile screens — compact KPI strip, scrollable filter pills, thin allergen-first card rows — while leaving the desktop table completely unchanged.

**Architecture:** All changes live in `src/app/inventory/page.tsx`. Mobile sections use `block sm:hidden`; desktop sections use `hidden sm:block` (or `hidden sm:grid`, `hidden sm:flex`). No new files, no API changes, no schema changes. Verification is `npm run build` after each task (there is no test suite).

**Tech Stack:** Next.js 14 App Router · TypeScript · Tailwind CSS · Lucide icons · existing `AllergenBadges` component

---

## File map

| Section | Location in file |
|---|---|
| Imports | lines 1–12 |
| State declarations | lines 168–204 |
| KPI `useMemo` | lines 269–275 |
| `renderRow` (desktop table row) | lines 456–535 |
| Filter pills array | lines 537–545 |
| JSX return — header | lines 549–583 |
| JSX return — KPI cards grid | lines 585–603 |
| JSX return — filter pills | lines 605–618 |
| JSX return — search + selects | lines 620–654 |
| JSX return — bulk bar | lines 658–734 |
| JSX return — desktop table | lines 835–912 |
| JSX return — detail panel | lines 914–end |

---

## Task 1: Add mobile state + update imports

**Files:**
- Modify: `src/app/inventory/page.tsx`

- [ ] **Step 1: Add `MoreHorizontal` to the lucide import**

Find the existing import block (lines 8–12):
```tsx
import {
  Search, Plus, X, Download,
  CheckSquare, Square, ChevronDown, ChevronRight, AlertCircle,
  ChevronsUpDown, ChevronUp, Pencil, Trash2, ShoppingCart, Copy,
} from 'lucide-react'
```

Replace with:
```tsx
import {
  Search, Plus, X, Download,
  CheckSquare, Square, ChevronDown, ChevronRight, AlertCircle,
  ChevronsUpDown, ChevronUp, Pencil, Trash2, ShoppingCart, Copy,
  MoreHorizontal,
} from 'lucide-react'
```

- [ ] **Step 2: Add three mobile UI state variables**

After the existing `const [orderQtys, setOrderQtys]` line (currently around line 192), add:
```tsx
const [showMobileOverflow,    setShowMobileOverflow]    = useState(false)
const [showMobileSortSheet,   setShowMobileSortSheet]   = useState(false)
const [showMobileFilterSheet, setShowMobileFilterSheet] = useState(false)
```

- [ ] **Step 3: Build and confirm no type errors**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | grep -E "error|Error|✓|Ready"
```

Expected: build succeeds (✓ or "Ready").

- [ ] **Step 4: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/inventory/page.tsx
git commit -m "feat(inventory): add mobile UI state + MoreHorizontal import"
```

---

## Task 2: Mobile header

**Files:**
- Modify: `src/app/inventory/page.tsx`

The desktop header (lines 549–583) is a `flex items-center justify-between gap-2 flex-wrap` div with title + 4 buttons. We hide it on mobile and render a simpler mobile header above it.

- [ ] **Step 1: Wrap the existing desktop header div to hide on mobile**

Find:
```tsx
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
```

Replace with:
```tsx
      {/* Header */}
      <div className="hidden sm:flex items-center justify-between gap-2 flex-wrap">
```

- [ ] **Step 2: Insert the mobile header immediately before the desktop header**

Insert this block right before the `{/* Header */}` comment:
```tsx
      {/* Mobile header */}
      <div className="flex sm:hidden items-center gap-2">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-gray-900 leading-tight">Inventory</h1>
          <p className="text-xs text-gray-400">{items.length} items</p>
        </div>
        <button
          onClick={() => { setShowOrderList(true); setOrderQtys({}) }}
          className="flex items-center justify-center w-9 h-9 bg-green-50 border border-green-200 text-green-700 rounded-xl"
        >
          <ShoppingCart size={16} />
        </button>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 bg-blue-600 text-white px-3 h-9 rounded-xl text-sm font-semibold"
        >
          <Plus size={15} /> Add
        </button>
        <div className="relative">
          <button
            onClick={() => setShowMobileOverflow(v => !v)}
            className="flex items-center justify-center w-9 h-9 bg-gray-50 border border-gray-200 text-gray-600 rounded-xl"
          >
            <MoreHorizontal size={16} />
          </button>
          {showMobileOverflow && (
            <div className="absolute right-0 top-full mt-1 w-44 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
              <button
                onClick={() => { window.location.href = '/api/inventory/export'; setShowMobileOverflow(false) }}
                className="flex items-center gap-2 w-full px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 border-b border-gray-100"
              >
                <Download size={14} /> Export CSV
              </button>
              <button
                onClick={() => { syncAllPrepd(); setShowMobileOverflow(false) }}
                disabled={syncingPrepd}
                className="flex items-center gap-2 w-full px-4 py-3 text-sm text-purple-700 hover:bg-purple-50 disabled:opacity-50"
              >
                {syncingPrepd ? '⟳ Syncing…' : '⟳ Sync PREPD'}
              </button>
            </div>
          )}
        </div>
      </div>
```

- [ ] **Step 3: Build and confirm**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | grep -E "error TS|Error:|✓|Ready"
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/inventory/page.tsx
git commit -m "feat(inventory): mobile header with overflow menu"
```

---

## Task 3: Mobile KPI strip

**Files:**
- Modify: `src/app/inventory/page.tsx`

The desktop KPI grid (lines ~585–603) is `grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5`. We hide it on mobile and show a horizontal-scroll strip instead.

- [ ] **Step 1: Add `sm:` prefix to hide the desktop KPI grid on mobile**

Find:
```tsx
      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
```

Replace with:
```tsx
      {/* KPI Cards */}
      <div className="hidden sm:grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
```

- [ ] **Step 2: Insert mobile KPI strip immediately before the KPI Cards comment**

```tsx
      {/* Mobile KPI strip */}
      <div className="flex sm:hidden gap-3 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
        <div className="flex-shrink-0 bg-blue-50 rounded-xl px-3 py-2.5 min-w-[110px]">
          <div className="text-[9px] font-bold text-blue-500 uppercase tracking-wide">Stock Value</div>
          <div className="text-lg font-extrabold text-blue-700 mt-0.5">{formatCurrency(kpis.totalValue)}</div>
        </div>
        <div className="flex-shrink-0 bg-green-50 rounded-xl px-3 py-2.5 min-w-[100px]">
          <div className="text-[9px] font-bold text-green-600 uppercase tracking-wide">Counted</div>
          <div className="text-lg font-extrabold text-green-700 mt-0.5">
            {kpis.counted} <span className="text-xs font-medium text-green-400">/ {kpis.activeCount}</span>
          </div>
        </div>
        <div className="flex-shrink-0 bg-orange-50 rounded-xl px-3 py-2.5 min-w-[100px]">
          <div className="text-[9px] font-bold text-orange-500 uppercase tracking-wide">Uncounted</div>
          <div className="text-lg font-extrabold text-orange-600 mt-0.5">{kpis.notCounted}</div>
        </div>
        <div className="flex-shrink-0 bg-gray-50 rounded-xl px-3 py-2.5 min-w-[80px]">
          <div className="text-[9px] font-bold text-gray-500 uppercase tracking-wide">Active</div>
          <div className="text-lg font-extrabold text-gray-700 mt-0.5">{kpis.activeCount}</div>
        </div>
      </div>
```

- [ ] **Step 3: Build and confirm**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | grep -E "error TS|Error:|✓|Ready"
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/inventory/page.tsx
git commit -m "feat(inventory): mobile KPI horizontal scroll strip"
```

---

## Task 4: Mobile filter pills + bottom sheets

**Files:**
- Modify: `src/app/inventory/page.tsx`

The desktop filter area has: wrapping pill row + search bar row (search input + category select + supplier select + grouped/flat toggle). On mobile: single scrolling pill row + Sort sheet + Filter sheet. The search bar stays full-width on both.

- [ ] **Step 1: Hide the desktop filter pills on mobile**

Find:
```tsx
      {/* Filter Pills */}
      <div className="flex gap-1.5 flex-wrap">
```

Replace with:
```tsx
      {/* Filter Pills */}
      <div className="hidden sm:flex gap-1.5 flex-wrap">
```

- [ ] **Step 2: Insert mobile filter pill row immediately before the Filter Pills comment**

```tsx
      {/* Mobile filter pills */}
      <div className="flex sm:hidden gap-2 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
        {pills.map(p => (
          <button
            key={p.key}
            onClick={() => setActivePill(p.key)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              activePill === p.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
            }`}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setShowMobileSortSheet(true)}
          className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold bg-white border border-gray-200 text-gray-600"
        >
          <ChevronsUpDown size={11} /> Sort
        </button>
        <button
          onClick={() => setShowMobileFilterSheet(true)}
          className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold bg-white border border-gray-200 text-gray-600"
        >
          ▽ Filter
        </button>
      </div>
```

- [ ] **Step 3: Hide the desktop category/supplier selects and grouped/flat toggle on mobile**

Find the search + filters row:
```tsx
      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
```

Replace with:
```tsx
      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
```
(no change to the outer div — that's fine because the search input is full-width on both)

Now find the category select:
```tsx
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
```

Replace with:
```tsx
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className="hidden sm:block border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
```

Find the supplier select:
```tsx
        <select value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
```

Replace with:
```tsx
        <select value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)} className="hidden sm:block border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
```

Find the grouped/flat toggle:
```tsx
        <div className="flex items-center gap-0.5 border border-gray-200 rounded-lg p-0.5 bg-white shrink-0">
```

Replace with:
```tsx
        <div className="hidden sm:flex items-center gap-0.5 border border-gray-200 rounded-lg p-0.5 bg-white shrink-0">
```

- [ ] **Step 4: Add Sort bottom sheet**

Find the `{/* Order List Modal */}` comment (around line 736) and insert this block immediately before it:

```tsx
      {/* Mobile Sort Sheet */}
      {showMobileSortSheet && (
        <div className="fixed inset-0 z-50 flex items-end sm:hidden" onClick={() => setShowMobileSortSheet(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative bg-white w-full rounded-t-2xl p-5 pb-8" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-gray-900">Sort by</h3>
              <button onClick={() => setShowMobileSortSheet(false)}><X size={18} className="text-gray-400" /></button>
            </div>
            {/* Grouped / Flat */}
            <div className="mb-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">View</div>
              <div className="flex gap-2">
                {([['category', '⊞ Grouped'], ['all', '≡ Flat']] as [SortMode, string][]).map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => setSortBy(mode)}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                      sortBy === mode ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {/* Column sort */}
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Sort column</div>
              <div className="space-y-1">
                {([
                  ['item',     'Item name'],
                  ['price',    'Purchase price'],
                  ['stock',    'Stock on hand'],
                  ['value',    'Inventory value'],
                  ['supplier', 'Supplier'],
                ] as [ColKey, string][]).map(([col, label]) => (
                  <button
                    key={col}
                    onClick={() => { toggleColSort(col); setShowMobileSortSheet(false) }}
                    className={`flex items-center justify-between w-full px-4 py-3 rounded-xl text-sm transition-colors ${
                      colSort?.col === col ? 'bg-blue-50 text-blue-700 font-semibold' : 'bg-gray-50 text-gray-700'
                    }`}
                  >
                    <span>{label}</span>
                    {colSort?.col === col && (
                      <span className="text-xs">{colSort.dir === 'asc' ? '↑ A–Z / Low–High' : '↓ Z–A / High–Low'}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Filter Sheet */}
      {showMobileFilterSheet && (
        <div className="fixed inset-0 z-50 flex items-end sm:hidden" onClick={() => setShowMobileFilterSheet(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative bg-white w-full rounded-t-2xl p-5 pb-8" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-gray-900">Filter</h3>
              <button onClick={() => setShowMobileFilterSheet(false)}><X size={18} className="text-gray-400" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Category</label>
                <select
                  value={catFilter}
                  onChange={e => setCatFilter(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">All Categories</option>
                  {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Supplier</label>
                <select
                  value={supplierFilter}
                  onChange={e => setSupplierFilter(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">All Suppliers</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <button
                onClick={() => { setCatFilter(''); setSupplierFilter(''); setShowMobileFilterSheet(false) }}
                className="w-full py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600 font-medium"
              >
                Clear filters
              </button>
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 5: Build and confirm**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | grep -E "error TS|Error:|✓|Ready"
```

Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/inventory/page.tsx
git commit -m "feat(inventory): mobile filter pills + sort/filter bottom sheets"
```

---

## Task 5: Mobile item row renderer

**Files:**
- Modify: `src/app/inventory/page.tsx`

- [ ] **Step 1: Add `renderMobileRow` function immediately after the existing `renderRow` function (after line ~535)**

```tsx
  const renderMobileRow = (item: InventoryItem) => {
    const inStock = parseFloat(String(item.stockOnHand)) > 0
    return (
      <div
        key={`m-${item.id}`}
        onClick={() => setSelected(item)}
        className={`flex items-center gap-3 px-4 py-2.5 border-b border-gray-50 cursor-pointer active:bg-gray-50 transition-colors ${
          !inStock ? 'bg-orange-50/50' : ''
        } ${!item.isActive ? 'opacity-50' : ''}`}
      >
        <div className={`w-2 h-2 rounded-full shrink-0 ${inStock ? 'bg-green-500' : 'bg-orange-400'}`} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-gray-900 truncate">{item.itemName}</div>
          {item.allergens && item.allergens.length > 0 && (
            <div className="mt-0.5">
              <AllergenBadges allergens={item.allergens} size="xs" />
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-bold text-gray-900">
            {formatCurrency(parseFloat(String(item.purchasePrice)))}
            <span className="text-[10px] font-normal text-gray-400">/{item.purchaseUnit}</span>
          </div>
          <div className={`text-[11px] ${inStock ? 'text-gray-500' : 'text-orange-500'}`}>
            {parseFloat(String(item.stockOnHand)).toFixed(1)} {item.countUOM || item.baseUnit}
            {!inStock && ' · out of stock'}
          </div>
        </div>
        <ChevronRight size={14} className="text-gray-300 shrink-0" />
      </div>
    )
  }
```

- [ ] **Step 2: Build and confirm**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | grep -E "error TS|Error:|✓|Ready"
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/inventory/page.tsx
git commit -m "feat(inventory): renderMobileRow — thin allergen card rows"
```

---

## Task 6: Mobile list rendering

**Files:**
- Modify: `src/app/inventory/page.tsx`

This task hides the desktop table on mobile and renders the mobile list above it.

- [ ] **Step 1: Hide the desktop table wrapper on mobile**

Find:
```tsx
      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
```

Replace with:
```tsx
      {/* Table */}
      <div className="hidden sm:block bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
```

- [ ] **Step 2: Insert the mobile list immediately before the Table comment**

```tsx
      {/* Mobile list */}
      <div className="block sm:hidden bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {categoryGroups ? (
          categoryGroups.map(([cat, rows]) => {
            const catValue = rows.reduce((s, i) =>
              s + parseFloat(String(i.stockOnHand)) * parseFloat(String(i.conversionFactor)) * parseFloat(String(i.pricePerBaseUnit)), 0)
            const collapsed = collapsedCats.has(cat)
            return (
              <React.Fragment key={`mg-${cat}`}>
                <div
                  className={`flex items-center justify-between px-4 py-2 cursor-pointer border-y ${CATEGORY_HEADER[cat] ?? 'bg-gray-50 border-gray-200'}`}
                  onClick={() => setCollapsedCats(prev => {
                    const n = new Set(prev); n.has(cat) ? n.delete(cat) : n.add(cat); return n
                  })}
                >
                  <div className="flex items-center gap-2">
                    {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <span className="text-xs font-bold uppercase tracking-wider">{cat}</span>
                    <span className="text-xs opacity-60">({rows.length})</span>
                  </div>
                  <span className="text-xs font-semibold">{formatCurrency(catValue)}</span>
                </div>
                {!collapsed && rows.map(item => renderMobileRow(item))}
              </React.Fragment>
            )
          })
        ) : (
          sortedItems.map(item => renderMobileRow(item))
        )}
        {sortedItems.length === 0 && (
          <div className="text-center py-12 text-gray-400 text-sm">No items found</div>
        )}
      </div>
```

- [ ] **Step 3: Build and confirm**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | grep -E "error TS|Error:|✓|Ready"
```

Expected: build succeeds.

- [ ] **Step 4: Verify on mobile in browser**

Start the dev server if not running:
```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run dev
```

Open `http://localhost:3000/inventory` and use browser DevTools → device toggle (iPhone 390px wide). Confirm:
- Mobile header shows: title, cart icon, + Add, ⋯ overflow
- KPI strip scrolls horizontally
- Filter pills scroll horizontally; Sort and Filter buttons open bottom sheets
- List shows thin card rows with allergen badges; items with no allergens are shorter
- Category group headers are collapsible
- Tapping a row opens the detail panel
- At 640px+ the desktop table appears normally

- [ ] **Step 5: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/inventory/page.tsx
git commit -m "feat(inventory): mobile list with category groups and thin card rows"
```
