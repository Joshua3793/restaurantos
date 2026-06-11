# RC-dependent Recipe Book (PREP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Recipe Book (PREP) page filter recipes and categories by the active Revenue Center (RC), exactly as the Menu page already does for MENU recipes — shared prep + active-RC prep shown together, "All RC" shows everything.

**Architecture:** Reuse the existing nullable `Recipe.revenueCenterId` / `RecipeCategory.revenueCenterId` columns (no schema change). A PREP recipe is either *Shared* (`revenueCenterId = null`, visible in all RCs) or *RC-specific*. The viewing filter for PREP is `revenueCenterId IN (rcId, null)`. Existing PREP rows are migrated to the default RC. The Menu page and the global `InventoryItem` / `pricePerBaseUnit` spine are untouched.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma + PostgreSQL, React client components, `useRc()` context (`src/contexts/RevenueCenterContext.tsx`).

> **Verification model:** This project has **no test suite** — per CLAUDE.md, `npm run build` is the only automated correctness gate, supplemented by manual browser checks. This plan therefore uses `npm run build` + targeted manual verification in place of unit tests. (User instruction in CLAUDE.md overrides the skill's default TDD steps.)
>
> **Build/serve gotcha (from project memory):** `npm run build` deadlocks if the preview/dev server is running. Stop the dev server before running a build. Node/npm may not be on PATH in the sandbox — use the project node-install path if `npm` is not found.

---

## File map

| File | Change |
|---|---|
| `scripts/assign-prep-rc.ts` | **Create** — one-time data migration: assign existing PREP recipes + categories to the default RC. |
| `src/app/api/recipes/route.ts` | **Modify** — GET: PREP RC filter `IN (rcId, null)`. POST: write `revenueCenterId` for PREP too. |
| `src/app/api/recipes/categories/route.ts` | **Modify** — GET: PREP RC filter `IN (rcId, null)`. POST: write `revenueCenterId` for PREP too. |
| `src/app/api/recipes/[id]/route.ts` | **Modify** — PATCH: accept `revenueCenterId`. |
| `src/app/recipes/page.tsx` | **Modify** — `useRc()`, pass `rcId` to fetches, RC in new-form, RC header, pass RC props to `CategoryManager` + `RecipePanel`. |
| `src/components/recipes/shared.tsx` | **Modify** — `CategoryManager` RC picker for PREP; `RecipePanel` optional RC selector (edit). |

---

## Task 1: Data migration — assign existing PREP rows to the default RC

**Files:**
- Create: `scripts/assign-prep-rc.ts`

This must run **with the deploy** so existing prep is owned by the default RC (other RCs start empty, by design — see spec).

- [ ] **Step 1: Write the migration script**

Create `scripts/assign-prep-rc.ts`:

```ts
// ONE-TIME migration: existing PREP recipes and PREP recipe categories were all
// shared (revenueCenterId = null) because the Recipe Book ignored Revenue Centers.
// The RC-dependent Recipe Book makes PREP rows RC-scoped. This assigns every
// existing PREP Recipe and RecipeCategory to the DEFAULT revenue center so the
// default RC's book looks unchanged; other RCs start empty (deliberate).
//
// Idempotent: only touches PREP rows that are still null. Re-running is a no-op.
//
// Dry by default. Run:
//   ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/assign-prep-rc.ts
//   APPLY=1 ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/assign-prep-rc.ts
import { prisma } from '../src/lib/prisma'

const APPLY = process.env.APPLY === '1'

async function main() {
  const defaultRc =
    (await prisma.revenueCenter.findFirst({ where: { isDefault: true } })) ??
    (await prisma.revenueCenter.findFirst({ orderBy: { createdAt: 'asc' } }))

  if (!defaultRc) {
    console.error('No RevenueCenter found — create one before running this migration.')
    process.exit(1)
  }
  console.log(`Default RC: ${defaultRc.name} (${defaultRc.id})`)

  const recipeWhere = { type: 'PREP' as const, revenueCenterId: null }
  const catWhere = { type: 'PREP' as const, revenueCenterId: null }

  const recipeCount = await prisma.recipe.count({ where: recipeWhere })
  const catCount = await prisma.recipeCategory.count({ where: catWhere })
  console.log(`PREP recipes to assign:    ${recipeCount}`)
  console.log(`PREP categories to assign: ${catCount}`)

  if (!APPLY) {
    console.log('\nDRY RUN — set APPLY=1 to write.')
    return
  }

  const r = await prisma.recipe.updateMany({ where: recipeWhere, data: { revenueCenterId: defaultRc.id } })
  const c = await prisma.recipeCategory.updateMany({ where: catWhere, data: { revenueCenterId: defaultRc.id } })
  console.log(`\nUpdated ${r.count} recipes, ${c.count} categories → ${defaultRc.name}`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Dry-run to confirm counts**

Run: `ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/assign-prep-rc.ts`
Expected: prints the default RC name and non-zero PREP recipe/category counts, ends with `DRY RUN`. No writes.

> **Do NOT run `APPLY=1` yet.** The migration is applied at deploy time, after the API + UI changes are merged, so the app is consistent. Running it now would hide all PREP recipes from non-default RCs while the page still ignores RC — harmless but confusing. The deploy runbook step is in Task 6.

- [ ] **Step 3: Commit**

```bash
git add scripts/assign-prep-rc.ts
git commit -m "feat(recipes): migration script to assign existing PREP rows to default RC"
```

---

## Task 2: API GET — PREP RC filter (recipes + categories)

**Files:**
- Modify: `src/app/api/recipes/route.ts` (GET, the `rcFilter` line)
- Modify: `src/app/api/recipes/categories/route.ts` (GET, the `rcFilter` block)

- [ ] **Step 1: Update the recipes GET filter**

In `src/app/api/recipes/route.ts`, replace this line:

```ts
  const rcFilter = (rcId && type === 'MENU') ? { revenueCenterId: rcId } : {}
```

with:

```ts
  // MENU: strict per-RC (unchanged). PREP: shared (null) + the active RC shown together.
  const rcFilter = !rcId
    ? {}
    : type === 'MENU'
      ? { revenueCenterId: rcId }
      : type === 'PREP'
        ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
        : {}
```

- [ ] **Step 2: Update the categories GET filter**

In `src/app/api/recipes/categories/route.ts`, replace this block:

```ts
  // MENU categories are per-RC; PREP categories are shared (revenueCenterId = null)
  const rcFilter = (type === 'MENU' && rcId)
    ? { revenueCenterId: rcId }
    : type === 'MENU'
      ? {} // All RCs: return all MENU categories
      : { revenueCenterId: null } // PREP: shared only
```

with:

```ts
  // MENU: strict per-RC. PREP: shared (null) + active RC shown together. No rcId = All RCs.
  const rcFilter = !rcId
    ? {} // All RCs: return all categories of this type
    : type === 'MENU'
      ? { revenueCenterId: rcId }
      : { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] } // PREP
```

- [ ] **Step 3: Build to verify it compiles**

Run: `npm run build`
Expected: build succeeds; `/api/recipes` and `/api/recipes/categories` listed as `ƒ (Dynamic)`. (Ensure no dev server is running first.)

- [ ] **Step 4: Commit**

```bash
git add src/app/api/recipes/route.ts src/app/api/recipes/categories/route.ts
git commit -m "feat(recipes): RC-aware GET filters for PREP (shared + active RC)"
```

---

## Task 3: API writes — accept revenueCenterId for PREP (POST + PATCH)

**Files:**
- Modify: `src/app/api/recipes/route.ts` (POST)
- Modify: `src/app/api/recipes/categories/route.ts` (POST)
- Modify: `src/app/api/recipes/[id]/route.ts` (PATCH)

- [ ] **Step 1: Recipe POST — write RC for PREP too**

In `src/app/api/recipes/route.ts` POST, change:

```ts
      revenueCenterId: type === 'MENU' ? (revenueCenterId || null) : null,
```

to:

```ts
      // PREP and MENU both carry an RC now; null = Shared (visible in all RCs).
      revenueCenterId: revenueCenterId || null,
```

- [ ] **Step 2: Category POST — write RC for PREP too**

In `src/app/api/recipes/categories/route.ts` POST, change:

```ts
      revenueCenterId: type === 'MENU' ? (revenueCenterId || null) : null,
```

to:

```ts
      revenueCenterId: revenueCenterId || null,
```

- [ ] **Step 3: Recipe PATCH — accept revenueCenterId**

In `src/app/api/recipes/[id]/route.ts` PATCH, change the destructure on line 22:

```ts
  const { name, categoryId, baseYieldQty, yieldUnit, portionSize, portionUnit, menuPrice, notes, isActive, baseIngredientId, steps } = body
```

to add `revenueCenterId`:

```ts
  const { name, categoryId, baseYieldQty, yieldUnit, portionSize, portionUnit, menuPrice, notes, isActive, baseIngredientId, steps, revenueCenterId } = body
```

and add this line inside the `data: { ... }` object (e.g. after the `baseIngredientId` line):

```ts
      ...(revenueCenterId !== undefined ? { revenueCenterId: revenueCenterId || null } : {}),
```

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/recipes/route.ts src/app/api/recipes/categories/route.ts "src/app/api/recipes/[id]/route.ts"
git commit -m "feat(recipes): persist revenueCenterId on PREP create/update + category create"
```

---

## Task 4: Recipe Book page — wire up the active RC

**Files:**
- Modify: `src/app/recipes/page.tsx`

- [ ] **Step 1: Import and read the RC context**

Add the import near the other imports (after the `useDrawer` import on line 7):

```ts
import { useRc } from '@/contexts/RevenueCenterContext'
```

Inside `RecipesInner()`, add right after the `const { setDrawerOpen } = useDrawer()` line:

```ts
  const { revenueCenters, activeRcId, activeRc } = useRc()
```

- [ ] **Step 2: Add `revenueCenterId` to the new-recipe form state**

Change the `newForm` initial state from:

```ts
  const [newForm, setNewForm]               = useState({
    name: '', categoryId: '', baseYieldQty: '', yieldUnit: '',
    portionSize: '', portionUnit: '', menuPrice: '', notes: '',
  })
```

to:

```ts
  const [newForm, setNewForm]               = useState({
    name: '', categoryId: '', baseYieldQty: '', yieldUnit: '',
    portionSize: '', portionUnit: '', menuPrice: '', notes: '', revenueCenterId: '',
  })
```

- [ ] **Step 3: Pre-fill the new-form RC from the active RC**

Add this effect after the existing effects (e.g. after the `useEffect(() => { loadRecipes() }, [loadRecipes])` line). When "All RC" is active (`activeRcId === null`), the field stays `''` which the API maps to Shared:

```ts
  useEffect(() => {
    setNewForm(f => ({ ...f, revenueCenterId: activeRcId ?? '' }))
  }, [activeRcId])
```

- [ ] **Step 4: Pass `rcId` to the category + recipe fetches**

Change `loadCategories`:

```ts
  const loadCategories = useCallback(async () => {
    const p = new URLSearchParams({ type })
    if (activeRcId) p.set('rcId', activeRcId)
    const data = await fetch(`/api/recipes/categories?${p}`).then(r => r.json())
    setCategories(Array.isArray(data) ? data : [])
  }, [activeRcId])
```

Change `loadRecipes`:

```ts
  const loadRecipes = useCallback(async () => {
    const params = new URLSearchParams({ type })
    if (!showInactive) params.set('isActive', 'true')
    if (search) params.set('search', search)
    if (activeRcId) params.set('rcId', activeRcId)
    const data = await fetch(`/api/recipes?${params}`).then(r => r.json())
    setRecipes(Array.isArray(data) ? data : [])
  }, [showInactive, search, activeRcId])
```

- [ ] **Step 5: Reset `revenueCenterId` in the create handler**

In `handleCreate`, change the reset call:

```ts
    setNewForm({ name: '', categoryId: '', baseYieldQty: '', yieldUnit: '', portionSize: '', portionUnit: '', menuPrice: '', notes: '' })
```

to:

```ts
    setNewForm({ name: '', categoryId: '', baseYieldQty: '', yieldUnit: '', portionSize: '', portionUnit: '', menuPrice: '', notes: '', revenueCenterId: activeRcId ?? '' })
```

- [ ] **Step 6: Add the RC selector to the new-recipe form UI**

Locate the category `<select>` inside the new-recipe form (the `showNewForm` block — the field whose options are `typeCats.map(...)`). Immediately after that field's wrapping `<div>`, insert this RC field (mirrors `src/app/menu/page.tsx:352-365`, but with a "Shared" option and not required):

```tsx
                <div>
                  <label className="text-[12.5px] font-medium text-ink-2 block mb-1.5">Revenue center</label>
                  <select
                    value={newForm.revenueCenterId}
                    onChange={e => setNewForm(f => ({ ...f, revenueCenterId: e.target.value }))}
                    className="w-full border border-line rounded-[9px] px-3 py-2 text-[13px] text-ink bg-paper focus:outline-none focus:border-ink-3"
                  >
                    <option value="">Shared (all RCs)</option>
                    {revenueCenters.filter(rc => rc.isActive).map(rc => (
                      <option key={rc.id} value={rc.id}>{rc.name}</option>
                    ))}
                  </select>
                </div>
```

- [ ] **Step 7: Show the active RC in the page header**

Find the header subtitle line that shows the recipe count (the `<p>` with `{recipes.length} ... recipes/dishes`). Add the active-RC suffix exactly as the Menu page does (`src/app/menu/page.tsx:199-201`). For example, if the line reads `<span className="font-medium text-ink">{displayRecipes.length} recipes</span>`, append after the closing span:

```tsx
            {activeRc && <> · <span className="font-mono text-[11px]">{activeRc.name}</span></>}
```

(If "All RC" is active, `activeRc` is null and nothing is appended.)

- [ ] **Step 8: Pass RC props to `CategoryManager`**

Find the `<CategoryManager ... />` usage (around line 396). Add the two RC props the Menu page passes (`src/app/menu/page.tsx:559-560`):

```tsx
          revenueCenterId={activeRcId}
          revenueCenters={revenueCenters}
```

- [ ] **Step 9: Build to verify**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 10: Commit**

```bash
git add src/app/recipes/page.tsx
git commit -m "feat(recipes): Recipe Book filters by active RC + RC field on new prep recipe"
```

---

## Task 5: Shared components — CategoryManager PREP picker + RecipePanel RC editing

**Files:**
- Modify: `src/components/recipes/shared.tsx`

- [ ] **Step 1: Let CategoryManager show the RC picker for PREP**

In `CategoryManager` (around line 1974), change:

```ts
  const showRcPicker = type === 'MENU' && !!revenueCenters?.length
```

to:

```ts
  const showRcPicker = !!revenueCenters?.length
```

And in the category-create body (around line 1985), change:

```ts
        revenueCenterId: type === 'MENU' ? (newRcId || null) : null,
```

to:

```ts
        revenueCenterId: newRcId || null,
```

> Menu still passes `type='MENU'` and behaves as before; the Recipe Book now passes `revenueCenters`, so PREP categories can be created Shared or per-RC. Confirm the RC picker dropdown (around line 2050) already includes a "Shared"/blank option; if it does not, add `<option value="">Shared (all RCs)</option>` as the first option so PREP categories can be created shared.

- [ ] **Step 2: Give RecipePanel an optional RC selector (edit scope)**

In `RecipePanel`'s props (line 1014), add an optional `revenueCenters` prop:

```ts
export function RecipePanel({ recipeId, categories, onClose, onUpdated, revenueCenters }: {
  recipeId: string
  categories: RecipeCategory[]
  onClose: () => void
  onUpdated: () => void
  revenueCenters?: { id: string; name: string; isActive: boolean }[]
}) {
```

Then render an RC/Shared dropdown wherever the panel shows the recipe's category control (near the existing category selector in the panel header/meta area). Render it **only when `revenueCenters` is provided** so the Menu page (which won't pass it) is unchanged. Use the panel's existing `patchRecipe` helper to persist:

```tsx
        {revenueCenters && recipe && (
          <div>
            <label className="text-[12.5px] font-medium text-ink-2 block mb-1.5">Revenue center</label>
            <select
              value={recipe.revenueCenterId ?? ''}
              onChange={e => patchRecipe({ revenueCenterId: e.target.value || null })}
              className="w-full border border-line rounded-[9px] px-3 py-2 text-[13px] text-ink bg-paper focus:outline-none focus:border-ink-3"
            >
              <option value="">Shared (all RCs)</option>
              {revenueCenters.filter(rc => rc.isActive).map(rc => (
                <option key={rc.id} value={rc.id}>{rc.name}</option>
              ))}
            </select>
          </div>
        )}
```

> `patchRecipe({ revenueCenterId })` PATCHes the recipe; Task 3 made the PATCH route accept it. Changing scope does not affect cost (the linked inventory item and its `pricePerBaseUnit` are global).

- [ ] **Step 3: Pass `revenueCenters` to RecipePanel from the Recipe Book page**

In `src/app/recipes/page.tsx`, find the `<RecipePanel ... />` usage (around line 390) and add the prop:

```tsx
          revenueCenters={revenueCenters}
```

(Leave the Menu page's `<RecipePanel>` usage as-is — it must not pass `revenueCenters`, preserving current Menu behavior.)

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/recipes/shared.tsx src/app/recipes/page.tsx
git commit -m "feat(recipes): edit prep RC scope in panel + per-RC prep categories"
```

---

## Task 6: End-to-end verification + deploy migration

**Files:** none (verification + ops)

- [ ] **Step 1: Final build**

Run: `npm run build`
Expected: success; `/api/recipes`, `/api/recipes/categories`, `/api/recipes/[id]` all `ƒ (Dynamic)`.

- [ ] **Step 2: Apply the data migration**

Before/with deploy, run the Task 1 script with APPLY:

Run: `APPLY=1 ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/assign-prep-rc.ts`
Expected: prints `Updated N recipes, M categories → <default RC name>`.

- [ ] **Step 3: Manual browser verification**

Start the dev server (`npm run dev`) and check, on `/recipes`:
- **Default RC active** → Recipe Book shows all existing prep (unchanged from before). Header shows the RC name.
- **Switch to another RC** → book shows only Shared prep (initially none, by design — see spec). Header shows that RC's name.
- **All RC** → book shows every prep recipe across RCs.
- **Create a prep recipe while RC-A is active**, leave Revenue center = its default → it appears under RC-A and All RC, not under RC-B.
- **Create one with Revenue center = "Shared (all RCs)"** → it appears under every RC.
- **Open an existing prep in the panel, change Revenue center to "Shared"** → it now appears in all RCs after reload.
- **In a MENU recipe under any RC, add that prep's inventory item as an ingredient** → it's selectable and its cost is unchanged, confirming RC scope is visibility-only.

- [ ] **Step 4: Confirm Menu page unchanged**

On `/menu`, switch RCs → behaves exactly as before (no Shared option leaking in; strict per-RC filter intact).

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore(recipes): RC-dependent Recipe Book verification fixes"
```

---

## Self-review notes

- **Spec coverage:** migration (Task 1) ✓; GET filters recipes+categories (Task 2) ✓; POST+PATCH writes (Task 3) ✓; page wiring incl. header, new-form RC, CategoryManager props (Task 4) ✓; prep form RC selector for create (Task 4 Step 6) and edit (Task 5 RecipePanel) ✓; Menu untouched (RecipePanel gated by optional prop; recipes GET keeps MENU strict) ✓; spine untouched (no `syncPrepToInventory` / `pricePerBaseUnit` changes) ✓.
- **No schema change** — confirmed both columns are pre-existing nullable fields.
- **Type consistency:** `revenueCenters` prop typed identically (`{ id, name, isActive }[]`) on `CategoryManager` and `RecipePanel`; `revenueCenterId` is `string | null` end to end; new-form field is `''`-for-Shared mapped to `null` server-side.
