# Mobile App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Controla OS mobile prototype's information architecture and hero interactions into the existing Fergie's OS Next.js app — a thumb-reachable bottom tab bar, a role-adaptive Today home, a quick-add launcher, and (in later phases) a redesigned count flow, prep parity, capture, and an inbox/more hub.

**Architecture:** Integrate, don't fork. Refactor the existing mobile bottom nav in `Navigation.tsx`, add new screens under `src/components/mobile/` and `src/app/`, bind everything to existing APIs and contexts, and reuse existing tokens/components. Navigation stays URL-based so auth/deep-links/back-button keep working.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind (existing tokens), Lucide icons, Prisma/Supabase. No test framework — **verification is `npm run build` + mobile preview** (see "Verification model" below).

---

## Verification model (read first)

This repo has **no test suite**; `npm run build` is the only automated correctness check (CLAUDE.md). So in this plan:

- The "test" step for each task is **`npm run build`** (must pass — type-checks the whole app) plus a **mobile-preview observation** using the `preview_*` tools (resize to a phone width, snapshot/screenshot, check console for errors).
- TDD is not used. Frequent commits still apply: commit after each task that builds clean.
- Reminder (CLAUDE.md): wrap any Prisma `Decimal` (e.g. `pricePerBaseUnit`) with `Number()` before arithmetic; any mutating route needs `export const dynamic = 'force-dynamic'`.

**Preview loop used in every task's verify step:**
1. `preview_start` (or reuse running server) → load the app.
2. `preview_resize` to 402×874 (the prototype's frame size).
3. Navigate to the route under test; `preview_console_logs` for errors; `preview_snapshot` for structure; `preview_screenshot` for the visual.

---

## File structure (Phase 1)

- Create `src/components/mobile/MobileTabBar.tsx` — the 5-slot bottom bar (extracted + refactored from `Navigation.tsx`).
- Create `src/components/mobile/QuickAddSheet.tsx` — the center-＋ bottom sheet.
- Create `src/components/mobile/kit.tsx` — shared mobile primitives used across phases (`MScreen`, `MPageHead`, `MCard`, `MSectionLabel`, `MQuickAction`, `MProgressBar`). Thin wrappers over existing tokens.
- Create `src/app/today/page.tsx` — Today route (client; mobile renders home, desktop bounces by role).
- Create `src/components/mobile/today/TodayManager.tsx` and `TodayChef.tsx` — the two role variants.
- Modify `src/components/Navigation.tsx` — replace the inline mobile bottom-nav markup (lines ~283–346) with `<MobileTabBar … />`; keep the "All Pages" drawer (reused as the More hub later) but trigger it from the new "More" tab.
- Modify `src/app/page.tsx` — root redirect now sends everyone to `/today`.
- Modify `src/components/layout/CostChromeGate.tsx` — add `/today` to spine routes; allow the mobile render.
- Modify `src/components/layout/CostChrome.tsx` — render on mobile too (currently `hidden md:flex`), in a condensed mobile layout.

---

## Phase 1 — Navigation shell + Today home + quick-add launcher

### Task 1: Shared mobile kit primitives

**Files:**
- Create: `src/components/mobile/kit.tsx`

- [ ] **Step 1: Create the kit file**

These are thin wrappers so every mobile screen is consistent and short. They use existing Tailwind tokens (`bg`, `paper`, `ink`, `line`, `gold`, `bg-2`, font-mono).

```tsx
'use client'
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

// Full-height scroll surface that clears the top RC bar and bottom tab bar.
export function MScreen({ children }: { children: ReactNode }) {
  return (
    <div className="md:hidden min-h-screen bg-[#fafaf9] text-ink px-4 pb-28">
      {children}
    </div>
  )
}

export function MPageHead({ title, eyebrow, right }: { title: string; eyebrow?: string; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 pt-2 pb-3.5">
      <div className="min-w-0">
        {eyebrow && <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em] mb-1.5">{eyebrow}</div>}
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.035em] leading-none">{title}</h1>
      </div>
      {right}
    </div>
  )
}

export function MCard({ children, accent, onClick, className = '' }: { children: ReactNode; accent?: string; onClick?: () => void; className?: string }) {
  return (
    <div
      onClick={onClick}
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
      className={`bg-paper border border-line rounded-xl p-3.5 ${onClick ? 'cursor-pointer' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

export function MSectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em] mt-4.5 mb-2">
      <span>{children}</span>
      {right && <span className="text-gold-2">{right}</span>}
    </div>
  )
}

export function MProgressBar({ pct, tone }: { pct: number; tone?: 'warn' | 'bad' | 'ok' }) {
  const col = tone === 'bad' ? 'bg-red' : tone === 'warn' ? 'bg-gold' : tone === 'ok' ? 'bg-green' : 'bg-ink'
  return (
    <div className="h-[5px] rounded-full bg-bg-2 overflow-hidden">
      <div className={`h-full rounded-full ${col}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  )
}

export function MQuickAction({ label, icon, badge, onClick }: { label: string; icon: ReactNode; badge?: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className="relative flex flex-col items-start gap-2 bg-paper border border-line rounded-xl p-3.5 text-left">
      <span className="grid place-items-center w-9 h-9 rounded-[10px] bg-ink text-gold">{icon}</span>
      <span className="text-[14px] font-semibold tracking-[-0.01em]">{label}</span>
      {badge ? <span className="absolute top-2.5 right-2.5 font-mono text-[9px] font-bold bg-gold text-ink rounded-full px-1.5 leading-[14px]">{badge}</span> : null}
    </button>
  )
}

export function MRowChevron() {
  return <ChevronRight size={17} className="text-ink-4 shrink-0" />
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS (new file is unused so far; type-checks clean).

- [ ] **Step 3: Commit**

```bash
git add src/components/mobile/kit.tsx
git commit -m "feat(mobile): shared mobile UI kit primitives"
```

---

### Task 2: Quick-add sheet

**Files:**
- Create: `src/components/mobile/QuickAddSheet.tsx`

- [ ] **Step 1: Create the sheet**

Reuses the established bottom-sheet pattern (`fixed inset-0 flex items-end` + backdrop + `rounded-t-2xl` + `pb-safe`). Each action navigates via `next/navigation`'s router. Until later phases land, the actions route to the closest existing screen (waste→`/wastage`, capture→`/invoices`, scan→`/inventory`, count→`/count`).

```tsx
'use client'
import { useRouter } from 'next/navigation'
import { Flame, Camera, Barcode, ClipboardList, ChevronRight } from 'lucide-react'

const ACTIONS = [
  { id: 'waste',   label: 'Log waste',       sub: 'Trim, spoilage, comps',  icon: Flame,         href: '/wastage',  danger: true },
  { id: 'capture', label: 'Capture invoice', sub: 'Photo → line items',     icon: Camera,        href: '/invoices' },
  { id: 'scan',    label: 'Scan an item',    sub: 'Barcode lookup',         icon: Barcode,       href: '/inventory' },
  { id: 'count',   label: 'Start a count',   sub: 'Jump to a storage area', icon: ClipboardList, href: '/count' },
] as const

export function QuickAddSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter()
  if (!open) return null
  const run = (href: string) => { onClose(); router.push(href) }
  return (
    <div className="md:hidden fixed inset-0 z-[80] flex items-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full bg-paper rounded-t-2xl shadow-xl pb-safe animate-[slide-up_.25s_ease]">
        <div className="flex justify-center pt-2.5"><div className="w-9 h-[5px] rounded-full bg-line-2" /></div>
        <div className="px-5 pt-3 pb-1 text-[18px] font-semibold tracking-[-0.02em]">Quick add</div>
        <div className="font-mono text-[11px] text-ink-3 px-5 pb-3">LOG SOMETHING FAST</div>
        <div className="px-4 pb-6 flex flex-col gap-2">
          {ACTIONS.map(a => {
            const Ico = a.icon
            return (
              <button key={a.id} onClick={() => run(a.href)} className="flex items-center gap-3 w-full text-left bg-paper border border-line rounded-[13px] px-3.5 py-3">
                <span className={`grid place-items-center w-[42px] h-[42px] rounded-xl shrink-0 ${a.danger ? 'bg-red-soft text-red-text' : 'bg-ink text-gold'}`}>
                  <Ico size={20} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[15.5px] font-semibold tracking-[-0.01em]">{a.label}</span>
                  <span className="block font-mono text-[11px] text-ink-3 mt-0.5">{a.sub}</span>
                </span>
                <ChevronRight size={17} className="text-ink-4" />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS. (`slide-up` keyframe already exists in `globals.css`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/mobile/QuickAddSheet.tsx
git commit -m "feat(mobile): quick-add bottom sheet"
```

---

### Task 3: MobileTabBar (refactor existing bottom nav)

**Files:**
- Create: `src/components/mobile/MobileTabBar.tsx`
- Modify: `src/components/Navigation.tsx` (replace inline bottom-nav markup ~lines 283–346 with `<MobileTabBar moreActive={…} moreBadge={…} onMore={…} onAdd={…} />`; remove now-unused `mobileLeft`/`mobileRight` arrays if they become dead)
- Reference: existing badge polling in `Navigation.tsx` (`inboxCounts`) stays and is passed in.

- [ ] **Step 1: Create MobileTabBar**

Slots: `Today (/today)`, `Prep (/prep)`, center `＋` (callback), `Count (/count)`, `More` (callback opening the existing "All Pages" drawer). Active state from `usePathname`; any route outside the four core routes activates "More".

```tsx
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Sun, ChefHat, ClipboardList, Grid2x2, Plus } from 'lucide-react'

const CORE = [
  { href: '/today', label: 'Today', icon: Sun },
  { href: '/prep',  label: 'Prep',  icon: ChefHat },
] as const
const CORE_RIGHT = [
  { href: '/count', label: 'Count', icon: ClipboardList },
] as const

export function MobileTabBar({ onAdd, onMore, moreBadge = 0 }: { onAdd: () => void; onMore: () => void; moreBadge?: number }) {
  const pathname = usePathname() ?? ''
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/')
  const coreHrefs = ['/today', '/prep', '/count']
  const moreActive = !coreHrefs.some(isActive)

  const Tab = ({ href, label, Icon }: { href: string; label: string; Icon: typeof Sun }) => {
    const on = isActive(href)
    return (
      <Link href={href} className="flex flex-col items-center gap-1" style={{ color: on ? '#09090b' : '#71717a' }}>
        <Icon size={22} strokeWidth={on ? 2.2 : 1.9} color={on ? '#09090b' : '#a1a1aa'} />
        <span className="text-[9.5px]" style={{ fontWeight: on ? 600 : 500 }}>{label}</span>
      </Link>
    )
  }

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-50 grid grid-cols-5 pt-2.5 pb-safe border-t border-line"
      style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(18px) saturate(180%)', WebkitBackdropFilter: 'blur(18px) saturate(180%)' }}
    >
      {CORE.map(t => <Tab key={t.href} href={t.href} label={t.label} Icon={t.icon} />)}
      <div className="flex justify-center">
        <button onClick={onAdd} aria-label="Quick add" className="grid place-items-center w-[52px] h-[52px] rounded-2xl -mt-[18px] bg-ink border-[3px] border-white shadow-lg">
          <Plus size={24} color="#d97706" strokeWidth={2.6} />
        </button>
      </div>
      {CORE_RIGHT.map(t => <Tab key={t.href} href={t.href} label={t.label} Icon={t.icon} />)}
      <button onClick={onMore} className="relative flex flex-col items-center gap-1" style={{ color: moreActive ? '#09090b' : '#71717a' }}>
        <span className="relative">
          <Grid2x2 size={22} strokeWidth={moreActive ? 2.2 : 1.9} color={moreActive ? '#09090b' : '#a1a1aa'} />
          {moreBadge > 0 && !moreActive && <span className="absolute -top-[3px] -right-[4px] w-[7px] h-[7px] bg-gold rounded-full border-[1.5px] border-white" />}
        </span>
        <span className="text-[9.5px]" style={{ fontWeight: moreActive ? 600 : 500 }}>More</span>
      </button>
    </nav>
  )
}
```

- [ ] **Step 2: Wire it into Navigation.tsx**

In `NavigationInner`, replace the inline `<nav className="md:hidden fixed bottom-0 …">…</nav>` block (the one that renders `mobileLeft`, the center "Pages" button, and `mobileRight`) with:

```tsx
<MobileTabBar
  onAdd={() => setQuickAddOpen(true)}
  onMore={() => setMoreOpen(true)}
  moreBadge={inboxCounts.invoicesReview + inboxCounts.priceAlerts}
/>
<QuickAddSheet open={quickAddOpen} onClose={() => setQuickAddOpen(false)} />
```

Add the imports at the top of `Navigation.tsx`:

```tsx
import { MobileTabBar } from '@/components/mobile/MobileTabBar'
import { QuickAddSheet } from '@/components/mobile/QuickAddSheet'
```

Add the new state next to the existing `moreOpen` state:

```tsx
const [quickAddOpen, setQuickAddOpen] = useState(false)
```

Keep the existing "All Pages" drawer block (opened by `moreOpen`) — the "More" tab now opens it. Remove `mobileLeft`/`mobileRight` only if no longer referenced after the swap (search the file; if the "All Pages" drawer uses them, leave them).

- [ ] **Step 3: Verify build + preview**

Run: `npm run build`
Expected: PASS.
Preview: resize to 402×874, load `/prep`. Expected: bottom bar shows `Today · Prep · ＋ · Count · More`; tapping ＋ opens the quick-add sheet; tapping More opens the All Pages drawer; tapping Today navigates to `/today` (will 404 until Task 4 — acceptable here, or do Task 4 first if preferred). Check `preview_console_logs` for no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/mobile/MobileTabBar.tsx src/components/Navigation.tsx
git commit -m "feat(mobile): refactor bottom nav to Today·Prep·+·Count·More"
```

---

### Task 4: Today route + role gating + skeleton

**Files:**
- Create: `src/app/today/page.tsx`

- [ ] **Step 1: Create the route**

Client component. On desktop (`md+`) it bounces to the role-appropriate desktop landing (preserving today's behavior: MANAGER/ADMIN→`/pass`, STAFF→`/count`). On mobile it renders the role-adaptive home. Uses `useUser()` for role.

```tsx
'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/contexts/UserContext'
import { MScreen } from '@/components/mobile/kit'
import { TodayManager } from '@/components/mobile/today/TodayManager'
import { TodayChef } from '@/components/mobile/today/TodayChef'

export default function TodayPage() {
  const router = useRouter()
  const { role, loading } = useUser()

  // Desktop has no mobile home — bounce to the role landing.
  useEffect(() => {
    if (loading) return
    if (typeof window !== 'undefined' && window.innerWidth >= 768) {
      router.replace(role === 'STAFF' ? '/count' : '/pass')
    }
  }, [role, loading, router])

  if (loading) {
    return <MScreen><div className="pt-10 font-mono text-[11px] text-ink-3">Loading…</div></MScreen>
  }

  const isManager = role === 'MANAGER' || role === 'ADMIN'
  return <MScreen>{isManager ? <TodayManager /> : <TodayChef />}</MScreen>
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: FAIL — `TodayManager`/`TodayChef` not found yet. That's expected; create them in Tasks 5–6.

(No commit yet — bundled with Tasks 5–6.)

---

### Task 5: Manager Today body

**Files:**
- Create: `src/components/mobile/today/TodayManager.tsx`

- [ ] **Step 1: Create TodayManager**

Sections top→bottom: greet header, mobile cost-chrome (reuse — see Task 7), "Needs you" queue (from `/api/invoices/kpis`), prep overview (from `/api/prep/items`), 2×2 quick actions. Bind to real endpoints; wrap any Decimal with `Number()`.

```tsx
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/contexts/UserContext'
import { Camera, ClipboardList, Flame, Bell, ChevronRight } from 'lucide-react'
import { MPageHead, MCard, MSectionLabel, MQuickAction, MProgressBar, MRowChevron } from '@/components/mobile/kit'

interface Kpis { awaitingApprovalCount: number; priceAlertCount: number }
interface PrepItem { id: string; name: string; onHand?: number; par?: number }

export function TodayManager() {
  const router = useRouter()
  const { user } = useUser()
  const [kpis, setKpis] = useState<Kpis | null>(null)
  const [prep, setPrep] = useState<PrepItem[]>([])

  useEffect(() => {
    fetch('/api/invoices/kpis').then(r => r.ok ? r.json() : null).then(d => d && setKpis(d)).catch(() => {})
    fetch('/api/prep/items').then(r => r.ok ? r.json() : null).then(d => Array.isArray(d) && setPrep(d.slice(0, 3))).catch(() => {})
  }, [])

  const firstName = (user?.name || user?.email?.split('@')[0] || 'there').split(' ')[0]
  const needs = [
    kpis && kpis.priceAlertCount > 0 && { icon: Bell, title: `${kpis.priceAlertCount} price alert${kpis.priceAlertCount > 1 ? 's' : ''}`, body: 'Cost impact to review', href: '/signals', accent: '#dc2626' },
    kpis && kpis.awaitingApprovalCount > 0 && { icon: Camera, title: `${kpis.awaitingApprovalCount} invoice${kpis.awaitingApprovalCount > 1 ? 's' : ''} to review`, body: 'OCR matched — confirm & approve', href: '/invoices', accent: '#d97706' },
  ].filter(Boolean) as { icon: typeof Bell; title: string; body: string; href: string; accent: string }[]

  return (
    <>
      <MPageHead eyebrow={greetingEyebrow()} title={`Good ${dayPart()}, ${firstName}.`} />

      {/* Cost chrome strip is mounted globally by CostChromeGate on /today (Task 7) */}

      <MSectionLabel right={needs.length ? `${needs.length} item${needs.length > 1 ? 's' : ''}` : undefined}>Needs you</MSectionLabel>
      {needs.length === 0 ? (
        <MCard><div className="font-mono text-[11px] text-ink-3">Nothing needs you right now.</div></MCard>
      ) : (
        <div className="flex flex-col gap-2">
          {needs.map((n, i) => {
            const Ico = n.icon
            return (
              <MCard key={i} accent={n.accent} onClick={() => router.push(n.href)}>
                <div className="flex items-center gap-3">
                  <span className="grid place-items-center w-9 h-9 rounded-[10px] bg-ink text-gold shrink-0"><Ico size={18} /></span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[14.5px] font-semibold tracking-[-0.01em]">{n.title}</span>
                    <span className="block font-mono text-[11px] text-ink-3 mt-0.5">{n.body}</span>
                  </span>
                  <ChevronRight size={17} className="text-ink-4" />
                </div>
              </MCard>
            )
          })}
        </div>
      )}

      <MSectionLabel right={<button onClick={() => router.push('/prep')}>open →</button>}>Today · prep</MSectionLabel>
      <MCard onClick={() => router.push('/prep')}>
        {prep.length === 0 ? (
          <div className="font-mono text-[11px] text-ink-3">No prep planned.</div>
        ) : (
          <div className="flex flex-col gap-3">
            {prep.map(p => {
              const pct = p.par && p.par > 0 ? Math.round((Number(p.onHand ?? 0) / Number(p.par)) * 100) : 0
              return (
                <div key={p.id}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[13.5px] font-medium truncate">{p.name}</span>
                    <span className="font-mono text-[11px] text-ink-3">{pct}%</span>
                  </div>
                  <MProgressBar pct={pct} tone={pct < 50 ? 'bad' : pct < 100 ? 'warn' : 'ok'} />
                </div>
              )
            })}
          </div>
        )}
      </MCard>

      <MSectionLabel>Quick actions</MSectionLabel>
      <div className="grid grid-cols-2 gap-2">
        <MQuickAction label="Capture invoice" icon={<Camera size={20} />} onClick={() => router.push('/invoices')} />
        <MQuickAction label="Schedule count" icon={<ClipboardList size={20} />} onClick={() => router.push('/count')} />
        <MQuickAction label="Log waste" icon={<Flame size={20} />} onClick={() => router.push('/wastage')} />
        <MQuickAction label="Signals" icon={<Bell size={20} />} badge={kpis?.priceAlertCount} onClick={() => router.push('/signals')} />
      </div>
    </>
  )
}

function dayPart() {
  const h = new Date().getHours()
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'
}
function greetingEyebrow() {
  const d = new Date()
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase()
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: still FAIL until `TodayChef` exists (Task 6). Continue.

---

### Task 6: Chef Today body

**Files:**
- Create: `src/components/mobile/today/TodayChef.tsx`

- [ ] **Step 1: Create TodayChef**

Sections: greet header, resume-count banner (from `/api/count/sessions` — most recent open session), my-prep cards (from `/api/prep/items`), service countdown, 2×2 quick actions. If no open count session, hide the resume banner.

```tsx
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/contexts/UserContext'
import { ClipboardList, Barcode, Flame, ChefHat, ArrowRight } from 'lucide-react'
import { MPageHead, MCard, MSectionLabel, MQuickAction, MProgressBar } from '@/components/mobile/kit'

interface CountSession { id: string; status: string; storageAreaName?: string; countedItems?: number; totalItems?: number }
interface PrepItem { id: string; name: string; station?: string; onHand?: number; par?: number }

export function TodayChef() {
  const router = useRouter()
  const { user } = useUser()
  const [session, setSession] = useState<CountSession | null>(null)
  const [prep, setPrep] = useState<PrepItem[]>([])

  useEffect(() => {
    fetch('/api/count/sessions').then(r => r.ok ? r.json() : null)
      .then((d: CountSession[] | null) => { if (Array.isArray(d)) setSession(d.find(s => s.status === 'IN_PROGRESS' || s.status === 'OPEN') ?? null) })
      .catch(() => {})
    fetch('/api/prep/items').then(r => r.ok ? r.json() : null).then(d => Array.isArray(d) && setPrep(d.slice(0, 3))).catch(() => {})
  }, [])

  const firstName = (user?.name || user?.email?.split('@')[0] || 'chef').split(' ')[0]
  const counted = Number(session?.countedItems ?? 0)
  const total = Number(session?.totalItems ?? 0)
  const pct = total > 0 ? Math.round((counted / total) * 100) : 0

  return (
    <>
      <MPageHead eyebrow={greetingEyebrow()} title={`Good ${dayPart()}, ${firstName}.`} />

      {session && (
        <MCard className="bg-ink text-paper border-ink" onClick={() => router.push(`/count?session=${session.id}`)}>
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] text-zinc-400 uppercase tracking-[0.06em]">Resume count</span>
            <span className="grid place-items-center w-7 h-7 rounded-full bg-zinc-800"><ArrowRight size={15} color="#d97706" /></span>
          </div>
          <div className="text-[16px] font-semibold mt-2 mb-1">{session.storageAreaName ?? 'Storage area'}</div>
          <div className="font-mono text-[11px] text-zinc-400 mb-2.5">{counted} of {total} counted</div>
          <MProgressBar pct={pct} tone="warn" />
        </MCard>
      )}

      <MSectionLabel right={<button onClick={() => router.push('/prep')}>open →</button>}>Your prep</MSectionLabel>
      <div className="flex flex-col gap-2">
        {prep.length === 0 ? (
          <MCard><div className="font-mono text-[11px] text-ink-3">No prep assigned.</div></MCard>
        ) : prep.map(p => (
          <MCard key={p.id} onClick={() => router.push('/prep')}>
            <div className="flex items-center gap-3">
              <span className="grid place-items-center w-9 h-9 rounded-[10px] bg-bg-2 text-ink-2 shrink-0"><ChefHat size={18} /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-[14.5px] font-semibold tracking-[-0.01em] truncate">{p.name}</span>
                <span className="block font-mono text-[11px] text-ink-3 mt-0.5">{p.station ?? 'Prep'}</span>
              </span>
            </div>
          </MCard>
        ))}
      </div>

      <MSectionLabel>Quick actions</MSectionLabel>
      <div className="grid grid-cols-2 gap-2">
        <MQuickAction label="Start a count" icon={<ClipboardList size={20} />} onClick={() => router.push('/count')} />
        <MQuickAction label="Scan an item" icon={<Barcode size={20} />} onClick={() => router.push('/inventory')} />
        <MQuickAction label="Log waste" icon={<Flame size={20} />} onClick={() => router.push('/wastage')} />
        <MQuickAction label="My prep list" icon={<ChefHat size={20} />} onClick={() => router.push('/prep')} />
      </div>
    </>
  )
}

function dayPart() { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening' }
function greetingEyebrow() { return new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase() }
```

> **Build note:** the exact field names from `/api/count/sessions` and `/api/prep/items` may differ (e.g. `storageArea.name` vs `storageAreaName`). During execution, open those route files and adjust the interfaces/field accessors to match the real JSON shape before finalizing. This is the one place to confirm against live responses.

- [ ] **Step 2: Verify build + preview**

Run: `npm run build`
Expected: PASS (`/today` now resolves both bodies).
Preview: resize 402×874, load `/today`. Use a STAFF and a MANAGER session if possible (or temporarily hardcode `isManager` to eyeball both). Expected: greet header, the correct role body, quick actions grid; `preview_console_logs` clean; `preview_screenshot` for the record.

- [ ] **Step 3: Commit**

```bash
git add src/app/today/page.tsx src/components/mobile/today/
git commit -m "feat(mobile): role-adaptive Today home (manager + chef)"
```

---

### Task 7: Mobile cost-chrome + root redirect + spine gate

**Files:**
- Modify: `src/components/layout/CostChrome.tsx`
- Modify: `src/components/layout/CostChromeGate.tsx`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Let CostChrome render on mobile**

In `CostChrome.tsx`, the outer wrapper is `hidden md:flex …`. Add a condensed mobile variant. Simplest: change the wrapper so it shows on mobile as a horizontally-scrolling strip. Replace the outer `<div className="hidden md:flex …">` opening tag with a responsive container that renders the same `CCItem`s but wraps/scrolls under `md`:

```tsx
// was: <div className="hidden md:flex bg-ink text-paper px-8 py-[10px] items-center gap-6 border-b border-ink">
<div className="flex bg-ink text-paper px-4 md:px-8 py-[10px] items-center gap-4 md:gap-6 border-b border-ink overflow-x-auto md:overflow-visible">
```

On mobile the trailing `pricePerBaseUnit` note (`flex-1` spacer + span) can crowd; wrap that span in `className="hidden md:inline … "` by adding `hidden md:flex` to the spacer+note group so mobile shows just the four KPIs. Concretely, wrap the `<div className="flex-1" />` and the trailing `<span>…</span>` in a fragment guarded for desktop, e.g. give the `<span>` `className="hidden md:inline-block font-mono …"` (keep existing classes, prepend `hidden md:inline-block`).

- [ ] **Step 2: Add /today to the spine gate**

In `CostChromeGate.tsx`, add `'/today'` to `SPINE_ROUTES`:

```tsx
const SPINE_ROUTES = [
  '/',
  '/today',
  '/pass',
  // …rest unchanged
]
```

- [ ] **Step 3: Root redirect → /today**

In `src/app/page.tsx`, change the final redirect so all roles land on `/today` (which itself bounces desktop by role):

```tsx
// was: redirect(role === 'STAFF' ? '/count' : '/pass')
redirect('/today')
```

Keep the `void role` or remove the now-unused `role`/supabase lookup if it becomes dead. Minimal change: keep the lookup but redirect to `/today`. (Leaving the role read in place is harmless.) If the linter flags `role` as unused, drop the two lines that compute it.

- [ ] **Step 4: Verify build + preview**

Run: `npm run build`
Expected: PASS. Confirm `/today` shows `ƒ (Dynamic)` is not required (it's a client page; root `/` already has `dynamic = 'force-dynamic'`).
Preview: load `/` on a 402-wide viewport → lands on `/today` with the dark cost-chrome strip on top (4 KPIs, horizontally fitting) and the Today body below. `preview_console_logs` clean. On a desktop-width viewport, `/today` bounces to `/pass` (manager) — verify with `preview_resize` to ~1200px then load `/today`.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/CostChrome.tsx src/components/layout/CostChromeGate.tsx src/app/page.tsx
git commit -m "feat(mobile): mobile cost-chrome + Today as mobile home"
```

---

### Phase 1 done — definition of done

- Bottom bar reads `Today · Prep · ＋ · Count · More` on phones; ＋ opens quick-add; More opens the pages drawer.
- `/today` shows the manager or chef home per real auth role, with live cost chrome (manager) and a resume-count banner (chef) when applicable.
- Root `/` lands mobile users on `/today`; desktop users still reach `/pass` or `/count`.
- `npm run build` passes; no console errors in the mobile preview.

---

## Phase 2 — Count stepper redesign (sequenced task outline)

> Detail-pass this phase before executing — fine-grained steps depend on the Phase 1 kit and the real `/api/count/sessions/[id]` shape.

1. **Area-picker mobile renderer** on `/count`: resume card + storage-area list (state, value, drift). Reuse existing `/count` mobile block; align to prototype card styling using the kit.
2. **CountSession overlay** (`src/components/mobile/count/CountSession.tsx`): sticky header (area, online/offline, progress bar), sticky search + category chips (counted/total per category), list grouped by category / flat when searching, "uncounted only" toggle, finalize bar. Full-screen `fixed inset-0`.
3. **BigStepper** shared component (`src/components/mobile/BigStepper.tsx`) — extract from kit; used here + prep + waste.
4. **QuickCount sheet** (`src/components/mobile/count/QuickCount.tsx`): unit toggle, BigStepper, optional unopened-cases stepper, live variance vs theoretical, save/clear.
5. **Offline:** extend `src/lib/count-offline.ts` (already exists) for the new sheet's draft + queue; surface offline pill + "syncs on reconnect" toast (reuse `Toast`).
6. **Wire**: quick-add "Start a count" and chef Today resume-banner deep-link into the overlay.
7. Verify: `npm run build` + preview a full count (search, pick out-of-order, save offline, finalize).

---

## Phase 3 — Prep mobile parity (sequenced task outline)

> Detail-pass before executing.

1. **Segmented control** To-do / Smart prep / History on `/prep` mobile renderer.
2. **To-do view**: progress overview, In-progress (live timer + Done→log sheet), To-do (Start), Done (undo). Reuse `PrepKpiStrip`.
3. **Smart-prep view**: urgency grouping (Critical/Needed/Looking good) from theoretical vs par; suggestion cards (on-hand/par/%, add-to-plan, inline priority); group-by station/category sheet.
4. **History view**: logged yield vs par.
5. **Sheets**: plan-amount (BigStepper + depletes preview), recipe+start/done (scaled ingredients/method — reuse `RecipeViewModal`), log-yield, new-prep-item.
6. **Offline**: new `src/lib/prep-offline.ts` mirroring `count-offline.ts`; shared `SyncBar` (`src/components/mobile/SyncBar.tsx`).
7. Verify: `npm run build` + preview plan→start→log offline→sync.

---

## Phase 4 — Capture flow (sequenced task outline)

> Detail-pass before executing.

1. **Capture overlay** (`src/components/mobile/capture/CaptureFlow.tsx`): mode selector (Barcode/Invoice/Receipt), viewfinder + reticles + scan-line animation (keyframes already exist in `Mobile App.html`; port to `globals.css`), shutter, page-stack. Wrap existing `src/components/CameraCapture.tsx`.
2. **InvoiceReview screen**: summary (lines/matched/to-review/total), extracted lines with match status, unmatched warning, approve → existing `/api/invoices/sessions/[id]/approve` (canonical spine writer — do **not** add a new write path).
3. **BarcodeResult card**: EAN, item, price/par, price-spike alert, actions.
4. **Wire**: quick-add "Capture invoice" + "Scan an item" open the overlay in the right mode.
5. Verify: `npm run build` + preview capture→review→approve against a seeded session.

---

## Phase 5 — Inbox / Signals + More hub (sequenced task outline)

> Detail-pass before executing.

1. **Mobile Inbox** (`/signals` mobile renderer or new component): tabbed (All/Invoices/Prices/Variance/Exceptions), item cards (impact + age), signal drill-in sheet (price spike → affected recipes), exceptions → capture/desktop.
2. **More hub**: replace/extend the existing "All Pages" drawer with grouped lists — Library (Inventory/Recipes/Menu), Insights (Wastage/Signals + Variance/Sales/Cost tagged "open on desktop"), Inbox (Invoices), Setup (Suppliers/Settings tagged "open on desktop"). Venue/user card with online/offline pill.
3. **Desktop-only tagging**: a small `DESKTOP` pill + toast "open on desktop" for non-mobile screens.
4. Verify: `npm run build` + preview inbox drill-in and More navigation.

---

## Phase 6 — Polish (sequenced task outline)

> Detail-pass before executing.

1. **Wastage mobile log sheet**: reason chips, station, cost-impact BigStepper; new `src/lib/waste-offline.ts` + SyncBar.
2. **Inventory / Recipes detail-sheet alignment** to prototype styling (reuse existing drawers).
3. **Larger-touch density toggle** (prototype `bigTouch`) — optional; a root font-size bump persisted to localStorage.
4. Verify: `npm run build` + preview each.

---

## Self-review notes (author)

- **Spec coverage:** §2.1 nav → Tasks 1–3; §2.2 roles + Today → Tasks 4–6; §3 Phase 1 → Tasks 1–7; Phases 2–6 → outline sections; §4 spine/offline → Task 5/7 + per-phase offline tasks; §5 out-of-scope respected (no Briefing/End-of-day/native; desktop screens tagged in Phase 5). ✓
- **Decimal/spine:** flagged in Task 5 (`Number()` wraps) and Phase 4 (approval = only spine writer). ✓
- **One confirmation point** intentionally left for execution: exact JSON field names from `/api/count/sessions` and `/api/prep/items` (Task 6 build note) — to be matched against the real route output rather than guessed, since guessing field names would be the kind of unverified reference the planning guidance forbids.
