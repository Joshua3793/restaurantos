# Resting Row + One Method Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A resting job's To Do row leads with the item and the stage it is IN (next step as the subtitle), and the item drawer shows the stage chain once, inside the Method list, with Back / Next at its foot.

**Architecture:** Presentation-only. One tiny lib helper (`restPhaseName`) with tests; three run-sheet row components re-ordered; the shared `PrepRecipeSection` gains a stage-aware title, a lit live-wait card, and the Back / Next action row that used to live in `StageList`; both drawers drop their Stages block and `StageList.tsx` is deleted. No API, schema, or maths change.

**Tech Stack:** Next.js 14 App Router, React client components, Tailwind flat tokens, vitest.

Spec: `docs/superpowers/specs/2026-09-14-rest-row-and-method-merge-design.md`.

## Global Constraints

- Tailwind **flat tokens only** (`bg-blue-soft`, `text-blue-text`, `bg-green-soft`, `text-green-text`, `text-green`, `bg-ink`, `text-gold`, `text-ink`, `text-ink-2/3/4`, `bg-bg-2`, `border-line`). Numbered colour classes are broken in this repo.
- Sub-components at **module scope** only.
- The resting row's big line is `{item.name} · {restPhaseName(rest.stage)}`; the description line is note-first then clock; the subtitle is `Next: <next stage name> · <minutes> hands-on` (desktop / hero) or `Next: <name> · <minutes>` (phone).
- The drawer keeps its header chip (`CURING · WAIT · 2/7`) in both frames; only the Stages LIST goes.
- Nothing advances on its own: Back / Next and the last-step tick call `onStage` exactly as today.
- `npm run build` in the main checkout is unreliable while the dev server runs: verify a **commit** in a detached worktree (Task 4).
- Branch `feat/rest-row-and-method-merge` (already created; the spec is its first commit).

---

### Task 1: `restPhaseName` in `prep-stages.ts`

**Files:**
- Modify: `src/lib/prep-stages.ts` (add after `stageLabel`, ~line 198)
- Test: `src/lib/__tests__/prep-stages.test.ts` (import list at lines 2–6; append a `describe`)

**Interfaces:**
- Produces: `restPhaseName(stage: RecipeStage): string` — `'Curing · wait' → 'Curing'`, `'Wait' → 'Wait'`, an ACTIVE name unchanged. Task 2 imports it in three row files.

- [ ] **Step 1: Write the failing test**

Add `restPhaseName` to the import list in `src/lib/__tests__/prep-stages.test.ts` (the `{ parseStages, … }` block), then append:

```ts
describe('restPhaseName: the phase a resting stage belongs to', () => {
  it('strips the derived " · wait" suffix', () => {
    expect(restPhaseName({ key: 'c:wait', name: 'Curing · wait', kind: 'PASSIVE', minutes: 1440 })).toBe('Curing')
  })
  it('a wait with no phase stays "Wait"', () => {
    expect(restPhaseName({ key: 'w', name: 'Wait', kind: 'PASSIVE', minutes: 60 })).toBe('Wait')
  })
  it('an active stage name is unchanged', () => {
    expect(restPhaseName({ key: 'mix', name: 'Mix', kind: 'ACTIVE', minutes: 30 })).toBe('Mix')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/prep-stages.test.ts`
Expected: FAIL — `restPhaseName` is not exported from `../prep-stages`.

- [ ] **Step 3: Implement it**

In `src/lib/prep-stages.ts`, directly after the `stageLabel` function:

```ts
/** The phase a resting stage belongs to, for the row's big line: methodToChain
 *  names a wait `${phase} · wait`; the hourglass already says "wait", so the
 *  row shows `Cured Salmon · Curing`. A phase-less wait stays "Wait". */
export function restPhaseName(stage: RecipeStage): string {
  const suffix = ' · wait'
  return stage.name.endsWith(suffix) ? stage.name.slice(0, -suffix.length) : stage.name
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/prep-stages.test.ts`
Expected: PASS, 3 new tests green, nothing else changed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prep-stages.ts src/lib/__tests__/prep-stages.test.ts
git commit -m "feat(prep): restPhaseName — the phase a resting stage belongs to

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The resting row leads with item · stage (desktop, phone, hero)

**Files:**
- Modify: `src/components/prep/runsheet/RestRow.tsx` (import line 21; the `{/* task — … */}` block, lines ~77–101)
- Modify: `src/components/prep/runsheet/RestRowMobile.tsx` (import line 12; `metaText` lines ~50–55; the task `<div>` lines ~70–88)
- Modify: `src/components/prep/runsheet/NextUpHero.tsx` (import line 10; `RestHero` lines ~46–53 and the `Recipe · stages` button ~line 70)

**Interfaces:**
- Consumes: `restPhaseName` (Task 1); `PrepItemRich.rest` = `{ index, total, stage: RecipeStage, state, readyAtMin, next: { index, stage } | null }`; `fmtMins` from `@/lib/prep-runsheet`.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Desktop `RestRow`**

Change the import
```ts
import { stageLabel } from '@/lib/prep-stages'
```
to
```ts
import { stageLabel, restPhaseName } from '@/lib/prep-stages'
```

Replace the whole `{/* task — "Bake · Sourdough": the next hands-on stage, then the item */}` block (from that comment through its closing `</div>` just before `{/* assignee · recipe · next */}`) with:

```tsx
        {/* task — "Cured Salmon · Curing": the item, then the stage it is IN.
            Under it the stage's note and clock, then the next step as a subtitle. */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-[22px] h-[22px] rounded-[7px] bg-blue-soft grid place-items-center shrink-0">
              <Hourglass size={12} className="text-blue-text" />
            </span>
            <span
              onClick={() => onOpenRecipe(item)}
              title="Open recipe"
              className={`text-[14px] font-semibold tracking-[-0.015em] break-words cursor-pointer underline decoration-line-2 underline-offset-[3px] ${
                rest.state === 'resting' ? 'text-ink-2' : 'text-ink'
              }`}
            >
              {item.name} · {restPhaseName(rest.stage)}
            </span>
          </div>
          <div className="flex items-center gap-x-3.5 gap-y-1 flex-wrap mt-1">
            <span className="font-mono text-[10px] text-ink-3">
              {rest.stage.note ? `${rest.stage.note} · ` : ''}
              {rest.state === 'resting'
                ? `resting ${fmtMins(elapsed)} of ${fmtMins(rest.stage.minutes)}`
                : `rested ${fmtMins(elapsed)}`}
            </span>
            <StageChip label={stageLabel(rest.index, rest.total, rest.stage)} passive />
            {item.station && <StationTag>{item.station}</StationTag>}
            <DeadlineChip item={item} />
          </div>
          {rest.next && (
            <div className="font-mono text-[10px] text-ink-4 mt-1 truncate">
              Next: {nextName} · {fmtMins(rest.next.stage.minutes)} hands-on
            </div>
          )}
        </div>
```

Update the file's header comment: the line `"Next: Bake" and the cook taps it.` stays true; add after it: `The row leads with the item and the stage it is IN; the next step is the subtitle and the button.`

- [ ] **Step 2: Phone `RestRowMobile`**

Change the import
```ts
import { stageLabel } from '@/lib/prep-stages'
```
to
```ts
import { stageLabel, restPhaseName } from '@/lib/prep-stages'
```

Replace the `metaText` definition with note-first order:

```ts
  const metaText = [
    rest.stage.note ?? null,
    rest.state === 'resting' ? `resting ${fmtMins(elapsed)} of ${fmtMins(rest.stage.minutes)}` : `rested ${fmtMins(elapsed)}`,
    kitchen && item.station ? item.station : null,
    dl != null ? `by ${fmtDeadline(dl, fmtClock)}` : null,
  ].filter(Boolean).join(' · ')
```

In the task `<div onClick={() => onOpenRecipe(item)} …>`, change the big line
```tsx
              {nextName} · {item.name}
```
to
```tsx
              {item.name} · {restPhaseName(rest.stage)}
```
and after the meta `<div className="flex items-center gap-2 flex-wrap font-mono text-[9.5px] …">…</div>` add:

```tsx
          {rest.next && (
            <div className="font-mono text-[9.5px] text-ink-4 mt-[3px] truncate">
              Next: {nextName} · {fmtMins(rest.next.stage.minutes)}
            </div>
          )}
```

Update the header comment's `task (next stage · name, one meta line)` to `task (name · stage, meta line, Next subtitle)`.

- [ ] **Step 3: Hero `NextUpHero` (`RestHero`)**

Change the import
```ts
import { stageLabel } from '@/lib/prep-stages'
```
to
```ts
import { stageLabel, restPhaseName } from '@/lib/prep-stages'
```

In `RestHero`, change
```tsx
          <span className="block text-[17px] font-semibold tracking-[-0.02em] break-words">{nextName} · {item.name}</span>
```
to
```tsx
          <span className="block text-[17px] font-semibold tracking-[-0.02em] break-words">{item.name} · {restPhaseName(rest.stage)}</span>
```

Replace the meta line
```tsx
      <div className="font-mono text-[10.5px] text-[#a1a1aa] mt-[9px] leading-[1.5] flex items-center gap-1.5 flex-wrap">
        <Hourglass size={11} className="text-[#a1a1aa]" />
        {stageLabel(rest.index, rest.total, rest.stage)} · {rest.state === 'resting' ? `resting ${fmtMins(elapsed)} of ${fmtMins(rest.stage.minutes)}` : `rested ${fmtMins(elapsed)}`}
        {rest.stage.note ? ` · ${rest.stage.note}` : ''}
        {item.deadlineMinutes != null ? ` · by ${fmtDeadline(item.deadlineMinutes, fmtClock)}` : ''}
      </div>
```
with
```tsx
      <div className="font-mono text-[10.5px] text-[#a1a1aa] mt-[9px] leading-[1.5] flex items-center gap-1.5 flex-wrap">
        <Hourglass size={11} className="text-[#a1a1aa]" />
        {rest.stage.note ? `${rest.stage.note} · ` : ''}
        {rest.state === 'resting' ? `resting ${fmtMins(elapsed)} of ${fmtMins(rest.stage.minutes)}` : `rested ${fmtMins(elapsed)}`}
        {' · '}{stageLabel(rest.index, rest.total, rest.stage)}
        {item.deadlineMinutes != null ? ` · by ${fmtDeadline(item.deadlineMinutes, fmtClock)}` : ''}
      </div>
      {rest.next && (
        <div className="font-mono text-[10.5px] text-[#a1a1aa] mt-1">
          Next: {nextName} · {fmtMins(rest.next.stage.minutes)} hands-on
        </div>
      )}
```

Change the button text `Recipe · stages` to `Recipe · method`.

(The hero's dark card uses literal greys `#a1a1aa` already — keep them; the flat-token rule is about the numbered Tailwind palette, and these match the existing card.)

- [ ] **Step 4: Lint + type-check**

Run: `npx eslint src/components/prep/runsheet/RestRow.tsx src/components/prep/runsheet/RestRowMobile.tsx src/components/prep/runsheet/NextUpHero.tsx && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v __tests__ | grep -E "RestRow|NextUpHero" ; echo "checked"`
Expected: eslint silent (pre-existing warnings are known); the grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/components/prep/runsheet/RestRow.tsx src/components/prep/runsheet/RestRowMobile.tsx src/components/prep/runsheet/NextUpHero.tsx
git commit -m "feat(prep): a resting row leads with the item and the stage it is in; the next step is the subtitle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: One Method section — live wait card, Back / Next, Stages list removed

**Files:**
- Modify: `src/components/prep/PrepRecipeSection.tsx` (imports lines 4, 10–11; `WaitRow` ~lines 205–225; the method-derivation block ~lines 304–322; the METHOD header ~line 497; the `WaitRow` call ~line 523; after the method `</ol>` ~line 531)
- Modify: `src/components/prep/board/PrepBoardDrawer.tsx` (import line 8; the `{/* Stage chain … */}` block lines ~142–153)
- Modify: `src/components/prep/PrepDrawer.tsx` (import line 18; the `{/* Stage chain … */}` block lines ~301–310)
- Delete: `src/components/prep/StageList.tsx`

**Interfaces:**
- Consumes: `methodToChain(method): RecipeStage[] | null` and `chainBlocks(method)` from `@/lib/recipe-method`; `stageLabel`, `stageElapsed` from `@/lib/prep-stages`; the existing `onStage?: (stageIndex: number) => void` prop and `log` (`StageLogShape`, has `status`, `stageIndex`, `stageEnteredAt`).
- Produces: nothing new. Both drawers keep passing the same props to `PrepRecipeSection`.

- [ ] **Step 1: Imports in `PrepRecipeSection.tsx`**

```ts
import { Minus, Plus, Hourglass, ArrowRight, ArrowLeft } from 'lucide-react'
…
import { chainBlocks, methodToChain, type MethodStep } from '@/lib/recipe-method'
import { stageElapsed, stageLabel } from '@/lib/prep-stages'
```

- [ ] **Step 2: `WaitRow` — muted row normally, the lit card when live**

Replace the whole `WaitRow` function (its doc comment through the closing `}`) with:

```tsx
/** The wait after a step. Muted one-liner normally; when the job is IN this wait
 *  it is the lit row of the list — the stage name, its note, and the live clock
 *  (the same information the old Stages list carried, now in the only list). */
function WaitRow({ step, name, live, enteredAt, nowMs }: {
  step: MethodStep
  /** the derived stage name for this wait, e.g. "Curing · wait" */
  name: string
  live: boolean
  enteredAt?: string | null
  nowMs: number
}) {
  const w = step.wait!
  if (!live) {
    return (
      <li className="flex items-center gap-2 ml-[42px] mr-2.5 my-0.5 rounded-lg px-2.5 py-1.5 font-mono text-[10.5px] text-blue-text/80">
        <Hourglass size={11} className="shrink-0" />
        <span className="min-w-0">wait {fmtMins(w.minutes)}{w.note ? ` · ${w.note}` : ''}</span>
      </li>
    )
  }
  const elapsed = enteredAt ? stageElapsed({ stageEnteredAt: enteredAt }, nowMs) : 0
  const ready = elapsed >= w.minutes
  const since = enteredAt ? new Date(enteredAt) : null
  return (
    <li className={`flex gap-3.5 items-start px-2.5 py-3 rounded-[10px] ${ready ? 'bg-green-soft' : 'bg-blue-soft'}`}>
      <span className={`w-[27px] h-[27px] rounded-lg grid place-items-center flex-shrink-0 bg-ink ${ready ? 'text-green' : 'text-blue-text'}`}>
        <Hourglass size={13} />
      </span>
      <span className="flex-1 min-w-0 pt-0.5">
        <span className="block text-[13.5px] font-semibold tracking-[-0.01em] text-ink">{name}</span>
        {w.note && <span className="block text-[12px] text-ink-2 mt-0.5">{w.note}</span>}
        <span className={`block font-mono text-[10.5px] mt-1 ${ready ? 'text-green-text' : 'text-blue-text'}`}>
          {since ? `since ${fmtClock(since.getHours() * 60 + since.getMinutes())} · ` : ''}
          {ready ? 'ready' : 'resting'} · {fmtMins(elapsed)} of {fmtMins(w.minutes)}
        </span>
      </span>
    </li>
  )
}
```

- [ ] **Step 3: Derive the chain, the stage title, and the last index**

In the method-derivation block, directly after `const blocks = method ? chainBlocks(method) : []`, add:

```ts
  // The derived chain itself — names for the live wait card, the section title
  // and the Next button. Same derivation `blocks` comes from; null when untimed.
  const chain = method ? methodToChain(method) : null
```

After `const currentBlock = inFlight ? blocks[current] ?? null : null`, add:

```ts
  const stageTitle = inFlight && chain && chain[current] ? stageLabel(current, chain.length, chain[current]) : null
  const lastIndex = chain ? chain.length - 1 : -1
```

- [ ] **Step 4: Title, wait call, action row**

Change the method header
```tsx
            <span>Method · tick as you go</span>
```
to
```tsx
            <span>Method · {stageTitle ?? 'tick as you go'}</span>
```

Change the `WaitRow` call
```tsx
                          {step.wait && <WaitRow step={step} live={waitLive} enteredAt={waitLive ? (log?.stageEnteredAt ?? null) : null} nowMs={nowMs} />}
```
to
```tsx
                          {step.wait && (
                            <WaitRow
                              step={step}
                              name={chain?.[waitIndex]?.name ?? 'Wait'}
                              live={waitLive}
                              enteredAt={waitLive ? (log?.stageEnteredAt ?? null) : null}
                              nowMs={nowMs}
                            />
                          )}
```

Directly after the method `</ol>` (still inside the `{stepTotal > 0 && (<div className="mt-[22px]">` block), add the action row moved from `StageList`:

```tsx
          {/* Back / Next — moved here from the old Stages list. Same gating: only
              a job in flight, only when the host lets the cook move it. Nothing
              advances on its own. */}
          {onStage && inFlight && chain && (
            <div className="flex items-center gap-2 mt-2.5 px-0.5">
              <button
                type="button"
                disabled={current <= 0}
                onClick={() => onStage(current - 1)}
                className="inline-flex items-center gap-1.5 h-10 px-3 rounded-[9px] text-[12.5px] font-semibold bg-paper border border-line text-ink-2 disabled:opacity-40"
              >
                <ArrowLeft size={13} /> Back
              </button>
              {current < lastIndex ? (
                <button
                  type="button"
                  onClick={() => onStage(current + 1)}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 h-10 px-3 rounded-[9px] text-[12.5px] font-semibold bg-ink text-paper"
                >
                  Next: {chain[current + 1].name} <ArrowRight size={13} className="text-gold" />
                </button>
              ) : (
                <span className="flex-1 font-mono text-[10px] text-ink-3 text-center">last stage — Done logs the yield</span>
              )}
            </div>
          )}
```

- [ ] **Step 5: Drawers drop the Stages list; delete `StageList.tsx`**

`src/components/prep/board/PrepBoardDrawer.tsx`: delete the import `import { StageList } from '@/components/prep/StageList'` and the whole block

```tsx
              {/* Stage chain — current stage lit; Back / Next mirror the run sheet. */}
              {stages && (
                <div className="dr-sec">
                  <div className="sl">Stages{stageAt ? ` · ${stageLabel(stageAt.index, stages.length, stageAt.stage)}` : ''}</div>
                  <StageList … />
                </div>
              )}
```
Keep `stages`, `stageAt`, `stageLabel` — the header chip at line ~82 still uses them.

`src/components/prep/PrepDrawer.tsx`: delete the import `import { StageList } from '@/components/prep/StageList'` and the block

```tsx
                {/* Stage chain — current stage lit, Back / Next mirror the run sheet. */}
                {stages && (
                  <div className="mt-2.5">
                    <StageList … />
                  </div>
                )}
```
Keep `stages` / `stageAt` / `stageLabel` — the header pill (~line 236) uses them. If `resolveStages` or `currentStage` become unused in either drawer, remove them from that import; if `stages` itself becomes unused in `PrepDrawer` (only `stageAt` reads it), leave the `const` — it feeds `stageAt`.

Then:
```bash
git rm src/components/prep/StageList.tsx
grep -rn "StageList" src
```
Expected: no output.

- [ ] **Step 6: Lint, type-check, tests**

Run: `npx eslint src/components/prep/PrepRecipeSection.tsx src/components/prep/board/PrepBoardDrawer.tsx src/components/prep/PrepDrawer.tsx && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v __tests__ | grep -E "PrepRecipeSection|PrepBoardDrawer|PrepDrawer|StageList" ; npm test 2>&1 | tail -4`
Expected: eslint silent; tsc grep prints nothing; vitest all green except the 2 known wall-clock-flaky cadence tests.

- [ ] **Step 7: Commit**

```bash
git add src/components/prep/PrepRecipeSection.tsx src/components/prep/board/PrepBoardDrawer.tsx src/components/prep/PrepDrawer.tsx
git commit -m "feat(prep): the drawer shows the stage chain once — inside the Method, with the live wait lit and Back / Next at its foot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
(`git rm` already staged the deletion.)

---

### Task 4: Isolated build, browser verification, PR

**Files:** none (fixes go back to the task that owns the file as a follow-up commit).

- [ ] **Step 1: Production build of the commit, isolated**

```bash
cd /Users/joshua/dev/fergies-os
SHA=$(git rev-parse HEAD)
W=/private/tmp/claude-501/-Users-joshua-dev-fergies-os/9d44334a-bb10-4afb-9f63-578121378b85/scratchpad/verify-rest
git worktree add --detach $W $SHA -q
ln -s /Users/joshua/dev/fergies-os/node_modules $W/node_modules
ln -s /Users/joshua/dev/fergies-os/.env $W/.env
(cd $W && npm run build 2>&1 | grep -E "Compiled successfully|error|Error|Failed" | head)
rm -f $W/node_modules $W/.env && git worktree remove --force $W
git diff --stat tsconfig.json
```
Expected: `✓ Compiled successfully`; no tsconfig diff.

- [ ] **Step 2: Browser — the resting row**

Dev server via `preview_start` (`name: "RestaurantOS (Next.js)"`), `/prep`, KITCHEN, To Do. Pass `tabId` on every action. In the Waiting section, Cured Salmon:
- Big line `Cured Salmon · Curing`; description `in the walk in fridge · resting …` then the `CURING · WAIT · 2/7` chip; subtitle `Next: Rinse & Rest · 15m hands-on`; the Next button unchanged.
- `resize_window` `preset: "mobile"`, reload, Kitchen mode: same row shape. Then My station: the hero only renders on the phone, and only when the resting job sorts first for the picked cook — pick the cook it is assigned to (or claim it from the Kitchen row first, then unclaim after). If the hero shows, check `Cured Salmon · Curing`, the note-first meta line, the `Next:` line, and the `Recipe · method` button. Reset to desktop.

- [ ] **Step 3: Browser — the drawer**

Open the Cured Salmon row's recipe button. Check:
- No `Stages` section header (`find "Stages"` → only the header chip text, if any).
- Method header `Method · Curing · wait · 2/7`.
- Step 1 (Curing) ticked and dimmed; the Curing wait is the lit full-width blue card with `in the walk in fridge` and `since 11:02 · resting …`.
- A Back / Next row under the method: `Back` enabled, `Next: Rinse & Rest`.
- Phone width: open the same item from the mobile row; same section.

- [ ] **Step 4: Browser — Next / Back round trip**

Tap `Next: Rinse & Rest` in the drawer → the row moves from Waiting to Working On; the drawer's lit row is now step 3 and the action row reads `Next: Rinse & Rest · wait`. Tap `Back` → the job returns to the curing wait. Note in the PR that `stageEnteredAt` is re-stamped by this round trip (the curing clock restarts) — acceptable on a demo job; if the user prefers, skip this step and say so.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/rest-row-and-method-merge
gh pr create --base main --title "feat(prep): resting rows lead with the stage they are in; the drawer has one Method" --body "$(cat <<'EOF'
## Summary

Two readability fixes on staged prep jobs.

**The Waiting row** led with the NEXT step (`Rinse & Rest · Cured Salmon`) and hid the stage the job is actually in under a small chip. It now reads `Cured Salmon · Curing`, then the stage's note and clock, then `Next: Rinse & Rest · 15m hands-on` as the subtitle. Desktop row, phone row, and the My-station hero.

**The drawer** showed the stage chain twice: a Stages list above a Method list that already carried the same waits. The Stages list is gone; the Method section now titles itself with the stage (`Method · Curing · wait · 2/7`), the live wait is the lit full-width card with its note and clock, and Back / Next sit at the foot of the method. `StageList.tsx` is deleted.

Spec: `docs/superpowers/specs/2026-09-14-rest-row-and-method-merge-design.md`.

## Verification
- `npm test` (new `restPhaseName` cases), lint, isolated-worktree `npm run build`.
- Browser-checked on the Cured Salmon job at desktop and phone widths: row text, drawer section, Back / Next round trip.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Report the PR URL.
