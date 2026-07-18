# Custom (uncosted) recipe ingredients — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users add a free-text ingredient that isn't in inventory ("Add anyway") to Recipe, Menu, and nested-prep editors — recorded exactly as typed, uncosted, affecting nothing else.

**Architecture:** Add a third `RecipeIngredient` kind — a **custom** row identified by a new nullable `customName` column with both `inventoryItemId` and `linkedRecipeId` null. The cost engine names it, costs it `$0`, and skips it in every aggregate. The shared recipe UI gains an "Add anyway" affordance and a dimmed, free-form-unit, no-cost row renderer.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase pooler) · Tailwind · vitest.

## Global Constraints

- **Prisma singleton:** always import `prisma` from `@/lib/prisma`; never instantiate `PrismaClient`.
- **`migrate dev` is broken** here (P3006 against the pooler shadow DB). Apply schema changes with `prisma db execute --url $DIRECT_URL` + `prisma migrate resolve --applied`, then `prisma generate`. Never run a full-schema `migrate diff`.
- **Route handlers stay dynamic:** the two ingredient routes already `export const dynamic = 'force-dynamic'` — keep it.
- **UOM writes:** custom lines bypass `assertKnownUnit` (they're never costed); inventory/recipe lines keep it.
- **Tailwind tokens:** use flat tokens (`text-ink-4`, `bg-red-soft`), never numbered classes (`bg-red-500`).
- **Prisma Decimal → string:** wrap Decimal-typed JSON fields in `Number()` before arithmetic.
- **Correctness check:** `npm run build` after any non-trivial change; `npm test` after touching costing.

---

### Task 1: Add `customName` column to `RecipeIngredient`

**Files:**
- Modify: `prisma/schema.prisma:200-213` (RecipeIngredient model)
- Create: `prisma/migrations/<timestamp>_recipe_ingredient_custom_name/migration.sql`

**Interfaces:**
- Produces: `RecipeIngredient.customName: string | null` — the free-text name of a custom ingredient; null for inventory/recipe lines.

- [ ] **Step 1: Add the column to the schema**

In `prisma/schema.prisma`, inside `model RecipeIngredient`, add `customName` next to the other nullable scalars (after `notes`):

```prisma
model RecipeIngredient {
  id              String         @id @default(uuid())
  recipeId        String
  inventoryItemId String?
  linkedRecipeId  String?
  qtyBase         Decimal
  unit            String
  sortOrder       Int            @default(0)
  notes           String?
  customName      String?
  recipePercent   Decimal?
  inventoryItem   InventoryItem? @relation("RecipeIngredientInventory", fields: [inventoryItemId], references: [id])
  linkedRecipe    Recipe?        @relation("RecipeAsIngredient", fields: [linkedRecipeId], references: [id])
  recipe          Recipe         @relation("RecipeToIngredients", fields: [recipeId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 2: Create the migration SQL file**

Create `prisma/migrations/20260717000000_recipe_ingredient_custom_name/migration.sql` (use a real timestamp of the form `YYYYMMDDHHMMSS`; match the folder name to it):

```sql
-- AlterTable
ALTER TABLE "RecipeIngredient" ADD COLUMN "customName" TEXT;
```

- [ ] **Step 3: Apply the migration against the direct DB**

Run: `npx prisma db execute --file prisma/migrations/20260717000000_recipe_ingredient_custom_name/migration.sql --url "$DIRECT_URL"`
Expected: exits 0, no output (or "Script executed successfully").

If `$DIRECT_URL` isn't exported in the shell, source it from `.env` first: `export $(grep -E '^DIRECT_URL=' .env | xargs)`.

- [ ] **Step 4: Mark the migration applied and regenerate the client**

Run:
```bash
npx prisma migrate resolve --applied 20260717000000_recipe_ingredient_custom_name
npx prisma generate
```
Expected: "Migration marked as applied." then "Generated Prisma Client".

- [ ] **Step 5: Verify the type is present**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -5` — this is a smoke check; a clean or unrelated-only output is fine. Confirm `customName` exists on the generated type:

Run: `grep -n "customName" node_modules/.prisma/client/index.d.ts | head -3`
Expected: at least one match (the field on the `RecipeIngredient` model type).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(recipes): add RecipeIngredient.customName column for uncosted ingredients"
```

---

### Task 2: Cost engine — treat custom lines as $0 (TDD)

**Files:**
- Modify: `src/lib/recipeCosts.ts` — input type (`~line 77-88`), `IngredientWithCost` union (`line 21`), the `.map` branches (`line 107-129`)
- Modify: `src/components/recipes/shared.tsx:80` — widen `ingredientType` union
- Test: `src/lib/__tests__/recipeCosts.test.ts`

**Interfaces:**
- Consumes: `RecipeIngredient.customName` from Task 1.
- Produces: `computeRecipeCost` emits `IngredientWithCost` with `ingredientType: 'inventory' | 'recipe' | 'custom'`; a custom line has `lineCost === 0`, `pricePerBaseUnit === 0`, `dimensionConflict === false`, `allergens === []`, `ingredientName === <customName>`, `ingredientBaseUnit === <its unit>`.

> Note: `fetchRecipeWithCost` uses Prisma `include` (not `select`) at the ingredient level, so `customName` is auto-loaded — **no query change needed**. Only the inline input type and the `.map` need editing.

- [ ] **Step 1: Widen the `ingredientType` union and the input type in `recipeCosts.ts`**

At `src/lib/recipeCosts.ts:21`, change:

```ts
  ingredientType: 'inventory' | 'recipe'
```

to:

```ts
  ingredientType: 'inventory' | 'recipe' | 'custom'
```

In the `computeRecipeCost` parameter's inline `ingredients` array type (`~line 77-88`), add `customName` after `linkedRecipeId`:

```ts
      inventoryItemId: string | null
      linkedRecipeId: string | null
      customName?: string | null
      inventoryItem: ({ itemName: string; baseUnit: string; allergens?: string[]; densityGPerMl?: unknown } & Parameters<typeof asChainItem>[0]) | null
```

- [ ] **Step 2: Write the failing test**

Add to `src/lib/__tests__/recipeCosts.test.ts` (new `describe` block near the end of the file):

```ts
describe('computeRecipeCost — custom (uncosted) ingredients', () => {
  it('adds a custom line at $0 and leaves it uncosted', () => {
    const r = computeRecipeCost(recipe([
      ing({ qtyBase: 500, unit: 'ml', inventoryItemId: 'x', inventoryItem: oilItem }),
      ing({ id: 'i2', qtyBase: 2, unit: 'sprig', customName: 'Fresh basil garnish' }),
    ]))
    // total is unchanged from the single oil line (500 ml × $0.002 = $1)
    expect(r.totalCost).toBeCloseTo(1)
    const custom = r.ingredients.find(i => i.id === 'i2')!
    expect(custom.ingredientType).toBe('custom')
    expect(custom.ingredientName).toBe('Fresh basil garnish')
    expect(custom.lineCost).toBe(0)
    expect(custom.pricePerBaseUnit).toBe(0)
    expect(custom.ingredientBaseUnit).toBe('sprig')
    expect(custom.dimensionConflict).toBe(false)
    expect(custom.allergens).toEqual([])
  })

  it('a free-form unit on a custom line never triggers a dimension conflict', () => {
    const r = computeRecipeCost(recipe([
      ing({ qtyBase: 1, unit: 'to taste', customName: 'Sea salt' }),
    ]))
    expect(r.dimensionConflicts).toBe(0)
    expect(r.totalCost).toBe(0)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- recipeCosts`
Expected: FAIL — the custom line currently falls through to the fallback (`ingredientName: 'Unknown'`, `ingredientType: 'inventory'`), so `ingredientType`/`ingredientName` assertions fail.

- [ ] **Step 4: Add the custom branch in the `.map`**

In `src/lib/recipeCosts.ts`, after the `else if (ing.linkedRecipe) { … }` block (ends ~line 129), add a third branch:

```ts
    } else if (ing.customName) {
      // Custom (uncosted) ingredient: free-text name + free-form unit, never costed.
      ingredientName     = ing.customName
      ingredientType     = 'custom'
      pricePerBaseUnit   = 0
      lineCostQty        = 0
      ingredientBaseUnit = ing.unit
      // dimensionConflict stays false; allergens stays []
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- recipeCosts`
Expected: PASS (all cases, including the two new ones).

- [ ] **Step 6: Widen the client-side union**

At `src/components/recipes/shared.tsx:80`, change:

```ts
  ingredientType: 'inventory' | 'recipe'
```

to:

```ts
  ingredientType: 'inventory' | 'recipe' | 'custom'
```

- [ ] **Step 7: Type-check**

Run: `npm run build`
Expected: build succeeds (no type errors from the widened union).

- [ ] **Step 8: Commit**

```bash
git add src/lib/recipeCosts.ts src/lib/__tests__/recipeCosts.test.ts src/components/recipes/shared.tsx
git commit -m "feat(recipes): cost engine treats custom ingredients as \$0"
```

---

### Task 3: API — accept and edit custom ingredient lines

**Files:**
- Modify: `src/app/api/recipes/[id]/ingredients/route.ts` (POST)
- Modify: `src/app/api/recipes/[id]/ingredients/[ingredientId]/route.ts` (PATCH)

**Interfaces:**
- Consumes: `RecipeIngredient.customName` (Task 1).
- Produces:
  - POST accepts `{ customName: string, qtyBase?: number, unit?: string }` (both IDs absent) → creates a custom line, stores `unit` raw (no UOM validation), returns `{ id }`.
  - PATCH on a custom row stores `unit` raw and accepts `{ customName }`; a substitute payload (`inventoryItemId`/`linkedRecipeId`) nulls `customName`, promoting the line.

- [ ] **Step 1: Rewrite the POST validation + create to support custom lines**

Replace the body of `POST` in `src/app/api/recipes/[id]/ingredients/route.ts` (keep the imports and `export const dynamic`):

```ts
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const { inventoryItemId, linkedRecipeId, qtyBase, unit, notes, recipePercent, customName } = body

  const hasInv = !!inventoryItemId
  const hasLinked = !!linkedRecipeId
  const hasCustom = typeof customName === 'string' && customName.trim().length > 0

  // Exactly one kind: inventory, linked recipe, or custom.
  const kinds = [hasInv, hasLinked, hasCustom].filter(Boolean).length
  if (kinds !== 1) {
    return NextResponse.json(
      { error: 'Provide exactly one of inventoryItemId, linkedRecipeId, or customName' },
      { status: 400 }
    )
  }

  // Custom lines carry a free-form unit and are never costed → skip UOM validation.
  // Inventory/recipe lines must resolve to a known unit.
  let storedUnit: string
  if (hasCustom) {
    storedUnit = typeof unit === 'string' ? unit : ''
  } else {
    try { storedUnit = assertKnownUnit(unit, 'ingredient unit') }
    catch (e) { if (e instanceof UnitError) return NextResponse.json({ error: e.message }, { status: 400 }); throw e }
  }

  const maxOrder = await prisma.recipeIngredient.aggregate({
    where: { recipeId: params.id },
    _max: { sortOrder: true },
  })
  const sortOrder = (maxOrder._max.sortOrder ?? -1) + 1

  const ing = await prisma.recipeIngredient.create({
    data: {
      recipeId: params.id,
      inventoryItemId: inventoryItemId || null,
      linkedRecipeId: linkedRecipeId || null,
      customName: hasCustom ? customName.trim() : null,
      qtyBase: qtyBase !== undefined && qtyBase !== null && qtyBase !== '' ? parseFloat(qtyBase) : 0,
      unit: storedUnit,
      sortOrder,
      notes: notes || null,
      recipePercent: recipePercent !== undefined && recipePercent !== null ? parseFloat(recipePercent) : null,
    },
    include: {
      inventoryItem: { select: { itemName: true } },
      linkedRecipe: { select: { name: true, yieldUnit: true } },
    },
  })

  await resyncPrepRecipe(params.id).catch(e => console.error('[ingredient POST] resync', e))
  return NextResponse.json({ id: ing.id }, { status: 201 })
}
```

- [ ] **Step 2: Update the PATCH route to handle custom rows and promote-on-substitute**

Replace the body of `PATCH` in `src/app/api/recipes/[id]/ingredients/[ingredientId]/route.ts` (keep imports + `export const dynamic`):

```ts
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; ingredientId: string } }
) {
  const body = await req.json()
  const { qtyBase, unit, notes, sortOrder, recipePercent, inventoryItemId, linkedRecipeId, customName } = body

  // Load the existing row to know whether it's a custom line (free-form unit) and
  // whether this PATCH is promoting it to a costed line.
  const existing = await prisma.recipeIngredient.findUnique({
    where: { id: params.ingredientId },
    select: { customName: true },
  })
  if (!existing) return NextResponse.json({ error: 'Ingredient not found' }, { status: 404 })

  const promoting = inventoryItemId !== undefined || linkedRecipeId !== undefined
  const isCustomAfter = !promoting && existing.customName !== null

  // Validate the unit only for costed lines. Custom lines store the unit raw.
  let unitToStore: string | undefined
  if (unit !== undefined) {
    if (isCustomAfter) {
      unitToStore = unit
    } else {
      try { unitToStore = assertKnownUnit(unit, 'ingredient unit') }
      catch (e) { if (e instanceof UnitError) return NextResponse.json({ error: e.message }, { status: 400 }); throw e }
    }
  }

  await prisma.recipeIngredient.update({
    where: { id: params.ingredientId },
    data: {
      ...(qtyBase !== undefined ? { qtyBase: parseFloat(qtyBase) } : {}),
      ...(unitToStore !== undefined ? { unit: unitToStore } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(sortOrder !== undefined ? { sortOrder } : {}),
      ...(recipePercent !== undefined ? { recipePercent: recipePercent !== null ? parseFloat(recipePercent) : null } : {}),
      ...(customName !== undefined ? { customName: customName || null } : {}),
      // Substituting with an inventory item — clears linkedRecipeId and any customName.
      ...(inventoryItemId !== undefined && linkedRecipeId === undefined ? { inventoryItemId, linkedRecipeId: null, customName: null } : {}),
      // Substituting with a linked recipe — clears inventoryItemId and any customName.
      ...(linkedRecipeId !== undefined ? { linkedRecipeId, inventoryItemId: null, customName: null } : {}),
    },
  })

  const costAffecting = qtyBase !== undefined || unit !== undefined || inventoryItemId !== undefined || linkedRecipeId !== undefined
  if (costAffecting) await resyncPrepRecipe(params.id).catch(e => console.error('[ingredient PATCH] resync', e))

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: build succeeds; both routes still show `ƒ (Dynamic)` in the route table.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/recipes/[id]/ingredients/route.ts" "src/app/api/recipes/[id]/ingredients/[ingredientId]/route.ts"
git commit -m "feat(recipes): API accepts and edits custom ingredient lines"
```

---

### Task 4: "Add anyway" in the search dropdowns

**Files:**
- Modify: `src/components/recipes/shared.tsx` — `RecipePanel` search (`~line 1515-1543`) + its `addIngredient` neighborhood (`~line 965`); `PrepRecipeModal` search (`~line 1752-1779`) + its `addIngredient` (`~line 1673`)

**Interfaces:**
- Consumes: the POST custom contract from Task 3 (`{ customName, qtyBase: 0, unit: '' }`).
- Produces: `addCustomIngredient(name: string)` in both `RecipePanel` and `PrepRecipeModal`; an "Add anyway" row rendered whenever the search box has a non-empty query.

- [ ] **Step 1: Add `addCustomIngredient` to `RecipePanel`**

In `src/components/recipes/shared.tsx`, immediately after the `addIngredient` function in `RecipePanel` (after `~line 1010`), add:

```ts
  const addCustomIngredient = async (rawName: string) => {
    const name = rawName.trim()
    if (!name) return
    setShowSearch(false); setSearchQ(''); setSearchResults([])

    const tempId = `temp-${Date.now()}`
    setRecipe(prev => {
      if (!prev) return prev
      const newIng: IngredientWithCost = {
        id: tempId,
        sortOrder: (prev.ingredients.at(-1)?.sortOrder ?? -1) + 1,
        qtyBase: 0,
        unit: '',
        notes: null,
        recipePercent: null,
        inventoryItemId: null,
        linkedRecipeId: null,
        ingredientName: name,
        ingredientType: 'custom',
        pricePerBaseUnit: 0,
        lineCost: 0,
        ingredientBaseUnit: '',
      }
      return { ...prev, ingredients: [...prev.ingredients, newIng] }
    })

    const res = await fetch(`/api/recipes/${recipeId}/ingredients`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customName: name, qtyBase: 0, unit: '' }),
    })
    if (res.ok) {
      const { id: realId } = await res.json()
      setRecipe(prev => prev ? { ...prev, ingredients: prev.ingredients.map(i => i.id === tempId ? { ...i, id: realId } : i) } : prev)
      dirtyRef.current = true
    } else {
      setRecipe(prev => prev ? { ...prev, ingredients: prev.ingredients.filter(i => i.id !== tempId) } : prev)
    }
  }
```

- [ ] **Step 2: Render the "Add anyway" row in the `RecipePanel` dropdown**

In `src/components/recipes/shared.tsx`, replace the dropdown block at `~line 1527-1542` (the `{showSearch && searchResults.length > 0 && ( … )}` region) with:

```tsx
              {showSearch && searchQ.trim() && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-line rounded-xl shadow-xl z-50 max-h-64 overflow-y-auto">
                  {searchResults.map(item => (
                    <button key={`${item.type}-${item.id}`} onClick={() => addIngredient(item)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-bg text-left text-sm">
                      {item.type === 'recipe' ? <ChefHat size={13} className="text-green shrink-0" /> : <Package size={13} className="text-blue shrink-0" />}
                      <span className="flex-1 text-ink-2">{item.name}</span>
                      <span className="text-xs text-ink-4">{item.unit}</span>
                      <span className="text-xs text-ink-3">{formatCurrency(item.pricePerBaseUnit)}/{item.unit}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${item.type === 'recipe' ? 'bg-green-soft text-green' : 'bg-gold/10 text-gold'}`}>
                        {item.type === 'recipe' ? 'PREP' : item.category}
                      </span>
                    </button>
                  ))}
                  <button onClick={() => addCustomIngredient(searchQ)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-bg text-left text-sm border-t border-line">
                    <Plus size={13} className="text-ink-4 shrink-0" />
                    <span className="flex-1 text-ink-2">Add <span className="font-medium text-ink">&ldquo;{searchQ.trim()}&rdquo;</span> as a custom ingredient</span>
                    <span className="text-xs text-ink-4 italic">no cost</span>
                  </button>
                </div>
              )}
```

- [ ] **Step 3: Add `addCustomIngredient` to `PrepRecipeModal`**

In `src/components/recipes/shared.tsx`, immediately after the `addIngredient` function inside `PrepRecipeModal` (after `~line 1680`), add the same helper but posting to the modal's `linkedRecipeId` and using its `load()`:

```ts
  const addCustomIngredient = async (rawName: string) => {
    const name = rawName.trim()
    if (!name) return
    setShowSearch(false); setSearchQ(''); setSearchResults([])
    await fetch(`/api/recipes/${linkedRecipeId}/ingredients`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customName: name, qtyBase: 0, unit: '' }),
    })
    await load()
  }
```

> Note: `PrepRecipeModal` reloads via `load()` rather than optimistic reconciliation (matches its existing `addIngredient`). Confirm the exact insertion point by locating `const addIngredient` within `PrepRecipeModal` and placing this directly after it.

- [ ] **Step 4: Render the "Add anyway" row in the `PrepRecipeModal` dropdown**

In `src/components/recipes/shared.tsx`, replace the dropdown block at `~line 1764-1778` (`{showSearch && searchResults.length > 0 && ( … )}`) with:

```tsx
                {showSearch && searchQ.trim() && (
                  <div className="absolute left-0 right-0 bottom-full mb-1 bg-white border border-line rounded-xl shadow-xl z-50 max-h-48 overflow-y-auto">
                    {searchResults.map(item => (
                      <button key={`${item.type}-${item.id}`} onClick={() => addIngredient(item)}
                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bg text-left text-sm">
                        {item.type === 'recipe' ? <ChefHat size={12} className="text-green shrink-0" /> : <Package size={12} className="text-blue shrink-0" />}
                        <span className="flex-1 text-ink-2">{item.name}</span>
                        <span className="text-xs text-ink-4">{item.unit}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${item.type === 'recipe' ? 'bg-green-soft text-green' : 'bg-gold/10 text-gold'}`}>
                          {item.type === 'recipe' ? 'PREP' : item.category}
                        </span>
                      </button>
                    ))}
                    <button onClick={() => addCustomIngredient(searchQ)}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bg text-left text-sm border-t border-line">
                      <Plus size={12} className="text-ink-4 shrink-0" />
                      <span className="flex-1 text-ink-2">Add <span className="font-medium text-ink">&ldquo;{searchQ.trim()}&rdquo;</span> as a custom ingredient</span>
                      <span className="text-xs text-ink-4 italic">no cost</span>
                    </button>
                  </div>
                )}
```

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: build succeeds. (`Plus` is already imported at the top of `shared.tsx`.)

- [ ] **Step 6: Commit**

```bash
git add src/components/recipes/shared.tsx
git commit -m "feat(recipes): 'Add anyway' custom-ingredient row in recipe & prep search"
```

---

### Task 5: Render custom rows — dimmed, free-form unit, no cost

**Files:**
- Modify: `src/components/recipes/shared.tsx` — `IngredientRow` (`~line 645-846`) and `PrepIngredientRow` (`~line 1796-1851`)

**Interfaces:**
- Consumes: `ing.ingredientType === 'custom'`, `ing.ingredientName`, `ing.unit`, `updateIngredient` PATCH from Task 3.
- Produces: custom lines display muted, with an inline free-text unit input and an empty cost cell; existing inventory/recipe rendering unchanged.

- [ ] **Step 1: Confirm the name area already handles custom**

No code change here — verification only. In `IngredientRow`:
- The name renders via the plain-`else` `<span>` (`~line 763-765`) whenever `inventoryItemId` is absent, which is true for custom lines — so the typed name shows correctly with no inventory link.
- `needsQty` (`~line 724`) is gated to `ing.ingredientType === 'inventory'`, so the "Needs qty" tag and the `bg-gold-soft/40` row tint (`~line 729`) already never apply to custom lines.
- The "Recipe" pill (`~line 766`) is gated to `ingredientType === 'recipe'`, so custom lines don't get it.

Read those three spots and confirm before moving on. The remaining steps add the muting, unit input, and empty cost cell.

- [ ] **Step 2: Add a dimmed style + `isCustom` flag at the top of `IngredientRow`'s return**

Find where `IngredientRow` computes its row-level values (near the top of the component body, before the `return`). Add:

```ts
  const isCustom = ing.ingredientType === 'custom'
```

Then, on the outer row container `<div className="grid grid-cols-12 …">` (the main row, `~line 745`), append a conditional muted/italic class. Locate that opening div and add to its className: `${isCustom ? 'italic text-ink-4' : ''}`.

- [ ] **Step 3: Replace the unit `<select>` with a free-text input for custom rows**

In `IngredientRow`, the unit cell is the `<div className="col-span-2">` containing the `<select>` (`~line 819-829`). Wrap it so custom rows get a text input instead:

```tsx
        <div className="col-span-2">
          {isCustom ? (
            <input
              value={unit}
              onChange={e => setUnit(e.target.value)}
              onBlur={() => { if (unit !== ing.unit) onUpdate(ing.id, { unit }) }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              placeholder="unit"
              className="w-full border border-line rounded px-1 py-0.5 font-mono text-[11px] text-ink-2 bg-paper focus:outline-none focus:ring-1 focus:ring-gold not-italic"
            />
          ) : (
            <select value={unitInList ? unit : '__custom__'} onChange={e => { if (e.target.value !== '__custom__') saveUnit(e.target.value) }}
              className="w-full border border-line rounded px-1 py-0.5 font-mono text-[11px] text-ink-2 bg-paper focus:outline-none focus:ring-1 focus:ring-gold">
              {!unitInList && <option value="__custom__">{unit}</option>}
              {compatibleGroups.map(group => (
                <optgroup key={group.label} label={group.label}>
                  {group.units.map(u => <option key={u.label} value={u.label}>{u.label}</option>)}
                </optgroup>
              ))}
            </select>
          )}
        </div>
```

> This reuses the existing `unit` state and `setUnit` setter already present in `IngredientRow` (used by the substitute/qty logic). `onUpdate` is the row's update prop (the same one `saveUnit`/`saveQty` call — confirm its name in the component's props destructure at `~line 645`; it is `onUpdate`). Verify `unit`/`setUnit` exist; if the component stores unit under a different local name, use that name consistently.

- [ ] **Step 4: Empty the cost cell for custom rows**

In `IngredientRow`, the cost cell is `<div className="col-span-2 text-right …">{ing.dimensionConflict && <UnitMismatchPill …/>}{formatCurrency(displayCost)}</div>` (`~line 831-834`). Replace its contents:

```tsx
        <div className="col-span-2 text-right font-mono text-[13px] font-medium text-ink">
          {isCustom ? (
            <span className="text-ink-4 not-italic text-[11px]">—</span>
          ) : (
            <>
              {ing.dimensionConflict && <UnitMismatchPill ing={ing} />}
              {formatCurrency(displayCost)}
            </>
          )}
        </div>
```

- [ ] **Step 5: Give the same treatment to `PrepIngredientRow`**

In `PrepIngredientRow` (`~line 1815-1849`), add `const isCustom = ing.ingredientType === 'custom'` near the top of the component body, mute the row, swap the unit control, and empty the cost cell.

Name/icon block (`~line 1817-1825`) — the icon currently only distinguishes recipe vs inventory; for custom use the `Package`-less muted look by leaving the existing icon logic but adding muted text is enough. Change the row container `<div className="grid grid-cols-12 gap-2 px-4 py-2 items-center border-t border-line hover:bg-bg group">` to append `${isCustom ? 'italic text-ink-4' : ''}`.

Unit cell (`~line 1831-1841`):

```tsx
      <div className="col-span-2">
        {isCustom ? (
          <input value={unit} onChange={e => setUnit(e.target.value)}
            onBlur={() => { if (unit !== ing.unit) onUpdate({ qtyBase: qty, unit }) }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            placeholder="unit"
            className="w-full border border-line rounded px-1 py-0.5 text-xs text-ink-2 bg-white focus:outline-none focus:ring-1 focus:ring-gold not-italic" />
        ) : (
          <select value={unitInList ? unit : '__custom__'} onChange={e => { if (e.target.value !== '__custom__') saveUnit(e.target.value) }}
            className="w-full border border-line rounded px-1 py-0.5 text-xs text-ink-2 bg-white focus:outline-none focus:ring-1 focus:ring-gold">
            {!unitInList && <option value="__custom__">{unit}</option>}
            {compatibleGroups.map(group => (
              <optgroup key={group.label} label={group.label}>
                {group.units.map(u => <option key={u.label} value={u.label}>{u.label}</option>)}
              </optgroup>
            ))}
          </select>
        )}
      </div>
```

Cost cell (`~line 1842-1845`):

```tsx
      <div className="col-span-2 text-right text-sm font-medium text-ink-2">
        {isCustom ? (
          <span className="text-ink-4 not-italic text-xs">—</span>
        ) : (
          <>
            {ing.dimensionConflict && <UnitMismatchPill ing={ing} />}
            {formatCurrency(ing.lineCost)}
          </>
        )}
      </div>
```

- [ ] **Step 6: Type-check**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 7: Manual verification in the preview**

Start the dev server via `preview_start` (name from `.claude/launch.json`, port 3000). In a recipe:
1. Type a non-inventory name (e.g. "edible flowers") in the ingredient search → confirm the **Add "edible flowers" as a custom ingredient — no cost** row appears.
2. Click it → the row appears **dimmed/italic**, cost cell shows `—`, unit cell is a free-text input.
3. Type `sprig` into the unit input, set qty `3`, reload → values persist; recipe total cost is unchanged.
4. Open the substitute pencil on the custom row, pick a real inventory item → row becomes a normal costed line (no longer dimmed, cost shows).
Capture a screenshot to share as proof.

- [ ] **Step 8: Commit**

```bash
git add src/components/recipes/shared.tsx
git commit -m "feat(recipes): render custom ingredient rows dimmed with free-form unit, no cost"
```

---

## Self-Review

**Spec coverage:**
- §1 data model → Task 1. §2 cost engine → Task 2. §3 types → Task 2 (both files). §4 API POST/PATCH → Task 3. §5 search "Add anyway" (RecipePanel + PrepRecipeModal) → Task 4. §6 row rendering (IngredientRow + PrepIngredientRow, promote-on-substitute) → Task 3 (PATCH nulls customName) + Task 5. §7 scope → Tasks 4–5 cover both editors; inline substitute unchanged. §8 testing → Task 2 (vitest), build steps throughout, manual verify in Task 5.
- Every spec section maps to a task. No gaps.

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Code shown in every code step. The two `> Note:` blocks give the implementer verification guidance for insertion points, not deferred work.

**Type consistency:** `ingredientType: 'inventory' | 'recipe' | 'custom'` widened in both `recipeCosts.ts` (Task 2 Step 1) and `shared.tsx` (Task 2 Step 6). `addCustomIngredient(name: string)` used identically in Task 4 Steps 1/3 and called in Steps 2/4. `customName` field name consistent across schema (Task 1), cost engine input type (Task 2), and both API routes (Task 3). POST contract `{ customName, qtyBase: 0, unit: '' }` matches between Task 3 (accepts) and Task 4 (sends). `isCustom` local flag consistent within Task 5.
