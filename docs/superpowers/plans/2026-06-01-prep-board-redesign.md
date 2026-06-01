# Prep "Board" Desktop Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the desktop Prep page's oversized renderers with the approved "Board" design — dense one-line rows grouped into compact blocks in a container-query reflowing grid (Critical + Low-stock side-by-side, Later/Done full-width collapsible below), a slim header + one-line summary + compact toolbar, and a rebuilt detail drawer — wired to our real data and handlers. Mobile is untouched.

**Architecture:** Port the design's bespoke CSS into a scoped stylesheet (`prep-board.css`, all selectors under a `.pb` root so it can't leak). Add a pure view-model mapper (`prep-board-utils.ts`) that turns a `PrepItemRich` into the fields the design markup needs. Build focused presentational components (`PrepRow`, `PrepBlock`, `PrepLater`, `PrepSummaryLine`, `PrepBoard`, `PrepBoardDrawer`) that consume the view-model and call existing page handlers via props. Swap the desktop renderers in `prep/page.tsx` for `<PrepBoard>` inside a `container-type:inline-size` wrapper; keep the mobile (`md:hidden`) renderers exactly as they are.

**Tech Stack:** Next.js 14 App Router, React, TypeScript, scoped plain CSS (container queries), existing Prep data/handlers.

**Reference design (read before implementing):** `/tmp/controla_handoff/controla-os/project/prep/` — `styles.css` (the visual spec), `app.js` (markup + behavior), `data.js` (shape). The board markup we replicate is `rowHTML`, `blockHTML`, `laterHTML`, `summaryHTML`, `renderBoard`, `openDrawer` in `app.js`.

**Build/verify note:** No unit tests in this repo — `npm run build` is the type-check. node is not on PATH; prefix commands with `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"`. **NEVER run `npm run build` while the dev server is running** (it corrupts `.next`); stop the preview server + `rm -rf .next` first, then restart. Browser verification uses the preview MCP tools with the real 38 prep items (DB is up).

---

## Field/handler mapping (the contract — used by every task)

Design field → our `PrepItemRich`:
- `urgency` `'critical'|'low'|'par'` ← `priority` `'911'|'NEEDED_TODAY'|'LATER'`
- `make` ← `suggestedQty` · `onHand`←`onHand` · `par`←`parLevel` · `unit`←`unit`
- `stockOut` ← `isBlocked || onHand <= 0`
- `overridden` ← `manualPriorityOverride != null`
- `status` (To Do) ← `todayLog?.status` (`NOT_STARTED|IN_PROGRESS|DONE|PARTIAL|BLOCKED|SKIPPED`) collapsed to `'not-started'|'in-progress'|'done'|'skipped'`
- `onList` ← `isOnList` · `cat`←`category` · `station`←`station` · `prepMin`←`estimatedPrepTime`

Existing page handlers (pass into `<PrepBoard>` as props):
- `onToggleOnList(id, bool)` ← `handleToggleOnList`
- `onAddAll(priority)` ← `handleAddAll`
- `onStatusChange(item, status, qty?)` ← `onRowStatusChange` (status strings: `'IN_PROGRESS'|'DONE'|'NOT_STARTED'|'SKIPPED'`)
- `onPriorityChange(id, priority)` ← `handlePriorityChange` (`'911'|'NEEDED_TODAY'|'LATER'|''`)
- `onOpen(item)` ← `openDrawer`
- `onOpenRecipe(item)` ← `openRecipeModal`

---

## File structure

- **Create** `src/app/prep/prep-board.css` — scoped port of the design's board/row/block/later/summary/toolbar/drawer/state CSS (NOT the shell/topbar/sidebar/demo — we have those). Every selector prefixed with `.pb`.
- **Create** `src/components/prep/board/prep-board-utils.ts` — `BoardRow` type + `toBoardRow()` + `boardSummary()` + label/order constants.
- **Create** `src/components/prep/board/PrepRow.tsx`
- **Create** `src/components/prep/board/PrepBlock.tsx`
- **Create** `src/components/prep/board/PrepLater.tsx`
- **Create** `src/components/prep/board/PrepSummaryLine.tsx`
- **Create** `src/components/prep/board/PrepBoard.tsx` — desktop orchestrator (both views + 3 groupings + reflow wrapper).
- **Create** `src/components/prep/board/PrepBoardDrawer.tsx` — rebuilt detail drawer matching the design.
- **Modify** `src/app/prep/page.tsx` — import `prep-board.css`; replace the desktop To-Do block (~1109–1160) and the desktop Smart-Prep block (~1163–1535) with `<div className="pb"> <PrepBoard …/> </div>`; compress the desktop header (~986–1046) to slim header; mount `<PrepBoardDrawer>` for desktop. Leave every `md:hidden` mobile block unchanged.

---

### Task 1: Scoped board stylesheet

**Files:**
- Create: `src/app/prep/prep-board.css`

- [ ] **Step 1: Port the design CSS, scoped**

Open the reference `/tmp/controla_handoff/controla-os/project/prep/styles.css`. Copy the rule blocks from the **`/* ══ BOARD ══ */` section through the end of the file** — i.e. these selector groups: `.board`, `.actionable`, `.block` (+ `.crit`/`.low` variants), `.bk-head`/`.bk-dot`/`.bk-title`/`.bk-meta`/`.bk-action`/`.bk-body`, `.dot-red/.dot-amber/.dot-green/.dot-gray`, `.row` and ALL its children (`.r-dot`, `.r-name`, `.nm`, `.cat`, `.tag*`, `.r-edit`, `.r-stock`, `.r-make*`, `.r-reveal*`, `.r-act`, `.act-*`, row status variants `.row.done/.skipped/.inprog`, `.r-status*`, `@keyframes pulse`, the `.row.inprog::after` underline), `.later*`, `.bk-empty*`, the detail drawer `.scrim`/`.drawer`/`.dr-*`/`.ovr-*`/`.steps`/`.step`/`.ing*`/`.hist*`, the state styles `.skel*`/`.page-empty*`/`.page-error*`/`.err-banner*`, `.toast*`, and `.grp-divider`/`.hidden`. Also copy the `.head`, `.tabs`, `.actions`/`.btn*`, `.summary*`, and `.toolbar`/`.search*`/`.ddown*`/`.seg*` rules from the "Slim header"/"Toolbar" sections.

DO NOT copy: `:root` token block (our Tailwind tokens already define these as CSS-less classes — instead, the ported file must use the literal hex values, see below), `*{box-sizing}`, `html,body`, `.shell`, `.topbar`, `.tb-*`, `.below`, `.side*`, `.nav-*`, `.demo*`.

**Scoping rule:** prefix every selector with `.pb ` (e.g. `.row{…}` → `.pb .row{…}`; `.block.crit .bk-head{…}` → `.pb .block.crit .bk-head{…}`; `@container (min-width:1260px){ .actionable{…} }` → `@container (min-width:1260px){ .pb .actionable{…} }`). For `.scrim`/`.drawer`/`.toast` (rendered at document root via portal-less fixed positioning) prefix with `.pb-` instead and rename the classes in markup to `pb-scrim`/`pb-drawer`/`pb-toast` so they work outside the `.pb` subtree — keep their internal child selectors (`.dr-*`) prefixed `.pb-drawer ` (e.g. `.pb-drawer .dr-head`).

**Token substitution:** the design uses `var(--ink)` etc. Our globals do NOT define those CSS variables. Add this single block at the TOP of `prep-board.css` so the `var(--…)` references resolve (values copied verbatim from the design `:root`, which already match our Tailwind tokens):

```css
.pb, .pb-scrim, .pb-drawer, .pb-toast {
  --bg:#fafaf9; --bg-2:#f4f4f5; --paper:#ffffff;
  --ink:#09090b; --ink-2:#27272a; --ink-3:#71717a; --ink-4:#a1a1aa;
  --line:#e4e4e7; --line-2:#d4d4d8;
  --gold:#d97706; --gold-2:#b45309; --gold-soft:#fef3c7;
  --red:#dc2626; --red-text:#b91c1c; --red-soft:#fee2e2;
  --green:#16a34a; --green-text:#15803d; --green-soft:#dcfce7;
}
.pb .mono{font-family:var(--font-geist-mono),'Geist Mono',ui-monospace,monospace;letter-spacing:-0.01em;}
```

Replace every `'Geist Mono'`/`'Geist'`/`'Fraunces'` font-family literal in the ported rules with the project font vars: `'Geist Mono'`→`var(--font-geist-mono),'Geist Mono',ui-monospace,monospace`; `'Geist'`→`var(--font-geist-sans),system-ui,sans-serif`; `'Fraunces',Georgia,serif`→`var(--font-fraunces),'Fraunces',Georgia,serif`.

- [ ] **Step 2: Build to confirm the CSS parses / page still builds**

Stop any preview server first. Run:
```
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && rm -rf .next && npm run build 2>&1 | grep -E "Compiled successfully|Failed|Type error"
```
Expected: the file isn't imported yet, so build is unaffected — `✓ Compiled successfully`. (We import it in Task 9.)

- [ ] **Step 3: Commit**
```bash
git add src/app/prep/prep-board.css
git commit -m "feat(prep): scoped board stylesheet (ported from approved design)"
```

---

### Task 2: View-model mapper

**Files:**
- Create: `src/components/prep/board/prep-board-utils.ts`

- [ ] **Step 1: Write the mapper + constants**

```ts
import type { PrepItemRich } from '@/components/prep/types'

export type Urgency = 'critical' | 'low' | 'par'
export type BoardStatus = 'not-started' | 'in-progress' | 'done' | 'skipped'

export interface BoardRow {
  id: string
  name: string
  cat: string
  station: string
  unit: string
  onHand: number
  par: number
  make: number
  urgency: Urgency
  stockOut: boolean
  overridden: boolean
  onList: boolean
  status: BoardStatus
  prepMin: number
  pct: number            // onHand/par as % (0–100+), for par display
  item: PrepItemRich     // escape hatch for handlers / drawer
}

const fmt = (n: number) => {
  const v = Number(n) || 0
  return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, '')
}
export const fmtQty = fmt

export function urgencyOf(item: PrepItemRich): Urgency {
  const eff = item.manualPriorityOverride ?? item.priority
  return eff === '911' ? 'critical' : eff === 'NEEDED_TODAY' ? 'low' : 'par'
}

export function statusOf(item: PrepItemRich): BoardStatus {
  const s = item.todayLog?.status
  if (s === 'IN_PROGRESS') return 'in-progress'
  if (s === 'DONE' || s === 'PARTIAL') return 'done'
  if (s === 'SKIPPED') return 'skipped'
  return 'not-started'
}

export function toBoardRow(item: PrepItemRich): BoardRow {
  const par = Number(item.parLevel) || 0
  const onHand = Number(item.onHand) || 0
  return {
    id: item.id,
    name: item.name,
    cat: item.category,
    station: item.station ?? '—',
    unit: item.unit,
    onHand,
    par,
    make: Number(item.suggestedQty) || 0,
    urgency: urgencyOf(item),
    stockOut: item.isBlocked || onHand <= 0,
    overridden: item.manualPriorityOverride != null,
    onList: item.isOnList,
    status: statusOf(item),
    prepMin: Number(item.estimatedPrepTime) || 0,
    pct: par > 0 ? Math.round((onHand / par) * 100) : 100,
    item,
  }
}

export function dotClass(u: Urgency) {
  return u === 'critical' ? 'dot-red' : u === 'low' ? 'dot-amber' : 'dot-green'
}

export function fmtMin(m: number): string {
  if (m >= 60) { const h = Math.floor(m / 60), mm = m % 60; return mm ? `${h}h ${mm}m` : `${h}h` }
  return `${m}m`
}

/** Total prep minutes for a block (skip par items, which need no make). */
export function totalMin(rows: BoardRow[]): number {
  return rows.reduce((a, r) => a + (r.make > 0 ? r.prepMin : 0), 0)
}

// Smart-prep category/station ordering (stable, known-categories first then alpha)
export const STATION_LABEL: Record<string, string> = {}
export function compareGroup(a: string, b: string) { return a.localeCompare(b) }
```

- [ ] **Step 2: Build to type-check**
```
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && rm -rf .next && npm run build 2>&1 | grep -E "Compiled successfully|Failed|Type error"
```
Expected: `✓ Compiled successfully` (compiles; not yet imported).

- [ ] **Step 3: Commit**
```bash
git add src/components/prep/board/prep-board-utils.ts
git commit -m "feat(prep): board view-model mapper"
```

---

### Task 3: PrepRow (dense one-line row)

**Files:**
- Create: `src/components/prep/board/PrepRow.tsx`

Replicates `rowHTML` from the design `app.js`, lines 23–80. Grid columns and classes come from `.pb .row` in the stylesheet.

- [ ] **Step 1: Write the component**

```tsx
'use client'
import type { PrepItemRich } from '@/components/prep/types'
import { BoardRow, dotClass, fmtQty } from './prep-board-utils'

export interface RowHandlers {
  view: 'todo' | 'smart'
  onOpen: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
  onToggleOnList: (id: string, next: boolean) => void
  onStatusChange: (item: PrepItemRich, status: string, qty?: number) => void
  onPriorityChange: (id: string, priority: string) => void
}

const Recipe = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4V4z"/><path d="M4 16a4 4 0 0 1 4-4h12"/></svg>)
const Prio = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 21V4M4 4h13l-2 4 2 4H4"/></svg>)
const More = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>)

export function PrepRow({ row, h }: { row: BoardRow; h: RowHandlers }) {
  const { item, urgency: u } = row
  const stock = (
    <>{row.onHand === 0 ? <span className="z">0</span> : fmtQty(row.onHand)} / {fmtQty(row.par)} <small>{row.unit}</small></>
  )
  const make = row.make > 0
    ? <span className={`r-make ${u === 'critical' ? 'crit' : 'low'}`}>make {fmtQty(row.make)}</span>
    : <span className="r-make par" style={row.pct > 100 ? { color: 'var(--green-text)' } : undefined}>{row.pct > 100 ? `+${row.pct - 100}%` : 'on par'}</span>

  let statusChip: React.ReactNode = null
  if (h.view === 'todo') {
    if (row.status === 'in-progress') statusChip = <span className="r-status prog"><span className="pdot" />IN PROGRESS</span>
    else if (row.status === 'done') statusChip = <span className="r-status done">✓ DONE</span>
    else if (row.status === 'skipped') statusChip = <span className="r-status" style={{ color: 'var(--ink-4)' }}>REMOVED</span>
  }

  let act: React.ReactNode
  if (h.view === 'smart') {
    if (row.onList) act = <button className="act-btn act-onlist" onClick={() => h.onToggleOnList(row.id, false)}>On list ✓</button>
    else act = <button className={`act-btn ${u === 'par' ? 'act-ghost' : 'act-add'}`} onClick={() => h.onToggleOnList(row.id, true)}><span className="ic">+</span> Add</button>
  } else {
    if (row.status === 'not-started') act = <button className="act-btn act-start" onClick={() => h.onStatusChange(item, 'IN_PROGRESS')}><span className="ic">▶</span> Start</button>
    else if (row.status === 'in-progress') act = <button className="act-btn act-done" onClick={() => h.onStatusChange(item, 'DONE')}>✓ Done</button>
    else if (row.status === 'done') act = <button className="act-btn act-ghost" onClick={() => h.onStatusChange(item, 'NOT_STARTED')}>↻ Reset</button>
    else act = <button className="act-btn act-ghost" onClick={() => h.onStatusChange(item, 'NOT_STARTED')}>↩ Restore</button>
  }

  const cls = `row${h.view === 'todo' && row.status === 'in-progress' ? ' inprog' : ''}${h.view === 'todo' && row.status === 'done' ? ' done' : ''}${h.view === 'todo' && row.status === 'skipped' ? ' skipped' : ''}`
  const progStyle = h.view === 'todo' && row.status === 'in-progress' ? ({ ['--pw' as string]: `${Math.max(8, row.pct)}%` } as React.CSSProperties) : undefined

  return (
    <div className={cls} style={progStyle}>
      <span className={`r-dot ${dotClass(u)}`} />
      <span className="r-name">
        <span className="nm" onClick={() => h.onOpen(item)}>{row.name}</span>
        {row.stockOut && <span className="tag out">STOCK OUT</span>}
        {row.overridden && <span className="r-edit" title="Priority overridden by chef">✎</span>}
        {statusChip}
      </span>
      <span className="r-stock">{stock}</span>
      <span className="r-make-cell" style={{ textAlign: 'right' }}>{make}</span>
      <span className="r-reveal">
        <button onClick={() => h.onOpenRecipe(item)} title="View recipe"><Recipe /></button>
        <button onClick={() => h.onOpen(item)} title="Change priority"><Prio /></button>
        <button onClick={() => h.onOpen(item)} title="More"><More /></button>
      </span>
      <span className="r-act">{act}</span>
    </div>
  )
}
```

- [ ] **Step 2: Build to type-check** (same command as Task 2 step 2). Expected `✓ Compiled successfully`.
- [ ] **Step 3: Commit**
```bash
git add src/components/prep/board/PrepRow.tsx
git commit -m "feat(prep): dense board row component"
```

---

### Task 4: PrepBlock (group card)

**Files:**
- Create: `src/components/prep/board/PrepBlock.tsx`

Replicates `blockHTML` (design `app.js` 83–110).

- [ ] **Step 1: Write the component**

```tsx
'use client'
import { BoardRow, fmtMin, totalMin } from './prep-board-utils'
import { PrepRow, RowHandlers } from './PrepRow'

const Check = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="20 6 9 17 4 12"/></svg>)

export interface BlockProps {
  kind: 'crit' | 'low' | ''
  title: string
  rows: BoardRow[]
  h: RowHandlers
  addAll?: boolean
  emptyText?: string
  onAddAll?: () => void
}

export function PrepBlock({ kind, title, rows, h, addAll, emptyText, onAddAll }: BlockProps) {
  const mins = totalMin(rows)
  const meta = rows.length ? `· ${rows.length} item${rows.length > 1 ? 's' : ''}${mins ? ` · ~${fmtMin(mins)}` : ''}` : ''
  const dotCls = kind === 'crit' ? 'dot-red' : kind === 'low' ? 'dot-amber' : 'dot-gray'
  const showAddAll = addAll && rows.some(r => !r.onList) && rows.length > 0
  return (
    <div className={`block ${kind}`}>
      <div className="bk-head">
        <span className={`bk-dot ${dotCls}`} />
        <span className="bk-title">{title}</span>
        <span className="bk-meta" dangerouslySetInnerHTML={{ __html: meta.replace(/~([\dhm ]+)/, '<b>~$1</b>') }} />
        {showAddAll && <button className="bk-action" onClick={onAddAll}>+ Add all</button>}
      </div>
      <div className="bk-body">
        {rows.length === 0 ? (
          <div className="bk-empty">
            <div className="ei"><Check /></div>
            <div className="et">{emptyText || 'All clear'}</div>
            <div className="es">Nothing needs prepping here.</div>
          </div>
        ) : rows.map(r => <PrepRow key={r.id} row={r} h={h} />)}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Build to type-check.** Expected `✓ Compiled successfully`.
- [ ] **Step 3: Commit**
```bash
git add src/components/prep/board/PrepBlock.tsx
git commit -m "feat(prep): board group block component"
```

---

### Task 5: PrepLater (full-width collapsible)

**Files:**
- Create: `src/components/prep/board/PrepLater.tsx`

Replicates `laterHTML` (design `app.js` 113–128) and the To-Do "DONE / REMOVED" variant (175–186).

- [ ] **Step 1: Write the component**

```tsx
'use client'
import { useState } from 'react'
import { BoardRow } from './prep-board-utils'
import { PrepRow, RowHandlers } from './PrepRow'

export interface LaterProps {
  variant: 'par' | 'closed'
  rows: BoardRow[]
  h: RowHandlers
}

export function PrepLater({ variant, rows, h }: LaterProps) {
  const [open, setOpen] = useState(false)
  const title = variant === 'par' ? 'ON PAR / LATER' : 'DONE / REMOVED'
  const meta = variant === 'par' ? '· at or above par — no action needed' : "· completed or taken off today's list"
  return (
    <div className={`later${open ? ' open' : ''}`}>
      <div className="later-strip" onClick={() => setOpen(o => !o)}>
        <span className="chev">▶</span>
        <span className="lt" style={{ color: 'var(--green-text)' }}>{title}</span>
        <span className="lmeta">{meta}</span>
        <span className="lcount">{rows.length} ITEMS {open ? '· COLLAPSE' : '· EXPAND'}</span>
      </div>
      <div className="later-body">
        <div className="later-grid">{rows.map(r => <PrepRow key={r.id} row={r} h={h} />)}</div>
        {variant === 'par' && <div className="later-note">ADD MANUALLY ONLY IF YOU HAVE AN EVENT OR KNOW SOMETHING THE SYSTEM DOESN&apos;T</div>}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Build.** Expected `✓ Compiled successfully`.
- [ ] **Step 3: Commit**
```bash
git add src/components/prep/board/PrepLater.tsx
git commit -m "feat(prep): board Later/Done collapsible component"
```

---

### Task 6: PrepSummaryLine

**Files:**
- Create: `src/components/prep/board/PrepSummaryLine.tsx`

Replicates `summaryHTML` (design `app.js` 131–157), but computed from real items.

- [ ] **Step 1: Write the component**

```tsx
'use client'
import type { PrepItemRich } from '@/components/prep/types'
import { toBoardRow } from './prep-board-utils'

const Info = () => (<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>)
const Chart = () => (<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>)

export function PrepSummaryLine({ items, view }: { items: PrepItemRich[]; view: 'todo' | 'smart' }) {
  const rows = items.map(toBoardRow)
  const crit = rows.filter(r => r.urgency === 'critical').length
  const low = rows.filter(r => r.urgency === 'low').length
  const par = rows.filter(r => r.urgency === 'par').length

  if (view === 'todo') {
    const list = rows.filter(r => r.onList)
    const done = list.filter(r => r.status === 'done').length
    const blocked = list.filter(r => r.stockOut).length
    const removed = list.filter(r => r.status === 'skipped').length
    return (
      <div className="summary">
        <span className="s"><b>{done}/{list.length}</b> done</span>
        <span className="s crit"><span className="dot dot-red" /><b>{list.filter(r => r.urgency === 'critical').length}</b> critical</span>
        <span className="s low"><b>{blocked}</b> blocked on stock</span>
        <span className="s"><b>{removed}</b> removed</span>
        <span className="hint"><Info /> carries over daily until done or removed</span>
      </div>
    )
  }
  return (
    <div className="summary">
      <span className="s"><b>{rows.length}</b> active</span>
      <span className="s crit"><span className="dot dot-red" /><b>{crit}</b> critical</span>
      <span className="s low"><span className="dot dot-amber" /><b>{low}</b> low / needed today</span>
      <span className="s par"><span className="dot dot-green" /><b>{par}</b> on par</span>
      <span className="hint"><Chart /> computed live from theoretical stock · resets at next count</span>
    </div>
  )
}
```

- [ ] **Step 2: Build.** Expected `✓ Compiled successfully`.
- [ ] **Step 3: Commit**
```bash
git add src/components/prep/board/PrepSummaryLine.tsx
git commit -m "feat(prep): board one-line summary"
```

---

### Task 7: PrepBoard (desktop orchestrator + reflow)

**Files:**
- Create: `src/components/prep/board/PrepBoard.tsx`

Replicates `renderBoard` (design `app.js` 160–217). Renders `.actionable` grid + Later. The container-query reflow comes from the `.pb` CSS once the parent wrapper sets `container-type:inline-size` (done in Task 9).

- [ ] **Step 1: Write the component**

```tsx
'use client'
import type { PrepItemRich } from '@/components/prep/types'
import { toBoardRow, BoardRow } from './prep-board-utils'
import { PrepBlock } from './PrepBlock'
import { PrepLater } from './PrepLater'
import { RowHandlers } from './PrepRow'

export interface PrepBoardProps {
  view: 'todo' | 'smart'
  groupBy: 'urgency' | 'category' | 'station'
  items: PrepItemRich[]          // already RC/active-filtered by the page
  todayItems: PrepItemRich[]     // isOnList items (for To Do)
  handlers: Omit<RowHandlers, 'view'>
  onAddAll: (priority: '911' | 'NEEDED_TODAY') => void
}

export function PrepBoard({ view, groupBy, items, todayItems, handlers, onAddAll }: PrepBoardProps) {
  const h: RowHandlers = { ...handlers, view }

  if (view === 'todo') {
    const list = todayItems.map(toBoardRow)
    const crit = list.filter(r => r.urgency === 'critical' && r.status !== 'done' && r.status !== 'skipped')
    const low = list.filter(r => r.urgency !== 'critical' && r.status !== 'done' && r.status !== 'skipped')
    const closed = list.filter(r => r.status === 'done' || r.status === 'skipped')
    return (
      <div className="board">
        <div className="actionable">
          <PrepBlock kind="crit" title="CRITICAL" rows={crit} h={h} emptyText="No critical items" />
          <PrepBlock kind="low" title="NEEDED TODAY" rows={low} h={h} emptyText="All par levels met" />
        </div>
        <PrepLater variant="closed" rows={closed} h={h} />
      </div>
    )
  }

  // SMART PREP
  const rows = items.map(toBoardRow)
  if (groupBy === 'urgency') {
    const crit = rows.filter(r => r.urgency === 'critical')
    const low = rows.filter(r => r.urgency === 'low')
    const par = rows.filter(r => r.urgency === 'par')
    return (
      <div className="board">
        <div className="actionable">
          <PrepBlock kind="crit" title="CRITICAL" rows={crit} h={h} addAll onAddAll={() => onAddAll('911')} />
          <PrepBlock kind="low" title="LOW STOCK / NEEDED TODAY" rows={low} h={h} addAll onAddAll={() => onAddAll('NEEDED_TODAY')} />
        </div>
        <PrepLater variant="par" rows={par} h={h} />
      </div>
    )
  }

  // category / station grouping → tri grid of tinted blocks
  const keyOf = (r: BoardRow) => (groupBy === 'category' ? r.cat : r.station)
  const groupKeys = Array.from(new Set(rows.map(keyOf))).sort((a, b) => a.localeCompare(b))
  return (
    <div className="board">
      <div className="actionable tri">
        {groupKeys.map(g => {
          const grp = rows.filter(r => keyOf(r) === g)
          const hasCrit = grp.some(r => r.urgency === 'critical')
          const hasLow = grp.some(r => r.urgency === 'low')
          const kind = hasCrit ? 'crit' : hasLow ? 'low' : ''
          return <PrepBlock key={g} kind={kind} title={g.toUpperCase()} rows={grp} h={h} addAll={hasCrit || hasLow} onAddAll={() => onAddAll(hasCrit ? '911' : 'NEEDED_TODAY')} />
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Build.** Expected `✓ Compiled successfully`.
- [ ] **Step 3: Commit**
```bash
git add src/components/prep/board/PrepBoard.tsx
git commit -m "feat(prep): desktop board orchestrator (todo + smart, 3 groupings)"
```

---

### Task 8: PrepBoardDrawer (rebuilt detail drawer)

**Files:**
- Create: `src/components/prep/board/PrepBoardDrawer.tsx`

Replicates `openDrawer` (design `app.js` 262–331) using our `PrepItemDetail`. Steps/ingredients/history degrade gracefully when absent.

- [ ] **Step 1: Write the component**

```tsx
'use client'
import { useEffect, useState } from 'react'
import type { PrepItemRich, PrepItemDetail } from '@/components/prep/types'
import { toBoardRow, dotClass, fmtMin, fmtQty } from './prep-board-utils'

const X = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>)

export interface DrawerProps {
  item: PrepItemRich | null
  view: 'todo' | 'smart'
  onClose: () => void
  onToggleOnList: (id: string, next: boolean) => void
  onStatusChange: (item: PrepItemRich, status: string) => void
  onPriorityChange: (id: string, priority: string) => void
}

export function PrepBoardDrawer({ item, view, onClose, onToggleOnList, onStatusChange, onPriorityChange }: DrawerProps) {
  const [detail, setDetail] = useState<PrepItemDetail | null>(null)
  const [steps, setSteps] = useState<string[]>([])

  useEffect(() => {
    setDetail(null); setSteps([])
    if (!item) return
    let cancelled = false
    ;(async () => {
      try {
        const d = await fetch(`/api/prep/items/${item.id}`).then(r => r.ok ? r.json() : null)
        if (!cancelled && d) setDetail(d)
      } catch { /* ignore */ }
      if (item.linkedRecipeId) {
        try {
          const r = await fetch(`/api/recipes/${item.linkedRecipeId}`).then(r => r.ok ? r.json() : null)
          const arr: string[] = Array.isArray(r?.steps) ? r.steps.map(String)
            : (typeof r?.notes === 'string' ? r.notes.replace(/^\s*(instructions?|method|steps)\s*:?\s*/i, '').split(/\n+|(?=\d+[.)]\s)/).map((s: string) => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean) : [])
          if (!cancelled) setSteps(arr)
        } catch { /* ignore */ }
      }
    })()
    return () => { cancelled = true }
  }, [item])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const open = !!item
  const r = item ? toBoardRow(item) : null
  const u = r?.urgency ?? 'par'
  const uLabel = u === 'critical' ? 'CRITICAL' : u === 'low' ? 'NEEDED TODAY' : 'ON PAR'
  const barColor = u === 'critical' ? 'var(--red)' : u === 'low' ? 'var(--gold)' : 'var(--green)'
  const rationale = r
    ? (r.make > 0
        ? `${fmtQty(r.onHand)} ${r.unit} on hand against a ${fmtQty(r.par)} par — system suggests making ${fmtQty(r.make)} ${r.unit} to cover through the next count.`
        : `At or above par (${r.pct}%). No make needed right now; the board updates as sales and wastage move stock.`)
    : ''

  return (
    <>
      <div className={`pb-scrim${open ? ' show' : ''}`} onClick={onClose} />
      <aside className={`pb-drawer${open ? ' show' : ''}`}>
        {r && item && (
          <>
            <div className="dr-head">
              <div className="dr-top">
                <div>
                  <div className="dr-cat"><span className={`r-dot ${dotClass(u)}`} style={{ display: 'inline-block' }} /> {r.cat.toUpperCase()} · {r.station} · {uLabel}</div>
                  <div className="dr-title">{r.name}</div>
                </div>
                <button className="dr-close" onClick={onClose}><X /></button>
              </div>
              <div className="dr-chips">
                {r.stockOut && <span className="tag out">STOCK OUT</span>}
                {r.overridden && <span className="tag ovr">✎ CHEF OVERRIDE</span>}
                <span className="tag station">{r.station}</span>
                {r.prepMin > 0 && <span className="tag station">~{fmtMin(r.prepMin)} PREP</span>}
              </div>
            </div>
            <div className="dr-body">
              <div className="dr-sec">
                <div className="dr-suggest">
                  {r.make > 0
                    ? <span className={`big ${u === 'critical' ? 'crit' : 'low'}`}>make {fmtQty(r.make)} {r.unit}</span>
                    : <span className="big" style={{ color: 'var(--green-text)' }}>At par — no make needed</span>}
                  <div className="rat">{rationale}</div>
                </div>
                <div className="dr-barlbl"><span><b>{fmtQty(r.onHand)}</b> / {fmtQty(r.par)} {r.unit} on hand</span><span>{r.pct}% of par</span></div>
                <div className="dr-bar"><div className="fill" style={{ width: `${Math.max(2, Math.min(100, r.pct))}%`, background: barColor }} /></div>
              </div>

              <div className="dr-sec">
                <div className="sl">Priority override</div>
                <div className="ovr-row">
                  <button className={`ovr-btn crit ${u === 'critical' ? 'on' : ''}`} onClick={() => onPriorityChange(r.id, '911')}>Critical</button>
                  <button className={`ovr-btn low ${u === 'low' ? 'on' : ''}`} onClick={() => onPriorityChange(r.id, 'NEEDED_TODAY')}>Needed today</button>
                  <button className={`ovr-btn par ${u === 'par' ? 'on' : ''}`} onClick={() => onPriorityChange(r.id, 'LATER')}>Later</button>
                </div>
              </div>

              {steps.length > 0 && (
                <div className="dr-sec">
                  <div className="sl">Method · {steps.length} steps</div>
                  <div className="steps">{steps.map((s, n) => <div className="step" key={n}><span className="n">{n + 1}</span><span>{s}</span></div>)}</div>
                </div>
              )}

              {detail?.ingredients && detail.ingredients.length > 0 && (
                <div className="dr-sec">
                  <div className="sl">Ingredients</div>
                  <div>{detail.ingredients.map(ing => {
                    const short = ing.isAvailable === false
                    return <div className="ing" key={ing.id}><span>{ing.itemName}</span><span className={`iq ${short ? 'short' : ''}`}>{fmtQty(ing.qtyBase)} {ing.unit}{short ? ' · short' : ''}</span></div>
                  })}</div>
                </div>
              )}

              {item.lastMadeAt && (
                <div className="dr-sec">
                  <div className="sl">Recent history</div>
                  <div><div className="hist"><span>Last made</span><span>{new Date(item.lastMadeAt).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase()}</span><span style={{ color: 'var(--green-text)' }}>DONE</span></div></div>
                </div>
              )}
            </div>
            <div className="dr-foot">
              {view === 'smart'
                ? (r.onList ? <button className="btn" onClick={onClose}>On today&apos;s list ✓</button> : <button className="btn btn-primary" onClick={() => { onToggleOnList(r.id, true); onClose() }}><span className="ic">+</span> Add to today</button>)
                : (r.status === 'not-started' ? <button className="btn btn-primary" onClick={() => { onStatusChange(item, 'IN_PROGRESS'); onClose() }}><span className="ic">▶</span> Start prep</button>
                  : r.status === 'in-progress' ? <button className="btn btn-primary" onClick={() => { onStatusChange(item, 'DONE'); onClose() }}><span className="ic">✓</span> Mark done</button>
                  : <button className="btn" onClick={onClose}>Close</button>)}
            </div>
          </>
        )}
      </aside>
    </>
  )
}
```

- [ ] **Step 2: Build.** Expected `✓ Compiled successfully`.
- [ ] **Step 3: Commit**
```bash
git add src/components/prep/board/PrepBoardDrawer.tsx
git commit -m "feat(prep): rebuilt detail drawer matching board design"
```

---

### Task 9: Wire the board into the desktop page

**Files:**
- Modify: `src/app/prep/page.tsx`

- [ ] **Step 1: Add imports + the board CSS**

At the top of `src/app/prep/page.tsx`, with the other imports:
```tsx
import './prep-board.css'
import { PrepBoard } from '@/components/prep/board/PrepBoard'
import { PrepSummaryLine } from '@/components/prep/board/PrepSummaryLine'
import { PrepBoardDrawer } from '@/components/prep/board/PrepBoardDrawer'
```

- [ ] **Step 2: Replace the desktop content (To-Do + Smart-Prep desktop blocks) with the board**

Find the shared content region that renders the desktop To-Do block (`hidden md:block` around the critical/needed `PrepTaskRow` list, ~lines 1109–1160) and the entire desktop Smart-Prep block (the `hidden md:*` KPI grid + toolbar + urgency/category/station renders, ~lines 1163–1535). Replace BOTH desktop blocks with a single desktop board region (leave the `md:hidden` mobile blocks that interleave them untouched):

```tsx
{/* ── Desktop board (To Do + Smart Prep) ── */}
{viewMode !== 'history' && (
  <div className="pb hidden md:block" style={{ containerType: 'inline-size' }}>
    <PrepSummaryLine items={items} view={viewMode === 'today' ? 'todo' : 'smart'} />
    <PrepBoard
      view={viewMode === 'today' ? 'todo' : 'smart'}
      groupBy={smartPrepView}
      items={filteredToday.length || search || filterCategory !== 'ALL' || filterStation !== 'ALL' ? filteredToday : items}
      todayItems={todayItems}
      handlers={{
        onOpen: openDrawer,
        onOpenRecipe: openRecipeModal,
        onToggleOnList: handleToggleOnList,
        onStatusChange: onRowStatusChange,
        onPriorityChange: handlePriorityChange,
      }}
      onAddAll={handleAddAll}
    />
  </div>
)}
```

Note: for Smart Prep, the board should show ALL active items (`items`) filtered by the page's category/station/search filters. The page already computes `filteredToday` for the To-Do list; add a parallel `filteredSmart` memo right after `filteredToday` (around line 275):

```tsx
const filteredSmart = useMemo(() => {
  return items.filter(item => {
    if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterCategory !== 'ALL' && item.category !== filterCategory) return false
    if (filterStation === 'UNASSIGNED') { if (item.station) return false }
    else if (filterStation !== 'ALL') { if (item.station !== filterStation) return false }
    return true
  })
}, [items, search, filterCategory, filterStation])
```

Then pass `items={viewMode === 'today' ? todayItems : filteredSmart}` is NOT needed — instead pass `items={filteredSmart}` and `todayItems={filteredToday}` so both views respect filters:

```tsx
    <PrepBoard
      view={viewMode === 'today' ? 'todo' : 'smart'}
      groupBy={smartPrepView}
      items={filteredSmart}
      todayItems={filteredToday}
      handlers={{ onOpen: openDrawer, onOpenRecipe: openRecipeModal, onToggleOnList: handleToggleOnList, onStatusChange: onRowStatusChange, onPriorityChange: handlePriorityChange }}
      onAddAll={handleAddAll}
    />
```

- [ ] **Step 3: Mount the rebuilt drawer for desktop**

The page already has `drawerItem`/`openDrawer`/`closeDrawer` state. Where the existing desktop drawer (`PrepDrawer`/`PrepDetailPanel`) is rendered, add the new one for desktop. Add near the other drawer/portal mounts at the end of the returned JSX:

```tsx
<div className="hidden md:block">
  <PrepBoardDrawer
    item={drawerItem}
    view={viewMode === 'today' ? 'todo' : 'smart'}
    onClose={closeDrawer}
    onToggleOnList={handleToggleOnList}
    onStatusChange={(item, status) => onRowStatusChange(item, status)}
    onPriorityChange={handlePriorityChange}
  />
</div>
```

If a previous desktop `PrepDrawer`/`PrepDetailPanel` is rendered unconditionally, wrap it in `md:hidden` (or remove its desktop usage) so the two drawers don't both show on desktop. Verify by grepping for `PrepDrawer`/`PrepDetailPanel` usage in the page and gating the desktop instance to mobile-only.

- [ ] **Step 4: Compress the desktop header**

In the `hidden md:block` desktop header (~986–1046), keep the title/crumb/tabs/actions but DROP the now-duplicated content the board owns: remove the desktop KPI strip (`hidden md:grid` 4-card strip ~1163–1232) and the desktop Smart-Prep toolbar/view-switcher (~1234–1297) since the board region now renders the one-line summary; keep the SEARCH + category/station/active-only + GROUP switcher as a compact `.toolbar` ABOVE the board. Move/rebuild that toolbar using the design `.toolbar` markup, wired to `search/setSearch`, `filterCategory`, `filterStation`, `activeOnly`, and `smartPrepView` (group switch shown only when `viewMode==='smartprep'`):

```tsx
<div className="pb hidden md:block">
  <div className="toolbar">
    <div className="search"><span className="icn">{/* search svg */}</span>
      <input placeholder="Search prep items, recipes, stations…" value={search} onChange={e => setSearch(e.target.value)} />
    </div>
    <select className="ddown" value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>{/* All categories + categories */}</select>
    <select className="ddown" value={filterStation} onChange={e => setFilterStation(e.target.value)}>{/* All stations + stations */}</select>
    <button className="ddown" onClick={() => setActiveOnly(a => !a)}><span className="cb">{activeOnly ? '✓' : ''}</span> Active only</button>
    {viewMode === 'smartprep' && (
      <div className="seg" style={{ marginLeft: 'auto' }}>
        {(['urgency','category','station'] as const).map(g => (
          <div key={g} className={`s${smartPrepView === g ? ' active' : ''}`} onClick={() => setSmartPrepView(g)}>{g[0].toUpperCase()+g.slice(1)}</div>
        ))}
      </div>
    )}
  </div>
</div>
```

(Keep the existing `<select>`s if simpler than restyling — the `.ddown` look is nice-to-have; the dense board is the priority. Native selects styled with `.ddown` are acceptable.)

- [ ] **Step 5: Build to type-check (server stopped)**
```
export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" && rm -rf .next && npm run build 2>&1 | grep -E "Compiled successfully|Failed|Type error"
```
Expected: `✓ Compiled successfully`.

- [ ] **Step 6: Commit**
```bash
git add src/app/prep/page.tsx
git commit -m "feat(prep): wire dense board + summary + drawer into desktop prep page"
```

---

### Task 10: Browser verification (real data)

**Files:** none.

- [ ] **Step 1:** Start preview (`preview_start`), set viewport 1280×800, navigate `/prep`. Confirm DB up (38 items). `preview_console_logs` (errors expected: none).
- [ ] **Step 2: To Do board.** `preview_screenshot`: CRITICAL + NEEDED side-by-side dense blocks; DONE/REMOVED collapsible below; far more than 2 items visible. Click a row name → drawer opens with suggestion/par/override/steps/ingredients. Click ▶ Start on a not-started row → becomes in-progress (gold underline + IN PROGRESS); ✓ Done → moves to DONE block.
- [ ] **Step 3: Smart Prep.** Click "Smart prep" tab. Urgency grouping: CRITICAL + LOW STOCK blocks side-by-side, ON PAR/LATER collapsible. Click "+ Add all" → items get "On list ✓". Switch GROUP → Category and Station: tinted blocks in the `tri` grid.
- [ ] **Step 4: Reflow.** With nav summoned (pin the sidebar via the top-bar tab) the content narrows → board reflows from 2 columns to 1 (`@container` < 1260px). `preview_screenshot` both states.
- [ ] **Step 5: States.** Temporarily nothing to add — verify empty To-Do (no `isOnList` items) shows board with empty CRITICAL/NEEDED blocks ("No critical items"/"All par levels met").
- [ ] **Step 6: Mobile untouched.** Resize 390×844 → the mobile renderers (cards/compact rows) still show; the `.pb hidden md:block` board is hidden; no board leakage.
- [ ] **Step 7: Final build + commit any fixes.** Stop server, `rm -rf .next`, `npm run build` → PASS. Restart server.

---

## Self-Review notes
- **Spec coverage:** board grid + reflow (Task 1 CSS `@container`, Task 7), dense row all states (Task 3), blocks + empty + Add-all (Task 4), Later/Done collapsible (Task 5), one-line summary (Task 6), slim header/compact toolbar (Task 9 step 4), rebuilt drawer (Task 8), all wired to real data/handlers (Tasks 7/9), mobile untouched (Task 9 gating + Task 10 step 6). ✓
- **Type consistency:** `RowHandlers` (view + 5 callbacks) defined in Task 3, consumed Tasks 4/5/7; `BoardRow`/`toBoardRow`/`dotClass`/`fmtMin`/`fmtQty`/`totalMin` defined Task 2, used 3–8; `PrepBoardProps`/`onAddAll(priority)` consistent Task 7 ↔ Task 9. ✓
- **Status strings** passed to `onRowStatusChange` are the Prisma `PrepStatus` values (`IN_PROGRESS`/`DONE`/`NOT_STARTED`/`SKIPPED`) — matches `handleStatusChange`. ✓
- **Scoping:** all board CSS under `.pb`; drawer/scrim/toast under `.pb-*` so they work as document-level fixed elements. Mobile blocks never get `.pb`. ✓
