# Pass + Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Inbox of everything a manager or shift lead must deal with, plus a rebuilt Pass hub (phone and desktop) on top of it. The Inbox holds cooks' reports, checklist flags and the app's own alerts. Each item is tagged, filterable, and keeps its history.

**Architecture:**
- New Prisma models store every item: `InboxItem`, `InboxEvent`, `InboxTag`, `InboxFlagRoute` and `InboxSync`.
- **Cook reports** are created directly.
- **Checklist flags** sync both ways with their run line.
- **The app's own alerts** (temps, stations, prep, money, count, phones) are reconciled by a throttled system sync from their live sources, keyed by a stable `sourceKey`.
- Pure rules live in `src/lib/inbox/`. Routes follow the house pattern. Pages follow the mockup in the Controla look.
- Pass becomes a reader of the Inbox, plus stations, service, handover notes and numbers.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma + PostgreSQL (Supabase, pgBouncer transaction pooler), Tailwind with flat Controla tokens, lucide icons, vitest.

**Spec:** `docs/superpowers/specs/2026-10-30-pass-inbox-design.md`. Read it first; it holds the decisions and the source table.

## Global Constraints

- **Worktree.** Work in `/Users/joshua/dev/fergies-os-checklists` on branch `feat/pass-inbox`, which starts at `origin/main` 5d868849. `node_modules` and `.env` are already present.
  - Node lives at `/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin`.
  - npm, npx, vitest and next must run with the sandbox disabled.
- **Route handlers.** Every route file has `export const dynamic = 'force-dynamic'`.
  - Catch `AuthError` → `{ error }` with its status.
  - Log anything else as `console.error('<METHOD> <path>', e)` and return a 500 with a short message.
- **Auth.** Use `requireSession(minRole?)` from `src/lib/auth.ts`.
  - The Inbox (read and act) is **LEAD**.
  - Tags and flag routes (write) are **MANAGER**.
  - Report something is any signed-in user.
  - RC reads go through `isRcInScope`. RC writes go through `assertRcWritable` (both in `src/lib/rc-scope.ts`).
  - Items with `managerOnly` (the Money tag, phone approvals) are never returned to a LEAD, and that includes counts.
- **Dates.** Business date is Pacific, from `businessDateLocal()`. "Snooze till tomorrow" means 05:00 Pacific the next day.
- **Decimals.** Prisma `Decimal` reaches the client as a string, so wrap it in `Number()`.
- **Person ids** are plain strings with no FK. History must survive a hard-deleted user. Display names come from `whoOf(user)` (`src/lib/checklists/who.ts`). Never show an email.
- **Client code.** Pages are `'use client'` with module-scope sub-components.
- **Look.**
  - Flat Tailwind tokens (`bg-paper`, `text-ink-3`, `bg-red-soft` …); numbered colour classes are broken.
  - Mono for numbers, times, labels and pills.
  - Tap targets ≥44 px; phone buttons 50 px.
  - Sheets sit over the scrim at z-[60] with no blur.
  - Category colours are dots only, never text.
  - No emoji.
- **Tag palette** (exact, the 8 hexes): `#71717a #dc2626 #ca8a04 #ea580c #16a34a #db2777 #0d9488 #2563eb`. Money's seed colour `#7c3aed` is allowed as its built-in default.
- **Copy.** Use kitchen words, as in the mockup: "Needs you first", "Report something", "Mark fixed", "Snooze till tomorrow", "Waiting on someone", "Cleared itself", "Manage tags".
- **Live DB.** Local dev talks to the LIVE database. The migration (Task 1) and any browser test that writes need Joshua's explicit yes. The controller applies the migration. Implementers never write to the DB.

## Review Focus

1. **A system alert that clears itself and comes back** (the walk-in warms again at 14:00) must reopen the same day's item, not duplicate it. Covered by the `reconcile` tests in Task 2 and the sync test in Task 6.
2. **A LEAD must never see a Money item.** That covers the list, the counts, the bell, Pass and `GET /api/inbox/[id]` by id. Covered by the `visibleTo` tests in Task 2 and the route tests in Task 4.
3. **Fixing a flag from either place closes both.** "Mark fixed" on the board and "Mark fixed" in the Inbox each close the other side. A re-answered line clears its item. Covered by the Task 5 tests.
4. **Two managers open the Inbox at the same moment.** The system sync must not create duplicate items: `sourceKey` is unique, writes are upserts, and P2002 is tolerated. Covered by the Task 6 test.
5. **A STAFF cook reporting with a tag that isn't cooks-can-pick, or into another RC,** gets 400 or 403 and nothing is written. Covered by the Task 4 tests.

---

### Task 1: Schema and migration

**Files:** Modify `prisma/schema.prisma`. Create `prisma/migrations/20261030030000_inbox/migration.sql`.

**Interfaces.** Produces these enums and models:

- **Enums:**
  - `InboxSeverity { NOW TODAY FYI }`
  - `InboxStatus { OPEN SNOOZED WAITING DONE }`
  - `InboxSource { REPORT FLAG SYSTEM }`
  - `InboxEventKind { RAISED SEEN NOTE SNOOZED WAITING REOPENED DONE CLEARED RETAGGED }`
  - `InboxBuiltIn { FOOD_SAFETY CHECKLISTS PREP STOCK MONEY TEAM }`
- **`InboxTag`:**
  - `id` uuid, `builtIn InboxBuiltIn? @unique`
  - `name String`, `color String`
  - `cookCanPick Boolean @default(false)`, `managerOnly Boolean @default(false)`
  - `sortOrder Int @default(0)`, `isActive Boolean @default(true)`
  - timestamps; back-relations `items`, `routes`
- **`InboxFlagRoute`:** `reason ChecklistFlagReason @id`, `tagId` (relation InboxTag, `onDelete: Restrict`), `updatedAt`.
- **`InboxItem`:**
  - `id` uuid
  - `revenueCenterId String?` (relation RevenueCenter, `onDelete: SetNull`)
  - `tagId` (relation InboxTag, Restrict)
  - `severity InboxSeverity`, `title String`, `body String?`, `place String?`, `href String?`
  - `source InboxSource`, `sourceKey String? @unique`
  - `managerOnly Boolean @default(false)`
  - `status InboxStatus @default(OPEN)`, `snoozeUntil DateTime?`
  - `raisedById String?`, `raisedByName String?`
  - `doneById String?`, `doneByName String?`, `doneAt DateTime?`
  - `clearedAt DateTime?`
  - `createdAt`, `updatedAt`
  - `@@index([status, revenueCenterId])`, `@@index([tagId])`, `@@index([raisedById])`
- **`InboxEvent`:**
  - `id` uuid, `itemId` (Cascade)
  - `kind InboxEventKind`, `byId String?`, `byName String?`, `note String?`
  - `at DateTime @default(now())`
  - `@@index([itemId, at])`, `@@index([byId, kind])`
- **`InboxSync`:** `revenueCenterId String @id`, `at DateTime`.

**Steps:**

- [ ] **Step 1.** Add the models. Back-relations: `RevenueCenter.inboxItems`.
- [ ] **Step 2.** Generate the SQL read-only, without the shadow DB.
  - Take the session-mode URL from `$DATABASE_URL` (port 6543→5432, drop `pgbouncer` / `connection_limit`).
  - Run `npx prisma migrate diff --from-url "$SESSION_URL" --to-schema-datamodel prisma/schema.prisma --script`.
  - Expected: only CREATE TYPE / CREATE TABLE / CREATE INDEX statements and FKs from the new tables. Anything else → STOP and report it.
- [ ] **Step 3.** Run `npx prisma generate` and `npm run build`. Expected: both pass.
- [ ] **Step 4.** Do NOT apply. The controller applies after Joshua's yes.
- [ ] **Step 5.** Commit `feat(inbox): inbox tables`.

---

### Task 2: Pure rules

**Files:** Create `src/lib/inbox/rules.ts`. Test: `src/lib/__tests__/inbox-rules.test.ts`.

**Interfaces.** Produces:

- **Types:**
  - `Severity = 'NOW' | 'TODAY' | 'FYI'`
  - `Status = 'OPEN' | 'SNOOZED' | 'WAITING' | 'DONE'`
  - `TagLite = { id; builtIn: string | null; name; color; cookCanPick; managerOnly; isActive }`
  - `ItemLite = { id; tagId; severity; status; managerOnly; snoozeUntil: string | null; clearedAt: string | null; doneById: string | null; createdAt: string }`
- **`reconcile(existing, present, now)`** — signature `reconcile(existing: Pick<ItemLite,'status'|'clearedAt'|'doneById'> | null, present: boolean, now: Date): { action: 'create' | 'clear' | 'reopen' | 'none' }`. Exactly the spec's four rules:
  - no item + present → `create`
  - open / snoozed / waiting + not present → `clear`
  - DONE with `clearedAt` + present → `reopen`
  - otherwise → `none`
- **`snoozeUntilTomorrow(now: Date): Date`** — 05:00 Pacific on the next Pacific calendar day. Handle DST using an Intl-based Pacific offset.
- **`isOpenNow(item, now): boolean`** — OPEN or WAITING, or SNOOZED with `snoozeUntil <= now`.
- **`canSee(role: Role, item: { managerOnly: boolean }, tag?: { managerOnly: boolean }): boolean`** — false for below LEAD. False for LEAD when the item or the tag is managerOnly.
- **`flagTagId(reason, routes: Record<string,string>, tags: TagLite[]): string`** — OUT_OF_RANGE → the FOOD_SAFETY tag id. Otherwise `routes[reason]` if it is an active tag, else the CHECKLISTS built-in tag id.
- **`flagSeverity(isBlocker: boolean): Severity`** — NOW if blocker, else TODAY.
- **`groupItems<T extends {severity}>(items): { severity: Severity; items: T[] }[]`** — order NOW, TODAY, FYI. Empty groups are dropped.
- **`badgeCount(items: ItemLite[], role, tagsById, now): number`** — visible, open-now, and severity NOW or TODAY.
- **`SEED_TAGS`** — the six built-ins plus Maintenance (`#ea580c`, cookCanPick), Events (`#db2777`, cookCanPick) and Other (`#71717a`, cookCanPick), in that order. Deterministic ids `tag-<lowercase key>` (`tag-food_safety` …, `tag-maintenance`, `tag-events`, `tag-other`).
  - Food safety `#dc2626` cookCanPick
  - Checklists `#2563eb`
  - Prep `#16a34a` cookCanPick
  - Stock `#0d9488` cookCanPick
  - Money `#7c3aed` managerOnly
  - Team `#71717a`
- **`SEED_ROUTES`** — `{ BROKEN: 'tag-maintenance', RAN_OUT: 'tag-stock', OTHER: 'tag-other' }`.

**Steps:**

- [ ] **Step 1.** Write the failing tests.
  - Every reconcile branch, including "DONE by a person + present → none".
  - `snoozeUntilTomorrow(new Date('2026-10-30T07:52:00Z'))` → `'2026-10-31T12:00:00.000Z'` (05:00 PDT).
  - `snoozeUntilTomorrow(new Date('2026-11-01T06:30:00Z'))` → `'2026-11-02T13:00:00.000Z'` (05:00 PST after the fall back).
  - `canSee('LEAD', { managerOnly: true })` → false; `canSee('MANAGER', …)` → true; `canSee('STAFF', …)` → false.
  - `flagTagId` for each reason, with and without a route.
  - `badgeCount` ignores FYI, DONE, future snoozes, and managerOnly for a LEAD.
- [ ] **Step 2.** Run the tests; they fail.
- [ ] **Step 3.** Implement. Keep it pure: no Prisma, no React.
- [ ] **Step 4.** Run the tests; they pass.
- [ ] **Step 5.** Commit `feat(inbox): pure rules`.

---

### Task 3: Tags and flag routes (seed + API)

**Files:**
- Create `src/lib/inbox/tags.ts` (server-only).
- Create `src/app/api/inbox/tags/route.ts` (GET, POST) and `src/app/api/inbox/tags/[id]/route.ts` (PATCH, DELETE).
- Create `src/app/api/inbox/flag-routes/route.ts` (GET, PUT).
- Test: `src/app/api/inbox/__tests__/tags.test.ts`.

**Interfaces.** Produces:

- **`ensureInboxSeeded(): Promise<void>`**
  - `createMany(skipDuplicates)` of `SEED_TAGS` and `SEED_ROUTES`.
  - Only when `inboxTag.count() === 0`. Inactive tags count, so a deleted seed tag is never brought back.
- **`loadTags(): Promise<TagLite[]>`** — active and inactive, ordered by sortOrder.
- **`GET /api/inbox/tags`**
  - Requires any session.
  - STAFF gets only active `cookCanPick` tags that are not `managerOnly`.
  - LEAD gets active tags minus `managerOnly`.
  - MANAGER gets all, including inactive, with `openCount` per tag.
  - Response: `{ tags: TagLite[] }`.
- **`POST /api/inbox/tags`** (MANAGER) with `{ name, color, cookCanPick }`:
  - name: trimmed, 1–24 chars, else 400 'Give the tag a name'.
  - color: must be in the palette, else 400 'Pick a colour'.
  - name unique case-insensitive among active tags, else 409 'There’s already a tag called X'.
  - Never `builtIn`; `managerOnly` false.
- **`PATCH /api/inbox/tags/[id]`** with `{ name?, color?, cookCanPick? }`.
  - Built-ins accept name and color only. `cookCanPick` on a built-in → 400 'Built-in tags keep their settings'.
- **`DELETE /api/inbox/tags/[id]`**
  - Built-in → 409 'Built-in tags can’t be removed'.
  - Otherwise `isActive=false`. Open items keep their tag.
  - If a flag route points at it → 409 'Move the flag route off this tag first'.
- **`GET /api/inbox/flag-routes`** (MANAGER) → `{ routes: { BROKEN, RAN_OUT, OTHER } }` (tag ids).
- **`PUT /api/inbox/flag-routes`** (MANAGER) with `{ reason: 'BROKEN' | 'RAN_OUT' | 'OTHER', tagId }`.
  - The tag must be active, else 400 'Pick an active tag'.

**Steps:**

- [ ] **Step 1.** Write the failing tests:
  - STAFF tag list filter
  - POST duplicate → 409
  - PATCH built-in cookCanPick → 400
  - DELETE built-in → 409
  - DELETE a routed tag → 409
  - PUT a route to an inactive tag → 400
  - a LEAD hitting POST → 403
- [ ] **Step 2.** Implement. Every handler calls `ensureInboxSeeded()` first.
- [ ] **Step 3.** Run the tests, then `npm run build`.
- [ ] **Step 4.** Commit `feat(inbox): tags and flag routes`.

---

### Task 4: Inbox core API (list, item, actions, report, count)

**Files:**
- Create `src/lib/inbox/store.ts` (server-only).
- Create these routes:
  - `src/app/api/inbox/route.ts` (GET)
  - `src/app/api/inbox/[id]/route.ts` (GET, PATCH)
  - `src/app/api/inbox/count/route.ts` (GET)
  - `src/app/api/inbox/report/route.ts` (POST)
  - `src/app/api/inbox/mine/route.ts` (GET)
- Test: `src/app/api/inbox/__tests__/{list,item,report}.test.ts`.

**Interfaces.** Produces:

- **`ItemView`** = `ItemLite` + `{ title; body; place; href; source; tag: TagLite; raisedByName; doneByName; doneAt; unread: boolean; revenueCenterId }`. All dates are ISO strings.
- **`loadItems(user, { rcId, status: 'open' | 'done', tagId?, from? (raisedById), place? }): Promise<ItemView[]>`**
  - Scope: the rc plus items with a null rc.
  - `open` = `isOpenNow` items. `done` = DONE in the last 14 days.
  - Filtered by `canSee`.
  - `unread` = no SEEN event by the user.
  - Order: severity, then createdAt desc.
- **`act(user, id, action)`**, where `action` is one of:
  - `{ kind: 'note', note }`
  - `{ kind: 'snooze' }`
  - `{ kind: 'wait', note? }`
  - `{ kind: 'done', note? }`
  - `{ kind: 'reopen' }`
  - `{ kind: 'retag', tagId }`

  It updates the item and writes the matching event in one `$transaction`.
  - `done` sets doneBy*/doneAt and clears `clearedAt`.
  - `reopen` → OPEN.
  - `snooze` → SNOOZED + `snoozeUntilTomorrow`.
  - The note is trimmed, max 500 chars.
  - Retag to a `managerOnly` tag by a LEAD → 403.
  - A FLAG-source `done` also resolves the line (Task 5 adds that hook; leave a call to `onItemDone(item, user, tx)`, exported as a no-op here).
- **`GET /api/inbox?rcId=&status=&tagId=&from=`** (LEAD)
  - Calls `syncSystemItems(rcId)`. Task 6 provides it; import a stub that resolves immediately until then.
  - Returns `{ items, counts: { byTag: Record<tagId, number>, open: number, done: number }, tags }`.
- **`GET /api/inbox/[id]`** (LEAD)
  - 404 if not visible or out of scope.
  - Writes SEEN once per user.
  - Returns `{ item: ItemView, events: Array<{ kind, byName, note, at }> }`.
- **`PATCH /api/inbox/[id]`** (LEAD) with an action body.
  - 400 'Unknown action'.
  - 409 'Already fixed' for `done` on a DONE item.
  - `assertRcWritable` on the item's rc when one is set.
- **`GET /api/inbox/count?rcId=`**
  - LEAD+ → `{ count }` (badgeCount).
  - STAFF → `{ count: number of their own reports done since their last SEEN on them }`.
- **`POST /api/inbox/report`** (any session) with `{ rcId, tagId, text, place?, urgent? }`.
  - `assertRcWritable`.
  - Text trimmed, 3–500 chars, else 400 'Say what’s going on'.
  - A STAFF user's tag must be active + cookCanPick + not managerOnly, else 400 'Pick a tag'.
  - Creates source REPORT, severity NOW if urgent else TODAY, `raisedBy` = `whoOf(user)`. Title = the first line of the text, max 80 chars. Body = the full text.
  - Writes a RAISED event.
  - Returns `{ item }`.
- **`GET /api/inbox/mine`** (any session) → `{ items }` — the user's own reports from the last 14 days, with status and doneByName.

**Steps:**

- [ ] **Step 1.** Write the failing tests:
  - A LEAD never receives a managerOnly item, in the list, the count or the GET by id (404).
  - The first GET by id writes SEEN; the second doesn't.
  - Each action writes the right event and fields.
  - `done` twice → 409.
  - A STAFF report with a non-pickable tag → 400.
  - A report into an out-of-scope rc → 403, nothing written.
  - Text of 2 chars → 400.
- [ ] **Step 2.** Implement.
- [ ] **Step 3.** Run the tests, `npm test`, then `npm run build`.
- [ ] **Step 4.** Commit `feat(inbox): inbox API — list, act, report, count`.

---

### Task 5: Checklist flags ↔ Inbox

**Files:**
- Create `src/lib/inbox/flags.ts` (server-only).
- Modify `src/app/api/checklists/lines/[id]/route.ts` and `src/app/api/checklists/lines/[id]/resolve/route.ts`.
- Modify `src/lib/inbox/store.ts` (`onItemDone`).
- Test: `src/lib/__tests__/inbox-flags.test.ts` and updates to the existing checklist line and resolve tests.

**Interfaces.** Produces:

- **`syncFlagItem(tx, line, run, station, who)`** — called inside the line PUT transaction after the line update.
  - **Line is now FLAGGED:** upsert an InboxItem on `sourceKey 'flag:<lineId>'`:
    - tag = `flagTagId(reason)`
    - severity = `flagSeverity(isBlocker)`
    - title = `'<line title> · ' + (reason label)`
    - body = the note, or the value + unit for OUT_OF_RANGE
    - place = station name
    - rc = station rc
    - `raisedBy` = who
    - href = `/checklist/today`

    If the item exists and is DONE, reopen it (REOPENED); otherwise update it.
  - **Line not FLAGGED and an item exists and is open:** clear it (CLEARED, 'Cleared itself — the job was redone').
- **Resolve route:** after a successful resolve, mark the item DONE (DONE event, by the resolver) if it is open.
- **`onItemDone`:** for a FLAG source, set the line's `resolvedById` / `resolvedByName` / `resolvedAt` in the same tx, guarded so it only applies while the line is FLAGGED and unresolved.

**Steps:**

- [ ] **Step 1.** Write the failing tests:
  - A flag creates the item with the routed tag.
  - A re-flag after the item was done reopens it.
  - An untick clears it.
  - An in-range re-answer clears it.
  - A board resolve marks the item done.
  - An Inbox done resolves the line.
  - OUT_OF_RANGE always lands in Food safety.
- [ ] **Step 2.** Implement.
- [ ] **Step 3.** Run the tests and `npm test`.
- [ ] **Step 4.** Commit `feat(inbox): checklist flags land in the inbox and close both ways`.

---

### Task 6: System sources sync

**Files:**
- Create `src/lib/inbox/system.ts` (server-only).
- Create `src/lib/inbox/conditions.ts` (pure collectors).
- Test: `src/lib/__tests__/inbox-conditions.test.ts`, `src/lib/__tests__/inbox-system.test.ts`.

**Interfaces.** Produces:

- **`collectConditions(input): Condition[]`** (pure).
  - `Condition = { sourceKey; tagBuiltIn; severity; title; body?; place?; href; managerOnly; revenueCenterId: string | null }`.
  - `input` carries the data the sources need: temp units with today's readings, stations + today runs + applicable job counts for the OPEN phase, unsigned CLOSE runs from the last business date, prep items, unacknowledged UP price alerts, the awaiting-invoice count, days since the last count, and pending phones.
  - Each source follows the spec table exactly: keys, severities, titles. Reuse the title wording from `src/lib/start-page.ts` builders where one exists (`tempNeeds`, `prepNeed`, `priceNeed`, `invoiceNeed`, `countNeed`); import their helpers rather than copying them.
- **`syncSystemItems(rcId: string | null): Promise<void>`**
  - Throttle: skip if `InboxSync.at` for the rc is within 60 s; otherwise upsert `at`.
  - Load the inputs: Prisma reads only, the same queries the existing routes use. Read `/api/prep/items` logic from its lib, not over HTTP. Where a route has no lib function, extract a small server-only function and use it from both the route and here.
  - Compute the conditions.
  - Load the existing SYSTEM items whose sourceKeys are present, plus the open SYSTEM items for this rc whose keys are absent.
  - Apply `reconcile` for each.
  - Create via `createMany(skipDuplicates)` followed by event writes. Run clears and reopens as `updateMany` per key plus events.
  - Tolerate P2002.
  - Price-rise items: Inbox "done" acknowledges the PriceAlert. Hook that into `onItemDone` for `sourceKey` `price:*`.
  - Never throw to the caller. Log and continue, so a failing source never breaks the Inbox.
- **Wire-up:** replace Task 4's stub import with the real one.

**Steps:**

- [ ] **Step 1.** Write the failing tests for `collectConditions`, one per source:
  - the exact `sourceKey`, severity and tag
  - a cold unit logged in range → no condition
  - a station with 0 applicable jobs → no condition
  - a phone that is stale → no condition
  - a LEAD-hidden money condition → `managerOnly` true
- [ ] **Step 2.** Write the failing tests for `syncSystemItems` with mocked prisma:
  - throttled when synced 30 s ago
  - creates new items
  - clears absent ones with a CLEARED event
  - reopens a cleared one
  - leaves a person-done one alone
  - a P2002 on create → no throw
- [ ] **Step 3.** Implement.
- [ ] **Step 4.** Run the tests, `npm test`, then `npm run build`.
- [ ] **Step 5.** Commit `feat(inbox): the app files its own alerts`.

---

### Task 7: Inbox pages

**Files:**
- Create `src/app/inbox/page.tsx`.
- Create `src/components/inbox/{InboxList.tsx,ItemSheet.tsx,TagChips.tsx,InboxFilters.tsx,format.ts}`.
- Modify `src/lib/route-access.ts` and its test: `['/inbox', 'LEAD']`, `['/inbox/tags', 'MANAGER']`.

**Interfaces:** consumes the Task 4 JSON.

**Steps:**

- [ ] **Step 1. Phone layout** (`md:hidden`), following InboxMobile:
  - "‹ Pass" link and the Open · N / Done switch.
  - Title and lede.
  - Scrolling tag chips (All + each tag with count, dot).
  - "Manage tags →" (MANAGER only).
  - Severity groups, with the row anatomy from the mockup (tag dot + name + when, title, meta, gold unread dot).
  - Tapping a row opens `ItemSheet`.
- [ ] **Step 2. Desktop layout** (`hidden md:grid`), following InboxDesktop:
  - Filter column: Status with counts, Tag with counts, Where (station / place select), From (person select).
  - The list.
  - A detail pane, which is the same `ItemSheet` content rendered inline.
- [ ] **Step 3. `ItemSheet`:**
  - Tag pill with retag (a select, LEAD+) and the severity pill.
  - Title and body.
  - "What happened" timeline.
  - "Go to …" link when `href` is set.
  - Note box (maxLength 500).
  - Buttons: Snooze till tomorrow / Waiting on someone / Mark fixed (ink + gold ✓); Reopen when DONE.
  - Toast on a server error, then reload.
  - Opening it calls GET by id, which writes SEEN.
- [ ] **Step 4. Data:** wait for `useRc().ready`, poll every 30 s while visible, and keep state on refetch, following the house pattern in `src/app/checklist/today/page.tsx`.
- [ ] **Step 5.** Run `npm run build`; `/inbox` must be listed.
- [ ] **Step 6.** Commit `feat(inbox): inbox screens`.

---

### Task 8: Tags page

**Files:** Create `src/app/inbox/tags/page.tsx` and `src/components/inbox/TagSheet.tsx`.

**Steps:**

- [ ] **Step 1.** Build it following TagsEditor:
  - **Your tags:** dot, name, "N OPEN", ›. Tap opens `TagSheet`: name, the 8 colour dots, the cooks-can-pick switch, Remove (with confirm "Remove Cleaning? Items keep it.").
  - **"+ Add a tag".**
  - **Built in:** RENAME pill; `TagSheet` shows name + colour only.
  - **"Where cooks’ flags land":** three selects (Broken, Ran out, Other) → PUT.
- [ ] **Step 2.** Run `npm run build`.
- [ ] **Step 3.** Commit `feat(inbox): manage tags`.

---

### Task 9: Report something

**Files:**
- Create `src/components/inbox/ReportSheet.tsx`.
- Modify `src/app/checklist/page.tsx` (header "Report" button).
- Modify `src/components/start/CookStart.tsx` ("Report something" button + "Your reports" line from `/api/inbox/mine`: "2 reports · 1 fixed").
- Modify `src/app/inbox/page.tsx` (a "+ Report something" button).

**Steps:**

- [ ] **Step 1. `ReportSheet`**, following ReportSheet:
  - Tags from `GET /api/inbox/tags` as `aria-pressed` chips.
  - "What’s going on" textarea (maxLength 500).
  - "Where" select: stations of the RC, plus "Walk-in", "Dry store", "Dish pit", "Front of house". Free text is not needed.
  - Urgent switch.
  - "Send to the managers →".
  - No photo button. Photos come later; leave it out rather than drawing a dead button.
  - On success: the toast "Sent — you’ll see here when it’s fixed", then close.
- [ ] **Step 2. "Your reports":** a small list sheet showing title, tag, status, "Fixed by Josh · 9:12".
- [ ] **Step 3.** Run `npm run build`.
- [ ] **Step 4.** Commit `feat(inbox): cooks can report something`.

---

### Task 10: Bell and nav

**Files:**
- Modify `src/components/AlertsBell.tsx`.
- Modify `src/components/layout/CostChrome.tsx` (the desktop bell uses the same component).
- Modify `src/lib/nav-items.ts` and its test: add `{ href: '/inbox', label: 'Inbox', icon: Inbox, badgeKey: 'inbox' }` in the TODAY group, after Pass.
- Modify `src/components/Navigation.tsx` (the `inbox` badge from `/api/inbox/count`).

**Interfaces:**
- `badgeKey` union gains `'inbox'`.

**Steps:**

- [ ] **Step 1. Bell for LEAD+:**
  - Badge = `/api/inbox/count` (poll 30 s).
  - The dropdown shows the top 5 open items (from `/api/inbox?status=open`, NOW then TODAY) and "Open Inbox →".
  - The old price-alert list and "acknowledge all" go away; those alerts are Money items now.
- [ ] **Step 2. Bell for STAFF:**
  - Badge = their fixed-reports count.
  - The dropdown lists "Your reports".
- [ ] **Step 3.** Keep the existing `NotificationContext` soft notifications (toasts) as they are.
- [ ] **Step 4.** Run the tests and `npm run build`.
- [ ] **Step 5.** Commit `feat(inbox): the bell and the nav point at the inbox`.

---

### Task 11: Pass rebuild

**Files:**
- Create `src/app/api/checklists/handovers/route.ts` (GET, LEAD).
- Rewrite `src/components/start/StartMobile.tsx` and `src/components/start/StartDesktop.tsx`.
- Modify `src/components/start/useStartData.ts`.
- Modify `src/app/today/page.tsx`: LEAD gets StartMobile in a `max-w-[640px]` column on desktop too; STAFF keep CookStart.

**Interfaces:**

- **`GET /api/checklists/handovers?rcId=`** → `{ businessDate, notes: Array<{ stationName, color, isShared, byName, at, note }> }`.
  - Covers every SIGNED CLOSE run with a non-empty `handoverNote` for the last CLOSE business date: `shiftBusinessDate('CLOSE')`, or the previous day if none exist yet.
- **Pass data:**
  - `useStartData` adds `inbox` (from `/api/inbox?rcId&status=open`), `stations` (from `/api/checklists/today`) and `handovers`.
  - `buildNeeds` stops driving the list; Pass shows Inbox items instead. Leave `start-page.ts` builders in place (Task 6 reuses their wording).

**Steps:**

- [ ] **Step 1.** Handover route + test: only SIGNED CLOSE runs with notes, ordered shared first, then sortOrder.
- [ ] **Step 2. StartMobile**, following PassMobile:
  - Top bar bell (already from Task 10).
  - Crumb, greeting, lede: "Doors in X. **N things** need you before then."
    - N = NOW items.
    - Use the existing service status helpers for the doors time.
    - Drop the clause when there is no service.
  - "Right now" card: top 3 NOW items (then TODAY if fewer than 3), each with a tag dot, title, meta and a CTA linking to `href` or opening the item. The first CTA is the gold one.
  - "N more in the Inbox → Open Inbox".
  - Stations strip, 3-col tiles, for the current phase.
  - The service/prep ink card (keep the current one).
  - "From last night": the EOD note (MANAGER, from `lastClose`) plus each station handover.
  - Numbers card (MANAGER only).
- [ ] **Step 3. StartDesktop**, following PassDesktop:
  - Header with "Open Inbox (N) →".
  - The ink service band.
  - Left column: "Needs you first" (top 6, ranked, index / tag / title / meta / when pill / CTA) and the stations grid.
  - Right rail: "Inbox by tag" (counts + "1 NOW" markers), "From last night", numbers.
- [ ] **Step 4. LEAD view:**
  - No money anywhere: the counts already exclude it, and the numbers card is hidden.
  - Show a "Your station" card (the existing `ChecklistCard`) above "Right now" when the lead has picked a station.
- [ ] **Step 5.** Run `npm test` and `npm run build`.
- [ ] **Step 6.** Commit `feat(pass): the hub — needs you first, stations, handovers, inbox by tag`.

---

### Task 12: Verify

- [ ] **Step 1.** Run `npm test`, `npm run lint` (touched files clean) and `npm run build`. Every `/api/inbox/*` route must be `ƒ`.
- [ ] **Step 2. STOP and ask Joshua** before a browser test on the live DB.
  - Propose: report one test item, flag one test job, check Pass, the Inbox, the bell and the tags page, then delete the test rows.
  - Tags are seeded on first open. Seeded tags stay; they are wanted.
