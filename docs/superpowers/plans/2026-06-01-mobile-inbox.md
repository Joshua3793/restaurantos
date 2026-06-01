# Mobile Unified Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the broken desktop-shrunk `/invoices` layout on phones with a mobile-native **unified Inbox feed** — invoice sessions + price/variance/exception signals in one chip-filtered card list — while leaving the desktop V2 layout untouched.

**Architecture:** Dual-renderer in `src/app/invoices/page.tsx`: wrap the current content `hidden sm:block`, add a `block sm:hidden` `<MobileInbox>`. A pure normalizer (`lib/invoices/inbox-items.ts`) merges the page's `sessions` + a new `signals` fetch into `InboxItem[]`. Focused presentational components in `components/invoices/mobile/`. Reuses the existing (already mobile-aware) `InvoiceReviewDrawer`, `InvoiceUploadModal`, and the `/api/invoices/sessions` + `/api/signals` endpoints — no backend changes. Keeps the name "Invoices" everywhere.

**Tech Stack:** Next.js 14 App Router, React, TypeScript, Tailwind (flat tokens), Lucide icons.

**Spec:** `docs/superpowers/specs/2026-06-01-mobile-inbox-design.md` — read it.

**Build/verify note:** No unit suite — `npm run build` type-checks. node not on PATH: prefix with `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH"`. Builds can flake fetching the Fraunces Google Font (`ENOTFOUND`) — add `NODE_OPTIONS="--dns-result-order=ipv4first"`. **NEVER `npm run build` while the dev server runs** — stop it + `rm -rf .next` first. Browser-verify at 390×844 with the preview tools.

---

## Shared contract (used by every task)

`SessionSummary` (from `src/components/invoices/types.ts`): `{ id, status: SessionStatus, supplierName, invoiceDate, invoiceNumber, total, files[], createdAt, _count:{ scanItems, priceAlerts, recipeAlerts }, errorMessage? }`. `SessionStatus = 'UPLOADING'|'PROCESSING'|'REVIEW'|'APPROVING'|'APPROVED'|'REJECTED'|'ERROR'`.

`Signal` (shape returned by `/api/signals`): `{ id, fingerprint, rule, severity:'critical'|'warn'|'info', title, body, verbLabel, verbHref, impactValue: number|null, itemId, recipeId, status:'OPEN'|'APPLIED'|'SNOOZED'|'DISMISSED', createdAt }`.

Signals action (PATCH `/api/signals`): body `{ ids:[id], action:'apply'|'snooze'|'dismiss' }`.

---

## File structure

- **Create** `src/lib/invoices/inbox-items.ts` — `Signal` type, `InboxItem` type, `InboxCategory`, `toInboxItems()`, `inboxCounts()`, `fmtAge()`, `INBOX_CHIPS`. Pure.
- **Create** `src/components/invoices/mobile/InboxChips.tsx`
- **Create** `src/components/invoices/mobile/InboxInvoiceCard.tsx`
- **Create** `src/components/invoices/mobile/InboxSignalCard.tsx`
- **Create** `src/components/invoices/mobile/SignalSheet.tsx`
- **Create** `src/components/invoices/mobile/MobileInbox.tsx` — orchestrator.
- **Modify** `src/app/invoices/page.tsx` — fetch signals, `handleSignalAct`, dual-renderer.

---

### Task 1: Normalizer — `inbox-items.ts`

**Files:** Create `src/lib/invoices/inbox-items.ts`

- [ ] **Step 1: Write it**

```ts
import type { SessionSummary, SessionStatus } from '@/components/invoices/types'

export interface Signal {
  id: string
  fingerprint: string
  rule: string
  severity: 'critical' | 'warn' | 'info'
  title: string
  body: string
  verbLabel: string
  verbHref: string
  impactValue: number | null
  itemId: string | null
  recipeId: string | null
  status: 'OPEN' | 'APPLIED' | 'SNOOZED' | 'DISMISSED'
  createdAt: string
}

export type InboxCategory = 'invoices' | 'exceptions' | 'prices' | 'variance' | 'other'

export interface InboxItem {
  id: string
  kind: 'invoice' | 'signal'
  category: InboxCategory
  tone: 'gold' | 'red' | 'ink' | 'ink3'
  icon: 'invoice' | 'price' | 'variance' | 'exception' | 'signal'
  title: string
  meta: string
  badge?: string
  impact?: string
  needsAction: boolean
  ageMs: number
  raw: SessionSummary | Signal
}

const ACTIVE_SESSION: SessionStatus[] = ['UPLOADING', 'PROCESSING', 'REVIEW', 'APPROVING']

function fmtMoney(n: number): string {
  return '$' + (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2).replace(/\.00$/, ''))
}

export function fmtAge(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function sessionToItem(s: SessionSummary): InboxItem | null {
  if (s.status === 'APPROVED' || s.status === 'REJECTED') return null
  const isError = s.status === 'ERROR'
  const dateStr = s.invoiceDate
    ? new Date(s.invoiceDate).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })
    : ''
  const lines = s._count?.scanItems ?? 0
  const total = s.total ? Number(s.total) : null
  const metaBits = [
    s.invoiceNumber ? `INVOICE #${s.invoiceNumber}` : 'INVOICE',
    `${lines} ${lines === 1 ? 'LINE' : 'LINES'}`,
    total != null ? fmtMoney(total) : null,
  ].filter(Boolean)
  return {
    id: `inv-${s.id}`,
    kind: 'invoice',
    category: isError ? 'exceptions' : 'invoices',
    tone: isError ? 'red' : 'gold',
    icon: isError ? 'exception' : 'invoice',
    title: [s.supplierName ?? 'Unknown supplier', dateStr].filter(Boolean).join(' · '),
    meta: metaBits.join(' · '),
    badge: STATUS_BADGE[s.status],
    needsAction: s.status === 'REVIEW' || isError,
    ageMs: Date.now() - new Date(s.createdAt).getTime(),
    raw: s,
  }
}

const STATUS_BADGE: Partial<Record<SessionStatus, string>> = {
  REVIEW: 'REVIEW', PROCESSING: 'OCR…', UPLOADING: 'UPLOAD…', APPROVING: 'APPLYING…', ERROR: 'ERROR',
}

function categoryOfRule(rule: string): InboxCategory {
  if (rule === 'PRICE_SPIKE' || rule === 'RECIPE_DRIFT') return 'prices'
  if (rule === 'COUNT_OVERDUE' || rule === 'WASTAGE_SPIKE') return 'variance'
  return 'other'
}

function signalToItem(sig: Signal): InboxItem | null {
  if (sig.status !== 'OPEN') return null
  const cat = categoryOfRule(sig.rule)
  const tone = sig.severity === 'critical' ? 'red' : sig.severity === 'warn' ? 'gold' : 'ink3'
  return {
    id: `sig-${sig.id}`,
    kind: 'signal',
    category: cat,
    tone,
    icon: cat === 'prices' ? 'price' : cat === 'variance' ? 'variance' : 'signal',
    title: sig.title,
    meta: sig.rule.replaceAll('_', ' ') + (sig.body ? ` · ${sig.body}` : ''),
    impact: sig.impactValue != null && sig.impactValue > 0 ? '+' + fmtMoney(sig.impactValue) : undefined,
    needsAction: sig.severity === 'critical',
    ageMs: Date.now() - new Date(sig.createdAt).getTime(),
    raw: sig,
  }
}

/** Merge sessions + signals → one sorted feed. needs-action first, then oldest first. */
export function toInboxItems(sessions: SessionSummary[], signals: Signal[]): InboxItem[] {
  const items = [
    ...sessions.map(sessionToItem),
    ...signals.map(signalToItem),
  ].filter((x): x is InboxItem => x !== null)
  return items.sort((a, b) => {
    if (a.needsAction !== b.needsAction) return a.needsAction ? -1 : 1
    return b.ageMs - a.ageMs // oldest first
  })
}

export type ChipId = 'all' | InboxCategory
export const INBOX_CHIPS: { id: ChipId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'prices', label: 'Prices' },
  { id: 'variance', label: 'Variance' },
  { id: 'exceptions', label: 'Exceptions' },
]

export function inboxCounts(items: InboxItem[]): Record<ChipId, number> {
  const c: Record<ChipId, number> = { all: items.length, invoices: 0, prices: 0, variance: 0, exceptions: 0, other: 0 }
  for (const it of items) c[it.category] = (c[it.category] ?? 0) + 1
  return c
}

export function filterByChip(items: InboxItem[], chip: ChipId): InboxItem[] {
  if (chip === 'all') return items
  return items.filter(it => it.category === chip)
}
```

- [ ] **Step 2: Build** — `export PATH=… NODE_OPTIONS="--dns-result-order=ipv4first" && rm -rf .next && npm run build 2>&1 | grep -E "Compiled successfully|Failed|Type error"`. Expect `✓ Compiled successfully` (not yet imported).
- [ ] **Step 3: Commit** — `git add src/lib/invoices/inbox-items.ts && git commit -m "feat(invoices): inbox-items normalizer (sessions + signals → feed)"`

---

### Task 2: `InboxChips`

**Files:** Create `src/components/invoices/mobile/InboxChips.tsx`

- [ ] **Step 1: Write it**

```tsx
'use client'
import { INBOX_CHIPS, ChipId } from '@/lib/invoices/inbox-items'

export function InboxChips({ active, counts, onPick }: {
  active: ChipId
  counts: Record<ChipId, number>
  onPick: (id: ChipId) => void
}) {
  return (
    <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {INBOX_CHIPS.map(chip => {
        const on = active === chip.id
        const n = counts[chip.id] ?? 0
        return (
          <button
            key={chip.id}
            onClick={() => onPick(chip.id)}
            className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium tracking-[-0.005em] border transition-colors ${
              on ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'
            }`}
          >
            {chip.label}
            <span className={`font-mono text-[10px] ${on ? 'text-gold' : 'text-ink-4'}`}>{n}</span>
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Build.** Expect `✓ Compiled successfully`.
- [ ] **Step 3: Commit** — `git add src/components/invoices/mobile/InboxChips.tsx && git commit -m "feat(invoices): mobile inbox chip row"`

---

### Task 3: `InboxInvoiceCard`

**Files:** Create `src/components/invoices/mobile/InboxInvoiceCard.tsx`

Surfaces a session as a left-accent card. The full unmatched line list lives in the review drawer (SessionSummary has no per-line data); this card shows status/lines/total + a Review CTA when actionable.

- [ ] **Step 1: Write it**

```tsx
'use client'
import { FileText, AlertTriangle, ChevronRight } from 'lucide-react'
import { InboxItem, fmtAge } from '@/lib/invoices/inbox-items'
import type { SessionSummary } from '@/components/invoices/types'

const TONE: Record<string, { border: string; iconBg: string; icon: string; badge: string }> = {
  gold: { border: '#d97706', iconBg: 'bg-gold-soft', icon: 'text-gold-2', badge: 'bg-gold-soft text-gold-2' },
  red:  { border: '#dc2626', iconBg: 'bg-red-soft',  icon: 'text-red-text', badge: 'bg-red-soft text-red-text' },
}

export function InboxInvoiceCard({ item, onOpen }: { item: InboxItem; onOpen: (sessionId: string) => void }) {
  const s = item.raw as SessionSummary
  const t = TONE[item.tone] ?? TONE.gold
  return (
    <button
      type="button"
      onClick={() => onOpen(s.id)}
      className="w-full text-left bg-paper border border-line rounded-xl p-3 flex items-start gap-3 active:bg-bg-2 transition-colors"
      style={{ borderLeftWidth: 3, borderLeftColor: t.border }}
    >
      <span className={`w-8 h-8 rounded-lg grid place-items-center shrink-0 ${t.iconBg}`}>
        {item.icon === 'exception' ? <AlertTriangle size={16} className={t.icon} /> : <FileText size={16} className={t.icon} />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[14.5px] font-semibold tracking-[-0.01em] text-ink truncate">{item.title}</div>
        <div className="font-mono text-[10.5px] text-ink-3 truncate mt-0.5">{item.meta}</div>
        {item.needsAction && (
          <span className="inline-flex items-center gap-1 mt-2 font-mono text-[10.5px] font-semibold text-gold-2 bg-gold-soft px-2 py-1 rounded-full">
            Review <ChevronRight size={12} />
          </span>
        )}
      </div>
      <div className="text-right shrink-0">
        {item.badge && <span className={`font-mono text-[9px] font-semibold px-1.5 py-0.5 rounded ${t.badge}`}>{item.badge}</span>}
        <div className="font-mono text-[9.5px] text-ink-4 mt-1">{fmtAge(s.createdAt)} ago</div>
      </div>
    </button>
  )
}
```

- [ ] **Step 2: Build.** Expect pass.
- [ ] **Step 3: Commit** — `git add src/components/invoices/mobile/InboxInvoiceCard.tsx && git commit -m "feat(invoices): mobile inbox invoice card"`

---

### Task 4: `InboxSignalCard`

**Files:** Create `src/components/invoices/mobile/InboxSignalCard.tsx`

- [ ] **Step 1: Write it**

```tsx
'use client'
import { TrendingUp, Activity, Zap, ChevronRight } from 'lucide-react'
import { InboxItem, fmtAge, Signal } from '@/lib/invoices/inbox-items'

const ICON = { price: TrendingUp, variance: Activity, signal: Zap } as const

export function InboxSignalCard({ item, onOpen }: { item: InboxItem; onOpen: (item: InboxItem) => void }) {
  const sig = item.raw as Signal
  const Icon = ICON[item.icon as keyof typeof ICON] ?? Zap
  const border = item.tone === 'red' ? '#dc2626' : item.tone === 'gold' ? '#d97706' : '#a1a1aa'
  const iconCls = item.tone === 'red' ? 'text-red-text' : item.tone === 'gold' ? 'text-gold-2' : 'text-ink-3'
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="w-full text-left bg-paper border border-line rounded-xl p-3 flex items-start gap-3 active:bg-bg-2 transition-colors"
      style={{ borderLeftWidth: 3, borderLeftColor: border }}
    >
      <span className="w-8 h-8 rounded-lg grid place-items-center shrink-0 bg-bg-2">
        <Icon size={16} className={iconCls} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[14.5px] font-semibold tracking-[-0.01em] text-ink truncate">{item.title}</div>
        <div className="font-mono text-[10.5px] text-ink-3 truncate mt-0.5">{item.meta}</div>
      </div>
      <div className="text-right shrink-0 flex flex-col items-end">
        {item.impact && <div className={`font-mono text-[14px] font-semibold ${item.tone === 'red' ? 'text-red-text' : 'text-ink-2'}`}>{item.impact}</div>}
        <div className="font-mono text-[9.5px] text-ink-4 mt-0.5 flex items-center gap-1">{fmtAge(sig.createdAt)} ago <ChevronRight size={12} className="text-ink-4" /></div>
      </div>
    </button>
  )
}
```

- [ ] **Step 2: Build.** Expect pass.
- [ ] **Step 3: Commit** — `git add src/components/invoices/mobile/InboxSignalCard.tsx && git commit -m "feat(invoices): mobile inbox signal card"`

---

### Task 5: `SignalSheet`

**Files:** Create `src/components/invoices/mobile/SignalSheet.tsx`

Bottom sheet (app's standard mobile pattern). Apply/Snooze/Dismiss → `onAct`.

- [ ] **Step 1: Write it**

```tsx
'use client'
import { X } from 'lucide-react'
import { InboxItem, Signal } from '@/lib/invoices/inbox-items'

export function SignalSheet({ item, onClose, onAct }: {
  item: InboxItem | null
  onClose: () => void
  onAct: (id: string, action: 'apply' | 'snooze' | 'dismiss') => void
}) {
  if (!item || item.kind !== 'signal') return null
  const sig = item.raw as Signal
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:hidden">
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div className="relative z-50 bg-paper w-full rounded-t-2xl max-h-[85dvh] overflow-y-auto pb-safe">
        <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3 border-b border-line">
          <div className="min-w-0">
            <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">{sig.rule.replaceAll('_', ' ')}</div>
            <h2 className="text-[19px] font-semibold text-ink tracking-[-0.02em] leading-tight mt-1">{sig.title}</h2>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-full bg-bg-2 grid place-items-center text-ink-3 shrink-0"><X size={16} /></button>
        </div>

        <div className="px-4 py-4 space-y-4">
          {sig.impactValue != null && sig.impactValue > 0 && (
            <div className="bg-ink rounded-xl p-4 flex items-center justify-between">
              <div className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.06em]">Estimated impact</div>
              <div className="font-mono text-[22px] font-semibold text-gold">{'+$' + Number(sig.impactValue).toFixed(2)}</div>
            </div>
          )}
          <p className="text-[13.5px] text-ink-2 leading-relaxed">{sig.body}</p>
        </div>

        <div className="border-t border-line px-4 py-3 grid grid-cols-3 gap-2 pb-safe">
          <button onClick={() => onAct(sig.id, 'dismiss')} className="py-2.5 rounded-xl text-[13px] font-medium text-ink-3 border border-line active:bg-bg-2">Dismiss</button>
          <button onClick={() => onAct(sig.id, 'snooze')} className="py-2.5 rounded-xl text-[13px] font-medium text-ink-2 border border-line active:bg-bg-2">Snooze</button>
          <button onClick={() => onAct(sig.id, 'apply')} className="py-2.5 rounded-xl text-[13px] font-semibold bg-ink text-paper active:bg-ink-2">Apply</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Build.** Expect pass.
- [ ] **Step 3: Commit** — `git add src/components/invoices/mobile/SignalSheet.tsx && git commit -m "feat(invoices): mobile signal detail sheet"`

---

### Task 6: `MobileInbox` orchestrator

**Files:** Create `src/components/invoices/mobile/MobileInbox.tsx`

- [ ] **Step 1: Write it**

```tsx
'use client'
import { useMemo, useState } from 'react'
import { Upload, Camera, Inbox as InboxIcon } from 'lucide-react'
import type { SessionSummary } from '@/components/invoices/types'
import { Signal, toInboxItems, inboxCounts, filterByChip, fmtAge, ChipId, InboxItem } from '@/lib/invoices/inbox-items'
import { InboxChips } from './InboxChips'
import { InboxInvoiceCard } from './InboxInvoiceCard'
import { InboxSignalCard } from './InboxSignalCard'
import { SignalSheet } from './SignalSheet'

const EMPTY_TEXT: Record<ChipId, string> = {
  all: 'Inbox is empty — nothing needs you.',
  invoices: 'No invoices in the queue.',
  prices: 'No price alerts.',
  variance: 'No variance or wastage alerts.',
  exceptions: 'No exceptions to resolve.',
  other: 'Nothing here.',
}

export function MobileInbox({ sessions, signals, onSelectSession, onUploadClick, onScanClick, onSignalAct }: {
  sessions: SessionSummary[]
  signals: Signal[]
  onSelectSession: (id: string) => void
  onUploadClick: () => void
  onScanClick?: () => void
  onSignalAct: (id: string, action: 'apply' | 'snooze' | 'dismiss') => void
}) {
  const [chip, setChip] = useState<ChipId>('all')
  const [sheet, setSheet] = useState<InboxItem | null>(null)

  const items = useMemo(() => toInboxItems(sessions, signals), [sessions, signals])
  const counts = useMemo(() => inboxCounts(items), [items])
  const visible = useMemo(() => filterByChip(items, chip), [items, chip])
  const oldest = items.length ? fmtAge((items[items.length - 1].raw as { createdAt: string }).createdAt) : null

  return (
    <div className="space-y-3">
      {/* Compact header */}
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em] flex items-center gap-1.5">
            <InboxIcon size={11} /> INBOX / INVOICES
          </div>
          <h1 className="text-[26px] font-semibold text-ink tracking-[-0.03em] leading-none mt-1">Invoices</h1>
          <div className="font-mono text-[10.5px] text-ink-4 mt-1.5">
            {items.length} {items.length === 1 ? 'ITEM' : 'ITEMS'}{oldest ? ` · OLDEST ${oldest.toUpperCase()} AGO` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onScanClick && (
            <button onClick={onScanClick} className="w-10 h-10 rounded-xl bg-paper border border-line grid place-items-center text-ink-2 active:bg-bg-2"><Camera size={17} /></button>
          )}
          <button onClick={onUploadClick} className="inline-flex items-center gap-1.5 px-3.5 h-10 rounded-xl bg-ink text-paper text-[13px] font-medium active:bg-ink-2">
            <Upload size={15} className="text-gold" /> Upload
          </button>
        </div>
      </div>

      <InboxChips active={chip} counts={counts} onPick={setChip} />

      {visible.length === 0 ? (
        <div className="bg-paper border border-line rounded-xl py-10 text-center">
          <p className="font-mono text-[11px] text-green-text uppercase tracking-[0.06em]">All clear</p>
          <p className="text-[13px] text-ink-3 mt-1">{EMPTY_TEXT[chip]}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {visible.map(it => it.kind === 'invoice'
            ? <InboxInvoiceCard key={it.id} item={it} onOpen={onSelectSession} />
            : <InboxSignalCard key={it.id} item={it} onOpen={setSheet} />
          )}
        </div>
      )}

      <SignalSheet item={sheet} onClose={() => setSheet(null)} onAct={(id, action) => { onSignalAct(id, action); setSheet(null) }} />
    </div>
  )
}
```

- [ ] **Step 2: Build.** Expect pass.
- [ ] **Step 3: Commit** — `git add src/components/invoices/mobile/MobileInbox.tsx && git commit -m "feat(invoices): MobileInbox orchestrator"`

---

### Task 7: Wire into the page (dual-renderer)

**Files:** Modify `src/app/invoices/page.tsx`

- [ ] **Step 1: Add signals state + fetch + action handler**

Add imports near the top:
```tsx
import { MobileInbox } from '@/components/invoices/mobile/MobileInbox'
import { Signal } from '@/lib/invoices/inbox-items'
```
Add state alongside the existing `useState`s (after `const [sessions, setSessions] = …`):
```tsx
const [signals, setSignals] = useState<Signal[]>([])
```
Add a fetcher and call it from the existing `fetchSessions` (so they refresh together). Inside `fetchSessions`, after `setSessions(data)`, add a parallel signals fetch (non-blocking):
```tsx
fetch('/api/signals', { cache: 'no-store' })
  .then(r => r.ok ? r.json() : null)
  .then(j => { if (j?.signals) setSignals(j.signals) })
  .catch(() => {})
```
Add the action handler (mirrors the Signals page), placed with the other `useCallback` handlers:
```tsx
const handleSignalAct = useCallback(async (id: string, action: 'apply' | 'snooze' | 'dismiss') => {
  // optimistic remove
  setSignals(prev => prev.filter(s => s.id !== id))
  try {
    await fetch('/api/signals', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id], action }) })
  } catch { /* poll will resync */ }
}, [])
```

- [ ] **Step 2: Dual-renderer — wrap desktop, add mobile**

In the returned JSX, the inner `<div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">` currently holds `PageHead`, `InvoiceKpiStripV2`, and the inbox/history switch. Wrap THAT desktop content block in `hidden sm:block`, and add the mobile inbox before it. Concretely, change the wrapper to render both:

```tsx
<div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">
  {/* ── Mobile: unified inbox feed ── */}
  <div className="block sm:hidden">
    <MobileInbox
      sessions={sessions}
      signals={signals}
      onSelectSession={setSelectedSessionId}
      onUploadClick={() => setShowUpload(true)}
      onScanClick={isNative() ? triggerScan : undefined}
      onSignalAct={handleSignalAct}
    />
  </div>

  {/* ── Desktop: existing V2 (unchanged) ── */}
  <div className="hidden sm:block">
    <PageHead … />            {/* keep existing */}
    <InvoiceKpiStripV2 … />   {/* keep existing */}
    {view === 'inbox' ? <InboxViewV2 … /> : <InvoiceListV2 … />}  {/* keep existing */}
  </div>

  {/* shared overlays stay OUTSIDE both wrappers, mounted once: scanError, isScanning, InvoiceDrawer, InvoiceUploadModal */}
</div>
```
Leave `InboxSubNav` (outside the wrapper), `scanError`, `isScanning`, `<InvoiceDrawer …>`, and `<InvoiceUploadModal …>` exactly where they are — they're shared. Only the `PageHead` + `InvoiceKpiStripV2` + inbox/history block move under `hidden sm:block`.

Note: `InboxSubNav` is a separate desktop sub-nav rendered before the container; verify it's already hidden on mobile (it uses the SubNav component). If it shows on mobile, wrap its usage `<div className="hidden sm:block"><InboxSubNav /></div>`.

- [ ] **Step 3: Build (server stopped)** — clean build. Expect `✓ Compiled successfully`.
- [ ] **Step 4: Commit** — `git add src/app/invoices/page.tsx && git commit -m "feat(invoices): mobile unified inbox renderer (dual-renderer)"`

---

### Task 8: Browser verification

**Files:** none.

- [ ] **Step 1:** `preview_start`; resize 390×844; navigate `/invoices`. `preview_console_logs` (errors: none).
- [ ] **Step 2:** `preview_screenshot` — compact "Invoices" header + chip row + card feed. NO horizontal KPI scroll, NO clipped cards.
- [ ] **Step 3:** Tap each chip (`preview_click` a chip button) — feed filters; counts match.
- [ ] **Step 4:** Tap an invoice card → `InvoiceReviewDrawer` opens full-screen. Close.
- [ ] **Step 5:** If a price/variance signal exists, tap it → `SignalSheet` opens; tap Snooze → sheet closes and item leaves the feed (optimistic) + `/api/signals` PATCH fires (`preview_network`).
- [ ] **Step 6:** Tap Upload → `InvoiceUploadModal` opens.
- [ ] **Step 7:** Resize to 1280×800 → desktop `/invoices` visually unchanged (PageHead + KPI strip + V2 list). Mobile inbox hidden.
- [ ] **Step 8:** Final clean build + commit any fixes; restart dev server.

---

## Self-Review notes
- **Spec coverage:** normalizer + category mapping (Task 1), chips (Task 2), invoice card (Task 3), signal card (Task 4), signal sheet + Apply/Snooze/Dismiss (Task 5), compact header + feed + empty states + orchestration (Task 6), signals fetch + handler + dual-renderer + keep-name (Task 7), all verification incl. desktop-unchanged (Task 8). Reuse of `InvoiceReviewDrawer`/`InvoiceUploadModal`/APIs honored. ✓
- **Type consistency:** `InboxItem`, `Signal`, `ChipId`, `toInboxItems/inboxCounts/filterByChip/fmtAge` defined in Task 1, used identically in Tasks 2–7. `onSignalAct(id, action)` and the `{ ids:[id], action }` PATCH body consistent (Task 5 ↔ 7). Card `onOpen` signatures: invoice card `(sessionId)`, signal card `(item)` — matched in Task 6. ✓
- **No OCR%:** SessionSummary lacks an OCR-confidence aggregate, so the invoice badge shows status (REVIEW/OCR…/ERROR), not the design's "92%". Intentional — noted in card (Task 3) and meta builder (Task 1). ✓
- **Naming:** "Invoices" kept (header Task 6, no nav change). ✓
