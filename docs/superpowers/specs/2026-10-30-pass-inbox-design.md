# Pass + Inbox — design

**Date:** 2026-10-30
**Owner:** Joshua
**Status:** approved mockup, building
**Mockup:** https://claude.ai/artifact/7EsAPSNKXKGg7Z6t91Q6EC, page "Pass + Inbox". It has 7 boards: PassMobile, InboxMobile, NoticeSheet, ReportSheet, TagsEditor, PassDesktop, InboxDesktop.

## Why

A manager's alerts are scattered today:
- start-page "needs" are computed and never stored;
- cooks' checklist flags only show on the station board;
- price and invoice alerts sit behind the bell;
- Signals live on their own page;
- handover notes sit in two places;
- a cook has no way to report something that isn't a checklist job.

Nothing keeps a history of who raised an alert, who saw it, or who fixed it. Shift leads see none of it.

## Decisions (Joshua, 2026-10-30)

1. **One Inbox** of everything that needs a manager.
   - **Severity:** NOW (before doors / urgent), TODAY, or FYI.
   - **Tag:** each item has one tag.
   - **Status:** Open, Snoozed, Waiting on someone, or Done.
   - **History:** each item keeps who raised it, who saw it, notes, and who fixed it.
2. **Tags.** Managers can add their own tags.
   - **Built in:** Food safety, Checklists, Prep, Stock, Money, Team. These can be renamed and recoloured but never deleted, because the app files its own alerts there.
   - **Starter custom tags:** Maintenance, Events, Other.
   - **Flag routing:** managers choose which tag each checklist flag reason lands in.
3. **Who sees it.** The Inbox is for LEAD and above. Money items stay MANAGER+.
4. **No push notifications.** The in-app bell with a count is enough for now.
5. **Cooks can "Report something":** pick a tag (one marked cooks-can-pick), write a note, choose where, and switch on urgent. **Photos come later.**

## Model

**`InboxTag`**
- Fields:
  - `builtIn` (`FOOD_SAFETY | CHECKLISTS | PREP | STOCK | MONEY | TEAM`, unique, or null for custom)
  - `name`, `color` (one of the 8 palette hexes)
  - `cookCanPick`, `managerOnly`
  - `sortOrder`, `isActive`
- Seeds use deterministic ids, `tag-<key>`.
- Money is `managerOnly`.
- Built-in tags have `cookCanPick=false` except Food safety, Stock and Prep.

**`InboxFlagRoute`**
- Fields: `reason` (the `ChecklistFlagReason` enum, primary key) and `tagId`.
- Seeds: BROKEN → Maintenance, RAN_OUT → Stock, OTHER → Other.
- OUT_OF_RANGE always goes to Food safety and is not editable.

**`InboxItem`**
- Fields:
  - `revenueCenterId` (null means every RC)
  - `tagId`
  - `severity` (`NOW | TODAY | FYI`)
  - `title`, `body?`, `place?`, `href?`
  - `source` (`REPORT | FLAG | SYSTEM`)
  - `sourceKey` (unique; null for reports)
  - `managerOnly`
  - `status` (`OPEN | SNOOZED | WAITING | DONE`), `snoozeUntil?`
  - `raisedById?`, `raisedByName?`
  - `doneById?`, `doneByName?`, `doneAt?`
  - `clearedAt?` (when a system condition went away by itself)
  - timestamps
- Indexes: `(status, revenueCenterId)` and `(tagId)`.

**`InboxEvent`**
- Fields: `itemId` (Cascade), `kind`, `byId?`, `byName?`, `note?`, `at`.
- `kind` is one of `RAISED | SEEN | NOTE | SNOOZED | WAITING | REOPENED | DONE | CLEARED | RETAGGED`.
- **Unread** means the current user has no SEEN event on the item. The first open of an item writes SEEN.

**`InboxSync`**
- Fields: `revenueCenterId` (primary key) and `at`.
- Throttles system sync to once per 60 s per RC.

Person ids are plain strings, the same as the checklists. Hard-deleting a user must not erase history.

## Where items come from

| Source | sourceKey | Tag | Severity | Clears itself when | "Done" also |
|---|---|---|---|---|---|
| Cook report | none | chosen | NOW if urgent, else TODAY | never | none |
| Checklist flag | `flag:<lineId>` | route by reason; OUT_OF_RANGE → Food safety | NOW if the line is a blocker, else TODAY | the line is un-flagged or re-answered in range | resolves the line (same as the board's Mark fixed) |
| Temp latest reading out of range | `temp-bad:<unitId>:<date>` | Food safety | NOW | a later in-range reading | none |
| Cold units not logged today | `temp-missing:<rcId>:<date>` | Food safety | NOW | all logged | none |
| Station not started (OPEN phase, has jobs today, no run) | `station-open:<stationId>:<date>` | Checklists | NOW | a run exists | none |
| Closing list left unsigned | `close-unsigned:<runId>` | Checklists | TODAY | signed | none |
| Critical prep, unattended | `prep:<prepItemId>:<date>` | Prep | NOW | assigned, in progress or done | none |
| Price rise | `price:<priceAlertId>` | Money | TODAY | acknowledged elsewhere | acknowledges the PriceAlert |
| Invoices awaiting approval | `invoices:<rcId>` | Money | TODAY | none awaiting | none |
| Count older than 4 days | `count-stale:<rcId>` | Stock | FYI | a new count | none |
| Phone waiting for an OK | `phone:<pinDeviceId>` (managerOnly) | Team | TODAY | approved, rejected or stale | none |

**System reconcile** is a pure function, `reconcile(existing | null, conditionNow: boolean)`:
- Condition present, no item → create it OPEN and write a RAISED event.
- Condition gone, item OPEN, SNOOZED or WAITING → set status DONE and `clearedAt`, and write a CLEARED event ("Cleared itself").
- Condition present, item DONE with `clearedAt` set → reopen it and write a REOPENED event.
- Condition present, item DONE by a person → leave it alone. Daily keys bring it back the next day.

**Snoozed** items reopen when `snoozeUntil` passes. "Snooze till tomorrow" means 05:00 Pacific the next day.

**Signals are out of scope** here. They keep their own page. A later step can feed them in as Money/Stock FYI items.

## Screens

### `/inbox` (LEAD+), mobile and desktop

This follows InboxMobile and InboxDesktop.
- **Tabs:** Open (count) / Done.
- **Tag chips with counts:** on the phone they scroll sideways; on desktop they are a filter column that also filters by Status, Where and From.
- **Groups:** NOW · BEFORE DOORS / TODAY / FOR YOUR INFO.
- **Unread:** a gold dot.
- **Item sheet or pane** (NoticeSheet) shows:
  - the tag pill, with retag for LEAD+
  - severity and the body
  - the "What happened" timeline
  - a note box
  - Snooze till tomorrow / Waiting on someone / Mark fixed / Reopen
- **Links:**
  - "Manage tags →" (MANAGER)
  - each system item's own "Go to" link (`href`)

### `/inbox/tags` (MANAGER)

This follows TagsEditor.
- **Your tags:** add, rename, recolour, set cooks-can-pick, archive.
- **Built in:** rename and recolour only.
- **Where cooks' flags land:** one select per reason.

### Report something (any signed-in cook)

This follows ReportSheet. It is reachable from:
- the cook screen header ("Report")
- the cook start page
- `/inbox` for LEAD+

The cook sees their own reports and whether each is fixed. On the cook start page this is a "Your reports" line, and the bell for STAFF shows their own reports.

### Bell (mobile top bar + desktop chrome)

- **LEAD+:**
  - The badge counts OPEN NOW + TODAY items they can see.
  - The dropdown shows the top 5 and an "Open Inbox" link.
  - The price-alert list moves into the Inbox as Money items.
- **STAFF:**
  - The badge counts their own reports fixed since they last looked.
  - The dropdown lists their reports.

### Pass

This follows PassMobile and PassDesktop.
- **Who sees which version:**
  - `/pass` desktop: MANAGER.
  - `/today` phone: MANAGER and LEAD. A LEAD gets the same Pass minus money.
  - LEAD on desktop also gets this layout on `/today`, in a fluid column.
- **Sections, in order:**
  1. Greeting and lede ("Doors in 1h 08m. 3 things need you before then").
  2. **Needs you first:** the top Inbox items, NOW then TODAY, up to 6 on desktop and 3 on the phone, plus "N more in the Inbox".
  3. **Stations strip:** the current phase, from `/api/checklists/today`.
  4. **Service and prep band:** as today.
  5. **From last night:** the whole-kitchen EOD note (MANAGER) plus every station's CLOSE handover note from last night (LEAD+). The station notes come from a new endpoint.
  6. **Numbers** (MANAGER): sales, food cost, running low.
- **Desktop right rail:** "Inbox by tag", with counts and NOW markers.

## Not in this build

- Photos on reports.
- Push notifications.
- Feeding Signals in.
- Assigning an item to a person.
- Per-tag notification settings.
