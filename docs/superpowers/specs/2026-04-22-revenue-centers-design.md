# Revenue Centers Design Spec

**Date:** 2026-04-22  
**Status:** Approved — ready for implementation planning

---

## Goal

Allow one kitchen to operate multiple independent revenue streams (e.g. Restaurant, Catering, Events) with separate cost attribution, stock allocation, purchasing history, and reporting — without splitting physical inventory.

---

## Architecture Overview

Revenue Centers (RCs) are named operational contexts. Inventory is physically shared in one pool, but each RC maintains a **virtual stock allocation** — a running balance of how much of each item is attributed to that RC. All transactional data (invoices, sales, wastage, counts) is tagged to an RC. Reports and COGS calculations become RC-dimensioned.

The active RC is a **global app-level context** — set once in the navigation, applies to every page simultaneously. There are no per-page RC selectors.

---

## Data Model

### `RevenueCenter`
```
id           String   @id @default(cuid())
name         String   // "Restaurant Kitchen", "Catering", "Events"
color        String   // from curated palette: "blue" | "amber" | "purple" | "green" | "rose" | "teal"
isDefault    Boolean  @default(false)  // one RC is the default for new installs
createdAt    DateTime @default(now())
```

One RC must always be marked `isDefault`. Deleting the default RC is blocked.

### `StockAllocation`
Virtual per-RC stock balance. Not physical movement — purely bookkeeping.
```
id               String   @id @default(cuid())
revenueCenterId  String
inventoryItemId  String
quantity         Decimal  // current allocated balance in item's baseUnit
updatedAt        DateTime @updatedAt

@@unique([revenueCenterId, inventoryItemId])
```

### `StockTransfer` (Pull audit log)
```
id               String   @id @default(cuid())
fromRcId         String   // RC losing stock
toRcId           String   // RC gaining stock
inventoryItemId  String
quantity         Decimal  // in item's baseUnit
notes            String?
createdAt        DateTime @default(now())
createdBy        String?  // future: user tracking
```

### Schema changes to existing models

| Model | New field | Notes |
|---|---|---|
| `InvoiceSession` | `revenueCenterId String?` | which RC purchased this invoice |
| `InvoiceSession` | `parentSessionId String?` | non-null = this is a clone |
| `InvoiceLineItem` | `revenueCenterId String?` | line-item RC override; if null, inherits from session |
| `SaleEntry` | `revenueCenterId String?` | which RC made this sale |
| `WastageLog` | `revenueCenterId String?` | which RC wastage belongs to |
| `CountSession` | `revenueCenterId String?` | which RC this count is for |

All nullable — existing rows belong to the default RC at query time (null = default). All API routes that filter by `rcId` must resolve null rows by treating them as belonging to the default RC. This is enforced in the query layer with a `OR revenueCenterId IS NULL` clause when the active RC is the default, or a strict equality filter otherwise.

---

## Global RC Context

A React Context (`RevenueCenterContext`) lives in the root layout, wrapping all pages. It provides:

```ts
interface RevenueCenterContext {
  revenueCenters: RevenueCenter[]   // all RCs
  activeRcId: string                // currently selected RC id
  activeRc: RevenueCenter           // full object
  setActiveRcId: (id: string) => void
}
```

Active RC id is persisted to `localStorage` (`activeRcId` key) so it survives page refreshes. On first load, defaults to the `isDefault` RC.

An API route `GET /api/revenue-centers` returns all RCs (lightweight — no joins needed).

---

## Navigation — RC Selector

### Desktop Sidebar

RC selector sits between the logo block and nav links in the existing `bg-gray-900` sidebar:

```
┌─────────────────────┐
│ CONTROLA OS     🔔  │
│ Fergie's Kitchen    │
├─────────────────────┤
│ ● Restaurant    ▾   │  ← RC selector
├─────────────────────┤
│ Dashboard           │
│ Inventory           │
│ ...                 │
```

- Colored dot uses the active RC's color (mapped from color name to hex)
- Clicking opens a popover/dropdown within the sidebar listing all RCs
- Each RC row shows its dot + name; active RC gets a checkmark
- "Manage Revenue Centers" link at the bottom of the dropdown navigates to `/revenue-centers`

The active nav link gets a `border-l-4` accent in the active RC's color as an ambient reminder.

### Mobile — Sticky Top Bar

A new slim sticky header is added above page content on mobile only. The root layout gains `pt-[topBarHeight]` on mobile (md:pt-0) to prevent content overlap.

```
┌─────────────────────────────────┐
│ ● Restaurant Kitchen        ▾   │  ← sticky, full-width, left-aligned
├─────────────────────────────────┤
│  page content                   │
└─────────────────────────────────┘
        [bottom tab bar]
```

- Background: `bg-white border-b` with a subtle left border in RC color
- Tapping opens a bottom sheet listing all RCs to select from
- The existing mobile bottom nav is unchanged

### Color Palette

8 curated colors (no free-form hex input). Stored as color name strings, resolved to hex at render time:

| Name | Hex |
|---|---|
| blue | #3B82F6 |
| amber | #F59E0B |
| purple | #8B5CF6 |
| green | #22C55E |
| rose | #F43F5E |
| teal | #14B8A6 |
| orange | #F97316 |
| indigo | #6366F1 |

---

## Revenue Centers Management Page (`/revenue-centers`)

Simple CRUD page. List of RCs with their color swatches. Add / Edit / Delete.

- **Add:** name + color picker (8-option grid) + set-as-default toggle
- **Edit:** same form, pre-filled
- **Delete:** blocked if RC is the default or has any linked data (invoices, sales, wastage, count sessions with that RC id). Show error explaining why.
- **Set default:** any RC can be promoted to default; old default is demoted

Add link to sidebar nav under Settings (desktop) and More drawer (mobile).

---

## Inventory

### RC-Filtered KPIs
The top KPI strip (total value, low-stock count, etc.) filters by active RC's `StockAllocation`. Items with no allocation row for the active RC show as 0.

### Item Detail — RC Allocation Section
In the inventory item detail panel / drawer, a new "Stock by Revenue Center" section shows:

```
Restaurant Kitchen    42 kg   [Pull →]
Catering              18 kg   [Pull →]
Events                 5 kg   [Pull →]
```

### Pull Function
"Pull →" button on each non-active RC row transfers stock to the active RC. Opens a small inline form:

- Quantity to pull (numeric input with unit label)
- Optional notes
- Confirm button

On confirm: decrements source RC's `StockAllocation`, increments active RC's `StockAllocation`, writes a `StockTransfer` row. No negative balances — validate before saving. If the source RC has no `StockAllocation` row for this item, treat its balance as 0 and block the pull with a validation error.

Pull history (last 10 transfers for this item) shown in a collapsible section below.

---

## Invoices

### RC Assignment
When creating or reviewing an invoice session, the active RC is pre-assigned. The user can override it with an RC selector in the invoice header.

### Line-Item RC Override
In the invoice review UI, each line item has an optional RC selector. If set, that line item belongs to the specified RC instead of the invoice-level RC.

### Clone Invoice Generation
When an invoice is approved and some line items have a different RC than the invoice-level RC:

1. The original invoice session is approved normally for its RC
2. For each RC that has overridden line items, a **clone session** is created:
   - `parentSessionId` = original session id
   - `revenueCenterId` = that RC's id
   - Status: `APPROVED` (clones are pre-approved; they're just a cost attribution record)
   - Contains only the line items attributed to that RC

Clones appear in that RC's invoice list. They are read-only (editing the original regenerates clones — out of scope for v1; clones are static once created).

### Invoice List
Filtered by `activeRcId`. Clone invoices show a small "copy" badge and a link to the original.

---

## Sales

`SaleEntry` gains `revenueCenterId`. On the sales entry form, RC defaults to active RC. The field is visible but pre-filled — user can override.

Sales list and totals filter by `activeRcId`.

---

## Wastage

`WastageLog` gains `revenueCenterId`. Same pattern: pre-filled from active RC, overridable on the log form.

Wastage list and cost totals filter by `activeRcId`.

---

## Count Sessions

When starting a new count session, the RC selector is shown on the "New Count" setup screen (alongside location/area selectors). It defaults to the active RC. The selected RC is stored on `CountSession`.

Count history list filters by `activeRcId`. Count reconciliation (variance) is calculated against the RC's `StockAllocation`, not total physical stock.

On count approval, two writes happen: (1) `InventoryItem.currentStock` is updated as today (physical stock), and (2) the counted RC's `StockAllocation` is updated to the counted quantity for each item in the session.

---

## Reports — RC Dimension

All report API routes accept an optional `rcId` query parameter. When provided, data is filtered to that RC.

**COGS formula becomes RC-dimensioned:**
```
RC COGS = Beginning RC Allocation value
        + RC Purchases (invoices tagged to RC, in period)
        − Ending RC Allocation value
```

The Reports page passes `activeRcId` on all fetch calls. An RC filter label appears in the report header ("Showing: Restaurant Kitchen").

---

## API Routes

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/revenue-centers` | List all RCs |
| POST | `/api/revenue-centers` | Create RC |
| GET | `/api/revenue-centers/[id]` | Get single RC |
| PATCH | `/api/revenue-centers/[id]` | Update RC |
| DELETE | `/api/revenue-centers/[id]` | Delete RC (with guards) |
| GET | `/api/revenue-centers/[id]/allocations` | All stock allocations for an RC |
| POST | `/api/stock-transfers` | Execute a pull (write transfer + update allocations) |
| GET | `/api/stock-transfers` | List transfers (filterable by itemId, rcId) |

Existing routes gain optional `?rcId=` filtering where relevant (invoices, sales, wastage, count sessions, reports).

---

## Out of Scope (v1)

- Editing a clone invoice (clone is static once created)
- User-level RC permissions (all users see all RCs)
- RC-level budgets or purchase order limits
- Automatic stock allocation on invoice approval (user manually pulls stock; auto-allocation is a v2 option)
- Multi-currency per RC
