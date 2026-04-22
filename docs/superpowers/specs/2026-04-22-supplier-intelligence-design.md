# Supplier Intelligence — Design Spec

## Goal

Replace the existing Inventory → Suppliers page with a dedicated top-level Suppliers page that combines supplier contact management with purchasing intelligence: per-supplier spend KPIs, price change history, and item catalog.

## Scope

This spec covers:
- New `/suppliers` top-level page with split-panel layout (list + detail)
- Supplier contact management (add/edit/delete) carried over from existing page
- Supplier intelligence: spend KPIs, price change history, item catalog
- Navigation changes: Suppliers moves out of Inventory into the main nav
- Redirect `/inventory/suppliers` → `/suppliers`
- Mobile: list → tap → full detail page at `/suppliers/[id]`

Out of scope: export, invoice history per supplier (Phase 2b), supplier comparison view.

---

## Architecture

### Routes

| Route | Description |
|---|---|
| `src/app/suppliers/page.tsx` | Split-panel shell — owns `selectedSupplierId` state |
| `src/app/suppliers/[id]/page.tsx` | Mobile-only detail page (same sections, stacked) |
| `src/app/inventory/suppliers/page.tsx` | Replaced with a redirect to `/suppliers` |

### Components

| File | Responsibility |
|---|---|
| `src/components/suppliers/SupplierList.tsx` | Left panel: search, supplier rows sorted by spend, Add button |
| `src/components/suppliers/SupplierDetail.tsx` | Right panel: dark header, KPI strip, price changes, item catalog |
| `src/components/suppliers/SupplierFormModal.tsx` | Add/Edit supplier modal (extracted from existing page, logic unchanged) |

### API routes

| Route | Description |
|---|---|
| `GET /api/suppliers` | Existing — augmented to include `monthSpend` and `invoiceCount` per supplier |
| `GET /api/suppliers/[id]` | Existing — unchanged |
| `POST /api/suppliers` | Existing — unchanged |
| `PUT /api/suppliers/[id]` | Existing — unchanged |
| `DELETE /api/suppliers/[id]` | Existing — unchanged |
| `GET /api/suppliers/[id]/intelligence` | **New** — returns KPIs, price changes, items for one supplier |

---

## Components

### SupplierList

Left panel, fixed width `w-[280px]`, `bg-gray-50`, scrollable.

**Toolbar:** Search input (filters by name client-side) + "+ Add" button (opens `SupplierFormModal`).

**Supplier rows** (sorted by `monthSpend` descending):
- Supplier name (bold)
- Spend line: `$X,XXX this month · ↑Y%` — green if positive, red if ≥ 15% increase (signals concern), gray if no change
- Sub-line: `N items · N invoices`
- Selected row: blue left stripe (`border-l-2 border-blue-500`) + `bg-blue-50`

Clicking a row sets `selectedSupplierId` on the parent (desktop) or navigates to `/suppliers/[id]` (mobile).

### SupplierDetail

Right panel, `flex-1`, three sections:

**1. Dark header** (`bg-slate-800 text-white`):
- Supplier name (large, bold)
- Contact info: contact name, phone, email (muted)
- Ordering info: order platform, cutoff days, delivery days (muted)
- Edit and Delete buttons (top-right, ghost style)

**2. KPI strip** (`bg-gray-50`, flex row, three cards):
- **This Month** — `monthSpend` + `monthSpendChangePct` (green ↑ / red ↓)
- **This Year** — `yearSpend` + `yearInvoiceCount` ("N invoices approved")
- **Price Changes** — count of `priceChanges` from the intelligence endpoint, amber-tinted when > 0, label "last 90 days"

**3. Body** (two-column grid, `flex-1 overflow-y-auto`):

Left column — **Price Changes:**
- Section heading "Price Changes"
- Card list, one entry per `priceChange`: item name, old price → new price, % badge (red for increase, green for decrease), date
- Sorted by date descending (most recent first)
- If empty: "No price changes in the last 90 days" muted message

Right column — **Items Supplied (N):**
- Section heading "Items Supplied (N)"
- Table: Item name | Current price/unit | Last invoice date
- Sorted alphabetically
- All items shown (scrollable within the column)

### SupplierFormModal

Add/Edit modal extracted from the existing `src/app/inventory/suppliers/page.tsx` with no logic changes. Fields: Company Name, Contact Name, Phone, Email, Order Platform, Cutoff Days, Delivery Days.

---

## New API: GET /api/suppliers/[id]/intelligence

Returns all analytics for a single supplier in one request.

**Response shape:**
```ts
{
  monthSpend: number
  monthSpendChangePct: number      // % vs prior calendar month (0 if no prior data)
  yearSpend: number
  yearInvoiceCount: number         // approved sessions this calendar year
  priceChanges: Array<{
    itemName: string
    oldPrice: number               // converted from Prisma Decimal
    newPrice: number
    pctChange: number              // positive = increase
    date: string                   // ISO date string
  }>
  items: Array<{
    id: string
    itemName: string
    pricePerBaseUnit: number       // converted from Prisma Decimal
    baseUnit: string
    lastInvoiceDate: string | null // most recent approved InvoiceSession date for this supplier
  }>
}
```

**Queries:**
- Month/year spend: `InvoiceSession` where `supplierId = id`, `status = 'APPROVED'`, `approvedAt` in range, `_sum { total }`
- Price changes: `PriceAlert` where `session.supplierId = id`, `createdAt >= 90 days ago`, include `inventoryItem.itemName`
- Items: `InventoryItem` where `supplierId = id`, include last invoice date via a subquery on `InvoiceSession` for this supplier

---

## Augmented GET /api/suppliers

Add `monthSpend` and `invoiceCount` to each supplier in the list response. These are used to populate the list rows without needing a per-supplier intelligence fetch.

Queries added (run in parallel for all suppliers via `Promise.all`):
- `monthSpend`: `InvoiceSession` aggregate per supplierId, current month, `status = 'APPROVED'`, `_sum { total }`
- `prevMonthSpend`: same for prior month (used to compute change % for the list row)
- `invoiceCount`: `InvoiceSession` count per supplierId, `status = 'APPROVED'`

---

## Navigation changes

**Sidebar (`src/components/Sidebar.tsx` or equivalent):**
- Add "Suppliers" nav item with a `Truck` icon, positioned between Invoices and Recipe Book
- Remove "Suppliers" sub-link from the Inventory section

**Redirect:**
- `src/app/inventory/suppliers/page.tsx` replaced with: `redirect('/suppliers')` using Next.js `redirect()` from `next/navigation`

---

## Mobile

On `< sm` breakpoints:
- `src/app/suppliers/page.tsx` shows only the `SupplierList` (full width, no detail panel)
- Tapping a supplier row navigates to `/suppliers/[id]`
- `src/app/suppliers/[id]/page.tsx` shows `SupplierDetail` full-screen with a back button at the top

The detail page fetches the supplier contact info from `GET /api/suppliers/[id]` and intelligence from `GET /api/suppliers/[id]/intelligence` in parallel on mount.

---

## Data flow

```
/suppliers page
  ├── suppliers (state)          ← GET /api/suppliers (with monthSpend)
  ├── selectedSupplierId (state)
  ├── <SupplierList
  │     suppliers={suppliers}
  │     selectedId={selectedSupplierId}
  │     onSelect={setSelectedSupplierId}
  │     onAdd/onEdit/onDelete → refetchSuppliers />
  └── <SupplierDetail
        supplierId={selectedSupplierId}  />   ← fetches /api/suppliers/[id]/intelligence internally

/suppliers/[id] page (mobile)
  └── <SupplierDetail supplierId={params.id} />
```

---

## Error handling

- Intelligence fetch failure: KPI cards show `—`, price changes and items sections show a muted error state. No error thrown to user.
- Supplier list fetch failure: show empty state with retry button.
- Delete with linked inventory items: existing API returns an error — surface it as an inline message in the modal ("This supplier has linked inventory items. Unlink them first.").
