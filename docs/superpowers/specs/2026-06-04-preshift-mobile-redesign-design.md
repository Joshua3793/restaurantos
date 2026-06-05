# Pre-shift mobile redesign + Temps integration

_Design spec · 2026-06-04_

## Context

`/preshift` ([src/app/preshift/page.tsx](../../../src/app/preshift/page.tsx)) is **desktop-only** — a `1fr / 320px` two-column layout with no mobile renderer, so on a phone it renders the desktop columns squeezed. Every other TODAY page (Prep, Count, Temps) uses the app's dual-renderer pattern. This change adds a mobile renderer.

At the same time, the page's **"Safety & temps"** section logs temperatures itself: three hardcoded check rows (Walk-in A, Walk-in B, Hot hold) write readings to `localStorage` and auto-judge them via `judgeTemp`. That now duplicates the real, DB-backed **Temps** page (`/temps`, `TempUnit`/`TempReading` in Postgres). Two sources of truth for the same food-safety data is a divergence bug waiting to happen — logging a temp in one place won't appear in the other.

**This spec does two things:** (1) add an option-A mobile renderer, and (2) replace pre-shift's inline temp logging with a summary that **mirrors the Temps page**, applied to **both** renderers so they behave identically.

Decisions locked with the user:
- **Temps:** pre-shift mirrors `/temps` (shows status, deep-links to log) — it does not log temps itself.
- **Scope:** apply the temps change to **both** desktop and mobile. Desktop keeps its two-column layout; only its Safety section changes.
- **Layout:** mobile uses **option A** — gate banner + progress on top, every section visible as a card, inline sign-off button at the end (no floating/sticky bar — the user disliked that on Temps).
- **Checklist persistence:** the task checklist (`done`, `custom`) stays in `localStorage` as today. (Per-device; noted as a possible future move to DB, out of scope here.)

## What changes

### Remove (temps no longer logged here)
- The three hardcoded `temp` check items in the `safety` section (Walk-in A/B, Hot hold).
- The `temps` state, `logTemp`, `judgeTemp`, and the temp branch of `isDone` / `isBlockingOpen` / `toggle`.
- The `temps` key in the localStorage payload.

### Add — Safety & temps becomes a mirror
Fetch today's temp units and derive a single **temps gate**:

```
GET /api/temps/units?rcId=<activeRc?.id>&date=<today YYYY-MM-DD>
```

Run the result through existing helpers in [src/components/temps/temp-utils.ts](../../../src/components/temps/temp-utils.ts) — `computeDayMetrics(units)` gives `{ total, logged, flagged }`. Then:

- **`tempsReady` = `total > 0 && logged === total && flagged === 0`** (every unit logged today and none out of range). If `total === 0` (no units configured), treat as ready/not-blocking so the page isn't permanently gated before any units exist.
- The Safety section is **one gate item** (not three rows): contributes 1 to `total` and, when `tempsReady`, 1 to `doneCount`; contributes 1 open blocker when not ready.
- Card content: `"{logged}/{total} logged · {flagged} out of range"`, red left-accent when blocking, and a **"Log temps →"** button routing to `/temps`. No inputs.

This folds into the existing gate math (`doneCount`, `total`, `blockersOpen`, `pct`, `ready`) so the **"Mark ready for service"** gate already accounts for temps with no special-casing downstream.

### Keep (unchanged)
- **Line check** — prep-derived rows from `/api/prep/items` (`itemsBySection.line`), with their `isBlocked` blockers.
- **Service readiness** — static `service` section items + user `custom` checks; `AddCheck`; `localStorage` for `done`/`custom`.
- Service **countdown** via `currentWindow` / `nextServiceStart` / `fmtDuration` (`src/lib/service-hours`); `ready → router.push('/pass')`; Reset.

## Mobile renderer (layout A)

A `md:hidden` block added to the page (desktop block gets `hidden md:block`), both fed by the same derived state. Stacked, nothing hidden:

1. **Header** — "Pre-shift" + countdown to service (`serviceCountdown` / `serviceLabel`).
2. **Gate banner** — red `"{blockersOpen} blockers — service can't open"` / green `"Ready for service"`.
3. **Progress** — `{doneCount}/{total} done` + a thin bar (`pct`).
4. **Safety & temps card** — the mirror summary above (red accent when blocking; "Log temps →").
5. **Line check card** — prep rows (ready / blocked).
6. **Service readiness card** — checkable rows (tap toggles `done`); per-row delete for custom items; **Add check** below.
7. **Sign-off** — inline full-width button: disabled style until `ready`, then dark **"Mark ready for service"** → `openService()` (`/pass`). No sticky/floating bar.

Use **flat color tokens** only (`bg-red-soft`, `text-green-text`, …). Define mobile sub-components at **module scope** (focus-retention rule).

## Code shape

- **Shared:** extract a `SafetyTempsSummary` piece used by both renderers (props: `logged`, `total`, `flagged`, `onLogTemps`), plus the temps fetch + `tempsReady` derivation living in the page component (one fetch, both renderers read it).
- **Desktop:** its Safety `Section` swaps from temp `CheckRow`s to the `SafetyTempsSummary` card; the right-rail sign-off and `ProgressBand` are unchanged except they now read the temps-inclusive totals.
- **Mobile:** new module-scope components (`MGateBanner`, `MSectionCard`, `MCheckRow`, reuse `AddCheck`).
- Reuse existing preshift logic (`isDone`, `isBlockingOpen`, `blockers`, `pct`, `ready`, countdown) — only the temp items are replaced by the single derived gate.

## Files touched
- `src/app/preshift/page.tsx` — remove inline temp logging; add temps fetch + `tempsReady`; add mobile renderer; swap desktop Safety section.
- `src/components/preshift/SafetyTempsSummary.tsx` (new) — shared mirror card (or co-locate if small).
- Possibly `src/components/preshift/` for the new mobile sub-components, following the `src/components/temps/` precedent.
- Reuses `src/components/temps/temp-utils.ts` (`computeDayMetrics`, `isSafe`, `rangeText`).

## Verification
1. `npm run build` — type-check; `/preshift` compiles.
2. Dev server, `/preshift`:
   - **Desktop:** Safety section now shows the temps summary; with units logged & in range on `/temps`, the temp gate is green and counts toward sign-off; with one out of range, it's a red blocker and "Mark ready" stays disabled. "Log temps →" routes to `/temps`.
   - **Mobile (`preview_resize` mobile):** option-A layout — gate banner, progress, the four cards, inline sign-off. Toggle service-readiness checks; add a custom check; confirm blocker count and the gate flip to "Ready for service" when all clear (incl. temps). No floating bar.
   - Cross-check: logging temps on `/temps` updates the pre-shift Safety summary on reload (shared DB).
3. Screenshot desktop + mobile.
