# Inventory Page — Mobile UX Redesign

## Goal

Redesign the inventory page layout for mobile screens so it feels light and scannable, replacing the heavy desktop table with a thin card list, compact KPI strip, and a streamlined header — while leaving the desktop experience completely unchanged.

## Architecture

All changes are mobile-only (below the `sm` / 640 px breakpoint). The desktop table, column headers, and sorting behaviour are untouched. On mobile, a parallel rendering path shows the new list layout. No new API routes, no schema changes.

## What changes on mobile

### Header
- **Keep**: page title ("Inventory") + item count subtitle
- **Keep visible**: Cart button (order list), **+ Add** button
- **Move to ⋯ overflow menu**: Export, Sync PREPD — these are infrequent actions that don't need top-level space on mobile

### KPI strip
- Replace the 2-column `grid` with a **horizontally scrollable single row** of compact tiles
- Tiles: Stock Value · Counted (n / total) · Uncounted · Active
- Each tile has a coloured background matching the existing accent colours (blue, green, orange, slate)
- No wrapping — tiles scroll off-screen to the right

### Filter pills
- Replace the wrapping `flex-wrap` row with a **horizontally scrollable single row**, no wrapping
- Order: All Items · Active · Out of Stock · Uncounted · High Value · ⇅ Sort · ▽ Filter
- **Sort** opens a bottom sheet with the existing sort options (A–Z, category, price, stock, value)
- **Filter** opens a bottom sheet with category select, supplier select, storage area select, and the Grouped/Flat toggle
- The category and supplier `<select>` elements that currently sit in the search bar row are **hidden on mobile** (moved into the Filter sheet)

### Search bar
- Full-width, always visible below the header — unchanged in behaviour

### Item list
Each item renders as a **thin row** (not a table row):

```
● Item Name                    $12.50/kg
  GLU  MLK                        24 kg
```

- **Left**: stock-status dot (green = in stock, orange = out of stock) + item name (bold, truncates) + allergen badges on the line below (existing `AllergenBadges` component, `size="xs"`) — only rendered if `allergens.length > 0`, so rows without allergens are naturally shorter
- **Right**: purchase price with unit label (e.g. `/kg`) on top, stock on hand quantity below; out-of-stock qty text is orange
- **Chevron** `›` on the far right — tapping the row opens the existing detail panel (unchanged)
- Out-of-stock rows get a faint `#fffbf5` background tint

### Category group headers
Kept — colour-coded by category (same `CATEGORY_HEADER` colours), showing category name + item count on the left and category value on the right. Collapsible on tap (same behaviour as desktop).

### What is NOT on mobile rows
- Supplier name
- Storage area / location
- Inventory value per item
- Checkbox (bulk actions hidden on mobile — too complex for touch)
- Active toggle (accessible via detail panel instead)

### Detail panel
Unchanged — already works well as a full-screen overlay on mobile.

## Files to change

| File | Change |
|---|---|
| `src/app/inventory/page.tsx` | Add mobile list renderer, mobile header, mobile KPI strip, mobile filter pills, overflow menu, bottom sheets for Sort/Filter |

No new files needed — all changes are additions within the existing page component.

## Desktop unchanged

Everything above `sm:` breakpoint is untouched: the `<table>`, column sort headers, bulk action bar, checkboxes, supplier/category selects in the search row.

## Out of scope

- Swipe-to-delete or swipe actions on rows
- Infinite scroll / virtualisation (the list already renders all items; acceptable for now)
- Editing from the mobile list (use detail panel)
