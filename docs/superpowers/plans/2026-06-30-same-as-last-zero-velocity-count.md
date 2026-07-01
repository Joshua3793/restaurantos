# "Same as last" for zero-velocity count items — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let counters confirm zero-velocity (no-movement-since-last-count) items unchanged in a count session — via a per-line "Same as last" button and a filtered bulk "Confirm all unchanged" — recording an honest zero-variance count flagged as carried-forward.

**Architecture:** A `CountLine.noMovement` boolean is computed at session creation from the same consumption/purchase/wastage/prep maps that produce `expectedQty`. A `CountLine.carriedForward` boolean records counts that came from "Same as last." The client routes both the per-line and bulk actions through the existing `confirmLine` path (reusing its offline queue + 409 merge), recording `countedQty = expectedQty` with variance forced to 0.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Tailwind. No test suite — `npm run build` is the correctness gate (CLAUDE.md), plus a manual flow check in the running app.

**Spec:** `docs/superpowers/specs/2026-06-30-same-as-last-zero-velocity-count-design.md`

---

## Verification convention

This repo has **no unit-test runner**. For every task, "verify" means:
- Run `npm run build` (this is also the type-check) and confirm it completes with no errors.
- Where a task changes runtime behavior, do the listed **manual check** in the dev app (`npm run dev`, http://localhost:3000/count).

> ⚠️ Do not run `npm run build` while the dev server is running — the project deadlocks (see memory: Reports page build deadlock). Stop the dev server before building.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `prisma/schema.prisma` | `CountLine` model | Add `noMovement`, `carriedForward` booleans |
| `prisma/migrations/20260630000000_count_line_carried_nomovement/migration.sql` | DDL | New: two `ADD COLUMN` |
| `src/app/api/count/sessions/route.ts` | Session create (POST) | Compute + store `noMovement` per line |
| `src/app/api/count/sessions/[id]/lines/[lineId]/route.ts` | Line PATCH | Accept + persist `carriedForward`; zero variance |
| `src/lib/count-offline.ts` | Offline queue | Carry `carried` flag through queue + flush |
| `src/app/count/page.tsx` | Count UI | `Line` type, `confirmLine` carried opt, filter, per-line button, bulk bar + dialog, badge |

GET `src/app/api/count/sessions/[id]/route.ts` needs **no change**: it spreads `...l`, so the new scalar columns flow through automatically (verified in Task 3's manual check).

---

## Task 1: Schema + migration — `noMovement` and `carriedForward`

**Files:**
- Modify: `prisma/schema.prisma` (model `CountLine`, around line 233-252)
- Create: `prisma/migrations/20260630000000_count_line_carried_nomovement/migration.sql`

- [ ] **Step 1: Add the two fields to the `CountLine` model**

In `prisma/schema.prisma`, inside `model CountLine`, add these two lines just after `skipped Boolean @default(false)` (line 243):

```prisma
  noMovement      Boolean       @default(false)
  carriedForward  Boolean       @default(false)
```

- [ ] **Step 2: Hand-write the migration SQL**

Create `prisma/migrations/20260630000000_count_line_carried_nomovement/migration.sql` with:

```sql
-- Zero-velocity "Same as last" support
ALTER TABLE "CountLine" ADD COLUMN "noMovement" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CountLine" ADD COLUMN "carriedForward" BOOLEAN NOT NULL DEFAULT false;
```

> Why hand-written: `prisma migrate dev` fails in this project (P3006 shadow-DB drift — see memory "Prisma migrate shadow DB broken"). Never run a full-schema `migrate diff`. These two additive, defaulted columns are safe DDL.

- [ ] **Step 3: Apply the migration against the direct (non-pooler) connection**

Run:
```bash
npx prisma db execute --url "$DIRECT_URL" --file prisma/migrations/20260630000000_count_line_carried_nomovement/migration.sql
```
Expected: completes silently (no output = success). If `$DIRECT_URL` is not exported in the shell, read it from `.env` and pass the literal value.

- [ ] **Step 4: Mark the migration applied and regenerate the client**

Run:
```bash
npx prisma migrate resolve --applied 20260630000000_count_line_carried_nomovement
npx prisma generate
```
Expected: "Migration ... marked as applied." then "Generated Prisma Client".

- [ ] **Step 5: Verify the build picks up the new fields**

Run: `npm run build`
Expected: PASS (no type errors). Prisma types now include `CountLine.noMovement` and `CountLine.carriedForward`.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260630000000_count_line_carried_nomovement
git commit -m "feat(count): add CountLine.noMovement + carriedForward columns"
```

---

## Task 2: Session create — compute and store `noMovement`

**Files:**
- Modify: `src/app/api/count/sessions/route.ts` (the `lines.create` map, lines 158-181)

The maps `consumptionMap`, `purchaseMap`, `wastageMap`, `prepMap` are already built above this loop (lines 112-125) with per-item cutoff. An item that is absent from all of them had zero movement in its window. Combined with "has a prior count" (`item.lastCountDate != null`), that is exactly `noMovement`.

- [ ] **Step 1: Compute `noMovement` inside the create map and store it**

Replace the `lines.create` callback body (lines 158-181) so it computes `noMovement` and adds it to the returned object. The full replacement for the `create: items.map(...)` block:

```ts
        create: items.map((item, i) => {
          const baseStock = revenueCenterId
            ? (stockAllocationMap.has(item.id)
                ? stockAllocationMap.get(item.id)!
                : (isDefaultRc ? Number(item.stockOnHand) : 0))
            : Number(item.stockOnHand)

          const expected = computeExpected(item.id, baseStock, consumptionMap, purchaseMap, wastageMap, prepMap.consumption, prepMap.output)

          // Zero-velocity: a previously-counted item that NO movement map touched in
          // its window. expected == baseStock == its last counted qty by construction,
          // so "Same as last" can record it with an honest zero variance.
          const moved =
            consumptionMap.has(item.id) ||
            purchaseMap.has(item.id) ||
            wastageMap.has(item.id) ||
            prepMap.consumption.has(item.id) ||
            prepMap.output.has(item.id)
          const noMovement = item.lastCountDate != null && !moved

          return {
            inventoryItemId: item.id,
            expectedQty:     expected,
            noMovement,
            // Derive from the purchase format (self-heals legacy items whose
            // stored countUOM no longer matches their structure).
            selectedUom:     resolveCountUom({
              dimension: item.dimension,
              baseUnit:  item.baseUnit,
              packChain: item.packChain,
              countUnit: item.countUnit,
            }) || item.baseUnit,
            priceAtCount:    pricePerBaseUnit(asChainItem(item)),
            sortOrder:       i,
          }
        }),
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Manual check — `noMovement` is set correctly**

Start the dev server (`npm run dev`), create a new full count, then in the browser devtools Network tab inspect the `POST /api/count/sessions` response. Confirm: lines for items with a prior count and no recent invoice/sale/wastage/prep show `"noMovement": true`; an item you know was recently received or sold shows `"noMovement": false`; an item that has never been counted shows `"noMovement": false`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/count/sessions/route.ts
git commit -m "feat(count): compute + store noMovement at session creation"
```

---

## Task 3: Line PATCH — accept and persist `carriedForward`

**Files:**
- Modify: `src/app/api/count/sessions/[id]/lines/[lineId]/route.ts`

- [ ] **Step 1: Destructure `carriedForward` from the request body**

Change line 13 from:
```ts
  const { countedQty, selectedUom, skipped, notes, expectedUpdatedAt, entries } = body
```
to:
```ts
  const { countedQty, selectedUom, skipped, notes, expectedUpdatedAt, entries, carriedForward } = body
```

- [ ] **Step 2: Persist the flag and force zero variance on the single-unit count branch**

In the `else if (countedQty !== undefined)` branch (lines 73-89), replace its `data = { ... }` assignment with:

```ts
    data = {
      countedQty:   counted,
      skipped:      false,
      carriedForward: carriedForward === true,
      entries:      Prisma.DbNull,  // single-unit path clears any prior mixed-unit entries
      // A carried-forward "Same as last" count is unchanged by definition — pin
      // variance to exactly 0 rather than letting base-unit round-trip rounding
      // introduce a tiny non-zero figure.
      variancePct:  carriedForward === true ? 0 : (expected > 0 ? ((countedBase - expected) / expected) * 100 : 0),
      varianceCost: carriedForward === true ? 0 : (countedBase - expected) * price,
      ...(selectedUom !== undefined ? { selectedUom } : {}),
      ...(notes       !== undefined ? { notes }       : {}),
    }
```

- [ ] **Step 3: Clear the flag on the other write branches**

So a previously-carried line that is re-counted or reset loses the flag:

In the mixed-entries branch (`else if (validEntries && validEntries.length > 0)`, lines 56-72), add `carriedForward: false,` to its `data` object (e.g. just after `skipped: false,`).

In the unskip/reset branch (`else if (skipped === false)`, line 55), change it to:
```ts
    data = { skipped: false, countedQty: null, variancePct: null, varianceCost: null, carriedForward: false, entries: Prisma.DbNull }
```

(The `skipped === true` branch keeps `carriedForward` untouched — a skipped line is excluded from valuation anyway.)

- [ ] **Step 4: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Manual check — GET round-trips the new columns**

With the dev server running, open an in-progress session and inspect the `GET /api/count/sessions/[id]` response in the Network tab. Confirm each line includes `noMovement` and `carriedForward` (proves the GET `...l` spread carries them with no GET-route change). Then PATCH a line via the UI later (Task 6) and confirm `carriedForward` flips.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/count/sessions/[id]/lines/[lineId]/route.ts"
git commit -m "feat(count): persist carriedForward + zero variance on Same-as-last PATCH"
```

---

## Task 4: Offline queue — carry the `carried` flag

**Files:**
- Modify: `src/lib/count-offline.ts`

- [ ] **Step 1: Add `carried` to the `CountMutation` interface**

Change the interface (lines 5-13) to add a `carried` field:

```ts
export interface CountMutation {
  id:        string
  ts:        number
  sessionId: string
  lineId:    string
  type:      'count' | 'skip'
  qty?:      number
  entries?:  { unit: string; qty: number }[]   // mixed-unit count (authoritative when present)
  carried?:  boolean                            // "Same as last" — record unchanged, zero variance
}
```

- [ ] **Step 2: Send `carriedForward` when flushing a carried count**

In `flushCountQueue`, change the body builder (lines 98-104) to:

```ts
        body: JSON.stringify(
          m.type === 'skip'
            ? { skipped: true }
            : m.entries && m.entries.length
              ? { entries: m.entries }
              : { countedQty: m.qty, ...(m.carried ? { carriedForward: true } : {}) },
        ),
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/count-offline.ts
git commit -m "feat(count): carry Same-as-last flag through offline queue"
```

---

## Task 5: Client — `Line` type, `confirmLine` carried option, bulk state

**Files:**
- Modify: `src/app/count/page.tsx`

- [ ] **Step 1: Add the new fields to the `Line` interface**

In the `interface Line` block (lines 46-62), add after `skipped: boolean` (line 55):

```ts
  noMovement?: boolean
  carriedForward?: boolean
```

- [ ] **Step 2: Extend the `statusFilter` union and add bulk-selection state**

Change line 287 from:
```ts
  const [statusFilter,  setStatusFilter]  = useState<'all' | 'uncounted' | 'counted' | 'skipped'>('all')
```
to:
```ts
  const [statusFilter,  setStatusFilter]  = useState<'all' | 'uncounted' | 'counted' | 'skipped' | 'nomovement'>('all')
```

Then add, immediately after line 290 (`const [editingItemId, ...]`):

```ts
  // ── Bulk "Same as last" (zero-velocity confirm) ─────────────────────────────
  const [bulkSelected,    setBulkSelected]    = useState<Set<string>>(new Set())
  const [showBulkConfirm, setShowBulkConfirm] = useState(false)
  const [bulkBusy,        setBulkBusy]        = useState(false)
```

- [ ] **Step 3: Add the `nomovement` clause to `filteredLines`**

In the `filteredLines` `useMemo` (lines 498-510), add this line right after the `statusFilter === 'skipped'` clause (line 506):

```ts
      if (statusFilter === 'nomovement') { if (!l.noMovement || l.countedQty !== null || l.skipped) return false }
```

- [ ] **Step 4: Add the carried `opts` parameter to `confirmLine`**

Change the `confirmLine` signature (line 645) from:
```ts
  const confirmLine = async (line: Line, qty: number, entries?: { unit: string; qty: number }[]) => {
```
to:
```ts
  const confirmLine = async (line: Line, qty: number, entries?: { unit: string; qty: number }[], opts?: { carried?: boolean; silent?: boolean }) => {
    const carried = opts?.carried === true
```

Then, within `confirmLine`:

(a) Force zero variance for carried counts. Change the `vPct`/`vCost` lines (654-658) to:
```ts
    const vPct  = carried ? 0 : (Number(line.expectedQty) > 0 ? ((qtyBase - Number(line.expectedQty)) / Number(line.expectedQty)) * 100 : 0)
    // Value the in-progress variance at the LIVE derived spine price; priceAtCount is only
    // the fallback (and remains the authoritative snapshot for finalized/historical lines).
    const livePpb = Number(line.inventoryItem.pricePerBaseUnit ?? line.priceAtCount)
    const vCost = carried ? 0 : (qtyBase - Number(line.expectedQty)) * livePpb
```

(b) Mark the optimistic line carried. Change `applyCount` (lines 662-663) to:
```ts
    const applyCount = (l: Line): Line =>
      l.id === line.id ? { ...l, ...optimistic, skipped: false, carriedForward: carried, variancePct: vPct, varianceCost: vCost } : l
```

(c) Skip auto-advance when silent (used by bulk). Change the auto-advance block (lines 666-674) to:
```ts
    // Auto-advance to next uncounted
    if (!opts?.silent) {
      const next = filteredLines.find(l => l.id !== line.id && l.countedQty === null && !l.skipped)
      if (next) {
        setTimeout(() => {
          setOpenId(next.id)
          const prefix = typeof window !== 'undefined' && window.innerWidth < 640 ? 'm-' : 'd-'
          cardRefs.current[`${prefix}${next.id}`]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, 120)
      }
    }
```

(d) Carry the flag into the offline queue payload. Change `queueCount` (lines 682-686) to:
```ts
    const queueCount = () => {
      enqueueCountMutation({ sessionId: active!.id, lineId: line.id, type: 'count', qty, ...(mixed ? { entries } : {}), ...(carried ? { carried: true } : {}) })
      setPendingCount(c => c + 1)
      if (active) saveCountSessionCache(active.id, { ...active, lines: active.lines!.map(applyCount) })
    }
```

(e) Send `carriedForward` in the online PATCH body. Change the non-mixed branch of the request body (line 697) from:
```ts
            : { countedQty: qty, expectedUpdatedAt: line.updatedAt },
```
to:
```ts
            : { countedQty: qty, expectedUpdatedAt: line.updatedAt, ...(carried ? { carriedForward: true } : {}) },
```

- [ ] **Step 5: Add the per-line and bulk confirm helpers**

Immediately after the `confirmLine` function (after its closing `}` at line 724), add:

```ts
  // "Same as last" — record the line's expected qty (== last count for a no-movement
  // item) as the count, flagged carried-forward with zero variance. Reuses confirmLine
  // so it inherits the offline queue + 409 merge.
  const confirmSameAsLast = (line: Line, silent = false) => {
    const qty = convertBaseToCountUom(Number(line.expectedQty), line.selectedUom, line.inventoryItem)
    return confirmLine(line, qty, undefined, { carried: true, silent })
  }

  // Eligible lines currently visible under the No-movement filter (uncounted only).
  const bulkEligible = filteredLines.filter(l => l.noMovement && l.countedQty === null && !l.skipped)

  // Total $ value of the selected lines, valued at the live spine price.
  const bulkSelectedValue = () =>
    bulkEligible
      .filter(l => bulkSelected.has(l.id))
      .reduce((sum, l) => sum + Number(l.expectedQty) * Number(l.inventoryItem.pricePerBaseUnit ?? l.priceAtCount), 0)

  const toggleBulk = (id: string) =>
    setBulkSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })

  const bulkSelectAll = () => setBulkSelected(new Set(bulkEligible.map(l => l.id)))
  const bulkSelectNone = () => setBulkSelected(new Set())

  const runBulkConfirm = async () => {
    setBulkBusy(true)
    const targets = bulkEligible.filter(l => bulkSelected.has(l.id))
    for (const line of targets) {
      // Sequential: each confirmSameAsLast awaits its PATCH and falls back to the
      // offline queue on failure, so one bad line never aborts the batch.
      await confirmSameAsLast(line, true)
    }
    setBulkBusy(false)
    setShowBulkConfirm(false)
    setBulkSelected(new Set())
  }
```

- [ ] **Step 6: Verify the build**

Run: `npm run build`
Expected: PASS. (No UI wired yet — Tasks 6-9 add the controls. This task only adds dead-but-typed code, so the build must still pass.)

- [ ] **Step 7: Commit**

```bash
git add src/app/count/page.tsx
git commit -m "feat(count): Same-as-last confirm logic + bulk selection state"
```

---

## Task 6: Client — per-line "Same as last" button (both renderers)

**Files:**
- Modify: `src/app/count/page.tsx`

The button appears in the expanded-card action row of an eligible, uncounted line in both renderers.

- [ ] **Step 1: Desktop action row**

In the desktop expanded body action row (the `<div className="flex gap-2">` at line 2139), add a "Same as last" button as the FIRST child, before the "Confirm count" button (line 2140). Insert:

```tsx
                {line.noMovement && line.countedQty === null && (
                  <button
                    onClick={() => confirmSameAsLast(line)}
                    className="px-3 h-11 border border-gold bg-gold-soft text-gold-2 rounded-[9px] font-medium text-[13px] hover:bg-[#fde68a] transition-colors flex items-center gap-1.5"
                    title="No movement since last count — record unchanged"
                  >
                    <Copy size={14} /> Same as last
                  </button>
                )}
```

- [ ] **Step 2: Mobile action row**

In the mobile expanded body, add the same button right before the "Save count" button (line 2380). Insert:

```tsx
                {line.noMovement && line.countedQty === null && (
                  <button
                    onClick={() => confirmSameAsLast(line)}
                    className="w-full h-12 border border-gold bg-gold-soft text-gold-2 rounded-[12px] font-semibold text-[15px] flex items-center justify-center gap-2 mt-4"
                  >
                    <Copy size={17} /> Same as last
                  </button>
                )}
```

- [ ] **Step 3: Ensure the `Copy` icon is imported**

Check the lucide-react import block near the top of the file. If `Copy` is not already imported, add it to the existing `import { ... } from 'lucide-react'` list.

Run: `grep -n "from 'lucide-react'" src/app/count/page.tsx` then confirm `Copy` is in the list; if absent, add it.

- [ ] **Step 4: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Manual check — per-line button**

With the dev server running: open a session, expand a line that has `noMovement: true`. Confirm the "Same as last" button shows. Tap it → the line becomes counted with 0 variance, and the next uncounted line auto-opens. Expand a line with `noMovement: false` → the button is absent.

- [ ] **Step 6: Commit**

```bash
git add src/app/count/page.tsx
git commit -m "feat(count): per-line Same-as-last button (mobile + desktop)"
```

---

## Task 7: Client — "No movement" filter toggle

**Files:**
- Modify: `src/app/count/page.tsx`

Place a single toggle just below the shared search bar so it serves both renderers.

- [ ] **Step 1: Add the filter toggle below the search bar**

Immediately after the search-bar closing `</div>` at line 2643 (before the `{/* ════ DESKTOP LAYOUT */}` comment at 2645), insert:

```tsx
        {/* ── No-movement (zero-velocity) filter ─────────────────────────────── */}
        {(active.lines?.some(l => l.noMovement && l.countedQty === null && !l.skipped) ?? false) && (
          <div className="-mx-4 sm:-mx-6 md:-mx-8 px-4 sm:px-6 md:px-8 py-2 flex items-center gap-2">
            <button
              onClick={() => {
                setStatusFilter(statusFilter === 'nomovement' ? 'all' : 'nomovement')
                setBulkSelected(new Set())
              }}
              className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-full font-mono text-[11px] font-medium border transition-colors ${
                statusFilter === 'nomovement'
                  ? 'border-gold bg-gold-soft text-gold-2'
                  : 'border-line text-ink-3 hover:border-line-2'
              }`}
            >
              <Copy size={12} /> No movement · {active.lines?.filter(l => l.noMovement && l.countedQty === null && !l.skipped).length ?? 0}
            </button>
            {statusFilter === 'nomovement' && (
              <span className="font-mono text-[10.5px] text-ink-4">items unchanged since last count</span>
            )}
          </div>
        )}
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Manual check — filter**

With the dev server running: in a session containing no-movement items, the "No movement · N" chip appears. Tap it → the list narrows to only uncounted no-movement items. Tap again → returns to all. In a session with no eligible items, the chip is absent.

- [ ] **Step 4: Commit**

```bash
git add src/app/count/page.tsx
git commit -m "feat(count): No-movement filter toggle"
```

---

## Task 8: Client — bulk multi-select + summary-confirm dialog

**Files:**
- Modify: `src/app/count/page.tsx`

When the No-movement filter is active, each eligible card shows a selection checkbox, and a sticky bar offers "Confirm all unchanged" with a summary dialog.

- [ ] **Step 1: Add the selection checkbox to the desktop uncounted header**

In the desktop uncounted/open header row (the `<div className="flex items-center gap-3 px-4 py-3 cursor-pointer">` at line 1992), add — as the FIRST child, before `<Circle .../>` (line 1995):

```tsx
            {statusFilter === 'nomovement' && line.noMovement && line.countedQty === null && (
              <button
                onClick={e => { e.stopPropagation(); toggleBulk(line.id) }}
                className="shrink-0"
                title="Select for bulk confirm"
              >
                {bulkSelected.has(line.id)
                  ? <CheckSquare size={18} className="text-gold-2" />
                  : <Square size={18} className="text-line-2" />}
              </button>
            )}
```

- [ ] **Step 2: Add the selection checkbox to the mobile uncounted header**

The mobile uncounted card header is the equivalent row inside the mobile `renderLine`. Locate the mobile uncounted card's header `<div>` (the row rendering the item name + chevron, near line 2255-2266, inside the mobile renderer). Add the same checkbox as its first child:

```tsx
            {statusFilter === 'nomovement' && line.noMovement && line.countedQty === null && (
              <button
                onClick={e => { e.stopPropagation(); toggleBulk(line.id) }}
                className="shrink-0"
                title="Select for bulk confirm"
              >
                {bulkSelected.has(line.id)
                  ? <CheckSquare size={20} className="text-gold-2" />
                  : <Square size={20} className="text-line-2" />}
              </button>
            )}
```

> If the exact mobile header element is ambiguous, place this immediately inside the outermost clickable header `<div>` of the mobile uncounted branch so it renders at the left edge of the card.

- [ ] **Step 3: Add the sticky bulk action bar**

Inside the filter block added in Task 7, after the toggle row (i.e. add a second block right after the closing `)}` of the Task-7 insertion, still before the DESKTOP LAYOUT comment), insert the sticky bar:

```tsx
        {statusFilter === 'nomovement' && bulkEligible.length > 0 && (
          <div className="sticky bottom-0 z-20 -mx-4 sm:-mx-6 md:-mx-8 px-4 sm:px-6 md:px-8 py-3 bg-paper border-t border-line flex items-center gap-3">
            <button
              onClick={bulkSelected.size === bulkEligible.length ? bulkSelectNone : bulkSelectAll}
              className="font-mono text-[11px] text-ink-3 hover:text-ink-2 underline underline-offset-2"
            >
              {bulkSelected.size === bulkEligible.length ? 'Select none' : `Select all ${bulkEligible.length}`}
            </button>
            <div className="flex-1" />
            <button
              disabled={bulkSelected.size === 0}
              onClick={() => setShowBulkConfirm(true)}
              className="inline-flex items-center gap-1.5 px-4 h-10 bg-ink text-paper rounded-[10px] font-medium text-[13px] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-ink-2 transition-colors"
            >
              <Copy size={14} className="text-gold" /> Confirm {bulkSelected.size || ''} unchanged
            </button>
          </div>
        )}
```

- [ ] **Step 4: Add the summary-confirm dialog**

Add this dialog near the other modals in the count view (e.g. immediately before the Add-item modal JSX, or any top-level modal group). It is self-contained and reads only state defined in Task 5:

```tsx
        {showBulkConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="fixed inset-0 bg-black/40" onClick={() => !bulkBusy && setShowBulkConfirm(false)} />
            <div className="relative bg-paper w-full max-w-sm rounded-2xl border border-line p-5 shadow-xl">
              <h3 className="text-[15px] font-semibold text-ink">Confirm unchanged</h3>
              <p className="text-[13px] text-ink-2 mt-2 leading-relaxed">
                Record <b>{bulkSelected.size}</b> item{bulkSelected.size === 1 ? '' : 's'} as unchanged
                since the last count — total value{' '}
                <b className="font-mono">{formatCurrency(bulkSelectedValue())}</b>.
              </p>
              <p className="font-mono text-[10.5px] text-ink-4 mt-2">
                These will be flagged as carried-forward, not physically counted.
              </p>
              <div className="flex gap-2 mt-5">
                <button
                  disabled={bulkBusy}
                  onClick={() => setShowBulkConfirm(false)}
                  className="flex-1 h-11 border border-line rounded-[10px] text-[13px] text-ink-2 font-medium disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  disabled={bulkBusy}
                  onClick={runBulkConfirm}
                  className="flex-1 h-11 bg-ink text-paper rounded-[10px] text-[13px] font-medium disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  {bulkBusy ? 'Confirming…' : <><Check size={15} className="text-gold" /> Confirm</>}
                </button>
              </div>
            </div>
          </div>
        )}
```

- [ ] **Step 5: Ensure `CheckSquare` and `Square` icons are imported**

Run: `grep -n "from 'lucide-react'" src/app/count/page.tsx` and confirm `CheckSquare` and `Square` are imported; add any that are missing to the lucide import list. (`Check`, `Copy` were added/confirmed earlier; `formatCurrency` is already used in this file.)

- [ ] **Step 6: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 7: Manual check — bulk flow**

With the dev server running: activate the No-movement filter. Confirm each eligible card shows a checkbox. Tap "Select all N" → all check. Tap "Confirm N unchanged" → dialog shows the right count and a plausible total value. Confirm → all selected lines become counted with 0 variance and the selection clears. Re-open the filter → those lines no longer appear (now counted).

- [ ] **Step 8: Commit**

```bash
git add src/app/count/page.tsx
git commit -m "feat(count): bulk multi-select + summary-confirm for Same-as-last"
```

---

## Task 9: Client — carried-forward badge on counted lines

**Files:**
- Modify: `src/app/count/page.tsx`

- [ ] **Step 1: Badge on the desktop counted-collapsed card**

In the desktop counted-collapsed card (lines 1945-1977), inside the mono detail row (the `<div className="font-mono text-[11px] text-ink-3 mt-0.5 flex items-center gap-1.5">` at line 1958), add at the end of that row, after the `lastQty` span (line 1963):

```tsx
                  {line.carriedForward && (
                    <span className="px-1.5 py-0.5 rounded-[5px] bg-gold-soft text-gold-2 text-[9.5px] font-medium tracking-wide">carried</span>
                  )}
```

- [ ] **Step 2: Badge on the mobile counted card**

In the mobile counted card's detail/sub line (the row that renders `Number(line.countedQty)` + variance for a counted line — near the mobile counted branch around line 2213-2266), add the same badge span next to the counted quantity:

```tsx
                  {line.carriedForward && (
                    <span className="px-1.5 py-0.5 rounded-[5px] bg-gold-soft text-gold-2 text-[9.5px] font-medium tracking-wide">carried</span>
                  )}
```

> Place it within the existing counted-state sub-row so it sits beside the quantity/variance text.

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Manual check — badge**

With the dev server running: after confirming an item via "Same as last" (single or bulk), its counted card shows a small gold "carried" badge. An item counted by typing a quantity does NOT show the badge.

- [ ] **Step 5: Commit**

```bash
git add src/app/count/page.tsx
git commit -m "feat(count): carried-forward badge on counted lines"
```

---

## Task 10: Full build + end-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Clean build**

Stop the dev server. Run: `npm run build`
Expected: PASS with no type errors. Confirm the count API routes still show `ƒ (Dynamic)` in the build output (not `○ (Static)`).

- [ ] **Step 2: End-to-end flow in the app**

Start `npm run dev` and walk the full path:
1. Create a full count → some lines are `noMovement`.
2. No-movement filter chip shows with the right count; activating it narrows the list.
3. Per-line "Same as last" records an eligible line at 0 variance with the "carried" badge.
4. Bulk: select all → "Confirm N unchanged" → summary dialog shows correct count + total value → confirm commits all with badges.
5. A never-counted item and a recently-moved item are NOT eligible (no button, excluded from filter).
6. Offline: with the filter active, throttle network to Offline in devtools, run a bulk confirm → lines show as counted locally; restore network → queue flushes, counts persist with `carriedForward` (re-fetch the session and confirm).
7. Finalize the session → the valuation total includes the carried lines.

- [ ] **Step 3: Commit any final touch-ups**

If steps surfaced small fixes, commit them:
```bash
git add -A
git commit -m "fix(count): polish Same-as-last flow from manual verification"
```

> Avoid `git add -A` if iCloud dup files ("name 2.tsx") are present (see memory). Prefer explicit paths.

---

## Self-review notes (author)

- **Spec coverage:** eligibility (Task 2) · recording via confirmLine (Task 5) · schema flags (Task 1) · filter (Task 7) · per-line button (Task 6) · bulk + summary dialog (Task 8) · traceability badge (Task 9). All spec sections map to a task.
- **GET route:** intentionally unchanged — new scalar columns flow through the `...l` spread (Task 3 Step 5 verifies).
- **Out of scope (per spec):** no staleness warning, no cadence config, no auto-deactivation, no /reports analytics changes — the carried badge lives on the count line displays.
- **Type consistency:** `confirmSameAsLast`, `bulkEligible`, `bulkSelected`, `runBulkConfirm`, `toggleBulk`, `bulkSelectAll`, `bulkSelectNone`, `bulkSelectedValue` are all defined in Task 5 and consumed in Tasks 6-8 under the same names. `carried`/`carriedForward` naming: client/queue use `carried`; API body + DB column use `carriedForward` (mapped at the fetch boundary in Task 5e and Task 4).
