# Sales Period Import Design

## Goal

Extend the sales import feature to support weekly and monthly ProductMix CSV exports from Toast POS, and update the sales page to display summaries at day, week, and month granularity with intelligent aggregation.

## Background

Currently the sales import only handles single-day ProductMix exports. Users must upload sales data daily, which is impractical. Toast's ProductMix export supports any date range — a weekly or monthly export contains the same columns and structure as a daily one, but with aggregated totals and quantities across the full period. Enabling period imports lets users do weekly or monthly sales reconciliation instead of daily uploads, while still getting accurate COGS, theoretical inventory usage, and trend analysis.

---

## 1. Data Model

### `SalesEntry` schema change

Add two fields:

```prisma
periodType  String    @default("day")  // "day" | "week" | "month" | "custom"
endDate     DateTime?                  // null for day entries; set for all period entries
```

No other changes. `SaleLineItem` is unchanged — line items work identically regardless of period type.

**Migration:** `ALTER TABLE "SalesEntry" ADD COLUMN "periodType" TEXT NOT NULL DEFAULT 'day'; ALTER TABLE "SalesEntry" ADD COLUMN "endDate" TIMESTAMP(3);`

Existing daily entries get `periodType = 'day'` and `endDate = NULL` via the column defaults. No backfill needed.

---

## 2. CSV Parsing

### Date range detection (`/api/sales/import/route.ts`)

The current parser scans Summary sheet cell A1 for a single `YYYY-MM-DD` pattern. The updated logic:

**Single-day file** (e.g. `ProductMix_2026-04-01`):
- Existing behavior unchanged
- `periodType = 'day'`, `endDate = null`

**Period file** (e.g. `ProductMix_2026-04-01_2026-04-30`):
- Extract two dates from the title string using regex: `/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/`
- `startDate = first date`, `endDate = second date`
- Auto-detect `periodType`:
  - `endDate - startDate` = 6–7 days → `'week'`
  - `endDate - startDate` = 28–31 days → `'month'`
  - anything else → `'custom'`

**Everything else is identical:** item parsing, recipe fuzzy-matching, totals extraction, and the Items sheet structure are the same for all period types.

---

## 3. Import Modal UX

### Single-day files
No changes to the existing modal flow.

### Period files (auto-detected)
- The single date field becomes two fields: **From** and **To**, pre-populated from the file, both editable
- A small badge shows the auto-detected period type: **Week** / **Month** / **Custom** — user can change via a dropdown
- The rest of the modal is identical: item list with fuzzy-match confidence badges, editable quantities, total revenue and food sales fields
- On save: POST to `/api/sales` with `periodType`, `endDate`, and all existing fields

---

## 4. Sales Page — Split Panel Layout

The sales page gains a **Week / Month** granularity toggle and a split-panel layout.

### Left panel — period list

- Granularity toggle at top: **Day** | **Week** | **Month**
- **Day mode**: shows existing daily entry list (current behavior) — one row per day, clicking a row shows that day's line items in the right panel
- **Week / Month mode**: each row = one period in reverse chronological order
- Row shows: date range label, total revenue, completion badge
- Badge variants:
  - `7/7 days` — all days present (aggregated from daily entries)
  - `4/7 days` — partial week (some daily entries missing)
  - `Weekly import` — came from a direct weekly file upload
  - `Monthly import` — came from a direct monthly file upload
  - `Not available` (muted, no revenue) — no data for that period

### Right panel — period detail

Shows detail for the selected period:

- **Summary card** at top: total revenue, food sales %, covers (if available), period type label
- **Day breakdown** below: one row per day in the period
  - If daily entry exists: show revenue
  - If missing: show "—" in muted text
- **Direct import note**: if the period came from a weekly or monthly import (not aggregated from daily entries), show "Imported as [Week / Month]" and omit the day breakdown rows

### Aggregation logic (client-side)

All aggregation is done in the browser from the existing `/api/sales` GET response (no new API aggregation endpoints needed).

| Scenario | Result |
|---|---|
| Direct weekly import exists for that week | Use it as-is; show "Weekly import" badge |
| Daily entries cover the full week | Sum them → week total; show "7/7 days" badge |
| Daily entries cover part of the week | Sum available; show "X/7 days" badge |
| No data for that week | Show "Not available" |
| Direct monthly import exists | Use it as-is; show "Monthly import" badge |
| Weekly entries (or daily rollups) cover the month | Sum the weeks → month total |
| No data for that month | Show "Not available" |

**Week definition:** ISO week (Monday–Sunday).

**Conflict handling:** If both a direct period import and daily entries exist for the same date range, the direct import takes precedence for display. Daily entries are still shown in the day breakdown rows.

---

## 5. API Changes

### `POST /api/sales`
Accept two new optional fields in the request body:
- `periodType: string` (defaults to `'day'` if omitted)
- `endDate: string | null` (ISO date string, defaults to `null` if omitted)

### `GET /api/sales`
No changes. Returns all `SalesEntry` rows including the new `periodType` and `endDate` fields. Client-side aggregation handles the week/month grouping.

### `PUT /api/sales/[id]`
Accept `periodType` and `endDate` in the update body (pass-through, same pattern as other fields).

---

## 6. Out of Scope

- Per-day breakdown within a weekly/monthly Toast export (Toast does not include per-day data in period exports)
- Duplicate detection / overlap warnings when both a period import and daily entries exist for the same dates
- Server-side aggregation endpoints for week/month rollups
- Editing period type after import (user can delete and re-import)
- Any changes to COGS calculation logic, recipe costing, or inventory usage routes — they already consume `SaleLineItem` records and are unaffected
