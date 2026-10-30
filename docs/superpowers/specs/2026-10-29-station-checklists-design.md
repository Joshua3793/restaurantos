# Station checklists + PIN sign-in — design

**Date:** 2026-10-29 · **Owner:** Joshua · **Status:** approved mockup, building
**Mockup:** https://claude.ai/artifact/7EsAPSNKXKGg7Z6t91Q6EC (12 boards: sign-in row, cook row, manager row, starter lists)

## Why

Opening and closing today are two kitchen-wide lists (`OpenCheckItem`, `EodCheckItem`), one per revenue center. They are not split by station. The closing list lives on `/end-of-day`, which is LEAD+ and mixes in money, so cooks never use it: the last close on Kitchen was 2 Jul 2026. A tick stores a typed name (`doneByName`), not a person, and there is no history view. 20 of 24 cooks have no login of their own, so a tick from the shared kitchen login says nothing about who did the job.

## What Joshua decided (2026-10-29)

1. Each cook gets a **designated list per station**, one for opening and one for closing, plus a few **whole-kitchen** jobs everyone sees.
2. **Blockers** stay. A blocker must be done or **flagged** before the station can sign off.
3. **Categories and items are fully editable** by managers: names, order, blocker, answer type, which days.
4. **Every tick records the signed-in person and time.** A manager can see the history for any date.
5. **Each cook signs in as themselves.** They use the **clock-in PIN**, which is the employee number already stored as `Cook.clockId` (confirmed by Joshua). A **manager OKs each new phone once**. After that the PIN alone signs them in on that phone.
6. **The cook picks their station** at the start of each shift. Their usual station (`Cook.homeStation`) is pre-ticked. They can tick two stations when covering.

## Part A — Station checklists

### Model

- **Station** (`ChecklistStation`): belongs to one revenue center. Fields: name, colour (hex from the category palette), sortOrder, isActive. `isShared = true` marks the single "Whole kitchen" station whose jobs show on everyone's list. There is at most one shared station per RC.
- **Category** (`ChecklistCategory`): belongs to a station and a phase (`OPEN` | `CLOSE`). Fields: name, sortOrder, isActive.
- **Item** (`ChecklistItem`): belongs to a category. Fields:
  - title
  - howTo (optional, shown to the cook)
  - isBlocker
  - answer: `TICK` | `NUMBER` | `TEMP`
  - unit, safeMin, safeMax (NUMBER only)
  - tempUnitId (TEMP only; the range comes from the TempUnit)
  - days (bitmask Mon=1 … Sun=64; 127 = every day)
  - sortOrder, isActive
- **Run** (`ChecklistRun`): one per (station, phase, business date). Fields:
  - status `OPEN` | `SIGNED`
  - signedOffById, signedOffByName, signedOffAt
  - handoverNote (CLOSE only)
- **Run line** (`ChecklistRunLine`): a **snapshot** of an item, taken the first time the run is opened. It copies title, howTo, isBlocker, answer, unit, safeMin, safeMax, tempUnitId, categoryName and sortOrder, and keeps `itemId` (SetNull). Its result fields:
  - status `TODO` | `DONE` | `FLAGGED`
  - value (Decimal)
  - doneById, doneByName, doneAt
  - flagReason `BROKEN` | `RAN_OUT` | `OUT_OF_RANGE` | `OTHER`, flagNote
  - resolvedById, resolvedByName, resolvedAt

  **List edits never change a run that has already started.** "Changes start on the next shift", so history stays true.
- **Crew** (`ChecklistRunCrew`): who picked the station for that run (runId, userId, userName, joinedAt), unique per (run, user).

### Rules (pure, in `src/lib/checklists/`)

- **Business date per phase.** OPEN uses `businessDateLocal(now)`. CLOSE uses `businessDateLocal(now − 5h)`, so a close finished at 00:40 still belongs to the night before.
- **Default phase:** OPEN before 14:00 Pacific, CLOSE from 14:00. The Opening/Closing switch overrides it.
- **Today's items.** An item belongs in a run when it is active, its category is active, its station matches, its phase matches, and the bit for the business date's weekday is set in `days`.
- **Number answers.** A value outside [safeMin, safeMax] (either bound may be null) saves the line as `FLAGGED` with reason `OUT_OF_RANGE`. It never counts as DONE.
- **TEMP answers** also write a `TempReading` (unitId, logDate = the run's business date, time = HH:MM Pacific, recordedBy = the person's name). The Temps log and the end-of-day temps gate stay right without anyone logging the reading twice.
- **Blockers left** = blocker lines still `TODO`. A run can sign off when blockers left = 0. Non-blocker lines left `TODO` are allowed; history shows them as missed.
- **The shared station never signs off.** Its run counts as done when every line is DONE or FLAGGED.
- **Signed runs are locked.** Ticks, unticks and flags return 409. A LEAD+ can reopen a run.
- **Handover.** The closing note shows at the top of the same station's next OPEN run, as the line "Last night: …".

### Who can do what

| Action | Minimum |
| --- | --- |
| See and tick their list, flag, sign off, pick a station | STAFF, within RCs they can write (`assertRcWritable`) |
| Today board (every station), mark a flag fixed, reopen a run | LEAD |
| History | MANAGER |
| Edit stations, categories, items | MANAGER (was ADMIN) |

### Screens (mockup boards → routes)

- `/checklist`: the cook's screen (mobile first, one fluid column on desktop).
  - The station picker opens when the cook has not picked for this run.
  - Then the list grouped "Before doors / Before you leave" first, then by category.
  - Shared lines carry a KITCHEN pill.
  - NUMBER and TEMP lines open the log sheet (number + flag). TICK lines tick on tap.
  - Any line can be flagged from its sheet.
  - CLOSE adds the handover note.
  - The footer button is "Finish opening" or "Sign off <station>", disabled with "N left" while blockers are open.
- `/checklist/today` (LEAD): every station for the phase, with progress, crew and status pill (NOT STARTED, N BEFORE DOORS, N FLAGGED, DONE). Below it, open flags with "Mark fixed".
- `/checklist/history` (MANAGER): a 7-day strip plus "Pick a date", person and station filters. Each run expands to its line log (time, job, who, value or flag). CSV export of the shown day.
- `/checklist/edit` (MANAGER): station chips (add / rename / colour / remove), Opening/Closing switch, categories with items, "+ Add item", "+ Add category", "Copy from…" another station. The item sheet holds title, howTo, blocker, answer (tick / number / temperature with unit and safe range, or a Temps unit), days, category, Remove. Up/down reorder (drag is a nice-to-have).
- **Cook start page** (`CookStart`): the opening card is replaced by a card showing the current run's progress ("Grill opening · 6 of 12 · 3 before doors") that links to `/checklist`.
- **Manager start page** (`buildNeeds`): open flags become "now" needs, e.g. "Mixer guard broken · Pastry · Ana".
- **`/end-of-day`**: its close-down checklist block becomes "Station closing: 4 of 6 signed off" with a link to `/checklist/today?phase=CLOSE`. The EOD sign-off gate becomes: temps ready AND every non-shared station that has a CLOSE run today is SIGNED.
- `/setup/open-checklist` and `/setup/eod-checklist` redirect to `/checklist/edit`.

### First open and moving the old lists

The first time an RC's stations are read and it has none (inactive ones count), it is seeded. FOOD RCs only; a bar starts empty. Seed ids are deterministic, so two first-opens at once cannot double-seed.

- **Whole kitchen** (shared):
  - OPEN gets the RC's existing active `OpenCheckItem` rows, keeping section → category, title, meta → howTo and isBlocker.
  - CLOSE gets the existing active `EodCheckItem` rows, mapped the same way.
  - If an RC has none of either, it gets the starter "Whole kitchen" list.
- **Grill, Fryer, Sauté / hot line, Garde manger, Pastry, Dish, Lead / pass**, each with the starter lists from the mockup's last board. Blockers are marked there; "Lowboy temp °C" becomes a NUMBER item, °C, 0–4.

The old tables and routes stay, read-only and unused, until a follow-up drop after the build is live.

## Part B — PIN sign-in

### Flow (mockup sign-in row, with one change)

The cook types the PIN **first**; the app then asks "Sam L., is this you?". The mockup showed "find your name" first. That would put the crew's names on a public page, so it is dropped.

1. `/auth/pin` (public). Keypad. POST `{ pin }`.
2. PIN not found → "PIN not recognised", and the attempt is counted.
3. Found, and this phone already holds an **approved device** for that cook → signed in, then `/checklist`.
4. Found but the phone is not approved → "Sam L., is this you?" → yes → a **pending device** is created and the phone shows "A manager needs to OK this phone". It polls every 4 s and signs in by itself once approved.
5. A manager approves either from the "Crew sign-in" screen (Approve / Not them) or on the cook's phone ("Manager types their PIN here": a manager-role cook's PIN approves this phone).

### Rules

- **Device** = a random 32-byte token in an httpOnly, Secure, SameSite=Lax cookie `pin_device` (400 days), stored only as a SHA-256 hash. Statuses: `PENDING` | `APPROVED` | `REJECTED` | `REVOKED`. One phone can hold approvals for several cooks (the shared kitchen iPad). Clearing cookies makes it a new phone.
- **Lockout.** 5 failed PIN tries in 15 minutes, per IP and per cook, returns 429 "Too many tries — wait 15 minutes". Attempts go in a table; there is no Redis.
- **The account.** A cook with no login gets one the first time an approved device signs in:
  - a Supabase user with the synthetic email `pin.<cookId>@crew.controlaos.vercel.app` (never emailed; `email_confirm: true`) and `user_metadata { role: 'STAFF', isActive: true, name }`
  - a Prisma `User` with the same id
  - `Cook.userId` set to it

  A cook already linked to a login (4 today) signs in **as that login**. An inactive linked user is refused (403 "This login is switched off").
- **Session minting.** The server calls `admin.generateLink({ type: 'magiclink', email })` and then `verifyOtp({ type: 'magiclink', token_hash })` on a cookie-bound server client. The Set-Cookie values are buffered onto the response, the same pattern as `/auth/callback`. From then on, middleware and `requireSession` see an ordinary Supabase session.
- **The PIN is not a secret.** It is printed on clock reports. The device OK is the security; never sign in on the PIN alone from an unapproved device.
- **Roles.** PIN accounts start as STAFF with no scope rows (that is, all RCs, the same as today's shared login). A manager can change both in People.

### Screens

- `/login` gets a "Kitchen crew? Sign in with your PIN" link to `/auth/pin`.
- `/auth/pin` covers the keypad, the "is this you?" step, waiting for an OK, and the manager PIN on the spot.
- `/checklist/crew` (MANAGER) is "Crew sign-in": pending phones first (Approve / Not them), then every active cook with a status (SET UP · n phones, WAITING, NOT YET, NO PIN when `clockId` is empty) and a Revoke for each phone. A pending count also shows as a card on `/checklist/today`.

## Not in this build

- Photo answers.
- Push notifications. Flags show on the manager's screens instead, so the copy "the manager gets told right away" becomes "shows on the manager's screen".
- Drag-to-reorder (up/down instead).
- Dropping the old opening and EOD tables.
