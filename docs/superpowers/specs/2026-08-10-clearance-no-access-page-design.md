# Clearance: in-place "no access" page, no redirects

**Date:** 2026-08-10
**Status:** Design approved, ready for implementation plan

## Problem

A user below MANAGER cannot navigate the app. Two defects compound:

1. **Middleware redirects instead of explaining.** `src/middleware.ts` bounces any
   role-blocked route to `/`, which redirects to `/today`, which on desktop
   `router.replace`s to `/count`. A Staff user who clicks "Reports" silently lands
   on Count with no explanation. Every gated page is a trapdoor back to Count.

2. **The sidebar and middleware enforce different tables.** `canSeeNavItem` in
   `src/components/Navigation.tsx` gates only `/end-of-day` (LEAD), `/tips`
   (MANAGER) and `/setup` (ADMIN, via `adminOnly`). Middleware additionally
   gates `/pass`, `/reports`, `/cost`, `/variance`, `/signals` (MANAGER) and
   *all* of `/setup/*` (ADMIN). So the nav shows Staff six items it will then
   bounce them out of: Pass, Reports, Variance, Signals, Suppliers, Revenue
   centers.

   That the two tables agree on `/tips` and disagree on six other routes is the
   defect in miniature: agreement is coincidental and maintained by hand.

## Goals

- No role-based redirects. A blocked page shows an explanatory screen **at its own
  URL**.
- The menu tells the truth: out-of-reach items are visibly dimmed, not hidden, and
  remain clickable so the explanation is one click away.
- One clearance table, consumed by both middleware and the nav, with a test that
  fails if they ever drift apart again.

## Non-goals

- Changing which clearance any route requires. The gates stay exactly as
  middleware defines them today.
- Per-revenue-center access (`UserScope` / `effectiveAccess`). This spec is about
  global `Role` only.
- API-layer authorization. `requireSession()` already guards every route handler
  and is unchanged; this spec governs page chrome, not data access.

## Design

### 1. `src/lib/route-access.ts` — the single table

New module. Client-safe by construction: no `server-only` marker and no *value*
imports from `@prisma/client`, because `src/middleware.ts` runs in a restricted
runtime. Same constraint `src/lib/roles.ts` already documents; `import type { Role }`
is erased at compile time.

```ts
/** Route prefix → minimum clearance. Longest prefix wins. */
const ROUTE_CLEARANCE: Array<[string, Role]> = [
  ['/setup',      'ADMIN'],
  ['/settings',   'ADMIN'],
  ['/pass',       'MANAGER'],
  ['/reports',    'MANAGER'],
  ['/cost',       'MANAGER'],
  ['/variance',   'MANAGER'],
  ['/signals',    'MANAGER'],
  ['/tips',       'MANAGER'],
  ['/end-of-day', 'LEAD'],
]

/** Clearance needed to open `pathname`, or null when it is open to STAFF+. */
export function requiredClearance(pathname: string): Role | null

/** False while `role` is null (clearance still loading) — never grant on unknown. */
export function canAccess(role: Role | null, pathname: string): boolean
```

Matching rule: a prefix `p` matches when `pathname === p || pathname.startsWith(p + '/')`.
When several match, the longest prefix wins, so a future
`['/setup/suppliers', 'MANAGER']` entry would override `['/setup', 'ADMIN']`
without reordering the array.

`/cost` is retained for parity with today's `MANAGER_PREFIXES` even though the v2
`REDIRECTS` table rewrites `/cost` → `/reports` before the role check ever runs.
It is inert but harmless, and keeping it means the table is a faithful copy.

### 2. Middleware rewrites instead of redirecting

`src/middleware.ts` — the three `NextResponse.redirect(new URL('/', ...))` blocks
collapse to one rewrite:

```ts
const need = requiredClearance(pathname)
if (need && !atLeast(role, need)) {
  const url = request.nextUrl.clone()
  url.pathname = '/no-access'
  url.searchParams.set('from', pathname)
  url.searchParams.set('need', need)
  return NextResponse.rewrite(url)
}
```

`rewrite` renders a different route **without changing the browser URL**. The
address bar still reads `/pass`, back/forward behave normally, and the check stays
server-side so the gated page never flashes. The `ADMIN_PREFIXES`,
`MANAGER_PREFIXES` and `LEAD_PREFIXES` constants are deleted — `route-access.ts`
replaces them.

Unchanged: the unauthenticated → `/login` and deactivated → `/login?error=deactivated`
redirects. Those are genuine redirects and stay redirects. The v2 `REDIRECTS` table
and the `DEV_AUTH_BYPASS` escape hatch are untouched.

The `from` and `need` params are inputs to the rewritten render only; because a
rewrite is invisible to the browser, they never appear in the address bar.

### 3. `src/app/no-access/page.tsx` — the explanation

New route, rendered inside the normal app shell so the sidebar is present and the
user can navigate straight to somewhere they *can* reach.

Content, driven by `searchParams`:

- Lock glyph.
- "You don't have the clearance to open **Pass**." — the page name resolved from
  `from` by looking it up in the nav tables, falling back to the raw path.
- "Ask an admin for **Manager** clearance." — `ROLE_LABELS[need]` from
  `src/lib/roles.ts`.
- The user's current level, so the gap is legible.
- A button back to `/today`.

Direct navigation to `/no-access` with no params renders the same screen with
generic copy. The route is not itself gated.

**The params must be read server-side and passed down as props.**
`useSearchParams()` does not work here: a rewrite leaves the browser URL on
`/pass`, so the client router sees `/pass`'s params and finds no `need` — the
server render would have them and the client would not. This forces a two-file
split: `src/app/no-access/page.tsx` is a server component (`force-dynamic`)
that reads `searchParams`, resolves the page name via `navLabelFor(from)`, and
renders `src/components/access/NoAccessCard.tsx`, a client component taking
`{ pageLabel, need }` as props and using `useUser()` only for the viewer's own
clearance.

### 4. Nav: dimmed and locked, never hidden

`src/components/Navigation.tsx`:

- `canSeeNavItem`, the `adminOnly` field and the `minRole` field are deleted.
  Clearance now derives from `href` via `canAccess`, so `NavItem` carries no
  clearance data of its own and cannot contradict middleware.
- The desktop sidebar (currently `group.items.filter(...)`) and the mobile "More"
  drawer (currently the same filter) stop filtering. Every item renders.
- Out-of-reach items render at reduced opacity with a `Lock` glyph in place of the
  badge, and stay real `<Link>`s so clicking reaches the no-access screen.
- While `role` is null (`/api/me` in flight) items render in their normal state
  rather than flashing locked — the lock appears only once clearance is known to
  be insufficient. `canAccess(null, …)` still returns false for enforcement
  purposes; the nav uses `role != null && !canAccess(...)` for the *visual* lock
  so a slow `/api/me` does not flash a fully-gray menu.

Consequence, accepted: a Staff sidebar grows from 11 visible items to 17, six of
them dimmed. That is the point — the menu stops lying.

`MobileTabBar` is unchanged: Today, Prep, Count and More are all open to STAFF.

### 5. `/today` on desktop for below-MANAGER roles

`src/app/today/page.tsx` currently `router.replace`s **every** role on desktop —
MANAGER+ to `/pass`, everyone else to `/count`. Only the second bounce is removed:

- MANAGER+ on desktop still lands on `/pass`. Unchanged.
- STAFF and LEAD on desktop now render `/today` itself.

`MScreen` is `md:hidden` (`src/components/mobile/kit.tsx`), so it cannot carry the
desktop render. `/today` gets a responsive container in its place, and `TodayChef`'s
stacked cards flow into a two-column grid at `md:` with a wider max-width. Same
components, same endpoints, no new data.

`TodayManager` needs no desktop treatment: managers bounce to `/pass` before it
would matter.

`/today` is already listed in `SPINE_ROUTES` (`src/lib/chrome-routes.ts`), so the
cost-chrome strip and sidebar offsets already work there.

## Testing

`route-access.ts` is pure, so it joins the existing vitest suite
(`src/lib/__tests__/`, run by `npm test`).

`src/lib/__tests__/route-access.test.ts`:

1. **Longest-prefix match** — `/setup/suppliers` → ADMIN, `/reports/waste` →
   MANAGER, `/prep` → null.
2. **Segment matching** — `/passport` must not inherit `/pass`'s MANAGER gate.
3. **Every role against every gate** — the full `ROLE_RANK` × table matrix,
   including OWNER passing all of them and STAFF passing none.
4. **Null role denies** — `canAccess(null, '/pass') === false`.

`src/lib/__tests__/nav-items.test.ts` — **the regression guard**: every `href`
in `navGroups` and `setupItems` resolves through `requiredClearance` to the
clearance middleware enforces. This is the test that would have caught the
original defect, and it fails if either table drifts.

This guard forces one structural change the spec above did not anticipate:
`vitest.config.ts` collects only `src/**/*.test.ts`, so a `.tsx` client
component cannot be imported by a test. The nav data (`NavItem`, `NavGroup`,
`navGroups`, `setupItems`) therefore moves out of `Navigation.tsx` into a new
`src/lib/nav-items.ts`, which also hosts `allNavItems` and
`navLabelFor(pathname)` — the lookup the no-access screen uses to name the page
it is standing in for. `Navigation.tsx` imports the tables from there and keeps
only rendering. The moved `NavItem` type drops its `adminOnly` and `minRole`
fields: clearance derives from `href`, so a nav item can no longer hold an
opinion that contradicts middleware.

`npm run build` is the type-check for the middleware and component changes.

**Manual verification caveat:** `DEV_AUTH_BYPASS=true` short-circuits middleware
entirely and `requireSession()` returns the OWNER, so the gate is invisible in
dev-bypass mode. Verifying by hand means turning the bypass off and signing in as
a real STAFF user.

## Risks

- **Middleware rewrite + App Router.** `usePathname()` can report the rewritten
  path rather than the browser path under a middleware rewrite. Impact is limited
  to sidebar active-state highlighting on the no-access screen — cosmetic, no
  functional break. Worth confirming during implementation; if the highlight is
  wrong, the no-access page can read `from` and no fix to the nav is needed.
- **Soft navigation through a rewrite.** `<Link>` navigation issues an RSC request
  that middleware rewrites via the `x-nextjs-rewrite` header. Standard Next
  behaviour, but the first thing to check if a gated link renders blank.

## Files

| File | Change |
|---|---|
| `src/lib/route-access.ts` | new — the clearance table + `requiredClearance` / `canAccess` |
| `src/lib/__tests__/route-access.test.ts` | new — prefix matching + role matrix |
| `src/lib/nav-items.ts` | new — nav tables extracted from `Navigation.tsx` + `navLabelFor` |
| `src/lib/__tests__/nav-items.test.ts` | new — the nav↔middleware parity regression guard |
| `src/app/no-access/page.tsx` | new — server route; reads `from`/`need`, passes them as props |
| `src/components/access/NoAccessCard.tsx` | new — the client screen |
| `src/middleware.ts` | three redirects → one rewrite; prefix constants deleted |
| `src/components/Navigation.tsx` | `canSeeNavItem`/`adminOnly`/`minRole` deleted; dim + lock instead of filter, both renderers |
| `src/app/today/page.tsx` | drop the below-MANAGER desktop bounce; container replaces `MScreen` |
| `src/components/mobile/today/TodayChef.tsx` | two-column grid at `md:` |
