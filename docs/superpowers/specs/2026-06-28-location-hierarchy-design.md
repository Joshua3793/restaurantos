# Location → Revenue Center Hierarchy

**Date:** 2026-06-28
**Status:** Design (approved foundation; spec under review)

## Problem

Today the app's `RevenueCenter` is a **flat** concept. Cafe, Catering, etc. are
all peers; every transaction points at exactly one `revenueCenterId`. Two things
break because of this:

1. **Biased sales analytics.** The "Cafe" revenue center mixes kitchen food and
   bar drinks into one bucket. Sales attributed to Cafe read as effectively 100%
   food at full yield, which is not real — drink sales are invisible as their own
   margin story. A manager cannot see "what of Cafe is food vs. what is bar."

2. **No notion of who owns what.** Roles (`ADMIN/MANAGER/STAFF`) are global.
   There is no way to say "this person manages the Cafe," "this person runs only
   the Bar," or "these cooks work in the Kitchen." Everyone sees every revenue
   center.

What the business actually is: **locations / distinct businesses** (the Cafe, the
Catering operation), and **within each, operational units** (kitchen, bar) that
can optionally be split out. We want managers to see a whole location's rolled-up
performance, and sub-managers / line staff to see and operate only their unit.

## Goals

- Introduce a two-level hierarchy: **Location** (parent) → **Revenue Center**
  (operational leaf), matching restaurant/Toast industry vocabulary.
- Keep almost all existing operational data and code working unchanged — every
  current `revenueCenterId` FK stays a leaf revenue center.
- Locations are a **read-only aggregation lens**; all writes happen at the
  revenue-center level (no cross-RC contamination).
- Add **scoped access**: keep global role as the capability tier, add a per-user
  assignment of which node(s) they can see/act on.
- Give each revenue center a **type** (`FOOD` / `DRINK`) that drives both
  cost-vocabulary ("food cost %" vs "pour cost %") and per-RC target cost.

## Non-goals (YAGNI)

- Arbitrary-depth nesting. Exactly two levels (Location → RC).
- `RETAIL` / `EVENTS` RC types. Only `FOOD` and `DRINK` now; the type field is an
  extensible string, so more can be added later without migration.
- A dedicated `CATERING` RC type. Catering is a `FOOD`-typed RC under a Catering
  location.
- Moving any existing operational data between nodes at rollout (see Migration).
- Per-node *roles* (a user being manager in one place, staff in another). Role is
  global; scope only narrows visibility/write-ability.

## Data model

Three schema additions. Nothing existing is removed.

### 1. `Location` (new parent)

Holds the **org-level identity** that today sits awkwardly on `RevenueCenter`:

- `id`, `name`, `color`
- `type` — `restaurant` / `catering` / `other` (moved from RevenueCenter)
- `isDefault` — exactly one default location (replaces RC `isDefault` at the org
  level; see Migration)
- `schedulingMode`, `prepLeadMinutes`, `serviceSchedule` (moved from RevenueCenter)
- `managerName`, `notes`, `description`, `isActive`, `createdAt`

A Location **never holds operational data directly** — it aggregates its child
revenue centers.

### 2. `RevenueCenter` (existing model — additions only)

- `locationId` (NOT NULL) — parent Location. All existing FKs that point at
  `RevenueCenter` are unchanged; an RC is always a leaf.
- `type` (String, default `FOOD`) — `FOOD` | `DRINK`. Drives vocabulary and which
  cost language applies.
- `targetCostPct` (Decimal, nullable) — per-RC target (food ~28%, pour ~18%).
  Replaces the old RC-level `targetFoodCostPct`; the Location dashboard shows a
  revenue-weighted blend of its children's targets.
- Retains operational identity only: `name`, `color`, `isActive`.

The current `isDefault` on RevenueCenter is retained as the **default-stock-pool**
marker (the spine's `InventoryItem.stockOnHand` belongs to the default RC). Its
semantics are unchanged — this is orthogonal to the new Location `isDefault`.

### 3. `UserScope` (new join)

The missing user↔node link.

```
UserScope {
  id
  userId
  locationId      // nullable — set when scoped to a whole location
  revenueCenterId // nullable — set when scoped to a single RC
  createdAt
  @@unique([userId, locationId, revenueCenterId])
}
```

A row scopes a user to a node. A Location-scoped row implicitly grants every
child RC of that location. A user may have multiple rows (e.g. scoped to two RCs
in different locations).

## Access control (role × scope)

- **Global role is unchanged** = *what you can do*. `ADMIN/MANAGER/STAFF` still
  gate `/settings` (ADMIN), `/reports` (MANAGER+), etc. exactly as today via
  `requireSession(minRole)`.
- **UserScope** = *where you can do it*. A new resolver in `src/lib/auth.ts`
  turns a user into a **set of leaf RC ids** they may touch:
  - ADMIN → all RCs (bypasses scope entirely).
  - User with **no** UserScope rows → all RCs (backward-compatible; assignment
    only ever *narrows*). This keeps the app fully working on day one before any
    assignments exist.
  - User scoped to a Location → all child RCs of that location.
  - User scoped to RC(s) → exactly those.
- The resolved RC-id set is folded into the **existing `where.revenueCenterId`
  filters** already wired through every page (sales, count, inventory, recipes,
  invoices, prep, wastage). Scoping reuses plumbing that already exists — it does
  not introduce a parallel filter path.
- **Writes are scoped too**, not just reads. A bartender scoped to Bar cannot
  count Kitchen stock. Each mutating handler intersects its target
  `revenueCenterId` with the caller's resolved set and returns 403 on miss.

## Location = read-only lens · Revenue Center = write boundary

This is the no-contamination guarantee, enforced structurally.

- **Selecting a Location** → an **aggregated, read-only dashboard**: blended
  COGS %, sales, variance, labor across its RCs, plus a per-RC breakdown line.
  No editable grids, no add/import — a Location has no stock of its own.
- **Selecting a Revenue Center** → full operational mode: inventory grid, counts,
  prep, invoice approve, sales import — all writing to that one RC.
- **Server-side firewall:** any write (`POST`/`PATCH`/`DELETE`) that names a
  `locationId` instead of a leaf `revenueCenterId`, or whose target RC is outside
  the caller's resolved scope, is rejected at the API layer. The UI hides
  write affordances at the Location level; the API enforces it regardless of UI.

### Selector UX

The current single RC picker (`RevenueCenterContext` / `MobileRcBar`) becomes
**two-tier**: each Location is a header row that expands to its child RCs.

- Picking a **Location** → read-only aggregate view.
- Picking an **RC** → operational view.
- "All" remains (aggregate of everything the user is scoped to), read-only.
- The picker only shows nodes within the user's scope. A Bar-scoped user sees
  just Bar; a Cafe-Location manager sees Cafe with Kitchen + Bar beneath it.

## Type-driven vocabulary

`RevenueCenter.type` drives a single terminology lookup `vocab[type]`. Costing
**math is identical** (everything still traces to `pricePerBaseUnit` /
`computeRecipeCost`); only the displayed words change. No parallel cost path.

| Concept        | `FOOD`              | `DRINK`                      |
|----------------|---------------------|------------------------------|
| cost %         | Food cost %         | Pour cost % (liquor cost)    |
| the build      | Recipe              | Cocktail / pour spec         |
| section/menu   | Menu                | Drink menu                   |
| inputs         | Ingredients         | Pours / bottles              |
| target         | Target food cost %  | Target pour cost %           |

Consumers of `vocab[type]`: the cost-chrome spine strip, KPI cards (Pass / Sales
/ Reports), report tab titles, and recipe/menu page headings. Implemented as one
map module; sites read labels from it instead of hardcoding "food cost".

### Location aggregation fixes the bias

A Cafe location with a `FOOD` RC (Kitchen) + a `DRINK` RC (Bar) no longer reads
"100% food." Its dashboard shows **food cost % (Kitchen)** and **pour cost %
(Bar)** as separate lines plus a blended COGS %. The unrealistic "100% yield of
food" disappears because drink sales now live in a `DRINK`-typed RC with their
own cost language and target. This is the direct fix to the motivating problem.

## Toast routing

No new mechanism. The existing menu-route sentinels
(`ToastRevenueCenterMap` rows like `menu:BAR`, `menu:CATERING`) already map Toast
menus to a target RC per line item. Post-redesign those targets are simply the
correctly-typed leaf RCs: cocktails → Bar (`DRINK`), brunch → Kitchen (`FOOD`),
both under the Cafe location; catering → the Catering location's RC. The
order-level GUID fallback and menu-level override logic in
`src/lib/toast/sales-sync.ts` are unchanged.

## Migration (zero operational-data movement)

On rollout, **auto-wrap**: for each existing `RevenueCenter`, create a same-named
`Location` as its parent and set the RC's `locationId` to it. Nothing moves —
every existing `revenueCenterId` FK stays valid because RCs remain leaves.

- Existing RC `type` defaults to `FOOD`; existing `targetFoodCostPct` copies into
  the new `targetCostPct`.
- The existing default RC's location becomes the default Location.
- Org metadata (type, scheduling, service schedule) copies up from each RC to its
  new Location.

Then, when the user is ready, they split a location at leisure: rename the "Cafe"
RC → "Kitchen", change its type if needed, add a "Bar" RC (`DRINK`) under the
Cafe Location, and route/assign data going forward. Undivided locations
(Catering) simply stay single-child.

No backfill of historical sales into the not-yet-existing Bar RC is attempted;
the split is forward-looking.

## Build sequence (for the implementation plan)

1. **Schema + migration.** Add `Location`, `RevenueCenter.{locationId,type,
   targetCostPct}`, `UserScope`. Auto-wrap migration script. (Follow the
   pooler-DDL / expand-contract gotchas in CLAUDE.md — direct host unreachable;
   use `$executeRawUnsafe` over the pooler for DDL.)
2. **Scope resolver.** `src/lib/auth.ts`: user → resolved set of leaf RC ids;
   helper to intersect a target RC with the caller's scope (read + write).
   Fold into existing `where` filters across the RC-scoped routes.
3. **Two-tier selector + Location dashboard.** Extend `RevenueCenterContext` to
   carry locations + active node (location vs RC). Read-only aggregate dashboard.
   API-layer write-guard rejecting location-targeted / out-of-scope writes.
4. **Type vocabulary.** `vocab[type]` map; relabel cost-chrome, KPIs, reports,
   recipe/menu headings. Per-RC `targetCostPct` wired into cost-chrome target;
   Location shows blended target.
5. **Settings UI.** Manage locations, revenue centers (with type + target), and
   per-user scope assignments. (ADMIN-only, under `/settings`.)

Each step is independently shippable; steps 1–2 are inert until the UI in 3 uses
them.

## Open decisions / notes

- Two `isDefault` concepts coexist: **Location.isDefault** (the primary business)
  and **RevenueCenter.isDefault** (the default stock pool / `stockOnHand` owner).
  They are orthogonal and both retained. Naming in code should make this explicit
  to avoid confusion.
- Whether the Location dashboard's "blended COGS %" is revenue-weighted or
  simple-average across child RCs — recommend **revenue-weighted** (matches how a
  P&L reads). Confirm during plan.
- Labor cost is referenced as a Location dashboard metric but no labor model
  exists yet in the app; the dashboard will show it only if/when a labor source
  exists. Out of scope for this spec otherwise.
