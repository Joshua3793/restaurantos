# Prep — Plan Tomorrow Mode + Delete Button

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Plan Tomorrow" view mode where managers can quickly set per-item priorities for the next day using inline chips, plus a delete button with confirmation in the more menu.

**Architecture:** Two independent surface changes. (1) Delete: add `onDelete` prop to `PrepItemRow`, inline confirm state, and a `handleDelete` in the page. The DELETE API endpoint already exists at `/api/prep/items/[id]` (soft-deletes via `isActive: false`). (2) Plan Tomorrow: a new `viewMode` value `'plan'` that switches PrepItemRow into a planning layout — inline priority chips replace the status pill, stock context (onHand / parLevel) is shown, and items at/above par with no override are faded. Priority is changed by tapping chips which call the existing `onPriorityChange` handler, updating `manualPriorityOverride`.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Tailwind CSS. No new API endpoints needed.

---

## File Map

| File | Change |
|------|--------|
| `src/components/prep/PrepItemRow.tsx` | Add `onDelete` prop + inline delete confirm; add `planMode` prop + plan layout with priority chips |
| `src/app/prep/page.tsx` | Add `'plan'` to `viewMode` type; add `handleDelete`; pass `planMode`/`onDelete` to rows; add plan banner; hide Currently Making strip in plan mode |

No new files needed.

---

## Shared constants (defined once, used in both tasks)

The plan-mode priority chips need labels and active styles. Define these at the top of `PrepItemRow.tsx` alongside the existing `STATUS_CYCLE` constant:

```typescript
// Priority values for chips; empty string = clear override (Auto)
const PLAN_CHIPS: Array<{ value: string; label: string; activeClass: string }> = [
  { value: '',            label: 'Auto', activeClass: 'bg-gray-200 text-gray-700' },
  { value: 'LATER',       label: 'Later', activeClass: 'bg-gray-200 text-gray-500' },
  { value: 'LOW_STOCK',   label: 'Low',   activeClass: 'bg-amber-100 text-amber-700' },
  { value: 'NEEDED_TODAY',label: 'Today', activeClass: 'bg-orange-100 text-orange-700' },
  { value: '911',         label: '911',   activeClass: 'bg-red-100 text-red-700 font-bold' },
]
```

---

### Task 1: Delete button in PrepItemRow

**Files:**
- Modify: `src/components/prep/PrepItemRow.tsx`

---

- [ ] **Step 1: Add `onDelete` to the Props interface**

In `src/components/prep/PrepItemRow.tsx`, update the `Props` interface (currently lines 12–17):

```typescript
interface Props {
  item: PrepItemRich
  onClick: () => void
  onStatusChange: (itemId: string, status: string, actualQty?: number) => void
  onPriorityChange: (itemId: string, priority: string) => void
  onDelete: (itemId: string) => void
  planMode?: boolean
}
```

Update the function signature to destructure the new props:

```typescript
export function PrepItemRow({ item, onClick, onStatusChange, onPriorityChange, onDelete, planMode = false }: Props) {
```

---

- [ ] **Step 2: Add `confirmingDelete` state**

Add one line below the existing `useState` declarations (after line 33 `const [confirmQty, setConfirmQty] = useState('')`):

```typescript
const [confirmingDelete, setConfirmingDelete] = useState(false)
```

---

- [ ] **Step 3: Add the PLAN_CHIPS constant below STATUS_CYCLE**

Below the existing `const INLINE_QTY_STATUSES = new Set(...)` line, add:

```typescript
const PLAN_CHIPS: Array<{ value: string; label: string; activeClass: string }> = [
  { value: '',             label: 'Auto',  activeClass: 'bg-gray-200 text-gray-700' },
  { value: 'LATER',        label: 'Later', activeClass: 'bg-gray-200 text-gray-500' },
  { value: 'LOW_STOCK',    label: 'Low',   activeClass: 'bg-amber-100 text-amber-700' },
  { value: 'NEEDED_TODAY', label: 'Today', activeClass: 'bg-orange-100 text-orange-700' },
  { value: '911',          label: '911',   activeClass: 'bg-red-100 text-red-700 font-bold' },
]
```

---

- [ ] **Step 4: Replace the `⋯` menu JSX with a version that includes Delete**

Find the `{/* More menu */}` section (currently lines 153–197). Replace it entirely with:

```tsx
{/* More menu */}
<div className="shrink-0">
  <button
    ref={menuButtonRef}
    onClick={e => {
      e.stopPropagation()
      if (!menuOpen && menuButtonRef.current) {
        const rect = menuButtonRef.current.getBoundingClientRect()
        setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
      }
      setMenuOpen(v => !v)
    }}
    className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
  >
    <MoreHorizontal size={16} />
  </button>
  {menuOpen && (
    <>
      <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
      <div
        className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-44 text-sm"
        style={{ top: menuPos.top, right: menuPos.right }}
      >
        {['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'PARTIAL', 'BLOCKED', 'SKIPPED'].map(s => (
          <button
            key={s}
            onClick={() => {
              setMenuOpen(false)
              if (INLINE_QTY_STATUSES.has(s)) {
                setConfirmQty(item.suggestedQty > 0 ? item.suggestedQty.toFixed(1) : '')
                setConfirmingDone(true)
              } else {
                onStatusChange(item.id, s)
              }
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-gray-50"
          >
            {PREP_STATUS_META[s]?.label ?? s}
          </button>
        ))}
        <div className="border-t border-gray-100 my-1" />
        <div className="px-3 py-1 text-xs text-gray-400 font-semibold uppercase">Set Priority</div>
        {PREP_PRIORITY_ORDER.map(p => (
          <button
            key={p}
            onClick={() => { onPriorityChange(item.id, p); setMenuOpen(false) }}
            className="w-full text-left px-3 py-1.5 hover:bg-gray-50"
          >
            {PREP_PRIORITY_META[p as PrepPriority].label}
          </button>
        ))}
        <div className="border-t border-gray-100 my-1" />
        {confirmingDelete ? (
          <div className="px-3 py-2">
            <p className="text-xs text-gray-600 mb-2">Delete this item?</p>
            <div className="flex gap-2">
              <button
                onClick={() => { setMenuOpen(false); setConfirmingDelete(false); onDelete(item.id) }}
                className="flex-1 px-2 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmingDelete(false)}
                className="flex-1 px-2 py-1 border border-gray-200 text-gray-600 text-xs rounded hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingDelete(true)}
            className="w-full text-left px-3 py-1.5 text-red-600 hover:bg-red-50"
          >
            Delete item
          </button>
        )}
      </div>
    </>
  )}
</div>
```

---

- [ ] **Step 5: Commit Task 1**

```bash
git add src/components/prep/PrepItemRow.tsx
git commit -m "feat: add delete button with inline confirmation to PrepItemRow more menu"
```

---

### Task 2: Plan mode layout in PrepItemRow

**Files:**
- Modify: `src/components/prep/PrepItemRow.tsx`

The plan-mode row shows: stock context (onHand / parLevel) on the left, item name + notes in the middle, inline priority chips on the right. Items at or above par with no manual override are faded to 40% opacity.

---

- [ ] **Step 1: Replace the outer `<div>` and add the plan-mode branch**

The entire `return (...)` block in `PrepItemRow` currently starts with a single `<div>`. Replace the whole return with the following (both modes):

```tsx
const isAtPar = item.onHand >= item.parLevel && !item.manualPriorityOverride
const currentOverride = item.manualPriorityOverride ?? ''

// ── PLAN TOMORROW MODE ────────────────────────────────────────────────────────
if (planMode) {
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-50 transition-opacity ${priority.borderClass} ${isAtPar ? 'opacity-40 hover:opacity-100' : ''}`}
    >
      {/* Stock context */}
      <div className="shrink-0 text-right">
        <div className="text-xs font-semibold text-gray-700">{item.onHand % 1 === 0 ? item.onHand.toFixed(0) : item.onHand.toFixed(1)}</div>
        <div className="text-xs text-gray-400">/ {item.parLevel % 1 === 0 ? item.parLevel.toFixed(0) : item.parLevel.toFixed(1)} {item.unit}</div>
      </div>

      {/* Name + notes */}
      <div className="flex-1 min-w-0 cursor-pointer" onClick={onClick}>
        <div className="text-sm font-medium text-gray-800 truncate">{item.name}</div>
        {item.notes && (
          <div className="text-xs text-amber-700 truncate">{item.notes}</div>
        )}
      </div>

      {/* Priority chips */}
      <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
        {PLAN_CHIPS.map(chip => (
          <button
            key={chip.value || 'auto'}
            onClick={() => onPriorityChange(item.id, chip.value)}
            className={`px-2 py-0.5 rounded-full text-xs transition-colors ${
              currentOverride === chip.value
                ? chip.activeClass
                : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* Detail arrow */}
      <button onClick={onClick} className="shrink-0 text-gray-400 hover:text-gray-600">
        <ChevronRight size={16} />
      </button>

      {/* More menu (delete only in plan mode) */}
      <div className="shrink-0">
        <button
          ref={menuButtonRef}
          onClick={e => {
            e.stopPropagation()
            if (!menuOpen && menuButtonRef.current) {
              const rect = menuButtonRef.current.getBoundingClientRect()
              setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
            }
            setMenuOpen(v => !v)
          }}
          className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
        >
          <MoreHorizontal size={16} />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div
              className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-44 text-sm"
              style={{ top: menuPos.top, right: menuPos.right }}
            >
              {confirmingDelete ? (
                <div className="px-3 py-2">
                  <p className="text-xs text-gray-600 mb-2">Delete this item?</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setMenuOpen(false); setConfirmingDelete(false); onDelete(item.id) }}
                      className="flex-1 px-2 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirmingDelete(false)}
                      className="flex-1 px-2 py-1 border border-gray-200 text-gray-600 text-xs rounded hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingDelete(true)}
                  className="w-full text-left px-3 py-1.5 text-red-600 hover:bg-red-50"
                >
                  Delete item
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── TODAY / NEEDS-ACTION MODE (existing layout) ───────────────────────────────
return (
  <div
    className={`flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-50 hover:bg-gray-50 transition-colors relative ${priority.borderClass}`}
  >
    {/* ... rest of existing JSX unchanged ... */}
  </div>
)
```

> **Note to implementer:** Keep the existing Today/Normal JSX exactly as it is — only wrap it in the `// ── TODAY MODE` return at the bottom. The plan-mode branch is an early return above it.

---

- [ ] **Step 2: Commit Task 2**

```bash
git add src/components/prep/PrepItemRow.tsx
git commit -m "feat: add plan-mode layout to PrepItemRow with inline priority chips and stock context"
```

---

### Task 3: Plan mode wiring in page.tsx

**Files:**
- Modify: `src/app/prep/page.tsx`

---

- [ ] **Step 1: Extend the viewMode type to include `'plan'`**

Find (line 24):
```typescript
const [viewMode, setViewMode] = useState<'today' | 'needs-action'>('today')
```
Replace with:
```typescript
const [viewMode, setViewMode] = useState<'today' | 'needs-action' | 'plan'>('today')
```

---

- [ ] **Step 2: Add `handleDelete` function**

After `handlePriorityChange` (around line 150), add:

```typescript
async function handleDelete(itemId: string) {
  try {
    await fetch(`/api/prep/items/${itemId}`, { method: 'DELETE' })
    load()
  } catch (e) {
    console.error('Failed to delete prep item', e)
    setActionError('Delete failed — try again.')
  }
}
```

---

- [ ] **Step 3: Update the `filtered` useMemo to not filter by status in plan mode**

Find the `filtered` useMemo (around line 60–68). Replace:
```typescript
  const filtered = useMemo(() => items.filter(item => {
    if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterPriority !== 'ALL' && item.priority !== filterPriority)     return false
    if (filterCategory !== 'ALL' && item.category !== filterCategory)     return false
    const s = item.todayLog?.status ?? 'NOT_STARTED'
    if (filterStatus !== 'ALL' && s !== filterStatus) return false
    if (viewMode === 'needs-action' && (s === 'DONE' || s === 'SKIPPED')) return false
    return true
  }), [items, search, filterPriority, filterCategory, filterStatus, viewMode])
```
With:
```typescript
  const filtered = useMemo(() => items.filter(item => {
    if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterPriority !== 'ALL' && item.priority !== filterPriority)     return false
    if (filterCategory !== 'ALL' && item.category !== filterCategory)     return false
    if (viewMode === 'plan') return true  // plan mode: no status filtering
    const s = item.todayLog?.status ?? 'NOT_STARTED'
    if (filterStatus !== 'ALL' && s !== filterStatus) return false
    if (viewMode === 'needs-action' && (s === 'DONE' || s === 'SKIPPED')) return false
    return true
  }), [items, search, filterPriority, filterCategory, filterStatus, viewMode])
```

---

- [ ] **Step 4: Update the view mode toggle to include "Plan Tomorrow"**

Find the view mode toggle JSX (the `flex items-center gap-1 bg-gray-100` div with the two mode buttons). Replace the whole block:

```tsx
<div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
  {(['today', 'needs-action', 'plan'] as const).map(m => (
    <button key={m}
      onClick={() => setViewMode(m)}
      className={`px-3 py-1 text-xs rounded-md transition-colors ${viewMode === m ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}
    >
      {m === 'today' ? 'Today' : m === 'needs-action' ? 'Needs Action' : 'Plan Tomorrow'}
    </button>
  ))}
</div>
```

---

- [ ] **Step 5: Hide Currently Making strip in plan mode and add a plan banner**

Find the `{/* Currently Making */}` block. Wrap it to hide in plan mode:

```tsx
{/* Currently Making — hidden in plan mode */}
{inProgress.length > 0 && viewMode !== 'plan' && (
  <div className="bg-blue-50 border border-blue-200 rounded-xl overflow-hidden">
    {/* ... existing content unchanged ... */}
  </div>
)}

{/* Plan Tomorrow banner */}
{viewMode === 'plan' && (
  <div className="bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3 flex items-center gap-3">
    <span className="text-lg">📋</span>
    <div>
      <p className="text-sm font-semibold text-indigo-800">Planning tomorrow's prep</p>
      <p className="text-xs text-indigo-600">Tap a priority chip on each item to flag it for your team. Faded items are at or above par.</p>
    </div>
  </div>
)}
```

---

- [ ] **Step 6: Pass `planMode` and `onDelete` to all PrepItemRow instances**

There are three PrepItemRow usages in the file — the Currently Making strip and the main filtered list (and inProgress list). Update all of them to include the new props.

The Currently Making rows (inside the `inProgress.map`):
```tsx
<PrepItemRow key={item.id} item={item}
  onClick={() => setSelected(item)}
  onStatusChange={handleStatusChange}
  onPriorityChange={handlePriorityChange}
  onDelete={handleDelete}
  planMode={false}
/>
```

The main filtered list rows:
```tsx
<PrepItemRow
  key={item.id}
  item={item}
  onClick={() => setSelected(item)}
  onStatusChange={handleStatusChange}
  onPriorityChange={handlePriorityChange}
  onDelete={handleDelete}
  planMode={viewMode === 'plan'}
/>
```

---

- [ ] **Step 7: Update the empty state for plan mode**

Find the empty state block (`filtered.length === 0` branch). Update the message:

```tsx
<p className="text-gray-500 text-sm">
  {items.length === 0
    ? 'No prep items yet.'
    : viewMode === 'plan'
    ? 'No items match your filters.'
    : 'Nothing matches your filters.'}
</p>
```

---

- [ ] **Step 8: Commit Task 3**

```bash
git add src/app/prep/page.tsx
git commit -m "feat: add Plan Tomorrow view mode with inline priority chips and delete handler"
```

---

## Manual Test Checklist

After all tasks are done, verify in the browser (run `npm run dev`):

- [ ] **Delete:** Open `⋯` menu on any prep item → "Delete item" appears at bottom → clicking it shows "Delete this item?" confirm → "Delete" removes the item (it disappears because `isActive` is now false and `activeOnly` is checked) → "Cancel" dismisses without deleting
- [ ] **Plan Tomorrow toggle:** Clicking "Plan Tomorrow" in the view mode switcher activates the new mode
- [ ] **Plan banner:** Blue-indigo banner appears at top of list explaining the mode
- [ ] **Currently Making strip:** Disappears in plan mode
- [ ] **Plan row layout:** Each row shows onHand / parLevel context on the left, item name in center, 5 priority chips (Auto / Later / Low / Today / 911) on the right
- [ ] **Items at par:** Items where onHand ≥ parLevel with no override appear faded (40% opacity)
- [ ] **Priority chip tap:** Tapping a chip fires `onPriorityChange` — the chip highlights and the left border color updates after reload
- [ ] **Auto chip:** Tapping "Auto" clears the manual override (calls `onPriorityChange(id, '')`)
- [ ] **Active chip:** The chip matching `item.manualPriorityOverride` (or "Auto" if none) is visually selected
- [ ] **Plan mode delete:** `⋯` menu in plan mode only shows the delete option (no status/priority items)
- [ ] **Today mode unaffected:** Switching back to "Today" restores the normal status-pill row layout
