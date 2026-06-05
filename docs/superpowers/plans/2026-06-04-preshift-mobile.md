# Pre-shift Mobile Redesign + Temps Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an option-A mobile renderer to the desktop-only `/preshift` page and replace its inline localStorage temperature logging with a summary that mirrors the DB-backed Temps page — in both renderers.

**Architecture:** Single client page (`src/app/preshift/page.tsx`) with the app's dual-renderer pattern (`hidden md:block` desktop / `md:hidden` mobile), both fed by the same derived state. The "Safety & temps" section's three hardcoded temp-logging rows are removed; instead the page fetches `/api/temps/units?date=<today>`, derives a single `tempsReady` gate via the existing `computeDayMetrics` helper, folds it into the sign-off totals, and shows a read-only summary card with a "Log temps →" deep-link to `/temps`.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind (flat color tokens), Lucide icons. Reuses `src/components/temps/temp-utils.ts`. No test suite — `npm run build` + browser preview are the verification gates (per CLAUDE.md).

**Spec:** [docs/superpowers/specs/2026-06-04-preshift-mobile-redesign-design.md](../specs/2026-06-04-preshift-mobile-redesign-design.md)

---

## File Structure

- **Modify** `src/app/preshift/page.tsx` — remove temp-logging state/logic; remove the 3 temp items from `SAFETY_DEFAULTS`; add temps fetch + `tempsReady` + fold into totals; wrap the existing desktop body in `hidden md:block`; inject the temps summary into the desktop Safety section; add a `md:hidden` mobile renderer.
- **Create** `src/components/preshift/SafetyTempsSummary.tsx` — shared presentational card (logged/total/flagged + "Log temps →"), used by both renderers.
- **Create** `src/components/preshift/mobile.tsx` — module-scope mobile sub-components (`MGateBanner`, `MProgress`, `MSectionCard`, `MCheckRow`, `MSignoff`).

Pattern reference: `src/components/temps/` (feature folder, module-scope components, flat tokens).

---

## Task 1: Shared component — SafetyTempsSummary

**Files:**
- Create: `src/components/preshift/SafetyTempsSummary.tsx`

- [ ] **Step 1: Create the component**

```tsx
'use client'
import { Thermometer, ArrowRight } from 'lucide-react'

// Read-only mirror of the Temps page for pre-shift. Shows today's temp-unit
// rollup and deep-links to /temps to log. `blocking` = not every unit logged
// or something out of range.
export function SafetyTempsSummary({
  logged, total, flagged, blocking, onLogTemps,
}: {
  logged: number
  total: number
  flagged: number
  blocking: boolean
  onLogTemps: () => void
}) {
  const statusText =
    total === 0
      ? 'No temp units yet'
      : flagged > 0
        ? `${flagged} out of range`
        : logged === total
          ? 'All logged · in range'
          : `${total - logged} awaiting`

  return (
    <div
      className="flex items-center gap-3 px-[18px] py-[13px] border-b border-line"
      style={blocking ? { boxShadow: 'inset 3px 0 0 #dc2626' } : undefined}
    >
      <span className={`w-[22px] h-[22px] rounded-[6px] grid place-items-center shrink-0 ${
        total > 0 && logged === total && flagged === 0 ? 'bg-green text-white' : 'bg-blue-soft text-blue-text'
      }`}>
        <Thermometer size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium tracking-[-0.01em] text-ink">Temperatures</div>
        <div className="font-mono text-[10.5px] mt-[3px] tracking-[0]">
          <span className={flagged > 0 ? 'text-red-text font-semibold' : 'text-ink-3'}>
            {logged}/{total} logged{flagged > 0 ? ` · ${flagged} out of range` : ''}
          </span>
        </div>
      </div>
      <button
        onClick={onLogTemps}
        className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold text-gold-2 bg-bg-2 border border-line rounded-full px-3 py-1.5 hover:border-ink-3 transition-colors shrink-0"
      >
        Log temps <ArrowRight size={12} />
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: compiles (component is unused so far — no errors).

- [ ] **Step 3: Commit**

```bash
git add src/components/preshift/SafetyTempsSummary.tsx
git commit -m "feat(preshift): add SafetyTempsSummary mirror component"
```

---

## Task 2: Remove inline temp logging + fold temps gate into totals (desktop still works)

**Files:**
- Modify: `src/app/preshift/page.tsx`

- [ ] **Step 1: Add imports**

At the top with the other imports add:

```tsx
import { computeDayMetrics, type TempUnit } from '@/components/temps/temp-utils'
import { SafetyTempsSummary } from '@/components/preshift/SafetyTempsSummary'
```

- [ ] **Step 2: Remove the temp `CheckItem` shape**

In the `CheckItem` interface delete the temp-related members. Remove:
```tsx
interface TempSpec { unit: '°C'; max?: number; min?: number }
```
and from `CheckItem` remove the line:
```tsx
  /** If present, the row logs a temperature and auto-judges it. */
  temp?: TempSpec
```

- [ ] **Step 3: Trim `SAFETY_DEFAULTS` to non-temp checks**

Replace the `SAFETY_DEFAULTS` array with (drop walkin-a, walkin-b, hot-hold):

```tsx
const SAFETY_DEFAULTS: CheckItem[] = [
  { id: 'safety:probe',    section: 'safety', title: 'Probe thermometer calibrated', meta: 'ice / boil check · daily' },
  { id: 'safety:sanitiser', section: 'safety', title: 'Sanitiser buckets made & dated', meta: 'all stations' },
]
```

- [ ] **Step 4: Replace temp state with temp-units fetch**

Remove the `temps` state line:
```tsx
  const [temps, setTemps] = useState<Record<string, number | null>>({})
```
and add after the `prepItems` state:
```tsx
  const [tempUnits, setTempUnits] = useState<TempUnit[]>([])
```

Update hydrate/persist to drop `temps`:
- In the hydrate effect, remove `setTemps(p.temps ?? {})` and the `setTemps({})` in the catch.
- In the persist effect, change the payload to `JSON.stringify({ done, custom })` and the dep array to `[done, custom, hydrated, storageKey]`.

Add a temps fetch effect after the prep fetch effect:
```tsx
  // Live temp units (mirror of the Temps page) for the safety gate.
  useEffect(() => {
    let cancelled = false
    const today = ymd(new Date())
    fetch(`/api/temps/units?rcId=${activeRcId ?? ''}&date=${today}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : [])
      .then(d => { if (!cancelled && Array.isArray(d)) setTempUnits(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [activeRcId])
```

- [ ] **Step 5: Delete `judgeTemp` and `logTemp`, simplify `isDone`/`isBlockingOpen`/`toggle`**

Delete the entire `judgeTemp` `useCallback` block and the `logTemp` `useCallback` block.

Replace `isDone`, `isBlockingOpen`, `toggle` with:
```tsx
  const isDone = useCallback((it: CheckItem) => !!done[it.id], [done])

  const isBlockingOpen = useCallback((it: CheckItem) => {
    if (isDone(it)) return false
    return !!it.blocker
  }, [isDone])

  const toggle = useCallback((it: CheckItem) => {
    setDone(prev => ({ ...prev, [it.id]: !prev[it.id] }))
  }, [])
```

In `resetAll`, change to `const resetAll = useCallback(() => { setDone({}) }, [])`.

- [ ] **Step 6: Derive the temps gate and fold it into totals**

Replace the `// ── Derived totals ──` block:
```tsx
  const total = allItems.length
  const doneCount = allItems.filter(isDone).length
  const blockers = allItems.filter(isBlockingOpen)
  const blockersOpen = blockers.length
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0
  const ready = total > 0 && doneCount === total
```
with:
```tsx
  // Temps gate: ready when every unit is logged today and none is out of range
  // (or there are no units configured yet).
  const tempMetrics = useMemo(() => computeDayMetrics(tempUnits), [tempUnits])
  const tempsReady = tempMetrics.total === 0
    ? true
    : tempMetrics.logged === tempMetrics.total && tempMetrics.flagged === 0

  // ── Derived totals (temps counts as one gate item) ─────────────────────────
  const blockers = allItems.filter(isBlockingOpen)
  const total = allItems.length + 1
  const doneCount = allItems.filter(isDone).length + (tempsReady ? 1 : 0)
  const blockersOpen = blockers.length + (tempsReady ? 0 : 1)
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0
  const ready = doneCount === total
```

- [ ] **Step 7: Update the desktop Safety section render + CheckRow usage**

In the desktop `SECTIONS.map` block, replace the body so the safety section gets the summary card and adjusted counts:
```tsx
            {SECTIONS.map(sec => {
              const items = itemsBySection[sec.key]
              const isSafety = sec.key === 'safety'
              const d = items.filter(isDone).length + (isSafety && tempsReady ? 1 : 0)
              const t = items.length + (isSafety ? 1 : 0)
              return (
                <Section key={sec.key} title={sec.title} Icon={sec.icon} done={d} total={t}>
                  {isSafety && (
                    <SafetyTempsSummary
                      logged={tempMetrics.logged}
                      total={tempMetrics.total}
                      flagged={tempMetrics.flagged}
                      blocking={!tempsReady}
                      onLogTemps={() => router.push('/temps')}
                    />
                  )}
                  {items.length === 0 && !isSafety ? (
                    <p className="text-[12.5px] text-ink-3 px-[18px] py-6 text-center">{loaded ? 'No checks here yet — add one above.' : 'Loading…'}</p>
                  ) : items.map(it => (
                    <CheckRow
                      key={it.id}
                      item={it}
                      done={isDone(it)}
                      blockingOpen={isBlockingOpen(it)}
                      onToggle={() => toggle(it)}
                      onRemove={it.custom ? () => removeCustom(it.id) : undefined}
                    />
                  ))}
                </Section>
              )
            })}
```

- [ ] **Step 8: Update the blockers rail to drop the temp reference, prepend a temps blocker**

In the desktop "Open blockers" `RailCard`, change the count to `blockersOpen` and prepend a temps row when not ready:
```tsx
            <RailCard title="Open blockers" count={blockersOpen}>
              {blockersOpen === 0 ? (
                <p className="text-[12.5px] text-green-text py-1">No blockers — line is clear.</p>
              ) : (
                <>
                  {!tempsReady && (
                    <div className="flex items-center gap-2.5 py-2 border-b border-dashed border-line last:border-0 text-[12.5px]">
                      <span className="w-[7px] h-[7px] rounded-full bg-red shrink-0" />
                      <span className="font-medium text-ink tracking-[-0.005em] truncate">Temperatures</span>
                      <span className="font-mono text-[10px] text-ink-3 ml-auto whitespace-nowrap">
                        {tempMetrics.flagged > 0 ? `${tempMetrics.flagged} out` : `${tempMetrics.total - tempMetrics.logged} to log`}
                      </span>
                    </div>
                  )}
                  {blockers.map(b => (
                    <div key={b.id} className="flex items-center gap-2.5 py-2 border-b border-dashed border-line last:border-0 text-[12.5px]">
                      <span className="w-[7px] h-[7px] rounded-full bg-red shrink-0" />
                      <span className="font-medium text-ink tracking-[-0.005em] truncate">{b.title}</span>
                      <span className="font-mono text-[10px] text-ink-3 ml-auto whitespace-nowrap">{b.right?.value ?? 'open'}</span>
                    </div>
                  ))}
                </>
              )}
            </RailCard>
```

- [ ] **Step 9: Update `CheckRow` to drop temp props**

In the `CheckRow` component signature remove `tempValue`, `judge`, `onLogTemp` from props and the destructure. Delete the entire `{item.temp ? ( … ) : item.right ? (` temp branch so it starts at `item.right ? (`:
```tsx
function CheckRow({ item, done, blockingOpen, onToggle, onRemove }: {
  item: CheckItem
  done: boolean
  blockingOpen: boolean
  onToggle: () => void
  onRemove?: () => void
}) {
  const rightTint = (t?: Tint) =>
    t === 'bad' ? 'text-red-text' : t === 'warn' ? 'text-gold-2' : t === 'ok' ? 'text-green-text' : 'text-ink-3'

  return (
    <div
      className="grid grid-cols-[26px_1fr_auto] items-center gap-3.5 px-[18px] py-[13px] border-b border-line last:border-0 hover:bg-bg/60 transition-colors cursor-pointer group"
      onClick={onToggle}
    >
      <div className={`w-[22px] h-[22px] rounded-[6px] border-[1.5px] grid place-items-center transition-all ${done ? 'bg-green border-green text-white' : 'border-line-2 text-transparent'}`}>
        <Check size={13} strokeWidth={3} />
      </div>

      <div className="min-w-0">
        <div className={`text-[14px] font-medium tracking-[-0.01em] flex items-center gap-1.5 ${done ? 'text-ink-3 line-through decoration-ink-4' : 'text-ink'}`}>
          <span className="truncate">{item.title}</span>
          {item.custom && onRemove && (
            <button onClick={e => { e.stopPropagation(); onRemove() }} className="opacity-0 group-hover:opacity-100 text-ink-4 hover:text-red-text transition-opacity shrink-0"><X size={12} /></button>
          )}
        </div>
        {(item.meta || item.metaAlert) && (
          <div className="font-mono text-[10.5px] text-ink-3 mt-[3px] tracking-[0] flex items-center gap-1.5 flex-wrap">
            {item.meta}
            {item.meta && item.metaAlert && <span className="text-ink-4">·</span>}
            {item.metaAlert && <b className="text-red-text font-semibold">{item.metaAlert}</b>}
          </div>
        )}
      </div>

      {item.right ? (
        <div className={`text-right font-mono text-[11.5px] font-semibold tracking-[-0.01em] ${rightTint(item.right.tint)}`}>
          {item.right.value}
          {item.right.sub && <small className="block font-normal text-ink-3 text-[9.5px] mt-px">{item.right.sub}</small>}
        </div>
      ) : (
        <div className="text-right font-mono text-[11.5px] text-ink-3">{done ? '✓' : '—'}</div>
      )}
    </div>
  )
}
```

- [ ] **Step 10: Wrap the desktop body so it only shows on md+**

The page returns `<>…</>`. Find the main container `<div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">` that holds `PageHead` + `ProgressBand` + sections grid + footer, and change its className to add `hidden md:block`:
```tsx
      <div className="hidden md:block p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">
```
(The `SubNav` above it stays shared.)

- [ ] **Step 11: Build**

Run: `npm run build`
Expected: `✓ Compiled successfully`; `/preshift` listed. Fix any type errors (e.g. leftover `temps`/`judgeTemp` references).

- [ ] **Step 12: Verify desktop in preview**

Start dev server (preview_start "RestaurantOS (Next.js)"), resize to width 1320, navigate to `/preshift`.
- Safety section shows a **Temperatures** summary row + Probe/Sanitiser checks; counts include the temp gate.
- With all `/temps` units logged & in range → temp row not blocking, contributes to progress.
- Toggle a service check; confirm progress + gate update.
- Screenshot.

- [ ] **Step 13: Commit**

```bash
git add src/app/preshift/page.tsx
git commit -m "feat(preshift): mirror Temps page for safety gate; drop inline temp logging"
```

---

## Task 3: Mobile renderer (option A)

**Files:**
- Create: `src/components/preshift/mobile.tsx`
- Modify: `src/app/preshift/page.tsx`

- [ ] **Step 1: Create the mobile sub-components**

```tsx
'use client'
import { Check, X, ArrowRight, AlertTriangle } from 'lucide-react'

export type MTint = 'ok' | 'warn' | 'bad' | 'neutral'

export function MGateBanner({ blockersOpen, ready }: { blockersOpen: number; ready: boolean }) {
  if (ready) {
    return (
      <div className="bg-green-soft text-green-text rounded-xl px-3.5 py-2.5 flex items-center gap-2 text-[13px] font-semibold mb-3">
        <Check size={17} strokeWidth={2.4} /> Ready for service
      </div>
    )
  }
  return (
    <div className="bg-red-soft text-red-text rounded-xl px-3.5 py-2.5 flex items-center gap-2 text-[13px] font-semibold mb-3">
      <AlertTriangle size={17} />
      {blockersOpen > 0
        ? `${blockersOpen} blocker${blockersOpen > 1 ? 's' : ''} — service can't open`
        : 'Finish the checks to open'}
    </div>
  )
}

export function MProgress({ done, total, pct, countdown, countdownLabel }: {
  done: number; total: number; pct: number; countdown: string | null; countdownLabel: string | null
}) {
  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="font-mono text-[11px] text-ink-3">
          <b className="text-ink font-semibold text-[13px]">{done}</b>/{total} done
        </span>
        {countdown && (
          <span className="font-mono text-[11px] text-gold-2 font-semibold">
            {countdown}{countdownLabel ? ` · ${countdownLabel}` : ''}
          </span>
        )}
      </div>
      <div className="h-2 rounded-full bg-bg-2 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-300 ${pct === 100 ? 'bg-green' : 'bg-gold'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function MSectionCard({ title, done, total, children }: {
  title: string; done: number; total: number; children: React.ReactNode
}) {
  const complete = total > 0 && done === total
  return (
    <section className="bg-paper border border-line rounded-xl overflow-hidden mb-3">
      <header className="flex items-center justify-between px-3.5 py-2.5 border-b border-line bg-bg-2">
        <h3 className="text-[12.5px] font-semibold tracking-[-0.01em]">{title}</h3>
        <span className={`font-mono text-[10.5px] ${complete ? 'text-green-text' : 'text-ink-3'}`}>{done} / {total}</span>
      </header>
      {children}
    </section>
  )
}

export function MCheckRow({ title, meta, metaAlert, done, right, rightTint, onToggle, onRemove }: {
  title: string
  meta?: string
  metaAlert?: string
  done: boolean
  right?: string
  rightTint?: MTint
  onToggle: () => void
  onRemove?: () => void
}) {
  const tintClass = rightTint === 'bad' ? 'text-red-text' : rightTint === 'warn' ? 'text-gold-2' : rightTint === 'ok' ? 'text-green-text' : 'text-ink-3'
  return (
    <div className="flex items-center gap-3 px-3.5 py-3 border-b border-line last:border-0 active:bg-bg/60 group" onClick={onToggle}>
      <div className={`w-[22px] h-[22px] rounded-[6px] border-[1.5px] grid place-items-center shrink-0 ${done ? 'bg-green border-green text-white' : 'border-line-2 text-transparent'}`}>
        <Check size={13} strokeWidth={3} />
      </div>
      <div className="min-w-0 flex-1">
        <div className={`text-[14px] font-medium tracking-[-0.01em] flex items-center gap-1.5 ${done ? 'text-ink-3 line-through decoration-ink-4' : 'text-ink'}`}>
          <span className="truncate">{title}</span>
          {onRemove && (
            <button onClick={e => { e.stopPropagation(); onRemove() }} className="text-ink-4 active:text-red-text shrink-0"><X size={12} /></button>
          )}
        </div>
        {(meta || metaAlert) && (
          <div className="font-mono text-[10px] text-ink-3 mt-[3px] flex items-center gap-1.5 flex-wrap">
            {meta}
            {meta && metaAlert && <span className="text-ink-4">·</span>}
            {metaAlert && <b className="text-red-text font-semibold">{metaAlert}</b>}
          </div>
        )}
      </div>
      {right && <span className={`font-mono text-[11px] font-semibold shrink-0 ${tintClass}`}>{right}</span>}
    </div>
  )
}

export function MSignoff({ ready, onOpen }: { ready: boolean; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      disabled={!ready}
      className={`w-full h-[52px] rounded-2xl inline-flex items-center justify-center gap-2 text-[15px] font-semibold tracking-[-0.01em] mt-1 ${
        ready ? 'bg-green text-white' : 'bg-bg-2 text-ink-4 cursor-not-allowed'
      }`}
    >
      <ArrowRight size={18} strokeWidth={2.5} /> {ready ? 'Open service' : 'Mark ready for service'}
    </button>
  )
}
```

- [ ] **Step 2: Import the mobile components and `SafetyTempsSummary` is already imported**

In `src/app/preshift/page.tsx` add:
```tsx
import { MGateBanner, MProgress, MSectionCard, MCheckRow, MSignoff } from '@/components/preshift/mobile'
```

- [ ] **Step 3: Render the mobile block**

Immediately after the shared `<SubNav … />` and **before** the `hidden md:block` desktop div, insert the mobile renderer:
```tsx
      {/* ── Mobile (option A) ── */}
      <div className="md:hidden p-4 max-w-lg mx-auto w-full">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-xl font-bold text-ink tracking-[-0.02em]">Pre-shift</h1>
            <p className="font-mono text-[10.5px] text-ink-3 mt-0.5 uppercase tracking-[0.02em]">
              {new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · Walk the line
            </p>
          </div>
          <button onClick={resetAll} className="font-mono text-[11px] text-ink-3 border border-line bg-paper rounded-full px-3 py-2">Reset</button>
        </div>

        <MGateBanner blockersOpen={blockersOpen} ready={ready} />
        <MProgress done={doneCount} total={total} pct={pct} countdown={serviceCountdown} countdownLabel={inService != null ? (serviceLabel ?? 'in service') : (serviceLabel ? `to ${serviceLabel}` : null)} />

        {SECTIONS.map(sec => {
          const items = itemsBySection[sec.key]
          const isSafety = sec.key === 'safety'
          const d = items.filter(isDone).length + (isSafety && tempsReady ? 1 : 0)
          const t = items.length + (isSafety ? 1 : 0)
          return (
            <MSectionCard key={sec.key} title={sec.title} done={d} total={t}>
              {isSafety && (
                <SafetyTempsSummary
                  logged={tempMetrics.logged}
                  total={tempMetrics.total}
                  flagged={tempMetrics.flagged}
                  blocking={!tempsReady}
                  onLogTemps={() => router.push('/temps')}
                />
              )}
              {items.map(it => (
                <MCheckRow
                  key={it.id}
                  title={it.title}
                  meta={it.meta}
                  metaAlert={it.metaAlert}
                  done={isDone(it)}
                  right={it.right?.value}
                  rightTint={it.right?.tint}
                  onToggle={() => toggle(it)}
                  onRemove={it.custom ? () => removeCustom(it.id) : undefined}
                />
              ))}
            </MSectionCard>
          )
        })}

        <AddCheck onAdd={addCheck} />
        <div className="mt-3" />
        <MSignoff ready={ready} onOpen={openService} />
        <div className="h-6" />
      </div>
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: `✓ Compiled successfully`.

- [ ] **Step 5: Verify mobile in preview**

preview_resize preset `mobile`; navigate `/preshift`.
- Option-A layout: header, gate banner, progress + countdown, three section cards (Safety leads with the Temperatures summary + Log temps button), Add check, inline "Mark ready for service".
- Tap service-readiness rows → toggle + counts update; gate banner flips to green "Ready for service" only when all checks done **and** temps ready.
- Tap "Log temps →" → routes to `/temps`.
- Confirm no floating/sticky bar; screenshot.

- [ ] **Step 6: Commit**

```bash
git add src/app/preshift/page.tsx src/components/preshift/mobile.tsx
git commit -m "feat(preshift): add option-A mobile renderer"
```

---

## Task 4: Final verification + integration check

- [ ] **Step 1: Cross-device temps check**

On `/temps` (mobile or desktop), log a unit out of range. Reload `/preshift`. Expected: Safety summary shows the out-of-range count, gate banner red, "Mark ready" disabled. Then log it in range on `/temps`, reload `/preshift` → gate clears. (Proves shared-DB mirror.)

- [ ] **Step 2: Full build**

Run: `npm run build`
Expected: `✓ Compiled successfully`; no `temps`/`judgeTemp`/`logTemp` references remain (`grep -n "judgeTemp\|logTemp\|setTemps" src/app/preshift/page.tsx` → no matches).

- [ ] **Step 3: Push**

```bash
git push -u origin feat/preshift-mobile
```

Then open a PR or merge to main per the user's preference.

---

## Self-Review

- **Spec coverage:** mobile renderer (Task 3) ✓; temps-mirror in both renderers (Task 2 desktop + Task 3 mobile, shared `SafetyTempsSummary` Task 1) ✓; one-gate-item fold incl. `total===0` edge (Task 2 Step 6) ✓; checklist stays localStorage (Task 2 Step 4 keeps `done`/`custom`) ✓; inline sign-off, no floating bar (Task 3 `MSignoff`) ✓; deep-link to `/temps` ✓; verification incl. cross-device (Task 4) ✓.
- **Placeholders:** none — every step has full code or exact commands.
- **Type consistency:** `tempMetrics` (`{total,logged,flagged}` from `computeDayMetrics`), `tempsReady`, `SafetyTempsSummary` props, and `MCheckRow` props are used consistently across tasks. `CheckRow` temp props removed everywhere they were passed (Task 2 Steps 7 & 9). `it.right?.tint` is typed `Tint`/`MTint` (`'ok'|'warn'|'bad'|'neutral'`).
