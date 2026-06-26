# Prep Tasks (checklist) — design

**Date:** 2026-06-25
**Status:** Approved design → ready for implementation plan

## Problem

Some kitchen prep work is not about producing a costed, inventory-tracked product
— it's about *processing* an existing ingredient (slicing cheese, portioning
salmon) or a standing duty. These don't fit the `PrepItem` model, which is always
anchored to a recipe and spawns a linked `InventoryItem` for costing.

Today the only way to surface such work on the prep board would be to create
zero-ingredient PREP recipes. That pollutes the Recipe Book, the inventory list,
recipe costing, smart-prep par math, and reports — all to get a checkbox.

## Goal

A **pure checklist** task system inside the prep page:

- No cost, no inventory movement, no par/threshold — done/not-done only.
- **RC-scoped**: each revenue center has its own task library and today's list.
- **On-demand**: a task library you pull from; tasks never auto-schedule.
- Minimal fields: **name + checkbox**, plus an optional read-only related ingredient.
- **Drag-reorderable** library.

## Non-goals (YAGNI)

- No station / assignee / due time / notes / blocked reason.
- No cost, no stock movement, no par, no smart-prep generation.
- No History-tab integration (tasks do not appear in History for v1).
- No multiple ingredients per task (single optional link only).
- The related-ingredient link is **read-only reference** — it never moves stock or cost.

## Why a separate model (not `PrepItem` overload)

The reason for rejecting fake recipes is to keep the cost spine clean. Adding a
`kind` discriminator to `PrepItem` re-opens that door: every reader of `PrepItem`
(costing, smart-prep, linked-`InventoryItem` sync, reports) would have to remember
to filter out task rows; one missed filter leaks a task into a COGS number.

A dedicated, tiny model makes the wall **structural** — there's no price, no recipe,
no linked-item-for-costing to forget to filter. Tasks cannot leak into cost /
inventory / reports by construction.

## Data model

```prisma
model PrepTask {
  id                    String         @id @default(uuid())
  name                  String
  revenueCenterId       String         // RC-bound: library is per-RC
  linkedInventoryItemId String?        // optional read-only related ingredient
  sortOrder             Int            @default(0)
  isActive              Boolean        @default(true)
  createdAt             DateTime       @default(now())
  updatedAt             DateTime       @updatedAt
  revenueCenter         RevenueCenter  @relation("PrepTaskRC", fields: [revenueCenterId], references: [id])
  linkedInventoryItem   InventoryItem? @relation("PrepTaskInventory", fields: [linkedInventoryItemId], references: [id])
  logs                  PrepTaskLog[]
}

model PrepTaskLog {
  id         String   @id @default(uuid())
  prepTaskId String
  logDate    DateTime
  createdAt  DateTime @default(now())
  prepTask   PrepTask @relation(fields: [prepTaskId], references: [id], onDelete: Cascade)

  @@unique([prepTaskId, logDate])
}
```

- `PrepTask` = the **library** entry (one RC). `PrepTaskLog` = "this task is on a given
  day's list" — pure membership. There is **no `done` column**: completing a task
  clears its log for the day (see Lifecycle), so a log's existence *is* the
  "still-to-do today" state. The log inherits its RC from the task — no RC column on
  the log, one less thing to keep in sync.
- `linkedInventoryItemId` points at `InventoryItem`. Because PREP recipes already
  spawn linked `InventoryItem`s, a single FK covers both raw and prep ingredients
  ("the list is the inventory list").
- Back-relations to add: `RevenueCenter` → `prepTasks PrepTask[] @relation("PrepTaskRC")`;
  `InventoryItem` → `prepTaskRefs PrepTask[] @relation("PrepTaskInventory")`.

### Migration

`prisma migrate dev` is broken in this project (P3006 shadow drift) and the direct
DB host is unreachable. Add the migration via the established workaround:
`prisma migrate diff` to generate SQL → apply over the pooler with
`$executeRawUnsafe` → `prisma migrate resolve --applied`. Two new tables + FKs +
the unique index; no changes to existing tables beyond the two back-relations
(which are Prisma-side only, no DDL).

## Lifecycle

- **Library** = active `PrepTask`s for the active RC, ordered by `sortOrder` then `name`.
- **Activate (add to today)** = create `PrepTaskLog(prepTaskId, today)`. Idempotent via
  `@@unique([prepTaskId, logDate])` — activating an already-active task is a no-op
  returning the existing log.
- **Done** = delete that day's log. The task **vanishes** from To Do and its Smart Prep
  "active today" toggle flips back to *off* — i.e. completion **resets** the task so it
  can be added to the list again (even the same day).
- **Remove from today** = also deletes that day's log. "Done" (✓) and "remove" (×) are
  the same mechanical operation — clear today's log — distinguished only by the user's
  intent/affordance. After either, the task is available to re-add.
- **Deactivate (remove from library)** = soft `isActive=false` (matches the app's
  "never cascade history" delete semantics).
- **New day** = nothing carries over; today starts empty until tasks are activated.

Because completion deletes the log, there is **no persisted record of which tasks were
done** — acceptable for v1 (History integration and completion counts are non-goals).
If a "completed today" count is wanted later, switch to keeping a `completedAt` log
instead of deleting.

## UI placement

Three prep views exist: **To Do** (`viewMode='today'`), **Smart Prep** (`'smartprep'`),
History. Smart Prep's urgency buckets are **Critical → Needed today → Later**.

### Smart Prep subpage = library + activation

A **Tasks** section renders **first, above Critical**. New order:
`Tasks → Critical → Needed today → Later`.

- Lists the RC's task library.
- Each row's checkbox/toggle means **"active today"** — toggling on creates today's
  log (drops the task onto To Do); toggling off deletes today's log.
- Inline **"＋ New task"** to create a library task; **rename** and **delete**
  (soft-deactivate) affordances.
- **Drag to reorder** the library (canonical order).
- Renders at the top of Smart Prep across its sub-views (urgency/category/station),
  since tasks are not par-driven.

### To Do subpage = execution

A **Tasks** section renders **first, above the to-do items**. New order:
`Tasks → [prep to-do items]`.

- Each active task is a **done checkbox**. Checking it = done → the task **vanishes**
  from the list immediately (deletes today's log) and becomes available to re-add on
  Smart Prep. No struck-through residue, no Done subgroup.
- A **remove (×)** also takes the task off today (same effect — clears the log).
- Renders in the library's `sortOrder` (To Do does not have its own drag).

### The two-verb model

Same task, different verb per page: on **Smart Prep** the checkbox = *activate*
(is it on today's list); on **To Do** the checkbox = *done* (finished → vanish + reset).
This matches what each page is for — Smart Prep plans, To Do executes.

### Related-ingredient `@`-picker

- In the task name input, typing `@` opens a dropdown of inventory items with a
  **client-side fuzzy filter** over `GET /api/inventory` (active items).
- Selecting sets `linkedInventoryItemId`. Picking again replaces it (single link).
- Stored as a **structured FK**, not inline `@text` in the name — survives item
  renames, can't desync.
- On the task row the linked ingredient renders as a **contrasting read-only chip**
  beside the name (the "item selected" highlight). Informational only — no navigation
  side effects required, no cost/stock effect.

### RC / All-RCs

Tasks follow the prep page's active RC. When **All** is selected, the Tasks section
shows a read-only note — *"Select a revenue center to manage tasks"* — mirroring how
counts require a specific RC.

## API

All routes `export const dynamic = 'force-dynamic'` and call `requireSession()`
(authenticated; prep is staff-facing, no min role). Catch `AuthError` →
`NextResponse.json({ error }, { status })`.

| Method | Route | Body / query | Effect |
|---|---|---|---|
| GET | `/api/prep/tasks` | `?rcId=&date=` | `{ library: PrepTask[], today: PrepTaskLog[] }` for the RC + date |
| POST | `/api/prep/tasks` | `{ name, revenueCenterId, linkedInventoryItemId? }` | create library task (appends at end: `sortOrder = max+1`) |
| PATCH | `/api/prep/tasks/[id]` | `{ name?, isActive?, linkedInventoryItemId? }` | rename / soft-deactivate / retag |
| DELETE | `/api/prep/tasks/[id]` | — | soft-deactivate (`isActive=false`) |
| PATCH | `/api/prep/tasks/reorder` | `{ ids: string[] }` | write `sortOrder` by index (one RC) |
| POST | `/api/prep/tasks/[id]/today` | `{ date }` | **activate** — idempotent upsert of the log |
| DELETE | `/api/prep/tasks/[id]/today` | `?date=` | **done / remove** — delete the log (vanish + reset) |

The today-log lifecycle is keyed by `taskId + date`, so the client never tracks log
IDs; the unique index makes activate idempotent. "Done" (To Do ✓), "remove" (To Do ×),
and Smart Prep "toggle off" all map to the single DELETE.

**Validation:** non-empty `name`; `revenueCenterId` exists; `date` parses;
`linkedInventoryItemId` (if present) references an existing item. Bad input → 400;
not found → 404.

## Components (`src/components/prep/`)

- `PrepTaskLibrary.tsx` — Smart Prep section. Library rows with activate toggle,
  drag handle, related-ingredient chip, inline "＋ New task", rename/delete.
  Hosts the `@`-picker.
- `PrepTaskList.tsx` — To Do section. Today's tasks as done-checkboxes + remove ×,
  with the related-ingredient chip.
- Shared types added to `src/components/prep/types.ts`: `PrepTask`, `PrepTaskLog`,
  `PrepTaskRow` (task + today log + linked item summary).
- `src/app/prep/page.tsx` owns fetch + state (`taskLibrary`, today logs, inventory
  list for the picker) and renders each section at the top of its view, in **both**
  the mobile (`block sm:hidden`) and desktop (`hidden sm:block`) renderer blocks per
  the page's dual-renderer pattern. Optimistic updates for activate/done/remove.

## Error handling

- Activate when a log already exists for `(task, date)` → idempotent (return existing).
- Deactivate a task with logs → soft `isActive=false`; logs preserved as history.
- `@`-picker over an empty/failed inventory fetch → picker shows "no items", task
  still saves without a link.
- All-RCs selected → section is read-only with the select-an-RC note; no writes.

## Testing

No test suite — `npm run build` is the correctness gate; run after schema and route
changes. Manual verification via the preview server:

1. Create a task, drag to reorder, tag an ingredient via `@`.
2. Activate on Smart Prep → confirm it appears on To Do.
3. Check done on To Do → task vanishes; confirm its Smart Prep toggle is off and it
   can be re-added the same day. Remove × → same vanish behavior.
4. Switch RC → confirm library + today isolation per RC; All-RCs shows the note.
5. Confirm tasks appear in **no** COGS / cost / inventory / reports number
   (structural — there is no price to leak, but verify the board sections only).
