# Prep — Editable Categories & Stations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users add, rename, and delete the categories and stations used in prep items through a settings modal on the prep page.

**Architecture:** Add a `PrepSettings` singleton row to the database (id = `"singleton"`, `categories String[]`, `stations String[]`). A `GET /api/prep/settings` endpoint returns the lists (seeding defaults on first access via upsert). A `PUT /api/prep/settings` endpoint saves changes. A new `PrepSettingsModal` component renders the editor. `PrepItemForm` fetches from the API instead of importing the hardcoded constants. The existing `PREP_CATEGORIES`/`PREP_STATIONS` constants in `prep-utils.ts` become the seed defaults — they are not removed.

**Tech Stack:** Next.js 14 App Router, Prisma ORM, PostgreSQL (Supabase — native `String[]` arrays already used in schema), TypeScript, Tailwind CSS.

---

## File Map

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `PrepSettings` model |
| `src/app/api/prep/settings/route.ts` | **New** — GET (seed + return) and PUT (update) |
| `src/components/prep/PrepSettingsModal.tsx` | **New** — modal for editing categories and stations |
| `src/components/prep/PrepItemForm.tsx` | Fetch categories/stations from `/api/prep/settings` instead of importing constants |
| `src/app/prep/page.tsx` | Add settings (gear) button to header; toggle `showSettings` state; render modal |

---

### Task 1: Database schema + migration

**Files:**
- Modify: `prisma/schema.prisma`

---

- [ ] **Step 1: Add `PrepSettings` model to the schema**

Open `prisma/schema.prisma`. At the very end of the file, after the `PrepLog` model, add:

```prisma
model PrepSettings {
  id         String   @id @default("singleton")
  categories String[]
  stations   String[]
  updatedAt  DateTime @updatedAt
}
```

The `@id @default("singleton")` pattern ensures there is always exactly one row. Postgres native `String[]` is already used in this schema (`allergens String[] @default([])` on `InventoryItem`), so this is consistent.

---

- [ ] **Step 2: Push the schema to the database**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
npx prisma db push
```

Expected output includes `✓ Your database is now in sync with your Prisma schema.`

---

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add PrepSettings model for editable prep categories and stations"
```

---

### Task 2: API endpoint

**Files:**
- Create: `src/app/api/prep/settings/route.ts`

The GET endpoint uses `upsert` to seed default values on first access — no separate migration seed script needed.

The default categories come from `PREP_CATEGORIES` in `prep-utils.ts`:
`['MISC', 'SAUCE', 'DRESSING', 'PROTEIN', 'BAKED', 'GARNISH', 'BASE', 'PICKLED', 'DAIRY']`

The default stations come from `PREP_STATIONS` in `prep-utils.ts`:
`['Cold', 'Hot', 'Pastry', 'Butchery', 'Garde Manger']`

---

- [ ] **Step 1: Create the route file**

Create `src/app/api/prep/settings/route.ts` with this exact content:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const DEFAULT_CATEGORIES = [
  'MISC', 'SAUCE', 'DRESSING', 'PROTEIN', 'BAKED',
  'GARNISH', 'BASE', 'PICKLED', 'DAIRY',
]
const DEFAULT_STATIONS = ['Cold', 'Hot', 'Pastry', 'Butchery', 'Garde Manger']

export async function GET() {
  try {
    const settings = await prisma.prepSettings.upsert({
      where:  { id: 'singleton' },
      update: {},
      create: { id: 'singleton', categories: DEFAULT_CATEGORIES, stations: DEFAULT_STATIONS },
    })
    return NextResponse.json({ categories: settings.categories, stations: settings.stations })
  } catch (err) {
    console.error('[prep/settings GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const categories: string[] = Array.isArray(body.categories) ? body.categories.map(String) : DEFAULT_CATEGORIES
    const stations:   string[] = Array.isArray(body.stations)   ? body.stations.map(String)   : DEFAULT_STATIONS

    // Reject empty lists — always keep at least one value
    if (categories.length === 0 || stations.length === 0) {
      return NextResponse.json({ error: 'Lists cannot be empty' }, { status: 400 })
    }

    const settings = await prisma.prepSettings.upsert({
      where:  { id: 'singleton' },
      update: { categories, stations },
      create: { id: 'singleton', categories, stations },
    })
    return NextResponse.json({ categories: settings.categories, stations: settings.stations })
  } catch (err) {
    console.error('[prep/settings PUT]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

---

- [ ] **Step 2: Verify the endpoint works**

Start the dev server if not running: `npm run dev`

Test GET (should return defaults on first call):
```bash
curl http://localhost:3000/api/prep/settings
```
Expected:
```json
{"categories":["MISC","SAUCE","DRESSING","PROTEIN","BAKED","GARNISH","BASE","PICKLED","DAIRY"],"stations":["Cold","Hot","Pastry","Butchery","Garde Manger"]}
```

Test PUT:
```bash
curl -X PUT http://localhost:3000/api/prep/settings \
  -H "Content-Type: application/json" \
  -d '{"categories":["SAUCE","PROTEIN","TEST"],"stations":["Cold","Hot"]}'
```
Expected: JSON with the updated arrays.

Test empty-list guard:
```bash
curl -X PUT http://localhost:3000/api/prep/settings \
  -H "Content-Type: application/json" \
  -d '{"categories":[],"stations":["Cold"]}'
```
Expected: `{"error":"Lists cannot be empty"}` with status 400.

---

- [ ] **Step 3: Commit**

```bash
git add src/app/api/prep/settings/route.ts
git commit -m "feat: add GET/PUT /api/prep/settings endpoint with default seeding"
```

---

### Task 3: PrepSettingsModal component

**Files:**
- Create: `src/components/prep/PrepSettingsModal.tsx`

This modal has two sections — Categories and Stations — each with an editable list (add, rename inline, delete) and a Save button that calls `PUT /api/prep/settings`.

---

- [ ] **Step 1: Create the component**

Create `src/components/prep/PrepSettingsModal.tsx` with this exact content:

```tsx
'use client'
import { useState, useEffect } from 'react'
import { X, Plus, Trash2 } from 'lucide-react'

interface Props {
  onClose: () => void
  onSaved: () => void  // called after successful save so forms re-fetch
}

export function PrepSettingsModal({ onClose, onSaved }: Props) {
  const [categories, setCategories] = useState<string[]>([])
  const [stations,   setStations]   = useState<string[]>([])
  const [newCategory, setNewCategory] = useState('')
  const [newStation,  setNewStation]  = useState('')
  const [saving,  setSaving]  = useState(false)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/prep/settings')
      .then(r => r.json())
      .then(data => {
        setCategories(data.categories ?? [])
        setStations(data.stations ?? [])
        setLoading(false)
      })
      .catch(() => {
        setError('Failed to load settings')
        setLoading(false)
      })
  }, [])

  async function handleSave() {
    if (categories.length === 0 || stations.length === 0) {
      setError('Both lists must have at least one entry.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/prep/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories, stations }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error ?? 'Failed to save')
      } else {
        onSaved()
        onClose()
      }
    } catch {
      setError('Network error — try again.')
    } finally {
      setSaving(false)
    }
  }

  function addCategory() {
    const v = newCategory.trim()
    if (!v || categories.includes(v)) return
    setCategories(prev => [...prev, v])
    setNewCategory('')
  }

  function removeCategory(idx: number) {
    setCategories(prev => prev.filter((_, i) => i !== idx))
  }

  function updateCategory(idx: number, val: string) {
    setCategories(prev => prev.map((c, i) => i === idx ? val : c))
  }

  function addStation() {
    const v = newStation.trim()
    if (!v || stations.includes(v)) return
    setStations(prev => [...prev, v])
    setNewStation('')
  }

  function removeStation(idx: number) {
    setStations(prev => prev.filter((_, i) => i !== idx))
  }

  function updateStation(idx: number, val: string) {
    setStations(prev => prev.map((s, i) => i === idx ? val : s))
  }

  const inputCls = 'border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-full'

  function ListEditor({
    label,
    items,
    onUpdate,
    onRemove,
    newValue,
    onNewValueChange,
    onAdd,
    addPlaceholder,
  }: {
    label: string
    items: string[]
    onUpdate: (idx: number, val: string) => void
    onRemove: (idx: number) => void
    newValue: string
    onNewValueChange: (v: string) => void
    onAdd: () => void
    addPlaceholder: string
  }) {
    return (
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">{label}</h3>
        <div className="space-y-1.5 mb-3">
          {items.map((item, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                className={inputCls}
                value={item}
                onChange={e => onUpdate(idx, e.target.value)}
              />
              <button
                type="button"
                onClick={() => onRemove(idx)}
                disabled={items.length <= 1}
                className="shrink-0 p-1.5 text-gray-400 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            className={inputCls}
            value={newValue}
            onChange={e => onNewValueChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onAdd() } }}
            placeholder={addPlaceholder}
          />
          <button
            type="button"
            onClick={onAdd}
            disabled={!newValue.trim()}
            className="shrink-0 p-1.5 text-blue-600 hover:text-blue-700 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Add"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">Prep Settings</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
          </div>
        ) : (
          <div className="p-5 space-y-6">
            <ListEditor
              label="Categories"
              items={categories}
              onUpdate={updateCategory}
              onRemove={removeCategory}
              newValue={newCategory}
              onNewValueChange={setNewCategory}
              onAdd={addCategory}
              addPlaceholder="Add category…"
            />
            <div className="border-t border-gray-100" />
            <ListEditor
              label="Stations"
              items={stations}
              onUpdate={updateStation}
              onRemove={removeStation}
              newValue={newStation}
              onNewValueChange={setNewStation}
              onAdd={addStation}
              addPlaceholder="Add station…"
            />

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
                Cancel
              </button>
              <button type="button" onClick={handleSave} disabled={saving}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
```

---

- [ ] **Step 2: Commit**

```bash
git add src/components/prep/PrepSettingsModal.tsx
git commit -m "feat: add PrepSettingsModal for editing prep categories and stations"
```

---

### Task 4: PrepItemForm — fetch from API

**Files:**
- Modify: `src/components/prep/PrepItemForm.tsx`

Currently the form imports `PREP_CATEGORIES` and `PREP_STATIONS` from `@/lib/prep-utils` and uses them directly. Replace this with a fetch from `/api/prep/settings` on mount.

---

- [ ] **Step 1: Remove the static imports and add API fetch**

At the top of `src/components/prep/PrepItemForm.tsx`, find:

```typescript
import { PREP_CATEGORIES, PREP_STATIONS, PREP_PRIORITY_META, PREP_PRIORITY_ORDER } from '@/lib/prep-utils'
```

Replace with:

```typescript
import { PREP_PRIORITY_META, PREP_PRIORITY_ORDER } from '@/lib/prep-utils'

const DEFAULT_CATEGORIES = ['MISC', 'SAUCE', 'DRESSING', 'PROTEIN', 'BAKED', 'GARNISH', 'BASE', 'PICKLED', 'DAIRY']
const DEFAULT_STATIONS   = ['Cold', 'Hot', 'Pastry', 'Butchery', 'Garde Manger']
```

---

- [ ] **Step 2: Add categories and stations state**

Inside `PrepItemForm`, the existing state declarations start with `const [form, setForm] = useState(BLANK)`. After `const [error, setError] = useState<string | null>(null)`, add:

```typescript
const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES)
const [stations,   setStations]   = useState<string[]>(DEFAULT_STATIONS)
```

---

- [ ] **Step 3: Add a useEffect to fetch settings**

There is already a `useEffect` that fetches recipes:

```typescript
useEffect(() => {
  fetch('/api/recipes?type=PREP&isActive=true')
    .then(r => r.json())
    .then((data: Recipe[]) => setRecipes(Array.isArray(data) ? data : []))
}, [])
```

Add a second `useEffect` directly after it:

```typescript
useEffect(() => {
  fetch('/api/prep/settings')
    .then(r => r.json())
    .then(data => {
      if (Array.isArray(data.categories)) setCategories(data.categories)
      if (Array.isArray(data.stations))   setStations(data.stations)
    })
    .catch(() => { /* keep defaults on error */ })
}, [])
```

---

- [ ] **Step 4: Use the state arrays in the JSX**

Find the Category `<select>`:
```tsx
{PREP_CATEGORIES.map(c => <option key={c}>{c}</option>)}
```
Replace with:
```tsx
{categories.map(c => <option key={c}>{c}</option>)}
```

Find the Station `<select>`:
```tsx
{PREP_STATIONS.map(s => <option key={s}>{s}</option>)}
```
Replace with:
```tsx
{stations.map(s => <option key={s}>{s}</option>)}
```

---

- [ ] **Step 5: Commit**

```bash
git add src/components/prep/PrepItemForm.tsx
git commit -m "feat: PrepItemForm fetches categories and stations from API instead of hardcoded constants"
```

---

### Task 5: Prep page — settings button + modal

**Files:**
- Modify: `src/app/prep/page.tsx`

---

- [ ] **Step 1: Add the import**

At the top of `src/app/prep/page.tsx`, add the new modal import alongside the existing prep component imports:

```typescript
import { PrepSettingsModal } from '@/components/prep/PrepSettingsModal'
```

Also add `Settings` to the lucide-react import line:
```typescript
import { ChefHat, Plus, RefreshCw, Search, Settings } from 'lucide-react'
```

---

- [ ] **Step 2: Add `showSettings` state**

After the existing `const [showAdd, setShowAdd] = useState(false)` line, add:

```typescript
const [showSettings, setShowSettings] = useState(false)
```

---

- [ ] **Step 3: Add the Settings button to the header**

Find the header buttons section (the `div` containing the Refresh and Add Prep Item buttons). Add the Settings button as the first button, before Refresh:

```tsx
<button
  onClick={() => setShowSettings(true)}
  className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50"
  title="Edit categories & stations"
>
  <Settings size={14} />
  Settings
</button>
```

---

- [ ] **Step 4: Render the modal**

At the bottom of the JSX, after the Edit form `{editing && ...}` block, add:

```tsx
{/* Settings modal */}
{showSettings && (
  <PrepSettingsModal
    onClose={() => setShowSettings(false)}
    onSaved={() => setShowSettings(false)}
  />
)}
```

---

- [ ] **Step 5: Commit**

```bash
git add src/app/prep/page.tsx
git commit -m "feat: add Settings button to prep page header to open category/station editor"
```

---

## Manual Test Checklist

After all tasks, verify in the browser (`npm run dev`, navigate to `/prep`):

- [ ] **Settings button** is visible in the prep page header
- [ ] Clicking it opens a modal titled "Prep Settings" with two sections: Categories and Stations
- [ ] Default values are pre-populated from the database (first load seeds defaults)
- [ ] **Add category**: type a new name in the add input, press Enter or click `+` → appears in list
- [ ] **Rename category**: edit an existing category inline → value updates in the input
- [ ] **Delete category**: click the trash icon → item removed (disabled when only 1 left)
- [ ] **Add/rename/delete station**: same as above for stations
- [ ] **Save**: click "Save Changes" → modal closes, database updated
- [ ] **Verify in PrepItemForm**: open "Add Prep Item" → Category and Station dropdowns reflect the saved values (not the old hardcoded defaults)
- [ ] **Duplicate guard**: adding a category that already exists does nothing
- [ ] **Empty list guard**: deleting all but the last item disables the trash icon
