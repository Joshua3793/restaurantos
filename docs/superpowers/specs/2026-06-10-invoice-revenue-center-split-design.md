# Invoice Revenue-Center Split + RC-Aware Purchase Movement — Design

**Date:** 2026-06-10
**Status:** Approved, pending implementation plan

## Problem

Invoices can be assigned a revenue center (RC) at the session level and per
line item, and on approval the system clones a child "(copy)" session per
alternative RC. But the clone **copies** the moved lines without removing them
from the parent, and all spend reporting keys off `session.revenueCenterId`
over every approved scan item. The result:

- **Double-count** — a line assigned to a different RC is counted both in the
  parent (under the parent's RC) and in the clone (under its own RC). Global
  spend is inflated.
- **Misattribution** — the parent RC is charged for lines that belong to other
  RCs.

This corrupts per-RC and global spend KPIs (`rawLineTotal` sums). It does **not**
affect the pricing spine: `pricePerBaseUnit` is written once in the approve loop
and the clone block never re-writes prices.

Two other gaps make the feature unusable in practice:
- Per-line RC is silently ignored unless a session RC was set at upload (the
  clone block is skipped when `session.revenueCenterId` is null).
- There is no way to set the invoice-level RC from the review drawer — only at
  upload, sourced from the sidebar's active RC filter.

## Goal

One invoice, lines split across revenue centers, each line's purchase cost
attributed to exactly one RC:

- Invoice A is assigned to **Cafe** (default). Lines 1–2 are assigned to
  **Catering**, lines 3–5 stay on Cafe.
- COGS / cost reports attribute lines 3–5 to Cafe and lines 1–2 to Catering.
- The **"All revenues"** view (no RC filter) shows the full invoice spend, each
  line counted **once**.
- Per-line RC also makes the **purchase movement history** RC-aware (which RC a
  purchase went to). Live on-hand quantities are NOT changed.

## Decisions (from brainstorming)

- **Movement scope:** record/history only. Reporting splits spend by RC and the
  purchase-movement view becomes RC-aware. Invoice approval does **not** change
  `stockOnHand` / `StockAllocation` quantities (stock stays count-driven).
- **Split model:** keep the clone-per-RC session approach, but fix it to
  **move, not copy** — reporting stays keyed off session-level RC.
- **Parent lines:** keep all lines on the parent for fidelity (matches the
  scanned image); flag the moved ones and exclude them from spend.

## Non-goals

- Changing live on-hand quantities (`stockOnHand`, `StockAllocation`) on invoice
  approval.
- Adding `revenueCenterId` to `Invoice` / `InvoiceLineItem` (the final
  supplier-level records stay RC-agnostic; the split lives at the session /
  scan-item layer).
- Retroactively assigning an RC to historical null-RC invoices.
- A formal stock-movement ledger table (movements remain reconstructed).

## Design

### 1. Data model — one new field

`prisma/schema.prisma`, `InvoiceScanItem`:

```prisma
splitToSessionId String?   // set on a PARENT line moved into an RC clone; null = live/countable
@@index([splitToSessionId])
```

- `null` → the line is live and counts toward its session's RC.
- non-null → the line has been reallocated into the clone session with that id;
  excluded from all spend aggregation (the clone's copy is the canonical home).

No `Invoice` / `InvoiceLineItem` changes.

**Migration:** `prisma migrate dev` is broken in this project (P3006 shadow
drift — see memory `project_prisma_migrate_shadow_broken`). Add the column via
the `prisma migrate diff` → `db execute` → `migrate resolve` workaround.

### 2. Invoice-level RC, decoupled from the sidebar

- **Sidebar `activeRcId` is view-only.** `InvoiceUploadModal` stops sending it
  as the session RC (`src/components/invoices/InvoiceUploadModal.tsx`).
- **Default the session RC to the main RC.** On session creation
  (`src/app/api/invoices/sessions/route.ts`), if no `revenueCenterId` is
  provided, set it to the `RevenueCenter` where `isDefault = true`. Every
  invoice therefore always has an RC.
- **Invoice-level RC selector in the drawer header.** Add a selector in
  `InvoiceReviewDrawer.tsx` bound to the existing
  `PATCH /api/invoices/sessions/[id] { revenueCenterId }` path, defaulting to
  the session's current RC. Closes the "can't set session RC in the drawer" gap.
- **Per-line RC default inherits the invoice RC.** In `card.tsx`, the per-line
  dropdown's effective default becomes the session RC (not a hardcoded default),
  so unset lines follow the whole-invoice selection.

### 3. Approve — clone, move-not-copy

`src/app/api/invoices/sessions/[id]/approve/route.ts` (clone block ~319–366):

- Group items by effective RC (`item.revenueCenterId ?? sessionRcId`), as today.
- For each RC ≠ `sessionRcId`:
  - Create the clone session (unchanged) with `createMany` copies of those lines
    (copies have `splitToSessionId = null` — canonical home).
  - **Additionally**, set `splitToSessionId = clone.id` on the matching **parent**
    scan items (the lines that were copied out).
- The price-write loop is unchanged: it runs once over the parent's lines, and
  price is RC-agnostic, so the spine stays correct. Clone copies never re-write
  prices.

### 4. Reporting — exclude flagged parent lines

Add `splitToSessionId: null` to every approved-scan-item spend aggregation, so
each line is counted exactly once (live parent lines under their session RC;
clone copies under the clone's RC):

- `src/app/api/insights/cost-chrome/route.ts` (3 `aggregate` calls)
- `src/app/api/insights/revenue-centers/route.ts`
- `src/app/api/reports/cogs/route.ts`
- `src/app/api/reports/dashboard/route.ts`
- `src/app/api/reports/analytics/route.ts`
- `src/app/api/invoices/kpis/route.ts` (verify; add if it sums line totals)
- `src/app/api/invoices/exceptions/route.ts` (verify; add if it sums line totals)
- `src/app/api/chat/route.ts` (purchase filter)

**"All revenues"** = no `rcId` filter → sum of all non-split approved lines
across all sessions = the full invoice total, once.

### 5. Purchase movement, RC-aware (no quantity change)

`src/app/api/inventory/[id]/stock-movements/route.ts`, the PURCHASE source:

- Exclude `splitToSessionId != null` parent dupes.
- Attribute each PURCHASE movement's RC via its session's `revenueCenterId`
  (surface the RC on the movement row; allow filtering the view by RC).
- `stockOnHand` / `StockAllocation` quantities are untouched.

### 6. Migration / backfill of existing "(copy)" clones

Existing clones were created copy-not-move, so parents still hold live
duplicates. One-time reviewable script (`scripts/`):

- For each clone session (`parentSessionId != null`), set
  `splitToSessionId = <clone.id>` on the parent's scan items whose
  `revenueCenterId` matches the clone's `revenueCenterId`.
- Removes historical double-counting without deleting any rows.
- Historical null-RC invoices are left as-is.

Run as a script, not silently inside the schema migration.

## Data flow (worked example)

```
Invoice A, session RC = Cafe (default). Lines: 1,2 → Catering; 3,4,5 → (inherit Cafe)
Approve:
  • price loop writes pricePerBaseUnit once for each matched line (RC-agnostic)
  • clone block:
      - clone session C (RC = Catering, parentSessionId = A) gets copies of 1,2 (splitToSessionId null)
      - parent lines 1,2 get splitToSessionId = C.id
Reporting (splitToSessionId IS NULL, group by session RC):
  • Cafe     = parent lines 3,4,5
  • Catering = clone lines 1,2
  • All revenues (no rcId) = lines 1,2,3,4,5 — each once
Movement history for an item on line 1: PURCHASE attributed to Catering; parent dupe excluded.
```

## Testing

- `npm run build` (type-check; only automated check).
- Manual end-to-end:
  1. Upload an invoice while the sidebar is filtered to a non-default RC →
     confirm the session defaults to the **main** RC, not the sidebar's.
  2. In the drawer, set the invoice RC to Cafe; assign lines 1,2 to Catering.
  3. Approve → parent shows all 5 lines with 1,2 flagged "moved to Catering";
     clone holds 1,2.
  4. Confirm cost-chrome / COGS per-RC numbers split correctly and the
     unfiltered "All revenues" total equals the invoice total (no double-count).
  5. Open the item on line 1 → its purchase movement is attributed to Catering.
- Backfill: run the script against existing "(copy)" clones; confirm global
  spend totals drop by the previously double-counted amount.
