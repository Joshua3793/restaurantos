# Count session: RC-scoped sync + dual stepper + empty count field — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make count-session sync respect the session's revenue center, start the count field empty, and replace the single UOM-dependent stepper with an explicit `±1` / `±0.1` dual stepper in both renderers.

**Architecture:** Two files. The sync API route gains the same `ItemRevenueCenter` filter the session-creation route already uses. The count page's `inputQty` state widens to `number | ''` (empty display, coerced to `0` for math), and both the mobile and desktop stepper blocks are rebuilt as a two-row control.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma, Tailwind, lucide-react (`Plus` / `Minus` already imported in the file).

## Global Constraints

- No test suite exists — `npm run build` (type-check + build) is the only automated correctness check. Every task ends with a green `npm run build`.
- Prisma `Decimal` fields arrive as strings in JSON — wrap with `Number()` before arithmetic (already the pattern in this file).
- Numbered Tailwind color classes are broken; use the flat tokens already in use in these blocks (`bg-bg-2`, `border-line`, `text-ink-2`, `bg-gold`/`border-gold`, `bg-ink`, `text-gold`, etc.).
- Dual-renderer convention: mobile block (`sm:hidden`) precedes desktop block (`hidden sm:block`); edits to one do not affect the other. Both must be changed.
- Branch already created: `feat/count-stepper-rc-sync` (spec committed there).

## File Structure

- `src/app/api/count/sessions/[id]/sync/route.ts` — add RC filter to the `inventoryItem.findMany` where-clause (Task 1).
- `src/app/count/page.tsx` — widen `inputQty` type + coerce at math sites + reset-to-empty sites (Task 2); rebuild both stepper JSX blocks and drop `stepBy` (Task 3).

---

### Task 1: RC-scope the sync route

**Files:**
- Modify: `src/app/api/count/sessions/[id]/sync/route.ts:28-35`

**Interfaces:**
- Consumes: `session.revenueCenterId` (already loaded at the top of the handler, line 12).
- Produces: no new exports; behavior change only.

- [ ] **Step 1: Add the RC filter to the active-items query**

Replace the `where` object in the `activeItems` query (lines 29-33):

```ts
  const activeItems = await prisma.inventoryItem.findMany({
    where: {
      isActive: true,
      isStocked: true,
      ...(areaIds.length > 0 ? { storageAreaId: { in: areaIds } } : {}),
      // RC-scoped session → only items that are members of this revenue center
      // (ItemRevenueCenter). An unscoped session (no revenueCenterId) keeps the
      // legacy "all items". Mirrors POST /api/count/sessions item selection.
      ...(session.revenueCenterId
        ? { revenueCenters: { some: { revenueCenterId: session.revenueCenterId } } }
        : {}),
    },
    orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
  })
```

- [ ] **Step 2: Type-check / build**

Run: `npm run build`
Expected: build succeeds; the route still shows `ƒ (Dynamic)` in output (it already uses `params`, so it stays dynamic).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/count/sessions/[id]/sync/route.ts
git commit -m "fix(count): RC-scope the sync-from-inventory query"
```

---

### Task 2: Start the count field empty

Widen `inputQty` to `number | ''` and coerce to `0` everywhere it feeds arithmetic. This task leaves the stepper JSX structurally unchanged except the input `value`/`onChange` (Task 3 rebuilds the surrounding buttons).

**Files:**
- Modify: `src/app/count/page.tsx` (lines 282, 450, 778, 830, 1966/1969, 2137, 2218, 2273, 2366, 2379)

**Interfaces:**
- Consumes: nothing new.
- Produces: `inputQty: number | ''` — every numeric read must coerce with `Number(inputQty) || 0`. `''` means "untouched / show blank", saved as `0`.

- [ ] **Step 1: Widen the state type and start empty**

Line 282, change:

```ts
  const [inputQty,      setInputQty]      = useState<number | ''>('')
```

- [ ] **Step 2: Reset-to-empty at the fresh-line and reset sites**

Line 450 (fresh line — keep prior count as a number, else empty):

```ts
      setInputQty(line.countedQty !== null ? Number(line.countedQty) : '')
```

Line 830 (`setInputQty(0)` → empty):

```ts
    setInputQty('')
```

Line 2366 (unit-tab switch resets the field — inside the mobile unit tabs `onClick`):

```ts
                      <button key={label} onClick={() => { if (label !== line.selectedUom) { changeUom(line, label); setInputQty(''); setCaseQty(0) } }}
```

Leave line 458 (`setInputQty(Number(saved[0].qty) || 0)`) as-is — a rehydrated multi-entry line is a real number.

- [ ] **Step 3: Coerce at the arithmetic sites**

Line 778 (`changeUom` conversion):

```ts
      const inBase = convertCountQtyToBase(Number(inputQty) || 0, line.selectedUom, line.inventoryItem)
```

Lines 1966 and 1969 (live variance preview):

```ts
      const dAllEntries = [{ qty: Number(inputQty) || 0, unit: line.selectedUom }, ...extraEntries]
      const inputBase = dHasExtras
        ? countEntriesToBase(dAllEntries, line.inventoryItem)
        : convertCountQtyToBase(Number(inputQty) || 0, line.selectedUom, line.inventoryItem)
```

Line 2218 (desktop confirm — coerce both the qty arg and the primary entry):

```ts
                  onClick={() => confirmLine(line, Number(inputQty) || 0, extraEntries.length > 0 ? [{ qty: Number(inputQty) || 0, unit: line.selectedUom }, ...extraEntries] : undefined)}
```

Line 2273 (mobile `effectiveQty`):

```ts
      const effectiveQty = (Number(inputQty) || 0) + (showCases ? caseQty * _caseInSel : 0)
```

- [ ] **Step 4: Allow the inputs to clear back to empty**

Both stepper inputs currently do `onChange={e => setInputQty(parseFloat(e.target.value) || 0)}`. Update both (desktop line 2137, mobile line 2379) so an empty field stays empty:

```ts
                  onChange={e => setInputQty(e.target.value === '' ? '' : (parseFloat(e.target.value) || 0))}
```

- [ ] **Step 5: Search for any remaining unguarded `inputQty` arithmetic**

Run: `grep -n "inputQty" src/app/count/page.tsx`
Confirm every remaining use is one of: a `setInputQty(v => …)` updater (whose `v` is coerced with `Number(v) || 0`), a `Number(inputQty) || 0` coercion, or an input `value={inputQty}` (React renders `''` as blank — correct). Note the mobile renderer confirms via `effectiveQty` (line 2273, coerced in Step 3), not `inputQty` directly. Fix any bare `inputQty +`/`inputQty *`/function-arg use that slipped through with `Number(inputQty) || 0`.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: build succeeds with no type error on `inputQty` (the `number | ''` type is fully coerced at every math site).

- [ ] **Step 7: Commit**

```bash
git add src/app/count/page.tsx
git commit -m "feat(count): start the count field empty instead of 0"
```

---

### Task 3: Dual `±1` / `±0.1` steppers in both renderers

Replace the single stepper in each renderer with a two-row control: coarse `±1` buttons flanking the centered input on top, smaller `±0.1` buttons constrained to the input width and centered on the second row. Remove the UOM-dependent `stepBy`.

**Files:**
- Modify: `src/app/count/page.tsx` — desktop stepper (lines 2127-2147), mobile stepper (lines 2374-2383), remove `stepBy` (line 2254).

**Interfaces:**
- Consumes: `inputQty: number | ''` and `setInputQty` from Task 2.
- Produces: no new exports. Stepper handlers use `Math.max(0, Math.round(((Number(v) || 0) ± STEP) * 100) / 100)`.

- [ ] **Step 1: Remove the `stepBy` variable**

Delete line 2254 entirely:

```ts
      const stepBy      = /^(kg|l|lb|gal|qt)$/i.test(line.selectedUom) ? 0.1 : 1   // fine step for bulk weight/volume units
```

- [ ] **Step 2: Rebuild the desktop stepper**

Replace the whole `{/* ± stepper */}` block (lines 2126-2147):

```tsx
              {/* ± stepper — coarse ±1 flanks the input, fine ±0.1 below */}
              <div className="mb-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setInputQty(v => Math.max(0, Math.round(((Number(v) || 0) - 1) * 100) / 100))}
                    className="w-14 h-[66px] rounded-[9px] bg-bg-2 border border-line flex items-center justify-center hover:bg-line transition-colors shrink-0"
                    aria-label="Subtract 1"
                  >
                    <Minus size={20} className="text-ink-2" />
                  </button>
                  <input
                    type="number"
                    value={inputQty}
                    onChange={e => setInputQty(e.target.value === '' ? '' : (parseFloat(e.target.value) || 0))}
                    className="flex-1 min-w-0 h-[66px] text-center text-[28px] font-semibold tracking-[-0.03em] border-2 border-gold rounded-[9px] focus:outline-none text-ink"
                    min={0} step={0.1}
                  />
                  <button
                    onClick={() => setInputQty(v => Math.round(((Number(v) || 0) + 1) * 100) / 100)}
                    className="w-14 h-[66px] rounded-[9px] bg-bg-2 border border-line flex items-center justify-center hover:bg-line transition-colors shrink-0"
                    aria-label="Add 1"
                  >
                    <Plus size={20} className="text-ink-2" />
                  </button>
                </div>
                {/* fine ±0.1 row, constrained to the input width (button 56px + gap 8px each side) */}
                <div className="flex gap-2 mt-2 px-[64px]">
                  <button
                    onClick={() => setInputQty(v => Math.max(0, Math.round(((Number(v) || 0) - 0.1) * 100) / 100))}
                    className="flex-1 h-9 rounded-[9px] bg-bg-2 border border-line flex items-center justify-center gap-1 hover:bg-line transition-colors text-ink-3"
                    aria-label="Subtract 0.1"
                  >
                    <Minus size={13} /><span className="text-[12px] font-medium">0.1</span>
                  </button>
                  <button
                    onClick={() => setInputQty(v => Math.round(((Number(v) || 0) + 0.1) * 100) / 100)}
                    className="flex-1 h-9 rounded-[9px] bg-bg-2 border border-line flex items-center justify-center gap-1 hover:bg-line transition-colors text-ink-3"
                    aria-label="Add 0.1"
                  >
                    <Plus size={13} /><span className="text-[12px] font-medium">0.1</span>
                  </button>
                </div>
              </div>
```

- [ ] **Step 3: Rebuild the mobile stepper**

Replace the `{/* Big stepper */}` block (lines 2374-2384) — keep the "on hand" caption and "tap to type" hint:

```tsx
                {/* Big stepper — coarse ±1 flanks the input, fine ±0.1 below */}
                <div className="text-center font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em] mt-4 mb-2">{line.selectedUom} on hand</div>
                <div className="flex items-center gap-3">
                  <button onClick={() => setInputQty(v => Math.max(0, Math.round(((Number(v) || 0) - 1) * 100) / 100))}
                    className="w-[60px] h-[60px] rounded-2xl bg-bg-2 border border-line grid place-items-center shrink-0 active:bg-line" aria-label="Subtract 1"><Minus size={26} className="text-ink-2" /></button>
                  <input type="number" value={inputQty} onChange={e => setInputQty(e.target.value === '' ? '' : (parseFloat(e.target.value) || 0))}
                    className="flex-1 min-w-0 h-[60px] text-center text-[40px] font-semibold tracking-[-0.03em] border-2 border-gold rounded-2xl focus:outline-none text-ink" min={0} step={0.1} />
                  <button onClick={() => setInputQty(v => Math.round(((Number(v) || 0) + 1) * 100) / 100)}
                    className="w-[60px] h-[60px] rounded-2xl bg-ink grid place-items-center shrink-0 active:bg-ink-2" aria-label="Add 1"><Plus size={26} className="text-gold" /></button>
                </div>
                {/* fine ±0.1 row, constrained to the input width (button 60px + gap 12px each side) */}
                <div className="flex gap-3 mt-2 px-[72px]">
                  <button onClick={() => setInputQty(v => Math.max(0, Math.round(((Number(v) || 0) - 0.1) * 100) / 100))}
                    className="flex-1 h-10 rounded-xl bg-bg-2 border border-line flex items-center justify-center gap-1 active:bg-line text-ink-3" aria-label="Subtract 0.1"><Minus size={16} /><span className="text-[13px] font-medium">0.1</span></button>
                  <button onClick={() => setInputQty(v => Math.round(((Number(v) || 0) + 0.1) * 100) / 100)}
                    className="flex-1 h-10 rounded-xl bg-bg-2 border border-line flex items-center justify-center gap-1 active:bg-line text-ink-3" aria-label="Add 0.1"><Plus size={16} /><span className="text-[13px] font-medium">0.1</span></button>
                </div>
                <div className="text-center font-mono text-[10.5px] text-ink-4 mt-2">tap to type</div>
```

- [ ] **Step 4: Confirm `stepBy` is fully gone**

Run: `grep -n "stepBy" src/app/count/page.tsx`
Expected: no matches.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Visual check in preview**

Start the dev server (preview_start) and open a count session. Confirm:
- The count field opens blank (no `0`).
- Top row `−1` / `+1` change the value by 1 and clamp at 0.
- Second-row `−0.1` / `+0.1` buttons are smaller, centered under the input, and change the value by 0.1.
- Typing a number then clearing it leaves the field blank (not `0`).

- [ ] **Step 7: Commit**

```bash
git add src/app/count/page.tsx
git commit -m "feat(count): dual ±1 / ±0.1 stepper in both renderers"
```

---

## Self-Review

- **Spec coverage:** RC sync → Task 1. Empty field → Task 2. Dual steppers (both renderers, always-visible, `stepBy` removed, clamp/round preserved) → Task 3. All three spec sections mapped.
- **Placeholder scan:** No TBD/TODO; every code step carries full code.
- **Type consistency:** `inputQty` is `number | ''` from Task 2 onward; every arithmetic site (778, 1966/1969, 2218, 2273) and every stepper updater (`Number(v) || 0`) coerces; input `value={inputQty}` renders `''` as blank, which is intended. `setInputQty` accepts both `''` and numbers and updater functions returning numbers — consistent with the widened type.
