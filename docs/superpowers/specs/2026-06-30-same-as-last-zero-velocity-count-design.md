# "Same as last" for zero-velocity count items — Design

**Date:** 2026-06-30
**Status:** Approved (pre-implementation)

## Problem

The inventory is too large to count weekly; in practice a full count happens roughly
once a month (driven by the monthly inventory valuation sent to the accountant). A
subset of items are **not used in the menu and do not move** — their stock is the same
every month. Manually typing a count for each of these during the monthly session is
pure overhead: the number never changes, yet the item must stay in the count so it
contributes to the valuation.

We want a fast way to confirm these unchanged, without weakening the count's existing
**anti-bias principle** (the count UI deliberately does *not* pre-fill the expected qty
so counters don't rubber-stamp theoretical stock — see `src/app/count/page.tsx:446`).

## Goal

Add a "Same as last" confirmation path, available **only** for zero-velocity items,
that records the prior on-hand as the count with zero variance, refreshes the count
date, and is clearly flagged as carried-forward for audit.

## Non-goals (YAGNI)

- No staleness cap or "last physical count too old" warning.
- No per-class count cadence configuration.
- No auto-deactivation of dead stock (the items must remain active for valuation).
- No change to how `expectedQty` itself is computed.

## Decisions (from brainstorming)

| Dimension | Decision |
|---|---|
| Eligibility scope | Zero-velocity items **only** (preserves anti-bias principle) |
| Zero-velocity definition | **No movement since last count** (behavioral) |
| Triggers | Filter (page view) **+** multi-select/confirm-all **+** per-line quick button |
| Traceability | **Flag** carried-forward lines (schema addition) |
| Bulk guardrail | **Summary confirm** dialog (count + total value) |

## Design

### 1. Eligibility — the `noMovement` signal

A count line is **eligible** when its item has had **zero stock movements since the
item's own last count** — no consumption (sales→recipe depletion), no receipts
(invoice/manual), no wastage, no pulls/transfers. The expected-qty computation
(`src/lib/count-expected.ts`) already queries exactly these movements over the
per-item `lastCountDate` window; we piggyback on that same query to emit a per-line
boolean.

- `noMovement` is **computed at fetch time**, not stored, and returned on each line
  from the count session GET route. Deriving it from the same movement data that
  produces `expectedQty` guarantees the two can never disagree: for a no-movement
  item, `expectedQty == last counted qty` by construction, so "same as last" records
  an honest zero-variance number.
- **Never-counted items are ineligible.** An item with no prior finalized count has no
  "last" to carry forward (and its window is its entire history, so every movement —
  or the absence of a baseline — disqualifies the shortcut). These must be counted
  normally.

### 2. Recording — what "Same as last" writes

Both the per-line button and the bulk action route through the **existing
`confirmLine` path** so they inherit:

- the offline durability queue (`enqueueCountMutation`),
- the 409 cross-device merge,
- count-date refresh,
- live spine-price valuation (`pricePerBaseUnit ?? priceAtCount`).

It records `countedQty = expectedQty` expressed in the line's count UOM, yielding
`variancePct = 0` and `varianceCost = 0`. The single addition vs. a typed count: it
sets `carriedForward = true`.

### 3. Schema — traceability

One additive field on `CountLine`:

```prisma
model CountLine {
  // ...existing fields...
  carriedForward  Boolean  @default(false)
}
```

- `true` when the count originated from "Same as last" (single or bulk); `false` for
  a typed/manual count (including "Out of stock" and normal Confirm).
- Read by the count history view and the variance report to badge carried-forward
  vs. physically-counted lines.
- Expand-contract safe: additive, defaulted, no backfill required. Apply over the
  pooler per the project's migration workaround (no full-schema diff).

### 4. UI — three triggers (all within the count session)

Dual-renderer: every UI addition is mirrored in both the mobile (`block sm:hidden`)
and desktop (`hidden sm:block`) line blocks.

1. **Filter — "No movement":** a segment/toggle that narrows visible lines to
   `noMovement === true && countedQty === null && !skipped`. Lets the user isolate the
   stale-but-stable tail for the monthly session.
2. **Per-line quick button — "Same as last":** rendered on eligible, uncounted lines
   beside Confirm / Out of stock / Skip. One tap → `confirmLine` with the carried-forward
   path. No typing, forces an implicit per-item glance.
3. **Bulk — "Confirm all unchanged":** within the filtered view, multi-select
   (including select-all) → "Confirm all unchanged" → **summary dialog** → commit each
   selected line through the carried-forward confirm path.
   - **Summary dialog** text: "Confirm N items as unchanged — $X total value?" where
     `$X = Σ (expectedQty × live spine price)` over the selected lines. This surfaces
     the dollar figure heading to the accountant before committing.

### 5. Data flow

```
GET /api/count/sessions/[id]
  → build lines (existing) + derive noMovement per line from movement query
  → lines include { ...existing, noMovement }

User action (per-line OR bulk select → confirm-all → summary dialog confirm)
  → confirmLine(line, expectedQtyInCountUom, { carriedForward: true })
     → PATCH /api/count/sessions/[id]/lines/[lineId]
        body adds carriedForward: true
        records countedQty = expectedQty, variance 0, refreshes count date
  → optimistic update + offline queue fallback (existing)

Finalize (existing) → snapshot/valuation unchanged; carriedForward persists for audit
```

### 6. Error handling

- Reuses `confirmLine`'s existing offline-queue + 409-merge durability. Carried-forward
  mutations enqueue identically on failure (queue payload gains `carriedForward: true`).
- Bulk action commits lines independently; a single line's failure falls back to the
  queue without aborting the batch (mirrors current per-line behavior).
- If an eligible line is concurrently counted on another device (409), the existing
  per-line merge applies; the bulk action skips it (already counted).

### 7. Testing / verification

No automated test suite — verify via `npm run build` (type-check) plus manual flow:

1. Seed/identify a zero-movement item with a prior finalized count; confirm it shows
   `noMovement` and the "Same as last" button.
2. Confirm a moved item and a never-counted item are **not** eligible.
3. Per-line "Same as last" → line shows counted, variance 0, `carriedForward` badge.
4. Filter → select-all → "Confirm all unchanged" → dialog shows correct N and $X →
   commit → all lines counted + flagged.
5. Offline: trigger bulk, go offline mid-commit, reconnect → queue flushes, counts
   persist with `carriedForward`.
6. Finalize → valuation total includes carried lines; history/variance report badges
   them as carried.

## Affected code (anticipated)

- `prisma/schema.prisma` — `CountLine.carriedForward`.
- `src/lib/count-expected.ts` — emit per-item movement-presence used to derive
  `noMovement`.
- `src/app/api/count/sessions/[id]/route.ts` (GET) — return `noMovement` per line.
- `src/app/api/count/sessions/[id]/lines/[lineId]/route.ts` (PATCH) — accept and
  persist `carriedForward`.
- `src/app/count/page.tsx` — `noMovement` on `Line` type; filter; per-line button;
  multi-select + bulk action + summary dialog; offline queue payload; carried badge.
- Count history + variance report views — render the carried-forward badge.
