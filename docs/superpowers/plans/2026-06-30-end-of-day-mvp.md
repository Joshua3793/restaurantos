# End-of-Day Page (MVP — read-only recap) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give End-of-day its own route again — a nightly "close the day" recap at `/end-of-day` — shipping the full page layout with the read-only recap wired to real data (net sales, food cost, top/slow sellers, waste + price flags), and everything that needs new subsystems (checklist, sign-off gate, prep/order drafting, labour, forecast) rendered as clearly-labelled placeholders for later phases.

**Architecture:** New client page `src/app/end-of-day/page.tsx` following the app's dual-renderer + PageHead + cost-chrome conventions. One new read-only API route `/api/eod/summary` aggregates today's sales/covers/food-cost, top & slow menu movers (`SaleLineItem.qtySold`), and waste/price flags (`WastageLog` + `PriceAlert`). Nav links on `/pass` and the middleware role gate are repointed from `/reports` to `/end-of-day`. `/reports` stays exactly as-is (analytics). No schema changes in this MVP.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma/PostgreSQL · Tailwind (flat color tokens) · Lucide icons. No test suite — `npm run build` is the correctness check; visual verification via the preview server.

**Design source of truth:** `docs/design-refs/end-of-day.design.html` (rendered layout) and `docs/design-refs/end-of-day.behavior.js` (Phase 2/3 interaction logic — reference only; not built in MVP). Transcribe markup from the design file, substituting the token map below.

---

## Scope (locked with product owner 2026-06-30)

- **Build now:** MVP = read-only recap. Full page *layout* ships; only the recap data is live.
- **Labour KPI + all "vs forecast" comparisons:** render as **static placeholders** (real data wired in a later phase). Mark them visually as estimates so no one mistakes them for live numbers.
- **Closing checklist:** deferred to Phase 2 and will be **DB-backed / admin-editable** (do NOT hard-code it as a permanent solution). In MVP the checklist + gate render as a static placeholder block.
- **Not in MVP (placeholder blocks only):** closing checklist, temperature logs, gate ring / "Close the day" sign-off, prep-for-tomorrow queue, order suggestions / draft PO, 86 board, handover persistence, daypart breakdown, comps/voids/discounts in the day summary.

## Token map (design CSS var → repo Tailwind flat token)

Per `project_tailwind_color_tokens` memory — numbered classes (`bg-red-500`) are broken; use flat tokens.

| Design | Repo class |
|---|---|
| `var(--gold)` | `text-gold` / `bg-gold` |
| `var(--gold-2)` | `text-gold-2` |
| `var(--red)` | `bg-red` (or `stroke-red` inline) |
| `var(--red-text)` | `text-red-text` |
| `var(--green-text)` | `text-green-text` |
| `var(--blue)` | `bg-blue` |
| `var(--bg-2)` | `bg-bg-2` |
| `var(--ink)` / `ink-2` / `ink-3` | `text-ink` / `text-ink-2` / `text-ink-3` |
| `var(--line)` | `border-line` |
| `var(--paper)` | `bg-paper` |
| menu swatches `--m-sig/--m-hand/--m-sweets` | neutral `bg-gold` / `bg-ink-4` for MVP |

Card shell used throughout (matches `reports/page.tsx`): `bg-paper border border-line rounded-[12px] overflow-hidden`. Card header: `flex items-center justify-between px-[18px] py-3 border-b border-line bg-bg-2`.

## File structure

- **Create** `src/app/api/eod/summary/route.ts` — read-only aggregate: today's sales/covers/food-cost + top/slow movers + waste/price flags. `export const dynamic = 'force-dynamic'`.
- **Create** `src/app/end-of-day/page.tsx` — the page (client component); orchestrates fetch + layout. Sub-components defined at **module scope** (per CLAUDE.md — inner components remount and lose focus).
- **Create** `src/app/end-of-day/eod-components.tsx` — presentational sub-components (`EodKpiRow`, `DayInReview`, `MoversCard`, `FlagsCard`, `CloseRail`, `LoopStrip`) to keep the page file focused.
- **Modify** `src/middleware.ts:11` — add `/end-of-day` to `MANAGER_PREFIXES`.
- **Modify** `src/app/pass/page.tsx:254` and `:269` — repoint the SubNav tab + header action Link to `/end-of-day`.

---

### Task 1: Repoint navigation + role gate to `/end-of-day`

**Files:**
- Modify: `src/middleware.ts:11`
- Modify: `src/app/pass/page.tsx:254`, `src/app/pass/page.tsx:269`

- [ ] **Step 1: Add the route to the MANAGER gate**

In `src/middleware.ts`, change line 11 from:

```ts
const MANAGER_PREFIXES = ['/reports', '/pass', '/cost', '/variance', '/signals']
```

to:

```ts
const MANAGER_PREFIXES = ['/reports', '/pass', '/cost', '/variance', '/signals', '/end-of-day']
```

- [ ] **Step 2: Repoint the Pass SubNav tab**

In `src/app/pass/page.tsx`, change the tab at line 254 from `{ href: '/reports', label: 'End-of-day', icon: <Clock size={14} /> }` to:

```tsx
          { href: '/end-of-day', label: 'End-of-day', icon: <Clock size={14} /> },
```

- [ ] **Step 3: Repoint the Pass header action link**

In `src/app/pass/page.tsx`, change the `<Link href="/reports" …>` at line 269 (the one whose body is `<Clock size={13} … /> End-of-day`) so its `href` is `/end-of-day`. Leave the other `/reports` reference in `sub` (weekly food sales) untouched.

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: PASS. `/end-of-day` will 404 at this point (page not created yet) — that's fine; the build only compiles.

- [ ] **Step 5: Commit**

```bash
git add src/middleware.ts src/app/pass/page.tsx
git commit -m "feat(eod): repoint Pass nav + role gate to /end-of-day"
```

---

### Task 2: `/api/eod/summary` read-only aggregate route

**Files:**
- Create: `src/app/api/eod/summary/route.ts`

Returns today's recap. "Today" = the LA-local calendar day, parsed at UTC boundaries the same way `reports/dashboard` does (sales `date` is stored date-only → UTC midnight). RC scope via `?rcId=&isDefault=&locationId=` mirrors `reports/dashboard`.

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveLocationRcIds } from '@/lib/rc-scope'

export const dynamic = 'force-dynamic'

// Today's UTC-boundary window. Sales `date` is stored date-only (UTC midnight), so
// we bracket the current calendar day at UTC to match — same convention as
// reports/dashboard's from/to parsing.
function todayWindow() {
  const now = new Date()
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return { gte: new Date(`${ymd}T00:00:00.000Z`), lte: new Date(`${ymd}T23:59:59.999Z`) }
}

export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const rcId = searchParams.get('rcId') || ''
  const locationId = searchParams.get('locationId')
  const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null
  const rcFilter = locRcIds
    ? { revenueCenterId: { in: locRcIds } }
    : rcId ? { revenueCenterId: rcId } : {}

  const win = todayWindow()

  const [sales, waste, priceAlerts] = await Promise.all([
    prisma.salesEntry.findMany({
      where: { date: win, ...rcFilter },
      select: {
        totalRevenue: true, foodSalesPct: true, covers: true,
        lineItems: {
          select: {
            qtySold: true,
            recipe: { select: { id: true, name: true, menuPrice: true } },
          },
        },
      },
    }),
    prisma.wastageLog.findMany({
      where: { date: win, ...rcFilter },
      orderBy: { costImpact: 'desc' },
      take: 6,
      select: {
        id: true, qtyWasted: true, unit: true, reason: true,
        costImpact: true, loggedBy: true,
        inventoryItem: { select: { itemName: true } },
      },
    }),
    prisma.priceAlert.findMany({
      where: { createdAt: win },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: { id: true, itemName: true, percentChange: true, oldPrice: true, newPrice: true },
    }),
  ])

  // ── Headline numbers ──────────────────────────────────────────────────────
  const netSales = sales.reduce((s, e) => s + Number(e.totalRevenue), 0)
  const foodSales = sales.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
  const covers = sales.reduce((s, e) => s + (e.covers ?? 0), 0)
  // Food cost $ today = today's approved purchases (numerator basis used elsewhere).
  const purchases = await prisma.invoiceScanItem.aggregate({
    where: {
      approved: true, splitToSessionId: null,
      session: {
        approvedAt: win,
        ...(locRcIds
          ? { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] }
          : rcId ? { revenueCenterId: rcId } : {}),
      },
    },
    _sum: { rawLineTotal: true },
  })
  const foodCostDollars = Number(purchases._sum.rawLineTotal ?? 0)
  const foodCostPct = foodSales > 0 ? (foodCostDollars / foodSales) * 100 : null
  const avgSpend = covers > 0 ? netSales / covers : null

  // ── Movers (aggregate qtySold per recipe across today's entries) ──────────
  const byRecipe = new Map<string, { id: string; name: string; menuPrice: number | null; units: number }>()
  for (const e of sales) {
    for (const li of e.lineItems) {
      const r = li.recipe
      const cur = byRecipe.get(r.id) ?? { id: r.id, name: r.name, menuPrice: r.menuPrice == null ? null : Number(r.menuPrice), units: 0 }
      cur.units += li.qtySold
      byRecipe.set(r.id, cur)
    }
  }
  const movers = [...byRecipe.values()].filter(m => m.units > 0)
  const topSellers = [...movers].sort((a, b) => b.units - a.units).slice(0, 4)
  const slowMovers = [...movers].sort((a, b) => a.units - b.units).slice(0, 4)

  const wasteFlags = waste.map(w => ({
    id: w.id,
    name: w.inventoryItem?.itemName ?? 'Unknown item',
    meta: `${Number(w.qtyWasted)} ${w.unit} · ${w.reason.toLowerCase()}`,
    loggedBy: w.loggedBy,
    cost: Number(w.costImpact),
  }))

  const priceFlags = priceAlerts.map(p => ({
    id: p.id,
    name: p.itemName,
    pct: p.percentChange == null ? null : Number(p.percentChange),
  }))

  return NextResponse.json({
    date: win.gte.toISOString().slice(0, 10),
    netSales, foodSales, covers,
    foodCostDollars, foodCostPct, avgSpend,
    topSellers, slowMovers, wasteFlags, priceFlags,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
```

- [ ] **Step 2: Confirm the Prisma field names**

Before trusting the code, verify the field names actually exist (they vary by schema):

Run: `grep -nE "model PriceAlert" -A20 prisma/schema.prisma`
Expected: confirm `itemName`, `percentChange` (or the real names — e.g. `pctChange`/`changePct`), `oldPrice`, `newPrice`, and `createdAt`. **If they differ, update the `select` and the mapping.** Same for `WastageLog` (`qtyWasted`, `unit`, `reason`, `costImpact`, `loggedBy`, `inventoryItem` relation) — these were confirmed present at schema lines 270-281.

Run: `grep -nE "menuPrice|model Recipe" prisma/schema.prisma | head`
Expected: confirm `Recipe.menuPrice` exists (Decimal, nullable).

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS, and the route appears as `ƒ (Dynamic)` in the output (never `○ (Static)` — a static mut-less GET route serves stale build-time data; see CLAUDE.md "Route handlers must be dynamic").

- [ ] **Step 4: Smoke-test the endpoint**

Start the preview server (`preview_start`), then:
Run (preview_eval): `await (await fetch('/api/eod/summary', {cache:'no-store'})).json()`
Expected: JSON with `netSales`, `covers`, `topSellers[]`, `wasteFlags[]` etc. (values may be 0/empty if there are no sales dated today in the dev DB — that's correct, not a bug).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/eod/summary
git commit -m "feat(eod): read-only /api/eod/summary today-recap aggregate"
```

---

### Task 3: Page shell — route, data fetch, chrome strip, header

**Files:**
- Create: `src/app/end-of-day/page.tsx`

- [ ] **Step 1: Write the page shell with real data fetch**

Model the fetch + RC scoping on `reports/page.tsx` (uses `useRc()` + `setScopeParams`). Placeholder values are inlined as constants prefixed `PH_` and rendered with an `est` marker.

```tsx
'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Clock, Printer, Send, ArrowLeft } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { setScopeParams } from '@/lib/scope-params'
import { PageHead } from '@/components/layout/PageHead'
import { SubNav } from '@/components/layout/SubNav'
import { formatCurrency } from '@/lib/utils'
import { EodKpiRow, DayInReview, CloseRail, LoopStrip } from './eod-components'

export interface EodSummary {
  date: string
  netSales: number
  foodSales: number
  covers: number
  foodCostDollars: number
  foodCostPct: number | null
  avgSpend: number | null
  topSellers: Array<{ id: string; name: string; menuPrice: number | null; units: number }>
  slowMovers: Array<{ id: string; name: string; menuPrice: number | null; units: number }>
  wasteFlags: Array<{ id: string; name: string; meta: string; loggedBy: string; cost: number }>
  priceFlags: Array<{ id: string; name: string; pct: number | null }>
}

// Placeholder metrics — no data source yet (labour/forecast). Rendered with an
// explicit "est" tag so they read as estimates, never live numbers. Wired in a later phase.
export const PH_TARGET_PCT = 27
export const PH_LABOUR_PCT = 31.4

export default function EndOfDayPage() {
  const { activeRcId, activeRc, activeKind, activeLocationId } = useRc()
  const [data, setData] = useState<EodSummary | null>(null)

  useEffect(() => {
    const params = new URLSearchParams()
    setScopeParams(params, { activeKind, activeRcId, activeRc, activeLocationId })
    const qs = params.toString()
    fetch(`/api/eod/summary${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setData(d) })
      .catch(() => {})
  }, [activeRcId, activeRc, activeKind, activeLocationId])

  const fcPct = data?.foodCostPct ?? null
  const over = fcPct != null && fcPct > PH_TARGET_PCT

  return (
    <>
      <SubNav
        tabs={[
          { href: '/pass', label: 'Pass' },
          { href: '/preshift', label: 'Pre-shift' },
          { href: '/end-of-day', label: 'End-of-day', icon: <Clock size={14} /> },
        ]}
      />
      <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">

        {/* Cost-chrome strip — checklist/blockers are Phase 2 placeholders */}
        <div className="hidden md:flex items-center gap-4 mb-5 px-4 py-2.5 bg-paper border border-line rounded-[10px] font-mono text-[11px]">
          <span className="text-ink-3">Close checklist</span>
          <span className="text-ink-3 tabular-nums" title="Checklist ships in Phase 2">0 / 20 <span className="text-ink-4">est</span></span>
          <span className="w-px h-3.5 bg-line" />
          <span className="text-ink-3">Food cost · today</span>
          <span className={`tabular-nums font-semibold ${over ? 'text-red-text' : 'text-ink'}`}>{fcPct != null ? `${fcPct.toFixed(1)}%` : '—'}</span>
          <span className="w-px h-3.5 bg-line" />
          <span className="text-ink-3">Net sales</span>
          <span className="text-ink font-semibold tabular-nums">{data ? formatCurrency(data.netSales) : '—'}</span>
          <span className="flex-1" />
          <span className="text-ink-4">sign-off closes the loop · feeds tomorrow&apos;s <Link href="/pass" className="text-gold-2 border-b border-dashed border-current">Pass</Link></span>
        </div>

        <PageHead
          crumbs={<><Clock size={12} /> TODAY / END-OF-DAY</>}
          title={<>Service is <em className="font-fraunces italic font-medium text-gold-2">closed</em>.</>}
          sub={data ? <>{data.covers} covers · <b>{formatCurrency(data.netSales)}</b> net · food cost ran <b className={over ? 'text-red-text' : ''}>{fcPct != null ? `${fcPct.toFixed(1)}%` : '—'}</b>. Review the day, then sign off to open tomorrow with real numbers.</> : <>Loading today&apos;s close…</>}
          actions={
            <>
              <Link href="/pass" className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors">
                <ArrowLeft size={13} /> Back to Pass
              </Link>
              <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors">
                <Printer size={13} /> Print report
              </button>
            </>
          }
        />

        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <div>
            <EodKpiRow data={data} target={PH_TARGET_PCT} labourPct={PH_LABOUR_PCT} />
            <DayInReview data={data} target={PH_TARGET_PCT} />
            <LoopStrip />
          </div>
          <CloseRail data={data} />
        </div>
      </div>
    </>
  )
}
```

- [ ] **Step 2: Confirm shared imports exist**

Run: `grep -rn "export function SubNav" src/components/layout/SubNav.tsx && grep -rn "font-fraunces" src/app/pass/page.tsx tailwind.config.*`
Expected: `SubNav` is exported (it is — used in `pass/page.tsx:14`); `font-fraunces` is a real font utility (used in `pass/page.tsx:261`). If `/preshift` doesn't exist as a route, keep the tab but it's fine to 404 — it mirrors the current Pass SubNav. (Confirm with `ls src/app/preshift` — if absent, drop that tab.)

- [ ] **Step 3: Build fails (component file missing) — expected**

Run: `npm run build`
Expected: FAIL — `./eod-components` not found. Proceed to Task 4.

---

### Task 4: KPI row + Day-in-review + Loop strip components

**Files:**
- Create: `src/app/end-of-day/eod-components.tsx` (this task adds `EodKpiRow`, `DayInReview`, `MoversCard`, `FlagsCard`, `LoopStrip`; Task 5 adds `CloseRail` to the same file)

Transcribe the KPI, daypart, movers, and flags markup from `docs/design-refs/end-of-day.design.html` (lines 88-266), substituting the token map. Daypart bars are placeholders (no intra-day data); movers + flags are live from `EodSummary`.

- [ ] **Step 1: Write the components**

```tsx
'use client'
import Link from 'next/link'
import { TrendingUp, AlertTriangle, RotateCw } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import type { EodSummary } from './page'

const card = 'bg-paper border border-line rounded-[12px] overflow-hidden'
const cardHead = 'flex items-center justify-between px-[18px] py-3 border-b border-line bg-bg-2'

// ── KPI row ──────────────────────────────────────────────────────────────────
export function EodKpiRow({ data, target, labourPct }: { data: EodSummary | null; target: number; labourPct: number }) {
  const fc = data?.foodCostPct ?? null
  const over = fc != null && fc > target
  return (
    <div className="grid gap-3 mb-6 grid-cols-2 lg:grid-cols-4">
      <Kpi label="NET SALES · TODAY" value={data ? formatCurrency(data.netSales) : '—'}
        sub={data ? `${data.covers} covers` : ''} hero />
      <Kpi label="FOOD COST · TODAY" value={fc != null ? `${fc.toFixed(1)}%` : '—'}
        sub={`target ${target.toFixed(1)}`} valueClass={over ? 'text-red-text' : ''} accent="bg-red" />
      <Kpi label="AVG SPEND" value={data?.avgSpend != null ? formatCurrency(data.avgSpend) : '—'}
        sub="per cover" />
      {/* PLACEHOLDER — no labour data source yet */}
      <Kpi label="LABOUR" value={`${labourPct.toFixed(1)}%`} sub="est · not yet wired" placeholder />
    </div>
  )
}

function Kpi({ label, value, sub, valueClass = '', accent, hero, placeholder }:
  { label: string; value: string; sub: string; valueClass?: string; accent?: string; hero?: boolean; placeholder?: boolean }) {
  return (
    <div className={`relative flex flex-col justify-between min-h-[110px] rounded-[12px] p-5 border ${hero ? 'bg-ink text-paper border-ink' : 'bg-paper border-line'} ${placeholder ? 'opacity-70' : ''}`}>
      {accent && <div className={`absolute top-0 left-0 w-8 h-0.5 ${accent}`} />}
      <div>
        <div className={`font-mono text-[10.5px] tracking-[0.01em] uppercase ${hero ? 'text-zinc-500' : 'text-ink-3'}`}>{label}</div>
        <div className={`text-[30px] font-semibold tracking-[-0.04em] leading-none mt-2 ${hero ? '' : valueClass || 'text-ink'}`}>{value}</div>
      </div>
      <div className={`font-mono text-[11px] ${hero ? 'text-zinc-500' : 'text-ink-3'}`}>{sub}</div>
    </div>
  )
}

// ── Day in review ─────────────────────────────────────────────────────────────
export function DayInReview({ data, target }: { data: EodSummary | null; target: number }) {
  return (
    <div className="mt-1">
      <BandLabel title="Day in review" note="READ-ONLY · PULLED FROM POS + COUNTS" />
      <DaypartPlaceholder />
      <div className="grid gap-3 md:grid-cols-2 mb-4">
        <MoversCard title="Top sellers" hint="UNITS" rows={data?.topSellers ?? []} tone="ok" />
        <MoversCard title="Slow movers" hint="REVIEW" rows={data?.slowMovers ?? []} tone="warn" />
      </div>
      <FlagsCard data={data} />
    </div>
  )
}

function BandLabel({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex items-center gap-3 my-4">
      <span className="text-[13px] font-semibold tracking-[-0.01em] text-ink">{title}</span>
      <span className="flex-1 h-px bg-line" />
      <span className="font-mono text-[10px] text-ink-3 tracking-wide">{note}</span>
    </div>
  )
}

// Daypart is a placeholder — SalesEntry is a daily aggregate, no intra-day splits yet.
function DaypartPlaceholder() {
  return (
    <div className={`${card} mb-3`}>
      <div className={cardHead}>
        <h3 className="text-[13px] font-semibold flex items-center gap-2">Sales vs forecast <span className="text-ink-3 font-normal">· by daypart</span></h3>
        <span className="font-mono text-[10px] text-ink-3">est · forecast not wired</span>
      </div>
      <div className="p-6 text-center text-ink-3 font-mono text-[11px]">
        Daypart & forecast breakdown lands with the forecast engine (later phase).
      </div>
    </div>
  )
}

function MoversCard({ title, hint, rows, tone }: { title: string; hint: string; rows: EodSummary['topSellers']; tone: 'ok' | 'warn' }) {
  const toneCls = tone === 'ok' ? 'text-green-text' : 'text-gold-2'
  return (
    <div className={card}>
      <div className={cardHead}>
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <span className="font-mono text-[10px] text-ink-3">{hint}</span>
      </div>
      {rows.length === 0 ? (
        <div className="p-5 text-center text-ink-3 font-mono text-[11px]">No sales recorded today.</div>
      ) : (
        <div className="divide-y divide-line">
          {rows.map((r, i) => (
            <Link key={r.id} href={`/menu?highlight=${r.id}`} className="grid grid-cols-[24px_1fr_auto] gap-3 px-[18px] py-2.5 items-center hover:bg-bg-2/40 transition-colors">
              <span className="font-mono text-[11px] text-ink-3">{tone === 'ok' ? i + 1 : '—'}</span>
              <span className="text-[13px] text-ink font-medium truncate">{r.name}</span>
              <span className={`font-mono text-[13px] font-semibold tabular-nums ${toneCls}`}>{r.units}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

// Variance & waste flags — MVP sources: WastageLog (waste) + PriceAlert (price spikes).
// Theoretical-vs-counted variance rows come in Phase 2 (needs the variance recompute).
function FlagsCard({ data }: { data: EodSummary | null }) {
  const waste = data?.wasteFlags ?? []
  const price = data?.priceFlags ?? []
  const empty = waste.length === 0 && price.length === 0
  return (
    <div className={card}>
      <div className={cardHead}>
        <h3 className="text-[13px] font-semibold flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-red" /> Variance &amp; waste flags <span className="text-ink-3 font-normal">· today</span>
        </h3>
        <Link href="/variance" className="font-mono text-[10px] text-gold-2 border-b border-dashed border-current">FULL VARIANCE →</Link>
      </div>
      {empty ? (
        <div className="p-5 text-center text-ink-3 font-mono text-[11px]">No waste or price flags logged today.</div>
      ) : (
        <div className="divide-y divide-line">
          {price.map(p => (
            <div key={p.id} className="grid grid-cols-[20px_1fr_auto] gap-3 px-[18px] py-2.5 items-center">
              <TrendingUp size={13} className="text-red" />
              <span className="text-[13px] text-ink"><b>{p.name}</b><small className="text-ink-3"> · price change today</small></span>
              <span className="font-mono text-[13px] font-semibold text-red-text tabular-nums">{p.pct != null ? `${p.pct > 0 ? '+' : ''}${p.pct.toFixed(0)}%` : '—'}</span>
            </div>
          ))}
          {waste.map(w => (
            <div key={w.id} className="grid grid-cols-[20px_1fr_auto] gap-3 px-[18px] py-2.5 items-center">
              <AlertTriangle size={13} className="text-gold" />
              <span className="text-[13px] text-ink"><b>{w.name}</b><small className="text-ink-3"> · {w.meta} · {w.loggedBy}</small></span>
              <span className="font-mono text-[13px] font-semibold text-red-text tabular-nums">−{formatCurrency(w.cost)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Loop strip (brand chrome, static) ─────────────────────────────────────────
export function LoopStrip() {
  return (
    <div className="mt-5 flex flex-col md:flex-row md:items-center gap-3 px-[18px] py-3.5 bg-ink text-paper rounded-[12px]">
      <span className="font-mono text-[10px] text-gold shrink-0"><RotateCw size={11} className="inline mb-0.5" /> THE LOOP</span>
      <span className="text-[12.5px] text-zinc-300">You&apos;re at <b className="text-paper">06 · TRUTH</b> — service is counted. Sign-off writes today&apos;s actuals back into <b className="text-paper">01 · IN</b>, so tomorrow&apos;s Pass opens with real numbers.</span>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: still FAIL — `CloseRail` is imported by `page.tsx` but not yet exported. Add it in Task 5. (If you prefer a green build here, temporarily stub `export function CloseRail(){return null}` — Task 5 replaces it.)

---

### Task 5: Right rail — close gate, day summary, blockers/carries/handover (placeholders + real summary)

**Files:**
- Modify: `src/app/end-of-day/eod-components.tsx` (add `CloseRail`)

Transcribe the right-rail markup from `docs/design-refs/end-of-day.design.html` (lines 271-317). The gate ring, blockers, carries, and handover are Phase 2/3 placeholders. The **Day summary** shows the real net sales + food cost from `EodSummary`; gross/comps/discounts are placeholders (not persisted yet).

- [ ] **Step 1: Add `CloseRail`**

```tsx
// ── Right rail · close ─────────────────────────────────────────────────────────
export function CloseRail({ data }: { data: EodSummary | null }) {
  const railCard = 'bg-paper border border-line rounded-[12px] p-[18px] mb-4'
  return (
    <aside>
      {/* Gate — Phase 2 (sign-off + checklist). Static preview. */}
      <div className={`${railCard} text-center`}>
        <div className="mx-auto w-24 h-24 rounded-full border-8 border-bg-2 flex items-center justify-center">
          <span className="text-[22px] font-semibold text-ink-3">—</span>
        </div>
        <div className="text-[14px] font-semibold text-ink mt-3">Close the day</div>
        <div className="text-[11.5px] text-ink-3 mt-1">Checklist &amp; sign-off arrive in Phase 2.</div>
        <button disabled className="w-full mt-3 py-2.5 rounded-[9px] bg-bg-2 text-ink-4 text-[13px] font-medium cursor-not-allowed">
          Close the day
        </button>
      </div>

      {/* Day summary — net sales + food cost are LIVE; the rest are placeholders */}
      <div className={railCard}>
        <h4 className="text-[12px] font-semibold text-ink mb-2.5 flex items-center justify-between">Day summary <span className="font-mono text-[10px] text-ink-3 font-normal">closes loop</span></h4>
        <SumRow l="Gross sales" v="—" note="est" />
        <SumRow l="Comps & voids" v="—" note="est" />
        <SumRow l="Discounts" v="—" note="est" />
        <SumRow l="Net sales" v={data ? formatCurrency(data.netSales) : '—'} />
        <div className="flex items-center justify-between pt-2 mt-1 border-t border-line">
          <span className="text-[12px] text-ink font-medium">Food cost</span>
          <span className="font-mono text-[12px] font-semibold text-red-text tabular-nums">
            {data ? formatCurrency(data.foodCostDollars) : '—'}{data?.foodCostPct != null ? ` · ${data.foodCostPct.toFixed(1)}%` : ''}
          </span>
        </div>
      </div>

      {/* Handover — Phase 2 (persists to tomorrow's Pass). Non-persistent in MVP. */}
      <div className={railCard}>
        <h4 className="text-[12px] font-semibold text-ink mb-2 flex items-center justify-between">Handover note <span className="font-mono text-[10px] text-ink-3 font-normal">to opener</span></h4>
        <textarea disabled placeholder="Handover persistence arrives in Phase 2." className="w-full h-20 text-[12.5px] p-2.5 rounded-[8px] border border-line bg-bg-2/40 text-ink-3 resize-none" />
      </div>
    </aside>
  )
}

function SumRow({ l, v, note }: { l: string; v: string; note?: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[12px] text-ink-3">{l}</span>
      <span className="font-mono text-[12px] text-ink tabular-nums">{note && <span className="text-ink-4 mr-1">{note}</span>}{v}</span>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS. `/end-of-day` compiles as a client page.

- [ ] **Step 3: Commit**

```bash
git add src/app/end-of-day
git commit -m "feat(eod): read-only End-of-day recap page (MVP layout + live sales/movers/flags)"
```

---

### Task 6: Visual verification + seed a today's-sales sanity check

**Files:** none (verification only)

- [ ] **Step 1: Ensure the dev server is running**

Use `preview_start` (or confirm one is up with `preview_list`). Per `feedback_server_restart` memory, restart if stale.

- [ ] **Step 2: Load the page as a MANAGER**

Navigate the preview to `/end-of-day`. Then:
Run (preview_snapshot): confirm the page renders — header "Service is closed.", KPI row, Day-in-review cards, right rail, Loop strip.

- [ ] **Step 3: Check for console/network errors**

Run: `preview_console_logs` and `preview_network`.
Expected: no uncaught errors; `GET /api/eod/summary` returns 200.

- [ ] **Step 4: Confirm nav round-trips**

From `/pass`, the "End-of-day" SubNav tab and header button both navigate to `/end-of-day` (not `/reports`). `/reports` still loads its own analytics page unchanged.

- [ ] **Step 5: Screenshot for the record**

Run: `preview_screenshot` at desktop width, then `preview_resize` to mobile and screenshot again (the page uses responsive grids; confirm the rail stacks under the main column).

- [ ] **Step 6: Final commit if any tweaks were needed**

```bash
git add -A
git commit -m "fix(eod): verification tweaks"
```

---

## Self-review notes

- **Spec coverage (MVP subset):** header/greeting ✓ (Task 3), net sales / food cost / avg spend KPIs ✓ (Task 4), labour KPI placeholder ✓, daypart placeholder ✓, top/slow sellers live ✓, variance&waste flags live (waste + price) ✓, day summary net/food-cost live ✓, loop strip ✓, gate/checklist/handover placeholders ✓, nav + role gate ✓ (Task 1). Deferred-by-design (checklist, sign-off, prep queue, orders, forecast, labour, comps/discounts, daypart, 86 board, handover persistence) are all explicitly placeholder blocks — see Scope.
- **Placeholder scan:** the only "placeholders" are product-intentional UI stubs, each labelled `est`/"Phase 2"; no code steps are left as TODO.
- **Type consistency:** `EodSummary` is defined once in `page.tsx` and imported by `eod-components.tsx`. Field names (`foodCostPct`, `avgSpend`, `topSellers`, `wasteFlags`, `priceFlags`) match between the route JSON (Task 2) and the interface (Task 3). **Verify PriceAlert field names in Task 2 Step 2 before relying on them** — that's the one real schema-dependency risk.
- **Route dynamic-ness:** Task 2 exports `dynamic = 'force-dynamic'` and Step 3 checks for `ƒ (Dynamic)`, per the CLAUDE.md 405/stale-data gotcha.

## Later phases (out of MVP scope — captured for continuity)

- **Phase 2 — the ritual:** `EodClose` session + **DB-backed, admin-editable** checklist templates + `EodCheckLog` + temperature readings + gate ring wired to completion + "Close the day" sign-off + handover persisted to tomorrow's Pass. (See `docs/design-refs/end-of-day.behavior.js` for the interaction model to reproduce server-side.)
- **Phase 3 — sets up tomorrow:** prep-for-tomorrow queue → prep board (`isOnList`), below-par order suggestions grouped by supplier → draft PO, carries/86 board.
- **Phase 4 — polish:** forecast baselines (trailing same-weekday) to light up daypart + "vs forecast" deltas; comps/voids/discounts persisted via a Toast-sync extension for the day summary; labour cost input for the labour KPI + prime cost; print/email-owner report via the existing Resend digest infra.
