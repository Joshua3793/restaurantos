# RC-Partitioned Theoretical Stock — Design

**Date:** 2026-06-15
**Status:** Approved (design), pending implementation plan

## Problem

Theoretical stock value is not consistently partitioned by revenue center (RC). Each RC
should compute its own theoretical value from only its own baseline and its own movements,
and the **"All Revenue Centers"** view should be the **exact sum** of the individual RCs.
Today it isn't, due to two concrete bugs and one structural gap:

1. **Cross-RC purchase double-count.** `buildPurchaseMap` (the per-RC branch) does not filter
   `splitToSessionId: null`. When an invoice line is reassigned from one RC to another, the
   move-not-copy split leaves the parent line under the original RC (`splitToSessionId` set)
   and the canonical copy under the new RC's clone session. The per-RC purchase map counts
   **both**, so the same physical purchase is added to two RCs. Proven: *Albacore tuna* — one
   20-unit buy — counts as **$3,700 in both Cafe and Catering**.

2. **"All RCs" omits all purchases.** The `rcId = null` ("global") branch of `buildPurchaseMap`
   reads the **legacy `InvoiceLineItem` table**, which is empty (all real purchases live in the
   session model, `InvoiceScanItem`). So the All view shows **$0 purchases** and collapses to
   roughly "last count + a little prep." Measured: All = $20,577 while Cafe alone = $32,943.

3. **Shared (null-RC) movements.** Prep is logged with `revenueCenterId = null` ("Shared"), so it
   is invisible to every per-RC view and only appears in the global scope. Under a per-RC model,
   a movement with no RC belongs to no one and breaks "All = Σ RC."

### Measured current state (2026-06-15)

| View | Value | Makeup |
|---|---|---|
| Cafe (default) | $32,943.32 | baseline $20,508 (stockOnHand) + Cafe purchases $12,435 — **overstated** by reassigned lines (≥$3,700) |
| Catering (non-default) | $4,280.85 | allocation baseline $305 + Catering purchases $3,976 |
| All RCs | $20,577.51 | baseline $20,508 + purchases **$0** + prep net −$6 — **understated** (missing every purchase) |

`Cafe + Catering ≠ All` today. The goal is to make it equal by construction.

## Goal

Every variable in the theoretical-value calculation is attributed to exactly one RC and computed
per RC; the All view is the literal sum of the per-RC values.

```
theoretical_rc(item)  = max(0, baseStock_rc + purchases_rc + prepOut_rc
                                 − consumption_rc − wastage_rc − prepCons_rc)
theoretical_ALL(item) = Σ_overEveryRC  theoretical_rc(item)
value                 = Σ_item theoretical(item) × pricePerBaseUnit
```

## Decisions (locked with the user)

- **Approach A — per-RC attribution + ALL as a literal per-RC sum.** ALL is computed by looping
  every RC and summing per item, so `ALL = Σ RC` is true by construction and cannot drift.
  (Rejected: B "aggregate ALL query" reintroduces drift; C "materialized ledger" abandons the
  compute-on-read model.)
- **Every movement carries an RC.** `PrepLog`, `SalesEntry`, `WastageLog` get a required
  `revenueCenterId`. Purchases are already RC-scoped via `InvoiceSession.revenueCenterId`.
- **Backfill null → default RC (Cafe).** Existing null-RC rows are assigned to the default RC.
- **Definitions stay shareable.** `PrepItem.revenueCenterId` and recipes remain nullable —
  cost is RC-independent (one price spine); only the physical *log* (the movement) is RC-tagged.
- **Clamp semantics:** `ALL = Σ max(0, per-RC)`, not `max(0, Σ)`. Each RC floors independently.
- **Movements can only be recorded against a concrete RC**, never the read-only "All" view.

## Architecture

### 1. Data model

`prisma/schema.prisma`:
- `PrepLog.revenueCenterId`: `String?` → `String` (NOT NULL).
- `SalesEntry.revenueCenterId`: `String?` → `String` (NOT NULL).
- `WastageLog.revenueCenterId`: `String?` → `String` (NOT NULL).
- No change: `StockAllocation.revenueCenterId` (already NOT NULL), `PrepItem.revenueCenterId`
  (stays nullable — shareable definition), `InvoiceSession`/`InvoiceScanItem` (purchases scoped
  via session).

**Baseline partitioning (already correct, no change):** default RC baseline = `InventoryItem.stockOnHand`;
non-default RC baseline = its `StockAllocation.quantity` (0 if never allocated). Pulls/transfers
decrement `stockOnHand` when they create an allocation, so `stockOnHand + Σ allocations = total`
with no overlap. Purchases do not write `stockOnHand` (compute-on-read), so a Catering-tagged
purchase lands only in Catering's purchase map — no baseline double-count once bug #1 is fixed.

### 2. Engine — `src/lib/count-expected.ts`

- `buildPurchaseMap` per-RC branch: add `splitToSessionId: null` to the `invoiceScanItem` where
  clause. (Fixes bug #1.)
- `buildPurchaseMap` null branch: **remove** the legacy `InvoiceLineItem` path. Build maps are
  only ever called with a concrete `rcId`. (Removes the dead path behind bug #2.)
- `getTheoreticalStockMap(concreteRcId, itemIds?)`: unchanged for a concrete RC.
- **`getTheoreticalStockMap(null, itemIds?)` is redefined to mean "sum of all RCs"** (it no longer
  reads the legacy global path). It delegates to a new internal sum:
  ```
  rcs   = prisma.revenueCenter.findMany()
  perRc = await Promise.all(rcs.map(rc => getTheoreticalStockMap(rc.id, itemIds)))
  result[item] = Σ perRc[i][item]
  ```
  Each per-RC map is independently clamped; the sum is the All value. Keeping the same
  `(null) → all` signature means existing null-callers automatically get `ALL = Σ RC` with no
  call-site churn — only their *meaning* sharpens from "global pool" to "sum of RCs".

### 3. Call sites

Because `getTheoreticalStockMap(null)` is redefined to sum the RCs, callers that already pass
`null` for the all view inherit the fix with **no code change** — their meaning sharpens from
"global pool" to "sum of RCs". The audit is to (a) confirm each null-caller now reads correctly and
(b) find any caller that does its own bespoke all-handling (e.g. cost-chrome's manual
`globalValue + allocations`) and replace it with the single summed map:
- `src/app/api/insights/cost-chrome/route.ts` — banner "All" (drop the manual
  `globalValue + non-default allocations` composition; use the summed map).
- `src/app/api/inventory/route.ts` — "All Revenue Centers" list KPI (the `getTheoreticalStockMap(null)`
  call now returns Σ-RC, fixing its current cafe-pool-only total).
- `src/app/api/reports/*`, `src/app/api/digest/route.ts`, dashboard — confirm any "all" usage.
- Per-item / quick-count paths always run against a concrete RC — unchanged.

### 4. Write-path / UI enforcement

Rule: **a movement can only be recorded against a concrete RC; "All" is read-only.**
- Prep (`/api/prep/logs` POST, `/api/prep/generate`): log RC = prep item's RC if set, else the
  active RC context; block when context is "All" with a "select a revenue center" prompt.
- Wastage (`/wastage`): require active RC; block from "All".
- Sales (`/sales`): require an RC per entry.
- Each form shows the RC it writes to.

### 5. Migration sequence (order is load-bearing)

1. Backfill script (idempotent): `revenueCenterId = <default RC>` where null on `PrepLog`,
   `SalesEntry`, `WastageLog`.
2. Schema migration: those three columns → `NOT NULL`, via the diff / `db execute` /
   `migrate resolve` workaround (the `prisma migrate dev` shadow DB is known-broken in this repo).
3. Deploy engine + ALL-sum + UI.

**Phasing.** Phase 1 = backfill + engine + ALL-sum (ships together so null-RC prep is not dropped
from ALL the moment ALL becomes Σ-RC) — the accuracy win. Phase 2 = `NOT NULL` constraint + UI
enforcement — prevents new nulls.

## Verification

- Decomposition assertion: `theoretical(Cafe) + theoretical(Catering) == theoretical(ALL)`
  exactly, per item and in total; Albacore counts once (Catering); ALL includes purchases.
- Cross-surface: cost-chrome banner ALL == inventory "All RCs" KPI == Cafe + Catering.
- `npm run build` clean.
- Report corrected Cafe (current $32,943 minus reassigned-line over-count) and corrected ALL
  (baseline + all RC purchases).

## Expected consequences (not regressions)

- **Cafe value drops** once the `splitToSessionId` fix lands — it stops counting lines reassigned
  away (e.g. −$3,700 Albacore).
- **All value rises substantially** — it starts including the RC-tagged purchases it currently
  ignores.

## Out of scope

- Migrating default-RC stock from `stockOnHand` into an explicit allocation row (not needed; the
  baseline already partitions cleanly).
- Recipe/prep-item cost RC-dependence (cost is RC-independent by design — one price spine).
- Per-RC performance optimization of the All view (N× query cost is negligible at current RC count;
  batch later if RCs grow).
