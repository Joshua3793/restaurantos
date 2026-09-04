# Prep page audit — the To Do does not show the plan the chef posted

**Status (2026-09-04):** steps 1–4 implemented on branch `feat/prep-unified-ladder` (uncommitted at time of writing). Close is now the last service's end and the planning day rolls only once it has passed; the run sheet is one step ladder (`withLadderTimes` / `runSheetGroups` in `prep-plan.ts`) on desktop and mobile; posting stamps `PrepLog.dueTime` and rows show "by 11:00 · posted by …" when the live step has moved; mobile falls back to Kitchen when My station is empty, and a cook with no home station no longer matches unstationed items. Step 5 applied to the live db the same day (backup `prep-times-repair-backup-2026-09-04T16-12-15-849Z.json` in the repo root): six whole-day values were elapsed time stored as hands-on — Smoked Brisket and Smoked Pulled Pork (60 + 2,820 smoke), Cured Salmon (30 + 2,850 cure), Caper & Dill Crème Fraîche (15 + 1,425 set), Sourdough Starter (10 + 1,430 ferment), Sourdough Bread (45 + 1,395 proof). Totals unchanged, so start-by did not move; written on the recipe with the item overrides cleared; the live post's stored hands-on recomputed 7,685 → 500 min. Every other item's hands-on is still the old `estimatedPrepTime` backfill (no recipe has authored times) — the 3–5h ones (English Muffins 300, Bean Puree / Shakshuka / Blood Pudding 240, Bacon Jam 210, BBQ Sauce / Beef Tallow / Mushroom Ragout / Smoked Goat Cheese Cream / Smoked Miso Honey Butter 180) are probably mostly unattended too and are the chef's call.

**Date:** 2026-09-04 · **Scope:** `/prep` Smart Prep planner vs the To Do run sheet (desktop + mobile), the API that feeds them, and the live data behind them. Read-only audit; nothing was changed.

## Summary

The Smart Prep planner and the To Do run sheet are built on two different ordering models that were never reconciled:

| | Smart Prep planner | To Do run sheet |
|---|---|---|
| Unit of priority | 4-step urgency (`PASS` · `MID` · `CLOSE` · `TMRW`), chef can override the step | 3-level `priority` (`911` · `NEEDED_TODAY` · `LATER`), a *collapse* of the 4 steps |
| Deadline | Per step: doors-open / doors+2h / close / tomorrow's doors, rolled to tomorrow when planning after the last service | None. Only `startBy = service.time − active − passive`, never rolled |
| Ordering within a group | Step deadline → step → chef's drag order (`listOrder`) | `startBy` only. `listOrder` is never read |
| Default view | Grouped by step | Grouped by clock ("Late to start" / "within the hour" / "Later this morning" / "Afternoon") |
| Vocabulary | `PLAN_URG_META` (one table) | Two more hand-copied tables that have already drifted from it and from each other |

The result is that the chef dials in a plan by step and the cook sees a list ordered by a number the chef never touched. On the live list (10 posted items, all Brunch, all chef-overridden to MID or CLOSE) the To Do puts the two 48-hour smokes the chef marked **Before close** at the very top as "2 days LATE", and its Priority view puts all 10 items in one bucket. Neither view can show the plan that was posted.

## How each surface decides order

### Planner (`src/lib/prep-plan.ts`)

- `effectiveUrgency(item)` = chef override ?? `autoUrgency(onHand, par, targetToday)`.
- `planDayContext(services, now)` picks the day's anchors. After the last doors-open of the day, `doorsOpen` rolls to tomorrow so evening planning is for tomorrow.
- `urgencyDeadline(step, ctx, svcStart)` gives each step a minute-of-day deadline.
- `planSchedule` sorts a station's draft by deadline → step → `listOrder`, then walks crew cursors from `shiftStart` to give each row a slot and a "won't fit" flag. This is what the DraftRow's `07:30–08:15 · BY 11:00` line and the post dialog's "First start" show.
- `planGroups(rows, 'urgency')` groups by step and orders each group by `listOrder`.

### To Do (`src/components/prep/runsheet/RunSheet.tsx`, `RunSheetMobile.tsx`)

- `todo` = posted, not started, not done, sorted by `startByMinutes ?? Infinity` ([RunSheet.tsx:107](../../../src/components/prep/runsheet/RunSheet.tsx)).
- `startByMinutes` is computed in the items API as `service.timeMinutes − active − passive` ([items/route.ts:206](../../../src/app/api/prep/items/route.ts)). It does not know the urgency step and does not roll to tomorrow.
- **Time** ladder: `< now` → "Late to start"; `< now+60` → "Start within the hour"; `< 12:00` → "Later this morning"; everything else including `null` → "Afternoon" (desktop) / "Later today" (mobile).
- **Priority** ladder: buckets by the 3-level `item.priority`; rows inside keep the `startBy` sort.
- The mobile **My station** hero is `myTodo[0]`, i.e. the earliest `startBy`.
- The planner's schedule slot, deadline and `listOrder` are not rendered anywhere on the To Do. `PrepLog.dueTime` exists in the schema and is never written by the planner.

## Live data (read-only query, 2026-09-04)

| Measure | Value |
|---|---|
| Active prep items | 60 |
| … with a target service | 53 (all the same service: Brunch 09:00–16:00) |
| … with active minutes | 54 |
| … with passive minutes | 2 |
| … with a chef step override | 16 (`PASS`, `MID`, `CLOSE`) |
| … with a station | 56 (effectively all "Prep") |
| Posted, still open | 10 |
| … chef-overridden | 10 of 10 |
| … with a `listOrder` | 2 of 10 |
| … with a `dueTime` | 0 |
| … assigned to a cook | 0 |
| Active cooks | 23, none with a home station |
| Last post | Sep 3 list, posted 17:21 Pacific (after the day's service, for the next morning) |

Two of the posted items (Smoked Brisket, Smoked Pulled Pork) carry **2,880 active minutes** and no passive time, and Caper & Dill Crème Fraîche carries 1,440. The 48-hour smoke is stored as hands-on time.

### What the To Do shows for the posted list at 07:30 tomorrow

| Item | Chef's step | Deadline the planner showed | `startBy` | To Do (Time view) |
|---|---|---|---|---|
| Smoked Brisket | CLOSE | by 22:00 | 09:00 −2d | **Late to start · 2 days late** (top of list) |
| Smoked Pulled Pork | CLOSE | by 22:00 | 09:00 −2d | Late to start |
| Caper & Dill Crème Fraîche | MID | by 11:00 | 09:00 −1d | Late to start |
| Corn Salsa | MID | by 11:00 | 07:00 | Late to start |
| Pickle Apples | MID | by 11:00 | 07:00 | Late to start |
| Sun Dried Tomato Aioli | CLOSE | by 22:00 | 08:15 | Start within the hour |
| Adobo Pulled Pork | CLOSE | by 22:00 | 08:30 | Start within the hour |
| Beef Tallow Aioli | MID | by 11:00 | 08:30 | Start within the hour |
| Coffee Rub Mix | CLOSE | by 22:00 | 08:40 | Start within the hour |
| Zucchini Scapece | MID | by 11:00 | — | Afternoon (last) |

The chef's plan reads MID first (5 items by 11:00) then CLOSE (5 items by 22:00). The To Do reads the opposite for the two heaviest jobs and buries a MID item at the bottom because it has no service. Switch to the To Do's Priority view and all 10 land in "Needed today" with the same internal order, because MID and CLOSE collapse into one bucket.

At the moment the list was posted (17:21) every `startBy` was already in the past, so the cook opening the To Do that evening saw all nine timed items under "Late to start" in red, from 9 hours to 2 days late.

## Findings

Ordered by impact. File references point at the line that decides the behaviour.

1. **The To Do orders by a number the planner does not use.** Planner ranks by step deadline + `listOrder`; the To Do ranks by `service − times`. There is no code path from one to the other. [RunSheet.tsx:107](../../../src/components/prep/runsheet/RunSheet.tsx), [prep-plan.ts planSchedule](../../../src/lib/prep-plan.ts).

2. **`startBy` never rolls to the next day.** The planner rolls `doorsOpen` after the last service; `startByMinutes()` in `prep-runsheet.ts` subtracts from the raw service minute. Every evening-posted list opens fully red. [prep-runsheet.ts startByMinutes](../../../src/lib/prep-runsheet.ts), [prep-plan.ts planDayContext](../../../src/lib/prep-plan.ts).

3. **The To Do's Priority view throws away half the scale.** It buckets by the 3-level `priority`, so MID (ready 2h into service) and CLOSE (any time today) are indistinguishable. On the live list that is 10 of 10 items in one bucket. [RunSheet.tsx:161](../../../src/components/prep/runsheet/RunSheet.tsx), [RunSheetMobile.tsx:37](../../../src/components/prep/runsheet/RunSheetMobile.tsx).

4. **The chef's drag order is discarded.** `listOrder` is persisted by the reorder route and read by `planGroups`, but no run-sheet component reads it. Within any To Do group the order is `startBy`, then whatever the API returned (priority, then name).

5. **Three vocabularies for one scale.** `PLAN_URG_META` (planner), the desktop `defs` array, and mobile `PRIORITY_GROUPS` disagree. Desktop To Do says "Tomorrow · at par — building ahead"; mobile To Do says "Later · can slip to the afternoon" for the same bucket; the mobile file's comment claims it is kept in sync with desktop. The planner's TMRW step means "for tomorrow's service", not "this afternoon".

6. **Planner deadline bug in evening planning: Before close sorts ahead of Critical.** At 17:21 with Brunch 09:00–16:00, `planDayContext` gives `doorsOpen = tomorrow 09:00` but `close = tonight 22:00` (close only rolls when it is already past). So CLOSE deadlines at 22:00 tonight, PASS and MID at tomorrow 09:00/11:00, and TMRW ties with PASS. `planSchedule` sorts by deadline first, so the DraftRow shows `BY 22:00` for a Before-close item and `BY TMRW 09:00` for a Critical one, and sequences the CLOSE items first. [prep-plan.ts urgencyDeadline](../../../src/lib/prep-plan.ts).

7. **The clock buckets are hard-coded to noon.** "Later this morning" ends at 12:00 and "Afternoon" absorbs everything else including items with no service. For a kitchen whose only service opens at 09:00 these labels never describe anything real; after noon the whole list is "Afternoon".

8. **Mobile defaults to a mode that is empty for every cook.** `RunSheetMobile` starts in **My station**; `isMine` needs an assignment or `item.station === cook.homeStation`. With 0 assignments and 23 cooks with no home station, the only match is the one item whose station is also null (Zucchini Scapece). Every cook opens the app to one item and a hero card for it. [RunSheetMobile.tsx:86](../../../src/components/prep/runsheet/RunSheetMobile.tsx).

9. **Hands-on totals and the station load are inflated by unattended time stored as active.** The PostedBand's "hands-on", the planner header, the post dialog and `stationLoad` sum `activeMinutes`; with 2,880 + 2,880 + 1,440 in the list the live post reports roughly 120 hours of hands-on and the load strip is permanently red. This is data (recipe times), but the UI has no guard and the "won't fit" warning is meaningless while it stands.

10. **The planner's schedule is thrown away at post.** `PrepLog.dueTime` is in the schema and passed through the log routes but the post route never writes it; the cook cannot see the deadline or the slot the chef reviewed in the post dialog.

11. **Minor.** `sbOr(a) − sbOr(b)` is `NaN` when both are null (`Infinity − Infinity`); the sort tolerates it but it is a latent trap for anyone who adds a tiebreak. Desktop `priority` grouping keys on `item.priority` while the row's `UrgencyDot` keys on `effectiveUrgency(item)`; consistent today only because both derive from the same fields.

## Recommendation: one ladder, derived from the step

Make the To Do a rendering of the same model the planner builds, instead of a second model.

**Deadline per item, rolled with the planning day.** Reuse `planDayContext` + `urgencyDeadline` on the To Do (the run sheet already receives `services` and `nowMin`). Fix `planDayContext` so `close` rolls with `doorsOpen`: when doors have rolled to tomorrow, close is tomorrow's close. Define

```
deadline = urgencyDeadline(effectiveUrgency(item), ctx, item.service?.timeMinutes)
startBy  = deadline − active − passive
```

This one change fixes findings 1, 2 and 6: `startBy` becomes step-aware, rolls to tomorrow, and a Before-close smoke counts back from close instead of from doors.

**Sections are the steps, not the clock.** Replace the Time / Priority toggle with a single ladder whose sections are the four steps in `PLAN_URG_META`, labelled with their deadline for this day:

- Late to start (any step, `startBy < now`) — kept, at the top, above the NOW line
- Critical — ready for doors · by 09:00
- Mid-service · by 11:00
- Before close · by 22:00
- Tomorrow · by TMRW 09:00

Inside a section, order by `startBy`, then `listOrder`, then name. The chef's within-step drag order survives; a long job still floats to the top of its step. Keep **Station** as the only alternate grouping (it is the one that answers a different question).

**One vocabulary.** Delete the desktop `defs` array and mobile `PRIORITY_GROUPS`; both read `PLAN_URG_META`. The drawer already does.

**Persist what was posted.** At post time write `dueTime` (the step deadline) and keep `listOrder` on the live log. The step itself stays live-computed, which keeps the app-wide rule that priority is never trusted from a snapshot, and the existing "Stock changed" banner already covers escalation. If a posted item's live step later differs from its posted `dueTime`, show the posted deadline with a small "was Mid-service" marker rather than silently moving the row.

**Mobile default.** Start in **Kitchen** when the picked cook has no home station or `myTodo` is empty, and make the hero the first row of the unified ladder rather than the earliest raw `startBy`.

**Data hygiene the model depends on** (no code, but the schedule and load strip are noise until done):

- Smoked Brisket / Smoked Pulled Pork: active ≈ 60, passive ≈ 2,820 "smoke". Crème Fraîche: active ≈ 15, passive ≈ 1,425 "set".
- Give cooks a home station, or give the items real stations. Today every item is "Prep" and every cook is unhomed, so station grouping, station assignment and the load strip have nothing to work with.

### Suggested order of work

1. `prep-plan.ts`: roll `close` with doors; add `itemDeadline` / `itemStartBy`; tests in `prep-plan.test.ts` (evening case with the live numbers above).
2. Run sheet: compute `ctx` once, derive deadline + startBy per row, unified step ladder, `listOrder` tiebreak, `PLAN_URG_META` labels. Desktop and mobile share the group builder (a pure function in `prep-plan.ts` next to `planGroups`).
3. Post route: write `dueTime`; PostedBand / RunRow show the posted deadline.
4. Mobile default mode fallback.
5. Recipe time fixes for the three long items (data).

Everything in steps 1–4 is client + pure-lib work with no schema change. `npm test` covers 1 and the group builder; the run sheet is verifiable in the preview against the live posted list.
