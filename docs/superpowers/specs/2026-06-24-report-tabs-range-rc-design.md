# Date-range + RC scoping across report tabs

**Date:** 2026-06-24
**Status:** Approved

## Goal

Extend the shared `DateRangePicker` (presets + custom) and active-revenue-center
scoping to the remaining report tabs — **Sales, Inventory, Purchasing, Prep** — and
**mount Sales** as a real tab (it exists but is orphaned). Follows the Overview + COGS
work already shipped.

## Data facts (RC dimension)

- `SalesEntry.revenueCenterId` NOT NULL · `WastageLog.revenueCenterId` NOT NULL ·
  `PrepLog.revenueCenterId` NOT NULL · `InvoiceSession.revenueCenterId` nullable.
- `PriceAlert` has **no** RC column → price-change / supplier-volatility metrics are
  inherently global.
- Supplier offers (`InventorySupplierPrice`) have no RC → multi-supplier comparison is
  global.

## Design

### 1. Mount Sales
- `src/app/reports/sales/page.tsx` mirrors the other tab pages (`next/dynamic` →
  `SalesTab`, `ssr:false`).
- Add a "Sales" link to `src/app/reports/ReportsSubnav.tsx`.

### 2. `/api/reports/analytics` — absolute range + RC
- Add optional `from` / `to` (calendar days, parsed at UTC boundaries — same convention
  as Overview/COGS). When present, use `[from, endOfDay(to)]`; else keep the legacy
  `days` rolling window (backward compatible).
- Add optional `rcId` / `isDefault`; thread an RC filter through each section:

| Tab | Range-driven (windowed) | RC-scoped | Global (labeled) |
|---|---|---|---|
| Sales | sales, top items, weekly revenue | SalesEntry.revenueCenterId | — |
| Purchasing | spend by supplier/item, weekly trend | InvoiceSession.revenueCenterId (default → also null) | multi-supplier comparison & volatility |
| Inventory | price changes, value trend | stock value/by-category/top-value via RC stock model; count trend by RC | price changes & supplier volatility (no RC) |
| Prep | daily summaries, top items, categories | PrepLog.revenueCenterId | — |

- Inventory current-stock cards stay **point-in-time** (not range-driven), same split as
  Overview/COGS.
- RC stock model: default RC = `stockOnHand`; non-default = its `StockAllocation`; all =
  `stockOnHand` + every allocation (mirrors the inventory page / dashboard).

### 3. `/api/reports/prep`
- Already takes `startDate`/`endDate`; add `rcId` scoping on `PrepLog`.

### 4. Tab components
- Drop legacy `PeriodSelector` / inline period buttons; mount shared `DateRangePicker`;
  read `useRc()`; send `from`/`to` (+ `rcId`/`isDefault`).
- Default preset **"Last 30 days"** (preserves the current 30-day default; trend charts
  need the span). Add an optional `defaultPreset` prop to `DateRangePicker` so the right
  chip highlights initially and the parent can seed the matching range.

### 5. Honest global states
- Where a metric is global under a selected RC (price changes, supplier comparison),
  label it "Global — not RC-specific".

## Out of scope
- Per-RC historical inventory snapshots (counts are global).
- Changing the underlying analytics metrics themselves.
- Menu tab (separate page, not in this batch).

## Order of work
DateRangePicker prop → analytics API → prep API → tab components + page wrappers →
Sales route + subnav → build + verify.
