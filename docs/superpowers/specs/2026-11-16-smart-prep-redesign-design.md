# Smart Prep — whole list by category, honest numbers, crew, review before posting

Date: 2026-11-16 · Owner: Joshua · Status: design approved ("Lock it in")
Design board: https://claude.ai/artifact/XoEFyrr2PTyWdBX32gRpPh, page "Smart Prep" (5 boards: review, parts, computer, phone, post review)

## Problem (from the audit, worst first)

1. **Wrong pars give wrong suggestions.** Kimchi (vegan) par 5,000 kg → 376 batches. Hollandaise 4 g, Sourdough Starter (Gary) 4 g, Pickle Apples 0.002 kg (2 g). 9 items have par 0 and always read "at par".
2. **"Won't fit" on every job.** No cook has a `homeStation`, so `crewFor` finds nobody, every station has 0 minutes of hands, and every draft row says won't fit. Passed deadlines and jobs already cooking are scored too ("1668m past 15:00").
3. **Four different "needs making" counts**: phone tab badge (`spCritical + spNeeded`), desktop tab badge (`shiftSummary.critical + spNeeded`), mobile Suggestions badge, "Add all critical · N".
4. **Jobs already cooking sit in the draft as if new**: a stepper, "suggested ↺" and won't-fit on an IN_PROGRESS item.
5. The reason an item is suggested lives in a hover tooltip; warnings are bare icons.
6. Amounts are hard to read ("17055 of 2000 g"); fractional litres are rounded because the local formatters compare `'L'` while the canonical unit is `'l'`.
7. Clear and Accept-suggested act on everything with no count and no undo.
8. The post dialog does not say what changes.
9. Phone: two tabs to plan one list; 26×20 px reorder arrows; the post bar covers cards.
10. "Start today for …" / "lead time runs past the runway"; 8.5–9.5 px labels.
11. Assigning scrolls 17 names with no order.
12. +/− on quantities add a step to an odd amount (1.3 → 1.8 → 2.3) instead of landing on the grid.

## Design

### One number: "to make"
An item is **to make** when it is switched on for prep, not on the list, not cooking (`pipeline` null), has no par flag, and either has a suggestion above zero or must start today. That one count is the tab badge (computer and phone), the header ("24 more to make"), the "To make" filter chip, and "Add all N to make".

### Par flags
- **Par looks wrong**: par is more than 20 batches of the linked recipe, or a weight/volume par under 10 g / 10 ml. Today this catches exactly Kimchi, Hollandaise, Sourdough Starter, Pickle Apples (checked against the live list: the next-highest ratio is 5.7 batches).
- **No par set**: par 0 and no day target.
- A flagged item never gets a suggestion, is never counted as to make, and is never added by "Add all".
- The row shows the flag in words and a **Fix par** / **Set par** button (lead and above). It opens a small par editor (stepper in the item's unit, "was 5,000 kg", one sentence on the result) that saves through the existing recipe prep settings (`PATCH /api/recipes/[id] { prep: { parLevel } }`).

### The prep list — whole list, by category (default)
- The left pane (phone: lower section) is the **Prep list**: every prep item, grouped by recipe category (alphabetical, as today), with a **Category | Step** switch. Category is the default.
- Filter chips: **Everything** (default) · **To make** · **Par to fix** · **No par set**, each with its count. The computer view adds a row of category shortcuts ("Sauces 19") that scroll to that category.
- Inside a category: to make (by step, then the chef's order) → par flags → on your list → cooking → at par.
- **Row kinds** (reason always written on the row, never only in a tooltip):
  - to make: name, reason ("Out — 0 of 4 L · Critical"), amount in batches with the unit amount under it, a 44 px gold **+**;
  - flagged: the flag, the reason ("Par is 4 g — less than one spoon"), Fix/Set par;
  - on your list: "✓ On your list" (tap = take it off, with Undo);
  - cooking: gold row, "Cooking now", ready time, no action;
  - at par: one quiet line — name, "72 of 72 each / at par", a quiet + that still adds it.
- **Step view** keeps today's urgency groups. At-par rows fold into one line per group ("+ 19 at par · Show"). The long-lead group reads **"Start today — needed tomorrow 15:00"**.
- "Not prepped" (switched-off items) stays at the bottom, unchanged.

### Your list
- **On the go** strip on top: draft items that are cooking, read only — name and "ready 11:43" / "wait done". They never get a stepper, a reset, a won't-fit or a "to start" count. Tapping opens the drawer.
- Rows grouped **By step | By cook** (By cook replaces By station).
- **Quantities step on the grid**: + goes to the next multiple of the step, − to the one below, never under one step. Batches step by ½ (1.3 → 1½ → 2; 1.3 −→ 1 → ½). kg/L by 0.5, g/ml by 25, counts by 1 (unchanged step sizes). An amount off the grid shows in gold.
- A deadline already passed reads **Now**.
- Footer: "2 changes not posted" + the names, and **Review & post**.

### Who's on today
- A crew strip: today's cooks as chips, tick who is on (from the active cook list). Stored per kitchen per prep day so every device sees the same crew.
- **Hands until close** = cooks ticked × (close − now). **List needs** = hands-on minutes left on Your list (cooking jobs count their remaining minutes). Shown as "6 h 40 min of hands until close · list needs 4 h 10 min — fits".
- **Won't be ready** per job comes from one shared pool of the ticked cooks (stations ignored). It names the job, the deadline and the overrun in hours and minutes ("Focaccia won't be ready by 15:00 — 1 h 20 min over with 2 cooks"). Never for cooking jobs or for jobs whose deadline already passed. **No crew ticked → no won't-fit warnings at all.** The station load strip goes.
- The assign list shows today's crew first, then everyone else.

### Bulk buttons say what they do, with Undo
- **Add all N to make** (never flagged items), **Reset N quantities to suggested** (only rows that differ; hidden at 0), **Empty the list…** (asks once; jobs on the go stay).
- Each shows a toast with **Undo** for 10 seconds that puts the list back exactly as it was.

### Review before posting
- The post sheet lists **What changes**: each item added and each item taken off since the last post, then "N unchanged" and "N on the go — stay exactly as the cooks left them".
- **Before you post**: fits/won't fit with the crew (or "Tick who's on to check timing"), "N jobs have no cook — anyone can claim them", "N pars look wrong — they stay off the list until fixed".
- One sentence: quantity and note edits already reach the To Do as you make them (true today: the To Do reads the same live log).
- Button: **Post N changes** (first post: "Post N items").

### Phone
- One scroll, no tabs: header with the to-make count → crew strip → Your list (first rows, "+ N more · M on the go", **Open ▾** expands it) → filter chips + **Category ▾** → the prep list.
- 44 px targets everywhere (reorder arrows included). The post bar sits under the content: the page reserves its height so it never covers a card.

### Words and sizes
- Over 1,000 g / ml reads in kg / L ("17.1 of 2 kg"); litres print as "L"; thousands get a separator.
- Planner labels 11 px and up (no 8.5–9.5 px text).

## Decisions taken while writing this spec
- **Crew storage:** a new table `PrepCrewDay (revenueCenterId, listDate, cookIds Json)` — unique per kitchen per prep day, `listDate` from `prepDayStart()` like `PrepPost`. Json, not `text[]`, to stay clear of the pgBouncer array-write trap. **Additive migration — needs Joshua's yes before it is applied to the live database.**
- **No posted-quantity snapshot.** Quantities are live on the To Do the moment they change; the review lists adds and removals only and says so. A per-line "changed from" would need a new stored column for little gain.
- **Fix par gate:** the button shows for lead and above (same gate as the prep switch). The recipe route itself stays as it is (any signed-in user) — tightening it is a separate change.
- **Bulk writes stay per item** (no new bulk endpoint), with one error toast if any fail.
- **Category order** stays alphabetical (what `planGroups` does today), so cooks learn where things are.

## Out of scope
- Fixing the four wrong pars and nine missing pars in the data (Joshua can do it from the new Fix par button, or say yes to a one-off fix).
- Cooks' home stations; Station grouping of the prep list.
- Changing who may edit recipe prep settings server-side.
