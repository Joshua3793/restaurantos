# Smart Inventory (Par Levels + Barcode/SKU) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-RC par levels with suggested order quantities and a barcode field to inventory items, extending the count-page search to match by barcode.

**Architecture:** Par levels and reorder quantities live on `StockAllocation` (one row per RC per item) so each revenue center has independent thresholds. A new `PATCH /api/stock-allocations` endpoint saves them. The order guide expands to include any item whose stock is below par, not just zero-stock items. The barcode is a single nullable field on `InventoryItem`; the count-page search queries it via `GET /api/inventory/search?barcode=X` on Enter.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL · Tailwind CSS

---

## File Map

| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `barcode String?` to `InventoryItem`; add `parLevel Decimal?` + `reorderQty Decimal?` to `StockAllocation` |
| `src/app/api/stock-allocations/route.ts` | Add `PATCH` handler |
| `src/app/api/inventory/route.ts` | Attach `parLevel`/`reorderQty` to both RC paths |
| `src/app/api/inventory/search/route.ts` | Add `?barcode=X` exact-match branch |
| `src/components/StockStatus.tsx` | Add `parLevel` prop, replace hardcoded `< 3` threshold |
| `src/components/inventory/RcAllocationPanel.tsx` | Add par level inline edit form + below-par indicator |
| `src/app/inventory/page.tsx` | Add `barcode`/`parLevel`/`reorderQty` to `InventoryItem` interface; barcode field in drawer; Low Stock filter pill; order guide expansion |
| `src/components/inventory/InventoryItemDrawer.tsx` | Add barcode field (view + edit) |
| `src/app/count/page.tsx` | Add barcode lookup on Enter in search |

---

## Task 1: Schema Migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add `barcode` to `InventoryItem` and `parLevel`/`reorderQty` to `StockAllocation`**

In `prisma/schema.prisma`, add `barcode` after the `allergens` field (line 87):

```prisma
  allergens          String[]                 @default([])
  barcode            String?
```

Add `parLevel` and `reorderQty` after the `quantity` field in `StockAllocation` (after line 476):

```prisma
model StockAllocation {
  id              String        @id @default(cuid())
  revenueCenterId String
  inventoryItemId String
  quantity        Decimal       @default(0)
  parLevel        Decimal?
  reorderQty      Decimal?
  updatedAt       DateTime      @updatedAt
  inventoryItem   InventoryItem @relation(fields: [inventoryItemId], references: [id], onDelete: Cascade)
  revenueCenter   RevenueCenter @relation(fields: [revenueCenterId], references: [id], onDelete: Cascade)

  @@unique([revenueCenterId, inventoryItemId])
}
```

- [ ] **Step 2: Create and apply the migration**

```bash
npx prisma migrate dev --name smart-inventory-par-levels
```

Expected output: migration created and applied, no errors.

- [ ] **Step 3: Regenerate Prisma client**

```bash
npx prisma generate
```

Expected: `Generated Prisma Client`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add barcode to InventoryItem, parLevel/reorderQty to StockAllocation"
```

---

## Task 2: PATCH /api/stock-allocations — Par Level Upsert

**Files:**
- Modify: `src/app/api/stock-allocations/route.ts`

- [ ] **Step 1: Add PATCH handler to the end of the file**

```typescript
// PATCH /api/stock-allocations — upsert parLevel/reorderQty for one RC+item pair
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { inventoryItemId, rcId, parLevel, reorderQty } = body

  if (!inventoryItemId || !rcId) {
    return NextResponse.json({ error: 'inventoryItemId and rcId are required' }, { status: 400 })
  }
  if (parLevel !== null && parLevel !== undefined && Number(parLevel) < 0) {
    return NextResponse.json({ error: 'parLevel must be >= 0' }, { status: 400 })
  }
  if (reorderQty !== null && reorderQty !== undefined && Number(reorderQty) <= 0) {
    return NextResponse.json({ error: 'reorderQty must be > 0' }, { status: 400 })
  }

  const allocation = await prisma.stockAllocation.upsert({
    where: { revenueCenterId_inventoryItemId: { revenueCenterId: rcId, inventoryItemId } },
    update: {
      ...(parLevel !== undefined  ? { parLevel:  parLevel  === null ? null : Number(parLevel)  } : {}),
      ...(reorderQty !== undefined ? { reorderQty: reorderQty === null ? null : Number(reorderQty) } : {}),
    },
    create: {
      revenueCenterId: rcId,
      inventoryItemId,
      quantity: 0,
      parLevel:  parLevel  ?? null,
      reorderQty: reorderQty ?? null,
    },
  })

  return NextResponse.json(allocation)
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build 2>&1 | grep -E "error|Error" | head -20
```

Expected: no TypeScript errors in this file.

- [ ] **Step 3: Manual smoke test**

```bash
curl -X PATCH http://localhost:3000/api/stock-allocations \
  -H 'Content-Type: application/json' \
  -d '{"inventoryItemId":"<any-valid-id>","rcId":"<any-valid-rc-id>","parLevel":10,"reorderQty":null}'
```

Expected: JSON response with the upserted allocation row including `parLevel: "10"`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/stock-allocations/route.ts
git commit -m "feat: PATCH /api/stock-allocations to upsert par level and reorder qty"
```

---

## Task 3: GET /api/inventory — Attach parLevel/reorderQty

**Files:**
- Modify: `src/app/api/inventory/route.ts`

The GET handler has three branches: non-default RC, default RC, and all RCs. We need to attach `parLevel` and `reorderQty` to the first two (the "all RCs" branch is only used for aggregate reporting and doesn't need par levels).

Par levels are stored in `countUOM` (same units as `StockAllocation.quantity`). The API returns them as numbers or null.

- [ ] **Step 1: Update the non-default RC branch (around line 40)**

Replace:
```typescript
const items = allocations
  .map(a => ({ ...a.inventoryItem, rcStock: Number(a.quantity) }))
```

With:
```typescript
const items = allocations
  .map(a => ({
    ...a.inventoryItem,
    rcStock:    Number(a.quantity),
    parLevel:   a.parLevel   !== null ? Number(a.parLevel)   : null,
    reorderQty: a.reorderQty !== null ? Number(a.reorderQty) : null,
  }))
```

- [ ] **Step 2: Update the default RC branch to join StockAllocation**

Replace the entire `if (rcId && isDefault)` block:

```typescript
// Default RC (Cafe): stockOnHand IS Cafe's pool – return as-is
if (rcId && isDefault) {
  const [items, allocations] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: itemWhere,
      include: itemInclude,
      orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
    }),
    prisma.stockAllocation.findMany({
      where: { revenueCenterId: rcId },
      select: { inventoryItemId: true, parLevel: true, reorderQty: true },
    }),
  ])
  const allocByItemId = Object.fromEntries(allocations.map(a => [a.inventoryItemId, a]))
  const result = items.map(i => ({
    ...i,
    parLevel:   allocByItemId[i.id]?.parLevel   !== null && allocByItemId[i.id]?.parLevel   !== undefined ? Number(allocByItemId[i.id].parLevel)   : null,
    reorderQty: allocByItemId[i.id]?.reorderQty !== null && allocByItemId[i.id]?.reorderQty !== undefined ? Number(allocByItemId[i.id].reorderQty) : null,
  }))
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
```

- [ ] **Step 3: Build check**

```bash
npm run build 2>&1 | grep -E "error|Error" | head -20
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/inventory/route.ts
git commit -m "feat: attach parLevel and reorderQty to GET /api/inventory RC paths"
```

---

## Task 4: GET /api/inventory/search — Barcode Exact Match

**Files:**
- Modify: `src/app/api/inventory/search/route.ts`

- [ ] **Step 1: Add barcode branch at the top of the GET handler**

Replace the current GET handler:

```typescript
export async function GET(req: NextRequest) {
  const q       = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  const barcode = req.nextUrl.searchParams.get('barcode')?.trim() ?? ''
  const limit   = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '10'), 50)

  // Barcode exact match — used by count-page scanner
  if (barcode) {
    const item = await prisma.inventoryItem.findFirst({
      where: { barcode, isActive: true },
      select: {
        id: true,
        itemName: true,
        purchaseUnit: true,
        purchasePrice: true,
        pricePerBaseUnit: true,
        baseUnit: true,
        category: true,
        qtyPerPurchaseUnit: true,
        packSize: true,
        packUOM: true,
        barcode: true,
      },
    })
    return NextResponse.json(item ? [item] : [])
  }

  const words = q.split(/\s+/).filter(w => w.length > 1)

  const items = await prisma.inventoryItem.findMany({
    where: {
      isActive: true,
      OR: q
        ? [
            { itemName: { contains: q, mode: 'insensitive' as const } },
            ...words.map(word => ({ itemName: { contains: word, mode: 'insensitive' as const } })),
          ]
        : undefined,
    },
    select: {
      id: true,
      itemName: true,
      purchaseUnit: true,
      purchasePrice: true,
      pricePerBaseUnit: true,
      baseUnit: true,
      category: true,
      qtyPerPurchaseUnit: true,
      packSize: true,
      packUOM: true,
    },
    orderBy: { itemName: 'asc' },
    take: Math.min(limit * 5, 100),
  })

  if (!q) return NextResponse.json(items.slice(0, limit))

  const scored = items
    .map(item => ({ ...item, _score: fuzzyScore(q, item.itemName) }))
    .filter(i => i._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...rest }) => rest)

  return NextResponse.json(scored)
}
```

- [ ] **Step 2: Build check**

```bash
npm run build 2>&1 | grep -E "error|Error" | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/inventory/search/route.ts
git commit -m "feat: GET /api/inventory/search?barcode=X exact match"
```

---

## Task 5: StockStatus Component — parLevel-Aware Badge

**Files:**
- Modify: `src/components/StockStatus.tsx`

The current component shows "Low Stock" when `stock < 3` (hardcoded). Replace with `parLevel` awareness.

- [ ] **Step 1: Rewrite the component**

```typescript
'use client'

export function StockStatus({ stock, parLevel }: { stock: number; parLevel?: number | null }) {
  if (stock <= 0) return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
      Out of Stock
    </span>
  )
  if (parLevel != null && stock < parLevel) return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
      Low Stock
    </span>
  )
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
      In Stock
    </span>
  )
}
```

The `parLevel` prop is optional — existing callers that omit it will never show "Low Stock" (same as before, except the hardcoded `< 3` threshold is removed). This is the correct behaviour: "Low Stock" only fires when a par level has actually been configured.

- [ ] **Step 2: Build check — ensure no existing call sites break**

```bash
npm run build 2>&1 | grep -E "StockStatus|error" | head -20
```

All existing `<StockStatus stock={...} />` calls remain valid (new prop is optional). Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/StockStatus.tsx
git commit -m "feat: StockStatus respects parLevel prop instead of hardcoded threshold"
```

---

## Task 6: RcAllocationPanel — Inline Par Level Editing + Below-Par Indicator

**Files:**
- Modify: `src/components/inventory/RcAllocationPanel.tsx`

- [ ] **Step 1: Update the `Allocation` interface and add par-edit state**

Replace the top of the file up to and including the `Props` interface:

```typescript
'use client'
import { useState, useEffect, useCallback } from 'react'
import { ArrowRight, ChevronDown, ChevronUp, Pencil, X, Check } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

interface Allocation {
  revenueCenterId: string
  quantity: number
  parLevel:   number | null
  reorderQty: number | null
  revenueCenter: { id: string; name: string; color: string }
}

interface Transfer {
  id: string
  fromRc: { name: string; color: string }
  toRc:   { name: string; color: string }
  quantity: number
  notes: string | null
  createdAt: string
}

interface Props {
  itemId:       string
  stockOnHand:  number
  countUOM:     string
  defaultRcId:  string | null
  onPulled:     () => void
}
```

- [ ] **Step 2: Add par-edit state inside the component body, after the existing state declarations**

```typescript
  const [editParRcId,    setEditParRcId]    = useState<string | null>(null)
  const [editParLevel,   setEditParLevel]   = useState('')
  const [editReorderQty, setEditReorderQty] = useState('')
  const [savingPar,      setSavingPar]      = useState(false)
  const [parError,       setParError]       = useState('')
```

- [ ] **Step 3: Add the `handleSavePar` function after `handlePull`**

```typescript
  const handleSavePar = async (rcId: string) => {
    setSavingPar(true)
    setParError('')
    const res = await fetch('/api/stock-allocations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inventoryItemId: itemId,
        rcId,
        parLevel:   editParLevel   === '' ? null : Number(editParLevel),
        reorderQty: editReorderQty === '' ? null : Number(editReorderQty),
      }),
    })
    setSavingPar(false)
    if (!res.ok) {
      const d = await res.json()
      setParError(d.error || 'Save failed')
      return
    }
    setEditParRcId(null)
    setEditParLevel('')
    setEditReorderQty('')
    setParError('')
    loadData()
  }

  const openParEdit = (rc: { id: string }, alloc: Allocation | undefined) => {
    setEditParRcId(rc.id)
    setEditParLevel(alloc?.parLevel != null ? String(alloc.parLevel) : '')
    setEditReorderQty(alloc?.reorderQty != null ? String(alloc.reorderQty) : '')
    setParError('')
  }
```

- [ ] **Step 4: Replace the per-RC row JSX**

Replace the existing `{revenueCenters.map(rc => { ... })}` block with:

```tsx
        {revenueCenters.map(rc => {
          const isDefaultRc   = rc.id === defaultRcId
          const alloc         = allocations.find(a => a.revenueCenterId === rc.id)
          const qty           = isDefaultRc ? stockOnHand : (alloc ? Number(alloc.quantity) : 0)
          const parLevel      = alloc?.parLevel ?? null
          const isBelowPar    = parLevel !== null && qty < parLevel
          const isEditingPar  = editParRcId === rc.id
          const isPulling     = pullRcId === rc.id
          const suggested     = parLevel !== null && isBelowPar ? parLevel - qty : null

          return (
            <div
              key={rc.id}
              className={`px-4 py-3 border-l-2 transition-colors ${isBelowPar ? 'border-amber-400 bg-amber-50/40' : 'border-transparent'}`}
            >
              {/* RC header row */}
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
                <span className={`flex-1 text-sm ${isDefaultRc ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>
                  {rc.name}
                  {isDefaultRc && <span className="text-xs text-gray-400 font-normal ml-1">main pool</span>}
                </span>
                <span className="text-sm font-medium text-gray-700">
                  {qty.toFixed(2)} <span className="text-xs text-gray-400">{countUOM}</span>
                  {parLevel !== null && (
                    <span className={`ml-1 text-xs ${isBelowPar ? 'text-amber-600' : 'text-gray-400'}`}>
                      / par {parLevel}
                    </span>
                  )}
                </span>
                {isBelowPar && (
                  <span className="text-xs font-semibold bg-amber-100 text-amber-700 rounded-full px-2 py-0.5 shrink-0">
                    ⚠ Below Par
                  </span>
                )}
                <button
                  onClick={() => isEditingPar ? setEditParRcId(null) : openParEdit(rc, alloc)}
                  className="text-xs text-gray-400 hover:text-gray-600 shrink-0 p-1"
                  title={isEditingPar ? 'Cancel' : 'Edit par level'}
                >
                  {isEditingPar ? <X size={12} /> : <Pencil size={12} />}
                </button>
                {!isDefaultRc && (
                  <button
                    onClick={() => { setPullRcId(isPulling ? null : rc.id); setPullQty(''); setPullNotes(''); setPullError('') }}
                    className={`text-xs font-medium flex items-center gap-1 px-2.5 py-1 rounded-lg transition-colors ${
                      isPulling
                        ? 'bg-gold/15 text-gold border border-gold/30'
                        : 'bg-gold/10 text-gold hover:bg-gold/15 border border-blue-100'
                    }`}
                  >
                    Pull <ArrowRight size={11} />
                  </button>
                )}
              </div>

              {/* Below-par suggestion */}
              {isBelowPar && suggested !== null && !isEditingPar && (
                <div className="mt-1.5 ml-4 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                  📦 Suggested order: <strong>{suggested.toFixed(2)} {countUOM}</strong> (par − current)
                </div>
              )}

              {/* Par edit form */}
              {isEditingPar && (
                <div className="mt-2 ml-4 space-y-2">
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="text-xs text-gray-500 block mb-0.5">Par Level ({countUOM})</label>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={editParLevel}
                        onChange={e => setEditParLevel(e.target.value)}
                        placeholder="e.g. 10"
                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-gray-500 block mb-0.5">Order Qty (auto)</label>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={editReorderQty}
                        onChange={e => setEditReorderQty(e.target.value)}
                        placeholder="auto"
                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                      />
                    </div>
                  </div>
                  {parError && <p className="text-xs text-red-500">{parError}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSavePar(rc.id)}
                      disabled={savingPar}
                      className="flex items-center gap-1 px-3 py-1.5 bg-gold text-white rounded-lg text-xs font-medium hover:bg-[#a88930] disabled:opacity-50"
                    >
                      <Check size={11} /> {savingPar ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditParRcId(null)}
                      className="px-3 py-1.5 text-gray-500 border border-gray-200 rounded-lg text-xs hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Pull form */}
              {isPulling && (
                <div className="mt-3 pl-4 space-y-2">
                  <div className="text-xs text-gray-500">
                    Available: <span className="font-medium text-gray-700">{stockOnHand.toFixed(2)} {countUOM}</span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={pullQty}
                      onChange={e => setPullQty(e.target.value)}
                      placeholder="Quantity"
                      className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                    />
                    <div className="flex items-center justify-center px-2.5 bg-gray-100 rounded-lg text-sm text-gray-600 font-medium shrink-0">
                      {countUOM}
                    </div>
                    <button
                      onClick={() => handlePull(rc.id)}
                      disabled={pulling || !pullQty}
                      className="px-3 py-1.5 bg-gold text-white rounded-lg text-sm font-medium hover:bg-[#a88930] disabled:opacity-50"
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
```

- [ ] **Step 5: Build check**

```bash
npm run build 2>&1 | grep -E "error|Error" | head -20
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/inventory/RcAllocationPanel.tsx
git commit -m "feat: RcAllocationPanel inline par level editing and below-par indicator"
```

---

## Task 7: Inventory Page — Interface, Barcode Field, Low Stock Pill, Order Guide

**Files:**
- Modify: `src/app/inventory/page.tsx`

This task covers four small changes to the same file.

### 7a: Update InventoryItem interface

- [ ] **Step 1: Add fields to the `InventoryItem` interface (around line 21)**

Add three new optional fields after the `rcStock` line:

```typescript
interface InventoryItem {
  id: string; itemName: string; category: string
  supplier?: Supplier | null;    supplierId?: string | null
  storageArea?: StorageArea | null; storageAreaId?: string | null
  purchaseUnit: string; qtyPerPurchaseUnit: number
  purchasePrice: number; baseUnit: string
  packSize: number; packUOM: string; countUOM: string
  conversionFactor: number; pricePerBaseUnit: number
  stockOnHand: number
  rcStock?: number        // set when viewing a non-default RC (from StockAllocation)
  parLevel?:   number | null  // in countUOM; null = no par set
  reorderQty?: number | null  // in purchaseUnit; null = auto-calculate
  barcode?:    string | null
  allergens?: string[]
  isActive: boolean
  lastCountDate?: string | null; lastCountQty?: number | null
  recipe?: { id: string; name: string } | null
}
```

- [ ] **Step 2: Update the `StockStatus` call in view mode to pass `parLevel`**

Find line 1557 (the view-mode `StockStatus` call inside the drawer):

```tsx
<StockStatus stock={displayStock(selected)} />
```

Replace with:

```tsx
<StockStatus stock={displayStock(selected)} parLevel={selected.parLevel ?? null} />
```

Find line 563 (the list-row `StockStatus` call):

```tsx
<StockStatus stock={displayStock(item)} />
```

Replace with:

```tsx
<StockStatus stock={displayStock(item)} parLevel={item.parLevel ?? null} />
```

### 7b: Add "Low Stock" filter pill

- [ ] **Step 3: Add `'lowStock'` to the `FilterPill` type (line 40)**

```typescript
type FilterPill = 'all' | 'counted' | 'notCounted' | 'highValue' | 'outOfStock' | 'lowStock' | 'active' | 'inactive'
```

- [ ] **Step 4: Add the filter case in `pillFiltered` (around line 327)**

After the `'outOfStock'` case, add:

```typescript
case 'lowStock':   return items.filter(i => i.parLevel != null && displayStock(i) > 0 && displayStock(i) < i.parLevel)
```

- [ ] **Step 5: Add the pill to the `pills` array (around line 653-660)**

Insert after the `'outOfStock'` pill:

```typescript
{ key: 'lowStock', label: 'Low Stock' },
```

### 7c: Add barcode field in the drawer

The view-mode info grid (around line 1575) shows rows of `[label, value]` pairs. We need to add a barcode row (only when barcode is set) and a barcode input in edit mode.

- [ ] **Step 6: Add barcode to the view-mode info grid**

In the non-recipe rows array (around line 1575), add a barcode row at the end **only when it has a value**. The rows array is built like:

```typescript
const rows: [string, string][] = selected.recipe ? [ ... ] : [
  ['Supplier',       selected.supplier?.name || '—'],
  ['Storage Area',   selected.storageArea?.name || '—'],
  ['Purchase Unit',  selected.purchaseUnit],
  ['Qty per Case',   parseFloat(String(selected.qtyPerPurchaseUnit)).toFixed(0)],
  ['Purchase Price', formatCurrency(parseFloat(String(selected.purchasePrice)))],
  ['Pack Size',      `${parseFloat(String(selected.packSize ?? 1))} ${selected.packUOM ?? 'each'}`],
  ['Count UOM',      selected.countUOM ?? 'each'],
]
```

Add after the `['Count UOM', ...]` line in the **non-recipe** branch:

```typescript
  ...(selected.barcode ? [['Barcode', selected.barcode] as [string, string]] : []),
```

- [ ] **Step 7: Find the edit mode form and add a barcode field**

Search for the edit form's `Count UOM` field (it will be a select or input labeled `countUOM`). Find the closest pattern — something like:

```tsx
<label>Count UOM ...
```

After that field, add:

```tsx
<div>
  <label className="block text-xs font-medium text-gray-600 mb-1">Barcode</label>
  <input
    type="text"
    value={form.barcode ?? ''}
    onChange={e => setForm(f => ({ ...f, barcode: e.target.value || null }))}
    placeholder="Scan or type barcode…"
    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
  />
</div>
```

Also add `barcode` to the `EditForm` interface (around line 42):

```typescript
interface EditForm {
  itemName: string; category: string
  supplierId: string; supplierName: string
  storageAreaId: string; storageAreaName: string
  purchaseUnit: string; qtyPerPurchaseUnit: string
  purchasePrice: string
  packSize: string; packUOM: string; countUOM: string
  stockOnHand: string
  isActive: boolean
  allergens: string[]
  barcode: string | null
}
```

And initialise it in `defaultForm` (around line 71):

```typescript
const defaultForm = {
  itemName: '', category: '', supplierId: '', storageAreaId: '',
  purchaseUnit: 'case', qtyPerPurchaseUnit: '1', purchasePrice: '0',
  packSize: '1', packUOM: 'each', countUOM: 'each',
  baseUnit: 'g', stockOnHand: '0',
  location: '', allergens: [] as string[],
  barcode: null as string | null,
}
```

And include `barcode` when opening the edit form from a selected item. Search for the function that populates the form from `selected` (look for a `setForm` call that sets `itemName: selected.itemName`) and add:

```typescript
barcode: selected.barcode ?? null,
```

### 7d: Expand the Order Guide

- [ ] **Step 8: Replace the order guide logic (around line 1080)**

Find the order guide IIFE. Replace the `outOfStock` computation and the display:

```tsx
{showOrderList && (() => {
  const activeItems = items.filter(i => i.isActive && i.category !== 'PREPD')
  const orderItems  = activeItems.filter(i =>
    displayStock(i) <= 0 ||
    (i.parLevel != null && displayStock(i) < i.parLevel)
  )

  type OrderTab = 'all' | 'belowPar' | 'outOfStock'
  // Note: orderTab state must be added to component state (see Step 9)

  const belowPar   = orderItems.filter(i => i.parLevel != null && displayStock(i) > 0 && displayStock(i) < i.parLevel)
  const outOfStock = orderItems.filter(i => displayStock(i) <= 0)

  const suggestedQty = (item: InventoryItem): string => {
    if (item.reorderQty != null) return String(item.reorderQty)
    if (item.parLevel != null && item.parLevel > displayStock(item)) {
      const needed = item.parLevel - displayStock(item)
      return String(Math.ceil(needed / Number(item.qtyPerPurchaseUnit)))
    }
    return ''
  }

  const tabItems = orderTab === 'belowPar' ? belowPar
    : orderTab === 'outOfStock' ? outOfStock
    : orderItems

  const bySupplier = new Map<string, { supplierName: string; items: InventoryItem[] }>()
  for (const item of tabItems) {
    const key  = item.supplierId ?? '__none__'
    const name = item.supplier?.name ?? 'No Supplier'
    if (!bySupplier.has(key)) bySupplier.set(key, { supplierName: name, items: [] })
    bySupplier.get(key)!.items.push(item)
  }
  const copyText = Array.from(bySupplier.values()).map(({ supplierName, items: grp }) =>
    `${supplierName}:\n` + grp.map(i => `  - ${i.itemName}  ${orderQtys[i.id] ?? suggestedQty(i)}  ${i.purchaseUnit}  @${formatCurrency(parseFloat(String(i.purchasePrice)))}`).join('\n')
  ).join('\n\n')

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-xl rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2">
            <ShoppingCart size={18} className="text-green-600" />
            <h2 className="font-semibold text-gray-900">Order Guide</h2>
            <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">{orderItems.length} items</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => { navigator.clipboard.writeText(copyText) }}
              className="flex items-center gap-1.5 text-xs border border-gray-200 px-2.5 py-1.5 rounded-lg text-gray-600 hover:bg-gray-50">
              <Copy size={12} /> Copy
            </button>
            <button onClick={() => setShowOrderList(false)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={18} /></button>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1.5 px-4 py-2 border-b border-gray-100 bg-gray-50 shrink-0">
          {([
            { key: 'all',        label: `All (${orderItems.length})` },
            { key: 'belowPar',  label: `⚠ Below Par (${belowPar.length})` },
            { key: 'outOfStock', label: `Out of Stock (${outOfStock.length})` },
          ] as { key: OrderTab; label: string }[]).map(t => (
            <button
              key={t.key}
              onClick={() => setOrderTab(t.key)}
              className={`text-xs font-semibold px-3 py-1 rounded-full transition-colors ${
                orderTab === t.key
                  ? 'bg-gray-900 text-white'
                  : t.key === 'belowPar'
                    ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                    : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto flex-1 p-4 space-y-4">
          {tabItems.length === 0 ? (
            <div className="text-center py-12 text-gray-400 text-sm">No items in this category</div>
          ) : (
            Array.from(bySupplier.values()).map(({ supplierName, items: grp }) => (
              <div key={supplierName}>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{supplierName}</div>
                <div className="space-y-1">
                  {grp.map(item => {
                    const isOut = displayStock(item) <= 0
                    return (
                      <div key={item.id} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <div className="text-sm font-medium text-gray-800 truncate">{item.itemName}</div>
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${
                              isOut ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                            }`}>
                              {isOut ? 'Out' : 'Low'}
                            </span>
                          </div>
                          {item.parLevel != null && (
                            <div className="text-xs text-gray-400">
                              Par {item.parLevel} {item.countUOM} · Have {displayStock(item).toFixed(1)}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <input type="number" min="1" step="1"
                            value={orderQtys[item.id] ?? suggestedQty(item)}
                            onChange={e => setOrderQtys(q => ({ ...q, [item.id]: e.target.value }))}
                            placeholder="qty"
                            className="w-14 border border-gray-200 rounded-lg px-2 py-1 text-sm text-center text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-400" />
                          <span className="text-xs text-gray-500">{item.purchaseUnit}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
})()}
```

- [ ] **Step 9: Add `orderTab` state to the component state declarations (around line 201)**

```typescript
const [orderTab, setOrderTab] = useState<'all' | 'belowPar' | 'outOfStock'>('all')
```

Also reset it when opening the order list (find the two `setShowOrderList(true)` calls, around lines 672 and 701):

```typescript
onClick={() => { setShowOrderList(true); setOrderQtys({}); setOrderTab('all') }}
```

- [ ] **Step 10: Build check**

```bash
npm run build 2>&1 | grep -E "error|Error" | head -30
```

Expected: no TypeScript errors.

- [ ] **Step 11: Commit**

```bash
git add src/app/inventory/page.tsx
git commit -m "feat: inventory page parLevel/barcode interface, Low Stock pill, expanded order guide"
```

---

## Task 8: InventoryItemDrawer.tsx — Barcode Field

**Files:**
- Modify: `src/components/inventory/InventoryItemDrawer.tsx`

This drawer is used by the count page (`/count`).

- [ ] **Step 1: Find the `InventoryItem` interface in the drawer file and add `barcode`**

Search for the interface or type that describes the item in this file. Add:

```typescript
barcode?: string | null
```

- [ ] **Step 2: Add barcode in view mode**

Find where the drawer renders item info in view mode (look for a grid of label/value pairs). After the Count UOM row, add:

```tsx
{item.barcode && (
  <div className="bg-gray-50 rounded-lg p-3">
    <div className="text-xs text-gray-500">Barcode</div>
    <div className="font-medium text-gray-800 mt-0.5 font-mono text-sm">{item.barcode}</div>
  </div>
)}
```

- [ ] **Step 3: Add barcode in edit mode**

Find the edit form in the drawer. After the Count UOM field, add:

```tsx
<div>
  <label className="block text-xs font-medium text-gray-600 mb-1">Barcode</label>
  <input
    type="text"
    value={form.barcode ?? ''}
    onChange={e => setForm(f => ({ ...f, barcode: e.target.value || null }))}
    placeholder="Scan or type barcode…"
    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
  />
</div>
```

Also add `barcode: string | null` to the edit form state interface/type in this file, and initialise it from `item.barcode ?? null` when the edit form is opened.

- [ ] **Step 4: Build check**

```bash
npm run build 2>&1 | grep -E "error|Error" | head -20
```

- [ ] **Step 5: Commit**

```bash
git add src/components/inventory/InventoryItemDrawer.tsx
git commit -m "feat: barcode field in InventoryItemDrawer view and edit modes"
```

---

## Task 9: Count Page — Barcode Lookup on Enter

**Files:**
- Modify: `src/app/count/page.tsx`

The count page has a text search input (line 1628) that filters items locally. When the user presses Enter, we try a barcode lookup first. If a matching item is found in the active session's lines, we scroll to it and clear the search. If not, we leave the text search active.

- [ ] **Step 1: Add the `handleBarcodeSearch` callback in the component (after the existing hooks, before the return)**

```typescript
const handleBarcodeSearch = useCallback(async (query: string): Promise<boolean> => {
  if (!query.trim()) return false
  try {
    const res = await fetch(`/api/inventory/search?barcode=${encodeURIComponent(query.trim())}`)
    const results: { id: string }[] = await res.json()
    if (results.length !== 1) return false
    const matchedItemId = results[0].id
    const matchedLine = active?.lines.find(l => l.inventoryItem.id === matchedItemId)
    if (!matchedLine) return false
    setSearchQuery('')
    const prefix = window.innerWidth < 640 ? 'm-' : 'd-'
    const ref = cardRefs.current[`${prefix}${matchedLine.id}`]
    if (ref) ref.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return true
  } catch {
    return false
  }
}, [active?.lines, cardRefs])
```

- [ ] **Step 2: Add `onKeyDown` handler to the search input (around line 1629)**

Find the search `<input>` element (around line 1625). Add an `onKeyDown` prop:

```tsx
onKeyDown={async (e) => {
  if (e.key === 'Enter') {
    await handleBarcodeSearch(searchQuery)
  }
}}
```

- [ ] **Step 3: Build check**

```bash
npm run build 2>&1 | grep -E "error|Error" | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/app/count/page.tsx
git commit -m "feat: count page barcode lookup on Enter in search bar"
```

---

## Task 10: Full Build Verification

- [ ] **Step 1: Clean build**

```bash
npm run build
```

Expected: exits with code 0 (`✓ Compiled successfully`). Fix any TypeScript errors before committing.

- [ ] **Step 2: Start dev server and verify key flows**

```bash
npm run dev
```

Manual checks:
1. Open `/inventory` → filter pill row should include "Low Stock"
2. Open any item drawer → "Edit" mode should show Barcode field below Count UOM
3. Open an item drawer → RC Allocation Panel shows Pencil icon → click it → Par Level + Order Qty inputs appear → save → row shows `par X` and amber badge if below par
4. Open Order Guide → filter tabs "All / ⚠ Below Par / Out of Stock" appear
5. Open `/count` → type a known barcode in search → press Enter → page scrolls to that item

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: smart inventory implementation complete — par levels, barcode, order guide"
```
