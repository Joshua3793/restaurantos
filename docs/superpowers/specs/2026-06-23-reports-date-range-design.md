# Reports Overview — Date-range view

**Date:** 2026-06-23
**Status:** Approved

## Goal

Let the user select the analysis period on the Reports **Overview** page instead of
being locked to the hardcoded weekly / week-to-date (WTD) windows.

## Scope decisions (confirmed with user)

- The range drives only **time-windowed** metrics: food-cost % (hero + breadcrumb
  sub), Revenue, Purchases, Wastage, and the underlying covers / theoretical-cost math.
- **Snapshot** panels stay live and untouched: Top inventory value drivers,
  out-of-stock, Recipe drift (current stock & current recipe costs).
- Picker = **presets + custom range**. Presets: This week, Last week, This month,
  Last 30 days, This quarter. Plus custom From/To. **Default: This week** (preserves
  current behavior).
- **Out of scope (YAGNI):** applying the range to other report tabs, URL persistence
  of the selected range, historical inventory snapshots.

## Architecture

### 1. `DateRangePicker` (new) — `src/components/reports/DateRangePicker.tsx`
- Preset chips + From/To date inputs.
- Emits `{ from: Date, to: Date, label: string }` to the parent.
- Styled with existing tokens (paper/line/gold/ink), matches `Card` / `PageHead`.
- Validation: `from > to` disables apply, shows inline hint.

### 2. `reports/page.tsx`
- Owns range state, default **This week**.
- Passes `from`/`to` (ISO) to the `dashboard` fetch: `?rcId&isDefault&from&to`.
- Relabels the three KPI cards from "WEEKLY / WTD / 7D" to the active range label.
- Hero + breadcrumb food-cost % now read the **range-based** value returned by
  `dashboard`. Target % and on-hand still come live from `cost-chrome` (point-in-time).

### 3. `api/reports/dashboard/route.ts`
- Accept optional `from` / `to` ISO params.
- When present: use a single `[from, endOfDay(to)]` window for ALL time metrics
  (sales revenue, food sales, purchases, wastage, covers, theoretical cost,
  food-cost %), and return them. Provide a range-based `foodCostPct` + `foodCostLabel`
  (purchases/food-sales, wastage fallback — same logic as today's estimate).
- When absent: current weekly/WTD behavior unchanged — so `signals` and `pass`
  consumers are unaffected (backward compatible).

### 4. Helpers — `src/lib/dates.ts`
- Add preset boundary math next to `startOfWeek`: `startOfMonth`, `startOfQuarter`,
  `lastWeekRange`, `endOfDay`.

## Data flow

pick preset/custom → page computes `{from,to}` → refetch `dashboard?rcId&from&to`
→ hero / cards / breadcrumb sub re-render with the range numbers + range label.

## Edge handling

- `to` inclusive (end-of-day).
- `from > to` → apply disabled + inline hint.
- Empty range (no sales) → food-cost % null → render "—" (existing pattern).

## Notes

- `cost-chrome` is the app-shell live strip (mounted on every page) — intentionally
  NOT made range-aware; it stays the live WTD indicator and supplies target + on-hand.
- "This week" preset = Monday→now (WTD), so the three KPI cards become consistent
  with the food-cost window (today they mix WTD and rolling-7d). Acceptable / clearer.
