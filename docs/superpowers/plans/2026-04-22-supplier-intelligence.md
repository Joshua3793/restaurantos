# Supplier Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Inventory → Suppliers page with a top-level Suppliers page that has a split-panel layout (list on left, detail on right) combining contact management with spend KPIs, price change history, and item catalog.

**Architecture:** A new `/suppliers` route owns `selectedSupplierId` state and renders `SupplierList` + `SupplierDetail` side-by-side. `GET /api/suppliers` is augmented with per-supplier spend data for the list rows. A new `GET /api/suppliers/[id]/intelligence` endpoint returns KPIs, price changes, and items for the detail panel. The old `/inventory/suppliers` page becomes a redirect.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind CSS, Prisma + PostgreSQL, Lucide icons, `formatCurrency` from `@/lib/utils`

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/components/suppliers/types.ts` | Shared TypeScript types |
| Modify | `src/app/api/suppliers/route.ts` | Add monthSpend + invoiceCount to list |
| Create | `src/app/api/suppliers/[id]/intelligence/route.ts` | KPIs, price changes, items |
| Create | `src/components/suppliers/SupplierFormModal.tsx` | Add/Edit modal (extracted from inventory page) |
| Create | `src/components/suppliers/SupplierList.tsx` | Left panel — search, sorted rows, Add button |
| Create | `src/components/suppliers/SupplierDetail.tsx` | Right panel — header, KPIs, price changes, items |
| Create | `src/app/suppliers/page.tsx` | Split-panel shell (desktop) |
| Create | `src/app/suppliers/[id]/page.tsx` | Mobile detail page |
| Modify | `src/app/inventory/suppliers/page.tsx` | Replace with redirect to `/suppliers` |
| Modify | `src/app/inventory/layout.tsx` | Remove Suppliers tab |
| Modify | `src/components/Navigation.tsx` | Add Suppliers to sidebar + mobile More drawer |

---

## Task 1: Shared Types

**Files:**
- Create: `src/components/suppliers/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/components/suppliers/types.ts

// Returned by GET /api/suppliers (augmented)
export interface SupplierSummary {
  id: string
  name: string
  contactName: string | null
  phone: string | null
  email: string | null
  orderPlatform: string | null
  cutoffDays: string | null
  deliveryDays: string | null
  monthSpend: number
  prevMonthSpend: number
  invoiceCount: number
  _count: { inventory: number }
}

// Returned by GET /api/suppliers/[id]/intelligence
export interface PriceChange {
  itemName: string
  oldPrice: number
  newPrice: number
  pctChange: number  // positive = increase
  date: string       // ISO date string
}

export interface SuppliedItem {
  id: string
  itemName: string
  pricePerBaseUnit: number
  baseUnit: string
}

export interface SupplierIntelligence {
  monthSpend: number
  monthSpendChangePct: number
  yearSpend: number
  yearInvoiceCount: number
  lastApprovedAt: string | null
  priceChanges: PriceChange[]
  items: SuppliedItem[]
}

// Form data for add/edit
export interface SupplierForm {
  name: string
  contactName: string
  phone: string
  email: string
  orderPlatform: string
  cutoffDays: string
  deliveryDays: string
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/components/suppliers/types.ts
git commit -m "feat: add shared types for supplier intelligence"
```

---

## Task 2: Augment GET /api/suppliers + New Intelligence Endpoint

**Files:**
- Modify: `src/app/api/suppliers/route.ts`
- Create: `src/app/api/suppliers/[id]/intelligence/route.ts`

- [ ] **Step 1: Augment GET /api/suppliers**

Replace the entire `src/app/api/suppliers/route.ts` with:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)

  const [suppliers, monthAgg, prevMonthAgg, invoiceAgg] = await Promise.all([
    prisma.supplier.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { inventory: true } } },
    }),
    prisma.invoiceSession.groupBy({
      by: ['supplierId'],
      where: {
        status: 'APPROVED',
        supplierId: { not: null },
        approvedAt: { gte: monthStart, lt: monthEnd },
      },
      _sum: { total: true },
    }),
    prisma.invoiceSession.groupBy({
      by: ['supplierId'],
      where: {
        status: 'APPROVED',
        supplierId: { not: null },
        approvedAt: { gte: prevMonthStart, lt: monthStart },
      },
      _sum: { total: true },
    }),
    prisma.invoiceSession.groupBy({
      by: ['supplierId'],
      where: { status: 'APPROVED', supplierId: { not: null } },
      _count: true,
    }),
  ])

  const monthMap = Object.fromEntries(monthAgg.map(r => [r.supplierId, Number(r._sum.total ?? 0)]))
  const prevMap = Object.fromEntries(prevMonthAgg.map(r => [r.supplierId, Number(r._sum.total ?? 0)]))
  const countMap = Object.fromEntries(invoiceAgg.map(r => [r.supplierId, r._count]))

  const result = suppliers.map(s => ({
    ...s,
    monthSpend: monthMap[s.id] ?? 0,
    prevMonthSpend: prevMap[s.id] ?? 0,
    invoiceCount: countMap[s.id] ?? 0,
  }))

  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const supplier = await prisma.supplier.create({ data: body })
  return NextResponse.json(supplier, { status: 201 })
}
```

- [ ] **Step 2: Create the intelligence endpoint**

Create `src/app/api/suppliers/[id]/intelligence/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const yearStart = new Date(now.getFullYear(), 0, 1)
  const ninetyDaysAgo = new Date(now)
  ninetyDaysAgo.setDate(now.getDate() - 90)

  const [monthAgg, prevMonthAgg, yearAgg, yearCount, lastSession, priceAlerts, items] =
    await Promise.all([
      prisma.invoiceSession.aggregate({
        where: { supplierId: id, status: 'APPROVED', approvedAt: { gte: monthStart, lt: monthEnd } },
        _sum: { total: true },
      }),
      prisma.invoiceSession.aggregate({
        where: { supplierId: id, status: 'APPROVED', approvedAt: { gte: prevMonthStart, lt: monthStart } },
        _sum: { total: true },
      }),
      prisma.invoiceSession.aggregate({
        where: { supplierId: id, status: 'APPROVED', approvedAt: { gte: yearStart } },
        _sum: { total: true },
      }),
      prisma.invoiceSession.count({
        where: { supplierId: id, status: 'APPROVED', approvedAt: { gte: yearStart } },
      }),
      prisma.invoiceSession.findFirst({
        where: { supplierId: id, status: 'APPROVED' },
        orderBy: { approvedAt: 'desc' },
        select: { approvedAt: true },
      }),
      prisma.priceAlert.findMany({
        where: { session: { supplierId: id }, createdAt: { gte: ninetyDaysAgo } },
        include: { inventoryItem: { select: { itemName: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.inventoryItem.findMany({
        where: { supplierId: id },
        orderBy: { itemName: 'asc' },
        select: { id: true, itemName: true, pricePerBaseUnit: true, baseUnit: true },
      }),
    ])

  const monthSpend = Number(monthAgg._sum.total ?? 0)
  const prevMonthSpend = Number(prevMonthAgg._sum.total ?? 0)
  const monthSpendChangePct =
    prevMonthSpend === 0 ? 0 : Math.round(((monthSpend - prevMonthSpend) / prevMonthSpend) * 100)

  return NextResponse.json({
    monthSpend,
    monthSpendChangePct,
    yearSpend: Number(yearAgg._sum.total ?? 0),
    yearInvoiceCount: yearCount,
    lastApprovedAt: lastSession?.approvedAt?.toISOString() ?? null,
    priceChanges: priceAlerts.map(a => ({
      itemName: a.inventoryItem.itemName,
      oldPrice: Number(a.previousPrice),
      newPrice: Number(a.newPrice),
      pctChange: Number(a.changePct),
      date: a.createdAt.toISOString().split('T')[0],
    })),
    items: items.map(i => ({
      id: i.id,
      itemName: i.itemName,
      pricePerBaseUnit: Number(i.pricePerBaseUnit),
      baseUnit: i.baseUnit,
    })),
  })
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/app/api/suppliers/route.ts src/app/api/suppliers/[id]/intelligence/route.ts
git commit -m "feat: augment suppliers list API and add intelligence endpoint"
```

---

## Task 3: SupplierFormModal

**Files:**
- Create: `src/components/suppliers/SupplierFormModal.tsx`

- [ ] **Step 1: Create the modal**

```tsx
// src/components/suppliers/SupplierFormModal.tsx
'use client'
import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { SupplierForm, SupplierSummary } from './types'

const emptyForm: SupplierForm = {
  name: '', contactName: '', phone: '', email: '',
  orderPlatform: '', cutoffDays: '', deliveryDays: '',
}

const fields: { key: keyof SupplierForm; label: string; required?: boolean; placeholder?: string }[] = [
  { key: 'name',          label: 'Company Name',   required: true },
  { key: 'contactName',   label: 'Contact Name' },
  { key: 'phone',         label: 'Phone' },
  { key: 'email',         label: 'Email' },
  { key: 'orderPlatform', label: 'Order Platform', placeholder: 'e.g. Online Portal, Phone, Email' },
  { key: 'cutoffDays',    label: 'Cutoff Days',    placeholder: 'e.g. Monday, Wednesday' },
  { key: 'deliveryDays',  label: 'Delivery Days',  placeholder: 'e.g. Tuesday, Thursday' },
]

interface Props {
  supplier: SupplierSummary | null  // null = add mode
  onClose: () => void
  onSaved: () => void
}

export function SupplierFormModal({ supplier, onClose, onSaved }: Props) {
  const [form, setForm] = useState<SupplierForm>(emptyForm)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (supplier) {
      setForm({
        name: supplier.name,
        contactName: supplier.contactName ?? '',
        phone: supplier.phone ?? '',
        email: supplier.email ?? '',
        orderPlatform: supplier.orderPlatform ?? '',
        cutoffDays: supplier.cutoffDays ?? '',
        deliveryDays: supplier.deliveryDays ?? '',
      })
    } else {
      setForm(emptyForm)
    }
  }, [supplier])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    if (supplier) {
      await fetch(`/api/suppliers/${supplier.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
    } else {
      await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
    }
    setSaving(false)
    onSaved()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-gray-900">
            {supplier ? 'Edit Supplier' : 'Add Supplier'}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          {fields.map(f => (
            <div key={f.key}>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {f.label}{f.required && ' *'}
              </label>
              <input
                required={f.required}
                value={form[f.key]}
                onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder ?? ''}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-gray-200 rounded-lg py-2 text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : supplier ? 'Save Changes' : 'Add Supplier'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/components/suppliers/SupplierFormModal.tsx
git commit -m "feat: add SupplierFormModal component"
```

---

## Task 4: SupplierList

**Files:**
- Create: `src/components/suppliers/SupplierList.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/components/suppliers/SupplierList.tsx
'use client'
import { useState } from 'react'
import { SupplierSummary } from './types'
import { formatCurrency } from '@/lib/utils'

interface Props {
  suppliers: SupplierSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
}

export function SupplierList({ suppliers, selectedId, onSelect, onAdd }: Props) {
  const [search, setSearch] = useState('')

  const filtered = suppliers.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase())
  )

  // Sort by monthSpend descending
  const sorted = [...filtered].sort((a, b) => b.monthSpend - a.monthSpend)

  const spendLabel = (s: SupplierSummary) => {
    if (s.monthSpend === 0) return '$0 this month'
    const pct = s.prevMonthSpend === 0
      ? null
      : Math.round(((s.monthSpend - s.prevMonthSpend) / s.prevMonthSpend) * 100)
    return `${formatCurrency(s.monthSpend)} this month${pct !== null ? ` · ${pct >= 0 ? '↑' : '↓'}${Math.abs(pct)}%` : ''}`
  }

  const spendColor = (s: SupplierSummary) => {
    if (s.monthSpend === 0 || s.prevMonthSpend === 0) return 'text-gray-400'
    const pct = ((s.monthSpend - s.prevMonthSpend) / s.prevMonthSpend) * 100
    if (pct >= 15) return 'text-red-500'
    if (pct > 0) return 'text-green-600'
    return 'text-gray-500'
  }

  return (
    <div className="flex flex-col w-full sm:w-[280px] shrink-0 bg-gray-50 border-r border-gray-200 h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-200 shrink-0">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search suppliers…"
          className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={onAdd}
          className="bg-blue-600 text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-blue-700 shrink-0 transition-colors"
        >
          + Add
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-400">No suppliers found</div>
        )}
        {sorted.map(s => {
          const selected = s.id === selectedId
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`w-full text-left px-3 py-3 border-b border-gray-100 transition-colors ${
                selected
                  ? 'bg-blue-50 border-l-2 border-l-blue-500'
                  : 'bg-white hover:bg-gray-50 border-l-2 border-l-transparent'
              }`}
            >
              <p className={`text-sm font-semibold truncate ${selected ? 'text-blue-700' : 'text-gray-900'}`}>
                {s.name}
              </p>
              <p className={`text-xs mt-0.5 font-medium ${spendColor(s)}`}>
                {spendLabel(s)}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                {s._count.inventory} item{s._count.inventory !== 1 ? 's' : ''} · {s.invoiceCount} invoice{s.invoiceCount !== 1 ? 's' : ''}
              </p>
            </button>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/components/suppliers/SupplierList.tsx
git commit -m "feat: add SupplierList component"
```

---

## Task 5: SupplierDetail

**Files:**
- Create: `src/components/suppliers/SupplierDetail.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/components/suppliers/SupplierDetail.tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import { Pencil, Trash2, Loader2 } from 'lucide-react'
import { SupplierSummary, SupplierIntelligence } from './types'
import { formatCurrency } from '@/lib/utils'

interface Props {
  supplierId: string
  onEdit: (supplier: SupplierSummary) => void
  onDelete: (id: string) => void
  // supplier contact info from the already-loaded list (avoids extra fetch on desktop)
  supplier: SupplierSummary | null
}

export function SupplierDetail({ supplierId, onEdit, onDelete, supplier }: Props) {
  const [intel, setIntel] = useState<SupplierIntelligence | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchIntel = useCallback(async () => {
    setLoading(true)
    const data = await fetch(`/api/suppliers/${supplierId}/intelligence`)
      .then(r => r.json())
      .catch(() => null)
    setIntel(data)
    setLoading(false)
  }, [supplierId])

  useEffect(() => { fetchIntel() }, [fetchIntel])

  const changePctColor = (pct: number) =>
    pct >= 15 ? 'text-red-500' : pct > 0 ? 'text-green-600' : pct < 0 ? 'text-green-600' : 'text-gray-400'

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white">
      {/* Dark header */}
      <div className="bg-slate-800 text-white px-5 py-4 shrink-0 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-bold truncate">{supplier?.name ?? '—'}</h2>
          <div className="text-xs text-slate-400 mt-0.5 space-y-0.5">
            {(supplier?.contactName || supplier?.phone || supplier?.email) && (
              <p className="truncate">
                {[supplier?.contactName, supplier?.phone, supplier?.email].filter(Boolean).join(' · ')}
              </p>
            )}
            {(supplier?.orderPlatform || supplier?.cutoffDays || supplier?.deliveryDays) && (
              <p className="truncate">
                {[
                  supplier?.orderPlatform && `Order via: ${supplier.orderPlatform}`,
                  supplier?.cutoffDays && `Cutoff: ${supplier.cutoffDays}`,
                  supplier?.deliveryDays && `Delivery: ${supplier.deliveryDays}`,
                ].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
        </div>
        {supplier && (
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => onEdit(supplier)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              <Pencil size={12} /> Edit
            </button>
            <button
              onClick={() => onDelete(supplier.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/20 hover:bg-red-500/30 text-red-300 transition-colors"
            >
              <Trash2 size={12} /> Delete
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={24} className="animate-spin text-gray-300" />
        </div>
      ) : !intel ? (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
          Failed to load intelligence data
        </div>
      ) : (
        <>
          {/* KPI strip */}
          <div className="flex gap-3 px-4 py-3 bg-gray-50 border-b border-gray-200 shrink-0">
            <div className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2.5">
              <p className="text-[10px] text-gray-400 uppercase tracking-wide">This Month</p>
              <p className="text-lg font-bold text-gray-900 leading-tight">{formatCurrency(intel.monthSpend)}</p>
              <p className={`text-[10px] font-medium ${changePctColor(intel.monthSpendChangePct)}`}>
                {intel.monthSpendChangePct === 0 ? '— vs last month'
                  : `${intel.monthSpendChangePct > 0 ? '↑' : '↓'} ${Math.abs(intel.monthSpendChangePct)}% vs last month`}
              </p>
            </div>
            <div className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2.5">
              <p className="text-[10px] text-gray-400 uppercase tracking-wide">This Year</p>
              <p className="text-lg font-bold text-gray-900 leading-tight">{formatCurrency(intel.yearSpend)}</p>
              <p className="text-[10px] text-gray-400">{intel.yearInvoiceCount} invoice{intel.yearInvoiceCount !== 1 ? 's' : ''} approved</p>
            </div>
            <div className={`flex-1 rounded-lg px-3 py-2.5 border ${intel.priceChanges.length > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-200'}`}>
              <p className={`text-[10px] uppercase tracking-wide ${intel.priceChanges.length > 0 ? 'text-amber-700' : 'text-gray-400'}`}>
                Price Changes
              </p>
              <p className={`text-lg font-bold leading-tight ${intel.priceChanges.length > 0 ? 'text-amber-700' : 'text-gray-900'}`}>
                {intel.priceChanges.length} item{intel.priceChanges.length !== 1 ? 's' : ''}
              </p>
              <p className={`text-[10px] ${intel.priceChanges.length > 0 ? 'text-amber-600' : 'text-gray-400'}`}>last 90 days</p>
            </div>
          </div>

          {/* Body: two-column grid */}
          <div className="flex-1 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">

            {/* Price Changes */}
            <div className="px-4 py-4">
              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Price Changes</h3>
              {intel.priceChanges.length === 0 ? (
                <p className="text-sm text-gray-400">No price changes in the last 90 days</p>
              ) : (
                <div className="space-y-2">
                  {intel.priceChanges.map((pc, i) => (
                    <div key={i} className="bg-white border border-gray-100 rounded-lg px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-gray-900 truncate">{pc.itemName}</span>
                        <span className={`text-xs font-bold shrink-0 ${pc.pctChange > 0 ? 'text-red-500' : 'text-green-600'}`}>
                          {pc.pctChange > 0 ? '↑' : '↓'} {Math.abs(Math.round(pc.pctChange))}%
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {formatCurrency(pc.oldPrice)} → <span className="font-semibold text-gray-700">{formatCurrency(pc.newPrice)}</span>
                        {' · '}{pc.date}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Items Supplied */}
            <div className="px-4 py-4">
              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">
                Items Supplied ({intel.items.length})
              </h3>
              {intel.items.length === 0 ? (
                <p className="text-sm text-gray-400">No inventory items linked to this supplier</p>
              ) : (
                <div className="bg-white border border-gray-100 rounded-lg overflow-hidden">
                  <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-100">
                    <span className="text-[10px] font-semibold text-gray-400 uppercase">Item</span>
                    <span className="text-[10px] font-semibold text-gray-400 uppercase">Price</span>
                    <span className="text-[10px] font-semibold text-gray-400 uppercase">Unit</span>
                  </div>
                  {intel.items.map(item => (
                    <div key={item.id} className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-2 border-b border-gray-50 last:border-0 items-center">
                      <span className="text-xs text-gray-900 truncate">{item.itemName}</span>
                      <span className="text-xs font-semibold text-gray-700">{formatCurrency(item.pricePerBaseUnit)}</span>
                      <span className="text-[10px] text-gray-400">/{item.baseUnit}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/components/suppliers/SupplierDetail.tsx
git commit -m "feat: add SupplierDetail component with KPIs, price changes, items"
```

---

## Task 6: Suppliers Page Shell + Mobile Detail Page

**Files:**
- Create: `src/app/suppliers/page.tsx`
- Create: `src/app/suppliers/[id]/page.tsx`

- [ ] **Step 1: Create the desktop split-panel shell**

```tsx
// src/app/suppliers/page.tsx
'use client'
import { useState, useCallback, useEffect } from 'react'
import { SupplierList } from '@/components/suppliers/SupplierList'
import { SupplierDetail } from '@/components/suppliers/SupplierDetail'
import { SupplierFormModal } from '@/components/suppliers/SupplierFormModal'
import { SupplierSummary } from '@/components/suppliers/types'
import Link from 'next/link'

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editSupplier, setEditSupplier] = useState<SupplierSummary | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const fetchSuppliers = useCallback(() => {
    fetch('/api/suppliers').then(r => r.json()).then((data: SupplierSummary[]) => {
      setSuppliers(data)
      // Auto-select first supplier if none selected
      setSelectedId(prev => prev ?? (data[0]?.id ?? null))
    })
  }, [])

  useEffect(() => { fetchSuppliers() }, [fetchSuppliers])

  const selectedSupplier = suppliers.find(s => s.id === selectedId) ?? null

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this supplier? Inventory items will be unlinked.')) return
    await fetch(`/api/suppliers/${id}`, { method: 'DELETE' })
    setSelectedId(prev => (prev === id ? null : prev))
    fetchSuppliers()
  }

  return (
    <>
      {/* Desktop: split panel */}
      <div className="hidden sm:flex h-[calc(100vh-64px)] overflow-hidden">
        <SupplierList
          suppliers={suppliers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAdd={() => setShowAdd(true)}
        />
        {selectedId ? (
          <SupplierDetail
            key={selectedId}
            supplierId={selectedId}
            supplier={selectedSupplier}
            onEdit={setEditSupplier}
            onDelete={handleDelete}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
            Select a supplier to view details
          </div>
        )}
      </div>

      {/* Mobile: full-width list only (detail navigates to /suppliers/[id]) */}
      <div className="sm:hidden flex flex-col h-[calc(100vh-64px)]">
        <div className="px-4 pt-3 pb-2 shrink-0 flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">Suppliers</h1>
          <button
            onClick={() => setShowAdd(true)}
            className="bg-blue-600 text-white rounded-lg px-3 py-1.5 text-sm font-semibold hover:bg-blue-700"
          >
            + Add
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {suppliers
            .sort((a, b) => b.monthSpend - a.monthSpend)
            .map(s => {
              const pct = s.prevMonthSpend === 0 ? null
                : Math.round(((s.monthSpend - s.prevMonthSpend) / s.prevMonthSpend) * 100)
              const pctColor = pct === null ? 'text-gray-400'
                : pct >= 15 ? 'text-red-500' : pct > 0 ? 'text-green-600' : 'text-gray-500'
              return (
                <Link
                  key={s.id}
                  href={`/suppliers/${s.id}`}
                  className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 bg-white hover:bg-gray-50"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{s.name}</p>
                    <p className={`text-xs mt-0.5 ${pctColor}`}>
                      {s.monthSpend === 0 ? '$0 this month'
                        : `$${s.monthSpend.toLocaleString()} this month${pct !== null ? ` · ${pct >= 0 ? '↑' : '↓'}${Math.abs(pct)}%` : ''}`}
                    </p>
                    <p className="text-xs text-gray-400">{s._count.inventory} items · {s.invoiceCount} invoices</p>
                  </div>
                  <span className="text-gray-300 text-lg">›</span>
                </Link>
              )
            })}
        </div>
      </div>

      {/* Add modal */}
      {showAdd && (
        <SupplierFormModal supplier={null} onClose={() => setShowAdd(false)} onSaved={fetchSuppliers} />
      )}

      {/* Edit modal */}
      {editSupplier && (
        <SupplierFormModal supplier={editSupplier} onClose={() => setEditSupplier(null)} onSaved={fetchSuppliers} />
      )}
    </>
  )
}
```

- [ ] **Step 2: Create the mobile detail page**

```tsx
// src/app/suppliers/[id]/page.tsx
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { SupplierDetail } from '@/components/suppliers/SupplierDetail'
import { SupplierFormModal } from '@/components/suppliers/SupplierFormModal'
import { SupplierSummary } from '@/components/suppliers/types'

export default function SupplierDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [supplier, setSupplier] = useState<SupplierSummary | null>(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    fetch('/api/suppliers')
      .then(r => r.json())
      .then((data: SupplierSummary[]) => {
        setSupplier(data.find(s => s.id === params.id) ?? null)
      })
  }, [params.id])

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this supplier? Inventory items will be unlinked.')) return
    await fetch(`/api/suppliers/${id}`, { method: 'DELETE' })
    router.push('/suppliers')
  }

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* Back button */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 shrink-0 bg-white">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft size={16} /> Suppliers
        </button>
      </div>

      <SupplierDetail
        supplierId={params.id}
        supplier={supplier}
        onEdit={() => setEditing(true)}
        onDelete={handleDelete}
      />

      {editing && supplier && (
        <SupplierFormModal
          supplier={supplier}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            fetch('/api/suppliers')
              .then(r => r.json())
              .then((data: SupplierSummary[]) => setSupplier(data.find(s => s.id === params.id) ?? null))
          }}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/app/suppliers/page.tsx src/app/suppliers/[id]/page.tsx
git commit -m "feat: add suppliers page and mobile detail page"
```

---

## Task 7: Navigation + Redirect

**Files:**
- Modify: `src/components/Navigation.tsx`
- Modify: `src/app/inventory/layout.tsx`
- Modify: `src/app/inventory/suppliers/page.tsx`

- [ ] **Step 1: Add Suppliers to the nav**

In `src/components/Navigation.tsx`:

1. Add `Truck` to the lucide-react import line.

2. In the `navItems` array, add the Suppliers entry after Invoices:
```tsx
{ href: '/invoices',   label: 'Invoices',   icon: FileText },
{ href: '/suppliers',  label: 'Suppliers',  icon: Truck },     // ← add this line
{ href: '/recipes',    label: 'Recipe Book', icon: BookOpen, dividerBefore: true },
```

3. In the `mobileMore` array, add Suppliers after the existing Prep entry:
```tsx
{ href: '/prep',      label: 'Prep',      icon: ChefHat },
{ href: '/suppliers', label: 'Suppliers', icon: Truck },    // ← add this line
{ href: '/recipes',   label: 'Recipes',   icon: BookOpen },
```

- [ ] **Step 2: Remove Suppliers from Inventory sub-nav**

In `src/app/inventory/layout.tsx`, remove the Suppliers tab from the `tabs` array. Also remove the `Truck` import if it becomes unused.

The `tabs` array should become:
```tsx
const tabs = [
  { href: '/inventory',              label: 'Inventory',     icon: Package },
  { href: '/inventory/storage-areas', label: 'Storage Areas', icon: MapPin },
  { href: '/inventory/categories',   label: 'Categories',    icon: Tag },
]
```

- [ ] **Step 3: Replace inventory/suppliers page with redirect**

Replace the entire contents of `src/app/inventory/suppliers/page.tsx` with:

```tsx
import { redirect } from 'next/navigation'

export default function InventorySuppliersRedirect() {
  redirect('/suppliers')
}
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: build succeeds with no type errors

- [ ] **Step 5: Commit**

```bash
git add src/components/Navigation.tsx src/app/inventory/layout.tsx src/app/inventory/suppliers/page.tsx
git commit -m "feat: add Suppliers to nav, remove from Inventory, redirect old route"
```

---

## Self-Review

**Spec coverage:**
- ✅ New `/suppliers` top-level page with split-panel layout → Task 6
- ✅ Supplier contact management (add/edit/delete) → Task 3 + 6
- ✅ Spend KPIs: this month + % change, this year + invoice count, price changes count → Task 5
- ✅ Price change history (last 90 days) → Task 2 intelligence API + Task 5
- ✅ Item catalog with price and unit → Task 2 intelligence API + Task 5
- ✅ Navigation: Suppliers added between Invoices and Recipe Book → Task 7
- ✅ Navigation: Suppliers removed from Inventory sub-nav → Task 7
- ✅ Redirect `/inventory/suppliers` → `/suppliers` → Task 7
- ✅ Mobile: list → tap → `/suppliers/[id]` detail page → Task 6
- ✅ Augmented GET /api/suppliers with monthSpend, prevMonthSpend, invoiceCount → Task 2
- ✅ New GET /api/suppliers/[id]/intelligence → Task 2
- ✅ Supplier list sorted by monthSpend descending → Task 4
- ✅ Blue left-stripe on selected supplier row → Task 4
- ✅ Dark header with contact + ordering info in detail panel → Task 5
- ✅ Error handling: intelligence fetch failure shows loading/error state → Task 5

**Placeholder scan:** No TBDs. All code is complete. ✅

**Type consistency:** `SupplierSummary` defined in Task 1, used in Tasks 3/4/5/6. `SupplierIntelligence` defined in Task 1, consumed in Task 5. `formatCurrency` imported from `@/lib/utils` in Tasks 4 and 5. ✅
