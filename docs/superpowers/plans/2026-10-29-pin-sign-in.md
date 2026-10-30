# PIN Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each cook sign in on their own phone with the PIN they clock in with (`Cook.clockId`), after a manager OKs that phone once, so every checklist tick carries a real person.

**Architecture:**
- A phone is a **device**: a random token in an httpOnly cookie, stored only as a hash, approved per cook.
- A public route checks PIN + device, then **mints a normal Supabase session**. It does this through `admin.generateLink({ type: 'magiclink' })` and a server-side `verifyOtp`, buffering cookies like `/auth/callback`. So middleware and `requireSession` need no change.
- Failed attempts are counted in a table for lockout.

**Tech Stack:** Next.js 14 route handlers, `@supabase/ssr` + `@supabase/supabase-js` admin client, Prisma, Node `crypto`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-29-station-checklists-design.md`, Part B.

**Order:** build after `2026-10-29-station-checklists.md`, on the same branch. It only needs that plan's routes for its "Crew sign-in" link and the Today-board card.

## Global Constraints

- Every Global Constraint in the station-checklists plan applies, including the live-database stops.
- PINs are the Toast clock-in PINs as they are: 3 to 5 digits today, accepted as 3–8. Never pad them, and never assume a length.
- The PIN is NOT a secret: it is printed on clock reports and tip exports. **Never create a session for an unapproved device.** Never log a PIN or a raw device token. Never return whether a PIN exists without counting the attempt.
- Lockout is exactly **5 failed tries in 15 minutes, per IP and per cook**. The answer is 429 `{ error: 'Too many tries — wait 15 minutes' }`.
- The device cookie is `pin_device`: httpOnly, `secure` in production, `sameSite: 'lax'`, `path: '/'`, `maxAge` 400 days. The DB stores only `sha256(token)` as hex.
- The synthetic login email is exactly `pin.<cookId>@crew.controlaos.app`. It is created with `email_confirm: true` and never emailed. New PIN accounts get `role: 'STAFF'`, `isActive: true`, no `UserScope` rows, and Prisma `User.id` equal to the Supabase id. Both stores are written together (see the CLAUDE.md "Two-store sync invariant").
- Display name is the first name plus the last initial: `"Sam L."` (from `Cook.name` and `Cook.lastName`, or the second word of `name` when `lastName` is null).
- Public PIN routes live under `/api/auth/pin/*`. The page is `/auth/pin` (already public through middleware `PUBLIC_PREFIXES`).

## Review Focus

1. **A cook clears their browser cookies** and comes back with the PIN. They get the "is this you?" step and a new pending device, never a session. Covered by the Task 3 route test "no cookie → needsConfirm".
2. **Someone guesses PINs from one phone.** The 6th wrong try within 15 minutes is refused even when it is a correct PIN. Covered by the Task 3 lockout test.
3. **A cook already linked to an email login** (4 today) signs in as that same user. No second account is created. Covered by the `ensurePinUser` test in Task 2.
4. **A manager rejects or revokes a phone** while the cook's screen is polling. The poll shows "This phone wasn't OK'd", and any later PIN try on that device needs a fresh OK. Covered by the Task 3 status test and the Task 4 revoke test.
5. **The supplied manager PIN belongs to a STAFF cook, or to an inactive manager.** 403 'Only a manager can OK a phone', the device stays PENDING, and the attempt counts toward lockout. Covered by the Task 3 approve-here test.

---

### Task 1: Tables and pure rules

**Files:**
- Modify: `prisma/schema.prisma`; Create: `prisma/migrations/20261030010000_pin_devices/migration.sql`
- Create: `src/lib/pin/rules.ts`
- Test: `src/lib/__tests__/pin-rules.test.ts`

**Interfaces:**
- Produces:
  - `PinDevice { id String @id @default(uuid()); cookId String (relation Cook, onDelete: Cascade); tokenHash String; label String?; status PinDeviceStatus @default(PENDING); createdAt; approvedById String?; approvedByName String?; approvedAt DateTime?; lastUsedAt DateTime?; @@unique([tokenHash, cookId]); @@index([status]) }`
  - `enum PinDeviceStatus { PENDING APPROVED REJECTED REVOKED }`
  - `PinAttempt { id String @id @default(uuid()); key String; ok Boolean; createdAt DateTime @default(now()); @@index([key, createdAt]) }`
  - `newDeviceToken(): string` (32 random bytes as base64url)
  - `hashToken(token: string): string` (sha256 hex)
  - `LOCK_LIMIT = 5`, `LOCK_WINDOW_MS = 15 * 60_000`
  - `isLocked(failedAt: Date[], now: Date): boolean`
  - `pinDisplayName(cook: { name: string; lastName: string | null }): string`
  - `pinEmail(cookId: string): string`
  - `deviceLabel(userAgent: string | null): string` (`'iPhone'`, `'Android phone'`, `'iPad'`, else `'Browser'`)
- [ ] **Step 1: Write the failing tests:**
  - `hashToken('abc')` → `'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'`
  - `newDeviceToken()` has length 43 and two calls differ
  - `isLocked` with 5 failures inside the window → true; with 4 → false; with 5 where one is 16 minutes old → false
  - `pinDisplayName({ name: 'Sam', lastName: 'Lee' })` → `'Sam L.'`; `({ name: 'Sam Lee', lastName: null })` → `'Sam L.'`; `({ name: 'Raj', lastName: null })` → `'Raj'`
  - `pinEmail('c1')` → `'pin.c1@crew.controlaos.app'`
  - `deviceLabel` covers an iPhone UA, an Android UA and null
- [ ] **Step 2:** Run `npx vitest run src/lib/__tests__/pin-rules.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with `node:crypto`. Add the schema. Generate the migration SQL exactly as in the checklists plan, Task 1, step 2. Run `npx prisma generate`.
- [ ] **Step 4:** Run the tests. Expected: PASS. Run `npm run build`. Expected: passes.
- [ ] **Step 5: STOP and ask Joshua** before applying, in plain words: "This adds two empty tables for phone sign-in to the live database. OK?" Only on his yes, apply and resolve the migration, as in the checklists plan, Task 1, step 4.
- [ ] **Step 6: Commit** `feat(pin): device and attempt tables, pure rules`.

---

### Task 2: Account + session minting

**Files:**
- Create: `src/lib/pin/account.ts` (`server-only`)
- Test: `src/lib/__tests__/pin-account.test.ts` (mock `@/lib/prisma`, `@/lib/supabase/admin`, `@supabase/ssr`)

**Interfaces:**
- Consumes: `createAdminClient()` from `src/lib/supabase/admin.ts`, `pinEmail` from Task 1.
- Produces:
  - `ensurePinUser(cook: { id: string; name: string; lastName: string | null; userId: string | null }): Promise<{ userId: string; email: string }>`, which throws `PinError(403, 'This login is switched off')` when the linked user is inactive
  - `mintSession(req: NextRequest, email: string): Promise<CookieToSet[]>`, where `CookieToSet = { name: string; value: string; options: CookieOptions }`
  - `class PinError extends Error { constructor(public status: 400 | 401 | 403 | 404 | 409 | 429, message: string) }`
- [ ] **Step 1: Write the failing tests:**
  - A cook with a linked active user (`user.findUnique` → `{ id: 'u9', email: 'sam@x.com', isActive: true }`) → returns `{ userId: 'u9', email: 'sam@x.com' }`. `auth.admin.createUser` is NOT called.
  - A cook with a linked inactive user → throws `PinError` 403 'This login is switched off'.
  - A cook with no user:
    - calls `auth.admin.createUser` with `{ email: 'pin.c1@crew.controlaos.app', email_confirm: true, user_metadata: { role: 'STAFF', isActive: true, name: 'Sam Lee' } }`
    - then `prisma.$transaction` creates `user` `{ id: <new id>, email, name: 'Sam Lee', role: 'STAFF', isActive: true }` and updates `cook` `{ userId: <new id> }`
    - returns the new id
  - If the Prisma transaction throws after `createUser`, `auth.admin.deleteUser(<new id>)` is called (rollback) and the error is rethrown.
  - If `createUser` fails with "already registered", the existing auth user is found by email (`findAuthUserByEmail` from `src/lib/users.ts`) and reused, so a retry after a half-failure works.
  - `mintSession`: `generateLink` is called with `{ type: 'magiclink', email }`. `verifyOtp` is called with `{ type: 'magiclink', token_hash: <properties.hashed_token> }`. The cookies the stubbed `setAll` received are returned.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** `mintSession` builds `createServerClient(url, anonKey, { cookies: { getAll: () => req.cookies.getAll(), setAll: c => pending.push(...c) } })`, the same as `src/app/auth/callback/route.ts`. It throws `PinError(401, 'Could not sign in — try again')` when either Supabase call errors.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pin): create crew logins and mint sessions`.

---

### Task 3: Public PIN routes

**Files:**
- Create: `src/app/api/auth/pin/route.ts` (POST)
- Create: `src/app/api/auth/pin/status/route.ts` (GET)
- Create: `src/app/api/auth/pin/approve-here/route.ts` (POST)
- Create: `src/lib/pin/attempts.ts` (`server-only`: `clientIp(req)`, `checkLock(keys: string[])`, `recordAttempt(keys: string[], ok: boolean)`)
- Test: `src/app/api/auth/pin/__tests__/pin.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `clientIp(req)`: the first entry of `x-forwarded-for`, else `'unknown'`
  - lock keys: `ip:<ip>` and `cook:<cookId>` (the cook key only once a cook is known)
  - `POST /api/auth/pin { pin: string; confirm?: boolean }`:
    - Check the IP lock → 429.
    - `pin` must be 3–8 digits, else 400 'Enter your PIN'. Toast PINs are 3, 4 or 5 digits: the live data on 2026-10-29 was 7, 15 and 2 of the 24 active cooks. Joshua keeps the Toast PINs as they are.
    - Find the active cook with `clockId = pin`. If none: record a failed IP attempt → 401 `{ error: 'PIN not recognised' }`.
    - Check the cook lock → 429.
    - Read the `pin_device` cookie. If its hash has an APPROVED device for this cook: `ensurePinUser` → `mintSession` → update `lastUsedAt` → record ok → 200 `{ signedIn: true }` with the session cookies.
    - Else, `confirm` not true → 200 `{ needsConfirm: true, name: pinDisplayName(cook) }`. This is not counted as a failure: the PIN was right.
    - Else, `confirm` true: reuse the cookie token, or issue a new one, and set the cookie. Upsert a PENDING device for (tokenHash, cookId), resetting REJECTED/REVOKED back to PENDING with a fresh `createdAt`. → 200 `{ pending: true, name }`.
  - `GET /api/auth/pin/status`: no cookie → `{ devices: [] }`; else `{ devices: Array<{ cookName: string; status }> }` for that token hash.
  - `POST /api/auth/pin/approve-here { managerPin: string }`:
    - Locks as above.
    - The manager cook is found by `clockId`. Its linked user must be active and `atLeast(role, 'MANAGER')`, else 403 'Only a manager can OK a phone' (a failed attempt).
    - Approves every PENDING device on this cookie's token: `approvedById` = the manager user id, `approvedByName` = the manager user name.
    - → `{ approved: number }`.
- [ ] **Step 1: Write the failing tests** (mock prisma, `ensurePinUser`, `mintSession`):
  - unknown PIN → 401 and `pinAttempt.create` with `{ key: 'ip:1.2.3.4', ok: false }`
  - 5 failures in the last 15 minutes for `ip:1.2.3.4` → 429 with 'Too many tries — wait 15 minutes', and the cook lookup is not called
  - right PIN, no cookie → 200 `{ needsConfirm: true, name: 'Sam L.' }`, no session minted
  - right PIN + `confirm: true` → 200 `{ pending: true }`, a `Set-Cookie` containing `pin_device=` and `HttpOnly`, and `pinDevice.upsert` with status PENDING
  - right PIN + cookie with an APPROVED device → 200 `{ signedIn: true }`, `mintSession` called once, and the response carries the minted cookies
  - right PIN + cookie with a REVOKED device and no confirm → `needsConfirm`, no session
  - approve-here with a STAFF manager PIN → 403 'Only a manager can OK a phone' and the device untouched
  - status → `[{ cookName: 'Sam L.', status: 'PENDING' }]`
- [ ] **Step 2:** Run `npx vitest run src/app/api/auth/pin`. Expected: FAIL.
- [ ] **Step 3: Implement.** `PinError` maps to its status with `{ error }`. Anything else is a 500 'Could not sign in — try again', logged without the PIN.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pin): public PIN sign-in, device request and on-the-spot OK`.

---

### Task 4: Manager approvals API

**Files:**
- Create: `src/app/api/pin-devices/route.ts` (GET, MANAGER)
- Create: `src/app/api/pin-devices/[id]/route.ts` (PATCH, MANAGER)
- Create: `src/lib/pin/crew-status.ts` (pure)
- Test: `src/lib/__tests__/pin-crew-status.test.ts`, `src/app/api/pin-devices/__tests__/patch.test.ts`

**Interfaces:**
- Produces:
  - `crewStatus(cook: { clockId: string | null }, devices: Array<{ status }>): { label: 'SET UP' | 'WAITING' | 'NOT YET' | 'NO PIN'; tone: 'green' | 'gold' | 'grey' | 'red'; phones: number }`
    - no clockId → NO PIN red
    - any PENDING → WAITING gold
    - ≥1 APPROVED → SET UP green
    - otherwise → NOT YET grey
    - `phones` = the APPROVED count
  - `GET /api/pin-devices` → `{ pending: Array<{ id, cookName, label, createdAt }>, crew: Array<{ cookId, name, station: string | null, status: ReturnType<typeof crewStatus>, devices: Array<{ id, label, status, lastUsedAt, approvedByName }> }> }`. Active cooks only, in sortOrder. Pending is newest first.
  - `PATCH /api/pin-devices/[id] { action: 'approve' | 'reject' | 'revoke' }`:
    - approve: PENDING → APPROVED with the approver
    - reject: PENDING → REJECTED
    - revoke: APPROVED → REVOKED
    - any other transition → 409 'Already handled'
- [ ] **Step 1: Write the failing tests:**
  - every `crewStatus` branch
  - PATCH approve on PENDING → update with `{ status: 'APPROVED', approvedById: 'm1', approvedByName: 'Leo' }`
  - approve on APPROVED → 409
  - revoke on APPROVED → REVOKED
  - a LEAD caller → 403 (`requireSession('MANAGER')` throws)
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Revoking a device does not end a session that is already open on that phone. Deactivating the person in People does that. Say so in a code comment, and in the page copy: "Revoke stops this phone signing in again. To lock someone out now, switch off their login in People."
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pin): manager approves, rejects and revokes phones`.

---

### Task 5: Screens

**Files:**
- Create: `src/app/auth/pin/page.tsx`, `src/components/pin/Keypad.tsx`
- Modify: `src/app/login/page.tsx` (add the link)
- Create: `src/app/checklist/crew/page.tsx`
- Modify: `src/lib/route-access.ts` + its test (add `['/checklist/crew', 'MANAGER']`)
- Modify: `src/app/checklist/today/page.tsx` (pending-phones card, MANAGER+ only)

**Interfaces:**
- Consumes: Tasks 3–4. `useUser()` for the role on the Today board.

- [ ] **Step 1: `/auth/pin`** follows the "Sign in · PIN" and "First time on a phone" boards, with the PIN-first change from the spec. States:
  - **enter**: "Type the PIN you clock in with." with a 3×4 keypad of 64 px keys.
    - One dot appears per digit typed. There are no fixed placeholder dots, so the PIN length isn't hinted.
    - **No auto-submit.** PINs are 3–5 digits and "123" may be the start of another cook's "1234".
    - The keypad's bottom-right key is ⌫. A full-width "Sign in" button below it is enabled from 3 digits.
    - Max 8 digits.
  - **confirm**: "Sam L., is this you?" with "Yes, it's me" (POST `confirm: true`) and "No — try again".
  - **waiting**: the three-step list (PIN matched ✓ / Is this you ✓ / Manager OKs this phone · waiting) and the "Why the extra step?" card. Poll `/status` every 4 s. When it turns APPROVED, re-POST the held PIN, which signs in. REJECTED shows "This phone wasn't OK'd. Ask a manager." Also "Manager standing next to you? → Manager types their PIN here", which opens the keypad in manager mode and POSTs approve-here.
  - **locked**: the 429 message.
  - **signedIn**: `window.location.assign('/checklist')` (a hard navigation, the same reason as `/login`).

  Hold the PIN in component state only, never in storage. Clear it on success or after 10 minutes.
- [ ] **Step 2: `/login`.** Under the form add a secondary button, "Kitchen crew? Sign in with your PIN" → `/auth/pin`.
- [ ] **Step 3: `/checklist/crew`** follows the "Manager · OK a phone, crew set-up" board:
  - lede "**1 phone** waiting for your OK. **4 of 24** cooks set up."
  - pending cards with "Not Sam" / "OK this phone" (the gold CTA: the one gold fill on the page)
  - the crew list with status pills; expanding a row lists its phones with Revoke
  - poll every 10 s while there are pending devices
- [ ] **Step 4: Today board.** For MANAGER+ only, the top card "N phones waiting for your OK →" links to `/checklist/crew`. Hidden at zero.
- [ ] **Step 5:** Run `npm test` and `npm run build`. Expected: pass. `/api/auth/pin*` and `/api/pin-devices*` show as `ƒ (Dynamic)`.
- [ ] **Step 6: Commit** `feat(pin): PIN sign-in screen, crew sign-in page, login link`.

---

### Task 6: Verify

- [ ] **Step 1:** Run `npm test`, `npm run lint` and `npm run build`. Expected: all pass.
- [ ] **Step 2:** In the browser (no live writes): `/auth/pin` with a made-up PIN `0000` shows "PIN not recognised". This writes one attempt row, which is harmless and expires from the lock window.
- [ ] **Step 3: STOP and ask Joshua** before the end-to-end test: "To test it for real I need one cook to try it: it creates their login and asks you to OK their phone. Who should I use, and OK to do it?" On his yes, run the flow with that cook. Then check the tick on `/checklist` shows their name in History.
