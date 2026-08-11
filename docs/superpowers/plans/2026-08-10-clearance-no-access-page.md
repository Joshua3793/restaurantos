# Clearance: In-Place No-Access Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop redirecting users out of pages their clearance does not reach; show an explanatory screen at the page's own URL, and dim + lock the nav items they cannot open.

**Architecture:** One client-safe module (`src/lib/route-access.ts`) owns the route→clearance table. `src/middleware.ts` reads it and answers a blocked request with `NextResponse.rewrite('/no-access')` — a rewrite, not a redirect, so the browser URL never changes. `src/components/Navigation.tsx` reads the same table to dim and lock out-of-reach items instead of hiding them. The nav's data tables move into `src/lib/nav-items.ts` so a `.ts` unit test can assert nav and middleware agree.

**Tech Stack:** Next.js 14 App Router · TypeScript · Tailwind · vitest · lucide-react

## Global Constraints

- `src/lib/route-access.ts` MUST NOT have a `server-only` marker and MUST NOT import *values* from `@prisma/client`. `src/middleware.ts` runs in a restricted runtime. Use `import type { Role } from '@prisma/client'` — erased at compile time. Same rule `src/lib/roles.ts` already documents at its top.
- Clearance gates are **unchanged** from today's middleware: ADMIN for `/setup` + `/settings`; MANAGER for `/pass`, `/reports`, `/cost`, `/variance`, `/signals`; LEAD for `/end-of-day`. Do not add, remove, or relax a gate.
- Tailwind: **flat color tokens only** (`bg-red`, `text-red-text`, `text-ink-3`). Numbered classes (`bg-red-500`) are broken in this project.
- Only `src/**/*.test.ts` is collected by vitest (see `vitest.config.ts`) — **`.tsx` test files are silently ignored**. Every test in this plan is `.ts`.
- Unauthenticated → `/login` and deactivated → `/login?error=deactivated` stay **redirects**. Only the *role* checks become rewrites.
- Run `npm test` after each task. Baseline is **509 passing**; the count only ever goes up.

---

### Task 1: The shared clearance table

**Files:**
- Create: `src/lib/route-access.ts`
- Test: `src/lib/__tests__/route-access.test.ts`

**Interfaces:**
- Consumes: `atLeast` from `src/lib/roles.ts`; `Role` type from `@prisma/client`.
- Produces:
  - `requiredClearance(pathname: string): Role | null`
  - `canAccess(role: Role | null, pathname: string): boolean`
  - `ROUTE_CLEARANCE: ReadonlyArray<readonly [string, Role]>` (exported for the parity test in Task 2)

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/route-access.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { requiredClearance, canAccess, ROUTE_CLEARANCE } from '../route-access'
import { ROLE_ORDER } from '../roles'

describe('requiredClearance', () => {
  it('returns null for routes open to STAFF', () => {
    expect(requiredClearance('/prep')).toBeNull()
    expect(requiredClearance('/count')).toBeNull()
    expect(requiredClearance('/today')).toBeNull()
    expect(requiredClearance('/inventory')).toBeNull()
    expect(requiredClearance('/temps')).toBeNull()
    expect(requiredClearance('/wastage')).toBeNull()
  })

  it('gates the manager routes at MANAGER', () => {
    expect(requiredClearance('/pass')).toBe('MANAGER')
    expect(requiredClearance('/reports')).toBe('MANAGER')
    expect(requiredClearance('/cost')).toBe('MANAGER')
    expect(requiredClearance('/variance')).toBe('MANAGER')
    expect(requiredClearance('/signals')).toBe('MANAGER')
  })

  it('gates setup at ADMIN and end-of-day at LEAD', () => {
    expect(requiredClearance('/setup')).toBe('ADMIN')
    expect(requiredClearance('/settings')).toBe('ADMIN')
    expect(requiredClearance('/end-of-day')).toBe('LEAD')
  })

  it('applies a prefix gate to that route’s children', () => {
    expect(requiredClearance('/setup/suppliers')).toBe('ADMIN')
    expect(requiredClearance('/setup/users')).toBe('ADMIN')
    expect(requiredClearance('/reports/waste')).toBe('MANAGER')
  })

  it('matches on path segments, never on a bare string prefix', () => {
    // '/passport' must NOT inherit '/pass'’s MANAGER gate.
    expect(requiredClearance('/passport')).toBeNull()
    expect(requiredClearance('/setup-guide')).toBeNull()
  })

  it('prefers the longest matching prefix', () => {
    // Guards the ordering rule so a future narrower entry wins without a reorder.
    const longest = [...ROUTE_CLEARANCE]
      .filter(([p]) => '/setup/suppliers' === p || '/setup/suppliers'.startsWith(p + '/'))
      .sort((a, b) => b[0].length - a[0].length)[0]
    expect(requiredClearance('/setup/suppliers')).toBe(longest[1])
  })
})

describe('canAccess', () => {
  it('lets every role into an ungated route', () => {
    for (const role of ROLE_ORDER) {
      expect(canAccess(role, '/count')).toBe(true)
    }
  })

  it('lets OWNER through every gate in the table', () => {
    for (const [prefix] of ROUTE_CLEARANCE) {
      expect(canAccess('OWNER', prefix)).toBe(true)
    }
  })

  it('keeps STAFF out of every gate in the table', () => {
    for (const [prefix] of ROUTE_CLEARANCE) {
      expect(canAccess('STAFF', prefix)).toBe(false)
    }
  })

  it('places LEAD below MANAGER — end-of-day yes, pass no', () => {
    expect(canAccess('LEAD', '/end-of-day')).toBe(true)
    expect(canAccess('LEAD', '/pass')).toBe(false)
    expect(canAccess('LEAD', '/setup')).toBe(false)
  })

  it('gives MANAGER the manager routes but not setup', () => {
    expect(canAccess('MANAGER', '/pass')).toBe(true)
    expect(canAccess('MANAGER', '/reports')).toBe(true)
    expect(canAccess('MANAGER', '/end-of-day')).toBe(true)
    expect(canAccess('MANAGER', '/setup')).toBe(false)
    expect(canAccess('MANAGER', '/setup/suppliers')).toBe(false)
  })

  it('denies a null role on any gated route — never grant on unknown', () => {
    expect(canAccess(null, '/pass')).toBe(false)
    expect(canAccess(null, '/setup')).toBe(false)
  })

  it('allows a null role on an ungated route so loading never blocks the app', () => {
    expect(canAccess(null, '/count')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/route-access.test.ts`
Expected: FAIL — `Failed to resolve import "../route-access"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/route-access.ts`:

```ts
// The ONE route -> clearance table. Both src/middleware.ts (server-side
// enforcement) and src/components/Navigation.tsx (dim + lock) read it, so the
// menu can never again advertise a page the middleware bounces.
//
// Deliberately has NO `server-only` marker and NO value imports from
// @prisma/client: src/middleware.ts runs in a restricted runtime and must be
// able to import this. `import type` is erased at compile time.
import type { Role } from '@prisma/client'
import { atLeast } from '@/lib/roles'

/**
 * Route prefix -> minimum clearance. A prefix covers the route itself and all
 * of its children. Longest matching prefix wins, so a narrower entry can be
 * appended anywhere in the array to override a broader one.
 *
 * `/cost` is inert in practice — the v2 REDIRECTS table in middleware rewrites
 * /cost -> /reports before the role check runs — but it is kept so this table
 * is a faithful copy of the gates it replaced.
 */
export const ROUTE_CLEARANCE: ReadonlyArray<readonly [string, Role]> = [
  ['/setup', 'ADMIN'],
  ['/settings', 'ADMIN'],
  ['/pass', 'MANAGER'],
  ['/reports', 'MANAGER'],
  ['/cost', 'MANAGER'],
  ['/variance', 'MANAGER'],
  ['/signals', 'MANAGER'],
  ['/end-of-day', 'LEAD'],
] as const

/** Clearance needed to open `pathname`, or null when it is open to STAFF+. */
export function requiredClearance(pathname: string): Role | null {
  let bestPrefix = ''
  let bestRole: Role | null = null
  for (const [prefix, role] of ROUTE_CLEARANCE) {
    // Segment match, not string match: '/passport' must not inherit '/pass'.
    const hit = pathname === prefix || pathname.startsWith(prefix + '/')
    if (hit && prefix.length > bestPrefix.length) {
      bestPrefix = prefix
      bestRole = role
    }
  }
  return bestRole
}

/**
 * True when `role` may open `pathname`.
 *
 * A null role (clearance not loaded yet) is denied on every gated route — never
 * grant on unknown. Callers that want to avoid a loading flash should check
 * `role != null` themselves rather than treating null as permitted.
 */
export function canAccess(role: Role | null, pathname: string): boolean {
  const need = requiredClearance(pathname)
  if (need === null) return true
  if (role === null) return false
  return atLeast(role, need)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/route-access.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 36 files, 522 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/lib/route-access.ts src/lib/__tests__/route-access.test.ts
git commit -m "feat(access): one route->clearance table shared by middleware and nav"
```

---

### Task 2: Extract the nav tables + the drift regression guard

The nav data currently lives inside `src/components/Navigation.tsx`, a `.tsx`
client component that vitest does not collect. Moving the data to a `.ts` module
is what makes the parity test — the test that would have caught this whole bug —
possible.

**Files:**
- Create: `src/lib/nav-items.ts`
- Modify: `src/components/Navigation.tsx:20-85` (delete the moved definitions, import them instead) and `src/components/Navigation.tsx:381-384` (delete the dead `navItems` re-export)
- Test: `src/lib/__tests__/nav-items.test.ts`

**Interfaces:**
- Consumes: `requiredClearance` from Task 1.
- Produces:
  - `type NavItem = { href: string; label: string; icon: ComponentType<{ size?: number | string; color?: string }>; exact?: boolean; badgeKey?: 'invoicesReview' | 'priceAlerts' }`
  - `type NavGroup = { label: string; items: NavItem[] }`
  - `navGroups: NavGroup[]`, `setupItems: NavItem[]`, `allNavItems: NavItem[]`
  - `navLabelFor(pathname: string): string | null`

Note the `NavItem` shape has **no** `adminOnly` and **no** `minRole`. Clearance
derives from `href` via `requiredClearance`, so a nav item cannot carry an
opinion that contradicts middleware.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/nav-items.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { navGroups, setupItems, allNavItems, navLabelFor } from '../nav-items'
import { requiredClearance } from '../route-access'

// The clearance each nav destination is expected to need. This is written out
// by hand ON PURPOSE: if someone changes ROUTE_CLEARANCE without thinking about
// the menu, this table disagrees and the test fails.
const EXPECTED: Record<string, string | null> = {
  '/pass': 'MANAGER',
  '/preshift': null,
  '/prep': null,
  '/count': null,
  '/temps': null,
  '/end-of-day': 'LEAD',
  '/invoices': null,
  '/inventory': null,
  '/recipes': null,
  '/menu': null,
  '/reports': 'MANAGER',
  '/variance': 'MANAGER',
  '/signals': 'MANAGER',
  '/sales': null,
  '/wastage': null,
  '/setup': 'ADMIN',
  '/setup/suppliers': 'ADMIN',
  '/setup/revenue-centers': 'ADMIN',
}

describe('nav tables', () => {
  it('exposes every group item and setup item in allNavItems', () => {
    const fromGroups = navGroups.flatMap(g => g.items)
    expect(allNavItems).toHaveLength(fromGroups.length + setupItems.length)
  })

  it('gives every item a non-empty href, label and icon', () => {
    for (const item of allNavItems) {
      expect(item.href.startsWith('/')).toBe(true)
      expect(item.label.length).toBeGreaterThan(0)
      expect(item.icon).toBeTruthy()
    }
  })

  it('has no duplicate hrefs', () => {
    const hrefs = allNavItems.map(i => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })
})

// THE REGRESSION GUARD. The original defect was two clearance tables that
// disagreed: the sidebar advertised Pass/Reports/Variance/Signals/Suppliers/
// Revenue centers to Staff, and middleware bounced them right back out.
describe('nav <-> middleware clearance parity', () => {
  it('covers every nav href in the expectation table', () => {
    for (const item of allNavItems) {
      expect(EXPECTED).toHaveProperty(item.href)
    }
  })

  it('resolves every nav href to the clearance middleware enforces', () => {
    for (const item of allNavItems) {
      expect(requiredClearance(item.href)).toBe(EXPECTED[item.href])
    }
  })
})

describe('navLabelFor', () => {
  it('names the page behind a gated path', () => {
    expect(navLabelFor('/pass')).toBe('Pass')
    expect(navLabelFor('/end-of-day')).toBe('End-of-day')
    expect(navLabelFor('/setup/revenue-centers')).toBe('Revenue centers')
  })

  it('prefers the most specific match', () => {
    // '/setup/suppliers' must resolve to Suppliers, not to the Setup hub.
    expect(navLabelFor('/setup/suppliers')).toBe('Suppliers')
  })

  it('resolves a child path to its parent nav entry', () => {
    expect(navLabelFor('/reports/waste')).toBe('Reports')
  })

  it('returns null for a path no nav item owns', () => {
    expect(navLabelFor('/nowhere')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/nav-items.test.ts`
Expected: FAIL — `Failed to resolve import "../nav-items"`.

- [ ] **Step 3: Create the nav-items module**

Create `src/lib/nav-items.ts` (the arrays are moved verbatim from
`Navigation.tsx:43-85`, minus the `adminOnly` / `minRole` fields):

```ts
// Nav destinations, extracted from Navigation.tsx so a .ts unit test can assert
// they agree with route-access.ts. Deliberately carries NO clearance fields:
// what a user may open is derived from `href` via requiredClearance(), which is
// the same call middleware makes. One table, no drift.
import {
  Sun, Package, FileText, Trash2, BarChart3, BookOpen, UtensilsCrossed,
  ShoppingBag, Settings, ChefHat, Truck, ClipboardList, Activity, Building2,
  Zap, Flame, Thermometer, Clock,
} from 'lucide-react'

export type NavItem = {
  href: string
  label: string
  icon: React.ComponentType<{ size?: number | string; color?: string }>
  exact?: boolean
  badgeKey?: 'invoicesReview' | 'priceAlerts'
}

export type NavGroup = {
  label: string
  items: NavItem[]
}

export const navGroups: NavGroup[] = [
  {
    label: 'TODAY',
    items: [
      { href: '/pass',       label: 'Pass',       icon: Sun },
      { href: '/preshift',   label: 'Pre-shift',  icon: Flame },
      { href: '/prep',       label: 'Prep',       icon: ChefHat },
      { href: '/count',      label: 'Count',      icon: ClipboardList },
      { href: '/temps',      label: 'Temps',      icon: Thermometer },
      { href: '/end-of-day', label: 'End-of-day', icon: Clock },
    ],
  },
  {
    label: 'INBOX',
    items: [
      { href: '/invoices', label: 'Invoices', icon: FileText, badgeKey: 'invoicesReview' },
    ],
  },
  {
    label: 'LIBRARY',
    items: [
      { href: '/inventory', label: 'Inventory', icon: Package },
      { href: '/recipes',   label: 'Recipes',   icon: BookOpen },
      { href: '/menu',      label: 'Menu',      icon: UtensilsCrossed },
    ],
  },
  {
    label: 'INSIGHTS',
    items: [
      { href: '/reports',  label: 'Reports',  icon: BarChart3 },
      { href: '/variance', label: 'Variance', icon: Activity },
      { href: '/signals',  label: 'Signals',  icon: Zap },
      { href: '/sales',    label: 'Sales',    icon: ShoppingBag },
      { href: '/wastage',  label: 'Wastage',  icon: Trash2 },
    ],
  },
]

export const setupItems: NavItem[] = [
  { href: '/setup',                 label: 'Setup',           icon: Settings, exact: true },
  { href: '/setup/suppliers',       label: 'Suppliers',       icon: Truck },
  { href: '/setup/revenue-centers', label: 'Revenue centers', icon: Building2 },
]

/** Every destination the menu offers, groups first then setup. */
export const allNavItems: NavItem[] = [
  ...navGroups.flatMap(g => g.items),
  ...setupItems,
]

/**
 * Human name of the page at `pathname` — used by the no-access screen to say
 * "You can't open Pass" instead of echoing a raw path. Longest matching href
 * wins so '/setup/suppliers' resolves to Suppliers, not to the Setup hub.
 */
export function navLabelFor(pathname: string): string | null {
  let bestHref = ''
  let bestLabel: string | null = null
  for (const item of allNavItems) {
    const hit = pathname === item.href || pathname.startsWith(item.href + '/')
    if (hit && item.href.length > bestHref.length) {
      bestHref = item.href
      bestLabel = item.label
    }
  }
  return bestLabel
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/nav-items.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Point Navigation.tsx at the extracted module**

In `src/components/Navigation.tsx`:

Delete the `NavItem` type (lines 20-29), `canSeeNavItem` (lines 31-36), the
`NavGroup` type (lines 38-41), `navGroups` (lines 43-79) and `setupItems`
(lines 81-85). Replace them with an import next to the existing ones:

```ts
import { navGroups, setupItems, type NavItem } from '@/lib/nav-items'
```

Trim the now-unused icon imports from the `lucide-react` import at lines 6-11.
The icons still used *directly by the component* are exactly:

```ts
import { X, LogOut, ChevronRight, Wifi, WifiOff } from 'lucide-react'
```

Delete the dead re-export at the bottom of the file (lines 381-384) —
`grep -rn "navItems" src/` confirms nothing imports it:

```ts
// DELETE THESE LINES:
// const _allNavItems = navGroups.flatMap(g => g.items)
// export { _allNavItems as navItems }
```

Delete the unused local at line 177 (`const allNavItems = navGroups.flatMap(...)`
is assigned and never read).

Leave `visibleSetupItems` and the two `.filter(...)` calls alone for now —
Task 5 replaces them. `canSeeNavItem` is gone, so temporarily change the three
call sites to keep the file compiling:

- line 176: `const visibleSetupItems = setupItems`
- line 199: `const visibleItems = group.items`
- line 327: `const visibleItems = group.items`

Also delete the now-unused `atLeast` and `UserRole` imports if TypeScript flags
them; `useUser` is still needed.

- [ ] **Step 6: Verify the app still builds**

Run: `npm run build`
Expected: build succeeds. `/setup` and the other API routes still show
`ƒ (Dynamic)`. No new type errors.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: 37 files, 531 tests, 0 failures.

- [ ] **Step 8: Commit**

```bash
git add src/lib/nav-items.ts src/lib/__tests__/nav-items.test.ts src/components/Navigation.tsx
git commit -m "refactor(nav): extract nav tables to a testable module + parity guard"
```

---

### Task 3: Middleware rewrites instead of redirecting

**Files:**
- Modify: `src/middleware.ts:9-19` (delete the three prefix constants), `src/middleware.ts:111-123` (the checks)

**Interfaces:**
- Consumes: `requiredClearance` from Task 1.
- Produces: a rewrite to `/no-access?from=<pathname>&need=<Role>` — Task 4 builds that route and reads those two params.

- [ ] **Step 1: Replace the prefix constants with the shared table**

In `src/middleware.ts`, delete lines 9-19 — `ADMIN_PREFIXES`,
`MANAGER_PREFIXES`, `LEAD_PREFIXES` and their comments. The LEAD comment about
`/end-of-day` is worth keeping; move it into `ROUTE_CLEARANCE` in
`src/lib/route-access.ts` above the `['/end-of-day', 'LEAD']` entry:

```ts
  // A Lead runs the operational close (checklist, temps, sign-off) and WRITES
  // the handover note (PATCH /api/eod/close), but does not read the handover
  // money recap (GET /api/eod/handover) — that stays MANAGER. See src/app/api/eod/*.
  ['/end-of-day', 'LEAD'],
```

Add the import beside the existing `@/lib/roles` one:

```ts
import { requiredClearance } from '@/lib/route-access'
```

- [ ] **Step 2: Replace the three redirects with one rewrite**

Replace lines 111-123 (the `needs` helper and the three `if` blocks) with:

```ts
  // Role-gated route the user cannot reach → RENDER the no-access screen at
  // this URL. Deliberately a rewrite, not a redirect: the address bar keeps
  // reading /pass, back/forward behave, and the user can carry on navigating
  // from the sidebar instead of being flung back to /count with no explanation.
  const need = requiredClearance(pathname)
  if (need && !atLeast(role, need)) {
    const url = request.nextUrl.clone()
    url.pathname = '/no-access'
    url.searchParams.set('from', pathname)
    url.searchParams.set('need', need)
    return NextResponse.rewrite(url)
  }

  return response
```

`atLeast` stays imported; `ROLE_RANK` stays imported (the role fallback at
lines 105-109 still uses it). Everything above line 103 — public routes, v2
REDIRECTS, the dev bypass, the Supabase client, the unauthenticated and
deactivated redirects — is untouched.

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: build succeeds, no unused-import errors.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: 531 tests, 0 failures (middleware has no unit tests; this confirms
nothing regressed).

- [ ] **Step 5: Commit**

```bash
git add src/middleware.ts src/lib/route-access.ts
git commit -m "feat(access): rewrite blocked routes to /no-access instead of redirecting"
```

---

### Task 4: The no-access screen

**Files:**
- Create: `src/app/no-access/page.tsx` (server component)
- Create: `src/components/access/NoAccessCard.tsx` (client component)

**Interfaces:**
- Consumes: `navLabelFor` (Task 2), `ROLE_LABELS` + `ROLE_RANK` from `src/lib/roles.ts`, `useUser` from `src/contexts/UserContext`.
- Produces: `NoAccessCard({ pageLabel, need }: { pageLabel: string | null; need: Role | null })`.

**⚠️ Do NOT use `useSearchParams()` on this page.** Under a middleware rewrite
the browser URL stays `/pass` — the client hook reads the *browser* URL and
would find no `need` param, while the server render has it. The params must be
read server-side from the `searchParams` prop and passed down as props. Getting
this wrong produces a screen that renders correctly on hard load and goes blank
on client navigation.

- [ ] **Step 1: Create the client card**

Create `src/components/access/NoAccessCard.tsx`:

```tsx
'use client'
import Link from 'next/link'
import { Lock } from 'lucide-react'
import type { Role } from '@prisma/client'
import { ROLE_LABELS } from '@/lib/roles'
import { useUser } from '@/contexts/UserContext'

/**
 * Shown in place of a page the current clearance cannot open. Rendered by a
 * middleware REWRITE, so the URL is still the page the user asked for — which
 * is the point: no silent bounce, and the sidebar stays available.
 *
 * `pageLabel` and `need` arrive as props, NOT from useSearchParams(): a rewrite
 * leaves the browser URL untouched, so the client router cannot see the params
 * middleware attached.
 */
export function NoAccessCard({
  pageLabel,
  need,
}: {
  pageLabel: string | null
  need: Role | null
}) {
  const { role } = useUser()
  const target = pageLabel ?? 'this page'
  const needLabel = need ? ROLE_LABELS[need] : null

  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-4">
      <span className="grid place-items-center w-14 h-14 rounded-2xl bg-bg-2 text-ink-3 mb-5">
        <Lock size={24} />
      </span>

      <h1 className="text-[24px] font-semibold text-ink tracking-[-0.03em] m-0">
        You don&rsquo;t have access to {target}
      </h1>

      <p className="text-[14px] text-ink-2 mt-3 max-w-[420px] leading-relaxed">
        {needLabel
          ? <>This page needs <strong className="text-ink font-semibold">{needLabel}</strong> clearance. Ask your manager to raise your access if you need it.</>
          : <>Ask your manager to raise your access if you need this page.</>}
      </p>

      {role && (
        <p className="font-mono text-[11px] text-ink-3 mt-4">
          Your clearance: {ROLE_LABELS[role]}
        </p>
      )}

      <Link
        href="/today"
        className="mt-7 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-ink text-paper text-[13.5px] font-medium hover:opacity-90 transition-opacity"
      >
        Back to Today
      </Link>
    </div>
  )
}
```

- [ ] **Step 2: Create the route**

Create `src/app/no-access/page.tsx`:

```tsx
import type { Role } from '@prisma/client'
import { ROLE_RANK } from '@/lib/roles'
import { navLabelFor } from '@/lib/nav-items'
import { NoAccessCard } from '@/components/access/NoAccessCard'

// Reached by a middleware rewrite, never by a redirect — the browser URL stays
// on the page the user asked for. Must be dynamic: the rendered content depends
// on the ?from and ?need params middleware attaches per request.
export const dynamic = 'force-dynamic'

function asRole(value: string | string[] | undefined): Role | null {
  if (typeof value !== 'string') return null
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, value) ? (value as Role) : null
}

export default function NoAccessPage({
  searchParams,
}: {
  searchParams: { from?: string | string[]; need?: string | string[] }
}) {
  const from = typeof searchParams.from === 'string' ? searchParams.from : null
  return (
    <NoAccessCard
      pageLabel={from ? navLabelFor(from) : null}
      need={asRole(searchParams.need)}
    />
  )
}
```

- [ ] **Step 3: Verify it builds and is dynamic**

Run: `npm run build`
Expected: build succeeds, and the route table lists `/no-access` as
`ƒ (Dynamic)` — **not** `○ (Static)`. A static `/no-access` would freeze one
set of params into the build and show every user the same message.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: 531 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/app/no-access/page.tsx src/components/access/NoAccessCard.tsx
git commit -m "feat(access): no-access screen explaining the clearance needed"
```

---

### Task 5: Dim + lock nav items instead of hiding them

**Files:**
- Modify: `src/components/Navigation.tsx` — the desktop sidebar renderer, the setup group, and the mobile "More" drawer

**Interfaces:**
- Consumes: `canAccess` (Task 1), `navGroups` / `setupItems` (Task 2).
- Produces: no exports; UI only.

- [ ] **Step 1: Add the imports and the lock predicate**

In `src/components/Navigation.tsx`, add to the lucide import:

```ts
import { X, LogOut, ChevronRight, Wifi, WifiOff, Lock } from 'lucide-react'
```

and next to the other lib imports:

```ts
import { canAccess } from '@/lib/route-access'
```

Inside `NavigationInner`, beside the existing `isActive` helper, add:

```ts
  // Visual lock only. Enforcement is middleware's job — this just stops the
  // menu from advertising pages it will refuse.
  //
  // Gated on `role != null` on purpose: while /api/me is in flight `role` is
  // null and canAccess() denies everything, which would flash a fully-gray
  // sidebar on every page load.
  const isLocked = (href: string) => role != null && !canAccess(role, href)
```

- [ ] **Step 2: Remove the three filters left over from Task 2**

Replace the temporary lines from Task 2 Step 5:

- line ~176: `const visibleSetupItems = setupItems` → delete the variable entirely; use `setupItems` directly at its one call site in the setup group.
- in the desktop renderer: delete `const visibleItems = group.items` and map over `group.items` directly.
- in the mobile drawer: delete `const visibleItems = group.items` and map over `group.items` directly. Also delete the `if (visibleItems.length === 0) return null` guard — no group is ever empty now.

- [ ] **Step 3: Dim + lock in the desktop sidebar**

In the desktop `navGroups.map(...)` renderer, inside the item map, add `locked`
beside the existing `active` and `badge`:

```tsx
                {group.items.map(item => {
                  const active = isActive(item)
                  const badge  = getBadge(item.badgeKey)
                  const locked = isLocked(item.href)
                  const { href, label, icon: Icon } = item
                  return (
                    <Link
                      key={`${href}-${label}`}
                      href={href}
                      title={locked ? 'You don’t have access to this page' : undefined}
                      className={`group flex items-center gap-[10px] px-[10px] py-2 rounded-lg text-[13.5px] font-medium tracking-[-0.005em] whitespace-nowrap transition-colors ${
                        active
                          ? 'bg-paper text-ink'
                          : locked
                            ? 'text-line-2 opacity-40 hover:opacity-60 hover:bg-[#18181b]'
                            : 'text-line-2 hover:bg-[#18181b] hover:text-bg'
                      }`}
                    >
                      <span className={active ? 'text-ink' : 'text-ink-3 group-hover:text-line-2'}>
                        <Icon size={16} />
                      </span>
                      <span className="flex-1">{label}</span>
                      {locked ? (
                        <Lock size={12} className="text-ink-3 shrink-0" />
                      ) : badge > 0 ? (
                        <span className="font-mono text-[10px] px-[6px] py-[1px] rounded-full font-semibold leading-none tracking-normal bg-gold text-ink">
                          {badge > 99 ? '99+' : badge}
                        </span>
                      ) : null}
                    </Link>
                  )
                })}
```

Note the badge `className` collapses the old `active ? 'bg-gold text-ink' : 'bg-gold text-ink'` ternary — both branches were identical.

Apply the same `locked` treatment to the setup group's `setupItems.map(...)`
renderer just below it, which has the same `<Link>` shape but no badge:

```tsx
            {setupItems.map(item => {
              const active = isActive(item)
              const locked = isLocked(item.href)
              const { href, label, icon: Icon } = item
              return (
                <Link
                  key={href}
                  href={href}
                  title={locked ? 'You don’t have access to this page' : undefined}
                  className={`group flex items-center gap-[10px] px-[10px] py-2 rounded-lg text-[13.5px] font-medium tracking-[-0.005em] whitespace-nowrap transition-colors ${
                    active
                      ? 'bg-paper text-ink'
                      : locked
                        ? 'text-line-2 opacity-40 hover:opacity-60 hover:bg-[#18181b]'
                        : 'text-line-2 hover:bg-[#18181b] hover:text-bg'
                  }`}
                >
                  <span className={active ? 'text-ink' : 'text-ink-3 group-hover:text-line-2'}>
                    <Icon size={16} />
                  </span>
                  <span className="flex-1">{label}</span>
                  {locked && <Lock size={12} className="text-ink-3 shrink-0" />}
                </Link>
              )
            })}
```

- [ ] **Step 4: Dim + lock in the mobile "More" drawer**

In the drawer's `[...navGroups, { label: 'SETUP', items: setupItems }].map(...)`
block, replace the item map with:

```tsx
                    {group.items.map((item, i) => {
                      const active = isActive(item)
                      const badge  = getBadge(item.badgeKey)
                      const locked = isLocked(item.href)
                      const { href, label, icon: Icon } = item
                      return (
                        <Link
                          key={`drawer-${href}-${label}`}
                          href={href}
                          onClick={() => setMoreOpen(false)}
                          className={`flex items-center gap-3 px-3 py-2.5 transition-colors ${i > 0 ? 'border-t border-line' : ''} ${active ? 'bg-gold-soft/50' : 'hover:bg-bg-2'} ${locked ? 'opacity-45' : ''}`}
                        >
                          <span className={`grid place-items-center w-9 h-9 rounded-[10px] shrink-0 ${active ? 'bg-ink text-gold' : 'bg-bg-2 text-ink-2'}`}>
                            <Icon size={17} color={active ? '#d97706' : '#27272a'} />
                          </span>
                          <span className={`flex-1 text-[14px] ${active ? 'text-ink font-semibold' : 'text-ink-2 font-medium'}`}>{label}</span>
                          {!locked && badge > 0 && (
                            <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gold text-ink min-w-[18px] text-center leading-none">
                              {badge > 99 ? '99+' : badge}
                            </span>
                          )}
                          {locked
                            ? <Lock size={15} className="text-ink-4 shrink-0" />
                            : <ChevronRight size={16} className="text-ink-4 shrink-0" />}
                        </Link>
                      )
                    })}
```

- [ ] **Step 5: Verify it builds**

Run: `npm run build`
Expected: build succeeds, no unused-variable errors (confirm `canSeeNavItem`,
`visibleSetupItems`, `visibleItems`, `atLeast` and `UserRole` are all gone from
the file if no longer referenced).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: 531 tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/components/Navigation.tsx
git commit -m "feat(nav): dim + lock out-of-reach items instead of hiding them"
```

---

### Task 6: `/today` renders on desktop for below-MANAGER roles

**Files:**
- Modify: `src/app/today/page.tsx:15-30`
- Modify: `src/components/mobile/today/TodayChef.tsx:50-73`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing exported.

Managers keep landing on `/pass` — only the below-MANAGER `→ /count` bounce is
removed. `TodayManager` needs no desktop layout: MANAGER+ bounces before it
would render.

`MScreen` cannot be reused here — it is `md:hidden`
(`src/components/mobile/kit.tsx:12`) and is shared with other mobile-only
screens, so it must not be changed. `/today` gets its own container instead.
Every other kit primitive (`MPageHead`, `MCard`, `MSectionLabel`,
`MQuickAction`, `MProgressBar`) is already viewport-agnostic.

- [ ] **Step 1: Drop the below-MANAGER bounce**

In `src/app/today/page.tsx`, replace the `useEffect` and the return block
(lines 15-30) with:

```tsx
  // Desktop: MANAGER+ still land on the Pass, their real dashboard. Everyone
  // below now RENDERS Today here rather than being bounced to /count — the
  // bounce was half of why a Staff user could never navigate anywhere.
  useEffect(() => {
    if (loading) return
    if (typeof window === 'undefined' || window.innerWidth < 768) return
    if (role != null && atLeast(role, 'MANAGER')) router.replace('/pass')
  }, [role, loading, router])

  if (loading) {
    return (
      <div className="px-4 pb-28 md:px-0 md:pb-0">
        <div className="pt-10 font-mono text-[11px] text-ink-3">Loading…</div>
      </div>
    )
  }

  const isManager = role != null && atLeast(role, 'MANAGER')
  return (
    // Replaces MScreen, which is md:hidden and shared with mobile-only screens.
    // On desktop the padding comes from AppShell, so it is cleared at md+.
    <div className="min-h-screen bg-bg text-ink px-4 pb-28 md:min-h-0 md:px-0 md:pb-0">
      {isManager ? <TodayManager /> : <TodayChef />}
    </div>
  )
```

Remove the now-unused `MScreen` import from the `@/components/mobile/kit` import
line; nothing else from that module is imported by this file.

- [ ] **Step 2: Let TodayChef breathe on desktop**

In `src/components/mobile/today/TodayChef.tsx`, widen the two stacked blocks at
`md:`. Change the prep list container (line 51) from:

```tsx
      <div className="flex flex-col gap-2">
```

to:

```tsx
      <div className="flex flex-col gap-2 md:grid md:grid-cols-2 md:gap-3">
```

and the quick-actions grid (line 68) from:

```tsx
      <div className="grid grid-cols-2 gap-2">
```

to:

```tsx
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
```

- [ ] **Step 3: Verify it builds**

Run: `npm run build`
Expected: build succeeds, no unused-import error for `MScreen`.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: 531 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/app/today/page.tsx src/components/mobile/today/TodayChef.tsx
git commit -m "feat(today): render Today on desktop for below-manager roles"
```

---

### Task 7: End-to-end verification as a real Staff user

Unit tests cover the table; nothing so far has exercised the actual rewrite in a
browser. This task is the proof.

**⚠️ `DEV_AUTH_BYPASS=true` makes this untestable.** It short-circuits middleware
entirely (`src/middleware.ts:57`) and `requireSession()` returns the OWNER — so
no gate ever fires and the sidebar shows nothing locked. The bypass must be off
and you must sign in as a genuine STAFF user.

**Files:** none — verification only.

- [ ] **Step 1: Disable the dev bypass**

In the worktree's `.env` (a symlink to the main checkout's — **edit the real
file, note that this affects the main checkout too, and restore it afterwards**),
set:

```
DEV_AUTH_BYPASS=false
```

- [ ] **Step 2: Start the dev server**

Use `preview_start` with the `.claude/launch.json` entry for this worktree — do
not use `npm run dev` via Bash. Confirm the server is serving **this worktree**,
not the main checkout: `preview_start` reads `launch.json` from the main repo and
will otherwise run the server there, showing you code you did not write.

- [ ] **Step 3: Sign in as a STAFF user and check each behaviour**

| Check | Expected |
|---|---|
| Sidebar | 17 items visible; Pass, End-of-day, Reports, Variance, Signals, Setup, Suppliers, Revenue centers dimmed with a lock glyph |
| Click "Reports" | URL becomes and **stays** `/reports`; the no-access screen renders; sidebar still present |
| Copy of the message | "You don't have access to Reports" · "This page needs Manager clearance" · "Your clearance: Staff" |
| Browser Back | Returns to the previous page, not into a redirect loop |
| Hard-reload on `/reports` | Same screen, URL still `/reports` |
| Click "Count" | Opens normally — ungated routes are unaffected |
| "Back to Today" button | Lands on `/today`, which now renders on desktop rather than bouncing to `/count` |
| Desktop `/today` | Two-column prep grid and four-across quick actions, not a phone-width column |

- [ ] **Step 4: Confirm the manager path is unchanged**

Sign in as a MANAGER (or temporarily raise the test user). Expected: `/` still
lands on `/pass` on desktop; Pass/Reports/Variance/Signals are **not** dimmed;
Setup, Suppliers and Revenue centers **are** dimmed (ADMIN gate, unchanged from
today's behaviour).

- [ ] **Step 5: Restore the dev bypass**

Set `DEV_AUTH_BYPASS=true` back in `.env`. This file is shared with the main
checkout via the symlink — leaving it off will silently change behaviour in the
user's other session.

- [ ] **Step 6: Commit anything the verification turned up**

If a fix was needed, commit it with a message naming what the browser revealed.
If nothing needed fixing, there is nothing to commit — say so rather than
inventing a commit.

---

## Risks to watch during implementation

- **`usePathname()` under a middleware rewrite** may report `/no-access` rather
  than the browser path `/reports`. Impact is cosmetic — the sidebar's active
  highlight — and the no-access screen does not depend on it (it reads `from`
  from props). If the highlight is wrong, leave it; do not add a workaround
  unless the user asks.
- **Soft navigation through a rewrite.** A `<Link>` click issues an RSC request
  that middleware rewrites via the `x-nextjs-rewrite` header. This is standard
  Next behaviour, but if a locked link renders a blank page on click while a
  hard reload works, that is the mechanism to investigate first.
- **`npm run build` in the main checkout gives bogus failures while `next dev` is
  running**, and `next build` rewrites `tsconfig.json`. All builds in this plan
  run inside the worktree, which is why it exists.
