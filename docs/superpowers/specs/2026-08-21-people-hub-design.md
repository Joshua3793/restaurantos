# People hub — one place to manage everyone

**Date:** 2026-08-21
**Status:** design approved, not implemented
**Route:** `/setup/users` (kept; heading becomes "People")

## Problem

Three surfaces write to the same two rows, and none of them shows the whole
person.

| Surface | Entity | Fields it owns | Write gate |
|---|---|---|---|
| `/setup/users` "People & Access" | `User` | `email`, `name`, `role`, `isActive`, `isPending`, `UserScope[]` | ADMIN |
| `/setup/kitchen-crew` | `Cook` | `name`, `initials`, `homeStation`, `isActive`, `sortOrder` | ADMIN (`/api/prep/cooks`) |
| `/tips` → Settings → roster grid | `Cook` | `lastName`, `clockId`, `wage`, `dailyHourCap`, `tipRoleId`, `onTipPool`, `posPosition`, `userId` | MANAGER (`/api/tips/roster/[id]`) |

To set up one new cook who also signs in, an admin visits three pages in two
sections of the app and must remember that the login↔roster link lives on the
tips page.

Everything else that names a person is free text and out of scope:
`CountSession.countedBy`, `EodClose.signedOffBy`, `TempReading.recordedBy`,
`WastageLog.loggedBy`, `InvoiceSession.approvedBy`. `PrepLog.assignedTo` is the
one exception — it stores a `cookId`.

## Non-goals

- No schema change. `User` and `Cook` stay separate tables.
- No Activity tab. Only `PrepLog.assignedTo` is a real foreign key; the rest are
  name strings, so a per-person activity feed would be a fuzzy name match that
  can attribute one person's work to another.
- No Audit tab. The global `AccessAuditPanel` stays where it is.
- No change to who may do what. The ADMIN/MANAGER split is preserved exactly.

## Model — a Person is a projection, not a table

A person row is `{ userId, cookId }` with at least one non-null:

| Shape | `userId` | `cookId` | Example |
|---|---|---|---|
| Linked | set | set | a cook who also signs in |
| Login only | set | `null` | the bookkeeper |
| Roster only | `null` | set | most of the crew |

`Cook.userId` is nullable-and-unique by design (`prisma/schema.prisma:759`):
most cooks have no login, and the link is **always set deliberately, never
inferred from a name or email**. That rule is load-bearing — this is money — and
the hub does not relax it.

List key is `` userId ?? `cook:${cookId}` ``. Linking a roster row to a login
collapses two rows into one, and the surviving key is the user's.

### Name divergence is shown, never auto-resolved

`User.name` is a full name. `Cook.name` is the short first name that renders on
run-sheet chips and seeds `initials`. Syncing them would put "Mia Chen" on a
prep chip.

- Row display name: `User.name ?? [Cook.name, Cook.lastName].join(' ') ?? email`
- Identity tab shows **both**, labelled "Account name" and "Roster name", with a
  quiet note when they disagree. Divergence is legitimate.

## Endpoints

### `GET /api/settings/people` — new, ADMIN

One response carrying everything the hub needs:

- every `User` with `scopes` and its `cook` relation
- every `Cook` where `userId IS NULL`
- the locations/RC tree (as `GET /api/settings/users` returns today)
- active `TipRole[]`
- `PrepSettings.stations`

The lookups are folded in because `/api/tips/roles` is MANAGER-gated and the tip
roster is currently only reachable through `GET /api/tips/periods/[id]` — the
hub must not require an open tip period to exist.

`export const dynamic = 'force-dynamic'`.

### `POST /api/settings/people` — new, ADMIN

The only new write. It exists because the two creates live in different stores,
and because `Cook.dailyHourCap` must be prefilled from
`TipSettings.defaultDailyHourCap` — which `POST /api/tips/roster` does
(`route.ts:52`) and `POST /api/prep/cooks` does not, a divergence the hub would
otherwise inherit.

Body: `{ name, login?: { email, clearance, assignments }, roster?: { initials, homeStation, clockId, tipRoleId, onTipPool } }`.
At least one of `login` / `roster` required. `email` is singular — one person,
one account. Bulk invite stays on `POST /api/settings/users`, which keeps its
`emails[]` array.

**Order is deliberate: `Cook` first → invite → link.** Both halves of a partial
create are valid people, but the invite is the failure-prone half (network,
email, Supabase) and the recoverable one. If it fails, the roster row survives
and the response says so, with a retry on the Identity tab. Inverting the order
would require compensating a Supabase invite — a second thing that can fail.

The Supabase invite logic is extracted from `POST /api/settings/users` into
`src/lib/user-invite.ts` and called by both routes, so there is one
implementation.

### Every edit reuses an existing route

| Change | Route |
|---|---|
| account name, clearance, isActive | `PATCH /api/settings/users/[id]` |
| scope assignments | `PUT /api/settings/users/[id]/assignments` |
| resend invite | `POST /api/settings/users/[id]/resend` |
| remove login | `DELETE /api/settings/users/[id]` |
| roster name, initials, station, sortOrder, roster isActive | `PATCH /api/prep/cooks/[id]` |
| remove roster row | `DELETE /api/prep/cooks/[id]` |
| lastName, clockId, wage, dailyHourCap, tipRoleId, onTipPool, **userId link** | `PATCH /api/tips/roster/[id]` |

Nothing revalidates a `clockId` clash or a double-link in a second place. Those
routes carry the P2002 race handling (`tips/roster/[id]/route.ts:88-125`), the
readable 409s, the access-audit writes, and the two-store Supabase↔Prisma sync
with rollback.

## Screen

### Left pane (~320px, pinned)

- Search — matches name, email, and clock #
- Segmented filter: **All · Logins · Roster · Pending · Inactive**
- **All** groups by location via the existing `groupByLocation`, with one
  addition: roster-only people get a **"Kitchen roster · no login"** bucket
  rather than falling into the existing unassigned group. That group is a
  warning state ("a non-global role with zero assignments has no access at
  all"); a cook with no login is normal, not broken.
- **Roster** goes flat, sorts by `Cook.sortOrder`, and rows grow ↑/↓ handles —
  this is where the run-sheet reorder affordance from `/setup/kitchen-crew`
  lands.
- Row: initials avatar · display name · secondary line (email for logins,
  `Clock #1204 · Sauté` for roster-only) · pills for clearance, pending,
  off-pool, inactive.

Below `md:` the list **is** the page; selecting pushes the detail full-screen
with a back arrow. `md:`, not `sm:` — matching the newer prep/count/today
renderers.

### Right pane — four tabs

Tabs that don't apply stay visible but dimmed with an empty state inside, so the
layout doesn't reshuffle as you arrow down the list.

**Identity**
- status pill; Account name; Roster name + Last name; Initials; Email
  (read-only — it is the auth key)
- the link control, which is the point of the hub:
  - login without a roster row → *"Put them on the kitchen roster"*
  - roster row without a login → picker of unlinked **active** accounts, plus
    *"Invite them"*
- deactivate / reactivate / remove at the bottom, as today

**Access**
- clearance select, `AssignmentEditor`, and the live effective-access preview
  lifted verbatim from `PersonDetailPanel.tsx:26` — it must keep calling the
  same `resolveEffective` the server enforces with, so the preview can never
  disagree with reality
- roster-only: *"No app login — this person can't sign in."*

**Prep**
- home station (from `PrepSettings.stations`), run-sheet position with ↑/↓,
  roster active toggle
- no `Cook`: *"Not on the kitchen roster"* + add

**Tips**
- on-pool toggle, tip role with its multiplier shown, clock ID, daily hour cap,
  wage (labelled *reference only — never affects the split*)
- **inline check: on-pool + no clock ID is a silent zero.** Hours match on
  `clockId` and nothing else, so this person earns nothing and nobody finds out
  until payday.
- no `Cook`: same empty state as Prep

### Create

One "Add person" modal: name, then `[ ] Give them an app login` (email,
clearance, assignments) and `[ ] Put them on the kitchen roster` (initials —
auto-derived, still editable — home station, clock ID, tip role, on-pool). At
least one box required.

Multi-email bulk invite is preserved as a secondary *"Invite several people"*
link opening today's `InviteModal`, login-only.

### Two states rendered, not discovered on save

`PATCH /api/settings/users/[id]` rejects editing your own account (400) and
locks OWNER entirely (403). Both render read-only with an explanation, the way
`PersonDetailPanel` already handles `locked`.

## Permissions

`['/setup', 'ADMIN']` is already in `ROUTE_CLEARANCE`
(`src/lib/route-access.ts:20`) — the one route→clearance table both
`src/middleware.ts` and `Navigation.tsx` read — so the hub is ADMIN-only by page
gate with no new entry. `GET`/`POST /api/settings/people` require ADMIN
independently, since `/api/*` is excluded from the middleware matcher.

(Note: `CLAUDE.md` still describes an `ADMIN_PREFIXES`/`MANAGER_PREFIXES` pair
in `src/middleware.ts`. That is stale — the gates moved into `ROUTE_CLEARANCE`.
Worth correcting there separately.)

The Tips Settings roster grid stays MANAGER and stays editable. That preserves
the split `tips/roster/[id]/route.ts:9` was written for: the person running a
payout tunes caps and roles against live hours in context, but cannot rewrite
the prep run sheet.

## Included fix — the wage leak

`GET /api/prep/cooks` currently returns whole `Cook` rows — `wage` and `clockId`
included — to **any authenticated session**, STAFF included.

Fix: an explicit `select: { id, name, initials, homeStation, isActive, sortOrder }`.

Verified safe — every consumer reads only those fields:
- `src/app/prep/page.tsx:271`
- the `Cook` type at `src/components/prep/runsheet/assignee.tsx:10`
- the 4-field projection at `src/app/api/prep/items/route.ts:206`
- `src/app/setup/kitchen-crew/page.tsx` (being retired)

After this, `wage`/`clockId` appear on exactly two responses, both privileged:
the MANAGER tips payload and the ADMIN hub.

Optional hygiene, not required: `prisma.cook.findMany` at
`api/prep/items/route.ts:101` is unselected. It does not leak (it projects four
fields at line 206), but a select there is cheap defence-in-depth.

## Retirement

- `/setup/kitchen-crew` → `REDIRECTS` entry in `src/middleware.ts`
  (`middleware.ts:12`) pointing at `/setup/users`; page and its card deleted.
  That table fires before auth and issues a 308, so existing bookmarks land
  correctly and then go through the normal gate.
- Setup hub: drop the "Kitchen crew" card; retitle "Users & roles" → **People**,
  description covering logins, roster, and tips.
- Route stays `/setup/users`. Renaming buys a nicer URL at the cost of a second
  redirect and every existing link.

## Failure modes

| Case | Behaviour |
|---|---|
| Create: roster ok, invite fails | Roster-only person exists. Response reports it; retry from Identity. |
| Create: roster fails | Nothing created; error surfaced. Invite not attempted. |
| Link to an already-linked account | 409 `That login is already linked to X` — surfaced inline on Identity. |
| Clock ID already taken | 409 `Clock #NNNN already belongs to X` — surfaced inline on Tips. |
| Audit write fails after mutation committed | Routes return a non-fatal `warning`. `PersonDetailPanel.call()` (line 64) drops it today; the hub shows it. |
| Supabase metadata write fails | Existing rollback in `settings/users/[id]` PATCH stands; hub shows the 500 message verbatim. |

## Testing

**Pure lib — `src/lib/people.ts`, covered by `npm test`:**
- `mergePeople(users, orphanCooks)` — the projection, including key collapse
- `displayName(person)` — the name-precedence rule
- `personWarnings(person)` — on-pool-without-clock-ID, and account/roster name
  divergence

Keeping this in a pure lib holds it out of both the route and the component, and
puts it under the existing fast vitest suite.

**Route tests**, following the `src/app/api/tips/**/__tests__` pattern:
- `GET /api/settings/people` — ADMIN gate; all three person shapes present;
  orphan cooks included exactly once
- `POST /api/settings/people` — login-only, roster-only, both; partial-create
  path when the invite fails; `dailyHourCap` prefill applied
- `GET /api/prep/cooks` — response contains no `wage` and no `clockId`

**Type check:** `npm run build`, from an isolated worktree (a main-checkout
build fails spuriously while the dev server is running).

## Build order

1. `src/lib/people.ts` + its tests
2. `src/lib/user-invite.ts` extracted from `POST /api/settings/users`
3. `GET /api/settings/people` + tests
4. `POST /api/settings/people` + tests
5. Narrow `GET /api/prep/cooks` + test
6. Hub UI — list pane, then the four tabs, then create
7. Retire `/setup/kitchen-crew`; update the setup hub card
