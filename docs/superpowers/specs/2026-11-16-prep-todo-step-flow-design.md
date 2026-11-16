# Prep To Do — step-by-step flow, one "On the go" lane, wait alarms

Date: 2026-11-16 · Owner: Joshua · Status: design approved ("the plan looks good")
Design board: https://claude.ai/artifact/XoEFyrr2PTyWdBX32gRpPh (6 boards; board 6 is a clickable phone prototype)

## Problem (from the audit, worst first)

1. A started job jumps between **Working On** and **Waiting** on every wait. Sourdough Bread (15 steps, 10 waits) changes section 20 times.
2. The **Next** button does not say what comes next (phone: a bare arrow; desktop: a block name, no hint of work vs wait).
3. **Nothing announces a finished wait** — the row quietly turns green.
4. **No Back.** And Stop → Start restarts the job at step 1 (Stop clears `stageIndex`; Start resumes `existing.stageIndex ?? 0`) while the ticks still say step 9.
5. **Next jumps a whole block** of steps (the derived chain), not one method step. Recipes with an untimed method get no step guidance at all.
6. The drawer opens on scale / cost / ingredients; the method is far below.
7. Ticking the last step of a block silently advances the job (`tickMethodStep`); unticking does not go back.
8. A finished wait in the drawer has no button to move on.
9. Stop sits beside Next on the phone, same size.
10. "My station" opens on `cooks[0]`, not the person holding the device.
11. On-the-go jobs are unordered; the hairline ignores resting jobs; the phone caption packs 5 facts in one all-caps line.

## Design

**The cursor is a method step, not a chain block.** A recipe's method flattens into a *cook sequence*: each method step is a STEP item, and a step's wait is a WAIT item right after it. The job's position is one item of that sequence (`PrepLog.stepKey`, with `stepEnteredAt` for its own clock). The existing chain/stage machinery stays and is kept in sync (each item maps to the chain block it belongs to), so ladder timing, rest info, pipeline and the start page keep working unchanged.

**One lane.** Every started job sits in **On the go** until it is done. Order: wait finished (ready) → hands-on → waiting (soonest ready first).

**The job card** shows: a clock (hands-on: elapsed of the step's minutes; waiting: time left + ready-at; ready: READY since hh:mm), the item, the current step's instruction, a **step track** (square = hands-on, dashed capsule = wait, capsule length grows with the wait; done = green, current = ringed, ready wait = solid green), and **one Next button** whose look says what comes next:

| Next is… | Button | Label |
|---|---|---|
| more hands-on | solid ink, gold square | `Next step` (same phase) / `Next: <phase>` · sub `Hands-on · 5m` |
| a wait | white, dashed blue border, capsule glyph | `Start wait: <phase>` · sub `4h` |
| (in a wait, timer running) | grey | `Resting · 2h 41m left` · sub `Ready early? Open to move on` |
| (in a wait, timer out) | solid green | `Next: <phase>` · sub `Hands-on · 5m` |
| nothing — last step | ink, green dot | `Log yield` · sub `<qty> planned` |

Stop, hand-over and mute move into a **⋯ menu**. **Stop keeps the place**: Start carries on from the same step.

**Alarm when a wait ends:** a green banner on top of the To Do (one per job, oldest first, with its Next button), one short chime, a buzz on phones that support it, repeated every 5 min until the job moves on. Mute per device. Browser notification when the tab is hidden and permission was given. *Notifications with the app fully closed (iPhone) are a follow-up, not this build.*

**Drawer = cook mode** while a job is on the go: step track, the current step large, an "Up next" box (dashed blue when it is a wait), and a footer with **← Back** and the same Next button. Ingredients, batch & cost, stock fold away below. Ticks are only ticks — moving the job is always Back/Next. (The board's "tap any step to jump" is left out of this build.)

**Tidy:** My station remembers the last cook picked on that device; the hairline counts every started job (gold hands-on, blue waiting); the phone caption becomes two lines.
