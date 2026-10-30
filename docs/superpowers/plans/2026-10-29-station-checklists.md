# Station Checklists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the kitchen-wide opening list and the end-of-day close list with per-station opening/closing checklists that cooks tick on their phones, managers edit freely, and managers can review by date and person.

**Architecture:** New Prisma models (station → category → item templates; run → snapshot lines + crew per station/phase/business date). Pure rules in `src/lib/checklists/` (dates, applicability, number checks, progress) carry the logic and the tests. Thin API routes under `/api/checklists/*` follow the house route pattern. Four client pages under `/checklist/*` follow the Controla look. The old tables are left in place, unused.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma + PostgreSQL (Supabase, pgBouncer transaction pooler), Tailwind with the flat Controla tokens, vitest.

**Spec:** `docs/superpowers/specs/2026-10-29-station-checklists-design.md` (read it first: Part A).

## Global Constraints

- Work in the worktree `/Users/joshua/dev/fergies-os-checklists` on branch `feat/station-checklists` (it starts from `origin/main`). Never build in the main checkout. The worktree has no `node_modules` yet: run `npm install` there first. Node and npm live at `~/Desktop/node-install` (see the node-toolchain memory) and `.env` must be copied from the main checkout.
- Every route handler file has `export const dynamic = 'force-dynamic'`. Each handler catches `AuthError` → `NextResponse.json({ error }, { status })` and logs everything else as `console.error('<METHOD> <path>', e)` with a 500.
- Auth comes from `requireSession(minRole?)` (`src/lib/auth.ts`). RC writes go through `assertRcWritable(user, rcId)` (`src/lib/rc-scope.ts`).
- Business date comes from `businessDateLocal()` (`src/lib/eod-close.ts`), Pacific. Never use server wall-clock dates.
- Prisma `Decimal` reaches the client as a string, so wrap it in `Number()` before arithmetic or `.toFixed()`.
- Client pages start with `'use client'`. Sub-components live at module scope, never inside another component.
- Colours use the flat Tailwind tokens already in the app (`bg-paper`, `border-line`, `text-ink-3`, `bg-red-soft`, `text-red-text`, `bg-green`, `text-gold-2` …). Numbered colour classes are broken in this app. Every number, time, label and pill is `font-mono`. Titles and prose use the sans font. Tap targets are ≥44 px and phone buttons 50 px high. Bottom sheets sit over the scrim and are never blurred (no `backdrop-blur` on `fixed inset-0`).
- Copy uses kitchen words: "Before doors", "Before you leave", "Finish opening", "Sign off Grill", "Flag a problem", "Last night: …". No emoji.
- Every write a STAFF user can make is scoped to their RC. Nothing in `/api/checklists/*` returns money.
- **Live database:** local dev talks to the LIVE Supabase DB. Applying the migration (Task 1, step 4) and any browser test that ticks or signs off (Task 11) needs Joshua's explicit yes first. Stop and ask.

## Review Focus

1. **A close finished after midnight** (00:40) must land on the previous night's run, not create a new day. Covered by `shiftBusinessDate` tests in Task 2.
2. **Two cooks open the same station at the same moment.** There must be exactly one run with one set of lines and no 500. Covered by the `ensureRun` test in Task 4: upsert on the unique key, plus lines through `createMany({ skipDuplicates: true })`.
3. **A manager edits Grill's list at 10:00 while Grill's opening is under way.** Today's run keeps its lines; tomorrow's run gets the edit. Covered by the `ensureRun` "existing run is not re-snapshotted" test in Task 4.
4. **A cook types "3,5", " 4 ", "" or "abc" into a number.** "3,5" and " 4 " save as 3.5 and 4; "" and "abc" get a 400 "Enter a number". Covered by `parseReading` in Task 2 and the line-route test in Task 5.
5. **A tick on a signed-off run, or from a user outside the RC,** returns 409 or 403. Nothing is written. Covered by the line-route tests in Task 5.

---

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (new models after `OpenCheckTick`, back-relations on `RevenueCenter`, `TempUnit` and `User`)
- Create: `prisma/migrations/20261030000000_station_checklists/migration.sql`

**Interfaces:**
- Produces the Prisma models `ChecklistStation`, `ChecklistCategory`, `ChecklistItem`, `ChecklistRun`, `ChecklistRunLine`, `ChecklistRunCrew` and the enums `ChecklistPhase { OPEN CLOSE }`, `ChecklistAnswer { TICK NUMBER TEMP }`, `ChecklistLineStatus { TODO DONE FLAGGED }`, `ChecklistFlagReason { BROKEN RAN_OUT OUT_OF_RANGE OTHER }`, `ChecklistRunStatus { OPEN SIGNED }`.

- [ ] **Step 1: Add the models.** Fields and keys, exactly:
  - `ChecklistStation`: `id String @id @default(uuid())`, `revenueCenterId String`, `name String`, `color String @default("#71717a")`, `isShared Boolean @default(false)`, `sortOrder Int @default(0)`, `isActive Boolean @default(true)`, `createdAt`, `updatedAt`. Relation to `RevenueCenter` named `"ChecklistStationRC"`. `@@index([revenueCenterId, isActive])`.
  - `ChecklistCategory`: `id` uuid, `stationId`, `phase ChecklistPhase`, `name String`, `sortOrder Int @default(0)`, `isActive Boolean @default(true)`, timestamps. Station relation `onDelete: Cascade`. `@@index([stationId, phase])`.
  - `ChecklistItem`: `id` uuid, `categoryId`, `title String`, `howTo String?`, `isBlocker Boolean @default(false)`, `answer ChecklistAnswer @default(TICK)`, `unit String?`, `safeMin Decimal?`, `safeMax Decimal?`, `tempUnitId String?` (relation to `TempUnit`, `onDelete: SetNull`), `days Int @default(127)`, `sortOrder Int @default(0)`, `isActive Boolean @default(true)`, timestamps. Category relation `onDelete: Cascade`. `@@index([categoryId, isActive])`.
  - `ChecklistRun`: `id` uuid, `stationId` (relation, Cascade), `phase ChecklistPhase`, `businessDate String` ('YYYY-MM-DD'), `status ChecklistRunStatus @default(OPEN)`, `signedOffById String?`, `signedOffByName String?`, `signedOffAt DateTime?`, `handoverNote String?`, timestamps. `@@unique([stationId, phase, businessDate])`, `@@index([businessDate])`.
  - `ChecklistRunLine`: `id` uuid, `runId` (Cascade), `itemId String?` (relation to `ChecklistItem`, `onDelete: SetNull`), snapshot fields `categoryName String`, `title String`, `howTo String?`, `isBlocker Boolean`, `answer ChecklistAnswer`, `unit String?`, `safeMin Decimal?`, `safeMax Decimal?`, `tempUnitId String?` (plain column, no relation), `sortOrder Int`. Result fields: `status ChecklistLineStatus @default(TODO)`, `value Decimal?`, `doneById String?`, `doneByName String?`, `doneAt DateTime?`, `flagReason ChecklistFlagReason?`, `flagNote String?`, `resolvedById String?`, `resolvedByName String?`, `resolvedAt DateTime?`, `updatedAt`. `@@unique([runId, itemId])`, `@@index([runId])`, `@@index([status, resolvedAt])`.
  - `ChecklistRunCrew`: `id` uuid, `runId` (Cascade), `userId String`, `userName String`, `joinedAt DateTime @default(now())`. `@@unique([runId, userId])`, `@@index([userId])`.
  - Person ids are plain strings with no FK to `User`, the same as `EodClose.signedOffBy`. Hard-deleting a user must not erase history.

- [ ] **Step 2: Generate the SQL without the shadow DB** (it is broken on this project). Load env (`set -a && . ./.env; set +a`). Build the session-mode URL by taking `$DATABASE_URL`, changing port 6543 to 5432, and dropping `pgbouncer=true`. Then:
  `npx prisma migrate diff --from-url "$SESSION_URL" --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/20261030000000_station_checklists/migration.sql`
  Expected: only `CREATE TYPE`, `CREATE TABLE`, `CREATE INDEX` and `ADD CONSTRAINT` for the new objects. If any statement touches an existing table other than adding a FK from the new tables, stop and report it.

- [ ] **Step 3: `npx prisma generate` and `npm run build`.** Expected: the build passes. Nothing reads the models yet.

- [ ] **Step 4: STOP and ask Joshua** before applying, in plain words: "This adds new empty tables for the station lists to the live database. Nothing existing changes. OK to add them?" Only on his yes:
  `npx prisma db execute --url "$SESSION_URL" --file prisma/migrations/20261030000000_station_checklists/migration.sql`, then `DIRECT_URL="$SESSION_URL" npx prisma migrate resolve --applied 20261030000000_station_checklists`.

- [ ] **Step 5: Commit** `feat(checklists): station checklist tables`.

---

### Task 2: Pure rules

**Files:**
- Create: `src/lib/checklists/rules.ts`
- Test: `src/lib/__tests__/checklist-rules.test.ts`

**Interfaces:**
- Produces:
  - `type Phase = 'OPEN' | 'CLOSE'`
  - `shiftBusinessDate(phase: Phase, now?: Date): string`: OPEN gives `businessDateLocal(now)`; CLOSE gives `businessDateLocal(new Date(now.getTime() - 5 * 3600_000))`.
  - `defaultPhase(now?: Date): Phase`: OPEN when the Pacific hour is < 14.
  - `DAY_BITS = { MON: 1, TUE: 2, WED: 4, THU: 8, FRI: 16, SAT: 32, SUN: 64 } as const`, `EVERY_DAY = 127`
  - `dayBitFor(businessDate: string): number`: weekday of the 'YYYY-MM-DD' date, worked out from the date string, not the server timezone.
  - `appliesOn(days: number, businessDate: string): boolean`
  - `parseReading(raw: string): number | null`: trims, accepts a comma as the decimal point, null when empty or not a finite number.
  - `inRange(value: number, min: number | null, max: number | null): boolean`
  - `type LineLike = { status: 'TODO' | 'DONE' | 'FLAGGED'; isBlocker: boolean }`
  - `runProgress(lines: LineLike[]): { handled: number; total: number; done: number; flagged: number; blockersLeft: number }`, where handled = DONE + FLAGGED
  - `canSignOff(lines: LineLike[]): boolean`: blockersLeft === 0 and at least one line
  - `sharedRunComplete(lines: LineLike[]): boolean`: every line handled, false when empty
  - `daysLabel(days: number): string`: '' for 127, 'WED ONLY' for 4, 'MON · THU' for 9, 'WEEKDAYS' for 31, 'WEEKENDS' for 96

- [ ] **Step 1: Write the failing tests.** Assertions, exactly:
  - `shiftBusinessDate('CLOSE', new Date('2026-10-30T07:40:00Z'))` → `'2026-10-29'` (00:40 Pacific)
  - `shiftBusinessDate('OPEN', new Date('2026-10-30T07:40:00Z'))` → `'2026-10-30'`
  - `shiftBusinessDate('CLOSE', new Date('2026-10-30T05:30:00Z'))` → `'2026-10-29'` (22:30 Pacific)
  - `defaultPhase(new Date('2026-10-29T20:59:00Z'))` → `'OPEN'` (13:59 Pacific)
  - `defaultPhase(new Date('2026-10-29T21:00:00Z'))` → `'CLOSE'`
  - `dayBitFor('2026-10-29')` → `DAY_BITS.THU`
  - `dayBitFor('2026-11-01')` → `DAY_BITS.SUN`
  - `appliesOn(4, '2026-10-28')` → true; `appliesOn(4, '2026-10-29')` → false; `appliesOn(127, '2026-10-29')` → true
  - `parseReading('3,5')` → 3.5; `parseReading(' 4 ')` → 4; `parseReading('')` → null; `parseReading('abc')` → null; `parseReading('-18')` → -18
  - `inRange(4, 0, 4)` → true; `inRange(4.1, 0, 4)` → false; `inRange(-20, null, -18)` → true; `inRange(5, null, null)` → true
  - `runProgress` of [DONE blocker, FLAGGED blocker, TODO blocker, TODO] → `{ handled: 2, total: 4, done: 1, flagged: 1, blockersLeft: 1 }`
  - `canSignOff([{ status: 'FLAGGED', isBlocker: true }, { status: 'TODO', isBlocker: false }])` → true; `canSignOff([])` → false
  - `sharedRunComplete([{ status: 'DONE', isBlocker: false }, { status: 'FLAGGED', isBlocker: true }])` → true
  - `daysLabel` covers the five values listed above

- [ ] **Step 2:** Run `npx vitest run src/lib/__tests__/checklist-rules.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `rules.ts`. No Prisma and no React imports, so it is safe on the client.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(checklists): date, day and progress rules`.

---

### Task 3: Starter lists and seeding

**Files:**
- Create: `src/lib/checklists/starter.ts` (data plus the pure seed builder)
- Create: `src/lib/checklists/seed.ts` (`server-only`; DB)
- Test: `src/lib/__tests__/checklist-seed.test.ts`

**Interfaces:**
- Consumes: Task 1 models, `EVERY_DAY` from Task 2.
- Produces:
  - `STARTER_STATIONS: ReadonlyArray<StarterStation>`, where `StarterStation = { key: string; name: string; color: string; isShared: boolean; open: StarterCategory[]; close: StarterCategory[] }` and `StarterCategory = { name: string; items: StarterItem[] }`, `StarterItem = { title: string; howTo?: string; isBlocker?: boolean; answer?: 'TICK' | 'NUMBER'; unit?: string; safeMin?: number; safeMax?: number }`
  - `buildSeed(rcId: string, oldOpen: OldItem[], oldClose: OldItem[]): SeedRows`, where `OldItem = { section: string; title: string; meta: string | null; isBlocker: boolean; sortOrder: number }` and `SeedRows = { stations: StationRow[]; categories: CategoryRow[]; items: ItemRow[] }` (plain `createMany` data with ids filled in)
  - `seedStationsIfEmpty(rcId: string): Promise<void>`

- [ ] **Step 1: Fill in `STARTER_STATIONS`** from the mockup's "Starter lists" board (spec, Part A, "First open and moving the old lists").
  - The 8 stations in this order and colour: Whole kitchen `#71717a` shared · Grill `#dc2626` · Fryer `#ca8a04` · Sauté / hot line `#ea580c` · Garde manger `#16a34a` · Pastry `#db2777` · Dish `#0d9488` · Lead / pass `#2563eb`.
  - Each phase's items go in categories: OPEN uses "Before doors" (the blockers), then "Set-up"; CLOSE uses "Before you leave" (the blockers), then "Clean down".
  - "Lowboy temp °C" becomes `{ title: 'Lowboy temp', answer: 'NUMBER', unit: '°C', safeMin: 0, safeMax: 4, isBlocker: true, howTo: 'Probe the middle shelf, not the door' }`.
  - "Hot hold ≥60 °C logged" becomes NUMBER °C with min 60. "Machine wash ≥60 °C · rinse ≥82 °C" becomes two NUMBER items: wash min 60, rinse min 82.
- [ ] **Step 2: Write the failing tests:**
  - `buildSeed('rc1', [], [])` gives 8 stations, exactly one `isShared`. Every id is deterministic: the same call twice gives identical ids (`chk-${rcId}-${stationKey}`, `chk-${rcId}-${stationKey}-${phase}-${catIndex}`, `chk-${rcId}-${stationKey}-${phase}-${catIndex}-${itemIndex}`).
  - Given `oldOpen = [{ section: 'Food safety', title: 'Hand sinks stocked', meta: 'Soap, paper towel', isBlocker: true, sortOrder: 1 }, { section: 'Line set-up', title: 'Fryer oil checked', meta: null, isBlocker: false, sortOrder: 4 }]`, the shared station's OPEN categories are exactly `['Food safety', 'Line set-up']`. The first item has `howTo: 'Soap, paper towel'` and `isBlocker: true`. The starter "Whole kitchen" OPEN list is NOT used.
  - With empty old lists, the shared station gets the starter "Whole kitchen" lists.
  - The Grill OPEN "Lowboy temp" item row has `answer: 'NUMBER'`, `unit: '°C'`, `safeMin: 0`, `safeMax: 4`, `days: 127`.
- [ ] **Step 3:** Run the tests. Expected: FAIL.
- [ ] **Step 4: Implement `buildSeed`**, then `seedStationsIfEmpty(rcId)`:
  - Return early when `prisma.checklistStation.count({ where: { revenueCenterId: rcId } }) > 0` (inactive rows count, so a list emptied on purpose stays empty).
  - Return early when the RC's `type` is not `'FOOD'` (null means FOOD, as in `api/open-checklist`).
  - Read the active `openCheckItem` / `eodCheckItem` rows for the RC, ordered by sortOrder.
  - Run the three `createMany({ skipDuplicates: true })` in one `$transaction`.
- [ ] **Step 5:** Run the tests. Expected: PASS.
- [ ] **Step 6: Commit** `feat(checklists): starter lists and first-open seeding`.

---

### Task 4: Runs: snapshot on first open

**Files:**
- Create: `src/lib/checklists/runs.ts` (`server-only`)
- Create: `src/lib/checklists/snapshot.ts` (pure)
- Test: `src/lib/__tests__/checklist-snapshot.test.ts`, `src/lib/__tests__/checklist-runs.test.ts` (Prisma mocked with the `vi.mock('@/lib/prisma')` pattern from `src/app/api/tips/roster/[id]/__tests__/route.test.ts`)

**Interfaces:**
- Consumes: `appliesOn` (Task 2), the models (Task 1).
- Produces:
  - `snapshotLines(runId: string, categories: Array<{ name: string; sortOrder: number; isActive: boolean; items: Array<ItemTemplate> }>, businessDate: string): LineCreate[]`. `ItemTemplate` is the `ChecklistItem` row's fields. Lines are ordered by category sortOrder, then item sortOrder, with `sortOrder` renumbered 0..n-1. Inactive items, inactive categories and items whose `days` miss the date are skipped.
  - `ensureRun(stationId: string, phase: Phase, businessDate: string): Promise<{ id: string; created: boolean }>`
  - `type RunView = { id; stationId; phase; businessDate; status; signedOffByName; signedOffAt; handoverNote; lines: LineView[]; crew: { userId: string; userName: string }[] }`, where `LineView` has every line column, with `value`, `safeMin` and `safeMax` as `number | null` (already `Number()`-ed)
  - `loadRunView(runId: string): Promise<RunView>`
  - `lastHandover(stationId: string, beforeDate: string): Promise<{ note: string; byName: string | null; businessDate: string } | null>`: the most recent SIGNED CLOSE run of that station with businessDate < beforeDate and a non-empty note

- [ ] **Step 1: Write the failing tests:**
  - `snapshotLines`: a WED-only item is skipped on '2026-10-29' (Thursday) and kept on '2026-10-28'. An inactive category's items are skipped. The output order follows (category.sortOrder, item.sortOrder) and the output `sortOrder` is 0,1,2. `categoryName` is copied.
  - `ensureRun`, when no run exists: calls `checklistRun.upsert` with `where: { stationId_phase_businessDate: … }`, then `checklistRunLine.createMany` with `skipDuplicates: true`, and returns `created: true`.
  - `ensureRun`, when the run already exists (the upsert returns a row whose `createdAt` is more than 5 s before now): does NOT call `checklistCategory.findMany` or `createMany`, and returns `created: false`. This pins "edits don't change a started run". Detect "existing" by a `findUnique` before the upsert; when it finds a row, return it straight away.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** `ensureRun`:
  1. `findUnique` the run; if found, return `{ id, created: false }`.
  2. Otherwise `upsert` (create, `update: {}`).
  3. Load the station's categories for the phase with their items.
  4. `createMany(snapshotLines(...), skipDuplicates)`.
  5. Return `created: true`.

  Concurrent first opens are safe: the upsert hits the unique key and the lines hit `@@unique([runId, itemId])`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(checklists): runs snapshot the list on first open`.

---

### Task 5: Cook API

**Files:**
- Create: `src/app/api/checklists/route.ts` (GET)
- Create: `src/app/api/checklists/pick/route.ts` (POST)
- Create: `src/app/api/checklists/lines/[id]/route.ts` (PUT)
- Create: `src/app/api/checklists/runs/[id]/signoff/route.ts` (POST)
- Create: `src/app/api/checklists/runs/[id]/reopen/route.ts` (POST, LEAD)
- Create: `src/lib/checklists/apply-line.ts` (pure: decides the new line state)
- Test: `src/lib/__tests__/checklist-apply-line.test.ts`, `src/app/api/checklists/__tests__/lines.test.ts`, `src/app/api/checklists/__tests__/signoff.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces (the JSON shapes Tasks 6–8 render):
  - `GET /api/checklists?rcId=&phase=` → `{ phase, businessDate, stations: StationCard[], mine: RunView[], shared: RunView | null, handover: Record<stationId, { note, byName, businessDate }> }`
    - `StationCard = { id, name, color, isShared, crew: string[], jobCount: number, picked: boolean }`
    - `jobCount` = the number of lines in today's run when it exists, otherwise the applicable items.
    - The handler calls `seedStationsIfEmpty(rcId)` first.
    - `mine` = runs where the caller is crew. `shared` = the shared station's run (`ensureRun`'d whenever the caller has picked at least one station).
    - `phase` defaults to `defaultPhase()`.
  - `POST /api/checklists/pick { rcId, phase, stationIds: string[] }`:
    - 1–2 ids, all active, non-shared, belonging to rcId.
    - Ensures each run, upserts crew rows (`userName` = the user's name or email), and deletes the caller's crew rows on other runs of the same rcId/phase/date.
    - Returns the same body as GET.
  - `PUT /api/checklists/lines/[id]` with body `{ action: 'tick' } | { action: 'untick' } | { action: 'value'; raw: string } | { action: 'flag'; reason: 'BROKEN' | 'RAN_OUT' | 'OTHER'; note?: string }` → `{ line: LineView, progress }`
  - `applyLine(line: { answer; safeMin: number | null; safeMax: number | null }, input, who: { id: string; name: string }, now: Date): { data: LinePatch } | { error: string; status: 400 }`
    - tick on TICK → DONE + who/when
    - tick on NUMBER/TEMP → 400 'Enter a reading'
    - untick → TODO, clears value, doneBy and flag
    - value: `parseReading`; null → 400 'Enter a number'; in range → DONE with value; out of range → FLAGGED with `flagReason: 'OUT_OF_RANGE'` and value
    - flag: FLAGGED with reason and note, who/when
  - `POST /api/checklists/runs/[id]/signoff { handoverNote?: string }`:
    - 409 `{ error: 'N before-doors jobs left' }` (OPEN) or `'N jobs left before you leave'` (CLOSE) when `!canSignOff`
    - 409 on a shared station ('The whole-kitchen list has no sign-off')
    - Sets SIGNED, signer and time, and `handoverNote` (CLOSE only, trimmed, empty → null)
  - `POST /api/checklists/runs/[id]/reopen` (LEAD): SIGNED → OPEN and clears the signer.

- [ ] **Step 1: Write the failing `applyLine` tests** for each branch above, with exact values:
  - value '5' on safeMax 4 → `status: 'FLAGGED', flagReason: 'OUT_OF_RANGE', value: 5`
  - value '3,5' → `status: 'DONE', value: 3.5`
  - value 'abc' → `{ error: 'Enter a number', status: 400 }`
  - untick → `status: 'TODO', value: null, flagReason: null, doneById: null`
- [ ] **Step 2: Write the failing route tests** (`lines.test.ts`), mocking prisma, `requireSession` and `assertRcWritable`:
  - A line whose run is SIGNED → 409 `{ error: 'Signed off — ask a lead to reopen' }`, no `checklistRunLine.update` call.
  - `assertRcWritable` throws `AuthError(403)` → 403, no update.
  - A TEMP line with `tempUnitId: 'u1'` and value '3.5' → `tempReading.create` called with `{ unitId: 'u1', logDate: run.businessDate, temp: 3.5, recordedBy: 'Sam Lee' }` and a `time` matching `/^\d{2}:\d{2}$/`.
  - 'abc' → 400 'Enter a number'.
- [ ] **Step 3: Write the failing `signoff.test.ts`:**
  - 1 blocker TODO on OPEN → 409 '1 before-doors jobs left' (use "job" when N = 1: '1 before-doors job left').
  - A FLAGGED blocker → 200, `status: 'SIGNED'`.
  - A shared station → 409.
- [ ] **Step 4:** Run `npx vitest run src/lib/__tests__/checklist-apply-line.test.ts src/app/api/checklists`. Expected: FAIL.
- [ ] **Step 5: Implement** `applyLine` and the five routes.
  - Every route resolves the run → station → `revenueCenterId` and calls `assertRcWritable` before writing.
  - Locked-run check: the run status must be OPEN for PUT lines.
  - The line PUT and the TEMP reading write share one `$transaction`.
- [ ] **Step 6:** Run the same tests. Expected: PASS. Then run `npm test`. Expected: all green.
- [ ] **Step 7: Commit** `feat(checklists): cook API — pick, tick, log, flag, sign off`.

---

### Task 6: Cook screen `/checklist`

**Files:**
- Create: `src/app/checklist/page.tsx`
- Create: `src/components/checklists/StationPicker.tsx`, `ChecklistView.tsx`, `LineRow.tsx`, `LineSheet.tsx`, `SignOffFooter.tsx`
- Test: none in vitest (UI). Verified in Task 11.

**Interfaces:**
- Consumes: the Task 5 JSON. `useRc()` for `activeRcId` (wait for `ready`; see the speed-audit memory "loaders must wait for useRc().ready"). `useUser()` for the name. `GET /api/prep/me` for `homeStation`. `runProgress`, `canSignOff`, `daysLabel` and `defaultPhase` from Task 2.

- [ ] **Step 1: Page shell.** It follows the mockup boards "Cook · Opening", "Cook · Closing" and "Cook · Pick your station":
  - "‹ Today" link.
  - Opening/Closing segmented switch, held in the `?phase=` search param.
  - Crumb `WED 29 OCT · OPENING`.
  - Greeting "Morning, *Name*." for OPEN and "Close down, *Name*." for CLOSE. Only the name is Fraunces italic, in gold-2.
  - Lede: "Doors at 9:00. **N things** must be done before then." / "**N things** left before you can sign off Grill." / green "Everything for doors is done…".
  - The doors time comes from the RC's first service start, read the way `CookStart` already does. If there is none, drop the "Doors at" clause.
- [ ] **Step 2: `StationPicker`** is a bottom sheet titled "Where are you today?". It lists non-shared stations with a colour dot and the meta "YOUR USUAL · 12 JOBS · NOBODY ON IT YET" / "LEO IS ON IT", with a tick box on each row and a limit of 2.
  - The pre-tick is the station whose name equals `homeStation` (case-insensitive, trimmed). If there is no match, nothing is pre-ticked.
  - The button reads "Start Grill opening →" (or "Start Grill + Fryer closing →") and POSTs `/pick`.
  - The sheet opens automatically when `mine` is empty. The "On Grill today · change ▾" chip reopens it.
- [ ] **Step 3: `ChecklistView`** has a progress card (`handled / total`, a green bar plus a red segment for flagged) and one card per run.
  - The shared run's lines are merged into the first card with a KITCHEN pill.
  - Sections: blockers first, under "BEFORE DOORS · N LEFT" (OPEN) or "BEFORE YOU LEAVE · N LEFT" (CLOSE), red while N > 0. Then each `categoryName` in line order, with the counts "x/y".
  - If there is a `handover` for the station on an OPEN run, a top row reads "Last night: <note> — Leo".
- [ ] **Step 4: `LineRow`**: a 26 px box (green when done, red "!" when flagged, red border on an urgent blocker); the title (struck through when done); a mono sub-line (who · time · value, the meta, or the flag text); and pills (KITCHEN, `daysLabel`). A TICK row toggles optimistically on tap and rolls back with a toast on error. NUMBER/TEMP rows open `LineSheet`, and a long-press or the "⋯" button opens it on TICK rows for flagging.
- [ ] **Step 5: `LineSheet`** follows the "Log a number or flag a problem" board:
  - Pills (BEFORE DOORS when blocker, station name), title, howTo.
  - Number input (`inputmode="decimal"`) with the unit and a live hint: "In range · safe 0–4 °C" (green) or "Above 4 °C — saves as a problem" (red).
  - "Save 3.5 °C and tick ✓".
  - "Can't do it? Flag it instead" with reason chips Broken / Ran out / Other…, an optional note, and the copy "Shows on the manager's screen. A flagged job counts as handled, so it won't hold up your sign-off."
  - A LAST TIME row shows the previous reading of this item (from the history API in Task 8: hide it until that exists, then add it).
- [ ] **Step 6: `SignOffFooter`** has a disabled "Finish opening · N before doors left" / "Sign off Grill · N left" button, and an enabled ink button with a gold arrow. On CLOSE there is a "Note for tomorrow's opener" textarea above it with the caption "SHOWS FIRST ON GRILL'S OPENING LIST". Signed state: a green line "Signed off by Leo · 22:48", plus "Reopen" for LEAD+.
- [ ] **Step 7:** Run `npm run build`. Expected: passes, and `/checklist` is listed.
- [ ] **Step 8: Commit** `feat(checklists): cook checklist screen`.

---

### Task 7: Manager today + flags

**Files:**
- Create: `src/app/api/checklists/today/route.ts` (GET, LEAD)
- Create: `src/app/api/checklists/lines/[id]/resolve/route.ts` (POST, LEAD)
- Create: `src/lib/checklists/station-status.ts` (pure)
- Create: `src/app/checklist/today/page.tsx`
- Test: `src/lib/__tests__/checklist-station-status.test.ts`

**Interfaces:**
- Produces:
  - `stationStatus(input: { isShared: boolean; run: { status: 'OPEN' | 'SIGNED'; lines: LineLike[] } | null; phase: Phase }): { label: string; tone: 'red' | 'gold' | 'green' | 'grey' }`
    - no run → `NOT STARTED` red
    - SIGNED, or a shared run that is complete → `DONE` green
    - blockersLeft > 0 → `N BEFORE DOORS` (OPEN) / `N BEFORE YOU LEAVE` (CLOSE), gold
    - any FLAGGED → `N FLAGGED` gold
    - otherwise → `IN PROGRESS` grey
  - `GET /api/checklists/today?rcId=&phase=` → `{ phase, businessDate, stations: Array<{ id, name, color, isShared, crew: string[], handled, total, status: { label, tone }, signedOffByName, signedOffAt }>, flags: Array<{ lineId, stationName, title, reason, note, value, unit, byName, at }> }`
    - `flags` = FLAGGED lines with `resolvedAt` null on runs of this RC from the last 7 business dates.
    - Stations sort with NOT STARTED first, then gold, then green.
  - `POST /api/checklists/lines/[id]/resolve` sets `resolvedById/Name/At`. 409 if the line is not FLAGGED.

- [ ] **Step 1:** Write the failing `stationStatus` tests covering every branch, including the exact label `'3 BEFORE DOORS'`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the rule and the two routes. Do not seed or `ensureRun` in GET: a station with no run is "not started".
- [ ] **Step 4:** Build the page from the "Manager · Today, every station" board:
  - Opening/Closing switch and a "History →" link.
  - Lede "Doors in 1h 08m. **Garde manger hasn't started** and 1 problem is flagged." The red clause names the first NOT STARTED station; drop it when there is none.
  - Stations card, rows with progress bars.
  - Flagged card with "Mark fixed".
  - The dashed quiet line "Temps all in range" (from `computeTempsReady`-style data already on `/api/temps/units`; omit it if that adds a fetch the page doesn't have).
  - Poll every 30 s while visible.
- [ ] **Step 5:** Run the tests and `npm run build`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(checklists): manager today board and flags`.

---

### Task 8: History

**Files:**
- Create: `src/app/api/checklists/history/route.ts` (GET, MANAGER)
- Create: `src/lib/checklists/history-csv.ts` (pure)
- Create: `src/app/checklist/history/page.tsx`
- Test: `src/lib/__tests__/checklist-history-csv.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/checklists/history?rcId=&date=YYYY-MM-DD&userId=&stationId=` → `{ date, days: Array<{ date, state: 'ok' | 'miss' | 'none' }>, runs: Array<RunView & { stationName, color, isShared }> }`
    - `days` = the 7 dates ending at `date`. `miss` = some non-shared run that day was not SIGNED.
    - The `userId` filter keeps runs where that user is crew or did any line, and within those runs keeps every line (context matters).
    - `stationId` filters runs.
  - `GET /api/checklists/history/people?rcId=` → `{ people: Array<{ userId, name }> }`: distinct crew from the last 60 days, for the filter.
  - `historyCsv(runs): string`. Header exactly `date,phase,station,job,status,value,unit,by,at,flag,note,signed_by,signed_at`. One row per line. Times are Pacific `HH:MM`. Fields are quoted when they contain a comma, quote or newline.
- [ ] **Step 1:** Write the failing CSV tests: the header, quoting of `Low on brioche, 1 case left`, a flagged row carrying `OUT_OF_RANGE` and the value.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the route, CSV and page from the "Manager · History by day" board:
  - a 7-day strip with dots
  - Everyone ▾ / All stations ▾ / Pick a date… (native `<input type="date">`)
  - the lede "**Tue 28 Oct.** 10 of 11 lists signed off. **Pastry closing** was never signed."
  - Closing and Opening cards, each run expandable to its line log
  - "Export ↓" downloads the CSV for the shown filters, built client-side with `historyCsv`
- [ ] **Step 4:** Back in `LineSheet` (Task 6, step 5), add LAST TIME: `GET /api/checklists/lines/[id]/last` → `{ value, unit, byName, at } | null`. It is the latest DONE/FLAGGED line with the same `itemId` and a value, before this run. The route is STAFF-level, because a cook needs it.
- [ ] **Step 5:** Run the tests and `npm run build`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(checklists): history by day with export`.

---

### Task 9: Editor

**Files:**
- Create: `src/app/api/checklists/stations/route.ts` (GET, POST), `src/app/api/checklists/stations/[id]/route.ts` (PATCH, DELETE)
- Create: `src/app/api/checklists/categories/route.ts` (POST), `src/app/api/checklists/categories/[id]/route.ts` (PATCH, DELETE)
- Create: `src/app/api/checklists/items/route.ts` (POST), `src/app/api/checklists/items/[id]/route.ts` (PATCH, DELETE)
- Create: `src/app/api/checklists/reorder/route.ts` (POST), `src/app/api/checklists/copy/route.ts` (POST)
- Create: `src/lib/checklists/item-input.ts` (pure validation)
- Create: `src/app/checklist/edit/page.tsx`, `src/components/checklists/edit/ItemSheet.tsx`, `CategoryCard.tsx`, `StationChips.tsx`
- Test: `src/lib/__tests__/checklist-item-input.test.ts`

**Interfaces:**
- Produces:
  - `parseItemInput(body: unknown): { ok: true; data: ItemData } | { ok: false; error: string }`. `ItemData = { title; howTo: string | null; isBlocker; answer; unit: string | null; safeMin: number | null; safeMax: number | null; tempUnitId: string | null; days: number; categoryId }`. Rules:
    - title trimmed, 1–120 chars ('Give the job a name')
    - days 1–127 ('Pick at least one day')
    - NUMBER needs a unit ('Add a unit, e.g. °C') and min ≤ max when both are set ('Safe range is back to front')
    - TEMP needs `tempUnitId` ('Pick a fridge or unit'); unit, min and max are forced to null (they come from the TempUnit)
    - TICK forces unit, min, max and tempUnitId to null
  - Every route is MANAGER and checks the target's station RC with `assertRcWritable`.
  - DELETE on a station, category or item sets `isActive: false`. History lines keep their snapshots.
  - `GET /api/checklists/stations?rcId=` → `{ stations: Array<{ id, name, color, isShared, isActive, phases: { OPEN: CategoryTree[]; CLOSE: CategoryTree[] } }>, tempUnits: Array<{ id, name, safeMin, safeMax }> }`. Only active categories and items. Calls `seedStationsIfEmpty`.
  - `POST /api/checklists/reorder { kind: 'category' | 'item'; ids: string[] }` rewrites `sortOrder` to the array index. All ids must share one parent; otherwise 400.
  - `POST /api/checklists/copy { fromStationId, toStationId, phase }` appends copies of the from-station's active categories and items for that phase onto the to-station. Category names already on the target get " (copy)".
  - A new station may not set `isShared` (exactly one per RC, seeded).
- [ ] **Step 1:** Write the failing `parseItemInput` tests for every rule and message above, plus a valid TEMP and a valid TICK round-trip.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the validation and routes.
- [ ] **Step 4:** Build the page from the "Manager · Edit a list" and "Manager · Edit an item" boards:
  - "‹ Today" back link (not Setup), "Copy from…"
  - Station chips (Everyone first, scrolling sideways) with "+ Station"; a long-press or the "Edit" chip menu offers Rename, Colour (the 8 palette dots) and Remove.
  - Opening/Closing switch with counts.
  - The note "Changes start on the next shift. Lists already started keep what they had, so history stays true."
  - Category cards with up/down buttons per row (aria-labels "Move up" / "Move down"), item pills (BEFORE DOORS, NUMBER °C 0–4, TEMP · Walk-in, days label) and "+ Add item".
  - "+ Add category".
  - `ItemSheet` holds the fields from the board: "A tick / A number / A temperature" with the unit/range or the Temps-unit picker, the day toggles, the category select, Remove and "Save item ✓".
- [ ] **Step 5:** Run the tests and `npm run build`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(checklists): edit stations, categories and items`.

---

### Task 10: Wire into the app

**Files:**
- Modify: `src/lib/route-access.ts` (add entries), `src/lib/__tests__/route-access.test.ts`
- Modify: `src/lib/nav-items.ts` (TODAY group: replace `{ href: '/end-of-day' … }` with `{ href: '/checklist', label: 'Open & close', icon: ListChecks }`; keep End-of-day under it for LEAD+), `src/lib/__tests__/nav-items.test.ts`
- Modify: `src/components/start/CookStart.tsx` (replace `OpeningCard` with `ChecklistCard`); Create: `src/components/start/ChecklistCard.tsx`
- Modify: `src/lib/start-page.ts` (`NeedKind` adds `'checklist'`; `NeedsInput` adds `checklistFlags: Array<{ lineId: string; title: string; stationName: string; byName: string | null }>`), `src/lib/__tests__/start-page.test.ts`, and `src/components/start/useStartData.ts`, the one place that builds `NeedsInput` (fetch `/api/checklists/today?rcId=&phase=OPEN` alongside its other loads and pass `flags`; skip the fetch below LEAD)
- Modify: `src/app/api/eod/close/signoff/route.ts` and `src/app/api/eod/close/route.ts` (gate) plus `src/lib/eod-close.ts` (new pure `stationsClosed`); `src/app/end-of-day/eod-components.tsx` (the checklist block)
- Modify: `src/middleware.ts` `REDIRECTS`: `/setup/open-checklist` and `/setup/eod-checklist` → `/checklist/edit`
- Test: `src/lib/__tests__/eod-stations-closed.test.ts`

**Interfaces:**
- Produces:
  - `ROUTE_CLEARANCE` adds `['/checklist/today', 'LEAD']`, `['/checklist/history', 'MANAGER']`, `['/checklist/edit', 'MANAGER']`. `/checklist` itself is STAFF, so it gets no entry.
  - `checklistNeeds(flags): NeedItem[]`: one `now` need per flag, title `'<title> · flagged'`, detail `'<stationName> · <byName>'`, href `/checklist/today`. Capped by `buildNeeds`'s existing max.
  - `stationsClosed(runs: Array<{ isShared: boolean; status: 'OPEN' | 'SIGNED' }>): { signed: number; total: number; ready: boolean }`: shared runs excluded; ready when signed === total (true when total is 0).
- [ ] **Step 1:** Write the failing tests:
  - `requiredClearance('/checklist')` → null; `'/checklist/today'` → 'LEAD'; `'/checklist/history'` → 'MANAGER'; `'/checklist/edit'` → 'MANAGER'
  - the nav test's TODAY group contains `/checklist`
  - `stationsClosed([{ isShared: true, status: 'OPEN' }, { isShared: false, status: 'SIGNED' }, { isShared: false, status: 'OPEN' }])` → `{ signed: 1, total: 2, ready: false }`
  - `buildNeeds` with one flag gives a `checklist` need ranked with the `now` items
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The EOD gate in `signoff` and in the `GET close` progress replaces the old checklist with: `computeTempsReady` AND `stationsClosed(today's CLOSE runs for the RC).ready`. The CLOSE date is `shiftBusinessDate('CLOSE')`. Keep the response field names the page reads; rename only what the page also changes.
  - `eod-components.tsx`: the close-down block becomes one card, "Station closing · 4 of 6 signed off", listing each station with its status pill, a link "Open the station board →" (`/checklist/today?phase=CLOSE`) and the temps row unchanged.
  - `ChecklistCard` on the cook start page:
    - before a pick: "Pick your station to start opening →"
    - after: "Grill opening · 6 of 12 · 3 before doors" (red when blockers > 0 and before doors), linking to `/checklist`
    - all done: the green fold line "Opening done · 12 of 12"
- [ ] **Step 4:** Run `npm test`. Expected: all green.
- [ ] **Step 5: Commit** `feat(checklists): wire into start page, end-of-day and nav`.

---

### Task 11: Verify

- [ ] **Step 1:** Run `npm test`, `npm run lint` and `npm run build` in the worktree. Expected: all pass. Every `/api/checklists/*` route shows `ƒ (Dynamic)`.
- [ ] **Step 2: STOP and ask Joshua** before any browser test that writes: "To test, I'll open Grill's list on the live app's database, tick 2 jobs, then untick them and delete that test run. OK?" On his yes:
  - Run the dev server from the worktree (see the "Preview serves the MAIN checkout" memory: point `.claude/launch.json` at the worktree or run it from there).
  - On a 390-wide viewport: pick Grill, tick a TICK line, log "5" on Lowboy temp (expect a red flag), flag a line "Broken", check the Today board shows the flag, mark it fixed, check History shows all three events with names and times.
  - Then delete the test run(s) by id and say so.
- [ ] **Step 3:** Take screenshots of `/checklist`, `/checklist/today`, `/checklist/history` and `/checklist/edit` at phone width for the PR.
