# Allergen Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add color-coded allergen pill badges across Inventory, Recipe, and Menu pages; add bulk "Assign Allergens" action; sync allergens when unchecked; remove unused `abbreviation` field.

**Architecture:** A single `src/lib/allergens.ts` defines the 9 allergen constants (key, label, abbr, Tailwind bg class). A shared `<AllergenBadges>` component renders the pills anywhere. The bulk API gains an `assignAllergens` action. The `abbreviation` DB field and all UI references are removed via migration.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL · Tailwind CSS · Lucide icons

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `src/lib/allergens.ts` | ALLERGENS constant — single source of truth |
| Create | `src/components/AllergenBadges.tsx` | `<AllergenBadges>` pill renderer + `<BulkAllergenModal>` |
| Modify | `src/app/api/inventory/bulk/route.ts` | Add `assignAllergens` case |
| Modify | `src/app/inventory/page.tsx` | Row badges, remove abbreviation display/form, bulk allergen button |
| Modify | `src/components/recipes/shared.tsx` | RecipeCard badges row, RecipePanel replace orange block |
| Modify | `prisma/schema.prisma` | Remove `abbreviation String?` field |
| Modify | `src/app/api/recipes/route.ts` | Remove `abbreviation` from auto-created PREPD item |
| Modify | `src/app/api/inventory/[id]/route.ts` | Remove `abbreviation` from PUT destructuring comments |

---

### Task 1: Create allergen definitions

**Files:**
- Create: `src/lib/allergens.ts`

- [ ] **Step 1: Create the file**

```typescript
// src/lib/allergens.ts
export interface AllergenDef {
  key: string      // matches DB value e.g. "Wheat/Gluten"
  label: string    // full display name
  abbr: string     // 3-letter badge label
  bg: string       // Tailwind bg class (must be full class name for purge safety)
  text: string     // Tailwind text class for tooltip contrast
}

export const ALLERGENS: AllergenDef[] = [
  { key: 'Wheat/Gluten', label: 'Wheat / Gluten', abbr: 'GLU', bg: 'bg-amber-500',  text: 'text-white' },
  { key: 'Milk',         label: 'Milk',            abbr: 'MLK', bg: 'bg-sky-500',    text: 'text-white' },
  { key: 'Eggs',         label: 'Eggs',            abbr: 'EGG', bg: 'bg-yellow-400', text: 'text-gray-900' },
  { key: 'Peanuts',      label: 'Peanuts',         abbr: 'PNT', bg: 'bg-orange-500', text: 'text-white' },
  { key: 'Tree Nuts',    label: 'Tree Nuts',       abbr: 'NUT', bg: 'bg-stone-500',  text: 'text-white' },
  { key: 'Sesame',       label: 'Sesame',          abbr: 'SES', bg: 'bg-lime-500',   text: 'text-white' },
  { key: 'Soy',          label: 'Soy',             abbr: 'SOY', bg: 'bg-green-600',  text: 'text-white' },
  { key: 'Fish',         label: 'Fish',            abbr: 'FSH', bg: 'bg-teal-500',   text: 'text-white' },
  { key: 'Shellfish',    label: 'Shellfish',       abbr: 'SHL', bg: 'bg-red-500',    text: 'text-white' },
]

export const ALLERGEN_MAP = Object.fromEntries(ALLERGENS.map(a => [a.key, a]))
```

- [ ] **Step 2: Verify TypeScript is happy**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors related to allergens.ts

- [ ] **Step 3: Commit**

```bash
git add src/lib/allergens.ts
git commit -m "feat: add allergen definitions constant"
```

---

### Task 2: Create AllergenBadges component

**Files:**
- Create: `src/components/AllergenBadges.tsx`

- [ ] **Step 1: Create the shared component**

```tsx
// src/components/AllergenBadges.tsx
'use client'
import { ALLERGENS, ALLERGEN_MAP } from '@/lib/allergens'

interface Props {
  allergens: string[]
  size?: 'xs' | 'sm'  // xs = list rows, sm = panels/cards
}

export function AllergenBadges({ allergens, size = 'xs' }: Props) {
  if (!allergens || allergens.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {allergens.map(key => {
        const def = ALLERGEN_MAP[key]
        if (!def) return null
        return (
          <span
            key={key}
            title={def.label}
            className={`inline-flex items-center rounded font-bold leading-none ${def.bg} ${def.text} ${
              size === 'xs'
                ? 'px-1 py-0.5 text-[9px] tracking-wide'
                : 'px-1.5 py-1 text-[11px] tracking-wide'
            }`}
          >
            {def.abbr}
          </span>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Create BulkAllergenModal in the same file**

Append to `src/components/AllergenBadges.tsx`:

```tsx
import { useState } from 'react'
import { X } from 'lucide-react'

interface BulkAllergenModalProps {
  onClose: () => void
  onApply: (allergens: string[], mode: 'add' | 'replace') => void
}

export function BulkAllergenModal({ onClose, onApply }: BulkAllergenModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<'add' | 'replace'>('add')

  const toggle = (key: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">Assign Allergens</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
        </div>

        {/* Mode toggle */}
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5 mb-4 w-fit">
          {(['add', 'replace'] as const).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                mode === m ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {m === 'add' ? 'Add to existing' : 'Replace all'}
            </button>
          ))}
        </div>

        {/* Allergen toggles */}
        <div className="grid grid-cols-3 gap-2 mb-5">
          {ALLERGENS.map(a => {
            const on = selected.has(a.key)
            return (
              <button
                key={a.key}
                onClick={() => toggle(a.key)}
                className={`flex flex-col items-center gap-1 p-2 rounded-xl border-2 transition-all ${
                  on ? `border-transparent ${a.bg}` : 'border-gray-200 hover:border-gray-300 bg-white'
                }`}
              >
                <span className={`text-[10px] font-bold tracking-wide ${on ? 'text-white' : 'text-gray-500'}`}>
                  {a.abbr}
                </span>
                <span className={`text-[9px] leading-tight text-center ${on ? 'text-white/80' : 'text-gray-400'}`}>
                  {a.label}
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onApply(Array.from(selected), mode)}
            disabled={selected.size === 0}
            className="flex-1 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Apply to {'{count}'} items
          </button>
          <button onClick={onClose} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
```

Note: `{'{count}'}` is a placeholder — in the real file write the JSX expression `{count}` where `count` is passed as a prop. Update the component signature to accept `count: number` and pass it from the inventory page.

- [ ] **Step 2b: Fix the count prop — update BulkAllergenModal signature**

```tsx
// Updated interface and button label
interface BulkAllergenModalProps {
  count: number
  onClose: () => void
  onApply: (allergens: string[], mode: 'add' | 'replace') => void
}
// In the button:
Apply to {count} items
```

- [ ] **Step 3: Build check**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | grep -E "error|Error|✓ Compiled" | head -10
```
Expected: `✓ Compiled successfully`

- [ ] **Step 4: Commit**

```bash
git add src/components/AllergenBadges.tsx
git commit -m "feat: add AllergenBadges and BulkAllergenModal components"
```

---

### Task 3: Add bulk assignAllergens API action

**Files:**
- Modify: `src/app/api/inventory/bulk/route.ts`

- [ ] **Step 1: Add the case and import syncPrepToInventory**

Replace the full file content:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncPrepToInventory } from '@/lib/recipeCosts'

export async function POST(req: NextRequest) {
  try {
    const { ids, action, value } = await req.json()

    switch (action) {
      case 'activate':
        await prisma.inventoryItem.updateMany({ where: { id: { in: ids } }, data: { isActive: true } })
        break
      case 'deactivate':
        await prisma.inventoryItem.updateMany({ where: { id: { in: ids } }, data: { isActive: false } })
        break
      case 'setSupplier':
        await prisma.inventoryItem.updateMany({ where: { id: { in: ids } }, data: { supplierId: value } })
        break
      case 'setStorageArea':
        await prisma.inventoryItem.updateMany({ where: { id: { in: ids } }, data: { storageAreaId: value } })
        break
      case 'setCategory':
        await prisma.inventoryItem.updateMany({ where: { id: { in: ids } }, data: { category: value } })
        break
      case 'assignAllergens': {
        // value: { allergens: string[], mode: 'add' | 'replace' }
        const { allergens: newAllergens, mode } = value as { allergens: string[]; mode: 'add' | 'replace' }
        if (mode === 'replace') {
          await prisma.inventoryItem.updateMany({ where: { id: { in: ids } }, data: { allergens: newAllergens } })
        } else {
          // 'add' mode: merge per item
          const items = await prisma.inventoryItem.findMany({
            where: { id: { in: ids } },
            select: { id: true, allergens: true },
          })
          await Promise.all(items.map(item => {
            const merged = Array.from(new Set([...item.allergens, ...newAllergens]))
            return prisma.inventoryItem.update({ where: { id: item.id }, data: { allergens: merged } })
          }))
        }
        // Cascade sync: any linked PREP recipe that uses these items
        const affectedRecipes = await prisma.recipe.findMany({
          where: {
            type: 'PREP',
            inventoryItemId: { not: null },
            ingredients: { some: { inventoryItemId: { in: ids } } },
          },
          select: { id: true },
        })
        await Promise.all(affectedRecipes.map(r => syncPrepToInventory(r.id)))
        break
      }
      case 'delete':
        await prisma.$transaction([
          prisma.recipeIngredient.updateMany({
            where: { inventoryItemId: { in: ids } },
            data:  { inventoryItemId: null },
          }),
          prisma.recipe.updateMany({
            where: { inventoryItemId: { in: ids } },
            data:  { inventoryItemId: null },
          }),
          prisma.invoiceScanItem.updateMany({
            where: { matchedItemId: { in: ids } },
            data:  { matchedItemId: null },
          }),
          prisma.invoiceLineItem.deleteMany({ where: { inventoryItemId: { in: ids } } }),
          prisma.countLine.deleteMany({ where: { inventoryItemId: { in: ids } } }),
          prisma.inventorySnapshot.deleteMany({ where: { inventoryItemId: { in: ids } } }),
          prisma.wastageLog.deleteMany({ where: { inventoryItemId: { in: ids } } }),
          prisma.priceAlert.deleteMany({ where: { inventoryItemId: { in: ids } } }),
          prisma.invoiceMatchRule.deleteMany({ where: { inventoryItemId: { in: ids } } }),
          prisma.inventoryItem.deleteMany({ where: { id: { in: ids } } }),
        ])
        break
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    return NextResponse.json({ success: true, affected: ids.length })
  } catch (err) {
    console.error('[bulk] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
```

- [ ] **Step 2: Build check**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | grep -E "error|Error|✓ Compiled" | head -10
```
Expected: `✓ Compiled successfully`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/inventory/bulk/route.ts
git commit -m "feat: add assignAllergens bulk API action with cascade sync"
```

---

### Task 4: Update inventory page — badges, bulk UI, remove abbreviation

**Files:**
- Modify: `src/app/inventory/page.tsx`

This task has multiple sub-steps. Read the current file carefully before each edit.

- [ ] **Step 1: Add imports at top of file**

Find the existing import block and add:
```tsx
import { AllergenBadges, BulkAllergenModal } from '@/components/AllergenBadges'
import { ALLERGENS } from '@/lib/allergens'
```

- [ ] **Step 2: Add state for bulk allergen modal**

Find where other `useState` declarations are (around lines 60-75). Add:
```tsx
const [showBulkAllergen, setShowBulkAllergen] = useState(false)
```

- [ ] **Step 3: Add executeBulkAllergen handler**

Find the `executeBulk` function and add a new handler after it:
```tsx
const executeBulkAllergen = async (allergens: string[], mode: 'add' | 'replace') => {
  setShowBulkAllergen(false)
  await fetch('/api/inventory/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: Array.from(checkedIds), action: 'assignAllergens', value: { allergens, mode } }),
  })
  fetchItems()
  setCheckedIds(new Set())
}
```

- [ ] **Step 4: Replace abbreviation subtitle with AllergenBadges in the row renderer**

Find (around line 461):
```tsx
{item.abbreviation && <div className="text-xs text-gray-400">{item.abbreviation}</div>}
```
Replace with:
```tsx
<AllergenBadges allergens={item.allergens ?? []} size="xs" />
```

- [ ] **Step 5: Add "Assign Allergens" button to bulk bar**

Find the bulk action bar (around line 653, after the Deactivate button). Add a new button after Deactivate:
```tsx
<button
  onClick={() => setShowBulkAllergen(true)}
  className="px-3 py-1.5 bg-white border border-gray-200 text-xs rounded-lg hover:bg-gray-50 flex items-center gap-1"
>
  Assign Allergens
</button>
```

- [ ] **Step 6: Render BulkAllergenModal conditionally**

Find the bottom of the component return (before the closing `</div>`), add:
```tsx
{showBulkAllergen && (
  <BulkAllergenModal
    count={checkedIds.size}
    onClose={() => setShowBulkAllergen(false)}
    onApply={executeBulkAllergen}
  />
)}
```

- [ ] **Step 7: Remove abbreviation from the new item form state**

Find (around line 69):
```tsx
abbreviation: '', location: '', allergens: [] as string[],
```
Remove `abbreviation: '',` so it becomes:
```tsx
location: '', allergens: [] as string[],
```

- [ ] **Step 8: Remove abbreviation from the reset/initial state** (around line 201)

Find and remove any `abbreviation: '',` from the editForm initial state and reset calls.

- [ ] **Step 9: Remove abbreviation input field from the detail panel form**

Search for `abbreviation` in the detail panel JSX (it will be an `<input>` with label "Abbreviation" or similar). Remove the entire label + input block.

- [ ] **Step 10: Remove abbreviation from the form submission body**

Find `abbreviation: editForm.abbreviation,` in the PUT body and remove it.

- [ ] **Step 11: Build check**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | grep -E "error TS|✓ Compiled" | head -20
```
Fix any TypeScript errors (they will be about `abbreviation` references you missed).

- [ ] **Step 12: Commit**

```bash
git add src/app/inventory/page.tsx
git commit -m "feat: allergen badges in inventory rows, bulk assign allergens, remove abbreviation UI"
```

---

### Task 5: Update recipes shared — RecipeCard badges and RecipePanel

**Files:**
- Modify: `src/components/recipes/shared.tsx`

- [ ] **Step 1: Add import**

At the top of `src/components/recipes/shared.tsx`, add:
```tsx
import { AllergenBadges } from '@/components/AllergenBadges'
```

- [ ] **Step 2: Add allergen badges row to RecipeCard**

Find the yield subtitle block in RecipeCard (around line 183–213). After the closing `</div>` of the subtitle `<div className="text-xs text-gray-400 mt-0.5 ...">`, add:
```tsx
{recipe.allergens && recipe.allergens.length > 0 && (
  <div className="mt-1">
    <AllergenBadges allergens={recipe.allergens} size="xs" />
  </div>
)}
```

- [ ] **Step 3: Replace orange allergen block in RecipePanel**

Find (around line 925–935):
```tsx
{/* Allergen matrix — inherited from ingredients */}
{recipe.allergens && recipe.allergens.length > 0 && (
  <div className="bg-orange-50 border border-orange-200 rounded-xl p-3">
    <div className="text-xs font-bold uppercase tracking-wide text-orange-700 mb-2">⚠ Contains Allergens</div>
    <div className="flex flex-wrap gap-1.5">
      {recipe.allergens.map(a => (
        <span key={a} className="px-2 py-0.5 rounded-full text-xs bg-orange-100 border border-orange-300 text-orange-800 font-medium">{a}</span>
      ))}
    </div>
  </div>
)}
```
Replace with:
```tsx
{recipe.allergens && recipe.allergens.length > 0 && (
  <div className="flex flex-col gap-1.5">
    <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Allergens</span>
    <AllergenBadges allergens={recipe.allergens} size="sm" />
  </div>
)}
```

- [ ] **Step 4: Build check**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | grep -E "error TS|✓ Compiled" | head -20
```
Expected: `✓ Compiled successfully`

- [ ] **Step 5: Commit**

```bash
git add src/components/recipes/shared.tsx
git commit -m "feat: allergen badges in RecipeCard and RecipePanel"
```

---

### Task 6: Remove abbreviation from DB schema and API

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/app/api/recipes/route.ts`
- Modify: `src/app/api/inventory/[id]/route.ts`

- [ ] **Step 1: Remove abbreviation from schema**

In `prisma/schema.prisma`, find and remove this line from the `InventoryItem` model:
```
abbreviation       String?
```

- [ ] **Step 2: Remove abbreviation from PREP item auto-creation in recipes API**

In `src/app/api/recipes/route.ts`, find the `prisma.inventoryItem.create` block (around line 126). Remove:
```typescript
abbreviation: name.substring(0, 8).toUpperCase().replace(/\s/g, ''),
```

- [ ] **Step 3: Remove abbreviation from inventory PUT destructuring**

In `src/app/api/inventory/[id]/route.ts`, the `...rest` spread in the PUT handler will include abbreviation from any client still sending it — that's fine, Prisma will ignore unknown fields in `...rest` once it's removed from the schema. No change needed here.

- [ ] **Step 4: Run migration**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npx prisma migrate dev --name remove-abbreviation
```
Expected: Migration created and applied. Prisma client regenerated.

- [ ] **Step 5: Final build check**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | grep -E "error TS|✓ Compiled" | head -20
```
Expected: `✓ Compiled successfully`

- [ ] **Step 6: Restart dev server**

```bash
pkill -f "next dev"; sleep 1; npm run dev > /tmp/nextjs-dev.log 2>&1 &
sleep 5 && curl -s http://localhost:3000 > /dev/null && echo "Server up"
```

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ src/app/api/recipes/route.ts
git commit -m "feat: remove abbreviation field from DB and API"
```

---

## Self-Review

**Spec coverage:**
- ✅ Allergen badges on inventory rows (Task 4, Step 4)
- ✅ Allergen badges on recipe cards (Task 5, Step 2)
- ✅ Allergen badges on menu cards — menu page uses `RecipeCard` from shared.tsx, so covered automatically by Task 5
- ✅ Allergen badges in recipe panel (Task 5, Step 3)
- ✅ Bulk "Assign Allergens" action (Tasks 3 + 4)
- ✅ Allergen sync on uncheck — covered by existing cascade sync in `PUT /api/inventory/[id]` which detects allergen changes in either direction
- ✅ Remove abbreviation from UI (Task 4, Steps 7–10)
- ✅ Remove abbreviation from DB (Task 6)
- ✅ Shared badge component used across all three pages (Task 2)
- ✅ ALLERGENS constant as single source of truth (Task 1)

**Placeholder scan:** No TBDs. Task 2 Step 2b clarifies the count prop inline. All code blocks are complete.

**Type consistency:** `AllergenBadges` takes `allergens: string[]` and `size?: 'xs' | 'sm'` — used consistently in Tasks 4 and 5. `BulkAllergenModal` takes `count: number`, `onClose`, `onApply` — matches usage in Task 4 Steps 5–6.
