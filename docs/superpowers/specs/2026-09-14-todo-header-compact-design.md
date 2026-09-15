# Prep — the To Do header gets out of the way

**Date:** 2026-09-14
**Surfaces:** `/prep` To Do tab — desktop run sheet (`RunSheet`) and mobile run sheet (`RunSheetMobile`), plus the page-level chrome the prep page paints above them
**Status:** design agreed, ready to build. Decisions recorded in §0.

On desktop the To Do stacks five rows of chrome before the first job: the
black posted band, the ordering sentence with the Kitchen / My station toggle,
the status card (done count, progress bar, in-progress / late / low-on-stock
counts, clock), a card per cook, and the station chips with the Steps /
Station toggle. That is roughly 700 px on a 1010 px-wide sheet. Mobile stacks
its own version: the shift band, the posted band, and the run sheet's NOW
line. The chef's verdict: it steals the screen and none of it is as useful as
the ladder underneath. This spec collapses it to one control row and a
hairline, and moves every number that still matters into the section header
that already owns it.

---

## 0 · Decisions (already made)

| Question | Decision |
|---|---|
| Crew status | **Only who is busy right now**, and that is already the **Working On** section: its rows carry the assignee chip and the elapsed timer. The crew cards (`CrewStrip`) go. Idle cooks, queued counts, per-cook hands-on load and per-cook late counts are not shown anywhere on the To Do. |
| Progress band | **No status line at all** (option C of three). The done count becomes part of a small caption in the control row; the bar becomes a 3 px hairline at the top of the sheet; the clock joins the caption. |
| Posted band, ordering sentence, toggle rows | **One control row.** Left: the caption (done count, posted time, poster, item count, clock, service caption, dirty flag). Right: Kitchen / My station, the station chips (or the cook picker in My station mode), Steps / Station. The ordering sentence is deleted; the section headers explain the order. |
| Where the counts go | **Into the sections.** Late to start already has its own header and count. "Low on stock" is added to each step header's caption. "Ready to move" already lives in the Waiting header. "In progress" is the Working On count. No new section is added — the ladder stays ONE step-derived order and a blocked job stays in its step. |
| Mobile | **Same treatment.** The shift band and the posted band are removed; the run sheet's existing NOW caption line carries the done count and posted time; the same hairline bar sits above it. `PrepShiftBand` is deleted (the To Do is its only consumer). |
| Data / API | **Unchanged.** Every number shown is already computed in the run sheets from props they already receive. No route, schema, or lib change. |

---

## 1 · Desktop (`RunSheet`)

Top to bottom, replacing everything above the first section:

**1.1 The hairline.** A 3 px bar, full sheet width, rounded ends, painted as
the very first child of the sheet. Green (`bg-green`) for the done share,
gold (`bg-gold`) for the in-progress share, `bg-bg-2` track. Same maths as
the old status card (`donePct`, `doingPct` over `items.length`), same
segment gap. Nothing else about it: no card, no label.

**1.2 The control row.** One flex row, `items-center`, `justify-between`,
`gap-4`, `mb-3.5`, wrapping on iPad (`flex-wrap`).

Left — the caption, one mono line, `text-[10.5px] text-ink-3`, `min-w-0
truncate`, parts joined by ` · `:

1. `6/19 done` — done count in `text-ink font-semibold`, total after the slash in `text-ink-4`.
2. `Posted 8:17 PM · Joshua · 14 items` — only when `post` is present. The time uses the same `whenLabel` rule the posted band used (bare time today, `yesterday`, or `Sep 12` for older), so a carried-over list still says which day it was posted. The name is `post.postedByName` as the API returns it. The hands-on total the old band showed is dropped; the step headers carry hands-on per step.
3. A green check glyph before "Posted" is kept as the one visual cue that the list is live; no black bar.
4. The clock `20:40` in `text-ink font-semibold`, followed by the service caption (`svcCaption`) when there is one, exactly as the status card showed it.
5. When `post.dirty`, the existing "Chef has unposted changes" gold pill, unchanged, after the caption.

Right — the controls, `flex items-center gap-2 flex-wrap shrink-0`:

1. The Kitchen / My station `Segmented`, with the not-done badge on Kitchen, as today.
2. In kitchen mode: the station chips (`all` + every station), as today. In My station mode: the cook picker chips, as today, without the `COOK` label (the segmented already says whose view this is).
3. The Steps / Station `Segmented`, as today.

The `RunSheet` props do not change except for one addition: `post:
PrepPostInfo | null`, so the sheet can paint the caption itself. The page
stops rendering `PostedBand` above the sheet.

**1.3 Removed.** `PostedBand` (desktop use), the ordering sentence, the
status card, `CrewStrip`. `CrewStrip.tsx` and `PostedBand.tsx` are deleted.
The `whenLabel` helper moves out of `PostedBand.tsx` into
`src/lib/prep-runsheet.ts` so both run sheets share it.

Everything from the first section header down is untouched: Waiting,
Working On, Late to start, the NOW divider, the four steps, Done.

---

## 2 · Counts in the sections

| Old status-card number | Where it lives now |
|---|---|
| `N in progress` | The **Working On** header count (already there). |
| `N late to start` | The **Late to start** header count (already there). In station grouping, each station header's `N late to start` caption (already there). |
| `N ready to move` | The **Waiting** header caption (already there on both sheets). |
| `N low on stock` | **New:** each step header's caption gains `N low on stock` when N > 0, joined with ` · ` after the hands-on total. N counts the rows in that step with `isBlocked || blockedReason`, the same test the card used. In station grouping, each station header gains the same. |
| `done / total` | The control-row caption (§1.2) and the hairline (§1.1). The collapsed **Done** section header already shows the done count. |

The Kitchen badge on the segmented (not-done count) is unchanged.

---

## 3 · Mobile (`RunSheetMobile` + the prep page)

**3.1 The page** stops painting `PrepShiftBand` and `PostedBand` in the
mobile To Do block. The stock-changed `PrepAlertBanner` stays where it is,
now directly under the tab bar.

**3.2 The run sheet** gains the same 3 px hairline as its first child, and
its existing caption line (`NOW 20:40 · <service> · N ready to move`)
becomes:

`6/19 DONE · NOW 20:40 · <service> · POSTED 8:17 PM · N ready to move`

Same mono uppercase style it has today. `6/19` uses the same weights as
desktop. The posted part appears only when `post` is present and uses
`whenLabel`, so it reads `POSTED 8:17 PM YESTERDAY` on a carried list. When
`post.dirty`, the gold "Chef has unposted changes" pill renders on its own
line under the caption (the phone caption has no room for it inline).

`RunSheetMobile` gains the same `post` prop.

**3.3 Removed.** `PrepShiftBand.tsx` is deleted. `computeShiftSummary` in
`prep-utils.ts` stays: the tab badges (`shiftSummary.total − resolved`,
`shiftSummary.critical`) still read it, and it is covered by
`prep-plan-pipeline.test.ts`. `countdown` stays on the page for `PrepDrawer`.
`workloadLabel` has no reader once the band goes, so it and the
`computeWorkloadMinutes` import are removed from the page (the lib function
itself stays).

---

## 4 · What the chef sees

Desktop, kitchen mode, a posted list with two jobs in flight:

```
▬▬▬▬▬▬▬▬▬▬▬▬░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
6/19 done · ✓ Posted 8:17 PM · Joshua · 14 items · 20:40     [Kitchen 13|My station] [All·12][Prep] [Steps|Station]

● WAITING · 1   resting
  …
● WORKING ON · 2   parallel timers — mark done to log yield
  Sourdough Bread   JB · 12m …
● LATE TO START · 2   won't make its step unless started now
  …
─ NOW · 20:40 ────────────────────────────────────────────────
● BEFORE CLOSE · 4   by 22:00 · 3h10 hands-on · 2 low on stock
  …
```

Roughly 45 px of chrome before the first section, down from about 700.

---

## 5 · Edge cases

- **No post** (the list was never posted, or the RC has no live post): the caption is `6/19 done · 20:40`. The run sheet only renders when there are posted items, so this is rare but must not crash.
- **Nobody working**: the Working On section is absent, as today. There is no idle-crew display to replace it.
- **No cooks**: My station mode shows an empty picker, as today.
- **iPad (md..lg)**: the control row wraps; the caption keeps the first line, the controls take the second. The caption truncates rather than wrapping.
- **Long poster name / email**: truncated by the caption's `truncate`.
- **Zero items**: `0/0 done`, hairline empty. Not reachable through the page (empty-state card renders instead) but the sheet must tolerate it.

---

## 6 · Files

| File | Change |
|---|---|
| `src/components/prep/runsheet/RunSheet.tsx` | Replace the header stack with the hairline + control row; add `post` prop; add the low-on-stock caption to step and station headers. |
| `src/components/prep/runsheet/RunSheetMobile.tsx` | Add the hairline; extend the caption line; add `post` prop and the dirty pill. |
| `src/lib/prep-runsheet.ts` | Add `postedWhenLabel(postedAt, listDate)` (moved from `PostedBand.tsx`). |
| `src/components/prep/runsheet/PostedBand.tsx` | Delete. |
| `src/components/prep/runsheet/CrewStrip.tsx` | Delete. |
| `src/components/prep/PrepShiftBand.tsx` | Delete. |
| `src/app/prep/page.tsx` | Stop rendering `PostedBand` (both blocks) and `PrepShiftBand`; pass `post={plan.post}` to both run sheets; drop `workloadLabel` and the dead imports. |
| `CLAUDE.md` | The run sheet line no longer lists `PostedBand`. |

---

## 7 · Verification

- `npm run lint` on the touched files; `npm run build` of the commit in an isolated worktree (the main checkout's build is unreliable while the dev server runs).
- `npm test` still passes (`computeShiftSummary` keeps its test).
- Browser, dev server, KITCHEN revenue center with its posted list: desktop at full width, iPad width (768–1024), and phone width. Check: hairline present and proportioned; caption text; Kitchen ↔ My station switch keeps the cook picker inline; Steps ↔ Station grouping; a step header showing `N low on stock`; no console errors; no `/api/prep/tasks`-style dead fetches.
- Dirty-post pill: verified by opening Smart Prep, changing a draft quantity without posting, and returning to the To Do.
