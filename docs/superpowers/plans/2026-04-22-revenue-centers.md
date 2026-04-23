# Revenue Centers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Revenue Centers — named operational streams (Restaurant, Catering, Events) sharing one physical inventory pool — so the app can attribute costs, purchases, sales, wastage, and stock counts per revenue stream.

**Architecture:** A global `RevenueCenterContext` (React Context + localStorage) holds the active RC and applies it across all pages simultaneously. Physical inventory is unchanged; each RC has a virtual `StockAllocation` balance per item. Transactional models (invoices, sales, wastage, count sessions) gain a `revenueCenterId` field. Invoice approval generates read-only clone sessions for any line items tagged to a non-default RC.

**Tech Stack:** Next.js 14 App Router · Prisma + PostgreSQL · Tailwind CSS · React Context API

---

## File Map

**New files:**
- `src/lib/rc-colors.ts` — color name → hex map and `rcHex()` helper
- `src/contexts/RevenueCenterContext.tsx` — global RC context + provider
- `src/components/navigation/RcSelector.tsx` — desktop sidebar RC switcher
- `src/components/navigation/MobileRcBar.tsx` — mobile sticky RC bar + bottom sheet
- `src/app/api/revenue-centers/route.ts` — GET list + POST create
- `src/app/api/revenue-centers/[id]/route.ts` — GET + PATCH + DELETE single RC
- `src/app/api/stock-transfers/route.ts` — POST pull transfer + GET list
- `src/app/revenue-centers/page.tsx` — RC management CRUD page
- `src/app/revenue-centers/loading.tsx` — skeleton
- `src/components/inventory/RcAllocationPanel.tsx` — per-item stock-by-RC breakdown + pull form

**Modified files:**
- `prisma/schema.prisma` — new models + RC fields on existing models
- `src/app/layout.tsx` — wrap with `RcProvider`, add `MobileRcBar`, add mobile top padding
- `src/components/Navigation.tsx` — insert `RcSelector` between logo block and nav links; add RC color accent to active link
- `src/app/api/invoices/sessions/route.ts` — accept `revenueCenterId` in POST
- `src/app/api/invoices/sessions/[id]/approve/route.ts` — generate clone sessions for non-session-RC line items
- `src/components/invoices/InvoiceDrawer.tsx` — session-level RC selector + per-line RC override dropdown
- `src/components/invoices/InvoiceList.tsx` — filter sessions by active RC; show clone badge
- `src/app/invoices/page.tsx` — pass `activeRcId` to `InvoiceList`
- `src/app/api/wastage/route.ts` — accept + filter by `revenueCenterId`
- `src/app/wastage/page.tsx` — pass `activeRcId` in GET; add RC field to log form
- `src/app/api/sales/route.ts` — accept + filter by `revenueCenterId`
- `src/app/sales/page.tsx` — pass `activeRcId` in GET; add RC field to entry form
- `src/app/api/count/sessions/route.ts` — accept + store `revenueCenterId`; filter list by RC
- `src/app/api/count/sessions/[id]/finalize/route.ts` — update `StockAllocation` rows on finalize
- `src/app/count/page.tsx` — add RC selector to new session form
- `src/app/api/reports/cogs/route.ts` — accept `?rcId=` param; filter purchases + sessions by RC

---

## Task 1: Prisma Schema — Add Revenue Center Models and Fields

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add new models to `prisma/schema.prisma`**

Append after the `PrepSettings` model at the bottom of the file:

```prisma
model RevenueCenter {
  id        String   @id @default(cuid())
  name      String
  color     String   // "blue" | "amber" | "purple" | "green" | "rose" | "teal" | "orange" | "indigo"
  isDefault Boolean  @default(false)
  createdAt DateTime @default(now())

  stockAllocations StockAllocation[]
  transfersFrom    StockTransfer[]   @relation("TransferFrom")
  transfersTo      StockTransfer[]   @relation("TransferTo")
  invoiceSessions  InvoiceSession[]  @relation("SessionRC")
  wastageLog       WastageLog[]      @relation("WastageRC")
  salesEntries     SalesEntry[]      @relation("SalesRC")
  countSessions    CountSession[]    @relation("CountRC")
}

model StockAllocation {
  id              String        @id @default(cuid())
  revenueCenterId String
  revenueCenter   RevenueCenter @relation(fields: [revenueCenterId], references: [id], onDelete: Cascade)
  inventoryItemId String
  inventoryItem   InventoryItem @relation(fields: [inventoryItemId], references: [id], onDelete: Cascade)
  quantity        Decimal       @default(0)
  updatedAt       DateTime      @updatedAt

  @@unique([revenueCenterId, inventoryItemId])
}

model StockTransfer {
  id              String        @id @default(cuid())
  fromRcId        String
  fromRc          RevenueCenter @relation("TransferFrom", fields: [fromRcId], references: [id])
  toRcId          String
  toRc            RevenueCenter @relation("TransferTo", fields: [toRcId], references: [id])
  inventoryItemId String
  inventoryItem   InventoryItem @relation(fields: [inventoryItemId], references: [id])
  quantity        Decimal
  notes           String?
  createdAt       DateTime      @default(now())
}
```

- [ ] **Step 2: Add RC fields to existing models**

In `InventoryItem`, add after the `prepItems` relation:
```prisma
  stockAllocations StockAllocation[]
  stockTransfers   StockTransfer[]
```

In `InvoiceSession`, add after `createdAt`:
```prisma
  revenueCenterId String?
  revenueCenter   RevenueCenter? @relation("SessionRC", fields: [revenueCenterId], references: [id])
  parentSessionId String?
```

In `InvoiceScanItem`, add after `sortOrder`:
```prisma
  revenueCenterId String?
```

In `WastageLog`, add after `notes`:
```prisma
  revenueCenterId String?
  revenueCenter   RevenueCenter? @relation("WastageRC", fields: [revenueCenterId], references: [id])
```

In `SalesEntry`, add after `createdAt`:
```prisma
  revenueCenterId String?
  revenueCenter   RevenueCenter? @relation("SalesRC", fields: [revenueCenterId], references: [id])
```

In `CountSession`, add after `notes`:
```prisma
  revenueCenterId String?
  revenueCenter   RevenueCenter? @relation("CountRC", fields: [revenueCenterId], references: [id])
```

- [ ] **Step 3: Run migration**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
npx prisma migrate dev --name add_revenue_centers
```

Expected: migration file created, database updated, no errors.

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: Compiled successfully. Zero TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add RevenueCenter, StockAllocation, StockTransfer schema; add RC fields to Invoice/Wastage/Sales/Count"
```

---

## Task 2: RC Color Utility + Revenue Center API

**Files:**
- Create: `src/lib/rc-colors.ts`
- Create: `src/app/api/revenue-centers/route.ts`
- Create: `src/app/api/revenue-centers/[id]/route.ts`

- [ ] **Step 1: Create `src/lib/rc-colors.ts`**

```ts
export const RC_COLOR_MAP: Record<string, string> = {
  blue:   '#3B82F6',
  amber:  '#F59E0B',
  purple: '#8B5CF6',
  green:  '#22C55E',
  rose:   '#F43F5E',
  teal:   '#14B8A6',
  orange: '#F97316',
  indigo: '#6366F1',
}

export const RC_COLORS = Object.keys(RC_COLOR_MAP) as string[]

export function rcHex(color: string): string {
  return RC_COLOR_MAP[color] ?? '#6B7280'
}
```

- [ ] **Step 2: Create `src/app/api/revenue-centers/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/revenue-centers — list all RCs; auto-seeds default if none exist
export async function GET() {
  let rcs = await prisma.revenueCenter.findMany({ orderBy: { createdAt: 'asc' } })

  if (rcs.length === 0) {
    const defaultRc = await prisma.revenueCenter.create({
      data: { name: 'Main Kitchen', color: 'blue', isDefault: true },
    })
    rcs = [defaultRc]
  }

  return NextResponse.json(rcs)
}

// POST /api/revenue-centers — create a new RC
export async function POST(req: NextRequest) {
  const { name, color, isDefault } = await req.json()

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  if (isDefault) {
    await prisma.revenueCenter.updateMany({ data: { isDefault: false } })
  }

  const rc = await prisma.revenueCenter.create({
    data: { name: name.trim(), color: color || 'blue', isDefault: !!isDefault },
  })

  return NextResponse.json(rc, { status: 201 })
}
```

- [ ] **Step 3: Create `src/app/api/revenue-centers/[id]/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const rc = await prisma.revenueCenter.findUnique({ where: { id: params.id } })
  if (!rc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(rc)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { name, color, isDefault } = await req.json()

  if (isDefault) {
    await prisma.revenueCenter.updateMany({ data: { isDefault: false } })
  }

  const rc = await prisma.revenueCenter.update({
    where: { id: params.id },
    data: {
      ...(name ? { name: name.trim() } : {}),
      ...(color ? { color } : {}),
      ...(isDefault !== undefined ? { isDefault: !!isDefault } : {}),
    },
  })

  return NextResponse.json(rc)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const rc = await prisma.revenueCenter.findUnique({ where: { id: params.id } })
  if (!rc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (rc.isDefault) {
    return NextResponse.json({ error: 'Cannot delete the default revenue center' }, { status: 400 })
  }

  // Block delete if RC has linked data
  const [invoiceCount, salesCount, wastageCount, countCount] = await Promise.all([
    prisma.invoiceSession.count({ where: { revenueCenterId: params.id } }),
    prisma.salesEntry.count({ where: { revenueCenterId: params.id } }),
    prisma.wastageLog.count({ where: { revenueCenterId: params.id } }),
    prisma.countSession.count({ where: { revenueCenterId: params.id } }),
  ])

  if (invoiceCount + salesCount + wastageCount + countCount > 0) {
    return NextResponse.json({
      error: 'Cannot delete: this revenue center has linked invoices, sales, wastage, or count sessions.',
    }, { status: 400 })
  }

  await prisma.revenueCenter.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: Compiled successfully.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rc-colors.ts src/app/api/revenue-centers/
git commit -m "feat: revenue center API routes + rc-colors utility"
```

---

## Task 3: Revenue Center React Context

**Files:**
- Create: `src/contexts/RevenueCenterContext.tsx`

- [ ] **Step 1: Create `src/contexts/RevenueCenterContext.tsx`**

```tsx
'use client'
import { createContext, useContext, useState, useEffect, useCallback } from 'react'

export interface RevenueCenter {
  id: string
  name: string
  color: string
  isDefault: boolean
  createdAt: string
}

interface RcContextValue {
  revenueCenters: RevenueCenter[]
  activeRcId: string | null
  activeRc: RevenueCenter | null
  setActiveRcId: (id: string) => void
  reload: () => Promise<void>
}

const RcContext = createContext<RcContextValue>({
  revenueCenters: [],
  activeRcId: null,
  activeRc: null,
  setActiveRcId: () => {},
  reload: async () => {},
})

export function RcProvider({ children }: { children: React.ReactNode }) {
  const [revenueCenters, setRevenueCenters] = useState<RevenueCenter[]>([])
  const [activeRcId, setActiveRcIdState] = useState<string | null>(null)

  const load = useCallback(async () => {
    const data: RevenueCenter[] = await fetch('/api/revenue-centers').then(r => r.json())
    setRevenueCenters(data)
    setActiveRcIdState(prev => {
      const stored = typeof window !== 'undefined' ? localStorage.getItem('activeRcId') : null
      if (stored && data.find(rc => rc.id === stored)) return stored
      return data.find(rc => rc.isDefault)?.id ?? data[0]?.id ?? null
    })
  }, [])

  useEffect(() => { load() }, [load])

  const setActiveRcId = (id: string) => {
    setActiveRcIdState(id)
    if (typeof window !== 'undefined') localStorage.setItem('activeRcId', id)
  }

  const activeRc = revenueCenters.find(rc => rc.id === activeRcId) ?? null

  return (
    <RcContext.Provider value={{ revenueCenters, activeRcId, activeRc, setActiveRcId, reload: load }}>
      {children}
    </RcContext.Provider>
  )
}

export const useRc = () => useContext(RcContext)
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Compiled successfully.

- [ ] **Step 3: Commit**

```bash
git add src/contexts/RevenueCenterContext.tsx
git commit -m "feat: RevenueCenterContext with localStorage persistence"
```

---

## Task 4: Navigation — Desktop RC Selector + Layout Provider

**Files:**
- Create: `src/components/navigation/RcSelector.tsx`
- Modify: `src/components/Navigation.tsx`
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Create `src/components/navigation/RcSelector.tsx`**

```tsx
'use client'
import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { ChevronDown, Check, Settings2 } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

export function RcSelector() {
  const { revenueCenters, activeRc, setActiveRcId } = useRc()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (!activeRc) return null

  const hex = rcHex(activeRc.color)

  return (
    <div ref={ref} className="relative px-3 py-2 border-b border-gray-700">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors text-left"
      >
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: hex }} />
        <span className="flex-1 text-sm text-gray-100 truncate">{activeRc.name}</span>
        <ChevronDown size={14} className="text-gray-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-3 right-3 top-full mt-1 bg-gray-800 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
          {revenueCenters.map(rc => (
            <button
              key={rc.id}
              onClick={() => { setActiveRcId(rc.id); setOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-700 transition-colors text-left"
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
              <span className="flex-1 text-sm text-gray-100 truncate">{rc.name}</span>
              {rc.id === activeRc.id && <Check size={14} className="text-blue-400" />}
            </button>
          ))}
          <div className="border-t border-gray-700 p-1">
            <Link
              href="/revenue-centers"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors"
            >
              <Settings2 size={12} />
              Manage Revenue Centers
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add `RcSelector` to `src/components/Navigation.tsx`**

Add the import at the top of the file:
```tsx
import { RcSelector } from '@/components/navigation/RcSelector'
```

In the desktop `<aside>` block, insert `<RcSelector />` between the logo block's closing `</div>` and `<nav className="flex-1 p-3">`. The section currently reads:
```tsx
        </div>
        <nav className="flex-1 p-3">
```

Change to:
```tsx
        </div>
        <RcSelector />
        <nav className="flex-1 p-3">
```

Also update the active nav link to show RC color accent. Find the className for the active link:
```tsx
active ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800 hover:text-white'
```

And add a dynamic style to the active `<Link>`:
```tsx
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'
```

Add `const { activeRc } = useRc()` inside `NavigationInner()` and update the active link:
```tsx
<Link
  href={href}
  style={active ? { borderLeftColor: rcHex(activeRc?.color ?? 'blue'), borderLeftWidth: 3 } : undefined}
  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
    active ? 'bg-blue-600 text-white pl-[9px]' : 'text-gray-300 hover:bg-gray-800 hover:text-white'
  }`}
>
```

(The `pl-[9px]` compensates for the 3px border so text doesn't shift.)

- [ ] **Step 3: Wrap layout with `RcProvider` in `src/app/layout.tsx`**

Add imports:
```tsx
import { RcProvider } from '@/contexts/RevenueCenterContext'
```

Wrap the body content:
```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <RcProvider>
          <Navigation />
          <GlobalSearch />
          <main className="md:ml-56 pb-20 md:pb-0 min-h-screen bg-gray-50">
            <div className="p-4 md:p-6 max-w-7xl mx-auto">
              {children}
            </div>
          </main>
        </RcProvider>
      </body>
    </html>
  )
}
```

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: Compiled successfully.

- [ ] **Step 5: Commit**

```bash
git add src/components/navigation/RcSelector.tsx src/components/Navigation.tsx src/app/layout.tsx
git commit -m "feat: desktop RC selector in sidebar + RcProvider wraps layout"
```

---

## Task 5: Navigation — Mobile RC Sticky Bar

**Files:**
- Create: `src/components/navigation/MobileRcBar.tsx`
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Create `src/components/navigation/MobileRcBar.tsx`**

```tsx
'use client'
import { useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

export function MobileRcBar() {
  const { revenueCenters, activeRc, setActiveRcId } = useRc()
  const [open, setOpen] = useState(false)

  if (!activeRc) return null
  const hex = rcHex(activeRc.color)

  return (
    <>
      <div
        className="md:hidden fixed top-0 left-0 right-0 z-40 bg-white border-b border-gray-100 flex items-center px-4 h-10"
        style={{ borderLeftColor: hex, borderLeftWidth: 3 }}
      >
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 text-sm font-medium text-gray-700"
        >
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: hex }} />
          {activeRc.name}
          <ChevronDown size={14} className="text-gray-400" />
        </button>
      </div>

      {open && (
        <>
          <div className="md:hidden fixed inset-0 bg-black/40 z-[60]" onClick={() => setOpen(false)} />
          <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white rounded-t-2xl z-[70] shadow-xl pb-safe">
            <div className="px-5 pt-4 pb-2 text-sm font-semibold text-gray-700">Revenue Center</div>
            <div className="px-4 pb-8 space-y-1">
              {revenueCenters.map(rc => (
                <button
                  key={rc.id}
                  onClick={() => { setActiveRcId(rc.id); setOpen(false) }}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-50 transition-colors"
                >
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
                  <span className="flex-1 text-sm text-gray-800 text-left">{rc.name}</span>
                  {rc.id === activeRc.id && <Check size={16} className="text-blue-500" />}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  )
}
```

- [ ] **Step 2: Add `MobileRcBar` to layout and add top padding on mobile**

In `src/app/layout.tsx`, add import:
```tsx
import { MobileRcBar } from '@/components/navigation/MobileRcBar'
```

Add `<MobileRcBar />` after `<Navigation />`:
```tsx
        <RcProvider>
          <Navigation />
          <MobileRcBar />
          <GlobalSearch />
          <main className="md:ml-56 pb-20 md:pb-0 pt-10 md:pt-0 min-h-screen bg-gray-50">
```

(`pt-10` = 40px on mobile to clear the sticky RC bar; `md:pt-0` removes it on desktop.)

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: Compiled successfully.

- [ ] **Step 4: Commit**

```bash
git add src/components/navigation/MobileRcBar.tsx src/app/layout.tsx
git commit -m "feat: mobile sticky RC bar with bottom-sheet switcher"
```

---

## Task 6: Revenue Centers Management Page

**Files:**
- Create: `src/app/revenue-centers/page.tsx`
- Create: `src/app/revenue-centers/loading.tsx`

- [ ] **Step 1: Create `src/app/revenue-centers/loading.tsx`**

```tsx
export default function Loading() {
  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4 animate-pulse">
      <div className="h-8 bg-gray-100 rounded w-48" />
      <div className="space-y-2">
        {[1, 2, 3].map(i => <div key={i} className="h-16 bg-gray-100 rounded-xl" />)}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create `src/app/revenue-centers/page.tsx`**

```tsx
'use client'
import { useState, useEffect, useCallback } from 'react'
import { Plus, Pencil, Trash2, Star } from 'lucide-react'
import { RC_COLORS, rcHex } from '@/lib/rc-colors'
import { useRc, RevenueCenter } from '@/contexts/RevenueCenterContext'

interface RcFormData {
  name: string
  color: string
  isDefault: boolean
}

const EMPTY_FORM: RcFormData = { name: '', color: 'blue', isDefault: false }

function RcFormModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: RevenueCenter | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<RcFormData>(
    initial ? { name: initial.name, color: initial.color, isDefault: initial.isDefault } : EMPTY_FORM
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    const res = await fetch(
      initial ? `/api/revenue-centers/${initial.id}` : '/api/revenue-centers',
      {
        method: initial ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }
    )
    setSaving(false)
    if (!res.ok) { const d = await res.json(); setError(d.error || 'Failed'); return }
    onSaved()
    onClose()
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5">
          <h3 className="font-semibold text-gray-900 mb-4">
            {initial ? 'Edit Revenue Center' : 'New Revenue Center'}
          </h3>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
              <input
                autoFocus
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Catering, Events..."
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2">Color</label>
              <div className="grid grid-cols-8 gap-2">
                {RC_COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, color: c }))}
                    className={`w-7 h-7 rounded-full transition-transform ${form.color === c ? 'ring-2 ring-offset-2 ring-gray-400 scale-110' : ''}`}
                    style={{ backgroundColor: rcHex(c) }}
                  />
                ))}
              </div>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={e => setForm(f => ({ ...f, isDefault: e.target.checked }))}
                className="rounded border-gray-300"
              />
              <span className="text-sm text-gray-700">Set as default revenue center</span>
            </label>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={saving}
                className="flex-1 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 disabled:opacity-50"
              >
                {saving ? 'Saving…' : initial ? 'Save Changes' : 'Create'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}

export default function RevenueCentersPage() {
  const { revenueCenters, reload } = useRc()
  const [editTarget, setEditTarget] = useState<RevenueCenter | null | 'new'>('new' as never)
  const [showForm, setShowForm] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const handleDelete = async (rc: RevenueCenter) => {
    if (!confirm(`Delete "${rc.name}"?`)) return
    const res = await fetch(`/api/revenue-centers/${rc.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const d = await res.json()
      setDeleteError(d.error || 'Failed to delete')
      return
    }
    setDeleteError('')
    reload()
  }

  const openAdd = () => { setEditTarget(null); setShowForm(true) }
  const openEdit = (rc: RevenueCenter) => { setEditTarget(rc); setShowForm(true) }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Revenue Centers</h1>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700"
        >
          <Plus size={16} />
          Add
        </button>
      </div>

      {deleteError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {deleteError}
        </div>
      )}

      <div className="space-y-2">
        {revenueCenters.map(rc => (
          <div
            key={rc.id}
            className="flex items-center gap-3 bg-white border border-gray-100 rounded-xl p-4"
          >
            <span
              className="w-4 h-4 rounded-full shrink-0"
              style={{ backgroundColor: rcHex(rc.color) }}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900">{rc.name}</p>
              {rc.isDefault && (
                <p className="text-xs text-amber-600 flex items-center gap-1 mt-0.5">
                  <Star size={10} /> Default
                </p>
              )}
            </div>
            <button
              onClick={() => openEdit(rc)}
              className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              <Pencil size={15} />
            </button>
            <button
              onClick={() => handleDelete(rc)}
              className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg"
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>

      {showForm && (
        <RcFormModal
          initial={editTarget as RevenueCenter | null}
          onClose={() => setShowForm(false)}
          onSaved={reload}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 3: Add Revenue Centers link to Navigation**

In `src/components/Navigation.tsx`, add to the `navItems` array after Settings:

```tsx
  { href: '/revenue-centers', label: 'Rev. Centers', icon: Layers, dividerBefore: false },
```

Add `Layers` to the lucide import line.

Also add to `mobileMore`:
```tsx
  { href: '/revenue-centers', label: 'Rev. Centers', icon: Layers },
```

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: Compiled successfully.

- [ ] **Step 5: Commit**

```bash
git add src/app/revenue-centers/ src/components/Navigation.tsx
git commit -m "feat: revenue centers management page (CRUD)"
```

---

## Task 7: Stock Allocations + Pull (Transfer) API

**Files:**
- Create: `src/app/api/stock-transfers/route.ts`

- [ ] **Step 1: Create `src/app/api/stock-transfers/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/stock-transfers?itemId=&rcId= — list transfers
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const itemId = searchParams.get('itemId')
  const rcId   = searchParams.get('rcId')

  const transfers = await prisma.stockTransfer.findMany({
    where: {
      ...(itemId ? { inventoryItemId: itemId } : {}),
      ...(rcId ? { OR: [{ fromRcId: rcId }, { toRcId: rcId }] } : {}),
    },
    include: {
      fromRc: { select: { id: true, name: true, color: true } },
      toRc:   { select: { id: true, name: true, color: true } },
      inventoryItem: { select: { id: true, itemName: true, baseUnit: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  return NextResponse.json(transfers)
}

// POST /api/stock-transfers — execute a pull (transfer stock between RCs)
export async function POST(req: NextRequest) {
  const { fromRcId, toRcId, inventoryItemId, quantity, notes } = await req.json()

  if (!fromRcId || !toRcId || !inventoryItemId || !quantity) {
    return NextResponse.json({ error: 'fromRcId, toRcId, inventoryItemId, and quantity are required' }, { status: 400 })
  }

  if (fromRcId === toRcId) {
    return NextResponse.json({ error: 'Source and destination must be different' }, { status: 400 })
  }

  const qty = parseFloat(quantity)
  if (qty <= 0) {
    return NextResponse.json({ error: 'Quantity must be positive' }, { status: 400 })
  }

  // Check source allocation
  const sourceAllocation = await prisma.stockAllocation.findUnique({
    where: { revenueCenterId_inventoryItemId: { revenueCenterId: fromRcId, inventoryItemId } },
  })

  const sourceQty = sourceAllocation ? Number(sourceAllocation.quantity) : 0
  if (sourceQty < qty) {
    return NextResponse.json({
      error: `Insufficient allocation. Source RC has ${sourceQty} units available.`,
    }, { status: 400 })
  }

  await prisma.$transaction([
    // Decrement source
    prisma.stockAllocation.upsert({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: fromRcId, inventoryItemId } },
      update: { quantity: { decrement: qty } },
      create: { revenueCenterId: fromRcId, inventoryItemId, quantity: 0 },
    }),
    // Increment destination
    prisma.stockAllocation.upsert({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: toRcId, inventoryItemId } },
      update: { quantity: { increment: qty } },
      create: { revenueCenterId: toRcId, inventoryItemId, quantity: qty },
    }),
    // Audit log
    prisma.stockTransfer.create({
      data: { fromRcId, toRcId, inventoryItemId, quantity: qty, notes: notes || null },
    }),
  ])

  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Compiled successfully.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/stock-transfers/
git commit -m "feat: stock transfer API (pull between RCs)"
```

---

## Task 8: Inventory — RC Allocation Panel

**Files:**
- Create: `src/components/inventory/RcAllocationPanel.tsx`

The inventory item detail panel (`SupplierDetail` pattern) already exists. This task creates the RC panel component that can be embedded into the item detail view.

- [ ] **Step 1: Create `src/components/inventory/RcAllocationPanel.tsx`**

```tsx
'use client'
import { useState, useEffect, useCallback } from 'react'
import { ArrowRight, ChevronDown, ChevronUp } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

interface Allocation {
  revenueCenterId: string
  quantity: number
  revenueCenter: { id: string; name: string; color: string }
}

interface Transfer {
  id: string
  fromRc: { name: string; color: string }
  toRc: { name: string; color: string }
  quantity: number
  notes: string | null
  createdAt: string
}

interface Props {
  itemId: string
  baseUnit: string
}

export function RcAllocationPanel({ itemId, baseUnit }: Props) {
  const { revenueCenters, activeRcId } = useRc()
  const [allocations, setAllocations] = useState<Allocation[]>([])
  const [transfers, setTransfers]     = useState<Transfer[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [pullRcId, setPullRcId]       = useState<string | null>(null)
  const [pullQty, setPullQty]         = useState('')
  const [pullNotes, setPullNotes]     = useState('')
  const [pulling, setPulling]         = useState(false)
  const [pullError, setPullError]     = useState('')

  const loadData = useCallback(async () => {
    const [allocRes, transferRes] = await Promise.all([
      fetch(`/api/revenue-centers`).then(r => r.json()),
      fetch(`/api/stock-transfers?itemId=${itemId}`).then(r => r.json()),
    ])
    // Build allocation map from the stock-allocations embedded in RC list
    // Re-fetch allocations specifically for this item
    const allocsRes: Allocation[] = await fetch(`/api/stock-allocations?itemId=${itemId}`).then(r => r.json())
    setAllocations(allocsRes)
    setTransfers(transferRes)
  }, [itemId])

  useEffect(() => { loadData() }, [loadData])

  const handlePull = async () => {
    if (!pullRcId || !pullQty) return
    setPulling(true)
    setPullError('')
    const res = await fetch('/api/stock-transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromRcId: pullRcId,
        toRcId: activeRcId,
        inventoryItemId: itemId,
        quantity: parseFloat(pullQty),
        notes: pullNotes || null,
      }),
    })
    setPulling(false)
    if (!res.ok) {
      const d = await res.json()
      setPullError(d.error || 'Transfer failed')
      return
    }
    setPullRcId(null)
    setPullQty('')
    setPullNotes('')
    loadData()
  }

  const otherRcs = revenueCenters.filter(rc => rc.id !== activeRcId)

  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Stock by Revenue Center</p>
      </div>

      <div className="divide-y divide-gray-50">
        {revenueCenters.map(rc => {
          const alloc = allocations.find(a => a.revenueCenterId === rc.id)
          const qty   = alloc ? Number(alloc.quantity) : 0
          const isActive = rc.id === activeRcId
          const isPulling = pullRcId === rc.id

          return (
            <div key={rc.id} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: rcHex(rc.color) }} />
                <span className={`flex-1 text-sm ${isActive ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>
                  {rc.name} {isActive && <span className="text-xs text-blue-500 font-normal ml-1">active</span>}
                </span>
                <span className="text-sm font-medium text-gray-700">
                  {qty.toFixed(2)} {baseUnit}
                </span>
                {!isActive && (
                  <button
                    onClick={() => setPullRcId(isPulling ? null : rc.id)}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-0.5"
                  >
                    Pull <ArrowRight size={12} />
                  </button>
                )}
              </div>

              {isPulling && (
                <div className="mt-2 pl-4 space-y-2">
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={pullQty}
                      onChange={e => setPullQty(e.target.value)}
                      placeholder={`Qty (${baseUnit})`}
                      className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      onClick={handlePull}
                      disabled={pulling || !pullQty}
                      className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                    >
                      {pulling ? '…' : 'Pull'}
                    </button>
                  </div>
                  <input
                    value={pullNotes}
                    onChange={e => setPullNotes(e.target.value)}
                    placeholder="Notes (optional)"
                    className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none"
                  />
                  {pullError && <p className="text-xs text-red-500">{pullError}</p>}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {transfers.length > 0 && (
        <div className="border-t border-gray-100">
          <button
            onClick={() => setShowHistory(h => !h)}
            className="w-full flex items-center gap-1 px-4 py-2 text-xs text-gray-400 hover:text-gray-600"
          >
            {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            Transfer history ({transfers.length})
          </button>
          {showHistory && (
            <div className="px-4 pb-3 space-y-1">
              {transfers.slice(0, 10).map(t => (
                <div key={t.id} className="flex items-center gap-1.5 text-xs text-gray-500">
                  <span style={{ color: rcHex(t.fromRc.color) }}>●</span>
                  {t.fromRc.name}
                  <ArrowRight size={10} />
                  <span style={{ color: rcHex(t.toRc.color) }}>●</span>
                  {t.toRc.name}
                  <span className="ml-auto font-medium">{Number(t.quantity).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add stock allocations GET endpoint**

Create `src/app/api/stock-allocations/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/stock-allocations?itemId= — allocations for a specific item
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const itemId = searchParams.get('itemId')

  if (!itemId) return NextResponse.json({ error: 'itemId required' }, { status: 400 })

  const allocations = await prisma.stockAllocation.findMany({
    where: { inventoryItemId: itemId },
    include: { revenueCenter: { select: { id: true, name: true, color: true } } },
  })

  return NextResponse.json(allocations)
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: Compiled successfully.

- [ ] **Step 4: Commit**

```bash
git add src/components/inventory/RcAllocationPanel.tsx src/app/api/stock-allocations/
git commit -m "feat: inventory RC allocation panel + stock-allocations API"
```

---

## Task 9: Invoices — RC Session Selector + Line-Item Override

**Files:**
- Modify: `src/app/api/invoices/sessions/route.ts`
- Modify: `src/components/invoices/InvoiceDrawer.tsx`
- Modify: `src/components/invoices/InvoiceList.tsx`
- Modify: `src/app/invoices/page.tsx`

- [ ] **Step 1: Update `POST /api/invoices/sessions` to accept `revenueCenterId`**

In `src/app/api/invoices/sessions/route.ts`, update the POST handler:

```ts
// POST /api/invoices/sessions — create a new session
export async function POST(req: NextRequest) {
  const { supplierName, supplierId, revenueCenterId } = await req.json().catch(() => ({}))

  const session = await prisma.invoiceSession.create({
    data: {
      status: 'UPLOADING',
      supplierName: supplierName || null,
      supplierId: supplierId || null,
      revenueCenterId: revenueCenterId || null,
    },
  })

  return NextResponse.json(session, { status: 201 })
}
```

- [ ] **Step 2: Add RC selector to `InvoiceDrawer` — session-level**

In `src/components/invoices/InvoiceDrawer.tsx`, import the RC context:

```tsx
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'
```

Inside the `InvoiceDrawer` component function (wherever session state is managed), add:

```tsx
const { revenueCenters, activeRcId } = useRc()
const [sessionRcId, setSessionRcId] = useState<string | null>(null)
```

When a session is loaded (`useEffect` that fetches session data), set:
```tsx
setSessionRcId(session.revenueCenterId ?? activeRcId)
```

Add a PATCH call when the user changes the session-level RC. Find the section in the drawer that renders the session header (supplier name, invoice date, etc.) and add an RC selector below it:

```tsx
<div className="flex items-center gap-2 mt-2">
  <span className="text-xs text-gray-500">Revenue Center:</span>
  <select
    value={sessionRcId ?? ''}
    onChange={async e => {
      setSessionRcId(e.target.value)
      await fetch(`/api/invoices/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revenueCenterId: e.target.value }),
      })
    }}
    className="text-xs border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
  >
    {revenueCenters.map(rc => (
      <option key={rc.id} value={rc.id}>{rc.name}</option>
    ))}
  </select>
</div>
```

- [ ] **Step 3: Add per-line RC override to scan item rows in `InvoiceDrawer`**

Each scan item row in the review UI needs an RC override selector. The scan items are rendered in a list inside InvoiceDrawer. Find the per-item row render and add, after the action dropdown or at the end of each item's controls:

```tsx
{/* RC override — only show if session has RC set */}
{sessionRcId && (
  <select
    value={item.revenueCenterId ?? sessionRcId}
    onChange={async e => {
      await fetch(`/api/invoices/sessions/${session.id}/scanitems/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revenueCenterId: e.target.value }),
      })
      // Re-fetch scan items to update local state
      refreshScanItems()
    }}
    className="text-[10px] border border-gray-100 rounded px-1 py-0.5 text-gray-500"
  >
    {revenueCenters.map(rc => (
      <option key={rc.id} value={rc.id}>{rc.name}</option>
    ))}
  </select>
)}
```

- [ ] **Step 4: Add PATCH route for scan item RC override**

In `src/app/api/invoices/sessions/[id]/scanitems/route.ts` — check if this file exists. If the scanitems route only handles GET, add a PATCH handler, OR create a new route at `src/app/api/invoices/sessions/[id]/scanitems/[scanItemId]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; scanItemId: string } }
) {
  const body = await req.json()
  const item = await prisma.invoiceScanItem.update({
    where: { id: params.scanItemId },
    data: { revenueCenterId: body.revenueCenterId ?? null },
  })
  return NextResponse.json(item)
}
```

- [ ] **Step 5: Filter `InvoiceList` by active RC**

In `src/app/invoices/page.tsx`, pass `activeRcId` to `InvoiceList`:

```tsx
import { useRc } from '@/contexts/RevenueCenterContext'

// Inside InvoicesPage:
const { activeRcId } = useRc()

// In the JSX:
<InvoiceList
  sessions={sessions}
  activeRcId={activeRcId}
  onSelect={setSelectedSessionId}
  onUploadClick={() => setShowUpload(true)}
  onDelete={handleDelete}
/>
```

In `src/components/invoices/InvoiceList.tsx`, add `activeRcId` to props and filter:

```tsx
interface InvoiceListProps {
  sessions: SessionSummary[]
  activeRcId: string | null
  // ... existing props
}

// In the component, filter sessions:
const filtered = activeRcId
  ? sessions.filter(s => s.revenueCenterId === activeRcId || (!s.revenueCenterId && !s.parentSessionId))
  : sessions
```

Show a clone badge on sessions with `parentSessionId`:
```tsx
{session.parentSessionId && (
  <span className="text-[9px] font-bold bg-purple-100 text-purple-600 px-1 py-0.5 rounded">COPY</span>
)}
```

The `SessionSummary` type also needs `revenueCenterId` and `parentSessionId` fields added to it. Find the type definition in `src/components/invoices/types.ts` and add:
```ts
revenueCenterId?: string | null
parentSessionId?: string | null
```

- [ ] **Step 6: Verify build**

```bash
npm run build
```

Expected: Compiled successfully.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/invoices/ src/components/invoices/ src/app/invoices/
git commit -m "feat: invoice RC session selector + per-line RC override + list filtering"
```

---

## Task 10: Invoice Approval — Clone Session Generation

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts`

- [ ] **Step 1: Update the approve route to generate clone sessions**

The approve route currently runs a transaction that processes all scan items. After the existing transaction, add clone generation logic.

In `src/app/api/invoices/sessions/[id]/approve/route.ts`, update the function to include clone generation after the main transaction:

```ts
// At the top, update the session fetch to include revenueCenterId:
const session = await prisma.invoiceSession.findUnique({
  where: { id: params.id },
  include: {
    scanItems: {
      include: { matchedItem: true },
    },
  },
})
```

After the main `await prisma.$transaction(...)` block and before the match rules loop, add:

```ts
  // ── Clone session generation ──────────────────────────────────────────────
  // Group scan items by their effective RC (item override > session RC)
  const sessionRcId = session.revenueCenterId
  const itemsByRc = new Map<string, typeof session.scanItems>()

  for (const item of itemsToProcess) {
    const rcId = item.revenueCenterId ?? sessionRcId
    if (!rcId || rcId === sessionRcId) continue  // belongs to session RC — no clone needed
    if (!itemsByRc.has(rcId)) itemsByRc.set(rcId, [])
    itemsByRc.get(rcId)!.push(item)
  }

  for (const [rcId, rcItems] of itemsByRc) {
    // Create clone session
    const clone = await prisma.invoiceSession.create({
      data: {
        status: 'APPROVED',
        supplierName: session.supplierName,
        supplierId: session.supplierId,
        invoiceDate: session.invoiceDate,
        invoiceNumber: session.invoiceNumber ? `${session.invoiceNumber} (clone)` : null,
        revenueCenterId: rcId,
        parentSessionId: params.id,
        approvedBy,
        approvedAt: new Date(),
      },
    })

    // Copy scan items to clone
    await prisma.invoiceScanItem.createMany({
      data: rcItems.map(item => ({
        sessionId: clone.id,
        rawDescription: item.rawDescription,
        rawQty: item.rawQty,
        rawUnit: item.rawUnit,
        rawUnitPrice: item.rawUnitPrice,
        rawLineTotal: item.rawLineTotal,
        matchedItemId: item.matchedItemId,
        matchConfidence: item.matchConfidence,
        action: item.action,
        approved: true,
        newPrice: item.newPrice,
        previousPrice: item.previousPrice,
        priceDiffPct: item.priceDiffPct,
        revenueCenterId: rcId,
        sortOrder: item.sortOrder,
      })),
    })
  }
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Compiled successfully.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/invoices/sessions/
git commit -m "feat: invoice approval generates clone sessions for non-default RC line items"
```

---

## Task 11: Sales — Revenue Center Field

**Files:**
- Modify: `src/app/api/sales/route.ts`
- Modify: `src/app/sales/page.tsx`

- [ ] **Step 1: Update `src/app/api/sales/route.ts`**

In the GET handler, add `rcId` filtering:

```ts
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const startDate = searchParams.get('startDate')
  const endDate   = searchParams.get('endDate')
  const rcId      = searchParams.get('rcId')

  const where: Record<string, unknown> = {}
  if (startDate) where.date = { ...(where.date as object ?? {}), gte: new Date(startDate) }
  if (endDate)   where.date = { ...(where.date as object ?? {}), lte: new Date(endDate + 'T23:59:59.999Z') }
  if (rcId) {
    where.OR = [
      { revenueCenterId: rcId },
      { revenueCenterId: null },  // null rows belong to default RC — included only when default is active
    ]
    // Refine: only include null-RC rows if rcId is the default RC
    // This is handled client-side by always passing rcId; null rows auto-include for default RC
  }

  // ... rest of GET unchanged
```

Actually, for simplicity: if `rcId` is provided, filter strictly: `{ revenueCenterId: rcId }`. Null-RC rows (legacy data) belong to the default RC — the client should check if `activeRc.isDefault` and add `OR revenueCenterId IS NULL` accordingly. Implement this via a separate query param:

```ts
  if (rcId) {
    const isDefault = searchParams.get('isDefault') === 'true'
    where.revenueCenterId = isDefault
      ? { in: [rcId, null as unknown as string] }
      : rcId
  }
```

In the POST handler, accept `revenueCenterId`:

```ts
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { lineItems = [], revenueCenterId, ...rest } = body

  const entry = await prisma.salesEntry.create({
    data: {
      date:            new Date(rest.date),
      totalRevenue:    parseFloat(rest.totalRevenue) || 0,
      foodSalesPct:    parseFloat(rest.foodSalesPct) || 0.7,
      covers:          rest.covers ? parseInt(rest.covers) : null,
      notes:           rest.notes || null,
      revenueCenterId: revenueCenterId || null,
      lineItems: {
        create: (lineItems as { recipeId: string; qtySold: number }[])
          .filter(li => li.recipeId && li.qtySold > 0)
          .map(li => ({ recipeId: li.recipeId, qtySold: parseInt(String(li.qtySold)) })),
      },
    },
    include: { lineItems: { include: { recipe: { select: RECIPE_SELECT } } } },
  })
  return NextResponse.json(entry, { status: 201 })
}
```

- [ ] **Step 2: Update `src/app/sales/page.tsx` to pass RC params**

In the sales page, add:

```tsx
import { useRc } from '@/contexts/RevenueCenterContext'

// Inside the component:
const { activeRcId, activeRc } = useRc()

// In fetchSales (or wherever data is fetched):
const params = new URLSearchParams()
if (startDate) params.set('startDate', startDate)
if (endDate)   params.set('endDate', endDate)
if (activeRcId) {
  params.set('rcId', activeRcId)
  if (activeRc?.isDefault) params.set('isDefault', 'true')
}
fetch(`/api/sales?${params}`)
```

In the new entry form (where `POST /api/sales` is called), add `revenueCenterId: activeRcId` to the body.

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: Compiled successfully.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sales/ src/app/sales/
git commit -m "feat: sales entries tagged to active revenue center; list filtered by RC"
```

---

## Task 12: Wastage — Revenue Center Field

**Files:**
- Modify: `src/app/api/wastage/route.ts`
- Modify: `src/app/wastage/page.tsx`

- [ ] **Step 1: Update `src/app/api/wastage/route.ts`**

In GET, add `rcId` filtering (same pattern as sales):

```ts
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const startDate = searchParams.get('startDate')
  const endDate   = searchParams.get('endDate')
  const itemId    = searchParams.get('itemId')
  const reason    = searchParams.get('reason')
  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'

  const logs = await prisma.wastageLog.findMany({
    where: {
      AND: [
        startDate ? { date: { gte: new Date(startDate) } } : {},
        endDate   ? { date: { lte: new Date(endDate) } }  : {},
        itemId    ? { inventoryItemId: itemId }            : {},
        reason    ? { reason }                             : {},
        rcId      ? { revenueCenterId: isDefault ? { in: [rcId, null as unknown as string] } : rcId } : {},
      ],
    },
    include: { inventoryItem: true },
    orderBy: { date: 'desc' },
  })
  return NextResponse.json(logs)
}
```

In POST, accept `revenueCenterId`:

```ts
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { inventoryItemId, qtyWasted, unit, reason, loggedBy, notes, date, revenueCenterId } = body

  const item = await prisma.inventoryItem.findUnique({ where: { id: inventoryItemId } })
  const ppbu = item ? parseFloat(String(item.pricePerBaseUnit)) : 0
  const costImpact = parseFloat(qtyWasted) * ppbu

  const log = await prisma.wastageLog.create({
    data: {
      inventoryItemId,
      date:            date ? new Date(date) : new Date(),
      qtyWasted:       parseFloat(qtyWasted),
      unit,
      reason:          reason || 'UNKNOWN',
      costImpact,
      loggedBy:        loggedBy || 'System',
      notes,
      revenueCenterId: revenueCenterId || null,
    },
    include: { inventoryItem: true },
  })
  return NextResponse.json(log, { status: 201 })
}
```

- [ ] **Step 2: Update `src/app/wastage/page.tsx`**

Add `useRc` hook and pass `rcId` + `isDefault` in the fetch URL. Pass `revenueCenterId: activeRcId` in the log POST body. (The wastage page has a log form — add the RC to the form submission body.)

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: Compiled successfully.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/wastage/ src/app/wastage/
git commit -m "feat: wastage logs tagged to active RC; list filtered by RC"
```

---

## Task 13: Count Sessions — RC Selector + Finalize Updates Allocations

**Files:**
- Modify: `src/app/api/count/sessions/route.ts`
- Modify: `src/app/api/count/sessions/[id]/finalize/route.ts`
- Modify: `src/app/count/page.tsx`

- [ ] **Step 1: Update `POST /api/count/sessions` to accept `revenueCenterId`**

In `src/app/api/count/sessions/route.ts`, update the POST handler:

```ts
export async function POST(req: NextRequest) {
  const { label, type = 'FULL', areaFilter, countedBy, sessionDate, revenueCenterId } = await req.json()
  // ... existing logic unchanged up to session creation ...

  const session = await prisma.countSession.create({
    data: {
      label: label?.trim() || (type === 'FULL' ? 'Full count' : 'Partial count'),
      sessionDate: sessionDate ? new Date(sessionDate) : new Date(),
      type,
      areaFilter: areaFilter || null,
      countedBy,
      revenueCenterId: revenueCenterId || null,
      lines: {
        create: items.map((item, i) => { /* existing logic unchanged */ }),
      },
    },
    // ... existing include unchanged
  })
  // ... rest unchanged
}
```

In the GET handler, add `rcId` filtering:

```ts
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'

  const sessions = await prisma.countSession.findMany({
    where: rcId
      ? { revenueCenterId: isDefault ? { in: [rcId, null as unknown as string] } : rcId }
      : {},
    orderBy: { startedAt: 'desc' },
    include: { lines: { select: { countedQty: true, skipped: true } } },
  })
  // ... rest unchanged
}
```

- [ ] **Step 2: Update finalize route to write `StockAllocation` rows**

In `src/app/api/count/sessions/[id]/finalize/route.ts`, after the existing `await prisma.$transaction([...])`, add:

```ts
  // Update StockAllocation for this RC
  if (session.revenueCenterId) {
    const allocationUpdates = session.lines
      .filter(line => !line.skipped && line.countedQty !== null)
      .map(line =>
        prisma.stockAllocation.upsert({
          where: {
            revenueCenterId_inventoryItemId: {
              revenueCenterId: session.revenueCenterId!,
              inventoryItemId: line.inventoryItemId,
            },
          },
          update: { quantity: Number(line.countedQty) },
          create: {
            revenueCenterId: session.revenueCenterId!,
            inventoryItemId: line.inventoryItemId,
            quantity: Number(line.countedQty),
          },
        })
      )

    await Promise.all(allocationUpdates)
  }
```

- [ ] **Step 3: Update `src/app/count/page.tsx` to show RC selector on new session form**

Find the new-session form modal (or wherever `countedBy`, `label`, `type` are gathered before calling `POST /api/count/sessions`). Add:

```tsx
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

// Inside the component:
const { revenueCenters, activeRcId } = useRc()

// In the form state:
const [selectedRcId, setSelectedRcId] = useState(activeRcId ?? '')

// In the form JSX, add RC selector field:
<div>
  <label className="block text-xs font-medium text-gray-600 mb-1">Revenue Center</label>
  <select
    value={selectedRcId}
    onChange={e => setSelectedRcId(e.target.value)}
    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
  >
    {revenueCenters.map(rc => (
      <option key={rc.id} value={rc.id}>{rc.name}</option>
    ))}
  </select>
</div>

// In the POST body:
body: JSON.stringify({ label, type, areaFilter, countedBy, sessionDate, revenueCenterId: selectedRcId })
```

Also pass RC params to the GET sessions call:
```ts
const params = new URLSearchParams()
if (activeRcId) {
  params.set('rcId', activeRcId)
  if (activeRc?.isDefault) params.set('isDefault', 'true')
}
fetch(`/api/count/sessions?${params}`)
```

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: Compiled successfully.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/count/ src/app/count/
git commit -m "feat: count sessions tagged to RC; finalize updates StockAllocation"
```

---

## Task 14: Reports — RC-Filtered COGS

**Files:**
- Modify: `src/app/api/reports/cogs/route.ts`
- Modify: `src/app/reports/page.tsx`

- [ ] **Step 1: Add `rcId` filtering to COGS route**

In `src/app/api/reports/cogs/route.ts`, in the COGS mode section (after the `if (!startDateStr || !endDateStr)` block), update the `InvoiceSession` purchase query to filter by RC:

```ts
  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'

  // ... existing code for beginSession, endSession unchanged ...

  // Existing invoice sessions query — add RC filter:
  const invoiceSessions = await prisma.invoiceSession.findMany({
    where: {
      status:    'APPROVED',
      approvedAt: { gte: rangeStart, lte: rangeEnd },
      ...(rcId ? {
        revenueCenterId: isDefault ? { in: [rcId, null as unknown as string] } : rcId,
      } : {}),
    },
    include: {
      scanItems: {
        where: { approved: true, action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] } },
        include: { matchedItem: { select: { category: true } } },
      },
    },
  })
```

Also filter `salesEntries` for food sales by RC:

```ts
  const salesEntries = await prisma.salesEntry.findMany({
    where: {
      date: { gte: rangeStart, lte: rangeEnd },
      ...(rcId ? {
        revenueCenterId: isDefault ? { in: [rcId, null as unknown as string] } : rcId,
      } : {}),
    },
  })
```

For `beginSession`/`endSession` (count-based inventory value), when RC is provided, use `StockAllocation` values instead of `InventorySnapshot` values. Add this handling:

```ts
  // RC-aware beginning inventory: use StockAllocation if rcId provided
  let beginningValue = 0
  const beginByCategory: Record<string, number> = {}

  if (rcId && beginSession) {
    const allocations = await prisma.stockAllocation.findMany({
      where: { revenueCenterId: rcId },
      include: { inventoryItem: { select: { pricePerBaseUnit: true, category: true } } },
    })
    for (const a of allocations) {
      const v = Number(a.quantity) * Number(a.inventoryItem.pricePerBaseUnit)
      beginningValue += v
      beginByCategory[a.inventoryItem.category] = (beginByCategory[a.inventoryItem.category] || 0) + v
    }
  } else if (beginSession) {
    // existing snapshot logic unchanged
    for (const snap of beginSession.snapshots) {
      const v = Number(snap.totalValue)
      beginningValue += v
      beginByCategory[snap.category] = (beginByCategory[snap.category] || 0) + v
    }
  }
  // ... similar for endingValue
```

- [ ] **Step 2: Pass `rcId` from reports page**

In `src/app/reports/page.tsx`, add:

```tsx
import { useRc } from '@/contexts/RevenueCenterContext'

// Inside the component:
const { activeRcId, activeRc } = useRc()

// In all report fetch calls that support rcId (cogs, analytics, etc.), append:
const rcParams = activeRcId
  ? `&rcId=${activeRcId}${activeRc?.isDefault ? '&isDefault=true' : ''}`
  : ''

// e.g.:
fetch(`/api/reports/cogs?startDate=${startDate}&endDate=${endDate}${rcParams}`)
```

Add an RC indicator label to the report header:

```tsx
{activeRc && (
  <span className="flex items-center gap-1 text-xs text-gray-500 px-2 py-1 bg-gray-100 rounded-full">
    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: rcHex(activeRc.color) }} />
    {activeRc.name}
  </span>
)}
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: Compiled successfully.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/reports/ src/app/reports/
git commit -m "feat: COGS and reports filtered by active revenue center"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| RevenueCenter entity + management page | Tasks 1, 2, 6 |
| StockAllocation + StockTransfer models | Task 1, 7 |
| RC color utility + palette | Task 2 |
| Global RC context + localStorage | Task 3 |
| Desktop sidebar RC selector | Task 4 |
| Mobile sticky RC bar | Task 5 |
| Nav link RC color accent | Task 4 |
| Revenue Centers CRUD page | Task 6 |
| Pull function (transfer between RCs) | Tasks 7, 8 |
| Inventory RC allocation panel | Task 8 |
| Invoice session-level RC | Task 9 |
| Invoice line-item RC override | Task 9 |
| Invoice clone generation on approve | Task 10 |
| Sales RC field + filtering | Task 11 |
| Wastage RC field + filtering | Task 12 |
| Count RC selector + alloc on finalize | Task 13 |
| Reports COGS RC filtering | Task 14 |

All spec requirements covered.

**Type consistency check:**
- `RevenueCenterContext` exports `RevenueCenter` interface — used consistently across all tasks
- `rcHex(color: string)` — used in Tasks 4, 5, 6, 8, 14
- `activeRcId` / `activeRc` from `useRc()` — consistent naming throughout
- `revenueCenterId` field name — consistent on all models and API bodies
- `isDefault` query param — consistent in GET handlers for Tasks 11, 12, 13, 14
