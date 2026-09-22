# Deleting an approved invoice rolls back everything its approval wrote — design

**Date:** 2026-09-22
**Status:** implemented
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

## As built

Implemented across five tasks (`24babff`..`9a935af` on `feat/invoice-delete-rollback`). The design above holds; the deviations below were forced by the generated Prisma client, the schema's actual cascade/restrict/set-null shape, or defects a review caught before merge.

### Capture (§1)

- **Records are written after the line's writes, not inside a per-line transaction.** Approve's per-line writes (the offer upsert, `ensurePrimary`, the spine's `$transaction(itemOps)`, `mirrorItemToPrimaryOffer`) are not themselves wrapped in one transaction today, so `flush()` runs immediately after the last write of each line rather than "inside that transaction" as §1 describes. A failed `flush()` is caught and logged, never thrown — the alternative would abort approval itself over a table update, for a table that didn't even exist on any deployed database until this ships.
- **The offer-read guard.** The pre-upsert `findUnique` that seeds a capture can itself fail; treating a failed read as "no prior offer existed" would record a fabricated `prev: null` and let a later rollback DELETE a pre-existing supplier offer it never should have touched. `offerCaptureFor(readOk, existing, upserted)` (`src/lib/invoice/approve-undo.ts`) returns "record nothing" whenever the read failed, regardless of what the upsert went on to do.
- **`next` is refreshed on every flush, not just the first.** Two scan lines in one invoice touching the same offer or item used to leave a stale `next` — the first line's flush marked the entry flushed permanently, so the second line's write was never reflected, and a later rollback would wrongly see `changed-since`. `UndoCollector.flush()` now re-reads every touched target — flushed or not — on every call, and issues an update against `next` for an already-flushed record whose row has moved again (never touching `prev`).
- **`Prisma.DbNull`, not `Prisma.JsonNull`, for a null `prev`/restore value.** `JsonNull` stores the JSON scalar `null` inside a non-null column — a value present in the row — which both `record.prev === null` reads and a restore's null write would get wrong. `DbNull` is the true SQL NULL and is what both the collector's writes and the planner's restores use for every nullable Json field (`packChain`, `pricing`).

### Restore & the delete flow (§1–§2)

- **The legacy "still equals the newPrice-implied value" guard is not implementable.** §2 step 4 described gating the best-effort revert on the item's current price still matching the line's `newPrice`-implied value (± 0.5%). `newPrice` is stored in the offer's own denomination (whatever unit that supplier's pack used), so comparing it to the item's current `pricePerBaseUnit` would mean redoing the exact per-line unit-conversion the OCR/matcher applied at approve time — and `PriceAlert.newPrice` only exists for moves ≥ 15%, so most lines have no independent witness at all. The legacy path is exactly today's `revertedPricing` rule, extended to `ADD_SUPPLIER` lines, with no additional guard.
- **The execute split.** `executeRestores` (offers → items → rules, plus the legacy per-line reverts) runs first inside the transaction, followed by the RC-clone deletes and the session delete, and only then `executeCreatedItemDeletes` — a created item can carry relations (`InvoiceMatchRule`, the session's own scan/price rows) that only clear once the session itself is gone. `executeRollback` runs both halves in the same order but exists for tests only; no route calls it.
- **Two guards protect the transaction from the schema's Restrict/Cascade actions**, both found by review rather than anticipated in the design. `guardCascades` keeps an `ITEM_CREATED` row `skipped: 'referenced'` when an `OFFER` or `MATCH_RULE` record on the same item was itself skipped (`changed-since`/`gone`): an offer's `InventorySupplierPrice.inventoryItemId` cascades with the item (silently losing a row the plan chose to keep), and a rule's `InvoiceMatchRule.inventoryItemId` is Restrict (the item delete would throw and abort the whole transaction). `guardPrimaryCollisions` downgrades an `OFFER` restore of `isPrimary: true` to `skipped: 'changed-since'` when a *different* offer on the same item currently holds the primary flag and isn't itself being cleared or deleted by this same plan — the "clear before set" ordering in §1 only holds among offers the plan already knows about; a third offer that took the flag after approval needed its own check.
- **The reference-check (`refs`) ended up both broader and narrower than §1's sketch.** Broader: it counts every relation on `InventoryItem` — Restrict, SetNull, *and* Cascade — not just the non-cascading ones, because an uncounted Cascade relation would let the transaction silently delete a row the plan never decided to touch. Narrower: `StockAllocation` and `ItemRevenueCenter` are excluded entirely, not merely zero-weighted — both are RC-membership/allocation rows that approve itself creates for every non-default-RC item, and counting them made every item created on a non-default revenue centre (e.g. Catering) permanently undeletable; they're meant to cascade with the item. `InvoiceScanItem.matchedItemId` is counted for **all** matching scan lines outside this session and its clones, approved or not (not only `approved: true`) — an unapproved draft's suggested match is a real `SetNull` a narrower count would miss.
- **The transaction needs explicit headroom.** `executeRestores` issues one statement per plan row, so a session with many touched rows can be 200–300 serial statements over the pgBouncer pooler — well past Prisma's defaults (2s wait / 5s timeout), which throw `P2028` on anything but a small invoice, permanently (the session row is never removed on a timeout, so every retry re-runs the same doomed transaction). `TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 }` (`src/lib/invoice/rollback-load.ts`) is passed to the `$transaction` call.
- **The delete-plan preview short-circuits for a clone.** Running the full planner against a clone's own (typically empty, or parent-owned) undo records produced a misleading `legacy: true` plan instead of the refusal the real `DELETE` throws. `GET …/delete-plan` now checks `parentSessionId` first and returns `{ isClone: true, rows: [] }` without ever calling `planRollback`.

### Legacy-session behaviour changes (relative to today, before this ships)

1. **Preps are re-costed after a best-effort revert**, same as a recorded restore — today's DELETE reverts `pricing`/`purchasePrice` and stops there; the new path runs `propagatePrepCostChanges` + `recalculateRecipeCosts` for every item the legacy revert touched.
2. **Deleting a parent now deletes its clones with it**, instead of leaving them with `parentSessionId` nulled by the schema's default `SetNull`. Today, an orphaned clone keeps its own `InvoiceScanItem` rows live and keeps counting its share of the invoice's spend forever — a silent double-count once the parent (and its own share) is gone. This closes the gap for every historical parent delete too, not just future ones — see the sizing count below.
3. **A clone can no longer be deleted on its own** — it 409s with `This is an RC copy — delete the original invoice instead`; only the parent (which now takes its clones with it) can remove one.

_Sizing: (controller fills in after the read-only run)_
