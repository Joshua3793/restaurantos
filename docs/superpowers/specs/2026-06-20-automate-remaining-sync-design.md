# Automate the remaining manual "Sync" controls

**Date:** 2026-06-20
**Status:** Approved (brainstorming) — ready for implementation plan
**Follows:** PR #16 (auto-sync PREP recipes) which removed the Inventory "Sync PREPD" and Prep "Sync from recipes" buttons.

## Problem

After PR #16, three automatable sync controls remain. Each makes derived/recomputed
data consistent and can run automatically on the right trigger, removing the manual
button. They are three independent subsystems with different mechanisms.

**Explicitly staying manual (confirmed, no work):** Sales "Import from Toast" and
Inventory "Import CSV" (file uploads, human-initiated) and Prep "Sync now" (offline
queue flush — already auto-flushes on reconnect; the button is an offline fallback).

## Part 1 — Count "Sync with inventory" → auto-reconcile on session open

**Today:** a manual "Sync" button (count page, desktop + mobile) calls
`POST /api/count/sessions/[id]/sync`, which reconciles an open session's lines against
current inventory: adds lines for newly-active items, removes lines for inactive/deleted
items, refreshes `expectedQty` + `priceAtCount` on **uncounted** lines, and refreshes
price on counted/skipped lines. It is **safe and idempotent**: it never overwrites an
entered `countedQty`, respects the session's `revenueCenterId`, and rejects FINALIZED
sessions (400).

**Design (client-side, no schema change):** when the count page opens/selects an
**IN_PROGRESS** session, automatically run the sync once in the background, then refresh
the lines — exactly what the button did, triggered on open instead of on click.

- The session's current lines display immediately (existing load), then the auto-sync
  runs and re-renders with the reconciled lines (non-blocking).
- Toast only when something actually changed (`added + removed + updated > 0`); stay
  silent on a no-op (no "Already up to date" spam on every open).
- Guard: only auto-sync `status === 'IN_PROGRESS'` sessions (the endpoint 400s on
  FINALIZED). Trigger from the explicit open/select-session action (one-shot per open),
  NOT a reactive effect, to avoid a sync→reload→effect loop. Track already-auto-synced
  session ids in a ref as a belt-and-suspenders guard.
- Remove the desktop + mobile "Sync" button, its handler's button wiring, and the
  `syncing`-on-click affordance. Keep `POST /api/count/sessions/[id]/sync` headless
  (manual/debug fallback), consistent with PR #16's pattern.

*Rejected alternatives:* server-side reconcile-if-stale in the GET route (needs a
`CountSession.lastSyncedAt` migration + makes GET mutate — more machinery than warranted);
triggering from the ~4 inventory-mutation sites (more wiring, syncs sessions nobody is
viewing). *Known limitation:* `expectedQty` drift from sales/invoices entered mid-count
is only reconciled on the next open, not live — acceptable (the button had the same
behavior, and physical counts rarely overlap sales entry).

## Part 2 — Signals "Refresh" → hourly Vercel Cron

**Today:** a manual "Refresh signals" button (`/signals` page) calls
`POST /api/signals/refresh`, which runs `evaluateAllRules()` (5 rules, idempotent,
~200+ reads — fine hourly, not sub-minute) and upserts the `Signal` table (preserving
SNOOZED/DISMISSED, pruning resolved OPEN signals). There is **no cron infrastructure on
main today**.

**Design (cron):**
- Extract the upsert/prune body of the POST handler into `recomputeSignals()` in
  `src/lib/signals/recompute.ts` (returns `{ inserted, updated, resolved, total }`).
- `POST /api/signals/refresh` calls `recomputeSignals()` (keeps its `requireSession()`
  auth) — remains as a headless/manual trigger.
- New `GET /api/cron/signals` (`export const dynamic = 'force-dynamic'`): authorize by
  `req.headers.get('authorization') === 'Bearer ' + process.env.CRON_SECRET` (Vercel Cron
  sends this header when `CRON_SECRET` is set); 401 on mismatch; else `recomputeSignals()`.
  Vercel Cron issues GET, hence a GET handler.
- New `vercel.json` at repo root:
  ```json
  { "crons": [{ "path": "/api/cron/signals", "schedule": "0 * * * *" }] }
  ```
- Remove the "Refresh signals" button + `refreshing` state from `src/app/signals/page.tsx`.
  The page keeps its on-mount `load()` (GET `/api/signals`, pure read) so it always shows
  the latest cron-computed signals.

**Operator actions (outside code, flagged):** set `CRON_SECRET` in Vercel project env
(Production) and in local `.env`; document it in CLAUDE.md's env list. Vercel Cron runs
only on the Production deployment.

## Part 3 — Reports dashboard "Refresh" → auto-refresh, passive label

**Today:** `src/app/reports/signals/page.tsx` runs `fetchAll()` on mount (read-only:
dashboard + invoice KPIs + high-cost recipes) and exposes a clickable refresh showing a
timestamp. It writes nothing — a manual reload.

**Design (client-only):**
- Keep the existing on-mount `fetchAll()`.
- Add auto-refresh: a 5-minute `setInterval(fetchAll, …)` (cleared on unmount) and a
  `window` focus / `visibilitychange` listener that calls `fetchAll()` when the tab
  becomes visible (guarded so it doesn't refetch more than once per ~30s).
- Demote the clickable refresh to a passive **"Updated HH:MM"** label (drop its
  `onClick`; keep the timestamp from `refreshedAt`).

## Scope & decomposition

Three independent subsystems, one theme. One spec; the implementation plan groups tasks
by part (Part 1 client-only; Part 2 cron + endpoint refactor + button removal + config;
Part 3 client-only). They can be implemented and reviewed independently.

## Out of scope
- Sales/Inventory file imports and Prep offline "Sync now" stay manual buttons.
- Event-driven signal recompute on invoice approval (cron is sufficient; possible future).
- Live `expectedQty` reconciliation mid-count (Part 1 known limitation above).

## Testing / verification

No automated suite — `npm run build` is the type-check gate; behavior verified via the
running app + targeted checks.

1. Build passes; `/api/cron/signals` shows `ƒ (Dynamic)` in the route table.
2. **Part 1:** open an IN_PROGRESS count session after deactivating/adding an inventory
   item → the line set reconciles automatically (added/removed), entered counts preserved,
   a toast appears only when something changed; opening a session with no inventory change
   shows no toast. No infinite sync loop (verify via network panel: one sync per open).
3. **Part 2:** `curl` `/api/cron/signals` without the bearer → 401; with
   `Authorization: Bearer $CRON_SECRET` → recompute runs and returns counts. The `/signals`
   page shows signals with no button; `POST /api/signals/refresh` still works manually.
4. **Part 3:** dashboard refetches on tab-focus and on the interval; the timestamp updates;
   no clickable refresh remains.
