# Station checklists — rulings made during the build

Decisions taken on Joshua's behalf while building (from the build ledger), with what each costs if wrong.

- | T2 → T10 | shiftBusinessDate | EOD close date (businessDateLocal) ≠ CLOSE run date after midnight → Ruling R2 |
- | T4 self | test text mixes "upsert returns old createdAt" and "findUnique first" | Ruling R3 |
- | T5 self | signoff message "1 before-doors jobs left" vs singular rule | Ruling R1 |
- | T1 self | step 4 applies to the live DB | Ruling R4 |
- ## Rulings
- Ruling R1: Sign-off 409 copy uses the singular for N=1 ('1 before-doors job left' / '1 job left before you leave') and the plural otherwise; tests assert the singular case — the plan text contradicted itself — cost if wrong: one string.
- Ruling R2: The EOD gate (T10) reads CLOSE runs at shiftBusinessDate('CLOSE'), not at the EodClose row's businessDateLocal() date; the EodClose date logic is left unchanged — an after-midnight close must still see last night's station runs — cost if wrong: an EOD close made after midnight is filed under the new day (as today) while gating on last night's runs.
- Ruling R3: ensureRun detects an existing run with findUnique first and returns it; the test mocks findUnique → row and asserts no category read and no createMany — matches the plan's own "Detect existing by findUnique" sentence — cost if wrong: none (behaviour identical).
- Ruling R4: The Task 1 implementer generates the SQL and builds but does NOT apply it; the controller reads the SQL and applies + resolves it (Joshua's yes is on record) — a live-DB write belongs with the controller — cost if wrong: a few minutes.
- Ruling R5: defaultPhase returns CLOSE before 05:00 Pacific as well as from 14:00 (spec said only "OPEN before 14:00") — a cook closing at 00:30 must land on Closing, which matches the 5h close shift — cost if wrong: an early-morning opener (before 05:00) lands on Closing and taps Opening.
- Ruling R6: add a nullable ChecklistRunLine.tempReadingId (an additive column on our new, still-empty table; the controller applies it under Joshua's "new empty tables" yes) and update/delete the linked reading on re-answer/untick — the Temps log is a food-safety record — cost if wrong: one extra column.
- Ruling R7: guarded writes (sign-off updateMany status OPEN; line write only while the run is OPEN) to close the sign-off/tick race — cheap — cost if wrong: none.
- Ruling R8: in the cook UI, a NUMBER/TEMP line that already holds a reading offers "change reading" but not the manual flag chips; to flag it, the cook unticks first — a manual flag deletes the logged reading (R6), so hiding it protects real Temps-log entries — cost if wrong: one extra tap to flag a logged line.
- Ruling R9: a ± toggle beside the unit on number entry (keep inputMode decimal) — the iPhone decimal pad has no minus and freezer readings are negative — cost if wrong: one extra button.
- Ruling R10: the lede and section header count whole-kitchen blockers; when a shared blocker is open the footer says "N of yours left" (its own run's blockers) — the two counts must not seem to disagree — cost if wrong: copy only.
- Ruling R11: the Today board's "History →" link shows only for MANAGER+ (handled in Task 8) — history is MANAGER-gated, so a LEAD would hit no-access — cost if wrong: a LEAD can't find history (they aren't allowed it anyway).
- Ruling R12: the EOD gate leaves out CLOSE runs with zero lines, and runs with zero crew and no handled line (abandoned picks) — otherwise a mis-pick locks "Close the day" for the night — cost if wrong: a station that was opened but never actually started doesn't block the close.
- Ruling R15: when a shared Whole-kitchen CLOSE run exists, its blockers must be handled for the EOD gate — the old EOD blockers (gas off etc.) moved there and would otherwise stop gating — cost if wrong: a Lead must handle the whole-kitchen blockers before closing (the old behaviour).
- Ruling R13: the cook start card's "done" = every one of the cook's runs SIGNED; whole-kitchen non-blockers don't hold it open — cost if wrong: copy/state only.
- Ruling R14: the cook screen gets a "Station board →" link for LEAD+ — managers land on /checklist from the nav with no way to the board — cost if wrong: one link.

## Deferred minors (reviewed: none block merge)

- Task 1: minor (deferred): no index on ChecklistRunLine.itemId / ChecklistItem.tempUnitId (SetNull scans); redundant @@index([runId]); RC FK is RESTRICT, so deactivate, never delete; nullable itemId makes the unique key moot after a hard delete.
- Task 3: minor (deferred): seed.ts:170 seeds when the RC doesn't exist (`rc && …`); should return early on a null rc. A blank old section becomes an empty category name. Hard deletes + deterministic ids could resurrect rows in a ms race (we only soft-delete).
- Task 4: minor (deferred): `created: true` also goes to the race loser; instanceof vs a duck-typed P2002.
- Task 4: minor (deferred): template read outside the tx, so an ON CONFLICT loser could add a line edited in the ms window; whitespace-only latest handover masks an older note.
- Task 5: minor (deferred): unscoped STAFF users (no UserScope rows) can use every RC (app-wide policy); any in-scope cook can sign off a station they're not crew on; pick isn't atomic; pick allows joining a SIGNED run (the UI should show it as signed); flag note >300 and handover >1000 return 400 rather than capping (the UI needs maxLength).
- Task 5: minor (deferred): the guarded writes narrow but don't fully close the sign-off/untick race (would need a row lock); a re-answer after a TempUnit is deleted → FK 500; a deleted line mid-request reports 'Signed off'.
- Task 6: minor (deferred): sheets have no focus trap/restore or scroll lock; a failed poll is silent when stale; no progressbar role; the picker doesn't mark SIGNED stations (needs an API field); Reopen uses the global role, not per-RC clearance; the day pill was dropped from cook rows.
- Task 6: minor (deferred): ± button steals focus (add preventDefault on mousedown); the ± aria-label is dynamic; the manual "Pick your station" button can open before /prep/me settles; reopen doesn't reload on 409.
- Task 7: minor (deferred): no minusDays boundary tests; untested bad-phase fallback; flag window anchored to the phase date; flags query has no take cap; poll failure silent with stale data; 409 on Mark fixed shows a red toast; dead toUpperCase.
- Task 8: minor (deferred): `latest` frozen at mount on the history page; no index on ChecklistRunLine.itemId (/last lookup; needs a migration); date-format helpers copied across 3 pages; stale in-flight load on RC switch.
- Task 8: minor (deferred): CSV guard doesn't cover leading tab/CR; lastTimeLabel shows a weekday for future-skewed times.
- Task 9: minor (deferred, recommend fixing before merge): " (copy)" names can exceed 40 and become unsaveable, and a double copy duplicates "X (copy)"; 403 scope tests exist only for station POST — add a 403 case per route.
- Task 9: minor (deferred): out-of-order reorder replies (queue them); reorder accepts partial sibling lists; no server cap on unit length; sheet shell / save logic / range formatters duplicated across 3 sheets; item POST validates the body before the parent lookup (400 vs 404).
- Task 10: minor (deferred): /api/eod/close* has no RC scope check (predates this work); with no station started, only temps (and shared blockers) gate the EOD close (spec-sanctioned; tell Joshua).
- Task 10: minor (deferred, recommend fixing in the final wave): EOD refreshGate after midnight mixes dates (skip the temps reload/tick when the close id changed); refreshGate doesn't clear a stale signoffError.
- Task 10: minor (deferred): a reopen elsewhere isn't seen once CLOSED; the EOD station list shows abandoned runs the gate ignores; cook card "5 of 5 · 1 left"; /checklist header may overflow at 320–360 px for LEAD+; EOD email/snapshot checklist counts now include shared blockers; R15 only applies if a cook opened the closing screen (no shared run otherwise); a station can be signed with every non-blocker TODO.
