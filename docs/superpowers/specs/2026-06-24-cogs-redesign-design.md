# COGS redesign — accurate counted Beginning/Ending inventory

**Date:** 2026-06-24
**Status:** Approved

## Problem (audited against live data)

The COGS card shows **$0** for Beginning/Ending inventory. Four stacked bugs:

1. **RC-mode reads `StockAllocation`.** The tab always passes the active RC (CAFE).
   CAFE is the *default* RC and has **0 allocation rows** (default stock lives in
   `stockOnHand`), so begin = end = **$0**. ([cogs/route.ts:91-137])
2. **Bounds key on `finalizedAt`, not `sessionDate`.** A Jun 1–23 period picks
   opening = April 8 because the real "Full Count Jun 1st" was *approved* Jun 10.
3. **Quick (single-item) counts pollute bounds.** Any finalized count is treated as a
   full snapshot, so a 1-item quick count ($241) becomes "ending inventory" vs the
   real full count of **$17,670**.
4. **RC-mode uses current allocation for both begin and end** → they cancel, no time
   dimension.

## Data-model facts

- `InventorySnapshot` has **no RC column** — a snapshot's RC is its session's RC.
- Per-RC *counted* inventory therefore exists only from RC-scoped FULL counts.
- A global (rc=null) count writes `stockOnHand`, which **is** the default-RC pool.

## Decisions (confirmed with user)

- **COGS is RC-dependent; "All RCs" = global.**
- **Default RC inherits the global count** (option b): since a global count writes the
  default pool, the default RC uses global FULL counts as its bounds. Only non-default
  RCs (e.g. Catering) need their own RC-scoped FULL counts.
- Begin/End must be **counted** stock (FULL counts), picked accurately.
- This round: COGS only. Wiring the shared range picker into the other tabs is a
  follow-up.

## Design

### 1. `periodSnapshotBounds(startMs, endMs, opts?)` — RC-aware, accurate
- Consider only `status='FINALIZED'` **`type='FULL'`** counts.
- **Scope:** `scopeRc = (rcId && !isDefault) ? rcId : null`. All-RCs and default-RC both
  use global (null) counts; non-default RC uses its own.
- Key on **`sessionDate`** (not `finalizedAt`): sort desc by sessionDate; Beginning =
  first with `sessionDate ≤ startMs`; Ending = first with `sessionDate ≤ endMs`.
- Value/byCategory summed from that session's `InventorySnapshot` rows.
- Returns `{ opening, closing }`, each `null` when no qualifying count.

### 2. `computePeriodCogs` (insights/food-cost-variance)
- Unchanged signature; inherits the FULL-only + sessionDate fix (it had the same bugs).
  Stays global.

### 3. `api/reports/cogs` route
- Remove the `StockAllocation` begin/end blocks entirely.
- `periodSnapshotBounds(start, end, { rcId, isDefault })` for both bounds.
- Purchases (`periodPurchases`) and food sales stay RC-scoped — unchanged.
- Response carries, per bound: `value`, `sessionDate`, `sessionId`, and a state:
  `needsCount` (no qualifying count) / `sameAsOpening` (begin===end, ending assumed
  unchanged).

### 4. `CogsTab.tsx`
- Replace bespoke start/end inputs + "Calculate" button with the shared
  **`DateRangePicker`** (presets + custom); auto-recompute on range or RC change.
- Begin/End cards render the count `sessionDate`, and explicit "No full count yet" /
  "No full count for [RC] — run an RC count or view All RCs" / "assumes unchanged"
  states instead of a silent $0.

## Expected result on current data

- **All RCs**, Jun 1–23 → Beginning = Ending = **$17,670** (only one FULL count exists),
  flagged "ending assumes unchanged"; COGS = purchases. (Was $0.)
- **Catering** → "No full count for Catering" until an RC-scoped FULL count is run.

## Out of scope

Range picker on Sales/Inventory/Purchasing/Prep tabs (follow-up); per-RC historical
snapshot storage; reconstructing inventory from movements.
