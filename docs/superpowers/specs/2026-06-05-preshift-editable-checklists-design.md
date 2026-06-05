# Pre-shift editable checklists

_Design spec · 2026-06-05_

## Context

On `/preshift` ([src/app/preshift/page.tsx](../../../src/app/preshift/page.tsx)) the authored checks are hardcoded constants (`SAFETY_DEFAULTS`, `SERVICE_DEFAULTS`). Users can only **add** ad-hoc items (kept in a per-day `custom` array) and **delete** those custom ones — built-in checks can't be removed or reworded. The user wants the Safety and Service checklists to be **fully editable**: add items, delete any item, and edit the wording. The Temperatures summary and the Prep-derived Line checks are out of scope (Temps stays fixed; Line checks regenerate from Prep).

Decisions locked with the user:
- **Persistence:** per-device `localStorage`, persisting across days (a renamed/deleted check stays changed tomorrow). Not shared across devices (acceptable for now; can move to DB later).
- **Scope:** Safety + Service rows editable. Line checks stay auto-populated from Prep. Temperatures summary stays fixed/non-editable.
- **Edit = wording only.** The blocker flag is still chosen at add-time, not edited later. Deleting a built-in check simply removes it from the user's template.

## Storage model

Split the current single per-day blob into a persistent **template** plus the per-day **done-state**:

- **`preshift:template:<rc>`** → `{ items: ChecklistItem[] }` — the authored Safety + Service checklist. `ChecklistItem = { id: string; section: 'safety' | 'service'; title: string; meta?: string; blocker?: boolean }`. Seeded **once** from `[...SAFETY_DEFAULTS, ...SERVICE_DEFAULTS]` (mapped to this shape) when no template exists for the revenue center; thereafter fully user-owned. Persists across days. Key is per-RC, **not** date-scoped.
- **`preshift:<date>:<rc>`** → `{ done }` — only today's checked-off map. The `custom` key is removed from this blob.

`SAFETY_DEFAULTS` / `SERVICE_DEFAULTS` remain in the file purely as the **seed** for new templates. The three sections resolve as:
- `safety` = template items where `section === 'safety'`
- `service` = template items where `section === 'service'`
- `line` = Prep-derived `lineItems` (unchanged; not editable)

Migration note: existing users' per-day `custom` items are not carried over (they were ephemeral demo additions). On first load after this ships, a fresh template is seeded from defaults.

## Operations (all mutate the template, then persist)

- **Add** — the existing `AddCheck` bar, but it now appends to the template instead of the per-day `custom` array, and its section `<select>` offers only **Safety** and **Service** (Line removed). New item id: `tpl:<section>:<slug>-<n>`.
- **Delete** — a trash (×) control on **every** Safety/Service row (built-ins included). Removes the item from the template and clears its `done` entry.
- **Edit wording** — a pencil control that swaps the row title into an inline text `<input>`; Enter or blur commits the new `title` to the template, Escape cancels. Empty title is rejected (keeps the prior text).

The gate/blocker math, Temperatures summary, Line checks, and per-day `done` toggling are unchanged — deleting/adding items naturally flows through the existing `total`/`doneCount`/`blockersOpen` derivation because they read `itemsBySection`.

## Component changes

- **[src/app/preshift/page.tsx](../../../src/app/preshift/page.tsx):**
  - Replace `const [custom, setCustom]` with `const [template, setTemplate]` (`ChecklistItem[]`), add a `templateKey` (`preshift:template:<rc>`), and a hydrate/persist effect pair for the template (seed from defaults when absent). Drop `custom` from the per-day blob.
  - `itemsBySection`: safety/service from `template`, line from `lineItems`.
  - Replace `addCheck` (writes template), `removeCustom` → `deleteItem(id)` (works on any safety/service item), add `editItem(id, title)`.
  - Pass `onEdit`/`onDelete` to Safety/Service rows in both renderers (Line rows get neither — they're not editable).
- **`CheckRow` (desktop, in page.tsx):** add an editable mode — when `onEdit`/`onDelete` are provided, render a hover-revealed `[pencil] [×]` cluster; pencil turns the title into an inline input (local edit state). Row body still toggles `done`. Reuse the inline-input styling pattern from `src/components/temps/TempDesktop.tsx` (`DesktopUnitRow` name field: transparent input, hover/focus border).
- **`MCheckRow` ([src/components/preshift/mobile.tsx](../../../src/components/preshift/mobile.tsx)):** same editable mode for mobile — inline `[pencil] [×]` controls and an inline rename input; row body still toggles. Stop propagation on the control buttons so they don't toggle the check.

## Verification
1. `npm run build` — type-check; `/preshift` compiles.
2. Dev server, `/preshift` (desktop + mobile via `preview_resize`):
   - Rename a built-in check (e.g. "Sanitiser buckets made & dated" → "Sanitiser buckets — all stations"); reload → the new wording persists.
   - Delete a built-in check (e.g. "POS open & printers tested"); reload → it stays gone; the section/gate counts drop by one.
   - Add a check via the bar (Safety or Service only — Line absent from the picker); it appears, persists across reload, and counts toward the gate.
   - Confirm the **Temperatures** summary has no edit/delete controls and is unaffected; **Line checks** rows have no edit/delete controls.
   - Toggle a renamed check on/off — done-state still works and is per-day.
3. Screenshot desktop + mobile in edit state.
