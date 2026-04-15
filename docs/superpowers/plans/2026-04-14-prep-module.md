# Prep Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daily kitchen production board (`/prep`) that tracks prep items by urgency (911 / Needed Today / Low Stock / Later), integrates with existing recipes and inventory, and applies an atomic inventory transaction when prep is marked complete.

**Architecture:** Two new Prisma models (`PrepItem`, `PrepLog`) link loosely to existing `Recipe` and `InventoryItem`. Priority and stock are computed at query time. Marking a prep log Done/Partial triggers a `prisma.$transaction` that deducts ingredients and credits the recipe output — all in one atomic write.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma ORM, PostgreSQL, Tailwind CSS, Lucide React

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add `PrepItem`, `PrepLog`; add back-relations on `Recipe` + `InventoryItem` |
| `src/lib/prep-utils.ts` | Create | Priority logic, suggested qty, scale factor computation |
| `src/components/prep/types.ts` | Create | Shared TypeScript interfaces used across page + components |
| `src/app/api/prep/items/route.ts` | Create | GET list + POST create |
| `src/app/api/prep/items/[id]/route.ts` | Create | GET detail + PUT update + DELETE soft-delete |
| `src/app/api/prep/generate/route.ts` | Create | POST — generate today's PrepLog rows for all active items |
| `src/app/api/prep/logs/route.ts` | Create | GET logs by date + POST upsert |
| `src/app/api/prep/logs/[id]/route.ts` | Create | PUT update status/qty — triggers inventory transaction |
| `src/app/api/prep/logs/[id]/revert/route.ts` | Create | POST — reverse + reapply inventory adjustment |
| `src/components/prep/PrepKpiStrip.tsx` | Create | 6 summary KPI cards |
| `src/components/prep/PrepItemRow.tsx` | Create | Single row in priority list |
| `src/components/prep/PrepItemForm.tsx` | Create | Add / Edit modal form |
| `src/components/prep/PrepDetailPanel.tsx` | Create | Right-side detail drawer with status actions + inventory impact |
| `src/app/prep/page.tsx` | Create | Main page — state, data fetching, layout, priority sections |
| `src/components/Navigation.tsx` | Modify | Add Prep link to desktop sidebar + mobile More drawer |

---

## Task 1: Prisma Schema

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add PrepItem and PrepLog models + back-relations**

Open `prisma/schema.prisma`. At the very end of the file, append the two new models:

```prisma
model PrepItem {
  id                     String         @id @default(uuid())
  name                   String
  linkedRecipeId         String?
  linkedRecipe           Recipe?        @relation("PrepItemRecipe", fields: [linkedRecipeId], references: [id])
  linkedInventoryItemId  String?
  linkedInventoryItem    InventoryItem? @relation("PrepItemInventory", fields: [linkedInventoryItemId], references: [id])
  category               String         @default("MISC")
  station                String?
  parLevel               Decimal        @default(0)
  unit                   String         @default("batch")
  minThreshold           Decimal        @default(0)
  targetToday            Decimal?
  shelfLifeDays          Int?
  notes                  String?
  manualPriorityOverride String?
  isActive               Boolean        @default(true)
  createdAt              DateTime       @default(now())
  updatedAt              DateTime       @updatedAt
  logs                   PrepLog[]
}

model PrepLog {
  id                String   @id @default(uuid())
  prepItemId        String
  prepItem          PrepItem @relation(fields: [prepItemId], references: [id], onDelete: Cascade)
  logDate           DateTime
  status            String   @default("NOT_STARTED")
  requiredQty       Decimal?
  actualPrepQty     Decimal?
  assignedTo        String?
  dueTime           String?
  note              String?
  blockedReason     String?
  inventoryAdjusted Boolean  @default(false)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([prepItemId, logDate])
}
```

Also add back-relations to the existing models. Find the `Recipe` model and add this line inside it (after the last relation line):

```prisma
  prepItems  PrepItem[]  @relation("PrepItemRecipe")
```

Find the `InventoryItem` model and add this line inside it (after `priceAlerts` relation):

```prisma
  prepItems  PrepItem[]  @relation("PrepItemInventory")
```

- [ ] **Step 2: Push schema to database**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
npx prisma db push
```

Expected output: `Your database is now in sync with your Prisma schema.`

- [ ] **Step 3: Regenerate Prisma client**

```bash
npx prisma generate
```

Expected: `Generated Prisma Client`

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add PrepItem and PrepLog models to schema"
```

---

## Task 2: Shared Utilities and Types

**Files:**
- Create: `src/lib/prep-utils.ts`
- Create: `src/components/prep/types.ts`

- [ ] **Step 1: Create `src/lib/prep-utils.ts`**

```typescript
export type PrepPriority = '911' | 'NEEDED_TODAY' | 'LOW_STOCK' | 'LATER'

export const PREP_PRIORITY_ORDER: PrepPriority[] = ['911', 'NEEDED_TODAY', 'LOW_STOCK', 'LATER']

export const PREP_PRIORITY_META: Record<PrepPriority, {
  label: string
  badgeClass: string
  borderClass: string
  bgClass: string
  headingClass: string
  emoji: string
}> = {
  '911': {
    label: '911',
    emoji: '🔴',
    badgeClass: 'bg-red-100 text-red-700 font-bold',
    borderClass: 'border-l-4 border-red-500',
    bgClass: 'bg-red-50',
    headingClass: 'text-red-700',
  },
  'NEEDED_TODAY': {
    label: 'Needed Today',
    emoji: '🟠',
    badgeClass: 'bg-orange-100 text-orange-700',
    borderClass: 'border-l-4 border-orange-400',
    bgClass: 'bg-orange-50',
    headingClass: 'text-orange-700',
  },
  'LOW_STOCK': {
    label: 'Low Stock',
    emoji: '🟡',
    badgeClass: 'bg-amber-100 text-amber-700',
    borderClass: 'border-l-4 border-amber-400',
    bgClass: 'bg-amber-50',
    headingClass: 'text-amber-700',
  },
  'LATER': {
    label: 'Optional / Later',
    emoji: '⚪',
    badgeClass: 'bg-gray-100 text-gray-500',
    borderClass: '',
    bgClass: 'bg-white',
    headingClass: 'text-gray-500',
  },
}

export const PREP_STATUS_META: Record<string, { label: string; badgeClass: string }> = {
  NOT_STARTED: { label: 'Not Started', badgeClass: 'bg-gray-100 text-gray-500' },
  IN_PROGRESS: { label: 'In Progress', badgeClass: 'bg-blue-100 text-blue-700' },
  DONE:        { label: 'Done',        badgeClass: 'bg-green-100 text-green-700' },
  PARTIAL:     { label: 'Partial',     badgeClass: 'bg-amber-100 text-amber-700' },
  BLOCKED:     { label: 'Blocked',     badgeClass: 'bg-red-100 text-red-700' },
  SKIPPED:     { label: 'Skipped',     badgeClass: 'bg-gray-100 text-gray-400' },
}

export const PREP_CATEGORIES = ['MISC', 'SAUCE', 'DRESSING', 'PROTEIN', 'BAKED', 'GARNISH', 'BASE', 'PICKLED', 'DAIRY']
export const PREP_STATIONS   = ['Cold', 'Hot', 'Pastry', 'Butchery', 'Garde Manger']

/**
 * Compute the priority for a prep item.
 * manualOverride wins unconditionally.
 * minThreshold is the EARLY WARNING level — set above parLevel.
 */
export function computePriority(
  onHand: number,
  parLevel: number,
  minThreshold: number,
  targetToday: number | null,
  manualOverride: string | null,
): PrepPriority {
  if (manualOverride) return manualOverride as PrepPriority
  if (onHand <= 0 && parLevel > 0) return '911'
  if (targetToday !== null && onHand < targetToday) return '911'
  if (onHand < parLevel) return 'NEEDED_TODAY'
  if (minThreshold > 0 && onHand < minThreshold) return 'LOW_STOCK'
  return 'LATER'
}

/** max(parLevel - onHand, targetToday - onHand, 0) */
export function computeSuggestedQty(
  onHand: number,
  parLevel: number,
  targetToday: number | null,
): number {
  const base = parLevel - onHand
  if (targetToday !== null) return Math.max(targetToday - onHand, base, 0)
  return Math.max(base, 0)
}

/**
 * Compute the scale factor for ingredient deduction / output credit.
 * unit='batch' → scale = actualPrepQty (each batch = one recipe run)
 * unit matches recipe yieldUnit → scale = actualPrepQty / baseYieldQty
 * otherwise → scale = 1, unitMismatch = true
 */
export function computeScale(
  actualPrepQty: number,
  unit: string,
  recipeYieldUnit: string,
  recipeBaseYieldQty: number,
): { scale: number; unitMismatch: boolean } {
  if (unit === 'batch') return { scale: actualPrepQty, unitMismatch: false }
  if (unit === recipeYieldUnit && recipeBaseYieldQty > 0) {
    return { scale: actualPrepQty / recipeBaseYieldQty, unitMismatch: false }
  }
  return { scale: 1, unitMismatch: true }
}
```

- [ ] **Step 2: Create `src/components/prep/types.ts`**

```typescript
import type { PrepPriority } from '@/lib/prep-utils'

export type { PrepPriority }

export type PrepStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'PARTIAL'
  | 'BLOCKED'
  | 'SKIPPED'

export interface PrepLogData {
  id: string
  prepItemId: string
  logDate: string
  status: PrepStatus
  requiredQty: number | null
  actualPrepQty: number | null
  assignedTo: string | null
  dueTime: string | null
  note: string | null
  blockedReason: string | null
  inventoryAdjusted: boolean
  createdAt: string
  updatedAt: string
}

export interface PrepItemRich {
  id: string
  name: string
  category: string
  station: string | null
  parLevel: number
  unit: string
  minThreshold: number
  targetToday: number | null
  shelfLifeDays: number | null
  notes: string | null
  manualPriorityOverride: string | null
  isActive: boolean
  linkedRecipeId: string | null
  linkedRecipe: {
    id: string
    name: string
    yieldUnit: string
    baseYieldQty: number
  } | null
  linkedInventoryItemId: string | null
  onHand: number
  priority: PrepPriority
  suggestedQty: number
  isBlocked: boolean
  blockedReason: string | null
  todayLog: PrepLogData | null
  createdAt: string
  updatedAt: string
}

export interface IngredientAvailability {
  id: string
  inventoryItemId: string | null
  itemName: string
  qtyBase: number
  unit: string
  stockOnHand: number | null
  isAvailable: boolean | null
}

export interface PrepItemDetail extends PrepItemRich {
  ingredients: IngredientAvailability[]
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/prep-utils.ts src/components/prep/types.ts
git commit -m "feat: add prep utilities and shared types"
```

---

## Task 3: API — Items List and Create

**Files:**
- Create: `src/app/api/prep/items/route.ts`

- [ ] **Step 1: Create the file**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computePriority, computeSuggestedQty } from '@/lib/prep-utils'

const recipeInclude = {
  select: {
    id: true,
    name: true,
    yieldUnit: true,
    baseYieldQty: true,
    inventoryItemId: true,
    inventoryItem: {
      select: { id: true, stockOnHand: true },
    },
    ingredients: {
      include: {
        inventoryItem: {
          select: { id: true, itemName: true, stockOnHand: true },
        },
      },
    },
  },
} as const

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const activeOnly = searchParams.get('active') !== 'false'

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today.getTime() + 86_400_000)

  const items = await prisma.prepItem.findMany({
    where: activeOnly ? { isActive: true } : undefined,
    include: {
      linkedRecipe: recipeInclude,
      linkedInventoryItem: {
        select: { id: true, itemName: true, stockOnHand: true, baseUnit: true },
      },
      logs: {
        where: { logDate: { gte: today, lt: tomorrow } },
        take: 1,
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const enriched = items.map(item => {
    // Resolve onHand
    let onHand = 0
    if (item.linkedInventoryItem) {
      onHand = parseFloat(String(item.linkedInventoryItem.stockOnHand))
    } else if (item.linkedRecipe?.inventoryItem) {
      onHand = parseFloat(String(item.linkedRecipe.inventoryItem.stockOnHand))
    }

    const parLevel     = parseFloat(String(item.parLevel))
    const minThreshold = parseFloat(String(item.minThreshold))
    const targetToday  = item.targetToday ? parseFloat(String(item.targetToday)) : null

    const priority     = computePriority(onHand, parLevel, minThreshold, targetToday, item.manualPriorityOverride)
    const suggestedQty = computeSuggestedQty(onHand, parLevel, targetToday)

    // Blocked check — any ingredient at zero stock?
    let isBlocked   = false
    let blockedReason: string | null = null
    if (item.linkedRecipe) {
      const low = item.linkedRecipe.ingredients
        .filter(ing => ing.inventoryItem && parseFloat(String(ing.inventoryItem.stockOnHand)) <= 0)
        .map(ing => ing.inventoryItem!.itemName)
      if (low.length > 0) {
        isBlocked     = true
        blockedReason = `Low stock: ${low.join(', ')}`
      }
    }

    return {
      id: item.id,
      name: item.name,
      category: item.category,
      station: item.station,
      parLevel,
      unit: item.unit,
      minThreshold,
      targetToday,
      shelfLifeDays: item.shelfLifeDays,
      notes: item.notes,
      manualPriorityOverride: item.manualPriorityOverride,
      isActive: item.isActive,
      linkedRecipeId: item.linkedRecipeId,
      linkedRecipe: item.linkedRecipe
        ? {
            id: item.linkedRecipe.id,
            name: item.linkedRecipe.name,
            yieldUnit: item.linkedRecipe.yieldUnit,
            baseYieldQty: parseFloat(String(item.linkedRecipe.baseYieldQty)),
          }
        : null,
      linkedInventoryItemId: item.linkedInventoryItemId,
      onHand,
      priority,
      suggestedQty,
      isBlocked,
      blockedReason,
      todayLog: item.logs[0] ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }
  })

  return NextResponse.json(enriched)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const {
    name, linkedRecipeId, linkedInventoryItemId,
    category, station, parLevel, unit, minThreshold,
    targetToday, shelfLifeDays, notes, manualPriorityOverride,
  } = body

  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const item = await prisma.prepItem.create({
    data: {
      name,
      linkedRecipeId:        linkedRecipeId        || null,
      linkedInventoryItemId: linkedInventoryItemId || null,
      category:              category              || 'MISC',
      station:               station               || null,
      parLevel:              parLevel   ? parseFloat(String(parLevel))   : 0,
      unit:                  unit       || 'batch',
      minThreshold:          minThreshold ? parseFloat(String(minThreshold)) : 0,
      targetToday:           targetToday  ? parseFloat(String(targetToday))  : null,
      shelfLifeDays:         shelfLifeDays ? parseInt(String(shelfLifeDays)) : null,
      notes:                 notes || null,
      manualPriorityOverride: manualPriorityOverride || null,
    },
  })

  return NextResponse.json(item, { status: 201 })
}
```

- [ ] **Step 2: Verify**

Start the dev server and run:
```bash
curl http://localhost:3000/api/prep/items
```
Expected: `[]` (empty array, no items yet)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/prep/items/route.ts
git commit -m "feat: add GET/POST /api/prep/items"
```

---

## Task 4: API — Single Item CRUD

**Files:**
- Create: `src/app/api/prep/items/[id]/route.ts`

- [ ] **Step 1: Create the file**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computePriority, computeSuggestedQty } from '@/lib/prep-utils'

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const item = await prisma.prepItem.findUnique({
    where: { id: params.id },
    include: {
      linkedRecipe: {
        include: {
          inventoryItem: {
            select: { id: true, itemName: true, stockOnHand: true, baseUnit: true },
          },
          ingredients: {
            include: {
              inventoryItem: {
                select: {
                  id: true, itemName: true, stockOnHand: true,
                  baseUnit: true, pricePerBaseUnit: true,
                },
              },
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
      linkedInventoryItem: true,
      logs: { orderBy: { logDate: 'desc' }, take: 30 },
    },
  })

  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let onHand = 0
  if (item.linkedInventoryItem) {
    onHand = parseFloat(String(item.linkedInventoryItem.stockOnHand))
  } else if (item.linkedRecipe?.inventoryItem) {
    onHand = parseFloat(String(item.linkedRecipe.inventoryItem.stockOnHand))
  }

  const parLevel     = parseFloat(String(item.parLevel))
  const minThreshold = parseFloat(String(item.minThreshold))
  const targetToday  = item.targetToday ? parseFloat(String(item.targetToday)) : null
  const priority     = computePriority(onHand, parLevel, minThreshold, targetToday, item.manualPriorityOverride)
  const suggestedQty = computeSuggestedQty(onHand, parLevel, targetToday)

  const ingredients = (item.linkedRecipe?.ingredients ?? []).map(ing => ({
    id: ing.id,
    inventoryItemId: ing.inventoryItemId,
    itemName: ing.inventoryItem?.itemName ?? 'Sub-recipe',
    qtyBase: parseFloat(String(ing.qtyBase)),
    unit: ing.unit,
    stockOnHand: ing.inventoryItem ? parseFloat(String(ing.inventoryItem.stockOnHand)) : null,
    isAvailable: ing.inventoryItem ? parseFloat(String(ing.inventoryItem.stockOnHand)) > 0 : null,
  }))

  const lowIngredients = ingredients.filter(i => i.isAvailable === false).map(i => i.itemName)

  return NextResponse.json({
    ...item,
    parLevel,
    minThreshold,
    targetToday,
    onHand,
    priority,
    suggestedQty,
    ingredients,
    isBlocked: lowIngredients.length > 0,
    blockedReason: lowIngredients.length > 0 ? `Low stock: ${lowIngredients.join(', ')}` : null,
  })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const body = await req.json()

  const item = await prisma.prepItem.update({
    where: { id: params.id },
    data: {
      ...(body.name                   !== undefined && { name: body.name }),
      ...(body.linkedRecipeId         !== undefined && { linkedRecipeId: body.linkedRecipeId || null }),
      ...(body.linkedInventoryItemId  !== undefined && { linkedInventoryItemId: body.linkedInventoryItemId || null }),
      ...(body.category               !== undefined && { category: body.category }),
      ...(body.station                !== undefined && { station: body.station || null }),
      ...(body.parLevel               !== undefined && { parLevel: parseFloat(String(body.parLevel)) }),
      ...(body.unit                   !== undefined && { unit: body.unit }),
      ...(body.minThreshold           !== undefined && { minThreshold: parseFloat(String(body.minThreshold)) }),
      ...(body.targetToday            !== undefined && { targetToday: body.targetToday ? parseFloat(String(body.targetToday)) : null }),
      ...(body.shelfLifeDays          !== undefined && { shelfLifeDays: body.shelfLifeDays ? parseInt(String(body.shelfLifeDays)) : null }),
      ...(body.notes                  !== undefined && { notes: body.notes || null }),
      ...(body.manualPriorityOverride !== undefined && { manualPriorityOverride: body.manualPriorityOverride || null }),
      ...(body.isActive               !== undefined && { isActive: body.isActive }),
    },
  })

  return NextResponse.json(item)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  await prisma.prepItem.update({
    where: { id: params.id },
    data: { isActive: false },
  })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Commit**

```bash
git add "src/app/api/prep/items/[id]/route.ts"
git commit -m "feat: add GET/PUT/DELETE /api/prep/items/[id]"
```

---

## Task 5: API — Generate Today's Prep

**Files:**
- Create: `src/app/api/prep/generate/route.ts`

- [ ] **Step 1: Create the file**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeSuggestedQty } from '@/lib/prep-utils'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const dateStr = body.date as string | undefined

  const today = dateStr ? new Date(dateStr) : new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today.getTime() + 86_400_000)

  const items = await prisma.prepItem.findMany({
    where: { isActive: true },
    include: {
      linkedInventoryItem: { select: { stockOnHand: true } },
      linkedRecipe: {
        include: { inventoryItem: { select: { stockOnHand: true } } },
      },
      logs: {
        where: { logDate: { gte: today, lt: tomorrow } },
        take: 1,
      },
    },
  })

  let created = 0
  let skipped = 0

  for (const item of items) {
    if (item.logs.length > 0) { skipped++; continue }

    let onHand = 0
    if (item.linkedInventoryItem) {
      onHand = parseFloat(String(item.linkedInventoryItem.stockOnHand))
    } else if (item.linkedRecipe?.inventoryItem) {
      onHand = parseFloat(String(item.linkedRecipe.inventoryItem.stockOnHand))
    }

    const parLevel    = parseFloat(String(item.parLevel))
    const targetToday = item.targetToday ? parseFloat(String(item.targetToday)) : null
    const suggested   = computeSuggestedQty(onHand, parLevel, targetToday)

    await prisma.prepLog.create({
      data: {
        prepItemId:  item.id,
        logDate:     today,
        status:      'NOT_STARTED',
        requiredQty: suggested,
      },
    })
    created++
  }

  return NextResponse.json({ created, skipped, date: today.toISOString() })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/prep/generate/route.ts
git commit -m "feat: add POST /api/prep/generate"
```

---

## Task 6: API — Logs List and Upsert

**Files:**
- Create: `src/app/api/prep/logs/route.ts`

- [ ] **Step 1: Create the file**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const dateStr    = searchParams.get('date')
  const prepItemId = searchParams.get('prepItemId')

  const date = dateStr ? new Date(dateStr) : new Date()
  date.setHours(0, 0, 0, 0)
  const nextDay = new Date(date.getTime() + 86_400_000)

  const logs = await prisma.prepLog.findMany({
    where: {
      ...(prepItemId ? { prepItemId } : {}),
      logDate: { gte: date, lt: nextDay },
    },
    include: {
      prepItem: { select: { id: true, name: true, unit: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json(logs)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { prepItemId, logDate, status, requiredQty, actualPrepQty, assignedTo, dueTime, note } = body

  if (!prepItemId) return NextResponse.json({ error: 'prepItemId is required' }, { status: 400 })

  const date = logDate ? new Date(logDate) : new Date()
  date.setHours(0, 0, 0, 0)

  const log = await prisma.prepLog.upsert({
    where: { prepItemId_logDate: { prepItemId, logDate: date } },
    create: {
      prepItemId,
      logDate:      date,
      status:       status      ?? 'NOT_STARTED',
      requiredQty:  requiredQty  ? parseFloat(String(requiredQty))  : null,
      actualPrepQty: actualPrepQty ? parseFloat(String(actualPrepQty)) : null,
      assignedTo:   assignedTo   ?? null,
      dueTime:      dueTime      ?? null,
      note:         note         ?? null,
    },
    update: {
      ...(status        !== undefined && { status }),
      ...(requiredQty   !== undefined && { requiredQty:  parseFloat(String(requiredQty)) }),
      ...(actualPrepQty !== undefined && { actualPrepQty: parseFloat(String(actualPrepQty)) }),
      ...(assignedTo    !== undefined && { assignedTo }),
      ...(dueTime       !== undefined && { dueTime }),
      ...(note          !== undefined && { note }),
    },
  })

  return NextResponse.json(log, { status: 201 })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/prep/logs/route.ts
git commit -m "feat: add GET/POST /api/prep/logs"
```

---

## Task 7: API — Update Log with Inventory Transaction

**Files:**
- Create: `src/app/api/prep/logs/[id]/route.ts`

- [ ] **Step 1: Create the file**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeScale } from '@/lib/prep-utils'

const COMPLETION_STATUSES = new Set(['DONE', 'PARTIAL'])

async function applyInventoryTransaction(
  logId: string,
  actualQty: number,
): Promise<{ applied: boolean; warning: string | null }> {
  const log = await prisma.prepLog.findUnique({
    where: { id: logId },
    include: {
      prepItem: {
        include: {
          linkedRecipe: {
            include: {
              inventoryItem: true,
              ingredients: { include: { inventoryItem: true } },
            },
          },
        },
      },
    },
  })

  if (!log?.prepItem.linkedRecipe) return { applied: false, warning: null }

  const recipe = log.prepItem.linkedRecipe
  const { scale, unitMismatch } = computeScale(
    actualQty,
    log.prepItem.unit,
    recipe.yieldUnit,
    parseFloat(String(recipe.baseYieldQty)),
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ops: any[] = []

  // Deduct each ingredient from inventory
  for (const ing of recipe.ingredients) {
    if (!ing.inventoryItemId || !ing.inventoryItem) continue
    ops.push(
      prisma.inventoryItem.update({
        where: { id: ing.inventoryItemId },
        data: { stockOnHand: { decrement: parseFloat(String(ing.qtyBase)) * scale } },
      }),
    )
  }

  // Credit the output inventory item
  if (recipe.inventoryItemId) {
    ops.push(
      prisma.inventoryItem.update({
        where: { id: recipe.inventoryItemId },
        data: {
          stockOnHand: { increment: parseFloat(String(recipe.baseYieldQty)) * scale },
        },
      }),
    )
  }

  // Mark log as adjusted
  ops.push(
    prisma.prepLog.update({
      where: { id: logId },
      data: { inventoryAdjusted: true },
    }),
  )

  await prisma.$transaction(ops)

  return {
    applied: true,
    warning: unitMismatch
      ? 'Unit mismatch — applied 1 full batch. Verify quantities manually.'
      : null,
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const body = await req.json()
  const { status, actualPrepQty, assignedTo, dueTime, note, blockedReason } = body

  const existing = await prisma.prepLog.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Require actualPrepQty when completing
  const qty =
    actualPrepQty !== undefined
      ? parseFloat(String(actualPrepQty))
      : existing.actualPrepQty
        ? parseFloat(String(existing.actualPrepQty))
        : null

  if (status && COMPLETION_STATUSES.has(status) && !qty) {
    return NextResponse.json(
      { error: 'actualPrepQty is required to mark as Done or Partial' },
      { status: 400 },
    )
  }

  const log = await prisma.prepLog.update({
    where: { id: params.id },
    data: {
      ...(status        !== undefined && { status }),
      ...(actualPrepQty !== undefined && { actualPrepQty: parseFloat(String(actualPrepQty)) }),
      ...(assignedTo    !== undefined && { assignedTo }),
      ...(dueTime       !== undefined && { dueTime }),
      ...(note          !== undefined && { note }),
      ...(blockedReason !== undefined && { blockedReason }),
    },
  })

  let inventoryResult: { applied: boolean; warning: string | null } = {
    applied: false,
    warning: null,
  }

  // Only fire the transaction once (idempotency via inventoryAdjusted flag)
  if (status && COMPLETION_STATUSES.has(status) && !existing.inventoryAdjusted && qty) {
    inventoryResult = await applyInventoryTransaction(params.id, qty)
  }

  return NextResponse.json({ ...log, inventoryResult })
}
```

- [ ] **Step 2: Commit**

```bash
git add "src/app/api/prep/logs/[id]/route.ts"
git commit -m "feat: add PUT /api/prep/logs/[id] with atomic inventory transaction"
```

---

## Task 8: API — Revert and Reapply Inventory Adjustment

**Files:**
- Create: `src/app/api/prep/logs/[id]/revert/route.ts`

- [ ] **Step 1: Create the file**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeScale } from '@/lib/prep-utils'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const body = await req.json()
  const newActualPrepQty = parseFloat(String(body.newActualPrepQty))

  if (!newActualPrepQty || isNaN(newActualPrepQty)) {
    return NextResponse.json({ error: 'newActualPrepQty is required' }, { status: 400 })
  }

  const log = await prisma.prepLog.findUnique({
    where: { id: params.id },
    include: {
      prepItem: {
        include: {
          linkedRecipe: {
            include: {
              inventoryItem: true,
              ingredients: { include: { inventoryItem: true } },
            },
          },
        },
      },
    },
  })

  if (!log)                       return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!log.inventoryAdjusted)     return NextResponse.json({ error: 'No adjustment to revert' }, { status: 400 })
  if (!log.prepItem.linkedRecipe) return NextResponse.json({ error: 'No linked recipe' }, { status: 400 })

  const recipe  = log.prepItem.linkedRecipe
  const prevQty = parseFloat(String(log.actualPrepQty ?? 0))
  const baseYield = parseFloat(String(recipe.baseYieldQty))

  const { scale: prevScale } = computeScale(prevQty, log.prepItem.unit, recipe.yieldUnit, baseYield)
  const { scale: nextScale } = computeScale(newActualPrepQty, log.prepItem.unit, recipe.yieldUnit, baseYield)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ops: any[] = []

  // Ingredients: reverse prev deduction, apply new deduction (net delta)
  for (const ing of recipe.ingredients) {
    if (!ing.inventoryItemId || !ing.inventoryItem) continue
    const qtyBase  = parseFloat(String(ing.qtyBase))
    const netDelta = (qtyBase * prevScale) - (qtyBase * nextScale) // positive = restore stock
    ops.push(
      prisma.inventoryItem.update({
        where: { id: ing.inventoryItemId },
        data: { stockOnHand: { increment: netDelta } },
      }),
    )
  }

  // Output: reverse prev credit, apply new credit (net delta)
  if (recipe.inventoryItemId) {
    const netCredit = (baseYield * nextScale) - (baseYield * prevScale)
    ops.push(
      prisma.inventoryItem.update({
        where: { id: recipe.inventoryItemId },
        data: { stockOnHand: { increment: netCredit } },
      }),
    )
  }

  ops.push(
    prisma.prepLog.update({
      where: { id: params.id },
      data: { actualPrepQty: newActualPrepQty, inventoryAdjusted: true },
    }),
  )

  await prisma.$transaction(ops)

  return NextResponse.json({ ok: true, previousQty: prevQty, newQty: newActualPrepQty })
}
```

- [ ] **Step 2: Commit**

```bash
git add "src/app/api/prep/logs/[id]/revert/route.ts"
git commit -m "feat: add POST /api/prep/logs/[id]/revert for inventory adjustment correction"
```

---

## Task 9: Component — PrepKpiStrip

**Files:**
- Create: `src/components/prep/PrepKpiStrip.tsx`

- [ ] **Step 1: Create the file**

```tsx
import type { PrepItemRich } from './types'

interface Props {
  items: PrepItemRich[]
  onFilterPriority: (p: string) => void
}

export function PrepKpiStrip({ items, onFilterPriority }: Props) {
  const total       = items.length
  const urgent      = items.filter(i => i.priority === '911').length
  const neededToday = items.filter(i => i.priority === 'NEEDED_TODAY').length
  const lowStock    = items.filter(i => i.priority === 'LOW_STOCK').length
  const done        = items.filter(i => i.todayLog?.status === 'DONE').length
  const blocked     = items.filter(i => i.isBlocked || i.todayLog?.status === 'BLOCKED').length

  const cards = [
    { label: 'Total Items',   value: total,       color: 'text-gray-900',   bg: 'bg-white',         border: 'border-gray-100',   filter: '' },
    { label: '911',           value: urgent,      color: 'text-red-600',    bg: 'bg-red-50',        border: 'border-red-200',    filter: '911' },
    { label: 'Needed Today',  value: neededToday, color: 'text-orange-600', bg: 'bg-orange-50',     border: 'border-orange-200', filter: 'NEEDED_TODAY' },
    { label: 'Low Stock',     value: lowStock,    color: 'text-amber-600',  bg: 'bg-amber-50',      border: 'border-amber-200',  filter: 'LOW_STOCK' },
    { label: 'Done Today',    value: done,        color: 'text-green-600',  bg: 'bg-green-50',      border: 'border-green-200',  filter: '' },
    { label: 'Blocked',       value: blocked,     color: 'text-red-500',    bg: 'bg-white',         border: 'border-gray-100',   filter: '' },
  ]

  return (
    <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
      {cards.map(card => (
        <button
          key={card.label}
          onClick={() => card.filter && onFilterPriority(card.filter)}
          className={`${card.bg} border ${card.border} rounded-xl p-3 text-left shadow-sm transition-all ${card.filter ? 'hover:shadow-md hover:scale-[1.02] cursor-pointer' : 'cursor-default'}`}
        >
          <div className="text-xs font-medium text-gray-500 mb-1">{card.label}</div>
          <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/prep/PrepKpiStrip.tsx
git commit -m "feat: add PrepKpiStrip component"
```

---

## Task 10: Component — PrepItemRow

**Files:**
- Create: `src/components/prep/PrepItemRow.tsx`

- [ ] **Step 1: Create the file**

```tsx
'use client'
import { useState } from 'react'
import { ChevronRight, AlertCircle, MoreHorizontal, BookOpen } from 'lucide-react'
import { CategoryBadge } from '@/components/CategoryBadge'
import {
  PREP_PRIORITY_META,
  PREP_STATUS_META,
  PREP_PRIORITY_ORDER,
  type PrepPriority,
} from '@/lib/prep-utils'
import type { PrepItemRich } from './types'

interface Props {
  item: PrepItemRich
  onClick: () => void
  onStatusChange: (itemId: string, status: string) => void
  onPriorityChange: (itemId: string, priority: string) => void
}

const STATUS_CYCLE: Record<string, string> = {
  NOT_STARTED: 'IN_PROGRESS',
  IN_PROGRESS: 'DONE',
  DONE:        'NOT_STARTED',
  PARTIAL:     'DONE',
  BLOCKED:     'IN_PROGRESS',
  SKIPPED:     'NOT_STARTED',
}

export function PrepItemRow({ item, onClick, onStatusChange, onPriorityChange }: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const priority   = PREP_PRIORITY_META[item.priority]
  const currentStatus = item.todayLog?.status ?? 'NOT_STARTED'
  const statusMeta = PREP_STATUS_META[currentStatus] ?? PREP_STATUS_META.NOT_STARTED

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-50 hover:bg-gray-50 transition-colors ${priority.borderClass} relative`}
    >
      {/* Status button */}
      <button
        onClick={e => { e.stopPropagation(); onStatusChange(item.id, STATUS_CYCLE[currentStatus] ?? 'IN_PROGRESS') }}
        className={`shrink-0 px-2 py-1 rounded-full text-xs font-medium ${statusMeta.badgeClass} hover:opacity-80 transition-opacity`}
      >
        {statusMeta.label}
      </button>

      {/* Name + badges — clickable */}
      <div className="flex-1 min-w-0 cursor-pointer" onClick={onClick}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-gray-800 truncate">{item.name}</span>
          {item.linkedRecipe && (
            <span className="shrink-0 inline-flex items-center gap-1 text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
              <BookOpen size={10} />
              {item.linkedRecipe.name}
            </span>
          )}
          {item.isBlocked && (
            <span title={item.blockedReason ?? 'Blocked'} className="shrink-0 text-red-500">
              <AlertCircle size={14} />
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <CategoryBadge category={item.category} />
          {item.station && (
            <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">{item.station}</span>
          )}
        </div>
      </div>

      {/* Stock numbers */}
      <div className="hidden md:flex items-center gap-4 text-xs shrink-0">
        <div className="text-center">
          <div className="font-semibold text-gray-700">{item.onHand.toFixed(1)}</div>
          <div className="text-gray-400">on hand</div>
        </div>
        <div className="text-center">
          <div className="font-semibold text-gray-700">{item.parLevel.toFixed(1)}</div>
          <div className="text-gray-400">par</div>
        </div>
        <div className="text-center">
          <div className={`font-bold ${item.suggestedQty > 0 ? 'text-blue-600' : 'text-gray-400'}`}>
            {item.suggestedQty.toFixed(1)}
          </div>
          <div className="text-gray-400">make</div>
        </div>
        <div className="text-xs text-gray-400">{item.unit}</div>
      </div>

      {/* Priority badge */}
      <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${priority.badgeClass}`}>
        {priority.label}
      </span>

      {/* Detail arrow */}
      <button onClick={onClick} className="shrink-0 text-gray-400 hover:text-gray-600">
        <ChevronRight size={16} />
      </button>

      {/* More menu */}
      <div className="relative shrink-0">
        <button
          onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
          className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
        >
          <MoreHorizontal size={16} />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-7 z-20 bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-44 text-sm">
              {['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'PARTIAL', 'BLOCKED', 'SKIPPED'].map(s => (
                <button
                  key={s}
                  onClick={() => { onStatusChange(item.id, s); setMenuOpen(false) }}
                  className="w-full text-left px-3 py-1.5 hover:bg-gray-50"
                >
                  {PREP_STATUS_META[s]?.label ?? s}
                </button>
              ))}
              <div className="border-t border-gray-100 my-1" />
              <div className="px-3 py-1 text-xs text-gray-400 font-semibold uppercase">Set Priority</div>
              {PREP_PRIORITY_ORDER.map(p => (
                <button
                  key={p}
                  onClick={() => { onPriorityChange(item.id, p); setMenuOpen(false) }}
                  className="w-full text-left px-3 py-1.5 hover:bg-gray-50"
                >
                  {PREP_PRIORITY_META[p as PrepPriority].label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/prep/PrepItemRow.tsx
git commit -m "feat: add PrepItemRow component"
```

---

## Task 11: Component — PrepItemForm

**Files:**
- Create: `src/components/prep/PrepItemForm.tsx`

- [ ] **Step 1: Create the file**

```tsx
'use client'
import { useState, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { PREP_CATEGORIES, PREP_STATIONS, PREP_PRIORITY_META, PREP_PRIORITY_ORDER } from '@/lib/prep-utils'
import type { PrepItemRich } from './types'

interface Recipe { id: string; name: string; yieldUnit: string }

interface Props {
  item?: PrepItemRich | null
  onClose: () => void
  onSaved: () => void
}

const BLANK = {
  name: '', linkedRecipeId: '', linkedInventoryItemId: '',
  category: 'MISC', station: '',
  parLevel: '', unit: 'batch', minThreshold: '',
  targetToday: '', shelfLifeDays: '', notes: '',
  manualPriorityOverride: '',
}

export function PrepItemForm({ item, onClose, onSaved }: Props) {
  const [form, setForm]     = useState(BLANK)
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/recipes?type=PREP&isActive=true')
      .then(r => r.json())
      .then((data: Recipe[]) => setRecipes(Array.isArray(data) ? data : []))
  }, [])

  useEffect(() => {
    if (item) {
      setForm({
        name:                  item.name,
        linkedRecipeId:        item.linkedRecipeId        ?? '',
        linkedInventoryItemId: item.linkedInventoryItemId ?? '',
        category:              item.category,
        station:               item.station               ?? '',
        parLevel:              String(item.parLevel),
        unit:                  item.unit,
        minThreshold:          String(item.minThreshold),
        targetToday:           item.targetToday != null ? String(item.targetToday) : '',
        shelfLifeDays:         item.shelfLifeDays != null ? String(item.shelfLifeDays) : '',
        notes:                 item.notes                ?? '',
        manualPriorityOverride: item.manualPriorityOverride ?? '',
      })
    }
  }, [item])

  const set = useCallback((k: keyof typeof BLANK, v: string) => {
    setForm(prev => ({ ...prev, [k]: v }))
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError(null)

    const payload = {
      name:                  form.name.trim(),
      linkedRecipeId:        form.linkedRecipeId        || null,
      linkedInventoryItemId: form.linkedInventoryItemId || null,
      category:              form.category,
      station:               form.station               || null,
      parLevel:              form.parLevel    ? parseFloat(form.parLevel)    : 0,
      unit:                  form.unit,
      minThreshold:          form.minThreshold ? parseFloat(form.minThreshold) : 0,
      targetToday:           form.targetToday  ? parseFloat(form.targetToday)  : null,
      shelfLifeDays:         form.shelfLifeDays ? parseInt(form.shelfLifeDays) : null,
      notes:                 form.notes || null,
      manualPriorityOverride: form.manualPriorityOverride || null,
    }

    const url    = item ? `/api/prep/items/${item.id}` : '/api/prep/items'
    const method = item ? 'PUT' : 'POST'
    const res    = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (res.ok) { onSaved(); onClose() }
    else {
      const data = await res.json().catch(() => ({}))
      setError(data.error ?? 'Failed to save')
    }
    setSaving(false)
  }

  const field = (label: string, children: React.ReactNode) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  )
  const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
  const selCls   = inputCls + ' bg-white'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">{item ? 'Edit Prep Item' : 'New Prep Item'}</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {field('Name *', (
            <input className={inputCls} value={form.name}
              onChange={e => set('name', e.target.value)} placeholder="e.g. Smoked Brisket" required />
          ))}

          {field('Linked Recipe (optional)', (
            <select className={selCls} value={form.linkedRecipeId}
              onChange={e => set('linkedRecipeId', e.target.value)}>
              <option value="">— None —</option>
              {recipes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          ))}

          <div className="grid grid-cols-2 gap-3">
            {field('Category', (
              <select className={selCls} value={form.category} onChange={e => set('category', e.target.value)}>
                {PREP_CATEGORIES.map(c => <option key={c}>{c}</option>)}
              </select>
            ))}
            {field('Station', (
              <select className={selCls} value={form.station} onChange={e => set('station', e.target.value)}>
                <option value="">— None —</option>
                {PREP_STATIONS.map(s => <option key={s}>{s}</option>)}
              </select>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-3">
            {field('Par Level', (
              <input className={inputCls} type="number" min="0" step="0.1"
                value={form.parLevel} onChange={e => set('parLevel', e.target.value)} placeholder="0" />
            ))}
            {field('Min Threshold', (
              <input className={inputCls} type="number" min="0" step="0.1"
                value={form.minThreshold} onChange={e => set('minThreshold', e.target.value)} placeholder="0"
                title="Early warning — set above par level" />
            ))}
            {field('Unit', (
              <input className={inputCls} value={form.unit}
                onChange={e => set('unit', e.target.value)} placeholder="batch" />
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {field('Target Today (optional)', (
              <input className={inputCls} type="number" min="0" step="0.1"
                value={form.targetToday} onChange={e => set('targetToday', e.target.value)} placeholder="—" />
            ))}
            {field('Shelf Life (days)', (
              <input className={inputCls} type="number" min="0" step="1"
                value={form.shelfLifeDays} onChange={e => set('shelfLifeDays', e.target.value)} placeholder="—" />
            ))}
          </div>

          {field('Manual Priority Override', (
            <select className={selCls} value={form.manualPriorityOverride}
              onChange={e => set('manualPriorityOverride', e.target.value)}>
              <option value="">— Auto (system decides) —</option>
              {PREP_PRIORITY_ORDER.map(p => (
                <option key={p} value={p}>{PREP_PRIORITY_META[p].label}</option>
              ))}
            </select>
          ))}

          {field('Notes', (
            <textarea className={inputCls} rows={2} value={form.notes}
              onChange={e => set('notes', e.target.value)} placeholder="Chef notes..." />
          ))}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Saving…' : item ? 'Save Changes' : 'Create Prep Item'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/prep/PrepItemForm.tsx
git commit -m "feat: add PrepItemForm modal component"
```

---

## Task 12: Component — PrepDetailPanel

**Files:**
- Create: `src/components/prep/PrepDetailPanel.tsx`

- [ ] **Step 1: Create the file**

```tsx
'use client'
import { useState, useEffect } from 'react'
import { X, BookOpen, CheckCircle, Clock, AlertCircle, RotateCcw, ChevronRight } from 'lucide-react'
import { CategoryBadge } from '@/components/CategoryBadge'
import { formatCurrency } from '@/lib/utils'
import {
  PREP_PRIORITY_META,
  PREP_STATUS_META,
  PREP_PRIORITY_ORDER,
  type PrepPriority,
} from '@/lib/prep-utils'
import type { PrepItemRich, PrepItemDetail, IngredientAvailability } from './types'

interface Props {
  item: PrepItemRich
  onClose: () => void
  onRefresh: () => void
  onEdit: () => void
}

export function PrepDetailPanel({ item, onClose, onRefresh, onEdit }: Props) {
  const [detail, setDetail]         = useState<PrepItemDetail | null>(null)
  const [actualQty, setActualQty]   = useState('')
  const [newRevertQty, setNewRevertQty] = useState('')
  const [showRevert, setShowRevert] = useState(false)
  const [loading, setLoading]       = useState(false)
  const [warning, setWarning]       = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/prep/items/${item.id}`)
      .then(r => r.json())
      .then(setDetail)
  }, [item.id])

  // Pre-fill actualQty from existing log
  useEffect(() => {
    if (item.todayLog?.actualPrepQty) setActualQty(String(item.todayLog.actualPrepQty))
  }, [item.todayLog?.actualPrepQty])

  const priority   = PREP_PRIORITY_META[item.priority]
  const logStatus  = item.todayLog?.status ?? 'NOT_STARTED'
  const statusMeta = PREP_STATUS_META[logStatus]

  async function ensureLog(): Promise<string> {
    if (item.todayLog?.id) return item.todayLog.id
    const log = await fetch('/api/prep/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prepItemId: item.id }),
    }).then(r => r.json())
    return log.id
  }

  async function updateStatus(newStatus: string) {
    const NEEDS_QTY = new Set(['DONE', 'PARTIAL'])
    if (NEEDS_QTY.has(newStatus) && !actualQty) {
      setWarning('Enter actual prep quantity first')
      return
    }
    setLoading(true)
    setWarning(null)
    const logId = await ensureLog()
    const res = await fetch(`/api/prep/logs/${logId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: newStatus,
        ...(actualQty && { actualPrepQty: parseFloat(actualQty) }),
      }),
    }).then(r => r.json())
    if (res.inventoryResult?.warning) setWarning(res.inventoryResult.warning)
    setLoading(false)
    onRefresh()
  }

  async function handleRevert() {
    if (!newRevertQty) return
    setLoading(true)
    await fetch(`/api/prep/logs/${item.todayLog!.id}/revert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newActualPrepQty: parseFloat(newRevertQty) }),
    })
    setShowRevert(false)
    setLoading(false)
    onRefresh()
  }

  async function setPriorityOverride(p: string) {
    await fetch(`/api/prep/items/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manualPriorityOverride: p || null }),
    })
    onRefresh()
  }

  const baseYield = item.linkedRecipe?.baseYieldQty ?? 0
  const yieldUnit = item.linkedRecipe?.yieldUnit ?? item.unit
  const scale = item.unit === 'batch'
    ? parseFloat(actualQty || '0')
    : yieldUnit === item.unit && baseYield > 0
      ? parseFloat(actualQty || '0') / baseYield
      : 1

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div
        className="w-full max-w-md bg-white shadow-xl h-full overflow-y-auto flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-gray-100 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-semibold text-gray-900 text-base truncate">{item.name}</h2>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${priority.badgeClass}`}>
                {priority.label}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <CategoryBadge category={item.category} />
              {item.station && <span className="text-xs text-gray-400">{item.station}</span>}
            </div>
          </div>
          <button onClick={onClose} className="shrink-0 p-1.5 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 p-4 space-y-5">
          {/* Stock strip */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'On Hand', value: `${item.onHand.toFixed(1)} ${item.unit}`, color: item.onHand <= 0 ? 'text-red-600' : 'text-gray-900' },
              { label: 'Par Level', value: `${item.parLevel.toFixed(1)} ${item.unit}`, color: 'text-gray-900' },
              { label: 'Make', value: `${item.suggestedQty.toFixed(1)} ${item.unit}`, color: item.suggestedQty > 0 ? 'text-blue-600 font-bold' : 'text-gray-400' },
            ].map(c => (
              <div key={c.label} className="bg-gray-50 rounded-xl p-3 text-center">
                <div className="text-xs text-gray-400 mb-1">{c.label}</div>
                <div className={`text-base font-semibold ${c.color}`}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* Status + actions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${statusMeta.badgeClass}`}>{statusMeta.label}</span>
            </div>

            {/* Actual qty input */}
            <div className="mb-3">
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Actual Qty Made <span className="text-gray-400">({item.unit}) — required to complete</span>
              </label>
              <input
                type="number" min="0" step="0.1"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={`e.g. ${item.suggestedQty.toFixed(1)}`}
                value={actualQty}
                onChange={e => setActualQty(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => updateStatus('IN_PROGRESS')} disabled={loading}
                className="flex items-center justify-center gap-1.5 px-3 py-2 text-sm border border-blue-200 text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 disabled:opacity-50">
                <Clock size={14} /> Start
              </button>
              <button onClick={() => updateStatus('DONE')} disabled={loading}
                className="flex items-center justify-center gap-1.5 px-3 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50">
                <CheckCircle size={14} /> Mark Done
              </button>
              <button onClick={() => updateStatus('PARTIAL')} disabled={loading}
                className="px-3 py-2 text-sm border border-amber-200 text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100 disabled:opacity-50">
                Partial
              </button>
              <button onClick={() => updateStatus('BLOCKED')} disabled={loading}
                className="px-3 py-2 text-sm border border-red-200 text-red-700 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-50">
                Blocked
              </button>
            </div>

            {warning && (
              <div className="mt-2 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
                <AlertCircle size={13} className="shrink-0 mt-0.5" /> {warning}
              </div>
            )}

            {item.todayLog?.inventoryAdjusted && (
              <div className="mt-2 flex items-center justify-between text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg p-2">
                <span className="flex items-center gap-1"><CheckCircle size={12} /> Inventory Updated</span>
                <button onClick={() => setShowRevert(v => !v)} className="underline hover:no-underline">
                  Correct qty
                </button>
              </div>
            )}

            {showRevert && (
              <div className="mt-2 p-3 bg-gray-50 rounded-lg space-y-2">
                <p className="text-xs text-gray-600">Previous qty: <strong>{item.todayLog?.actualPrepQty} {item.unit}</strong>. Enter corrected qty:</p>
                <input type="number" min="0" step="0.1" value={newRevertQty}
                  onChange={e => setNewRevertQty(e.target.value)}
                  className="w-full border border-gray-200 rounded px-2 py-1 text-sm" />
                <button onClick={handleRevert} disabled={loading || !newRevertQty}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm bg-gray-700 text-white rounded-lg hover:bg-gray-800 disabled:opacity-50">
                  <RotateCcw size={13} /> Revert &amp; Reapply
                </button>
              </div>
            )}
          </div>

          {/* Inventory impact preview */}
          {item.linkedRecipe && actualQty && parseFloat(actualQty) > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs space-y-1">
              <div className="font-semibold text-blue-700 mb-1">Inventory impact when completed:</div>
              {(detail?.ingredients ?? []).filter(i => i.inventoryItemId).map(ing => (
                <div key={ing.id} className="flex justify-between text-blue-600">
                  <span>− {(ing.qtyBase * scale).toFixed(2)} {ing.unit} {ing.itemName}</span>
                  <span className={ing.isAvailable === false ? 'text-red-500 font-medium' : ''}>
                    {ing.isAvailable === false ? '⚠ low stock' : ''}
                  </span>
                </div>
              ))}
              {item.linkedRecipe.inventoryItemId && (
                <div className="flex justify-between text-green-700 font-medium border-t border-blue-200 pt-1 mt-1">
                  <span>+ {(baseYield * scale).toFixed(2)} {yieldUnit} {item.linkedRecipe.name}</span>
                </div>
              )}
            </div>
          )}

          {/* Ingredient availability */}
          {detail?.ingredients && detail.ingredients.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Ingredients</div>
              <div className="space-y-1">
                {detail.ingredients.map(ing => (
                  <div key={ing.id} className="flex items-center justify-between text-sm py-1 border-b border-gray-50">
                    <span className="text-gray-700">{ing.itemName}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400 text-xs">{ing.qtyBase.toFixed(2)} {ing.unit}</span>
                      {ing.isAvailable === true  && <span className="text-green-500 text-xs">✓</span>}
                      {ing.isAvailable === false && <span className="text-red-500 text-xs font-medium">✗ out</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Linked recipe */}
          {item.linkedRecipe && (
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
              <div className="flex items-center gap-2 text-sm">
                <BookOpen size={14} className="text-gray-400" />
                <span className="text-gray-700">{item.linkedRecipe.name}</span>
              </div>
              <a href="/recipes" className="text-xs text-blue-600 hover:underline flex items-center gap-0.5">
                Open <ChevronRight size={12} />
              </a>
            </div>
          )}

          {/* Priority override */}
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Priority Override</div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setPriorityOverride('')}
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${!item.manualPriorityOverride ? 'bg-gray-800 text-white border-gray-800' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
              >
                Auto
              </button>
              {PREP_PRIORITY_ORDER.map(p => (
                <button
                  key={p}
                  onClick={() => setPriorityOverride(p)}
                  className={`px-3 py-1 text-xs rounded-full border transition-colors ${item.manualPriorityOverride === p ? PREP_PRIORITY_META[p as PrepPriority].badgeClass + ' border-current' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                >
                  {PREP_PRIORITY_META[p as PrepPriority].label}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          {item.notes && (
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 text-sm text-amber-800">
              {item.notes}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-100">
          <button onClick={onEdit}
            className="w-full px-4 py-2 text-sm border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50">
            Edit Prep Settings
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/prep/PrepDetailPanel.tsx
git commit -m "feat: add PrepDetailPanel component with inventory impact preview"
```

---

## Task 13: Page — /prep/page.tsx

**Files:**
- Create: `src/app/prep/page.tsx`

- [ ] **Step 1: Create the file**

```tsx
'use client'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { ChefHat, Plus, RefreshCw, Search, ChevronDown, ChevronUp } from 'lucide-react'
import { PrepKpiStrip }    from '@/components/prep/PrepKpiStrip'
import { PrepItemRow }     from '@/components/prep/PrepItemRow'
import { PrepItemForm }    from '@/components/prep/PrepItemForm'
import { PrepDetailPanel } from '@/components/prep/PrepDetailPanel'
import {
  PREP_PRIORITY_ORDER,
  PREP_PRIORITY_META,
  PREP_CATEGORIES,
  PREP_STATIONS,
  type PrepPriority,
} from '@/lib/prep-utils'
import type { PrepItemRich } from '@/components/prep/types'

export default function PrepPage() {
  const [items,      setItems]      = useState<PrepItemRich[]>([])
  const [loading,    setLoading]    = useState(true)
  const [generating, setGenerating] = useState(false)
  const [selected,   setSelected]   = useState<PrepItemRich | null>(null)
  const [editing,    setEditing]    = useState<PrepItemRich | null>(null)
  const [showAdd,    setShowAdd]    = useState(false)

  // Filters
  const [search,         setSearch]         = useState('')
  const [filterPriority, setFilterPriority] = useState('ALL')
  const [filterStatus,   setFilterStatus]   = useState('ALL')
  const [filterCategory, setFilterCategory] = useState('ALL')
  const [filterStation,  setFilterStation]  = useState('ALL')
  const [activeOnly,     setActiveOnly]     = useState(true)
  const [viewMode,       setViewMode]       = useState<'today' | 'needs-action'>('today')
  const [collapsed,      setCollapsed]      = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true)
    const data = await fetch(`/api/prep/items?active=${activeOnly}`).then(r => r.json())
    setItems(Array.isArray(data) ? data : [])
    setLoading(false)
  }, [activeOnly])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => items.filter(item => {
    if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterPriority !== 'ALL' && item.priority !== filterPriority)     return false
    if (filterCategory !== 'ALL' && item.category !== filterCategory)     return false
    if (filterStation  !== 'ALL' && item.station  !== filterStation)      return false
    const s = item.todayLog?.status ?? 'NOT_STARTED'
    if (filterStatus !== 'ALL' && s !== filterStatus) return false
    if (viewMode === 'needs-action' && (s === 'DONE' || s === 'SKIPPED')) return false
    return true
  }), [items, search, filterPriority, filterCategory, filterStation, filterStatus, viewMode])

  const sections = useMemo(() => {
    const map: Record<PrepPriority, PrepItemRich[]> = {
      '911': [], NEEDED_TODAY: [], LOW_STOCK: [], LATER: [],
    }
    filtered.forEach(i => map[i.priority].push(i))
    return map
  }, [filtered])

  const categories = useMemo(() => [...new Set(items.map(i => i.category))].sort(), [items])
  const stations   = useMemo(() => [...new Set(items.map(i => i.station).filter(Boolean) as string[])].sort(), [items])

  const handleGenerate = async () => {
    setGenerating(true)
    await fetch('/api/prep/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    setGenerating(false)
    load()
  }

  async function handleStatusChange(itemId: string, newStatus: string) {
    const item = items.find(i => i.id === itemId)
    if (!item) return
    const NEEDS_QTY = new Set(['DONE', 'PARTIAL'])
    if (NEEDS_QTY.has(newStatus)) {
      // Open detail panel for qty entry
      setSelected(item)
      return
    }
    let logId = item.todayLog?.id
    if (!logId) {
      const log = await fetch('/api/prep/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prepItemId: itemId }),
      }).then(r => r.json())
      logId = log.id
    }
    await fetch(`/api/prep/logs/${logId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
    load()
  }

  async function handlePriorityChange(itemId: string, priority: string) {
    await fetch(`/api/prep/items/${itemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manualPriorityOverride: priority }),
    })
    load()
  }

  const toggleSection = (p: string) =>
    setCollapsed(prev => ({ ...prev, [p]: !prev[p] }))

  const selCls = 'border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <ChefHat size={24} className="text-blue-600" /> Prep
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">Daily kitchen production board</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw size={14} className={generating ? 'animate-spin' : ''} />
            {generating ? 'Generating…' : 'Generate Today\'s Prep'}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus size={14} /> Add Prep Item
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <PrepKpiStrip items={items} onFilterPriority={p => setFilterPriority(prev => prev === p ? 'ALL' : p)} />

      {/* Filters */}
      <div className="bg-white border border-gray-100 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              className="w-full pl-9 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Search prep items…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <select className={selCls} value={filterPriority} onChange={e => setFilterPriority(e.target.value)}>
            <option value="ALL">All Priorities</option>
            <option value="911">911</option>
            <option value="NEEDED_TODAY">Needed Today</option>
            <option value="LOW_STOCK">Low Stock</option>
            <option value="LATER">Later</option>
          </select>
          <select className={selCls} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="ALL">All Statuses</option>
            {['NOT_STARTED','IN_PROGRESS','DONE','PARTIAL','BLOCKED','SKIPPED'].map(s => (
              <option key={s} value={s}>{s.replace('_',' ')}</option>
            ))}
          </select>
          <select className={selCls} value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
            <option value="ALL">All Categories</option>
            {categories.map(c => <option key={c}>{c}</option>)}
          </select>
          {stations.length > 0 && (
            <select className={selCls} value={filterStation} onChange={e => setFilterStation(e.target.value)}>
              <option value="ALL">All Stations</option>
              {stations.map(s => <option key={s}>{s}</option>)}
            </select>
          )}
        </div>
        <div className="flex items-center gap-4 text-sm flex-wrap">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={activeOnly}
              onChange={e => setActiveOnly(e.target.checked)}
              className="rounded text-blue-600" />
            <span className="text-gray-600">Active only</span>
          </label>
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
            {(['today', 'needs-action'] as const).map(m => (
              <button key={m}
                onClick={() => setViewMode(m)}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${viewMode === m ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}
              >
                {m === 'today' ? 'Today' : 'Needs Action'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Priority sections */}
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-gray-100 rounded-xl py-16 text-center">
          <ChefHat size={32} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500 text-sm">No prep items match your filters.</p>
          <p className="text-gray-400 text-xs mt-1">Click &ldquo;Generate Today&rsquo;s Prep&rdquo; to populate today&rsquo;s board.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {PREP_PRIORITY_ORDER.map(priority => {
            const sectionItems = sections[priority]
            if (sectionItems.length === 0) return null
            const meta    = PREP_PRIORITY_META[priority]
            const isOpen  = !collapsed[priority]
            return (
              <div key={priority} className={`border rounded-xl overflow-hidden ${priority === '911' ? 'border-red-200' : priority === 'NEEDED_TODAY' ? 'border-orange-200' : priority === 'LOW_STOCK' ? 'border-amber-200' : 'border-gray-200'}`}>
                {/* Section header */}
                <button
                  onClick={() => toggleSection(priority)}
                  className={`w-full flex items-center justify-between px-4 py-3 ${meta.bgClass} hover:opacity-90 transition-opacity`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-base">{meta.emoji}</span>
                    <span className={`font-semibold text-sm ${meta.headingClass}`}>{meta.label}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${meta.badgeClass}`}>{sectionItems.length}</span>
                  </div>
                  {isOpen ? <ChevronUp size={16} className={meta.headingClass} /> : <ChevronDown size={16} className={meta.headingClass} />}
                </button>
                {/* Items */}
                {isOpen && (
                  <div className="divide-y divide-gray-50">
                    {sectionItems.map(item => (
                      <PrepItemRow
                        key={item.id}
                        item={item}
                        onClick={() => setSelected(item)}
                        onStatusChange={handleStatusChange}
                        onPriorityChange={handlePriorityChange}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <PrepDetailPanel
          item={selected}
          onClose={() => setSelected(null)}
          onRefresh={() => { load(); setSelected(null) }}
          onEdit={() => { setEditing(selected); setSelected(null) }}
        />
      )}

      {/* Add form */}
      {showAdd && (
        <PrepItemForm
          onClose={() => setShowAdd(false)}
          onSaved={load}
        />
      )}

      {/* Edit form */}
      {editing && (
        <PrepItemForm
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { load(); setEditing(null) }}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify the page loads**

Navigate to `http://localhost:3000/prep` — expect the Prep page to load with an empty state and "Generate Today's Prep" button.

- [ ] **Step 3: Commit**

```bash
git add src/app/prep/page.tsx
git commit -m "feat: add /prep page with priority sections, filters, and KPI strip"
```

---

## Task 14: Navigation Update

**Files:**
- Modify: `src/components/Navigation.tsx`

- [ ] **Step 1: Add `ChefHat` import and Prep nav item**

In `Navigation.tsx`, find the lucide import line and add `ChefHat`:

```tsx
import {
  LayoutDashboard, Package, FileText, Trash2, BarChart3,
  ClipboardList, BookOpen, UtensilsCrossed, MoreHorizontal,
  X, ShoppingBag, TrendingUp, Settings, ChefHat,
} from 'lucide-react'
```

In the `navItems` array, add Prep after Count:

```tsx
  { href: '/count',  label: 'Count', icon: ClipboardList },
  { href: '/prep',   label: 'Prep',  icon: ChefHat },       // ← add this line
  { href: '/invoices', label: 'Invoices', icon: FileText },
```

In the `mobileMore` array, add Prep:

```tsx
const mobileMore: NavItem[] = [
  { href: '/prep',    label: 'Prep',    icon: ChefHat },      // ← add this line
  { href: '/recipes', label: 'Recipes', icon: BookOpen },
  // ... rest unchanged
]
```

- [ ] **Step 2: Verify navigation**

Confirm Prep appears in the desktop sidebar after Count, and in the mobile More drawer. Clicking it navigates to `/prep`.

- [ ] **Step 3: Final integration check**

Run through this checklist:
- [ ] `/prep` page loads without errors
- [ ] "Add Prep Item" opens the form; creating an item shows it in the list
- [ ] "Generate Today's Prep" creates PrepLog rows and shows items in priority sections
- [ ] Clicking an item row opens the detail panel
- [ ] Setting actual qty and clicking "Mark Done" shows inventory impact preview, then updates status
- [ ] After marking done, the "Inventory Updated" badge appears
- [ ] "Correct qty" shows the Revert & Reapply flow
- [ ] Filtering by priority, status, category works
- [ ] KPI strip updates as items change status
- [ ] No existing pages are broken (check Dashboard, Inventory, Recipes)

- [ ] **Step 4: Commit**

```bash
git add src/components/Navigation.tsx
git commit -m "feat: add Prep link to desktop sidebar and mobile navigation"
```

---

## Self-Review

**Spec coverage check:**
- ✅ PrepItem + PrepLog Prisma models (Task 1)
- ✅ Priority logic: 911 / NEEDED_TODAY / LOW_STOCK / LATER (Task 2)
- ✅ Suggested qty formula (Task 2)
- ✅ Scale factor for inventory transaction (Task 2)
- ✅ GET/POST items list (Task 3)
- ✅ GET/PUT/DELETE single item (Task 4)
- ✅ Generate today's prep (Task 5)
- ✅ Logs CRUD (Tasks 6, 7)
- ✅ Atomic inventory transaction on DONE/PARTIAL (Task 7)
- ✅ Idempotency via `inventoryAdjusted` flag (Task 7)
- ✅ Revert & Reapply (Task 8)
- ✅ KPI strip (Task 9)
- ✅ Item row with status cycle + more menu (Task 10)
- ✅ Add/Edit modal form (Task 11)
- ✅ Detail panel with qty input, impact preview, ingredient check (Task 12)
- ✅ Priority sections (collapsible, colour-coded) (Task 13)
- ✅ Filters: search, priority, status, category, station, active, view mode (Task 13)
- ✅ Navigation: desktop + mobile (Task 14)
- ✅ `manualPriorityOverride` wins over auto-priority (Tasks 2, 12)
- ✅ Blocked ingredient indicator (Tasks 3, 12)
- ✅ `inventoryAdjusted` prevents double-application (Task 7)
- ✅ `prisma.$transaction` for atomic inventory writes (Tasks 7, 8)
