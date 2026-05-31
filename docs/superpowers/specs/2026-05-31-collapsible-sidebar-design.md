# Collapsible Notion-style Sidebar — Design

**Date:** 2026-05-31
**Status:** Approved (pending spec review)
**Scope:** Desktop only (`md:` breakpoint and up). Mobile bottom tab bar + "More" hub are untouched.

## Problem

The desktop nav sidebar is permanently docked at `240px`, consuming horizontal real estate on every page. We want it collapsible and summonable on demand — Notion-style — so each page can use the full screen width. This is the enabling step for a later per-page redesign (pages → block layouts), which is **out of scope here**.

## Behavior

### State model

A new `SidebarContext` exposes two booleans plus toggles. Persistence is via `localStorage` (key `controla.sidebar.pinned`).

- **`pinned`** — sidebar is docked and pushes content (today's behavior). Persisted.
  - **Default when no stored value: `true`** (docked). First-time and returning-uncustomized users see the familiar layout. Only users who explicitly collapsed get the collapsed state restored.
- **`peeking`** — transient overlay summoned by edge-hover or the toggle button while unpinned. **Never persisted.**

Effective visibility: `visible = pinned || peeking`.

### Three visual modes

1. **Pinned (expanded)** — identical to today: `<aside>` docked at `left:0`, width `240px`; `main` offset by `md:ml-[240px]`. Toggle button shows a "collapse panel" icon.
2. **Collapsed** — `<aside>` translated off-screen (`-translate-x-full`), not in layout flow; `main` left margin drops to `0` → content full-width. A ~6px invisible hover strip sits at the far-left screen edge.
3. **Peeking (collapsed + summoned)** — `<aside>` slides in as a `fixed` floating panel (`z-50`, soft shadow) **over** content. Content does **not** shift. Auto-dismisses when the pointer leaves the panel + edge zone (with a small grace timeout to avoid flicker), or when a nav link is clicked.

### Controls

- **Edge-hover strip** — fixed `w-1.5 h-screen` zone at `left:0`, `z-40`, desktop-only (`hidden md:block`). `onMouseEnter` → `peeking = true`. Only active when not pinned.
- **Floating toggle button** — fixed `top-3 left-3`, ~32px, `PanelLeft` Lucide icon, `z-50`, desktop-only. Click flips `pinned` (and clears `peeking`). Visible on every desktop page.
- **Pointer-leave dismissal** — the floating `<aside>` keeps `peeking` alive while hovered; a shared `onMouseLeave` (panel + edge strip) clears `peeking` after ~150ms. Clicking any nav `Link` clears `peeking` immediately.

### Collision handling

The cost-chrome strip is full-bleed at the top of `main`. The floating toggle button must not overlap it:
- **Collapsed/peeking:** `main` gets a small left gutter (`md:pl-12`) reserving space for the button.
- **Pinned:** the button tucks into the top-left over the docked sidebar header; `main` keeps `md:ml-[240px]` and no extra gutter.

The margin/padding on `main` is therefore reactive to sidebar state (driven by the context), replacing the static `md:ml-[240px]`.

## Components / Files

- **New — `src/contexts/SidebarContext.tsx`**
  - `SidebarProvider` + `useSidebar()` hook.
  - Reads `localStorage` on mount (default `pinned = true`); writes on every `pinned` change.
  - Exposes `{ pinned, peeking, togglePinned, setPeeking, collapse, expand }`.
  - Guard against SSR (`typeof window` checks); avoid hydration mismatch by initializing from a `useEffect` and rendering the docked default on first paint.

- **New — `src/components/layout/SidebarEdgeTrigger.tsx`** (or inline in layout)
  - The 6px edge strip + the floating toggle button. Reads `useSidebar()`. Desktop-only.

- **Edit — `src/app/layout.tsx`**
  - Wrap tree in `<SidebarProvider>`.
  - Replace `<main className="md:ml-[240px] …">` with state-reactive classes (margin when pinned, left gutter when collapsed).
  - Mount `<SidebarEdgeTrigger />`.

- **Edit — `src/components/Navigation.tsx`**
  - Desktop `<aside>` reads `useSidebar()` for docked-vs-floating positioning, transform, shadow, and transition.
  - Nav `<Link>` `onClick` clears `peeking`.
  - Mobile renderers unchanged.

## Edge cases

- **Hydration:** initial server render assumes pinned (the default) to match the no-JS / first-paint state; the `useEffect` then applies the stored value. Use a transition so a stored-collapsed state animates closed rather than flashing.
- **`peeking` + `pinned` race:** toggling pin always clears `peeking`.
- **Pages without cost-chrome:** the left gutter still applies uniformly so the button never overlaps page content.
- **Keyboard:** the existing `KeyboardShortcuts` component may later get a shortcut to toggle the sidebar; not required for this change.

## Testing / verification

No automated test suite — `npm run build` must pass (type-check). Manual verification via the preview tools:
1. Pinned → click toggle → sidebar collapses, content goes full-width.
2. Collapsed → hover far-left edge → sidebar floats in over content; move away → it dismisses.
3. Collapsed → click a nav link → navigates and stays collapsed.
4. Reload while collapsed → stays collapsed (persisted). Reload while pinned → stays pinned.
5. Fresh `localStorage` → starts pinned.
6. Toggle button never overlaps the cost-chrome strip in any mode.

## Out of scope

- Per-page block redesigns (the follow-up, done one page at a time).
- Mobile nav changes.
- Keyboard shortcut for toggling (optional future add).
