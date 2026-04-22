# Invoices Page Redesign — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform `src/app/invoices/page.tsx` from a 2,391-line monolith into a thin shell that wires together four focused components: a compact KPI strip, an invoice list, a right-side drawer for review/approve, and an upload modal.

**Architecture:** `page.tsx` owns the `sessions` and `selectedSessionId` state and fetches both. All UI lives in `src/components/invoices/`. A new API route `/api/invoices/kpis` provides spending and alert summary data. The existing review/approve API routes are unchanged.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind CSS, Prisma + PostgreSQL, `formatCurrency` from `@/lib/utils`

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/components/invoices/types.ts` | Shared TypeScript types for all invoice components |
| Create | `src/app/api/invoices/kpis/route.ts` | KPI summary endpoint |
| Create | `src/components/invoices/InvoiceKpiStrip.tsx` | Compact 5-card KPI bar |
| Create | `src/components/invoices/InvoiceList.tsx` | Status tabs, search, invoice rows, mobile cards, delete |
| Create | `src/components/invoices/InvoiceUploadModal.tsx` | Upload/camera flow (extracted from page, logic unchanged) |
| Create | `src/components/invoices/InvoiceDrawer.tsx` | Right-side slide panel with processing/review/approve flow |
| Modify | `src/app/invoices/page.tsx` | Replace with thin shell |

---

## Task 1: Shared Types File

**Files:**
- Create: `src/components/invoices/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/components/invoices/types.ts

export type SessionStatus = 'UPLOADING' | 'PROCESSING' | 'REVIEW' | 'APPROVED' | 'REJECTED'
export type MatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
export type LineItemAction = 'PENDING' | 'UPDATE_PRICE' | 'ADD_SUPPLIER' | 'CREATE_NEW' | 'SKIP'

export interface ScanFile {
  id: string
  fileName: string
  fileType: string
  ocrStatus: string
}

export interface InventoryMatch {
  id: string
  itemName: string
  purchaseUnit: string
  pricePerBaseUnit: number
  purchasePrice: number
  qtyPerPurchaseUnit: number
  packSize: number
  packUOM: string
  baseUnit: string
}

export interface ScanItem {
  id: string
  rawDescription: string
  rawQty: number | null
  rawUnit: string | null
  rawUnitPrice: number | null
  rawLineTotal: number | null
  matchedItemId: string | null
  matchedItem: InventoryMatch | null
  matchConfidence: MatchConfidence
  matchScore: number
  action: LineItemAction
  approved: boolean
  isNewItem: boolean
  newItemData: string | null
  previousPrice: number | null
  newPrice: number | null
  priceDiffPct: number | null
  formatMismatch: boolean
  invoicePackQty: number | null
  invoicePackSize: number | null
  invoicePackUOM: string | null
  needsFormatConfirm: boolean
}

// Full session — returned by GET /api/invoices/sessions/[id]
export interface Session {
  id: string
  status: SessionStatus
  supplierName: string | null
  invoiceDate: string | null
  invoiceNumber: string | null
  total: string | null
  files: ScanFile[]
  scanItems: ScanItem[]
  priceAlerts: unknown[]
  recipeAlerts: unknown[]
  createdAt: string
}

// Summary — returned by GET /api/invoices/sessions (uses _count, not full arrays)
export interface SessionSummary {
  id: string
  status: SessionStatus
  supplierName: string | null
  invoiceDate: string | null
  invoiceNumber: string | null
  total: string | null
  createdAt: string
  _count: {
    scanItems: number
    priceAlerts: number
    recipeAlerts: number
  }
}

export interface ApproveResult {
  ok: boolean
  itemsUpdated: number
  newItemsCreated: number
  priceAlerts: number
  recipeAlerts: number
}

export interface KpiData {
  weekSpend: number
  weekSpendChangePct: number
  monthSpend: number
  monthInvoiceCount: number
  priceAlertCount: number
  awaitingApprovalCount: number
  topCategories: Array<{ category: string; spend: number }>
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npm run build`
Expected: build succeeds (no type errors in the new file)

- [ ] **Step 3: Commit**

```bash
git add src/components/invoices/types.ts
git commit -m "feat: add shared types for invoice components"
```

---

## Task 2: KPI API Route

**Files:**
- Create: `src/app/api/invoices/kpis/route.ts`

- [ ] **Step 1: Create the KPI route**

```typescript
// src/app/api/invoices/kpis/route.ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const now = new Date()

  // ISO week: Monday-based
  const dayOfWeek = now.getDay()
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const weekStart = new Date(now)
  weekStart.setDate(now.getDate() + diffToMonday)
  weekStart.setHours(0, 0, 0, 0)

  const prevWeekStart = new Date(weekStart)
  prevWeekStart.setDate(weekStart.getDate() - 7)
  const prevWeekEnd = new Date(weekStart)

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  const [
    weekAgg,
    prevWeekAgg,
    monthAgg,
    monthCount,
    priceAlertCount,
    awaitingCount,
    lineItems,
  ] = await Promise.all([
    prisma.invoiceSession.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: weekStart } },
      _sum: { total: true },
    }),
    prisma.invoiceSession.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: prevWeekStart, lt: prevWeekEnd } },
      _sum: { total: true },
    }),
    prisma.invoiceSession.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: monthStart, lt: monthEnd } },
      _sum: { total: true },
    }),
    prisma.invoiceSession.count({
      where: { status: 'APPROVED', approvedAt: { gte: monthStart, lt: monthEnd } },
    }),
    prisma.priceAlert.count({
      where: { acknowledged: false },
    }),
    prisma.invoiceSession.count({
      where: { status: 'REVIEW' },
    }),
    prisma.invoiceLineItem.findMany({
      where: { invoice: { createdAt: { gte: monthStart, lt: monthEnd } } },
      include: { inventoryItem: { select: { category: true } } },
    }),
  ])

  const weekSpend = Number(weekAgg._sum.total ?? 0)
  const prevWeekSpend = Number(prevWeekAgg._sum.total ?? 0)
  const weekSpendChangePct = prevWeekSpend === 0
    ? 0
    : Math.round(((weekSpend - prevWeekSpend) / prevWeekSpend) * 100)

  // Group line items by category
  const categoryMap: Record<string, number> = {}
  for (const item of lineItems) {
    const cat = item.inventoryItem.category
    categoryMap[cat] = (categoryMap[cat] ?? 0) + Number(item.lineTotal)
  }
  const topCategories = Object.entries(categoryMap)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([category, spend]) => ({ category, spend }))

  return NextResponse.json({
    weekSpend,
    weekSpendChangePct,
    monthSpend: Number(monthAgg._sum.total ?? 0),
    monthInvoiceCount: monthCount,
    priceAlertCount,
    awaitingApprovalCount: awaitingCount,
    topCategories,
  })
}
```

- [ ] **Step 2: Verify it builds**

Run: `npm run build`
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/app/api/invoices/kpis/route.ts
git commit -m "feat: add GET /api/invoices/kpis endpoint"
```

---

## Task 3: InvoiceKpiStrip Component

**Files:**
- Create: `src/components/invoices/InvoiceKpiStrip.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/components/invoices/InvoiceKpiStrip.tsx
'use client'
import { useEffect, useState } from 'react'
import { KpiData } from './types'
import { formatCurrency } from '@/lib/utils'

interface Props {
  refreshKey: number  // increment to trigger a refetch
}

export function InvoiceKpiStrip({ refreshKey }: Props) {
  const [kpis, setKpis] = useState<KpiData | null>(null)

  useEffect(() => {
    fetch('/api/invoices/kpis')
      .then(r => r.json())
      .then(setKpis)
      .catch(() => {})
  }, [refreshKey])

  const fmt = (n: number | undefined) =>
    n !== undefined ? formatCurrency(n) : '—'

  return (
    <div className="flex gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200 overflow-x-auto shrink-0">

      {/* This Week */}
      <div className="flex-1 min-w-[130px] bg-white border border-gray-200 rounded-lg px-3 py-2">
        <p className="text-[10px] text-gray-400 uppercase tracking-wide">This Week</p>
        <p className="text-base font-bold text-gray-900 leading-tight">{fmt(kpis?.weekSpend)}</p>
        {kpis && (
          <p className={`text-[10px] ${kpis.weekSpendChangePct >= 0 ? 'text-green-600' : 'text-red-500'}`}>
            {kpis.weekSpendChangePct >= 0 ? '↑' : '↓'} {Math.abs(kpis.weekSpendChangePct)}% vs last week
          </p>
        )}
      </div>

      {/* This Month */}
      <div className="flex-1 min-w-[130px] bg-white border border-gray-200 rounded-lg px-3 py-2">
        <p className="text-[10px] text-gray-400 uppercase tracking-wide">This Month</p>
        <p className="text-base font-bold text-gray-900 leading-tight">{fmt(kpis?.monthSpend)}</p>
        <p className="text-[10px] text-gray-400">{kpis?.monthInvoiceCount ?? '—'} invoices</p>
      </div>

      {/* Price Alerts */}
      <div className={`flex-1 min-w-[120px] rounded-lg px-3 py-2 border ${kpis && kpis.priceAlertCount > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-200'}`}>
        <p className={`text-[10px] uppercase tracking-wide ${kpis && kpis.priceAlertCount > 0 ? 'text-amber-700' : 'text-gray-400'}`}>Price Alerts</p>
        <p className={`text-base font-bold leading-tight ${kpis && kpis.priceAlertCount > 0 ? 'text-amber-700' : 'text-gray-900'}`}>
          {kpis?.priceAlertCount ?? '—'} items
        </p>
      </div>

      {/* Awaiting Approval */}
      <div className={`flex-1 min-w-[140px] rounded-lg px-3 py-2 border ${kpis && kpis.awaitingApprovalCount > 0 ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-200'}`}>
        <p className={`text-[10px] uppercase tracking-wide ${kpis && kpis.awaitingApprovalCount > 0 ? 'text-blue-700' : 'text-gray-400'}`}>Awaiting Approval</p>
        <p className={`text-base font-bold leading-tight ${kpis && kpis.awaitingApprovalCount > 0 ? 'text-blue-700' : 'text-gray-900'}`}>
          {kpis?.awaitingApprovalCount ?? '—'} sessions
        </p>
      </div>

      {/* Top Spend */}
      <div className="flex-[2] min-w-[180px] bg-white border border-gray-200 rounded-lg px-3 py-2">
        <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1.5">Top Spend</p>
        {kpis?.topCategories.length ? (
          <div className="space-y-1">
            {kpis.topCategories.map(({ category, spend }, i) => {
              const max = kpis.topCategories[0].spend
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-[9px] text-gray-500 w-14 truncate">{category}</span>
                  <div className="flex-1 h-1 bg-gray-100 rounded-full">
                    <div
                      className="h-full bg-blue-400 rounded-full"
                      style={{ width: `${(spend / max) * 100}%` }}
                    />
                  </div>
                  <span className="text-[9px] font-semibold text-gray-700 w-10 text-right">
                    ${(spend / 1000).toFixed(1)}k
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-[10px] text-gray-400">—</p>
        )}
      </div>

    </div>
  )
}
```

- [ ] **Step 2: Build to check**

Run: `npm run build`
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/components/invoices/InvoiceKpiStrip.tsx
git commit -m "feat: add InvoiceKpiStrip component"
```

---

## Task 4: InvoiceList Component

**Files:**
- Create: `src/components/invoices/InvoiceList.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/components/invoices/InvoiceList.tsx
'use client'
import { useState } from 'react'
import { SessionSummary, SessionStatus } from './types'
import { formatCurrency } from '@/lib/utils'

type Tab = 'all' | 'REVIEW' | 'APPROVED' | 'REJECTED'

interface Props {
  sessions: SessionSummary[]
  onSelect: (id: string) => void
  onUploadClick: () => void
  onDelete: (id: string, status: SessionStatus) => Promise<void>
}

function StatusBadge({ status }: { status: SessionStatus }) {
  if (status === 'REVIEW')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700">Review</span>
  if (status === 'APPROVED')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">Approved</span>
  if (status === 'REJECTED')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-600">Rejected</span>
  if (status === 'PROCESSING')
    return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-600">Processing</span>
  return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-500">Uploading</span>
}

export function InvoiceList({ sessions, onSelect, onUploadClick, onDelete }: Props) {
  const [tab, setTab] = useState<Tab>('all')
  const [search, setSearch] = useState('')
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; status: SessionStatus } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const reviewCount = sessions.filter(s => s.status === 'REVIEW').length

  const filtered = sessions.filter(s => {
    if (tab !== 'all' && s.status !== tab) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        (s.supplierName?.toLowerCase().includes(q) ?? false) ||
        (s.invoiceNumber?.toLowerCase().includes(q) ?? false)
      )
    }
    return true
  })

  const handleDelete = async (id: string, status: SessionStatus) => {
    setIsDeleting(true)
    await onDelete(id, status)
    setIsDeleting(false)
    setDeleteConfirm(null)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 bg-white shrink-0">
        <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5">
          {(['all', 'REVIEW', 'APPROVED', 'REJECTED'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'all' ? 'All' : t === 'REVIEW' ? (
                <span className="flex items-center gap-1">
                  Review
                  {reviewCount > 0 && (
                    <span className="bg-amber-100 text-amber-700 rounded-full px-1.5 text-[9px] font-bold">
                      {reviewCount}
                    </span>
                  )}
                </span>
              ) : (
                t.charAt(0) + t.slice(1).toLowerCase()
              )}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search supplier or invoice #…"
          className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={onUploadClick}
          className="bg-blue-600 text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-blue-700 transition-colors shrink-0"
        >
          + Upload
        </button>
      </div>

      {/* Desktop column headers */}
      <div className="hidden sm:grid grid-cols-[1fr_90px_90px_60px_90px_32px] gap-2 px-4 py-1.5 bg-gray-50 border-b border-gray-200 shrink-0">
        {['Supplier / Invoice', 'Date', 'Total', 'Items', 'Status', ''].map((h, i) => (
          <div key={i} className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{h}</div>
        ))}
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="py-16 text-center text-sm text-gray-400">No invoices found</div>
        )}

        {filtered.map(s => (
          <div key={s.id}>
            {/* Desktop row */}
            <div
              className={`hidden sm:grid grid-cols-[1fr_90px_90px_60px_90px_32px] gap-2 px-4 py-2.5 border-b border-gray-100 items-center cursor-pointer hover:bg-gray-50 transition-colors ${
                s.status === 'REVIEW' ? 'bg-amber-50 hover:bg-amber-100' : ''
              }`}
              onClick={() => onSelect(s.id)}
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">
                  {s.supplierName ?? 'Unknown supplier'}
                </p>
                <p className="text-[10px] text-gray-400">
                  {s._count.priceAlerts > 0 && (
                    <span className="text-amber-600">
                      ⚠ {s._count.priceAlerts} alert{s._count.priceAlerts !== 1 ? 's' : ''} ·{' '}
                    </span>
                  )}
                  {s.invoiceNumber ?? 'No invoice #'}
                </p>
              </div>
              <div className="text-xs text-gray-600">{s.invoiceDate ?? '—'}</div>
              <div className="text-sm font-semibold text-gray-900">
                {s.total ? formatCurrency(Number(s.total)) : '—'}
              </div>
              <div className="text-xs text-gray-600">{s._count.scanItems}</div>
              <div><StatusBadge status={s.status} /></div>
              <div className="relative" onClick={e => e.stopPropagation()}>
                <button
                  onClick={() => setOpenMenu(openMenu === s.id ? null : s.id)}
                  className="w-7 h-7 flex items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 text-base leading-none"
                >⋯</button>
                {openMenu === s.id && (
                  <div className="absolute right-0 top-8 z-10 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[120px]">
                    <button
                      onClick={() => { setDeleteConfirm({ id: s.id, status: s.status }); setOpenMenu(null) }}
                      className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Mobile card */}
            <div
              className={`sm:hidden flex items-stretch border-b border-gray-100 cursor-pointer ${
                s.status === 'REVIEW' ? 'bg-amber-50' : 'bg-white'
              }`}
              onClick={() => onSelect(s.id)}
            >
              <div className="flex-1 min-w-0 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-gray-900 truncate">
                    {s.supplierName ?? 'Unknown supplier'}
                  </p>
                  <StatusBadge status={s.status} />
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <p className="text-xs text-gray-500">
                    {s.total ? formatCurrency(Number(s.total)) : '—'}
                  </p>
                  <p className="text-xs text-gray-400">{s.invoiceDate ?? '—'}</p>
                  {s._count.priceAlerts > 0 && (
                    <p className="text-[10px] text-amber-600">
                      ⚠ {s._count.priceAlerts} alert{s._count.priceAlerts !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>
              </div>
              <div className="relative flex items-center pr-2 shrink-0" onClick={e => e.stopPropagation()}>
                <button
                  onClick={() => setOpenMenu(openMenu === s.id ? null : s.id)}
                  className="w-8 h-8 flex items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 text-base leading-none"
                >⋯</button>
                {openMenu === s.id && (
                  <div className="absolute right-0 top-9 z-10 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[120px]">
                    <button
                      onClick={() => { setDeleteConfirm({ id: s.id, status: s.status }); setOpenMenu(null) }}
                      className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setDeleteConfirm(null)}
        >
          <div
            className="bg-white rounded-2xl p-6 max-w-sm w-full mx-4 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-gray-900 mb-2">Delete invoice?</h3>
            <p className="text-sm text-gray-500 mb-4">
              {deleteConfirm.status === 'APPROVED'
                ? 'This will remove the approved invoice and reverse its price updates.'
                : 'This will permanently delete the invoice session.'}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm.id, deleteConfirm.status)}
                disabled={isDeleting}
                className="flex-1 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
              >
                {isDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Build to check**

Run: `npm run build`
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/components/invoices/InvoiceList.tsx
git commit -m "feat: add InvoiceList component with tabs, search, mobile cards"
```

---

## Task 5: InvoiceUploadModal Component

This task extracts the upload flow from `src/app/invoices/page.tsx` into a self-contained modal. The logic is identical — only the shell changes (it's now in a modal overlay with `onClose` / `onComplete` callbacks).

**Files:**
- Create: `src/components/invoices/InvoiceUploadModal.tsx`

- [ ] **Step 1: Identify what to copy from the existing page**

Open `src/app/invoices/page.tsx`. The upload modal needs:
- Imports: `Upload`, `ScanLine`, `Camera`, `X`, `CheckCircle2`, `Loader2`, `Image`, `FileText`, `FileSpreadsheet` from `lucide-react`
- `useUploadThing` from `@/lib/uploadthing-client`
- `CameraCapture` from `@/components/CameraCapture`
- `PACK_UOMS`, `COUNT_UOMS` from `@/lib/utils` (not needed for upload, skip)
- State: `files`, `isDragging`, `isCreating`, `noApiKey`, `scanError`, `uploadMode`, `showCamera`, `photoPreviews`
- Handlers: `handleDrop`, `handleFileInput`, `handleCameraCapture`, `removePhoto`, `handleStartScan` (lines 198–326)
- JSX: `renderUpload` (lines 402–572) and the camera overlay (line 1069–1077)

- [ ] **Step 2: Create the modal**

```tsx
// src/components/invoices/InvoiceUploadModal.tsx
'use client'
import { useState } from 'react'
import {
  Upload, ScanLine, Camera, X, CheckCircle2, Loader2,
  Image, FileText, FileSpreadsheet,
} from 'lucide-react'
import { useUploadThing } from '@/lib/uploadthing-client'
import { CameraCapture } from '@/components/CameraCapture'

interface Props {
  onClose: () => void
  onComplete: (newSessionId: string) => void
}

const fileIcon = (fileType: string) => {
  if (fileType.includes('pdf')) return <FileText size={16} className="text-red-500" />
  if (fileType.includes('csv') || fileType.includes('text')) return <FileSpreadsheet size={16} className="text-green-500" />
  return <Image size={16} className="text-blue-500" />
}

const MAX_PHOTOS = 5

export function InvoiceUploadModal({ onClose, onComplete }: Props) {
  const [files, setFiles] = useState<File[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [noApiKey, setNoApiKey] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [uploadMode, setUploadMode] = useState<'file' | 'camera'>('file')
  const [showCamera, setShowCamera] = useState(false)
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([])

  const { startUpload, isUploading } = useUploadThing('invoiceUploader', {
    onUploadError: (err) => { console.error('UploadThing error:', err) },
  })

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const dropped = Array.from(e.dataTransfer.files).filter(f =>
      f.type.startsWith('image/') || f.type === 'application/pdf' ||
      f.type === 'text/csv' || f.name.endsWith('.csv')
    )
    setFiles(prev => [...prev, ...dropped])
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return
    setFiles(prev => [...prev, ...Array.from(e.target.files!)])
    e.target.value = ''
  }

  const handleCameraCapture = (photo: File) => {
    setFiles(prev => {
      if (prev.length >= MAX_PHOTOS) return prev
      const next = [...prev, photo]
      if (next.length >= MAX_PHOTOS) setShowCamera(false)
      return next
    })
    setPhotoPreviews(prev => {
      if (prev.length >= MAX_PHOTOS) return prev
      return [...prev, URL.createObjectURL(photo)]
    })
  }

  const removePhoto = (idx: number) => {
    setFiles(prev => prev.filter((_, i) => i !== idx))
    setPhotoPreviews(prev => {
      URL.revokeObjectURL(prev[idx])
      return prev.filter((_, i) => i !== idx)
    })
  }

  const handleStartScan = async () => {
    if (files.length === 0) return
    setIsCreating(true)
    setScanError(null)
    setNoApiKey(false)

    const sess = await fetch('/api/invoices/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then(r => r.json())

    let uploadOk = false
    try {
      const uploaded = await startUpload(files)
      if (uploaded?.length) {
        await fetch(`/api/invoices/sessions/${sess.id}/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: uploaded.map(f => ({ url: f.ufsUrl, fileName: f.name, fileType: f.type })),
          }),
        })
        uploadOk = true
      }
    } catch { /* fall through to local upload */ }

    if (!uploadOk) {
      const fd = new FormData()
      files.forEach(f => fd.append('files', f))
      const localRes = await fetch(`/api/invoices/sessions/${sess.id}/upload-local`, {
        method: 'POST',
        body: fd,
      })
      if (localRes.ok) {
        uploadOk = true
      } else {
        setScanError('File upload failed. Please try again.')
        setIsCreating(false)
        return
      }
    }

    setIsCreating(false)

    fetch(`/api/invoices/sessions/${sess.id}/process`, { method: 'POST' })
      .then(async res => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          if (err.error?.includes('ANTHROPIC_API_KEY')) setNoApiKey(true)
          else setScanError(err.error || 'Processing failed.')
          await fetch(`/api/invoices/sessions/${sess.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'UPLOADING' }),
          })
        }
      })

    photoPreviews.forEach(url => URL.revokeObjectURL(url))
    onComplete(sess.id)
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
                <ScanLine size={16} className="text-blue-600" />
              </div>
              <h2 className="text-base font-bold text-gray-900">Scan Invoice</h2>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100">
              <X size={16} />
            </button>
          </div>

          {/* Body — copy the content of renderUpload() from src/app/invoices/page.tsx
              lines 403–572 (the inner div content, not the outer wrapper).
              Replace `setView` / `handleNewScan` references with `onClose`. */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">

            {scanError && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
                <strong>Upload error:</strong> {scanError}
              </div>
            )}

            {noApiKey && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
                <strong>ANTHROPIC_API_KEY not set.</strong> Add your key to{' '}
                <code className="bg-amber-100 px-1 rounded">.env</code> and restart the server.
              </div>
            )}

            {/* Mode toggle */}
            <div className="flex gap-2 p-1 bg-gray-100 rounded-xl">
              <button
                type="button"
                onClick={() => setUploadMode('file')}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  uploadMode === 'file' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Upload size={15} /> Upload File
              </button>
              <button
                type="button"
                onClick={() => setUploadMode('camera')}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  uploadMode === 'camera' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Camera size={15} /> Use Camera
              </button>
            </div>

            {uploadMode === 'file' ? (
              <>
                {/* Drag-and-drop zone — copy from page.tsx renderUpload, the drag-drop div and file list section */}
                {/* Lines ~449–496 of src/app/invoices/page.tsx */}
                <div
                  onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => document.getElementById('modal-file-input')?.click()}
                  className={`border-2 border-dashed rounded-2xl py-10 flex flex-col items-center gap-3 cursor-pointer transition-colors ${
                    isDragging ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <Upload size={32} className="text-gray-300" />
                  <div className="text-center">
                    <p className="font-medium text-gray-700">Drop files here or click to browse</p>
                    <p className="text-xs text-gray-400 mt-1">Photos, PDFs, or CSVs</p>
                  </div>
                </div>
                <input
                  id="modal-file-input"
                  type="file"
                  multiple
                  accept="image/*,.pdf,.csv"
                  className="hidden"
                  onChange={handleFileInput}
                />

                {files.length > 0 && (
                  <div className="bg-gray-50 rounded-xl divide-y divide-gray-100">
                    {files.map((f, i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-3">
                        {fileIcon(f.type)}
                        <span className="flex-1 text-sm text-gray-700 truncate">{f.name}</span>
                        <button onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} className="p-1 text-gray-400 hover:text-red-500">
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Camera mode — copy from page.tsx renderUpload camera section */}
                {/* Lines ~498–561 of src/app/invoices/page.tsx */}
                {photoPreviews.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Pages captured</p>
                      <p className="text-xs text-gray-400">{photoPreviews.length} / {MAX_PHOTOS}</p>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {photoPreviews.map((url, i) => (
                        <div key={i} className="relative aspect-[3/4] rounded-xl overflow-hidden border border-gray-200 bg-gray-50">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url} alt={`Page ${i + 1}`} className="w-full h-full object-cover" />
                          <div className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center">
                            <span className="text-white text-[10px] font-bold">{i + 1}</span>
                          </div>
                          <button type="button" onClick={() => removePhoto(i)} className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-red-500 flex items-center justify-center">
                            <X size={10} className="text-white" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {photoPreviews.length < MAX_PHOTOS ? (
                  <button type="button" onClick={() => setShowCamera(true)} className="w-full border-2 border-dashed border-blue-200 bg-blue-50 hover:bg-blue-100 rounded-2xl py-10 flex flex-col items-center gap-3 transition-colors">
                    <div className="w-16 h-16 rounded-full bg-blue-600 flex items-center justify-center shadow-lg">
                      <Camera size={28} className="text-white" />
                    </div>
                    <div className="text-center">
                      <p className="font-semibold text-blue-700">{photoPreviews.length === 0 ? 'Take Photo' : 'Add Another Page'}</p>
                      <p className="text-xs text-blue-500 mt-0.5">
                        {photoPreviews.length === 0 ? 'Opens your camera — point at the invoice' : `${MAX_PHOTOS - photoPreviews.length} page${MAX_PHOTOS - photoPreviews.length !== 1 ? 's' : ''} remaining`}
                      </p>
                    </div>
                  </button>
                ) : (
                  <div className="w-full border-2 border-gray-100 bg-gray-50 rounded-2xl py-6 flex flex-col items-center gap-2">
                    <CheckCircle2 size={24} className="text-green-500" />
                    <p className="text-sm font-medium text-gray-600">Maximum {MAX_PHOTOS} pages reached</p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="px-5 py-4 border-t border-gray-100 shrink-0">
            <button
              onClick={handleStartScan}
              disabled={files.length === 0 || isCreating || isUploading}
              className="w-full bg-blue-600 text-white rounded-xl py-3 font-semibold flex items-center justify-center gap-2 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {(isCreating || isUploading) ? <Loader2 size={18} className="animate-spin" /> : <ScanLine size={18} />}
              {isUploading ? 'Uploading…' : isCreating ? 'Starting…' : `Scan ${files.length > 0 ? `${files.length} ${files.length > 1 ? 'pages' : 'file'}` : 'Invoice'}`}
            </button>
          </div>
        </div>
      </div>

      {showCamera && (
        <CameraCapture
          pageNumber={files.length + 1}
          maxPages={MAX_PHOTOS}
          onCapture={handleCameraCapture}
          onClose={() => setShowCamera(false)}
        />
      )}
    </>
  )
}
```

- [ ] **Step 3: Build to check**

Run: `npm run build`
Expected: build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/components/invoices/InvoiceUploadModal.tsx
git commit -m "feat: add InvoiceUploadModal (extracted from page)"
```

---

## Task 6: InvoiceDrawer Component

This is the largest task. It extracts the processing/review/approve flow from `page.tsx` into a right-side slide drawer. All the sub-components (`ScanItemCard`, `ActionSelect`, `ItemDetailPanel`, `InventoryEditModal`, `AddItemModal`) move here too.

**Files:**
- Create: `src/components/invoices/InvoiceDrawer.tsx`

- [ ] **Step 1: Identify what moves from `src/app/invoices/page.tsx`**

| What | Source lines | Destination |
|---|---|---|
| `descriptionToKeywords` helper | 17–27 | Top of `InvoiceDrawer.tsx` |
| `confidenceBadge` helper | 115–120 | Top of `InvoiceDrawer.tsx` |
| `fileIcon` helper | 122–126 | Top of `InvoiceDrawer.tsx` |
| `ocrStatusBadge` helper | 128–133 | Top of `InvoiceDrawer.tsx` |
| `renderProcessing` render fn | 587–624 | `renderProcessing()` inside drawer |
| `renderReview` render fn | 628–887 | `renderReview()` inside drawer |
| `renderResults` render fn | 891–929 | `renderDone()` inside drawer |
| `AddItemModal` component | 1082–1197 | Module scope in `InvoiceDrawer.tsx` |
| `ScanItemCard` component | 1289–1801 | Module scope in `InvoiceDrawer.tsx` |
| `ActionSelect` component | 1802–1868 | Module scope in `InvoiceDrawer.tsx` |
| `ItemDetailPanel` component | 1869–2147 | Module scope in `InvoiceDrawer.tsx` |
| `InventoryEditModal` component | 2148–2391 | Module scope in `InvoiceDrawer.tsx` |

- [ ] **Step 2: Create `InvoiceDrawer.tsx` with the shell and all state/handlers**

```tsx
// src/components/invoices/InvoiceDrawer.tsx
'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import {
  X, Loader2, CheckCircle2, ScanLine, AlertTriangle,
  FileText, Image, FileSpreadsheet, TrendingUp, TrendingDown,
  Plus, Bell, Package, ClipboardList, ChevronRight, Pencil,
  Trash2, AlertCircle, Hash, CalendarDays, ChevronDown,
} from 'lucide-react'
import { formatCurrency, PACK_UOMS, COUNT_UOMS, calcPricePerBaseUnit, deriveBaseUnit, calcConversionFactor } from '@/lib/utils'
import { comparePricesNormalized, calcNewPurchasePrice } from '@/lib/invoice-format'
import { Session, ApproveResult } from './types'

interface Props {
  sessionId: string | null
  onClose: () => void
  onApproveOrReject: () => void
}

// ── Copy helper functions verbatim from src/app/invoices/page.tsx ─────────────
// descriptionToKeywords: lines 17–27
// confidenceBadge:       lines 115–120
// fileIcon:              lines 122–126
// ocrStatusBadge:        lines 128–133
// ─────────────────────────────────────────────────────────────────────────────

// [Paste descriptionToKeywords here — lines 17–27 of page.tsx]
// [Paste confidenceBadge here — lines 115–120 of page.tsx]
// [Paste fileIcon here — lines 122–126 of page.tsx]
// [Paste ocrStatusBadge here — lines 128–133 of page.tsx]

// ── Copy sub-components verbatim from src/app/invoices/page.tsx ───────────────
// AddItemModal:       lines 1082–1197 (remove export keyword if present — it's a local component)
// ScanItemCard:       lines 1289–1801
// ActionSelect:       lines 1802–1868
// ItemDetailPanel:    lines 1869–2147
// InventoryEditModal: lines 2148–2391
// ─────────────────────────────────────────────────────────────────────────────

// [Paste AddItemModal here]
// [Paste ScanItemCard here]
// [Paste ActionSelect here]
// [Paste ItemDetailPanel here]
// [Paste InventoryEditModal here]

// ── Main drawer component ─────────────────────────────────────────────────────

export function InvoiceDrawer({ sessionId, onClose, onApproveOrReject }: Props) {
  const [session, setSession] = useState<Session | null>(null)
  const [approveResult, setApproveResult] = useState<ApproveResult | null>(null)
  const [isApproving, setIsApproving] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [approvedBy, setApprovedBy] = useState(() =>
    typeof window !== 'undefined' ? (localStorage.getItem('approvedBy') ?? '') : ''
  )
  const [editingItem, setEditingItem] = useState<import('./types').ScanItem | null>(null)
  const [editingInventory, setEditingInventory] = useState<{
    inventoryItemId: string
    scanItem: import('./types').ScanItem
  } | null>(null)
  const [isAddingItem, setIsAddingItem] = useState(false)
  const [duplicateDismissed, setDuplicateDismissed] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchSession = useCallback(async (id: string) => {
    const data: Session = await fetch(`/api/invoices/sessions/${id}`).then(r => r.json())
    setSession(data)
    return data
  }, [])

  // Load session when sessionId changes
  useEffect(() => {
    if (!sessionId) {
      setSession(null)
      setApproveResult(null)
      return
    }
    setApproveResult(null)
    setDuplicateDismissed(false)
    fetchSession(sessionId)
  }, [sessionId, fetchSession])

  // Poll while PROCESSING
  useEffect(() => {
    if (session?.status === 'PROCESSING') {
      pollRef.current = setInterval(async () => {
        const s = await fetchSession(session.id)
        if (s.status !== 'PROCESSING') {
          if (pollRef.current) clearInterval(pollRef.current)
        }
      }, 2000)
    } else {
      if (pollRef.current) clearInterval(pollRef.current)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [session?.status, session?.id, fetchSession])

  const updateScanItem = async (
    itemId: string,
    updates: Partial<Omit<import('./types').ScanItem, 'newItemData'> & { newItemData?: Record<string, unknown> | string | null }>
  ) => {
    await fetch(`/api/invoices/sessions/${session!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanItemId: itemId, ...updates }),
    })
    await fetchSession(session!.id)
  }

  const handleApproveAll = async () => {
    if (!session) return
    setIsApproving(true)
    const res = await fetch(`/api/invoices/sessions/${session.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvedBy: approvedBy || 'Manager' }),
    })
    const result = await res.json()
    setApproveResult(result)
    setIsApproving(false)
    onApproveOrReject()
  }

  const handleReject = async () => {
    if (!session) return
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'REJECTED' }),
    })
    onApproveOrReject()
    onClose()
  }

  const handleCancelProcessing = async () => {
    if (!session) return
    setIsCancelling(true)
    await fetch(`/api/invoices/sessions/${session.id}/process`, { method: 'DELETE' })
    await fetchSession(session.id)
    setIsCancelling(false)
  }

  const handleAddItem = async (desc: string, qty: number | null, unitPrice: number | null) => {
    if (!session || !desc.trim()) return
    await fetch(`/api/invoices/sessions/${session.id}/scanitems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: desc, qty, unitPrice }),
    })
    await fetchSession(session.id)
    setIsAddingItem(false)
  }

  // Don't render anything if no session is selected
  if (!sessionId) return null

  const isOpen = !!sessionId

  // Determine which internal state to show
  const drawerState: 'loading' | 'processing' | 'review' | 'done' =
    !session ? 'loading'
    : approveResult ? 'done'
    : session.status === 'PROCESSING' ? 'processing'
    : session.status === 'REVIEW' ? 'review'
    : 'done'

  // ── renderProcessing ────────────────────────────────────────────────────────
  // Copy the JSX body of renderProcessing() from src/app/invoices/page.tsx
  // lines 588–623. Replace `session` references — `session` is now local state.
  // Replace `handleCancelProcessing` and `isCancelling` — both are defined above.
  const renderProcessing = () => (
    // [Paste renderProcessing JSX here from page.tsx lines 588–623]
    // The outer div wrapping changes: use a scrollable content div, not max-w-xl mx-auto
    <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-100 animate-pulse">
        <ScanLine size={32} className="text-blue-600" />
      </div>
      <div>
        <h2 className="text-lg font-bold text-gray-900 mb-1">Scanning Invoice…</h2>
        <p className="text-sm text-gray-500">
          {session?.files && session.files.length > 1
            ? `Sending all ${session.files.length} pages to Claude — usually 15–30 seconds.`
            : 'Claude is reading and extracting line items. Usually 10–20 seconds.'}
        </p>
      </div>
      {session?.files && (
        <div className="w-full bg-white rounded-xl border border-gray-100 divide-y divide-gray-50 text-left">
          {session.files.map(f => (
            <div key={f.id} className="flex items-center gap-3 px-4 py-3">
              {fileIcon(f.fileType)}
              <span className="flex-1 text-sm text-gray-700 truncate">{f.fileName}</span>
              {ocrStatusBadge(f.ocrStatus)}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Processing…
        </div>
        <button
          onClick={handleCancelProcessing}
          disabled={isCancelling}
          className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
        >
          {isCancelling ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
          {isCancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      </div>
    </div>
  )

  // ── renderReview ────────────────────────────────────────────────────────────
  // Copy the body of renderReview() from src/app/invoices/page.tsx lines 629–886.
  // Key changes required:
  //   - `sessions` (the full list, used for duplicate detection) is no longer
  //     available. Remove the duplicate detection block (lines 639–643) or pass
  //     sessions as a prop. Simplest: remove it (it was advisory only).
  //   - `session` is local state (already defined above).
  //   - `approvedBy`, `setApprovedBy`, `isApproving` are defined above.
  //   - `handleApproveAll`, `updateScanItem` are defined above.
  //   - `setEditingItem`, `setEditingInventory`, `setIsAddingItem` are defined above.
  //   - `editingItem`, `editingInventory`, `isAddingItem` are defined above.
  //   - `duplicateDismissed`, `setDuplicateDismissed` are defined above.
  const renderReview = () => {
    if (!session) return null
    // [Paste renderReview body here from page.tsx lines 630–886]
    // Remove the duplicate detection lines (639–643 and any JSX that uses `duplicateSession`)
    // or keep them if you add `sessions` as a prop — your call.
    return null // placeholder — replace with actual JSX
  }

  // ── renderDone ──────────────────────────────────────────────────────────────
  // Copy the body of renderResults() from src/app/invoices/page.tsx lines 892–929.
  // Replace the "Scan another invoice" button with `onClose()`.
  const renderDone = () => {
    if (!approveResult && session?.status !== 'APPROVED' && session?.status !== 'REJECTED') return null
    if (approveResult) {
      // [Paste renderResults JSX here from page.tsx lines 893–929]
      // Replace any "handleNewScan" call with onClose()
      return null // placeholder — replace with actual JSX
    }
    // Session already approved/rejected when opened from list
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
        {session?.status === 'APPROVED'
          ? <CheckCircle2 size={40} className="text-green-500" />
          : <X size={40} className="text-red-500" />}
        <p className="text-lg font-bold text-gray-900">
          {session?.status === 'APPROVED' ? 'Invoice Approved' : 'Invoice Rejected'}
        </p>
        <p className="text-sm text-gray-400">{session?.supplierName ?? ''} · {session?.invoiceDate ?? ''}</p>
        <button onClick={onClose} className="mt-2 px-6 py-2 rounded-xl bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200">
          Close
        </button>
      </div>
    )
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={onClose}
      />

      {/* Desktop: right-side drawer */}
      <div className={`hidden sm:flex fixed top-0 right-0 h-full w-[480px] z-50 bg-white shadow-2xl flex-col transition-transform duration-150 ease-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        {/* Drawer header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div className="min-w-0">
            <p className="text-base font-bold text-gray-900 truncate">
              {session?.supplierName ?? 'Invoice'}
            </p>
            {session && (
              <p className="text-xs text-gray-400">
                {session.invoiceNumber ?? 'No invoice #'} · {session.invoiceDate ?? ''}
                {session.total ? ` · ${formatCurrency(Number(session.total))}` : ''}
              </p>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 ml-3">
            <X size={18} />
          </button>
        </div>

        {/* Drawer body */}
        <div className="flex-1 overflow-y-auto">
          {drawerState === 'loading' && (
            <div className="flex items-center justify-center h-full">
              <Loader2 size={24} className="animate-spin text-gray-300" />
            </div>
          )}
          {drawerState === 'processing' && renderProcessing()}
          {drawerState === 'review' && renderReview()}
          {drawerState === 'done' && renderDone()}
        </div>
      </div>

      {/* Mobile: bottom sheet */}
      <div className={`sm:hidden fixed inset-0 z-50 flex items-end ${isOpen ? '' : 'pointer-events-none'}`}>
        <div
          className={`relative bg-white w-full rounded-t-2xl flex flex-col transition-transform duration-150 ease-out`}
          style={{ maxHeight: '90vh', transform: isOpen ? 'translateY(0)' : 'translateY(100%)' }}
        >
          {/* Handle */}
          <div className="flex justify-center pt-3 pb-1 shrink-0">
            <div className="w-10 h-1 rounded-full bg-gray-200" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0">
            <div className="min-w-0">
              <p className="text-base font-bold text-gray-900 truncate">
                {session?.supplierName ?? 'Invoice'}
              </p>
              {session && (
                <p className="text-xs text-gray-400">
                  {session.invoiceNumber ?? 'No invoice #'} · {session.invoiceDate ?? ''}
                </p>
              )}
            </div>
            <button onClick={onClose} className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 ml-3">
              <X size={18} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto">
            {drawerState === 'loading' && (
              <div className="flex items-center justify-center py-20">
                <Loader2 size={24} className="animate-spin text-gray-300" />
              </div>
            )}
            {drawerState === 'processing' && renderProcessing()}
            {drawerState === 'review' && renderReview()}
            {drawerState === 'done' && renderDone()}
          </div>
        </div>
      </div>

      {/* Sub-panels (rendered at z-60 so they appear above the drawer) */}
      {editingItem && (
        <ItemDetailPanel
          item={editingItem}
          onSave={async (updates) => { await updateScanItem(editingItem.id, updates); setEditingItem(null) }}
          onClose={() => setEditingItem(null)}
        />
      )}
      {editingInventory && (
        <InventoryEditModal
          inventoryItemId={editingInventory.inventoryItemId}
          scanItem={editingInventory.scanItem}
          onSaved={async (updates) => { await updateScanItem(editingInventory.scanItem.id, updates); setEditingInventory(null) }}
          onClose={() => setEditingInventory(null)}
        />
      )}
      {isAddingItem && (
        <AddItemModal onAdd={handleAddItem} onClose={() => setIsAddingItem(false)} />
      )}
    </>
  )
}
```

- [ ] **Step 3: Fill in the copy-paste sections**

The skeleton above has four `[Paste ... here]` placeholders. For each:

1. **Helper functions** — copy lines 17–27 and 115–133 verbatim from `src/app/invoices/page.tsx`. Paste above the sub-component definitions.

2. **Sub-components** — copy the five function definitions verbatim from `src/app/invoices/page.tsx`:
   - `AddItemModal`: lines 1084–1197
   - `ScanItemCard`: lines 1289–1801
   - `ActionSelect`: lines 1802–1868
   - `ItemDetailPanel`: lines 1869–2147
   - `InventoryEditModal`: lines 2148–2391

3. **`renderProcessing` body** — the JSX shown in Step 2 above is already complete (it replaces `renderProcessing`). No further paste needed.

4. **`renderReview` body** — replace `return null // placeholder` with the body of `renderReview` from `src/app/invoices/page.tsx` lines 630–886. Remove the duplicate detection block (lines 639–643 and the corresponding JSX). All other references (`session`, `updateScanItem`, `setEditingItem`, etc.) map directly to state/handlers defined in the drawer's component body.

5. **`renderDone` body** — replace `return null // placeholder` in the `approveResult` branch with the JSX from `renderResults()` in `src/app/invoices/page.tsx` lines 893–929. Replace any `handleNewScan()` call with `onClose()`.

- [ ] **Step 4: Build to check**

Run: `npm run build`
Expected: build succeeds. Fix any TypeScript errors about missing props or type mismatches — the most common issue will be that the copied sub-components reference `Session | null` instead of `Session` — add null guards where needed.

- [ ] **Step 5: Commit**

```bash
git add src/components/invoices/InvoiceDrawer.tsx
git commit -m "feat: add InvoiceDrawer (extracted review/approve flow)"
```

---

## Task 7: Replace page.tsx With Thin Shell

Now that all four components exist, replace `src/app/invoices/page.tsx` with a minimal orchestrator. The old file had 2,391 lines; the new one should be ~60 lines.

**Files:**
- Modify: `src/app/invoices/page.tsx`

- [ ] **Step 1: Replace the entire file**

```tsx
// src/app/invoices/page.tsx
'use client'
import { useState, useCallback, useEffect } from 'react'
import { InvoiceKpiStrip } from '@/components/invoices/InvoiceKpiStrip'
import { InvoiceList } from '@/components/invoices/InvoiceList'
import { InvoiceDrawer } from '@/components/invoices/InvoiceDrawer'
import { InvoiceUploadModal } from '@/components/invoices/InvoiceUploadModal'
import { SessionSummary, SessionStatus } from '@/components/invoices/types'

export default function InvoicesPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [kpiRefreshKey, setKpiRefreshKey] = useState(0)

  const fetchSessions = useCallback(() => {
    fetch('/api/invoices/sessions').then(r => r.json()).then(setSessions)
  }, [])

  useEffect(() => { fetchSessions() }, [fetchSessions])

  const handleApproveOrReject = useCallback(() => {
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
  }, [fetchSessions])

  const handleDelete = useCallback(async (id: string, _status: SessionStatus) => {
    await fetch(`/api/invoices/sessions/${id}`, { method: 'DELETE' })
    fetchSessions()
    if (selectedSessionId === id) setSelectedSessionId(null)
  }, [selectedSessionId, fetchSessions])

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <div className="px-4 pt-4 pb-2 shrink-0">
        <h1 className="text-2xl font-bold text-gray-900">Invoices</h1>
      </div>
      <InvoiceKpiStrip refreshKey={kpiRefreshKey} />
      <InvoiceList
        sessions={sessions}
        onSelect={setSelectedSessionId}
        onUploadClick={() => setShowUpload(true)}
        onDelete={handleDelete}
      />
      <InvoiceDrawer
        sessionId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
        onApproveOrReject={handleApproveOrReject}
      />
      {showUpload && (
        <InvoiceUploadModal
          onClose={() => setShowUpload(false)}
          onComplete={(newSessionId) => {
            fetchSessions()
            setShowUpload(false)
            setSelectedSessionId(newSessionId)
          }}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Build to check**

Run: `npm run build`
Expected: build succeeds. If there are type errors from removed state that sub-components still reference (e.g. `sessions` used in duplicate detection), trace them and fix in the component that imported them.

- [ ] **Step 3: Start the dev server and verify manually**

Run: `npm run dev`

Check:
1. `/invoices` loads — KPI strip shows across the top (or shows `—` if no approved sessions yet)
2. Invoice list shows with All/Review/Approved/Rejected tabs
3. Clicking a row opens the drawer from the right
4. Drawer shows correct content: processing spinner, review flow, or approved/rejected summary
5. Approve button in drawer closes drawer and refreshes KPI strip + list
6. Delete from ⋯ menu works — confirmation modal appears, session is removed
7. Upload button opens modal, file drop and camera modes both work
8. On mobile (resize to < 640px): list rows collapse to cards, drawer becomes bottom sheet, KPI strip scrolls horizontally

- [ ] **Step 4: Commit**

```bash
git add src/app/invoices/page.tsx
git commit -m "feat: refactor invoices page to thin shell with KPI strip, list, and drawer"
```

---

## Self-Review Notes

_Run after writing the plan:_

**Spec coverage check:**
- ✅ Compact KPI bar (5 cards) → Task 3
- ✅ KPI API endpoint → Task 2
- ✅ Status tabs (All/Review/Approved/Rejected) → Task 4
- ✅ Search by supplier/invoice# → Task 4
- ✅ Invoice rows with supplier, date, total, items, status → Task 4
- ✅ Alert indicator on rows → Task 4 (`_count.priceAlerts`)
- ✅ Right-side drawer (480px, slide animation) → Task 6
- ✅ Mobile bottom sheet → Task 6
- ✅ Drawer states: PROCESSING/REVIEW/DONE → Task 6
- ✅ Approve/reject callbacks refetch list + KPIs → Task 7
- ✅ Upload modal (extracted, logic unchanged) → Task 5
- ✅ Delete with confirmation → Task 4
- ✅ Mobile card layout → Task 4
- ✅ KPI strip horizontal scroll on mobile → Task 3 (`overflow-x-auto`, `min-w-*`)
- ✅ KPI fetch failure shows `—` → Task 3 (`.catch(() => {})` + `fmt()` fallback)

**Placeholder check:** Task 6 Step 2 contains explicit copy-paste instructions with exact line numbers rather than vague "TBD" placeholders — each instruction is specific and executable.

**Type consistency:** `Session` and `SessionSummary` are defined once in `types.ts` and imported everywhere. `SessionSummary` used in list/page; `Session` used in drawer. `KpiData` used in strip.
