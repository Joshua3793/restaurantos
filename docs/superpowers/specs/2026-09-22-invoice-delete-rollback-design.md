# Deleting an approved invoice rolls back everything its approval wrote — design

**Date:** 2026-09-22
**Status:** design, not implemented
**Builds on:** `2026-09-20-item-consolidation-design.md` (offers, frozen receipts), `2026-09-21-weight-priced-count-items-design.md` (`revert-pricing.ts`, which this replaces for new sessions).

## The problem

Approving an invoice writes, per line: the supplier offer (`InventorySupplierPrice` — price, pack, SKU, its own chain/pricing, `lastInvoiceSessionId`), sometimes the primary flag (`ensurePrimary`), the item spine when the line's supplier is primary (`packChain`/`pricing`/`purchasePrice`/`densityGPerMl`), a `PriceAlert`, the frozen receipt, a mirror of the spine back onto the primary offer, RC membership rows, a learned `InvoiceMatchRule`, a prep re-cost with `RecipeAlert`s, and — for a new product — the `InventoryItem` itself.

Deleting that session today (`DELETE /api/invoices/sessions/[id]` and the bulk route) reverts **one** of those: the item's price, only for `UPDATE_PRICE` lines (`ADD_SUPPLIER` lines are silently skipped), from `InvoiceScanItem.previousPrice` — a bare number whose denomination `revert-pricing.ts` has to guess. Offers are never touched, so the next primary sync re-adopts the deleted price; learned rules keep matching to a product that may have been wrong; an item created by the invoice stays; RC-split clones are orphaned (`parentSessionId` → `SET NULL`) and keep counting in spend; and none of it is in a transaction, so a mid-loop failure leaves some items reverted and the session gone.

Nothing stores the prior state, so exact rollback needs a record written at approve time.

## Decisions (user, 2026-09-22)

1. **Roll back everything approve wrote** — offers, item spine, primary flag, learned match rules, created items, alerts, receipts/stock — as if the invoice had never been approved.
2. **Only the newest writer can roll back.** A value a later invoice (or a manual edit) has since changed stays as it is; the rest of the deletion still happens. No replay of history, no refusing to delete.
3. **Mechanism:** undo records captured at approve time, `{ prev, next }` per touched row; restore `prev` only when the row still equals `next`. Sessions approved before this ships have no records and keep a best-effort revert, labelled as such.

## 1. Capture and restore

### The table

```prisma
model InvoiceApproveUndo {
  id        String   @id @default(cuid())
  sessionId String
  session   InvoiceSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  kind      String   // 'OFFER' | 'ITEM' | 'MATCH_RULE' | 'ITEM_CREATED'
  targetId  String
  prev      Json?    // null = the row did not exist before this approval
  next      Json     // the state approve left behind — the "unchanged since" witness
  createdAt DateTime @default(now())
  @@unique([sessionId, kind, targetId])
  @@index([kind, targetId])
}
```

One additive migration. No backfill is possible (the prior state is gone).

### State selectors — the load-bearing piece

`src/lib/invoice/approve-undo.ts` (pure): `offerState(row)`, `itemState(row)`, `ruleState(row)` reduce a Prisma row to a canonical plain object — Decimals → numbers, `undefined` → `null`, keys sorted, only the columns approve can write:

| kind | fields in `prev`/`next` |
|---|---|
| `OFFER` | `lastPrice, packQty, packSize, packUOM, packChain, pricing, supplierId, supplierItemCode, isPrimary, lastInvoiceSessionId` |
| `ITEM` | `packChain, pricing, purchasePrice, densityGPerMl` |
| `MATCH_RULE` | `rawDescription, supplierName, inventoryItemId, invoicePackQty, invoicePackSize, invoicePackUOM, supplierItemCode` (not `useCount`/`lastUsed` — usage counters are not state approve "wrote") |
| `ITEM_CREATED` | `next` = `itemState` of the new row; `prev = null` |

`next` is produced by the selector at approve time; the delete-time comparison reads the row again through the *same* selector, so "deep-equals `next`" compares like with like and cannot be fooled by key order, Decimal-vs-string or a column approve never touches.

### Capture in approve

A per-run `UndoCollector` (`src/lib/invoice/approve-undo.ts`):

- `touch(kind, targetId, readPrev)` records `prev` the **first** time a target is seen in the run, before the first write. Every write site goes through it: the offer upsert, `ensurePrimary` (the promoted offer's `prev` has `isPrimary: false`), the spine write, `mirrorItemToPrimaryOffer` (the same offer as the upsert — first touch wins, so `prev` is the state before *either* write), `saveMatchRule`, and `CREATE_NEW` (`prev = null`).
- At the end of the item's existing per-item transaction, `flush(tx)` re-reads every touched target through the selectors and `createMany`s the records with `prev` + `next` **inside that transaction** — a record can never exist without its writes, nor the writes without their record. `saveMatchRule` and `CREATE_NEW` flush inside their own writes' transaction the same way.
- Approve deletes the session's existing undo rows at the start of a run, next to where it already deletes old RC clones (a re-approval is only reachable through a forced status reset, but the records must not accumulate if it happens).

`InvoiceApproveUndo` rows are the **only** provenance the rollback reads. `InvoiceScanItem.previousPrice` keeps being written (the review UI shows it) but the rollback of a recorded session never looks at it.

### Restore rule — one rule for every kind

For each record, read the target through its selector:

- current **deep-equals `next`** → write `prev` (or **delete** the row when `prev` is null) → `outcome: 'restored' | 'deleted'`;
- otherwise → leave it → `outcome: 'skipped', reason: 'changed-since'` (a later invoice, a manual edit, a "make primary" click — the record does not say which, and does not need to);
- target no longer exists → `skipped, reason: 'gone'`.

That single rule *is* decision 2: the session can only ever un-write a value it wrote and nobody has touched since.

Kind-specific details:

- **`OFFER` / primary flag.** Records are applied in an order that respects the partial unique index `(inventoryItemId) WHERE isPrimary`: for each item, first every record whose `prev.isPrimary` is false (clearing a promoted row), then those whose `prev.isPrimary` is true. `ensurePrimary` only promotes when no primary exists, so a rollback never has to demote a row that another session made primary — if it did, that row's current state would not equal `next` and it would be skipped.
- **`ITEM`.** After all spines are restored, the same prep re-cost approve runs (`propagatePrepCostChanges` + `recalculateRecipeCosts`) runs for every restored item so PREP-linked items follow. This runs after the transaction commits, exactly as approve does.
- **`MATCH_RULE`.** Restored or deleted like any row. The learned alias is what makes the next scan of that description match the same product, so un-learning a wrongly-approved match is the point.
- **`ITEM_CREATED`.** Deleted only when nothing else references the item: no approved scan line outside this session, no `RecipeIngredient`, no `CountLine`, no `InventorySupplierPrice` other than ones this session created (those are `OFFER` records with `prev = null` and are deleted first). Otherwise `skipped, reason: 'referenced'` and the item stays. Records are applied in the order `OFFER`, `ITEM`, `MATCH_RULE`, `ITEM_CREATED`.

## 2. The delete flow

`DELETE /api/invoices/sessions/[id]`; the bulk `DELETE /api/invoices/sessions` loops the same routine one session at a time (each in its own transaction, results concatenated). One interactive `prisma.$transaction` per session:

1. **Refuse a clone.** `parentSessionId` set → `409 { error: 'This is an RC copy — delete the original invoice instead' }`. Clones are the same money split by revenue centre; only the original owns undo records.
2. **Load** the session's undo records. An `APPROVED` session with none is `legacy: true`.
3. **Restore** per the section-1 rule, collecting `{ kind, targetId, name, outcome, reason? }`.
4. **Legacy path** (no records): today's `revertedPricing` over `previousPrice`, now for `UPDATE_PRICE` **and** `ADD_SUPPLIER` lines, and only when the item's current `pricePerBaseUnit` still equals the line's `newPrice`-implied value (± 0.5 %) — `outcome: 'best-effort'`; offers, rules and created items are `skipped, reason: 'approved before undo records existed'`.
5. **Delete the clones** explicitly (`InvoiceSession where parentSessionId = id`), then the session. Cascades remove scan items (stock un-receives by construction — it is computed from approved lines), `PriceAlert`, `RecipeAlert`, `InvoiceFile` rows and the undo records.
6. **After commit:** prep re-cost for every restored `ITEM`, then blob-file deletion (as today).

Any failure before step 5 rolls the whole session back — no more half-reverted items with the session gone. Response: `{ legacy, restored, deleted, skipped: [...], recosted }`. Role gate unchanged: MANAGER whenever the session has approved lines; the bulk route is always MANAGER.

### Preview before the confirm

`GET /api/invoices/sessions/[id]/delete-plan` runs steps 1–4 with `apply: false` — the same planner, nothing written — and returns the same shape. `InvoiceListV2`'s confirm dialog for an `APPROVED` session replaces *"This will remove the approved invoice and reverse its price updates"* with the plan:

> Restores 3 supplier prices and 1 item price · removes 1 new product · 2 prices stay (changed since) · 4 learned matches removed

and, for a legacy session:

> Approved before rollback records existed — price reverts are best-effort; supplier prices and learned matches are not restored.

Bulk delete shows per-session totals. A clone's Delete action is disabled with the 409 message as its tooltip.

## 3. Library shape and tests

- `src/lib/invoice/approve-undo.ts` — selectors, `UndoCollector`, kinds. Pure except `flush(tx)`.
- `src/lib/invoice/rollback.ts` — `planRollback({ records, current, refs, legacyLines }) → RollbackPlan` (pure: deep-equal, ordering, reference check from counts the caller supplies, legacy labelling) and `executeRollback(tx, plan)`.
- Both DELETE routes and the `delete-plan` GET call `planRollback`; only the routes call `executeRollback`.

Tests (pure, `npm test`): selectors normalise Decimal / `undefined` / key order and ignore untouched columns; planner — unchanged → restore, changed-since → skip with reason, `prev = null` → delete, gone → skip, created item referenced → keep, primary ordering (clear before set), record ordering by kind, legacy → best-effort labels and the `ADD_SUPPLIER` inclusion; collector — first-touch-wins for a target written twice in one run; a real Cilantro shape: `PACK $4.99` → approve → `RATE 15.98/lb` → delete restores `PACK $4.99` exactly, no denomination guessing. Plus `tsc --noEmit`, eslint, isolated `npm run build`.

## 4. Rollout and proof

- Migration is additive; apply via the diff/db-execute path (the shadow DB is broken).
- **Read-only sizing before merge:** count `APPROVED` sessions (all legacy), RC clones (now refusing delete), and sessions with `ADD_SUPPLIER` lines (which today's revert silently skips and which the legacy path now covers). No data changes.
- **After deploy, one real cycle** on a small invoice chosen with the user: approve → `delete-plan` lists the records → delete → the offer, item and rule read back equal to their pre-approve state; the RC clone is gone with its parent.
- Deploy is the only rollout step.

## Out of scope

An "unapprove" action that keeps the session; replaying history to rebuild a price; a general audit log; removing RC membership rows (`ItemRevenueCenter` / `StockAllocation` — visibility, not price or stock; harmless to leave); rolling back sessions approved before this ships beyond the labelled best-effort path.
