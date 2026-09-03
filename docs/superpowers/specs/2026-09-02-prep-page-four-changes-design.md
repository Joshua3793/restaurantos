# Prep page — four changes

**Date:** 2026-09-02
**Surfaces:** `/prep` (To Do run sheet, Smart Prep planner, item drawer)

Four independent changes to the prep page, specified together because they land in
the same files. Each can be built and verified on its own.

1. The **Working On** band becomes a one-line list row instead of horizontal-scroll cards.
2. A To Do row gets an **instant remove** — off the kitchen's list without the
   Smart-Prep → remove → re-post round trip.
3. **Smart Prep works offline** — fill, modify and post all survive a dead zone, and
   the prep items are visible whatever the network is doing.
4. The **upscale bar** gets ± stepper buttons at 0.25× per press.

---

## 1 · Working On becomes a one-line row

### Today

`RunSheet.tsx:345` and `RunSheetMobile.tsx:271` render a `GroupHead "Working On"`
followed by `InProgressRail` / `InProgressRailMobile` — a horizontally scrolling
strip of 300px (desktop) / 228px (mobile) cards, one per item whose
`todayLog.status === 'IN_PROGRESS'`.

The band is already positioned above the ladder, so it already sits above **Late to
start** (Time grouping) and **Critical-Start Service** (Priority grouping). Position
does not change. Only the row format does.

### Change

Replace the rail with a stacked list of full-width rows built on the same grid the
ladder rows use, so the band reads as part of the list rather than as a separate
widget.

**Desktop — new `src/components/prep/runsheet/WorkingRow.tsx`**

Same grid as `RunRow`: `grid-cols-[64px_minmax(0,1fr)]` stacking to
`lg:grid-cols-[64px_minmax(0,1fr)_auto]`. Gold contrast in place of paper:
`bg-gold-soft`, `border-[#fcd34d]`, `border-l-[3px] border-l-gold`.

| Column | Content |
|---|---|
| 64px | Live timer in place of start-by: `18m` (mono, semibold) over `~25m to go`, or `over by 8m` in `text-red-text` when the runway is blown. Pulsing gold dot. |
| 1fr | Flame badge · name (click → `onOpenRecipe`) · below it the qty/batch label + `StationTag` |
| auto | `AssigneeChip` with `ClaimPopover` · Recipe icon button · **Stop** (ghost) · **Done** (dark, primary) |

Timer maths is unchanged from `InProgressRail`: `minutesBetween(startedAt, nowMs)`
for elapsed, `(activeMinutes + passiveMinutes) - elapsed` for remaining, formatted
with `fmtMins`.

Inheriting RunRow's `lg:` stacking is deliberate — below `lg` (iPad portrait, and
landscape before the sidebar docks) the action cluster drops to a second line rather
than squeezing the name column, which is the rule the ladder rows already follow.

**Mobile — new `src/components/prep/runsheet/WorkingRowMobile.tsx`**

Mirrors `RunRowMobile`: 44px timer column, `flex-1` name + meta line with the
`AssigneeChip` riding the meta line, then the action buttons.

`RunRowMobile` carries one 44px action button (Start). The working row needs two —
**Stop** (ghost) and **Done** (dark). There is no room for a fourth. Recipe opens by
tapping the name, which is already the recipe-open target on `RunRowMobile`. This is
an accepted tradeoff, not an omission.

**Deletions:** `InProgressRail.tsx` and `InProgressRailMobile.tsx` are removed. No
other file imports them (`PrepDoneSheet.tsx:8` and `NextUpHero.tsx:12` mention them
only in comments — update those comments).

### Acceptance

- Starting a prep moves it into a full-width gold row directly under the
  `Working On` group head, above the first ladder group in every grouping mode.
- The row carries Claim, Recipe, Stop and Done, and all four do what they did on the card.
- The elapsed / remaining timer keeps ticking (`useNowMinute` already drives `nowMs`).
- Two or more in-progress items stack vertically; nothing scrolls sideways.
- Below `lg`, the row stacks instead of truncating the name.

---

## 2 · Instant remove from To Do

### Today

Getting a job off the kitchen's list means: go to Smart Prep → remove from the draft
→ re-post. Three surfaces for one intent.

`handleToggleOnList(id, false)` alone does not do it. `todayItems`
(`src/app/prep/page.tsx:379`) keeps any row whose `todayLog.postedAt != null`, so an
item that was posted stays on To Do no matter what `isOnList` says.

### Change

An `×` button in the row's action cluster, left of the recipe button, on `RunRow` and
`RunRowMobile`.

**Not on a Working On row.** A job in flight is Stopped first, then removed. Keeps
the destructive action away from an item someone is standing over.

**New route: `POST /api/prep/plan/remove-item`**

```
body: { revenueCenterId, prepItemId, restore?: boolean, isOnList?: boolean }
```

- `requireSession('LEAD')` then `assertRcWritable(user, revenueCenterId)`. Removing an
  item from the kitchen's list is a plan edit, the same class as posting and as the
  `editsPlan` fields in `PUT /api/prep/logs/[id]`.
- Default (`restore` absent/false): in one transaction, clear `postedAt` on
  `{ revenueCenterId, prepItemId, ...postedOpenWhere }`, and set `isOnList: false` on
  the `PrepItem`. That is the exact end state the remove-then-re-post round trip
  produces today — and it matches what `POST /api/prep/plan/post` already does to
  items `notIn draftIds`.
- `restore: true`: resolve the item's live log with
  `ensureLiveLogs([prepItemId], revenueCenterId)` and stamp `postedAt: new Date()` on
  it, then set `isOnList` to the value in the body. **Not** `postedOpenWhere` — that
  fragment requires `postedAt: { not: null }` and so cannot find the row the removal
  just cleared. `ensureLiveLogs` is also what keeps the one-live-log-per-item
  invariant, and is the same primitive the post route uses.
- **`isOnList` is carried by the caller, not hardcoded to `true`.** Being on the
  kitchen's To Do is `PrepLog.postedAt`; `isOnList` is the separate Smart Prep DRAFT
  flag, and the two diverge routinely — post the list, then take the item off the
  draft, and the post goes `dirty` while the item stays posted with `isOnList`
  ALREADY false. Restoring `true` there would put a row the chef deliberately dropped
  back into the draft. The route cannot read the prior value (the removal was a
  separate request that already cleared it), so `handleRemoveFromToDo` captures
  `item.isOnList` before its optimistic patch and threads it into the Undo call, the
  same way it threads `headerWasAdjusted` — `usePrepToast` stores the Undo's
  `onClick` verbatim and fires it later from a closure frozen at removal time, so
  nothing can be recomputed at Undo time. The offline queue carries the same value on
  its `remove_item` entry. Omitted means `true`: the common case (posted AND on the
  draft), and the safe direction — an item wrongly ON the draft is visible to the
  chef and keeps its posted row through the next Post, whereas one wrongly OFF it is
  silently dropped by the next Post, which clears `postedAt` for everything
  `notIn draftIds`. (Which is also why "just leave `isOnList` alone on a restore" is
  not the fix.) Ignored on the removal path, which always clears the flag.
- **Keeps the `PrepPost` header honest.** `PostedBand` renders
  `{itemCount} items · {activeMinutes} hands-on`, so a removal that left them alone
  would make the band lie. Look up the header with `livePost(revenueCenterId)`; when
  one exists, decrement `itemCount` by 1 and subtract this item's minutes
  (`resolveActive(item) ?? estimatedPrepTime ?? 0` — the same expression the post
  route sums), both floored at 0. `restore` adds them back. The header row is never
  deleted: other items are still posted, and emptying the list entirely is what
  Recall is for.
- **Does not** call `markPlanDirty`. The removal is already reflected on the line —
  flagging the post as stale would be wrong.
- **No inventory write.** No `PrepLog` status change, no theoretical-stock
  invalidation, no `InventoryTransaction`. The prep simply is not on today's list.
- `export const dynamic = 'force-dynamic'`.

**Client:** `handleRemoveFromToDo(item)` in `src/app/prep/page.tsx` bumps
`mutationSeq`, optimistically sets `todayLog.postedAt = null` and `isOnList = false`
on that item, calls the route, and raises a toast with an Undo action that calls the
same route with `restore: true` plus the `isOnList` the item had before the patch.
The optimistic patch on the restore direction uses that same carried value — not
`true`.

**Role gate:** the `×` renders only when the page's existing `canPlan` is true
(LEAD+, writable RC, not read-only). STAFF never sees it.

**`usePrepToast` change:** `toast()` gains an optional second argument
`{ label, onClick }`. When present the toast renders a trailing action button and
holds for 6s instead of 2.6s; clicking it fires `onClick` and dismisses. Existing
single-argument callers are unaffected.

### Acceptance

- One tap on `×` takes the row off To Do immediately, no modal.
- A toast offers Undo; taking it puts the row back where it was.
- The item is back in Smart Prep's suggestions pane, re-addable, with no log status
  change and no stock movement.
- The posted band does not gain a "dirty / unposted changes" flag from a removal, and
  its item count and hands-on total drop to match the shortened list.
- A STAFF session sees no `×`.

---

## 3 · Smart Prep offline

### Today

`src/lib/prep-offline.ts` caches items in `localStorage` (`prep_items_v1`) and queues
three mutation types (`prep_queue_v1`): `isOnList_toggle`, `status`, `priority`.
`flushQueue` replays them on reconnect, deduping to the last mutation per item per type.

Three gaps:

1. `handleDraftEdit` (`src/app/prep/page.tsx:840`) bails —
   `if (!navigator.onLine) { markSaving(item.id, false); return } // planner edits are online-only`.
   The optimistic update paints, then dies on reload and never reaches the server.
2. `handlePost` is not queued at all and needs `data.post.postedAt` from the response.
3. `savePrepCache` runs only after a successful fetch, and `loadPrepCache` is consulted
   only when `!navigator.onLine`. A flaky-signal fetch failure while the browser still
   reports itself online falls through to `setItems([])` — a blank list. A cold load
   spins even when a good cache exists.

### Change

**Queue: three new mutation types.**

```ts
type: 'isOnList_toggle' | 'status' | 'priority'
    | 'draft_edit'   // { itemId, logId, revenueCenterId, patch: {requiredQty?, note?, assignedTo?, listOrder?} }
    | 'post'         // { revenueCenterId }
    | 'remove_item'  // { itemId, revenueCenterId, restore?: boolean, isOnList?: boolean }
```

**Dedup — `draft_edit` merges, it does not replace.** The existing rule (keep the last
mutation per item per type) is wrong for draft edits: setting a qty and then a note
would drop the qty. `draft_edit` entries for one item collapse into a single mutation
whose `patch` is the shallow merge of every patch in enqueue order — last write wins
per *field*, not per mutation. The merged entry takes the position of the item's
first `draft_edit` so relative order against a later `post` is preserved.

`post` and `remove_item` are **not** deduped against each other by item; `post` dedupes
to the last one per `revenueCenterId`.

**Flush order.** `deduplicateQueue` already preserves the relative order of survivors.
That is the whole guarantee needed: a `post` enqueued after the draft edits it depends
on flushes after them, so the server builds the post from a draft that is already
correct. No phase machinery.

**Shared `ensureLogId(m)`.** The `status` flush path already creates a `PrepLog` when
`logId` is missing or `_opt_`-prefixed. `draft_edit` needs the same thing. Factor it
into one helper used by both; `POST /api/prep/logs` is an upsert on
`(prepItem, day)` and accepts the draft fields directly, so a create can carry the
merged patch in the same request.

**Client — `src/app/prep/page.tsx`:**

- `handleDraftEdit`: replace the offline bail with
  `enqueueMutation({ type: 'draft_edit', ... })` + `setPendingCount(n => n + 1)`.
- `handlePost`: when offline, stamp `postedAt` with `new Date().toISOString()`
  locally, set `plan.post` to a locally-built header carrying `pending: true`, enqueue,
  and toast "Posted — will sync when back online". The existing offline banner already
  reports "N changes pending".
- `handleRemoveFromToDo`: enqueues `remove_item` when offline.
- `savePrepCache(items)` fires after **every** optimistic mutation, not only after a
  successful fetch — this is what makes an edit survive a reload in a dead zone.
- New `prep_plan_v1` cache for `plan.post`, written by `loadPlan` and by the optimistic
  post, read on mount, so `PostedBand` and the dirty pill render offline.

**Cache-first paint and unconditional fallback — `load()`:**

- On mount, read `loadPrepCache()` and render it before the fetch resolves, with
  `cacheAge` set. No spinner when a cache exists.
- On **any** fetch failure or timeout — not just `!navigator.onLine` — fall back to the
  cache and keep it on screen with its age stamp. Remove the `setItems([])` blanking
  path. The list is never empty because of the network.
- A successful fetch replaces the cached render and clears `cacheAge` as it does now.
  The `mutationSeq` stale-snapshot guard is unchanged and still applies.

**Role and scope checks are unchanged.** They run server-side at flush time. A queued
mutation from a session that has since lost write access to the RC fails at flush and
is counted in `result.failed`, which the existing banner already surfaces.

### Known risk (document in code)

A post queued at 06:00 and replayed at 14:00 posts a list sized against morning stock.
The queued draft edits replay first, so the quantities are the chef's own numbers
rather than stale suggestions — but the stock evidence behind those numbers is as old
as the queue. Accepted: the alternative is losing the chef's work.

### Acceptance

- With the network killed: add an item to the draft, change its qty, add a note,
  assign a cook, reload the page — every edit is still there.
- Post while offline: the To Do fills, the banner shows pending changes.
- Reconnect: the queue flushes in order, the server's draft matches what was edited,
  and the post lands with the right quantities.
- Kill the network mid-session without the browser firing an `offline` event (throttle
  to a failing profile): the item list stays on screen instead of blanking.
- Cold load with a warm cache paints items immediately, no spinner.

---

## 4 · ± steppers on the upscale bar

### Today

`src/components/prep/PrepRecipeSection.tsx:263` — a bare `<input type="range">`,
`min={SLIDER_MIN} (0.25)`, `max={SLIDER_MAX} (5)`, `step={0.25}`. Drag only. This is
the cook-along scale control used by `PrepDrawer` and `PrepBoardDrawer`.

### Change

A `−` and a `+` round button flanking the slider, styled like the pair
`RecipeViewModal.tsx:126` already uses (`w-8 h-8 rounded-full border border-gold/30
bg-white`, gold glyph, `disabled:opacity-40`).

Each press moves the factor one 0.25 step within `[SLIDER_MIN, SLIDER_MAX]` and calls
`onMakeQtyChange(nextFactor * baseInUnit)` — the same conversion the slider's
`onChange` uses, so `makeQty` stays in the prep item's unit.

**Snap to grid, don't add.** `factor` is derived (`makeQty / baseInUnit`) and can sit
off-grid at 1.13×. `+` goes to `Math.floor(f * 4 + 1) / 4` and `−` to
`Math.ceil(f * 4 - 1) / 4`, clamped — so a press always moves, and always lands on a
quarter.

Buttons are disabled at each bound.

`RecipeViewModal`'s own steppers (step 0.5, min 0.5) are a different surface and are
**left alone**.

### Acceptance

- `+` and `−` flank the slider and move the yield by exactly 0.25× of base per press.
- Pressing from an off-grid factor snaps to the neighbouring quarter.
- Disabled at 0.25× and at 5×.
- The slider, the `{qty} {unit}` readout, the `×N.NN of base` caption and the batch
  cost all stay in sync — they already derive from `makeQty`.

---

## Testing

- **`npm test`** — new `src/lib/__tests__/prep-offline.test.ts`, following the
  `count-offline.test.ts` precedent: `draft_edit` patch merging (qty then note keeps
  both), merged-entry ordering against a later `post`, `post` dedup per RC,
  `ensureLogId` behaviour for `_opt_` ids, and the existing three types' dedup
  unregressed.
- **`npm run build`** — types, and confirm `/api/prep/plan/remove-item` reports
  `ƒ (Dynamic)`.
- **Browser** — the three UI changes, then a devtools-offline pass:
  fill → modify → reload → post → reconnect → verify server state.
