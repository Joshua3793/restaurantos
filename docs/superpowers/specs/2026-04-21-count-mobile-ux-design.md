# Count Page — Mobile UX Redesign

## Goal

Fix text overlap and heavy desktop feel on the Count page for mobile screens. Replace cramped single-row session cards and the 3-row filter stack with clean, scannable mobile-first layouts — without touching the desktop experience.

## Architecture

All changes are mobile-only (below the `sm` / 640 px breakpoint). Desktop layouts are untouched. Three views are affected: session list, count mode, and review/finalize. No new API routes, no schema changes. All changes are confined to `src/app/count/page.tsx`.

## What Changes on Mobile

### View A — Session List

**Current problem:** Each session card fits date, label, counted-by + progress text, status badge, and 3 icon buttons (edit, reopen, delete) into one horizontal row. On mobile the text overlaps.

**New design — left-accent card:**
- A coloured 4px left border signals status at a glance: blue = IN_PROGRESS, amber = PENDING_REVIEW, green = FINALIZED, gray = CANCELLED
- **Line 1:** session label (bold, truncated) + status badge on the right
- **Line 2:** date · counted-by · progress (e.g. `Apr 21 · Joshua · 12/48`) on the left + CTA link on the right (`Continue →` / `Review →` / `Report`)
- **⋯ button** on the far right opens a small dropdown menu containing: Edit metadata, Reopen & edit counts, Delete — replacing the 3 icon buttons that currently clutter the row
- Tapping the card body (not ⋯) navigates: IN_PROGRESS → count mode, PENDING_REVIEW → count mode, FINALIZED → review view
- Desktop: the existing layout is preserved with `hidden sm:flex` / `flex sm:hidden` breakpoint guards

### View B — Count Mode

#### Item rows

**Current problem:** Category badge + location text sit on the same line as the item name — they overflow on narrow screens.

**New design — thin status-dot rows (mobile only, `block sm:hidden`):**

```
●  Cheddar cheese 1kg          3.5 kg
   Dairy · Walk-in cooler      +2.1%
```

- **Left:** 8px coloured dot — grey = uncounted, green = counted, amber = large variance (>15%)
- **Body:** item name (bold, truncated) on top; `category · location` as a small grey subtitle below (location omitted if empty)
- **Right:** counted qty + unit on top; variance % below (green / amber / red). Empty rows show `— —`
- **Counted row background:** faint green tint (`bg-green-50/60`) for counted, faint amber tint (`bg-amber-50/60`) for large-variance counted
- **Tap to expand:** tapping any row toggles the inline stepper (same ± buttons, numeric input, UOM label, Confirm count + Skip buttons as today)
- Skipped rows: grey background, strikethrough name, `Skipped` label on right
- Category group headers: kept, rendered as a thin label row — `DAIRY  4/8` — with a small inline progress bar. Same collapsible behaviour.
- Desktop: existing `renderLine` card layout unchanged (`hidden sm:block` wrapper)

#### Filter area

**Current problem:** Up to 3 stacked pill rows (category, location, status) consume significant vertical space.

**New design — single row + bottom sheet:**
- One pill row: `All · Uncounted · Counted` status pills always visible on the left; `⧉ Filter` button on the right
- Tapping Filter opens a bottom sheet (`fixed inset-0 z-50 flex items-end sm:hidden`) containing:
  - **Category** section: chip grid (All + each category name); tapping selects/deselects
  - **Location** section: chip grid (All + each location); only rendered if locations exist
  - Close handle + backdrop tap dismiss
- Active filter count badge shown on the Filter button when any filter is active (e.g. `⧉ Filter · 1`)
- Desktop: existing 3-row pill layout unchanged

### View C — Review & Finalize

**Current problem:** The 5-column variance table (`grid-cols-[1fr_80px_80px_70px_90px]`) breaks on mobile — columns are too narrow to read.

**New design — stacked variance cards (mobile only):**

Each counted item renders as a card:
```
⚠ Olive oil extra virgin         Oils
  Expected  4.0 L    →  Counted  2.0 L
  Variance  −50.0%       Cost  −$18.40
```

- Flagged items (>15% variance) get an amber left accent and warning icon
- Normal items get a plain white card
- Sorted by absolute cost impact descending (same as desktop)
- KPI strip at the top (Items counted · Flagged · Total value) stays as a 3-tile row, tiles made more compact (`py-2` instead of `p-4`)
- Approve & update inventory button: full-width, fixed to bottom of screen on mobile (`fixed bottom-20 inset-x-0 px-4 py-3 bg-white border-t`)
- Desktop: existing table layout unchanged (`hidden sm:block` / `block sm:hidden`)

## Files to Change

| File | Change |
|---|---|
| `src/app/count/page.tsx` | Add mobile session list cards, mobile count rows, mobile filter sheet, mobile review cards — all alongside existing desktop layouts with breakpoint guards |

No new files. No API changes. No schema changes.

## Desktop Unchanged

All existing layouts — session list flex rows, `renderLine` cards, 3-row filter pills, variance table — are untouched. They gain `hidden sm:flex` / `hidden sm:block` / `hidden sm:grid` guards where needed.

## Out of Scope

- Swipe-to-delete on session cards
- Infinite scroll / virtualisation
- Offline / draft mode
- Any changes to the new-session form (already redesigned and working)
