# Staff tip payouts — design

**Date:** 2026-08-21
**Status:** Approved, not implemented

## Problem

`/tips` is the manager's payout console: it shows the whole crew's split, the
daily pools, the sales that fund them, and the cash breakdown. It is gated at
`MANAGER` in `ROUTE_CLEARANCE`, so a STAFF user who clicks "Tip payouts" in the
sidebar today gets a padlock and the `/no-access` screen.

A cook has a legitimate question that page can answer and no other surface can:
*what was I paid, for which hours, and why?* This spec designs a staff-facing
view of that answer — one person's numbers, and nothing else's.

## Scope

**In:** a read-only personal payout view for paid periods; the identity link
that makes "personal" addressable; a whitelisted read API; roster UI to set the
link.

**Out:** live drafts, any pool/sales/crew figure, any other person's data, and
any write path. A staff user never mutates tip data.

## The four decisions

Each of these was chosen over stated alternatives; the reasoning is recorded
because the alternatives will look tempting again later.

1. **Identity is an explicit link, never a match.** `Cook.userId`, set
   deliberately by a manager. Not email, not name.
2. **Paid periods only.** No live draft estimate. A draft recomputes whenever a
   manager edits hours, a rate, or an import, so a number shown today can drop
   tomorrow.
3. **Personal fields only.** No day pool, no share %, no crew count, no rate,
   no sales.
4. **A reopened period keeps showing its last real payout, flagged.** It does
   not vanish.

### Why no name/email matching

The schema already states this domain's rule: hours match on `clockId` only,
**never** on name (`prisma/schema.prisma:738`). Money is where a wrong guess is
worst — a bad match shows one person another person's pay. An explicit link also
survives a name change and lets a cook with no app account simply stay unlinked,
which is the normal case, not a broken one.

### Why paid-only

`TipPeriod.snapshot.current` is a frozen record of cash that was actually handed
over. Reading only from it means the number on a cook's phone can never move
under them. A live draft estimate is more useful day-to-day and can be added
later as an explicitly-flagged "in progress" card without changing anything in
this design — but it must never be rendered like a settled figure.

### Why personal-only

Accepted cost, stated so nobody rediscovers it as a bug: the most common payout
dispute is "why was Tuesday lower than last Tuesday?" Under this rule the screen
answers that **only** when the cause was the cook's own hours, cap, or reward. If
the cause was a slow night or a bigger crew, the screen cannot say so. That is
the deliberate trade for keeping house financials off a staff device.

### Why a reopened period must not vanish

`reopenSnapshot` pushes the payout onto `snapshot.history` and sets
`current = null` (`src/app/api/tips/periods/[id]/pay/route.ts:38`). A strict
"read `current` only" rule would therefore erase, from the cook's phone, a
payout they were physically handed — with no explanation — for as long as the
correction takes. Instead the view reads the newest record from
`payoutsInOrder(snap)` whether or not it is `current`, and flags the period as
being corrected when `current == null`. The screen never contradicts what the
cook has in hand, and the fact that it is under revision is stated rather than
hidden.

## 1. Identity link

### Schema

`Cook` gains:

```prisma
userId String? @unique
user   User?   @relation(fields: [userId], references: [id], onDelete: SetNull)
```

`User` gains the back-relation `cook Cook?`.

- **Nullable** — most roster rows will never have an app login.
- **`@unique`** — one login ↔ one roster row, enforced in the database so a
  race cannot produce a double-link that shows someone another person's money.
- **`onDelete: SetNull`, never Cascade** — hard-deleting a user must not delete
  a roster row or erase tip history. Same call already made for
  `ChatConversation.userId`.

**Migration** is additive and nullable: no backfill, no downtime. This repo's
shadow database is broken (P3006), so it is applied via `migrate diff` →
`db execute` → `migrate resolve` over the session pooler, not `migrate dev`.

### Server

`PATCH /api/tips/roster/[id]` accepts `userId`, staying at its current
`requireSession('MANAGER')`. Validation mirrors the `clockId` clash handling
already in that file:

- `null` / `''` clears the link.
- A string must resolve to an **active** `User`, else 400.
- A unique-constraint violation returns **409 naming the cook who already holds
  that login** — "Josh's login is already linked to Maria Sandoval" — not a raw
  Prisma error.

### UI

The roster table in `src/components/tips/SettingsTab.tsx` already edits cap,
pool membership, role and wage through one `onSaveRoster(cookId, patch)`
callback. Add an **"App login"** column: a `<select>` of active users with
"— none —" first, calling the same callback with `{ userId }`.

The picker **never pre-selects a suggestion**, by email or by name. The link is
always a deliberate act.

## 2. Access and routing

One line appended to `ROUTE_CLEARANCE` in `src/lib/route-access.ts`:

```ts
['/tips/me', 'STAFF'],
```

Longest-prefix-wins overrides `['/tips', 'MANAGER']` for that path only — the
mechanism that table's own doc comment describes. **`/tips` itself is
unchanged**, so the manager console stays gated in middleware rather than in
component code.

`NavItem` gains an optional `staffHref`. `src/components/Navigation.tsx`
resolves the destination at render: if the user cannot reach `item.href` but can
reach `item.staffHref`, link there. "Tip payouts" then points at `/tips` for
MANAGER+ and `/tips/me` for STAFF, and loses its padlock for staff.

This adds a field to a table that deliberately carries none. It is admissible
because `staffHref` is a **destination**, not a clearance — clearance is still
derived solely from an href via `requiredClearance()`, so the menu still cannot
advertise a page middleware would bounce. The invariant test at
`src/lib/__tests__/nav-items.test.ts` extends to assert every `staffHref` is
STAFF-reachable.

## 3. Read API

### `GET /api/tips/me`

`requireSession()` with **no** `minRole` — any active user, including a manager
who is also on the roster. `export const dynamic = 'force-dynamic'` and
`Cache-Control: no-store`.

Flow:

1. Resolve the caller's cook by `userId`. None → `{ linked: false }`. **Not a
   404** — the caller is a valid user, they just have no roster row.
2. Load periods whose `snapshot` is non-null, newest first, capped at the **26
   most recent such periods** (a year of fortnights) so the response cannot
   grow without bound. The cap is applied to periods *before* projection, so a
   cook who was off the pool for some of them sees fewer than 26 rows — that is
   correct, not a truncation bug.
3. Normalize each through `readSnapshot()` — never raw JSON — so legacy flat
   snapshots migrate to v1 on read.
4. Take `payoutsInOrder(snap).at(-1)`, find `record.split.people` where
   `cookId` matches, and project. A period where the cook has no row projects
   to `null` and is **dropped from the list** — never emitted as a zero row.

### The projection is the security spine

`TipPeriod.snapshot` holds every cook's pay, the sales array, and the pool
totals. The transform is therefore a **field-by-field whitelist that constructs
a new object** — never the record with fields deleted, never a spread. It lives
in a pure lib, `src/lib/tips/me.ts`, beside `engine` / `audit` / `period`, so
`npm test` covers it directly.

```ts
interface MyPayoutDay {
  label: string
  hours: number        // capped/effective hours actually paid on
  rawHours: number     // as clocked, so a cap is explicable
  capped: boolean
  boost: number        // 1 = no reward
  edited: boolean      // hours came from a manual adjustment, not the clock file
  amount: number
}

interface MyPayout {
  periodId: string
  startDate: string
  endDate: string
  paidAt: string
  paidByName: string | null
  status: 'PAID' | 'BEING_CORRECTED'   // BEING_CORRECTED when snapshot.current is null
  roleName: string
  multiplier: number
  dailyHourCap: number | null
  hoursTotal: number
  tip: number                          // exact dollars earned
  envelopeCents: number                // rounded cash actually handed over
  perHour: number                      // tip / hoursTotal, guarded at zero hours
  days: MyPayoutDay[]
}
```

**Deliberately absent:** `pools`, `poolTotal`, `distributedTotal`, `basis`,
`sales`, `tips`, `crewByDay`, `weightedByDay`, `weighted`, `people[]`,
`poolRatePct`, `poolBasis`, `wage`, `clockId`.

`/api/tips/me` is the **only** STAFF-reachable tips endpoint. Every other route
under `/api/tips/*` is `requireSession('MANAGER')` and stays that way.

### Judgment calls

- **`paidByName` included.** It is a manager's name, not another cook's pay, and
  it answers "who do I ask about this".
- **`edited` included.** Hiding a hand-edit to someone's own hours is the wrong
  default.
- **`wage` excluded** even though it is the cook's own — it is reference-only,
  never affects the split, and has no business on this screen.

## 4. The screen

`/tips/me`, a client component, single responsive column — max-width centred on
desktop, full-bleed on a phone. This is simple enough to skip the dual-renderer
pattern; there is no second layout to maintain.

Two tabs held in local state — **not** `TIP_TABS` from `kit.tsx`, which is the
manager's six-tab set. Formatting reuses `money` / `hoursLabel` from kit so it
matches the rest of the app.

**Latest** — role pill (`Line Cook ×1.25`); the envelope as the headline with
period dates and paid-on beneath; a hours / per-hour / earned strip; then the day
list. Day rows show off-days muted, a gold `×1.5` on reward days, a red
`capped 9.5` where the contracted cap clipped hours, and a quiet "adjusted"
marker where `edited` is set. When `status === 'BEING_CORRECTED'`, an amber note
sits under the headline: *this payout is being corrected — the amount may
change*.

A footnote states the envelope-vs-earned rounding **once**, so the two numbers
never read as a discrepancy.

**History** — the payout list: dates, the **envelope** (same figure the Latest
headline shows, so the two tabs never disagree), hours, and $/h. Tapping a row
selects that period and switches to Latest. One detail renderer, not two.

### States

| State | Copy |
|---|---|
| `linked: false` | "Your payouts aren't linked to your account yet — ask a manager to link you on the tips roster." |
| linked, no payouts | "No payouts yet. Your first one shows up here once it's paid." |
| loading | skeleton |
| error | message + retry |

The first two must never collapse into one. Rendering `$0.00` for an unlinked
account is a lie about someone's pay. This is the same null-vs-zero distinction
the schema already draws for `SalesEntry.tipsCollected`: no data and no money are
different facts.

## 5. Testing

Unit tests on `src/lib/tips/me.ts` under `npm test`, beside the existing
engine / audit / period suites:

- **Key-whitelist test** — enumerate every permitted output key and fail on any
  extra. This is the one that matters: it means a field added to `SplitPerson`
  later cannot silently leak into the staff response.
- Reopened period → picks the superseded record and flags `BEING_CORRECTED`.
- Cook absent from `split.people` (on the roster, off the pool that period) →
  null, not a zero row.
- Zero-hours `perHour` guard.
- Cap / boost / edited day flags each render from the right source field.
- Legacy flat snapshot normalizes through `readSnapshot`.

Route tests follow the existing `src/app/api/tips/**/__tests__/route.test.ts`
pattern:

- Unlinked caller → `{ linked: false }`, status 200.
- STAFF caller → 200, not 403.
- A user linked to cook A never receives cook B's figures.
- Unauthenticated → 401.

Then `npm run build` to type-check.

**Practical note:** `DEV_AUTH_BYPASS` resolves to an OWNER, so exercising the
STAFF path locally needs either a real staff login or temporarily linking the
bypass user to a roster row. Per this repo's history, the build runs in an
isolated worktree.

## Deferred

- Live draft estimate for the in-progress period, as an explicitly-flagged
  card.
- Share-of-pool % or day pool $, if the house later decides that transparency is
  worth the disclosure.
- Self-serve link request ("this is me") for a cook to propose a link a manager
  approves.
