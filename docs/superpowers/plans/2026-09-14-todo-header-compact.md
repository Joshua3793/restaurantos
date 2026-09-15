# Compact To Do Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the five rows of chrome above the To Do ladder (posted band, ordering sentence, status card, crew cards, filter row) into one control row plus a 3 px progress hairline, on desktop and mobile, moving each count into the section header that already owns it.

**Architecture:** Pure presentation change inside the two run-sheet frames (`RunSheet.tsx`, `RunSheetMobile.tsx`). Both gain a `post` prop so they paint the posted caption themselves; the page stops painting `PostedBand` and `PrepShiftBand` above them. One small helper (`postedWhenLabel`) moves from the deleted `PostedBand.tsx` into `src/lib/prep-runsheet.ts` so both frames share it and it gets a unit test. No API, schema, or lib maths changes.

**Tech Stack:** Next.js 14 App Router, React client components, Tailwind flat tokens (`bg-green`, `text-ink-3`, …), vitest for the lib.

Spec: `docs/superpowers/specs/2026-09-14-todo-header-compact-design.md`.

## Global Constraints

- Tailwind **flat tokens only** (`bg-green`, `bg-gold`, `bg-bg-2`, `text-ink`, `text-ink-3`, `text-ink-4`, `text-gold-2`, `bg-gold-soft`, `border-line`). Numbered colour classes (`bg-red-500`) are broken in this repo.
- Sub-components must be defined at **module scope**, never inside a component body.
- The ladder stays **one step-derived order**. Do not add a "Low on stock" section; blocked rows stay in their step.
- The hairline is **3 px**, green for done, gold for in progress, `bg-bg-2` track, `gap-0.5` between segments, same maths as the old status card.
- `npm run build` in the main checkout is unreliable while the dev server runs: verify a **commit** in a detached worktree with `node_modules` and `.env` symlinked (recipe in Task 4).
- Work on branch `feat/todo-header-compact` (already created; the spec is its first commit).

---

### Task 1: `postedWhenLabel` in the run-sheet lib (moved out of `PostedBand`)

**Files:**
- Modify: `src/lib/prep-runsheet.ts` (append at the end)
- Test: `src/lib/__tests__/prep-runsheet.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `prepDayKey(d?: Date): string` from `src/lib/prep-day.ts` (returns the restaurant-day `'YYYY-MM-DD'`).
- Produces: `postedWhenLabel(postedAt: string, listDate?: string | null, todayKey?: string): string` — `'8:17 PM'` when the list is for today, `'8:17 PM yesterday'`, or `'8:17 PM Sep 12'`. Tasks 2 and 3 import it.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/__tests__/prep-runsheet.test.ts`:

```ts
import { postedWhenLabel } from '../prep-runsheet'

describe('postedWhenLabel: the time, plus WHICH day the list was posted for', () => {
  // 2026-09-14T20:17 local. The time part is rendered by toLocaleTimeString in
  // the test runner's zone, so assert on the day suffix and use a regex for the time.
  const postedAt = new Date(2026, 8, 14, 20, 17).toISOString()
  it('a list for today is just the time', () => {
    expect(postedWhenLabel(postedAt, '2026-09-14T00:00:00.000Z', '2026-09-14')).toMatch(/^\d{1,2}:\d{2} [AP]M$/)
  })
  it('a list for yesterday says yesterday', () => {
    expect(postedWhenLabel(postedAt, '2026-09-13T00:00:00.000Z', '2026-09-14')).toMatch(/^\d{1,2}:\d{2} [AP]M yesterday$/)
  })
  it('an older list carries its date', () => {
    expect(postedWhenLabel(postedAt, '2026-09-11T00:00:00.000Z', '2026-09-14')).toMatch(/^\d{1,2}:\d{2} [AP]M Sep 11$/)
  })
  it('no listDate falls back to the bare time', () => {
    expect(postedWhenLabel(postedAt, null, '2026-09-14')).toMatch(/^\d{1,2}:\d{2} [AP]M$/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/prep-runsheet.test.ts`
Expected: FAIL — `postedWhenLabel` is not exported from `../prep-runsheet`.

- [ ] **Step 3: Implement it**

Append to `src/lib/prep-runsheet.ts`:

```ts
import { prepDayKey } from './prep-day'

// The list is posted at the end of a shift for the NEXT day and its unfinished
// jobs carry over, so the caption has to say WHICH day's list this is — "8:17 PM"
// alone reads as "posted tonight" on a list posted two nights ago.
// `listDate` is a date-only marker at UTC midnight — read the date off it. Run it
// through the restaurant clock instead and it lands on the previous evening.
// `todayKey` is injectable for tests; production callers leave it to prepDayKey().
export function postedWhenLabel(postedAt: string, listDate?: string | null, todayKey: string = prepDayKey()): string {
  const t = new Date(postedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const day = listDate ? listDate.slice(0, 10) : null
  if (!day || day === todayKey) return t
  // Yesterday relative to the restaurant day, computed on the key itself so the
  // test can pin today without touching the wall clock.
  const yesterday = shiftDayKey(todayKey, -1)
  if (day === yesterday) return `${t} yesterday`
  // 'YYYY-MM-DD' is the restaurant day; render it as a date without re-deriving
  // a timezone from it (midday avoids the UTC-parse day shift).
  return `${t} ${new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

// 'YYYY-MM-DD' ± n days, as a 'YYYY-MM-DD'. Midday parse avoids DST/UTC edge shifts.
function shiftDayKey(key: string, days: number): string {
  const d = new Date(`${key}T12:00:00`)
  d.setDate(d.getDate() + days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}
```

Put the `import { prepDayKey } from './prep-day'` line with the other imports at the top of the file (line 2 area), not mid-file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/prep-runsheet.test.ts`
Expected: PASS, 4 new tests green, no other test in the file changed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prep-runsheet.ts src/lib/__tests__/prep-runsheet.test.ts
git commit -m "feat(prep): postedWhenLabel in the run-sheet lib, shared by both frames

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Desktop `RunSheet` — hairline + one control row; crew cards and status card removed

**Files:**
- Modify: `src/components/prep/runsheet/RunSheet.tsx` (imports at lines 20–33; props at 61–98; header JSX from the line `const donePct = …` (~line 238) down to the `{/* Waiting …` comment (~line 353); step/station `GroupHead` subs at ~202 and ~224)
- Modify: `src/app/prep/page.tsx` (desktop To Do block, ~line 1863: the `PostedBand` line and the `<RunSheet` props)
- Delete: `src/components/prep/runsheet/CrewStrip.tsx`

**Interfaces:**
- Consumes: `postedWhenLabel` from Task 1; `PrepPostInfo` from `src/components/prep/types.ts` (`{ id, postedAt, postedByName, itemCount, activeMinutes, dirty, listDate? }`).
- Produces: `RunSheet` gains a required prop `post: PrepPostInfo | null`. Task 3 mirrors the same prop on `RunSheetMobile`.

- [ ] **Step 1: Add the `post` prop and the new import**

In `src/components/prep/runsheet/RunSheet.tsx`:

Change the lib import line
```ts
import { fmtClock, fmtMins, fmtQty } from '@/lib/prep-runsheet'
```
to
```ts
import { fmtClock, fmtMins, fmtQty, postedWhenLabel } from '@/lib/prep-runsheet'
```

Add after `import type { PrepItemRich } from '@/components/prep/types'`:
```ts
import type { PrepPostInfo } from '@/components/prep/types'
```

Remove the line `import { CrewStrip } from './CrewStrip'`.

In the destructured props add `post,` after `services,` and in the props type add, after the `services: RcService[]` block:
```ts
  /** The live post for this RC's list (null when nothing is posted). The sheet
   *  paints the "Posted 8:17 PM · Joshua · 14 items" caption itself now that
   *  the black PostedBand above it is gone. */
  post: PrepPostInfo | null
```

- [ ] **Step 2: Replace the header stack**

In `RunSheet.tsx`, delete everything from the line
```tsx
  const donePct = items.length ? (done.length / items.length) * 100 : 0
```
down to (and including) the closing `</div>` of the `{/* station filter (kitchen) + grouping control */}` block — i.e. the old return's opening `<div className="max-w-[1010px] …">`, the slim control row, the status band, the crew/cook-picker block, and the station-filter row. Stop right before the `{/* Waiting — jobs resting …` comment.

Replace that whole span with:

```tsx
  const donePct = items.length ? (done.length / items.length) * 100 : 0
  const doingPct = items.length ? (doing.length / items.length) * 100 : 0

  return (
    <div className="max-w-[1010px] mx-auto tracking-[-0.005em]">
      {/* The whole header is a 3px progress hairline and ONE control row. The
          black posted band, the ordering sentence, the status card and the
          per-cook crew cards used to stack here (~700px of chrome before the
          first job); every number they carried now lives in the section header
          that owns it — see docs/superpowers/specs/2026-09-14-todo-header-compact-design.md. */}
      <div className="flex h-[3px] rounded-full overflow-hidden bg-bg-2 gap-0.5 mb-3">
        {done.length > 0 && <div className="bg-green" style={{ width: `${donePct}%` }} />}
        {doing.length > 0 && <div className="bg-gold" style={{ width: `${doingPct}%` }} />}
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap mb-3.5">
        <HeaderCaption doneN={done.length} totalN={items.length} post={post} clock={fmtClock(nowMin)} svcCaption={svcCaption} />

        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <Segmented<Mode>
            value={mode}
            onPick={setMode}
            options={[
              { id: 'kitchen', label: 'Kitchen', badge: notDone.length },
              { id: 'station', label: 'My station' },
            ]}
          />
          {mode === 'kitchen' ? (
            <div className="flex gap-1.5 flex-wrap">
              {['all', ...stations].map(s => {
                const on = stFilter === s
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStFilter(s)}
                    className={`px-3 py-1.5 rounded-full border font-mono text-[10.5px] font-medium cursor-pointer capitalize ${
                      on ? 'border-ink bg-ink text-paper' : 'border-line bg-paper text-ink-3'
                    }`}
                  >
                    {s === 'all' ? `All · ${todo.length + doing.length}` : s}
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 flex-wrap">
              {cooks.map(c => {
                const on = cook === c.id
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCook(c.id)}
                    className={`inline-flex items-center gap-1.5 px-[13px] py-[7px] rounded-full border font-mono text-[11px] font-semibold cursor-pointer ${
                      on ? 'border-ink bg-ink text-paper' : 'border-line bg-paper text-ink-2'
                    }`}
                  >
                    {c.initials}
                    <span className={`text-[9px] font-normal ${on ? 'text-line-2' : 'text-ink-4'}`}>{c.homeStation ?? ''}</span>
                  </button>
                )
              })}
            </div>
          )}
          <Segmented<Group>
            value={group}
            onPick={setGroup}
            options={[
              { id: 'ladder', label: 'Steps' },
              { id: 'station', label: 'Station' },
            ]}
          />
        </div>
      </div>
```

Then add the caption component at **module scope** (above `export function RunSheet`, after the `isTodo` const):

```tsx
// The one-line caption on the left of the control row: done count, the posted
// provenance (time, poster, item count) when there is a live post, the clock,
// and the service caption. Truncates rather than wrapping — the controls on the
// right take the second line on iPad, the caption never does.
function HeaderCaption({
  doneN,
  totalN,
  post,
  clock,
  svcCaption,
}: {
  doneN: number
  totalN: number
  post: PrepPostInfo | null
  clock: string
  svcCaption: string | null
}) {
  return (
    <div className="flex items-center gap-2 min-w-0 font-mono text-[10.5px] text-ink-3">
      <span className="min-w-0 truncate">
        <b className="text-ink font-semibold">{doneN}</b>
        <span className="text-ink-4">/{totalN}</span> done
        {post && (
          <>
            {' · '}
            <Check size={10} className="inline-block align-[-1px] text-green" />
            {' '}Posted {postedWhenLabel(post.postedAt, post.listDate)} · {post.postedByName} · {post.itemCount} item{post.itemCount !== 1 ? 's' : ''}
          </>
        )}
        {' · '}
        <b className="text-ink font-semibold">{clock}</b>
        {svcCaption && <> · {svcCaption}</>}
      </span>
      {post?.dirty && (
        <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.05em] bg-gold-soft text-gold-2 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">
          Chef has unposted changes
        </span>
      )}
    </div>
  )
}
```

Add `Check` to the lucide import: `import { RotateCcw, Check } from 'lucide-react'`.

- [ ] **Step 3: Low-on-stock captions on the step and station headers**

Still in `RunSheet.tsx`, add a helper next to `handsOn`:

```tsx
  // "N low on stock" for a group's caption — same test the old status card used
  // for its kitchen-wide count; now per section so a blocked job is counted where it sits.
  const lowStock = (list: PrepItemRich[]) => {
    const n = list.filter(i => i.isBlocked || !!i.blockedReason).length
    return n ? `${n} low on stock` : null
  }
```

In `renderLadder`, station grouping — change
```tsx
<GroupHead dot="bg-ink-3" title={s} count={grp.length} sub={late ? `${late} late to start` : null} />
```
to
```tsx
<GroupHead dot="bg-ink-3" title={s} count={grp.length} sub={[late ? `${late} late to start` : null, lowStock(grp)].filter(Boolean).join(' · ') || null} />
```

Step grouping — change
```tsx
sub={[g.sub, `${handsOn(g.rows)} hands-on`].filter(Boolean).join(' · ')}
```
to
```tsx
sub={[g.sub, `${handsOn(g.rows)} hands-on`, lowStock(g.rows)].filter(Boolean).join(' · ')}
```

Delete the now-unused `blockedN` const (`const blockedN = todo.filter(…)`).

- [ ] **Step 4: Delete `CrewStrip` and wire the page**

```bash
git rm src/components/prep/runsheet/CrewStrip.tsx
```

In `src/app/prep/page.tsx`, desktop To Do block (~line 1863): delete the line
```tsx
            {plan.post && activeRcId && <PostedBand post={plan.post} />}
```
and the surrounding `<>` / `</>` fragment that only existed to hold it, so `<RunSheet` is the direct `:` branch. Add the prop `post={activeRcId ? plan.post : null}` to `<RunSheet` right after `services={rcServices}`.

Leave the mobile `PostedBand` line and the `PostedBand` import alone for now — Task 3 removes them.

- [ ] **Step 5: Lint and type-check the touched files**

Run: `npx eslint src/components/prep/runsheet/RunSheet.tsx src/app/prep/page.tsx && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v __tests__ | grep -E "RunSheet|prep/page" ; echo "tsc filtered exit done"`
Expected: eslint prints nothing; the grep prints no lines (no type errors in the two files). If `grep` prints `blockedN` or `CrewStrip` errors, a leftover reference was missed in Steps 2–4.

- [ ] **Step 6: Commit**

```bash
git add src/components/prep/runsheet/RunSheet.tsx src/app/prep/page.tsx
git commit -m "feat(prep): desktop To Do header is one control row and a hairline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Mobile `RunSheetMobile` caption + page cleanup; `PostedBand` and `PrepShiftBand` deleted

**Files:**
- Modify: `src/components/prep/runsheet/RunSheetMobile.tsx` (imports ~line 18–31; props ~64–98; the caption block ~228–236)
- Modify: `src/app/prep/page.tsx` (imports lines 15, 29, 41; `workloadLabel` ~line 618; mobile To Do block ~1912–1960)
- Delete: `src/components/prep/runsheet/PostedBand.tsx`, `src/components/prep/PrepShiftBand.tsx`
- Modify: `CLAUDE.md` line 105

**Interfaces:**
- Consumes: `postedWhenLabel` (Task 1); `PrepPostInfo`.
- Produces: `RunSheetMobile` gains the required prop `post: PrepPostInfo | null` (same shape as Task 2).

- [ ] **Step 1: Prop + imports on the mobile sheet**

In `RunSheetMobile.tsx` change
```ts
import { fmtClock, fmtMins, fmtQty } from '@/lib/prep-runsheet'
```
to
```ts
import { fmtClock, fmtMins, fmtQty, postedWhenLabel } from '@/lib/prep-runsheet'
```
Add after the `PrepItemRich` type import:
```ts
import type { PrepPostInfo } from '@/components/prep/types'
```
Add `post,` to the destructured props after `services,` and to the type, after the `services: RcService[]` block:
```ts
  /** The live post for this RC's list (null when nothing is posted) — painted
   *  into the caption line now that the PostedBand above the sheet is gone. */
  post: PrepPostInfo | null
```

- [ ] **Step 2: Hairline + caption line**

Replace the caption block
```tsx
      <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-ink-3 pt-0.5 pb-2.5">
        NOW {fmtClock(nowMin)}
        {svcCaption ? ` · ${svcCaption}` : ''}
        {readyN > 0 && <span className="text-green-text"> · {readyN} ready to move</span>}
      </div>
```
with
```tsx
      {/* 3px progress hairline + one caption line replace the page's shift band and
          posted band (spec: 2026-09-14-todo-header-compact-design.md §3). */}
      <div className="flex h-[3px] rounded-full overflow-hidden bg-bg-2 gap-0.5 mb-2.5">
        {done.length > 0 && <div className="bg-green" style={{ width: `${(done.length / items.length) * 100}%` }} />}
        {doingAll.length > 0 && <div className="bg-gold" style={{ width: `${(doingAll.length / items.length) * 100}%` }} />}
      </div>
      <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-ink-3 pt-0.5 pb-2.5">
        <b className="text-ink font-semibold">{done.length}</b><span className="text-ink-4">/{items.length}</span> done
        {' · '}NOW {fmtClock(nowMin)}
        {svcCaption ? ` · ${svcCaption}` : ''}
        {post && ` · Posted ${postedWhenLabel(post.postedAt, post.listDate)}`}
        {readyN > 0 && <span className="text-green-text"> · {readyN} ready to move</span>}
      </div>
      {post?.dirty && (
        <div className="mb-2.5">
          <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.05em] bg-gold-soft text-gold-2 px-2 py-0.5 rounded-full whitespace-nowrap">
            Chef has unposted changes
          </span>
        </div>
      )}
```

`items.length` is never 0 here in practice (the page renders an empty-state card instead), but guard the division anyway: define `const totalN = items.length || 1` above the return and use `totalN` in both width expressions instead of `items.length`.

- [ ] **Step 3: Page cleanup**

In `src/app/prep/page.tsx`:

1. Delete `import PrepShiftBand from '@/components/prep/PrepShiftBand'` (line 15).
2. Delete `import { PostedBand } from '@/components/prep/runsheet/PostedBand'` (line 41).
3. Change line 29 to drop the two now-unused names:
   ```ts
   import { computeShiftSummary, computePriority } from '@/lib/prep-utils'
   ```
   (Keep `formatMinutes` only if something else in the file still reads it: run `grep -n "formatMinutes" src/app/prep/page.tsx` — if the only hit was line 618, drop it too.)
4. Delete the `workloadLabel` line (~618):
   ```ts
   const workloadLabel = useMemo(() => '~' + formatMinutes(computeWorkloadMinutes(todayItems)), [todayItems])
   ```
5. In the mobile To Do block delete
   ```tsx
   <PrepShiftBand summary={shiftSummary} countdown={countdown} workloadLabel={workloadLabel} />
   ```
   and
   ```tsx
   {plan.post && activeRcId && <PostedBand post={plan.post} />}
   ```
   and add `post={activeRcId ? plan.post : null}` to `<RunSheetMobile` after `services={rcServices}`.

Delete the two components:
```bash
git rm src/components/prep/runsheet/PostedBand.tsx src/components/prep/PrepShiftBand.tsx
```

Confirm nothing else imports them:
```bash
grep -rn "PostedBand\|PrepShiftBand\|CrewStrip\|workloadLabel" src
```
Expected: no output.

- [ ] **Step 4: CLAUDE.md**

On line 105 of `CLAUDE.md`, change
```
the **To Do run sheet** (`runsheet/` — `RunSheet`, `RunSheetMobile`, `PostedBand`) that shows ONLY posted items
```
to
```
the **To Do run sheet** (`runsheet/` — `RunSheet`, `RunSheetMobile`; each paints its own one-line posted caption + 3 px progress hairline, no status card or crew strip) that shows ONLY posted items
```

- [ ] **Step 5: Lint, tests, type-check**

Run: `npx eslint src/components/prep/runsheet/RunSheetMobile.tsx src/app/prep/page.tsx && npm test 2>&1 | tail -5 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v __tests__ | grep -E "RunSheet|prep/page|prep-runsheet" ; echo "done"`
Expected: eslint silent; vitest summary shows all files passing (the `prep-plan-pipeline` cadence test has two known wall-clock failures on main — if those two are the only failures, that is pre-existing, not this change); the tsc grep prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/components/prep/runsheet/RunSheetMobile.tsx src/app/prep/page.tsx CLAUDE.md
git commit -m "feat(prep): mobile To Do caption carries done count + posted time; shift band and posted band retired

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Build in an isolated worktree, browser verification, PR

**Files:** none modified (fixes found here go back into the task that owns the file, as a follow-up commit).

- [ ] **Step 1: Production build of the commit, isolated**

```bash
cd /Users/joshua/dev/fergies-os
SHA=$(git rev-parse HEAD)
W=/private/tmp/claude-501/-Users-joshua-dev-fergies-os/9d44334a-bb10-4afb-9f63-578121378b85/scratchpad/verify-todo
git worktree add --detach $W $SHA -q
ln -s /Users/joshua/dev/fergies-os/node_modules $W/node_modules
ln -s /Users/joshua/dev/fergies-os/.env $W/.env
(cd $W && npm run build 2>&1 | grep -E "Compiled successfully|error|Error|Failed" | head)
rm -f $W/node_modules $W/.env && git worktree remove --force $W
git diff --stat tsconfig.json
```
Expected: `✓ Compiled successfully`; `git diff --stat tsconfig.json` prints nothing (if it does, `git checkout tsconfig.json`).

- [ ] **Step 2: Browser — desktop**

Start the dev server with `preview_start` (`name: "RestaurantOS (Next.js)"`), open `/prep`, KITCHEN revenue center, To Do tab. Wait for `/api/prep/items` (slow, ~10 s). Check, with `read_page`/`find` and one screenshot:

- The first element under the tab bar is the 3 px bar, then one row: caption on the left reading `N/M done · ✓ Posted <time> · <name> · <k> items · <clock>`; Kitchen/My station, station chips, Steps/Station on the right.
- No element with text `Posted list`, `between tasks`, `Ordered by`, or `in progress` above the first section header.
- Click **My station**: the cook-picker chips replace the station chips inline in the same row. Click **Kitchen** to go back.
- Click **Station** grouping: station headers render; any with blocked rows show `N low on stock`. Click **Steps**.
- A step header whose rows include a blocked item shows `… hands-on · N low on stock`.
- `read_console_messages onlyErrors` is empty.

- [ ] **Step 3: Browser — iPad and phone**

`resize_window` to `{width: 900, height: 1100}`: the control row wraps to two lines, the caption truncates, nothing overflows horizontally (`document.documentElement.scrollWidth <= innerWidth` via `javascript_tool`). Then `preset: "mobile"` and reload: the mobile To Do shows the hairline, then the caption `N/M DONE · NOW HH:MM · … · POSTED <time>`, then the My station/Kitchen toggle; no shift band (`N/M` big number + chips) and no black posted band above. Reset with `preset: "desktop"`.

- [ ] **Step 4: Dirty-post pill**

In the browser: Smart Prep tab → change one draft quantity with the stepper (do not post) → To Do tab. The gold `Chef has unposted changes` pill shows in the caption row (desktop) / under the caption (mobile). Then Smart Prep → undo the change (step back) so the live list is left as it was.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/todo-header-compact
gh pr create --base main --title "feat(prep): the To Do header gets out of the way" --body "$(cat <<'EOF'
## Summary

The To Do stacked five rows of chrome before the first job (posted band, ordering sentence, status card, crew cards, filter row — ~700px). It is now one control row and a 3px progress hairline on desktop, and one caption line plus the hairline on mobile. Every number the old chrome carried moved into the section header that owns it; the crew status IS the Working On section.

Spec: `docs/superpowers/specs/2026-09-14-todo-header-compact-design.md`.

**Changed**
- `RunSheet` / `RunSheetMobile` take a `post` prop and paint the posted caption themselves.
- Step and station headers gain `N low on stock`.
- `postedWhenLabel` moved into `src/lib/prep-runsheet.ts` with tests.

**Deleted**
- `PostedBand`, `CrewStrip`, `PrepShiftBand`, and the page's `workloadLabel`.

## Verification
- `npm test`, lint, and an isolated-worktree `npm run build` pass.
- Browser-checked at desktop, iPad, and phone widths: Kitchen ↔ My station, Steps ↔ Station, low-on-stock captions, dirty-post pill, no console errors.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Report the PR URL.
