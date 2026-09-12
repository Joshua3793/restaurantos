# Prep drawer progress persists while the item is on the To Do

**Goal:** Whatever a cook does in the item drawer's cook-along — the scale, ticked ingredients, ticked method steps — is kept for as long as the item is on the To Do list, however many times the drawer is closed, and is reset only when the job completes (DONE / PARTIAL), is skipped, or is removed from the list.

**Design**
- **Storage: `PrepLog.progress Json?` on the item's ONE live log** (`{ makeQty, ingredients: string[], steps: string[] }`, see `src/lib/prep-progress.ts`). Server-side, because cooks share devices and the To Do itself is server state; it survives a reload and a second iPad. Ingredients are keyed by `RecipeIngredient.id`, method steps by `MethodStep.key` (legacy steps by `s<idx>`), so a reordered recipe does not shift ticks.
- **Written by `PUT /api/prep/logs/[id] { progress }`** — no LEAD gate (cooks own their progress), validated by `parseProgress`, `null` clears. The same route sets `progress` to null on a completion or SKIPPED status; `POST /api/prep/plan/remove-item` clears it when it clears `postedAt`. Stop (NOT_STARTED) keeps it — the user asked for reset only on completion or removal.
- **Client:** the prep page keeps `progressRef: Map<logId, PrepProgress>` (session cache, wins over the polled `todayLog.progress`) and `drawerProgress` state. `openDrawer` seeds the drawer from the cache, then the live log, then the item's suggested qty. Ticks and scale changes update the cache immediately and PUT with a 500 ms debounce per log. Completion / skip / removal delete the cache entry. Only items with a REAL live log id persist (an `_opt_` offline id or no log behaves as before: ephemeral).
- `PrepRecipeSection` becomes seedable: `progress` + `onProgressChange({ ingredients?, steps? })` props; its two Sets are keyed by id / step key instead of index.
- Additive migration `20260911120000_prep_log_progress` (`ALTER TABLE "PrepLog" ADD COLUMN "progress" JSONB`), applied to the live DB over the session pooler before merge (deploy runs no migrate).

**Out of scope:** sub-recipe ingredient ticks in `RecipeViewModal` (page-level `subRecipeChecked`, unchanged); offline queueing of progress writes (offline ticks live in the session cache only).

**Files:** `prisma/schema.prisma`, the migration, `src/lib/prep-progress.ts` (+ test), `src/app/api/prep/logs/[id]/route.ts`, `src/app/api/prep/plan/remove-item/route.ts`, `src/components/prep/types.ts`, `src/components/prep/PrepRecipeSection.tsx`, `src/components/prep/board/PrepBoardDrawer.tsx`, `src/components/prep/PrepDrawer.tsx`, `src/app/prep/page.tsx`, `CLAUDE.md`.

**Verification:** `npm test` (new lib tests), `npx tsc --noEmit`, eslint on touched files, isolated `npm run build`; browser: tick two ingredients + one step + change scale on a posted item, close and reopen the drawer (state kept), reload the page (state kept), complete the item (state gone on the next log), and remove + undo another item (state gone).
