# Recipe Editor Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the 2-3 second lag in recipe editing by removing redundant server round-trips, deferring list reloads to panel close, adding optimistic UI for ingredient edits, and caching ingredient search results.

**Architecture:** Five targeted changes: (1) server routes skip `syncPrepToInventory` for non-cost fields and return the full updated recipe so the client never re-fetches; (2) `RecipePanel` uses those responses and defers `onUpdated` to panel close; (3) ingredient edits apply an optimistic local state update before the PATCH resolves; (4) ingredient search caches results client-side and drops a heavy nested DB include; (5) the page-level recipe search is debounced and `IngredientRow` is memoized.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma, React (useRef/memo), `@/lib/uom` convertQty for optimistic cost.

---

## File Structure

| File | Change |
|---|---|
| `src/app/api/recipes/[id]/route.ts` | Guard `syncPrepToInventory` to cost-affecting fields only |
| `src/app/api/recipes/[id]/ingredients/[ingredientId]/route.ts` | Guard sync; return full recipe from PATCH and DELETE |
| `src/app/api/recipes/search-ingredients/route.ts` | Drop heavy ingredient include from PREP query; use synced `inventoryItem.pricePerBaseUnit` |
| `src/components/recipes/shared.tsx` | Use PATCH/DELETE responses; defer `onUpdated`; optimistic ingredient updates; search cache; React.memo IngredientRow |
| `src/app/recipes/page.tsx` | Debounce page-level recipe search |

---

## Task 1: Optimize server routes — guard syncPrepToInventory, return full recipe

**Files:**
- Modify: `src/app/api/recipes/[id]/route.ts`
- Modify: `src/app/api/recipes/[id]/ingredients/[ingredientId]/route.ts`

### Background

**`syncPrepToInventory`** is expensive: it calls `fetchRecipeWithCost` (deep Prisma include across all ingredients + linked recipes) and then writes to `inventoryItem`. It runs unconditionally on every PATCH today — even for name, notes, isActive, category, or sort-order changes.

**`ingredients/[ingredientId]/route.ts` PATCH** currently returns only the updated `RecipeIngredient` row. The client must then call `GET /api/recipes/:id` (another `fetchRecipeWithCost`) to refresh state. We fix this by having the PATCH return the full recipe so the client can skip that re-fetch.

Same for DELETE: currently returns `{ success: true }`. Changing it to return the full updated recipe eliminates the client's `load()` after every delete.

- [ ] **Step 1: Update `src/app/api/recipes/[id]/route.ts`**

Replace the file contents with:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fetchRecipeWithCost, syncPrepToInventory } from '@/lib/recipeCosts'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const recipe = await fetchRecipeWithCost(params.id)
  if (!recipe) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(recipe)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const { name, categoryId, baseYieldQty, yieldUnit, portionSize, portionUnit, menuPrice, notes, isActive } = body

  await prisma.recipe.update({
    where: { id: params.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(baseYieldQty !== undefined ? { baseYieldQty: parseFloat(baseYieldQty) } : {}),
      ...(yieldUnit !== undefined ? { yieldUnit } : {}),
      ...(portionSize !== undefined ? { portionSize: portionSize ? parseFloat(portionSize) : null } : {}),
      ...(portionUnit !== undefined ? { portionUnit } : {}),
      ...(menuPrice !== undefined ? { menuPrice: menuPrice ? parseFloat(menuPrice) : null } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
    },
  })

  // Only sync to inventory when fields that affect cost change (yield quantity/unit).
  // name, notes, isActive, categoryId, menuPrice, portionSize/Unit do not affect cost.
  const costAffecting = baseYieldQty !== undefined || yieldUnit !== undefined
  if (costAffecting) await syncPrepToInventory(params.id)

  const updated = await fetchRecipeWithCost(params.id)
  return NextResponse.json(updated)
}

// Hard delete — cleans up references before removing the row
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id
  try {
    await prisma.$transaction(async tx => {
      await tx.recipeIngredient.updateMany({ where: { linkedRecipeId: id }, data: { linkedRecipeId: null } })
      await tx.saleLineItem.deleteMany({ where: { recipeId: id } })
      await tx.prepItem.updateMany({ where: { linkedRecipeId: id }, data: { linkedRecipeId: null } })
      await tx.recipeAlert.deleteMany({ where: { recipeId: id } })
      const recipe = await tx.recipe.findUnique({ where: { id }, select: { inventoryItemId: true } })
      if (recipe?.inventoryItemId) {
        await tx.inventoryItem.update({ where: { id: recipe.inventoryItemId }, data: { isActive: false } })
      }
      await tx.recipe.delete({ where: { id } })
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[DELETE /api/recipes/:id]', err)
    return NextResponse.json({ error: 'Failed to delete recipe' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Update `src/app/api/recipes/[id]/ingredients/[ingredientId]/route.ts`**

Replace the file contents with:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncPrepToInventory, fetchRecipeWithCost } from '@/lib/recipeCosts'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; ingredientId: string } }
) {
  const body = await req.json()
  const { qtyBase, unit, notes, sortOrder, recipePercent, inventoryItemId } = body

  await prisma.recipeIngredient.update({
    where: { id: params.ingredientId },
    data: {
      ...(qtyBase !== undefined ? { qtyBase: parseFloat(qtyBase) } : {}),
      ...(unit !== undefined ? { unit } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
      ...(recipePercent !== undefined ? { recipePercent: recipePercent !== null ? parseFloat(recipePercent) : null } : {}),
      ...(inventoryItemId !== undefined ? { inventoryItemId, linkedRecipeId: null } : {}),
    },
  })

  // Only sync when cost-affecting fields change.
  // sortOrder, notes, recipePercent do not affect cost.
  const costAffecting = qtyBase !== undefined || unit !== undefined || inventoryItemId !== undefined
  if (costAffecting) await syncPrepToInventory(params.id)

  // Return the full updated recipe so the client can update state without an extra fetch.
  const recipe = await fetchRecipeWithCost(params.id)
  return NextResponse.json(recipe)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; ingredientId: string } }
) {
  await prisma.recipeIngredient.delete({ where: { id: params.ingredientId } })
  await syncPrepToInventory(params.id)
  // Return the full updated recipe so the client can update state without an extra fetch.
  const recipe = await fetchRecipeWithCost(params.id)
  return NextResponse.json(recipe)
}
```

- [ ] **Step 3: Verify the build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```
Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/api/recipes/[id]/route.ts src/app/api/recipes/[id]/ingredients/[ingredientId]/route.ts
git commit -m "perf(recipes): skip non-cost syncPrepToInventory; return full recipe from ingredient PATCH/DELETE

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Eliminate redundant client-side load() calls + defer onUpdated to panel close

**Files:**
- Modify: `src/components/recipes/shared.tsx`

### Background

**Current flow for every ingredient edit:**
1. `PATCH ingredient` → server does sync + returns full recipe (after Task 1)
2. `await load()` in client — **redundant** now that PATCH returns the full recipe
3. `onUpdated()` — triggers `loadRecipes()` + `loadCategories()` in `page.tsx` — **reloads entire recipe list on every keystroke**

**Fix:** Use the PATCH response body to update local state. Add a `dirtyRef` that gets set on any mutation. Wrap `onClose` with a local `handleClose` that calls `onUpdated()` once when closing if anything changed. Remove `onUpdated()` from every individual mutation.

This eliminates:
- 1 DB call per ingredient edit (the redundant `load()`)
- The full recipe-list reload on every edit (only happens once when the panel closes)

- [ ] **Step 1: Read `src/components/recipes/shared.tsx` lines 818–900 before editing**

Verify the current shapes of `patchRecipe`, `addIngredient`, `updateIngredient`, `deleteIngredient`.

- [ ] **Step 2: Apply changes to `RecipePanel` in `src/components/recipes/shared.tsx`**

Find the `RecipePanel` function (starts around line 819). Make the following targeted changes:

**2a. Add `dirtyRef` just below the existing state declarations** (after `const searchTimer = useRef…`):

```tsx
const dirtyRef = useRef(false)
```

**2b. Replace `patchRecipe`** (currently ~line 861):

```tsx
const patchRecipe = async (data: Record<string, unknown>) => {
  setSaving(true)
  const res = await fetch(`/api/recipes/${recipeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  const updated = await res.json()
  setRecipe(updated)   // use the response — no extra load() needed
  dirtyRef.current = true
  setSaving(false)
}
```

**2c. Replace `addIngredient`** (currently ~line 867):

```tsx
const addIngredient = async (item: IngredientSearchResult) => {
  await fetch(`/api/recipes/${recipeId}/ingredients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inventoryItemId: item.type === 'inventory' ? item.id : null,
      linkedRecipeId: item.type === 'recipe' ? item.id : null,
      qtyBase: 0,
      unit: item.unit,
    }),
  })
  // POST doesn't return the full recipe yet — use load() here only
  await load()
  dirtyRef.current = true
  setShowSearch(false)
  setSearchQ('')
  setSearchResults([])
}
```

**2d. Replace `updateIngredient`** (currently ~line 875):

```tsx
const updateIngredient = async (ingId: string, data: Record<string, unknown>) => {
  const res = await fetch(`/api/recipes/${recipeId}/ingredients/${ingId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  const updated = await res.json()
  setRecipe(updated)   // full recipe returned — no load() needed
  dirtyRef.current = true
}
```

**2e. Replace `deleteIngredient`** (currently ~line 880):

```tsx
const deleteIngredient = async (ingId: string) => {
  const res = await fetch(`/api/recipes/${recipeId}/ingredients/${ingId}`, { method: 'DELETE' })
  const updated = await res.json()
  setRecipe(updated)   // full recipe returned — no load() needed
  dirtyRef.current = true
}
```

**2f. Add `handleClose` just before the `if (!recipe) return (…)` guard**:

```tsx
const handleClose = () => {
  if (dirtyRef.current) onUpdated()
  onClose()
}
```

**2g. Replace every `onClose` call inside the RecipePanel JSX with `handleClose`.**

There are two places where `onClose` is called in the panel's own JSX:
1. The backdrop div click handler: `onClick={onClose}` → `onClick={handleClose}`
2. The back-arrow button: `onClick={onClose}` → `onClick={handleClose}`

Do NOT change `onClose` in `PrepRecipeModal` or other components — only inside `RecipePanel`.

- [ ] **Step 3: Verify the build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```
Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/components/recipes/shared.tsx
git commit -m "perf(recipes): use PATCH responses instead of re-fetching; defer onUpdated to panel close

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Optimistic ingredient updates

**Files:**
- Modify: `src/components/recipes/shared.tsx`

### Background

After Task 2 the flow is: user changes qty/unit → blur → PATCH fires → server responds with full recipe → `setRecipe(updated)`. This still has 200–400 ms of visual lag waiting for the server.

Optimistic update: immediately apply the `qtyBase`/`unit` change to local state (including recomputing `lineCost` and `totalCost`), fire the PATCH, then reconcile with the server response. The user sees the change instantly; the server confirms asynchronously.

`lineCost` formula (from `recipeCosts.ts`): `convertQty(qtyBase, unit, ingredientBaseUnit) * pricePerBaseUnit`
- `convertQty` is in `@/lib/uom` — already imported in `shared.tsx` (as `getUnitGroup`); just add it to the import.
- `pricePerBaseUnit` is already on every `IngredientWithCost`.

- [ ] **Step 1: Add `convertQty` to the uom import in `shared.tsx`**

Find the line (around line 6):
```tsx
import { UOM_GROUPS, getUnitGroup } from '@/lib/uom'
```
Change to:
```tsx
import { UOM_GROUPS, getUnitGroup, convertQty } from '@/lib/uom'
```

- [ ] **Step 2: Replace `updateIngredient` in `RecipePanel` with the optimistic version**

Replace the `updateIngredient` function you wrote in Task 2 with this version:

```tsx
const updateIngredient = async (ingId: string, data: Record<string, unknown>) => {
  // Optimistic update — reflect the change instantly in the UI before the server responds.
  const newQtyBase = data.qtyBase !== undefined ? Number(data.qtyBase) : undefined
  const newUnit    = data.unit    !== undefined ? (data.unit as string) : undefined

  if (recipe && (newQtyBase !== undefined || newUnit !== undefined)) {
    setRecipe(prev => {
      if (!prev) return prev
      const updatedIngredients = prev.ingredients.map(ing => {
        if (ing.id !== ingId) return ing
        const qtyBase = newQtyBase ?? ing.qtyBase
        const unit    = newUnit    ?? ing.unit
        const conv    = convertQty(qtyBase, unit, ing.ingredientBaseUnit)
        const lineCost = (conv !== null ? conv : qtyBase) * ing.pricePerBaseUnit
        return { ...ing, qtyBase, unit, lineCost }
      })
      const totalCost = updatedIngredients.reduce((s, i) => s + i.lineCost, 0)
      return { ...prev, ingredients: updatedIngredients, totalCost }
    })
  }

  // Actual server call — reconciles with authoritative data (handles edge cases).
  const res = await fetch(`/api/recipes/${recipeId}/ingredients/${ingId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  const updated = await res.json()
  setRecipe(updated)
  dirtyRef.current = true
}
```

- [ ] **Step 3: Verify the build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```
Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/components/recipes/shared.tsx
git commit -m "perf(recipes): optimistic ingredient updates for instant UI feedback

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Search optimizations — drop heavy include, increase debounce, add client cache

**Files:**
- Modify: `src/app/api/recipes/search-ingredients/route.ts`
- Modify: `src/components/recipes/shared.tsx`

### Background

**Server:** The PREP recipe query fetches full `ingredients` with nested `inventoryItem` rows just to compute `pricePerBaseUnit`. But `syncPrepToInventory` keeps the recipe's linked `InventoryItem.pricePerBaseUnit` up to date. We can use that instead — one `inventoryItem` select instead of a full ingredients include.

**Client debounce:** 250 ms is shorter than a Supabase pgBouncer round-trip (~150–300 ms). Increasing to 400 ms halves the number of API calls during fast typing with no perceptible UX difference.

**Client cache:** A `Map<string, IngredientSearchResult[]>` in a `useRef` caches results by query. Repeat searches (user types, deletes, retypes) hit memory instantly.

- [ ] **Step 1: Rewrite `src/app/api/recipes/search-ingredients/route.ts`**

Replace with:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

// Fuzzy score: how well does `query` match `target`?
// Returns 0–100. Handles case, partial words, abbreviations.
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase().trim()
  const t = target.toLowerCase().trim()

  if (!q) return 100
  if (t === q) return 100
  if (t.includes(q)) return 90

  const qWords = q.split(/\s+/).filter(Boolean)
  const tWords = t.split(/[\s\-/]+/).filter(Boolean)

  const allQWordsInTarget = qWords.every(qw =>
    tWords.some(tw => tw.startsWith(qw) || tw.includes(qw))
  )
  if (allQWordsInTarget) return 80

  const matchedWords = qWords.filter(qw =>
    tWords.some(tw => tw.startsWith(qw) || tw.includes(qw))
  )
  const ratio = matchedWords.length / qWords.length
  if (ratio >= 0.5) return Math.round(40 + ratio * 40)

  const initials = tWords.map(w => w[0]).join('')
  if (initials.includes(q)) return 50

  return 0
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') ?? '').trim()

  const [invItems, prepRecipes] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: {
        isActive: true,
        recipe: null,
        NOT: { category: { equals: 'PREPD', mode: 'insensitive' } },
        ...(q ? {
          OR: [
            { itemName: { contains: q, mode: 'insensitive' } },
            ...q.split(/\s+/).filter(w => w.length > 1).map(word => ({
              itemName: { contains: word, mode: 'insensitive' as const },
            })),
          ],
        } : {}),
      },
      select: { id: true, itemName: true, baseUnit: true, pricePerBaseUnit: true, category: true },
      orderBy: { itemName: 'asc' },
      take: 100,
    }),
    // Use the synced inventoryItem.pricePerBaseUnit (kept up-to-date by syncPrepToInventory)
    // instead of fetching all ingredients — much shallower query.
    prisma.recipe.findMany({
      where: {
        type: 'PREP',
        isActive: true,
        ...(q ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            ...q.split(/\s+/).filter(w => w.length > 1).map(word => ({
              name: { contains: word, mode: 'insensitive' as const },
            })),
          ],
        } : {}),
      },
      select: {
        id: true,
        name: true,
        yieldUnit: true,
        inventoryItem: { select: { pricePerBaseUnit: true } },
      },
      orderBy: { name: 'asc' },
      take: 50,
    }),
  ])

  const invResults = invItems.map(item => ({
    type: 'inventory' as const,
    id: item.id,
    name: item.itemName,
    unit: item.baseUnit,
    pricePerBaseUnit: Number(item.pricePerBaseUnit),
    category: item.category,
    _score: q ? fuzzyScore(q, item.itemName) : 100,
  }))

  const recipeResults = prepRecipes.map(recipe => ({
    type: 'recipe' as const,
    id: recipe.id,
    name: recipe.name,
    unit: recipe.yieldUnit,
    // pricePerBaseUnit is kept in sync by syncPrepToInventory
    pricePerBaseUnit: Number(recipe.inventoryItem?.pricePerBaseUnit ?? 0),
    category: 'PREPD',
    _score: q ? fuzzyScore(q, recipe.name) : 100,
  }))

  const combined = [...invResults, ...recipeResults]
    .filter(r => r._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 20)
    .map(({ _score, ...rest }) => rest)

  return NextResponse.json(combined)
}
```

- [ ] **Step 2: Add search cache + increase debounce in `RecipePanel` in `shared.tsx`**

Find the `searchTimer` ref declaration (around line 838):
```tsx
const searchTimer = useRef<ReturnType<typeof setTimeout>>()
```

Immediately after it, add:
```tsx
const searchCache = useRef<Map<string, IngredientSearchResult[]>>(new Map())
```

Find the `doSearch` callback (around line 855):
```tsx
const doSearch = useCallback(async (q: string) => {
  if (!q.trim()) { setSearchResults([]); return }
  const data = await fetch(`/api/recipes/search-ingredients?q=${encodeURIComponent(q)}`).then(r => r.json())
  setSearchResults(data)
}, [])
```

Replace with:
```tsx
const doSearch = useCallback(async (q: string) => {
  if (!q.trim()) { setSearchResults([]); return }
  // Serve from cache instantly if available, then refresh in background.
  const cached = searchCache.current.get(q)
  if (cached) setSearchResults(cached)
  const data: IngredientSearchResult[] = await fetch(
    `/api/recipes/search-ingredients?q=${encodeURIComponent(q)}`
  ).then(r => r.json())
  searchCache.current.set(q, data)
  setSearchResults(data)
}, [])
```

Find the debounce timer in the search input onChange (around line 1099):
```tsx
searchTimer.current = setTimeout(() => { doSearch(e.target.value); setShowSearch(true) }, 250)
```

Change `250` to `400`:
```tsx
searchTimer.current = setTimeout(() => { doSearch(e.target.value); setShowSearch(true) }, 400)
```

- [ ] **Step 3: Verify the build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```
Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/api/recipes/search-ingredients/route.ts src/components/recipes/shared.tsx
git commit -m "perf(recipes): lighter search query, 400ms debounce, client-side result cache

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Page-level search debounce + React.memo on IngredientRow

**Files:**
- Modify: `src/app/recipes/page.tsx`
- Modify: `src/components/recipes/shared.tsx`

### Background

**Page search:** `search` state in `page.tsx` is in `loadRecipes`'s dependency array. Every character fires a DB query immediately (no debounce). Fix: separate `searchInput` (immediate display state) from `search` (debounced, drives the API call).

**React.memo:** `IngredientRow` is defined at module scope (correct per CLAUDE.md), but it's not memoized. When `recipe` state updates after any ingredient PATCH, React re-renders all rows even if only one changed. With 15+ ingredients, this is measurable. `React.memo` with a shallow prop comparison prevents this.

- [ ] **Step 1: Add `memo` import to `shared.tsx` and wrap `IngredientRow`**

Find the React import at the top of `shared.tsx` (around line 3):
```tsx
import { useEffect, useState, useCallback, useRef } from 'react'
```

Add `memo`:
```tsx
import { useEffect, useState, useCallback, useRef, memo } from 'react'
```

Find the `IngredientRow` function declaration (around line 708):
```tsx
function IngredientRow({ ing, scaleFactor, canMoveUp, canMoveDown, onUpdate, onDelete, onMoveUp, onMoveDown, onEditItem }: {
```

Change it to use `memo`. Replace the `function IngredientRow(…) { … }` block's opening line with:
```tsx
const IngredientRow = memo(function IngredientRow({ ing, scaleFactor, canMoveUp, canMoveDown, onUpdate, onDelete, onMoveUp, onMoveDown, onEditItem }: {
```

And close the memo wrapper at the very end of the `IngredientRow` function (after the closing `}`), adding `)`:
```tsx
  )
}
)
```

The complete structure is:
```tsx
const IngredientRow = memo(function IngredientRow({ … }: { … }) {
  // … existing body unchanged …
})
```

- [ ] **Step 2: Debounce page-level recipe search in `src/app/recipes/page.tsx`**

Find the import line at the top:
```tsx
import { useEffect, useState, useCallback, Suspense } from 'react'
```

Add `useRef`:
```tsx
import { useEffect, useState, useCallback, useRef, Suspense } from 'react'
```

Find the `search` state declaration (around line 23):
```tsx
const [search, setSearch] = useState('')
```

Replace with two states — immediate input state and debounced search state:
```tsx
const [searchInput, setSearchInput] = useState('')
const [search, setSearch] = useState('')
const searchDebounce = useRef<ReturnType<typeof setTimeout>>()
```

Find the search `<input>` in the JSX (look for the input that sets `search`):
```tsx
onChange={e => setSearch(e.target.value)}
```

Replace with:
```tsx
onChange={e => {
  setSearchInput(e.target.value)
  clearTimeout(searchDebounce.current)
  searchDebounce.current = setTimeout(() => setSearch(e.target.value), 350)
}}
```

And update the input's `value` prop from `value={search}` to `value={searchInput}`.

Also clear the search on reset if there is an X / clear button that calls `setSearch('')` — add `setSearchInput('')` alongside it.

- [ ] **Step 3: Verify the build**

```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```
Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/components/recipes/shared.tsx src/app/recipes/page.tsx
git commit -m "perf(recipes): React.memo on IngredientRow; debounce page-level recipe search

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Manual verification checklist (after all tasks)

Run `npm run dev` and open `http://localhost:3000/recipes`.

- [ ] Open a recipe with 5+ ingredients — panel loads, no spinning beyond initial load.
- [ ] Edit a quantity — the value updates instantly (optimistic), no 2-second wait.
- [ ] Change a unit dropdown — updates instantly.
- [ ] Change the recipe name (InlineEdit) — saves without visible lag.
- [ ] Reorder an ingredient (move up/down) — no full list reload; feels immediate.
- [ ] Search for an ingredient: type 3 chars, wait ~400 ms, results appear. Retype same query — results appear instantly from cache.
- [ ] Delete an ingredient — list updates without re-fetching the whole recipe.
- [ ] Type in the page-level search box rapidly — no stuttering; DB query fires ~350 ms after you stop.
- [ ] Close the recipe panel after making edits — the recipe card in the list updates (food cost, etc.) after close, not during editing.
- [ ] Export check: `npm run build` shows `✓ Compiled successfully`.
