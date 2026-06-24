# Item ↔ Revenue-Center membership ("shared items")

**Date:** 2026-06-24
**Status:** Approved design — ready for implementation plan

## Problem

Counts are not item-scoped by revenue center (RC). Count creation selects items
globally (`InventoryItem where isActive && isStocked`, optional storage-area filter)
with **no RC filter**, so every RC's count lists every stocked item. If CAFE and
CATERING use flour but Bar does not, Bar's count still shows flour (expected 0). The
only item↔RC signal today is a `StockAllocation` row, which sets the per-RC baseline
but does **not** gate whether an item appears in a count.

We want explicit, user-managed membership: mark items as "present in N RCs" (in the
item drawer and via an inventory bulk action), and have counts show only the items
assigned to that RC. An item's total on-hand is the sum of its per-RC amounts.

## Decisions (confirmed)

1. **Membership store:** a dedicated `ItemRevenueCenter` join table, separate from
   stock. The default RC participates like any other RC.
2. **Symmetric scoping:** every RC — including the default — is scoped to its members.
3. **"All RCs" + start count:** counting requires a specific RC; if "All" is the active
   selection, the user is prompted to pick one (you cannot count "all" into one place).
4. **Removal guard:** removing an item from an RC that still has stock there
   (non-default `StockAllocation.quantity > 0`, or default `stockOnHand > 0`) is
   **blocked** with "zero out stock in <RC> first". An item must keep ≥ 1 RC.
5. **New-item creation:** a new item joins **only** the RC chosen at creation (the
   Add-Item modal's existing gold RC picker; falls back to the default RC if none is
   chosen). It is **not** auto-added to the default.

## Data model

New Prisma model:

```prisma
model ItemRevenueCenter {
  id              String        @id @default(cuid())
  inventoryItemId String
  revenueCenterId String
  createdAt       DateTime      @default(now())
  inventoryItem   InventoryItem @relation(fields: [inventoryItemId], references: [id], onDelete: Cascade)
  revenueCenter   RevenueCenter @relation(fields: [revenueCenterId], references: [id], onDelete: Cascade)

  @@unique([inventoryItemId, revenueCenterId])
  @@index([revenueCenterId])
}
```

Back-relations added to `InventoryItem` (`revenueCenters ItemRevenueCenter[]`) and
`RevenueCenter` (`itemMemberships ItemRevenueCenter[]`).

**Stock is unchanged.** Membership is pure visibility/scope:
- Default RC amount = `InventoryItem.stockOnHand`.
- Non-default RC amount = `StockAllocation.quantity`.
- Item total on-hand = `stockOnHand` (if default is a member) + Σ `StockAllocation`
  over non-default members — the same ΣRC math used by theoretical stock / COGS.

## Migration + backfill

`prisma migrate dev` is broken in this environment (P3006 shadow drift; the direct DB
host is unreachable). Use the established workaround: hand-author the migration SQL and
apply it over the pgBouncer pooler with `$executeRawUnsafe` (see
`project_prisma_migrate_shadow_broken` / `project_item_model_redesign`).

Backfill (idempotent), so behavior is unchanged on day one:
1. For every `InventoryItem` (active), insert membership in the **default RC**.
2. For every existing `StockAllocation (revenueCenterId, inventoryItemId)`, insert a
   membership for that pair.

After backfill, every item is in the default RC (so "CAFE counts everything" still
holds) plus any non-default RC it was already allocated to.

## Count scoping (the behavior change)

Count creation (`POST /api/count/sessions`) adds a membership filter to the item query:

```ts
where: {
  isActive: true,
  isStocked: true,
  ...(areaIds.length ? { storageAreaId: { in: areaIds } } : {}),
  ...(revenueCenterId ? { revenueCenters: { some: { revenueCenterId } } } : {}),
}
```

- A count scoped to an RC lists only that RC's members.
- Legacy/unscoped path (`revenueCenterId` null) is retained as "all items" for back-compat.
- Baseline / expected-quantity logic is **unchanged** (default = `stockOnHand`;
  non-default = `StockAllocation`, 0 if none). Membership only changes *which* items
  appear, not their expected value.
- Count page: when the active selection is "All RCs" (`activeRcId` null), starting a
  count prompts the user to pick a specific RC first.

## UI — item drawer

A new "Revenue Centers" section in the inventory item drawer:
- Shows the RCs the item belongs to as chips.
- A multi-select (all active RCs) to add/remove membership.
- Add → insert membership. Remove → delete membership, subject to the removal guard
  (block if that RC has stock for the item; block removing the last RC).
- Sits next to the existing gold per-RC allocation panel (allocation = quantity;
  membership = presence — related but distinct).

## UI — inventory bulk action

On the inventory list page:
- Checkbox multi-select of items, surfacing an action bar.
- Actions: **"Assign to RCs"** and **"Remove from RCs"** → choose one or more RCs →
  batch insert/delete memberships. Remove honors the same per-item stock guard
  (items that can't be removed are reported, not silently skipped).

## New-item creation

The Add-Item modal already has a gold RC picker (chooses the RC that receives initial
stock). On create, also insert an `ItemRevenueCenter` row for that chosen RC (default
RC if none chosen). v1 keeps creation single-RC; broaden via the drawer afterward.

## APIs

- `GET    /api/inventory/[id]/revenue-centers` — list an item's RC memberships.
- `POST   /api/inventory/[id]/revenue-centers` — `{ revenueCenterId }` add one.
- `DELETE /api/inventory/[id]/revenue-centers/[rcId]` — remove one (guarded).
- `POST   /api/inventory/revenue-centers/bulk` — `{ itemIds: string[], rcIds: string[],
  action: 'add' | 'remove' }`; returns `{ added, removed, blocked: [{itemId, rcId, reason}] }`.
- `POST /api/count/sessions` — add the membership filter (above).
- Add-item create path — insert membership for the chosen RC.

All routes `requireSession` per existing inventory conventions and `export const
dynamic = 'force-dynamic'`.

## Guards & edge cases

- **Removal with stock:** block when the target RC has non-zero stock for the item
  (default → `stockOnHand > 0`; non-default → `StockAllocation.quantity > 0`). Message:
  "Zero out stock in <RC> first."
- **Last membership:** block deleting an item's final RC (every item belongs to ≥ 1 RC).
- **Idempotent add:** adding an existing membership is a no-op (unique constraint).
- **All-RCs count:** require a concrete RC before a count can start.

## Out of scope (YAGNI)

- Per-RC par levels via membership (`StockAllocation.parLevel` already exists).
- Auto-membership inferred from recipe/sales usage.
- Moving the default RC's stock out of `stockOnHand` into allocations (the
  default-as-global-pool model is retained; membership rides on top of it).

## Affected files (anticipated)

- `prisma/schema.prisma` — new model + back-relations.
- migration SQL + backfill script (`scripts/`), applied via pooler.
- `src/app/api/count/sessions/route.ts` — membership filter.
- `src/app/api/inventory/[id]/revenue-centers/` + `revenue-centers/bulk/` — new routes.
- Item drawer component + inventory list page (bulk select/action bar).
- Add-Item modal create path.
