# Count session: RC-scoped sync + dual stepper + empty count field

Date: 2026-07-01

## Problem

Three issues in the count-session flow (`/count`), all reported from real use:

1. **Sync ignores revenue center.** In a Catering count session, pressing "sync
   from inventory" pulled in the entire Kitchen inventory instead of only
   Catering items. The sync endpoint filters by storage area but not by RC, so
   an RC-scoped session gets flooded with out-of-scope items.

2. **Stepper starts at `0`.** The count field is initialized to `0`, so to type
   a value you must first delete the leading `0`. It should start empty.

3. **Single UOM-dependent stepper is fiddly.** There is one `+/-` stepper whose
   increment silently changes with the unit of measure (`0.1` for kg/L/lb/gal/qt,
   `1` otherwise). Users want an explicit coarse `±1` set and a separate fine
   `±0.1` set so they can reach a target value directly.

## Scope

- `src/app/api/count/sessions/[id]/sync/route.ts` — add the RC filter.
- `src/app/count/page.tsx` — empty count field + dual steppers, both the desktop
  and mobile renderers.

No schema changes, no migration. Verify with `npm run build` (no test suite).

## Design

### 1. RC-scoped sync

The session-*creation* route (`src/app/api/count/sessions/route.ts`) already
scopes items to the RC via the `ItemRevenueCenter` join:

```ts
...(revenueCenterId ? { revenueCenters: { some: { revenueCenterId } } } : {}),
```

The sync route loads `session.revenueCenterId` already. Add the same clause to
its `inventoryItem.findMany` `where` (currently only `isActive`, `isStocked`,
and the optional `storageAreaId` filter):

```ts
where: {
  isActive: true,
  isStocked: true,
  ...(areaIds.length > 0 ? { storageAreaId: { in: areaIds } } : {}),
  ...(session.revenueCenterId
    ? { revenueCenters: { some: { revenueCenterId: session.revenueCenterId } } }
    : {}),
},
```

Behavior: an RC-scoped session (e.g. Catering) syncs only items that are members
of that RC; an unscoped session (`revenueCenterId == null`) keeps the legacy
"all items". This matches creation exactly, so a session's item set is now stable
between create and re-sync.

### 2. Empty count field

`inputQty` is currently `useState(0)` (page.tsx:282) and is read numerically in
several places (unit-change conversion ~778, variance/`effectiveQty` compute
~1966/2273, `confirmLine` ~2218). Change its type to `number | ''` and start it
empty:

- Initial state: `useState<number | ''>('')`.
- Opening a line with existing count keeps the number; a fresh line resets to
  `''` (page.tsx:450, 830). The multi-entry path (line 458) still sets a number.
- Input `onChange`: allow clearing back to empty —
  `e.target.value === '' ? '' : (parseFloat(e.target.value) || 0)`.
- All numeric read sites coerce with `Number(inputQty) || 0` so empty behaves as
  `0` for math (variance preview, confirm, unit conversion).
- Stepper handlers already produce a number and treat the current value as
  `Number(v) || 0`, so stepping up from empty yields `1` / `0.1` as expected.

Empty is purely a display state; a confirmed empty field still records `0`,
unchanged from today.

### 3. Dual steppers (both renderers)

Replace the single stepper with a two-row control, identical logic in the mobile
and desktop blocks:

- **Top row:** `[ −1 ] [ input ] [ +1 ]` — the coarse buttons flank the centered
  count field (the primary, most-used action). Same button size as the field is
  tall.
- **Second row:** `[ −0.1 ] [ +0.1 ]` — smaller buttons, constrained to the
  input's width and centered under it (not full-row width).

Both sets are always visible regardless of UOM. The old `stepBy` UOM branch
(page.tsx:2254) is removed; the input's `step` attribute becomes `0.1`.

Handlers keep the existing clamp-and-round semantics:

```ts
// −1 / −0.1
setInputQty(v => Math.max(0, Math.round(((Number(v) || 0) - STEP) * 100) / 100))
// +1 / +0.1
setInputQty(v => Math.round(((Number(v) || 0) + STEP) * 100) / 100)
```

`Math.max(0, …)` keeps the minimum at 0; `Math.round(x * 100) / 100` keeps two
decimals and kills float artifacts (e.g. `2.3000000000001`). These match the
current behavior exactly, only the increment amounts differ per button.

Layout follows the existing dual-renderer conventions in this file (`sm:hidden`
mobile block before the `hidden sm:block` desktop block); the decimal row uses
horizontal padding equal to the coarse-button width + gap so it lines up under
the input.

## Non-goals

- No change to how counts are saved, to variance math, or to the RC baseline /
  expected-quantity logic in sync.
- No change to the "cases" / extra-entries sub-UI beyond the coercion needed for
  the empty field.
- No new UOM-dependent behavior — the fine step is always `0.1`.

## Verification

`npm run build` (type-check + build; the only automated check in this repo).
Manual check in preview: RC-scoped session syncs only in-scope items; count
field opens empty; both stepper sets adjust by the right amount and clamp at 0.
