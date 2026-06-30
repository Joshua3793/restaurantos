# UI Staleness — Optimistic Updates & Transient States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every drawer/modal/sheet action reflect its change in the list/page *immediately* — never leave a row stale until a reload or a delayed background poll.

**Architecture:** Apply one of three repair patterns at each mutation site, following the codebase's existing conventions (the recipe-ingredient handlers and the count offline queue already do this well — they are the reference patterns):
1. **Optimistic row-status update** for status-transition actions (approve, retry/process, finalize, toggle active, deactivate, primary-offer). Set the target/transient status in local list state *synchronously, before or independent of the refetch*; the existing refetch stays as reconciliation. For invoices this also engages the fast 3s poll.
2. **Optimistic list mutation** for create/edit/delete/pull/par-save in list pages. Insert/replace/remove the row in local state immediately (or `await` the refetch *before* closing the modal so the list is never shown stale).
3. **Transient affordance** ("Saving…", "Deleting…", dimmed row) where neither (1) nor (2) fully covers the in-flight window, so the user always sees that their action was received.

**Tech Stack:** Next.js 14 App Router · TypeScript · React (`'use client'` pages) · Prisma. **No test suite exists** — `npm run build` is the only automated check (CLAUDE.md). Each task is verified by `npm run build` + manual preview verification of the specific interaction. Where a task says "verify in preview", use the `preview_*` tools (start server, perform the action, snapshot the row state).

---

## Conventions for every task in this plan

- **Optimistic-then-reconcile, never optimistic-only.** Always keep the existing `fetch...()`/`load()` refetch call *after* the optimistic mutation. The optimistic write makes the UI instant; the refetch corrects it against the server. On error, roll back (restore previous state) or refetch.
- **Prisma Decimals are strings** in API JSON — wrap with `Number()` before arithmetic (CLAUDE.md). Optimistic objects you build locally must match the shape the API returns.
- **Define sub-components at module scope** (CLAUDE.md) — do not introduce inline components inside a render body.
- **Commit after each task** with a focused message.
- Before editing a file, **Read it** to confirm the current code matches the snippet quoted here (line numbers drift; these were captured 2026-06-30).

---

## Priority tiers

- **P0 — the reported bug:** Task 1 (invoice approve), Task 2 (invoice retry/process).
- **P1 — rows visibly look broken/unchanged after action:** Tasks 3–8 (sales, wastage, inventory edit, RC pull/par, primary offer, recipe/menu toggle + bulk).
- **P2 — polish / missing transient feedback:** Tasks 9–13 (prep mark-done & status transient, recipe rename/substitute, settings role/deactivate transient, count finalize error surfacing, delete transient states).

Execute in order; each task is independently shippable.

---

## File Structure

No new files. All changes are localized edits to existing client components and their parent pages:

| File | Responsibility for this work |
|---|---|
| `src/app/invoices/page.tsx` | Owns `sessions` list state + poll; receives optimistic patches |
| `src/components/invoices/v2/InvoiceReviewDrawer.tsx` | Emits optimistic patch on approve/reject |
| `src/components/invoices/InvoiceListV2.tsx` | Optimistic bulk-delete dim/remove |
| `src/app/sales/page.tsx` | Await refetch before closing save/import modals |
| `src/app/wastage/page.tsx` | Transient state + await refetch before close |
| `src/components/inventory/InventoryItemDrawer.tsx` | Emit edited item to parent for optimistic list patch |
| `src/app/inventory/page.tsx` | Apply optimistic item patch to `items` |
| `src/components/inventory/RcAllocationPanel.tsx` | Optimistic qty/par after pull/save |
| `src/components/inventory/SupplierOffersSection.tsx` | Optimistic primary-star + saving state |
| `src/app/recipes/page.tsx`, `src/app/menu/page.tsx` | Optimistic toggle + bulk deactivate/delete |
| `src/components/recipes/shared.tsx` | Optimistic recipe rename + substitute cost-pending state |
| `src/app/prep/page.tsx`, `src/components/prep/PrepDoneSheet.tsx` | Transient "saving" affordance on status changes |
| `src/app/setup/users/page.tsx` | Transient state on role change / deactivate |
| `src/app/count/page.tsx` | Surface finalize failure instead of silent revert |

---

## P0 — Reported Bug

### Task 1: Invoice approve — optimistic `APPROVING` row status

**Root cause (verified):** `handleApprove` (drawer) → `onApproveOrReject()` → `handleApproveOrReject` (page) calls `fetchSessions()` immediately. That refetch frequently lands before the server commits `status='APPROVING'`, so the list shows `REVIEW`. Because `REVIEW` is not in the transient set (`page.tsx:137-139`), the poll falls back to **15s** — the row never shows `APPROVING` and jumps straight to gone. Fix: write `APPROVING` into local list state synchronously, which both shows the badge instantly *and* makes `hasTransient` true → engages the 3s poll.

**Files:**
- Modify: `src/components/invoices/v2/InvoiceReviewDrawer.tsx:721-723` (and the `onApproveOrReject` prop type, ~line 22 area of the component's props interface)
- Modify: `src/app/invoices/page.tsx:156-159` (`handleApproveOrReject`)

- [ ] **Step 1: Widen the `onApproveOrReject` prop to accept an optional optimistic patch**

In `InvoiceReviewDrawer.tsx`, find the props interface declaring `onApproveOrReject: () => void` and change it to:

```typescript
onApproveOrReject: (optimistic?: { id: string; status: SessionStatus }) => void
```

Ensure `SessionStatus` is imported in this file (it comes from `@/components/invoices/types`). Add to the existing type import if missing:

```typescript
import { SessionSummary, SessionStatus } from '@/components/invoices/types'
```

- [ ] **Step 2: Emit the optimistic `APPROVING` patch on successful approve**

In `InvoiceReviewDrawer.tsx`, replace the success block at lines 721-723:

```typescript
      setApproved(true)
      onApproveOrReject()
      if (result.queued) onClose()
```

with:

```typescript
      setApproved(true)
      // Optimistically flip the list row to APPROVING so the user sees the
      // transient state immediately AND the parent's fast (3s) poll engages.
      onApproveOrReject({ id: session.id, status: 'APPROVING' })
      if (result.queued) onClose()
```

- [ ] **Step 3: Apply the optimistic patch in the parent before refetching**

In `src/app/invoices/page.tsx`, replace `handleApproveOrReject` (lines 156-159):

```typescript
  const handleApproveOrReject = useCallback(() => {
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
  }, [fetchSessions])
```

with:

```typescript
  const handleApproveOrReject = useCallback((optimistic?: { id: string; status: SessionStatus }) => {
    if (optimistic) {
      setSessions(prev =>
        prev.map(s => (s.id === optimistic.id ? { ...s, status: optimistic.status } : s)),
      )
    }
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
  }, [fetchSessions])
```

(`SessionStatus` is already imported at `page.tsx:12`. `setSessions` already exists at `page.tsx:39`.)

- [ ] **Step 4: Confirm reject still compiles**

`handleReject` in the drawer calls `onApproveOrReject()` with no argument — the optional parameter keeps that valid. No change needed, but confirm it still type-checks.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS, no TypeScript errors. The `/invoices` route still shows `ƒ (Dynamic)`.

- [ ] **Step 6: Verify in preview**

Start the dev server, open `/invoices`, open a `REVIEW` invoice, click Approve & Post. Expected: the drawer closes and the list row shows an **"Approving"** badge immediately (not "Review"), then transitions to "Approved"/disappears within ~3s (fast poll). Snapshot to confirm the `APPROVING` badge renders.

- [ ] **Step 7: Commit**

```bash
git add src/components/invoices/v2/InvoiceReviewDrawer.tsx src/app/invoices/page.tsx
git commit -m "fix(invoices): optimistic APPROVING row status on approve (no more stale Review)"
```

---

### Task 2: Invoice retry/process — optimistic `PROCESSING` row status

**Problem:** `handleRetry` (page.tsx:190-193) fires the process POST without awaiting and immediately refetches; the row stays "Error" until the next poll (and `ERROR` isn't transient, so it's the 15s poll). No feedback that the retry was received.

**Files:**
- Modify: `src/app/invoices/page.tsx:190-193` (`handleRetry`)

- [ ] **Step 1: Optimistically set `PROCESSING` before firing the request**

Replace `handleRetry`:

```typescript
  const handleRetry = useCallback(async (id: string) => {
    fetch(`/api/invoices/sessions/${id}/process`, { method: 'POST' }).catch(() => {})
    await fetchSessions()
  }, [fetchSessions])
```

with:

```typescript
  const handleRetry = useCallback(async (id: string) => {
    // Show PROCESSING immediately; this also engages the fast (3s) poll so the
    // row updates promptly when OCR finishes, instead of waiting up to 15s.
    setSessions(prev => prev.map(s => (s.id === id ? { ...s, status: 'PROCESSING' } : s)))
    fetch(`/api/invoices/sessions/${id}/process`, { method: 'POST' }).catch(() => {})
    await fetchSessions()
  }, [fetchSessions])
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Verify in preview**

On `/invoices`, trigger Retry on an errored/processable session. Expected: row flips to "Processing" instantly; resolves to "Review" within a few seconds.

- [ ] **Step 4: Commit**

```bash
git add src/app/invoices/page.tsx
git commit -m "fix(invoices): optimistic PROCESSING status on retry"
```

---

## P1 — Rows Look Unchanged After Action

### Task 3: Sales — await refetch before closing save/import modals

**Problem:** `handleSave` (sales/page.tsx:987-996) and `handleImport` (1005-1010) close the modal (`setShowAdd(false)` / `setShowImport(false)`) without awaiting `fetchSales()`, so the list is stale for the refetch duration.

**Files:**
- Modify: `src/app/sales/page.tsx:987-996` and `:1005-1010`

- [ ] **Step 1: Read the two handlers** to confirm current shape, then reorder so the modal closes only after the refetch resolves.

For `handleSave`, ensure the structure is:

```typescript
  const handleSave = async (data: /* existing type */) => {
    // ...existing POST/PUT...
    await fetchSales()
    setShowAdd(false)
    setEditing(null) // if such state exists; keep existing close-up lines
  }
```

i.e. move every modal-closing `setShow…(false)` / `setEditing(null)` line to *after* `await fetchSales()`. Do not remove the `SaleForm`'s own "Saving…" button state — it already covers the in-flight window while the modal is still open.

- [ ] **Step 2: Apply the same reordering to `handleImport`** — `await fetchSales()` must complete before `setShowImport(false)`.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Verify in preview**

Add a manual sales day. Expected: the "Saving…" button stays until the new row is present, then the modal closes onto an already-updated list. No flash of stale/missing row.

- [ ] **Step 5: Commit**

```bash
git add src/app/sales/page.tsx
git commit -m "fix(sales): await refetch before closing save/import modal"
```

---

### Task 4: Wastage — transient state + await refetch before close

**Problem:** `handleAdd` (wastage/page.tsx:80-95) has no "Saving…" state and closes the modal before `fetchLogs()` resolves.

**Files:**
- Modify: `src/app/wastage/page.tsx:80-95` (handler) and the submit button in its modal

- [ ] **Step 1: Add a `saving` state and gate the submit**

At the top of the wastage page component, add:

```typescript
  const [saving, setSaving] = useState(false)
```

- [ ] **Step 2: Rework `handleAdd` to set saving, await refetch, then close**

Replace `handleAdd` with (preserve the existing field names and POST body — only the control flow changes):

```typescript
  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/wastage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(/* existing body */),
      })
      if (!res.ok) { /* keep existing error handling */ return }
      await fetchLogs()
      setShowAdd(false)
    } finally {
      setSaving(false)
    }
  }
```

- [ ] **Step 3: Reflect `saving` in the submit button**

Find the modal's submit `<button>` and set `disabled={saving}` and label `{saving ? 'Saving…' : 'Log wastage'}` (match the existing button text for the non-saving label).

- [ ] **Step 4: Build & verify in preview**

Run: `npm run build` → PASS. Then log a wastage entry in preview; confirm "Saving…" shows and the modal closes onto an updated list.

- [ ] **Step 5: Commit**

```bash
git add src/app/wastage/page.tsx
git commit -m "fix(wastage): saving state + await refetch before closing modal"
```

---

### Task 5: Inventory item edit — optimistic parent-list patch

**Problem:** `handleSave` in `InventoryItemDrawer.tsx:275-324` updates the drawer's own `item` and calls `onUpdated()`, but the parent `/inventory` list row stays stale until `fetchItems()` returns.

**Files:**
- Modify: `src/components/inventory/InventoryItemDrawer.tsx` (`onUpdated` prop + `handleSave`)
- Modify: `src/app/inventory/page.tsx` (the `onUpdated` callback passed to the drawer)

- [ ] **Step 1: Pass the updated item back through `onUpdated`**

In `InventoryItemDrawer.tsx`, locate the `onUpdated` prop type. If it is `onUpdated: () => void`, widen it to:

```typescript
onUpdated: (updatedItem?: InventoryItem) => void
```

(Use the drawer's existing item type — match whatever `normalizeItem(...)` returns / the `item` state type.)

In `handleSave`, where it currently does `setItem(normalizeItem({ ...item, ...updated, ... }))` then `onUpdated()`, capture the normalized object and pass it:

```typescript
      const next = normalizeItem({ ...item, ...updated /* keep existing spread */ })
      setItem(next)
      setEditMode(false)
      onUpdated(next)
```

- [ ] **Step 2: Apply the optimistic patch in the inventory page**

In `src/app/inventory/page.tsx`, find where `<InventoryItemDrawer onUpdated={...} />` is rendered. Change the callback to patch `items` before refetching:

```typescript
        onUpdated={(updatedItem) => {
          if (updatedItem) {
            setItems(prev => prev.map(i => (i.id === updatedItem.id ? { ...i, ...updatedItem } : i)))
          }
          fetchItems()
        }}
```

(Confirm the list state setter name — it may be `setItems`. Match the actual name used in this file.)

- [ ] **Step 3: Build & verify in preview**

Run: `npm run build` → PASS. Edit an item's price in preview; confirm the row in the table behind the drawer shows the new price immediately on save, before any visible refetch delay.

- [ ] **Step 4: Commit**

```bash
git add src/components/inventory/InventoryItemDrawer.tsx src/app/inventory/page.tsx
git commit -m "fix(inventory): optimistic list-row update after item edit"
```

---

### Task 6: RC allocation — optimistic qty after pull & par after save

**Problem:** `handlePull` (RcAllocationPanel.tsx:78-104) and `handleSavePar` (:117-141) only `loadData()`-refetch; the displayed allocation qty / par is stale until that returns.

**Files:**
- Modify: `src/components/inventory/RcAllocationPanel.tsx:78-104` and `:117-141`

- [ ] **Step 1: Optimistically adjust the allocation row on pull**

In `handlePull`, after the `if (!res.ok) { … return }` guard and before `loadData()`, patch the local allocations state. Using the panel's existing allocations state (confirm the setter name — referenced below as `setAllocations`):

```typescript
    const pulled = parseFloat(pullQty)
    setAllocations(prev =>
      prev.map(a => (a.rcId === rcId ? { ...a, quantity: Number(a.quantity) + pulled } : a)),
    )
    // ...existing form-clear lines...
    loadData()
    onPulled()
```

If the panel also displays a "Main Pool / unallocated" figure derived from a separate state value, decrement it by `pulled` here too so both sides move together. (Read the component to confirm whether the pool figure is local state or derived from `allocations`; only patch local state.)

- [ ] **Step 2: Optimistically update par/reorder on save**

In `handleSavePar`, before `loadData()`:

```typescript
    setAllocations(prev =>
      prev.map(a =>
        a.rcId === rcId
          ? { ...a, parLevel: parseFloat(editParLevel) || 0, reorderQty: parseFloat(editReorderQty) || 0 }
          : a,
      ),
    )
    setEditParRcId(null); setEditParLevel(''); setEditReorderQty('')
    loadData()
```

(Match the exact field names on the allocation object as returned by the API — `parLevel`, `reorderQty`. Wrap any Decimal-typed existing values with `Number()` before arithmetic.)

- [ ] **Step 3: Build & verify in preview**

Run: `npm run build` → PASS. Pull stock into an RC and edit a par level in preview; confirm the displayed numbers change instantly on submit.

- [ ] **Step 4: Commit**

```bash
git add src/components/inventory/RcAllocationPanel.tsx
git commit -m "fix(inventory): optimistic RC qty/par updates after pull & par-save"
```

---

### Task 7: Primary supplier offer — optimistic star + saving state

**Problem:** `setPrimary` (SupplierOffersSection.tsx:46-56) waits for `load()` before the star moves; no transient feedback.

**Files:**
- Modify: `src/components/inventory/SupplierOffersSection.tsx:46-56`

- [ ] **Step 1: Optimistically move the primary flag before refetch**

Replace `setPrimary`:

```typescript
  const setPrimary = async (offerId: string) => {
    setSaving(true)
    // Optimistically move the star so the click registers immediately.
    setOffers(prev => prev.map(o => ({ ...o, isPrimary: o.id === offerId })))
    const res = await fetch(`/api/inventory/${itemId}/suppliers`, {
      method: 'PATCH',
      body: JSON.stringify({ offerId }),
    })
    setSaving(false)
    load()
    if (res?.repriced) onRepriced?.()
  }
```

(Confirm the offers state setter name — referenced as `setOffers` — and that each offer object carries `id` and `isPrimary`. If the API response (`res`) needs `.json()` to read `repriced`, keep the existing parsing; only add the optimistic `setOffers` line.)

- [ ] **Step 2: Build & verify in preview**

Run: `npm run build` → PASS. On an item with ≥2 supplier offers, click the non-primary star; confirm it lights up instantly.

- [ ] **Step 3: Commit**

```bash
git add src/components/inventory/SupplierOffersSection.tsx
git commit -m "fix(inventory): optimistic primary-offer star selection"
```

---

### Task 8: Recipes & Menu — optimistic toggle + bulk deactivate/delete

**Problem:** `handleToggle` (recipes/page.tsx:99-102, menu/page.tsx:111-114) and the bulk handlers (recipes:136-155, menu:160-169) refetch the whole list without optimistic state — toggles look frozen and bulk-selected rows look unchanged for the refetch duration.

**Files:**
- Modify: `src/app/recipes/page.tsx:99-102, 136-155`
- Modify: `src/app/menu/page.tsx:111-114, 160-169`

- [ ] **Step 1: Optimistic single toggle (recipes)**

Replace `handleToggle`:

```typescript
  const handleToggle = async (id: string) => {
    setRecipes(prev => prev.map(r => (r.id === id ? { ...r, isActive: !r.isActive } : r)))
    await fetch(`/api/recipes/${id}/toggle`, { method: 'PATCH' })
    loadRecipes()
  }
```

(Confirm the list state setter — `setRecipes` — and that rows carry `isActive`. If `displayRecipes` is derived/filtered from `recipes`, patch the source state `recipes`, not the derived value.)

- [ ] **Step 2: Optimistic bulk deactivate/delete (recipes)**

In `handleBulkDeactivate`, before awaiting the requests, flip the selected active rows in local state:

```typescript
    const ids = new Set(toDeactivate.map(r => r.id))
    setRecipes(prev => prev.map(r => (ids.has(r.id) ? { ...r, isActive: false } : r)))
    setSelectedIds(new Set())
    setBulkConfirm(null)
    await Promise.all(toDeactivate.map(r => fetch(`/api/recipes/${r.id}/toggle`, { method: 'PATCH' })))
    await loadRecipes()
```

In `handleBulkDelete`, optimistically remove the rows:

```typescript
    const ids = new Set(/* selected ids being deleted */)
    setRecipes(prev => prev.filter(r => !ids.has(r.id)))
    setSelectedIds(new Set())
    setBulkConfirm(null)
    await Promise.all(/* existing DELETE calls */)
    await loadRecipes()
```

- [ ] **Step 3: Mirror Steps 1–2 in `src/app/menu/page.tsx`**

Apply the identical pattern to `handleToggle` (menu:111) and `handleBulkDelete` (menu:160) using the menu page's own list state setter (confirm name). The MENU page has no PREP linkage to worry about — same shape.

- [ ] **Step 4: Build & verify in preview**

Run: `npm run build` → PASS. Toggle a recipe and bulk-deactivate a couple; confirm switches/rows respond instantly.

- [ ] **Step 5: Commit**

```bash
git add src/app/recipes/page.tsx src/app/menu/page.tsx
git commit -m "fix(recipes,menu): optimistic toggle + bulk deactivate/delete"
```

---

## P2 — Polish / Missing Transient Feedback

### Task 9: Prep — transient "saving" affordance on status/priority/on-list changes

**Problem:** `handleStatusChange` (prep/page.tsx:428), `handlePriorityChange` (:510), `handleToggleOnList` (:550) apply optimistic updates (good) but show no in-flight indicator; `PrepDoneSheet` closes before the save resolves. If the save fails the value silently reverts via a full `load()`, surprising the user.

**Files:**
- Modify: `src/app/prep/page.tsx` (track in-flight item ids)
- Modify: `src/components/prep/PrepDoneSheet.tsx` (optional pending state on confirm)

- [ ] **Step 1: Track in-flight saves by item id**

At the top of the prep page component add:

```typescript
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
```

Add a helper:

```typescript
  const markSaving = (id: string, on: boolean) =>
    setSavingIds(prev => {
      const next = new Set(prev)
      if (on) next.add(id); else next.delete(id)
      return next
    })
```

- [ ] **Step 2: Wrap the three async handlers**

In `handleStatusChange`, `handlePriorityChange`, and `handleToggleOnList`, call `markSaving(itemId, true)` immediately after the optimistic update and `markSaving(itemId, false)` in a `finally` (or at the end of both success and error paths). Keep all existing optimistic + error-`load()` logic unchanged.

- [ ] **Step 3: Surface the indicator on the row**

In the row component(s) that render prep items (e.g. `PrepItemRow`), accept a `saving?: boolean` prop and render a small spinner / "Saving…" text or `opacity-60` while true. Pass `savingIds.has(item.id)` from the list render. Define any new sub-component at module scope.

- [ ] **Step 4: Build & verify in preview**

Run: `npm run build` → PASS. Mark a prep item done; confirm a brief "Saving…"/dimmed state on the row until the request resolves.

- [ ] **Step 5: Commit**

```bash
git add src/app/prep/page.tsx src/components/prep/PrepItemRow.tsx src/components/prep/PrepDoneSheet.tsx
git commit -m "feat(prep): transient saving indicator on status/priority/on-list changes"
```

---

### Task 10: Recipe rename + substitute — remove the stale/$0 window

**Problem:** `patchRecipe` (shared.tsx:940-952) waits for the server before the title changes; `substituteIngredient` (:1045-1079) shows `lineCost: 0` until the refetch.

**Files:**
- Modify: `src/components/recipes/shared.tsx:940-952, 1045-1079`

- [ ] **Step 1: Optimistic rename in `patchRecipe`**

Before the `await fetch(...)`, apply the patch optimistically, then reconcile with the server response:

```typescript
  const patchRecipe = async (data: Record<string, unknown>) => {
    setSaving(true)
    const snapshot = recipe
    setRecipe(prev => (prev ? { ...prev, ...data } : prev)) // optimistic
    try {
      const res = await fetch(`/api/recipes/${recipeId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      })
      if (res.ok) {
        const updated = await res.json()
        setRecipe(updated)
        dirtyRef.current = true
      } else {
        setRecipe(snapshot) // rollback
      }
    } catch {
      setRecipe(snapshot)
    } finally {
      setSaving(false)
    }
  }
```

(Confirm `recipe` state and `setRecipe` names match this file. `data` keys like `name`/`isActive` map directly onto the recipe object.)

- [ ] **Step 2: Show a "pending" cost instead of $0 on substitute**

In `substituteIngredient`, the optimistic branch sets `lineCost: 0`. Add a flag so the row can render "…" instead of "$0.00" while the real cost is fetched. Add `costPending: true` to the optimistically-substituted ingredient, and clear it after `await load()`. In the ingredient row renderer, show a muted "…" when `costPending` is set. (If adding a field to the ingredient type is too invasive, alternatively keep the previous `lineCost` value during the optimistic window rather than zeroing it — choose whichever is less invasive after reading the type.)

- [ ] **Step 3: Build & verify in preview**

Run: `npm run build` → PASS. Rename a recipe (title changes instantly) and substitute an ingredient (no `$0.00` flash).

- [ ] **Step 4: Commit**

```bash
git add src/components/recipes/shared.tsx
git commit -m "fix(recipes): optimistic rename + no \$0 flash on substitute"
```

---

### Task 11: Settings users — transient state on role change & deactivate

**Problem:** `handleRoleChange` (setup/users/page.tsx:311) and `handleDeactivate` (:325) are optimistic but show no in-flight feedback.

**Files:**
- Modify: `src/app/setup/users/page.tsx:311-333`

- [ ] **Step 1: Track the in-flight user id**

Add `const [busyUserId, setBusyUserId] = useState<string | null>(null)`. Set it at the start of `handleRoleChange`/`handleDeactivate` and clear it in a `finally`. Keep existing optimistic update + error-`loadUsers()` logic.

- [ ] **Step 2: Reflect it in the row**

Disable the role `<select>` and the Deactivate button for that row while `busyUserId === user.id`, and show a small spinner / "Saving…". 

- [ ] **Step 3: Build & verify in preview, then commit**

Run: `npm run build` → PASS. Change a role; confirm the control disables briefly.

```bash
git add src/app/setup/users/page.tsx
git commit -m "feat(settings): transient state on user role change & deactivate"
```

---

### Task 12: Count finalize — surface failure instead of silent revert

**Problem:** `handleFinalize` (count/page.tsx:901-945) marks the session `UPDATING`, navigates to the list, then finalizes fire-and-forget. On failure the status silently reverts to `PENDING_REVIEW` and the user, having navigated away, may never notice.

**Files:**
- Modify: `src/app/count/page.tsx:901-945`

- [ ] **Step 1: Add a visible failure path**

In the finalize failure branch (where it currently reverts status + `loadSessions()`), set a user-facing error banner/toast state (reuse the page's existing error state if present — search for `setActionError`/`setError` in this file) so the revert is accompanied by an explanation, e.g. `"Finalize failed — please retry."`. Keep the offline-queue/`loadSessions()` recovery logic intact.

- [ ] **Step 2: Build & verify**

Run: `npm run build` → PASS. (Hard to simulate finalize failure in preview without forcing a server error; verify the error state renders by temporarily throwing in the handler during local testing, then revert.)

- [ ] **Step 3: Commit**

```bash
git add src/app/count/page.tsx
git commit -m "fix(count): surface finalize failure instead of silent revert"
```

---

### Task 13: Optimistic dim/remove on delete (invoices bulk, count, prep, sales, recipes)

**Problem:** Single/bulk deletes keep the row at full opacity until the refetch returns (no interim feedback). Lowest severity — but a consistent "dimming then removal" affordance closes the loop.

**Files (pick per site; same pattern):**
- `src/components/invoices/InvoiceListV2.tsx:195-201` (bulk delete) + `src/app/invoices/page.tsx:172-188`
- `src/app/sales/page.tsx` (`handleDelete`), `src/app/count/page.tsx` (`handleDeleteSession`), `src/app/prep/page.tsx` (`handleDelete`)

- [ ] **Step 1: Optimistically remove on confirmed delete (invoices bulk example)**

In `src/app/invoices/page.tsx` `handleBulkDelete`, remove the rows from local state before/after the request resolves:

```typescript
  const handleBulkDelete = useCallback(async (ids: string[]): Promise<void> => {
    const idSet = new Set(ids)
    setSessions(prev => prev.filter(s => !idSet.has(s.id)))      // optimistic removal
    await fetch('/api/invoices/sessions', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
    })
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
    if (selectedSessionId && ids.includes(selectedSessionId)) setSelectedSessionId(null)
  }, [selectedSessionId, fetchSessions])
```

Apply the equivalent `setX(prev => prev.filter(...))` optimistic removal to `handleDelete` (single, page.tsx:172), sales `handleDelete`, count `handleDeleteSession`, and prep `handleDelete`. Keep the refetch as reconciliation; on a non-`res.ok` response, refetch to restore.

- [ ] **Step 2: Build & verify in preview, then commit**

Run: `npm run build` → PASS. Delete a row in each touched page; confirm it disappears instantly.

```bash
git add -A
git commit -m "fix: optimistic row removal on delete across invoices/sales/count/prep"
```

> Note on `git add -A`: the iCloud-sync gotcha (duplicate `name 2.ext` files) applies to `~/Desktop`, not this repo at `~/dev/fergies-os`. Still prefer staging explicit paths if unsure.

---

## Self-Review

**Spec coverage** — every staleness site found in the audit maps to a task:

| Audited issue | Task |
|---|---|
| Invoice approve stays "Review" (reported) | 1 |
| Invoice retry no feedback | 2 |
| Invoice bulk/single delete no interim | 13 |
| Sales save/import modal closes before refetch | 3 |
| Wastage no transient + early close | 4 |
| Inventory edit — parent list stale | 5 |
| RC pull / par-save stale | 6 |
| Primary-offer star stale | 7 |
| Recipe/Menu toggle + bulk stale | 8 |
| Prep status/priority/on-list no transient; done-sheet early close | 9 |
| Recipe rename stale; substitute $0 flash | 10 |
| Settings role/deactivate no transient | 11 |
| Count finalize silent failure | 12 |
| Count delete / sales delete / prep delete no interim | 13 |
| Recipe ingredient add/update/delete | *None needed — already optimistic (reference pattern)* |
| Count confirm/skip line | *None needed — already optimistic via offline queue* |
| Prep item form / settings / RC-CRUD / location-CRUD / invite | *None needed — already refetch + "Saving…"* |

**Placeholder scan:** Each task gives the exact transformation and the verification command. A few steps say "confirm the state setter name" — this is deliberate: line numbers/identifiers drift, and the executor must Read before editing (stated in Conventions). These are not placeholders for *logic*; the logic is fully specified.

**Type consistency:** `onApproveOrReject(optimistic?: { id, status: SessionStatus })` is defined in Task 1 Step 1 and consumed identically in Step 3. `setSessions`/`setRecipes`/`setItems`/`setAllocations`/`setOffers` are referenced as the existing list-state setters and flagged for confirmation per file. `markSaving`/`savingIds`/`busyUserId` are introduced and consumed within their own tasks.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-30-ui-staleness-optimistic-updates.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best here because each task is an isolated file edit + build + preview check.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach? (Or, if you'd rather, I can implement just P0 — Tasks 1 & 2, the reported invoice bug — first and you review before we continue.)**
