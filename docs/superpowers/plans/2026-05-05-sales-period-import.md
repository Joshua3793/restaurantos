# Sales Period Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend sales import to accept weekly/monthly Toast ProductMix exports and add a Day/Week/Month split-panel view to the sales page.

**Architecture:** Add `periodType` + `endDate` to `SalesEntry` (single schema change, no new tables). Update the import route to detect two-date filenames and return the new fields. Thread them through `POST/PUT /api/sales`. Extend `ImportModal` to show From/To date fields for period imports. Replace the sales list tab with a split-panel: a Day/Week/Month granularity toggle on the left, a detail panel on the right. Aggregation is entirely client-side from the existing GET response.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma + PostgreSQL · Tailwind CSS · `xlsx` (already installed)

---

## File Map

| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `periodType` + `endDate` to `SalesEntry` |
| `prisma/migrations/` | Auto-generated migration |
| `src/app/api/sales/import/route.ts` | Period date detection; extend `ImportParseResult` |
| `src/app/api/sales/route.ts` | POST: accept `periodType`, `endDate` |
| `src/app/api/sales/[id]/route.ts` | PUT: accept `periodType`, `endDate` |
| `src/app/sales/page.tsx` | Types, `ImportModal`, aggregation helpers, split-panel UI |

---

## Task 1: Prisma schema migration

**Files:**
- Modify: `prisma/schema.prisma` — add two fields to `SalesEntry`

- [ ] **Step 1: Add fields to `SalesEntry`**

In `prisma/schema.prisma`, find the `SalesEntry` model and add two fields after `notes`:

```prisma
model SalesEntry {
  id              String         @id @default(cuid())
  date            DateTime
  totalRevenue    Decimal
  foodSalesPct    Decimal        @default(0.7)
  covers          Int?
  notes           String?
  periodType      String         @default("day")
  endDate         DateTime?
  createdAt       DateTime       @default(now())
  revenueCenterId String?
  lineItems       SaleLineItem[]
  revenueCenter   RevenueCenter? @relation("SalesRC", fields: [revenueCenterId], references: [id])
}
```

- [ ] **Step 2: Create and apply the migration**

```bash
npx prisma migrate dev --name add-sales-period-fields
```

Expected: migration created and applied, no errors. Prisma client regenerated automatically.

- [ ] **Step 3: Verify build passes**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add periodType and endDate to SalesEntry schema"
```

---

## Task 2: Update import route — period date detection

**Files:**
- Modify: `src/app/api/sales/import/route.ts`

The current `extractDate` function pulls the first `YYYY-MM-DD` from the Summary sheet title. We need to detect a two-date pattern like `ProductMix_2026-04-01_2026-04-30` and auto-classify the period type.

- [ ] **Step 1: Update `ImportParseResult` and `extractDate`**

Replace the `ImportParseResult` interface and `extractDate` function:

```ts
export interface ImportParseResult {
  date: string           // YYYY-MM-DD start date
  endDate: string | null // null for single-day; ISO date for period files
  periodType: string     // 'day' | 'week' | 'month' | 'custom'
  totalSales: number
  foodSales: number
  items: ImportedItem[]
}

function extractDates(wb: XLSX.WorkBook, filename: string): {
  startDate: string
  endDate: string | null
  periodType: string
} {
  // Try Summary sheet → row 0, col 0
  const summarySheet = wb.Sheets['Summary'] ?? wb.Sheets['summary']
  let title = ''
  if (summarySheet) {
    const rows = XLSX.utils.sheet_to_json<string[]>(summarySheet, { header: 1, defval: '' }) as string[][]
    title = String(rows[0]?.[0] ?? '')
  }
  if (!title) title = filename

  // Two-date pattern: ProductMix_2026-04-01_2026-04-30
  const rangeMatch = title.match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/)
  if (rangeMatch) {
    const startDate = rangeMatch[1]
    const endDate   = rangeMatch[2]
    const diffDays  = Math.round(
      (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000
    )
    const periodType =
      diffDays >= 6  && diffDays <= 7  ? 'week'   :
      diffDays >= 28 && diffDays <= 31 ? 'month'  :
      'custom'
    return { startDate, endDate, periodType }
  }

  // Single-date pattern
  const singleMatch = title.match(/(\d{4}-\d{2}-\d{2})/)
  if (singleMatch) return { startDate: singleMatch[1], endDate: null, periodType: 'day' }

  // Fallback
  const fallback = new Date().toISOString().slice(0, 10)
  return { startDate: fallback, endDate: null, periodType: 'day' }
}
```

- [ ] **Step 2: Update the route handler to use `extractDates`**

Replace the `const date = extractDate(...)` line and the result construction:

```ts
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const wb = XLSX.read(buffer, { type: 'buffer' })

    const { startDate, endDate, periodType } = extractDates(wb, file.name)
    const { totalSales, foodSales, brunchItems } = parseAllLevels(wb)

    const recipes = await prisma.recipe.findMany({
      where: { type: 'MENU', isActive: true },
      select: { id: true, name: true },
    })

    const items: ImportedItem[] = brunchItems.map(bi => {
      const match = matchRecipe(bi.name, recipes)
      return {
        rawName: bi.name,
        qtySold: bi.qty,
        matchedRecipeId: match?.id ?? null,
        matchedRecipeName: match?.name ?? null,
        matchConfidence: match?.confidence ?? 'none',
      }
    })

    const result: ImportParseResult = { date: startDate, endDate, periodType, totalSales, foodSales, items }
    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to parse file'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
```

Also delete the old `extractDate` function — it is fully replaced by `extractDates`.

- [ ] **Step 3: Verify build passes**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sales/import/route.ts
git commit -m "feat: detect period date ranges in Toast ProductMix import"
```

---

## Task 3: Update POST and PUT sales routes

**Files:**
- Modify: `src/app/api/sales/route.ts`
- Modify: `src/app/api/sales/[id]/route.ts`

- [ ] **Step 1: Update `POST /api/sales`**

In `src/app/api/sales/route.ts`, update the `POST` handler to accept and persist `periodType` and `endDate`:

```ts
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { lineItems = [], revenueCenterId, ...rest } = body

  const entry = await prisma.salesEntry.create({
    data: {
      date:           new Date(rest.date),
      totalRevenue:   parseFloat(rest.totalRevenue) || 0,
      foodSalesPct:   parseFloat(rest.foodSalesPct) || 0.7,
      covers:         rest.covers ? parseInt(rest.covers) : null,
      notes:          rest.notes || null,
      periodType:     rest.periodType ?? 'day',
      endDate:        rest.endDate ? new Date(rest.endDate) : null,
      revenueCenterId: revenueCenterId || null,
      lineItems: {
        create: (lineItems as { recipeId: string; qtySold: number }[])
          .filter(li => li.recipeId && li.qtySold > 0)
          .map(li => ({ recipeId: li.recipeId, qtySold: parseInt(String(li.qtySold)) })),
      },
    },
    include: {
      revenueCenter: { select: RC_SELECT },
      lineItems: { include: { recipe: { select: RECIPE_SELECT } } },
    },
  })
  return NextResponse.json(entry, { status: 201 })
}
```

- [ ] **Step 2: Update `PUT /api/sales/[id]`**

In `src/app/api/sales/[id]/route.ts`, update the `PUT` handler:

```ts
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const { lineItems = [], revenueCenterId, ...rest } = body

  await prisma.saleLineItem.deleteMany({ where: { saleId: params.id } })

  const entry = await prisma.salesEntry.update({
    where: { id: params.id },
    data: {
      date:         new Date(rest.date),
      totalRevenue: parseFloat(rest.totalRevenue) || 0,
      foodSalesPct: parseFloat(rest.foodSalesPct) || 0.7,
      covers:       rest.covers ? parseInt(rest.covers) : null,
      notes:        rest.notes || null,
      periodType:   rest.periodType ?? 'day',
      endDate:      rest.endDate ? new Date(rest.endDate) : null,
      revenueCenterId: revenueCenterId ?? null,
      lineItems: {
        create: (lineItems as { recipeId: string; qtySold: number }[])
          .filter(li => li.recipeId && li.qtySold > 0)
          .map(li => ({ recipeId: li.recipeId, qtySold: parseInt(String(li.qtySold)) })),
      },
    },
    include: {
      revenueCenter: { select: RC_SELECT },
      lineItems: { include: { recipe: { select: RECIPE_SELECT } } },
    },
  })
  return NextResponse.json(entry)
}
```

- [ ] **Step 3: Verify build passes**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sales/route.ts src/app/api/sales/[id]/route.ts
git commit -m "feat: thread periodType and endDate through sales POST/PUT routes"
```

---

## Task 4: Update `ImportModal` — period import UI

**Files:**
- Modify: `src/app/sales/page.tsx` — `ParseResult` interface, `ImportModal` component, `handleImport` handler

The modal needs to show From/To date fields (instead of a single Date) and a period type badge/dropdown when a period file is detected.

- [ ] **Step 1: Update `ParseResult` interface and `ImportModal` types**

In `page.tsx`, find the `ParseResult` interface (around line 401) and add the two new fields:

```ts
interface ParseResult {
  date: string
  endDate: string | null    // add this
  periodType: string        // add this
  totalSales: number
  foodSales: number
  items: ParsedItem[]
}
```

Update the `onImport` callback type in `ImportModal`'s props:

```ts
function ImportModal({ menuRecipes, onImport, onClose }: {
  menuRecipes: RecipeSummary[]
  onImport: (row: {
    date: string
    endDate: string | null
    periodType: string
    totalRevenue: string
    covers: string
    foodSalesPct: string
    notes: string
    lineItems: { recipeId: string; qtySold: number }[]
  }) => Promise<void>
  onClose: () => void
})
```

- [ ] **Step 2: Add `endDate` and `periodType` state to `ImportModal`**

After the existing `const [saving, setSaving] = useState(false)` line, add:

```ts
const [endDate,    setEndDate]    = useState('')
const [periodType, setPeriodType] = useState<'day' | 'week' | 'month' | 'custom'>('day')
```

In `handleFile`, after `setDate(result.date)`, add:

```ts
setEndDate(result.endDate ?? '')
setPeriodType((result.periodType ?? 'day') as 'day' | 'week' | 'month' | 'custom')
```

- [ ] **Step 3: Replace the Date field in the review step with period-aware fields**

Find the review step's "Date + Totals" grid (around line 549). Replace the single `Date` column with a conditional block:

```tsx
{/* Date + Totals */}
<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
  {parsed.endDate ? (
    /* Period import: From / To / Period Type */
    <>
      <div>
        <label className="text-xs font-medium text-gray-600 block mb-1">From</label>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
      </div>
      <div>
        <label className="text-xs font-medium text-gray-600 block mb-1">To</label>
        <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
      </div>
      <div>
        <label className="text-xs font-medium text-gray-600 block mb-1">Period Type</label>
        <select value={periodType} onChange={e => setPeriodType(e.target.value as typeof periodType)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold">
          <option value="week">Week</option>
          <option value="month">Month</option>
          <option value="custom">Custom</option>
        </select>
      </div>
    </>
  ) : (
    /* Single-day import: existing date field */
    <div>
      <label className="text-xs font-medium text-gray-600 block mb-1">Date</label>
      <input type="date" value={date} onChange={e => setDate(e.target.value)}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
    </div>
  )}
  <div>
    <label className="text-xs font-medium text-gray-600 block mb-1">Total Net Sales</label>
    <div className="relative">
      <span className="absolute left-3 top-2 text-gray-400 text-sm">$</span>
      <input type="number" min="0" step="0.01" value={totalSales} onChange={e => setTotalSales(e.target.value)}
        className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
    </div>
  </div>
  <div>
    <label className="text-xs font-medium text-gray-600 block mb-1">
      Food Sales <span className="text-gray-400 font-normal">({foodPct}%)</span>
    </label>
    <div className="relative">
      <span className="absolute left-3 top-2 text-gray-400 text-sm">$</span>
      <input type="number" min="0" step="0.01" value={foodSales} onChange={e => setFoodSales(e.target.value)}
        className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
    </div>
  </div>
</div>
```

Note: when `parsed.endDate` is set, the grid is now 3 columns (From/To/Type) + 2 more. To keep the layout from breaking, change the grid on the outer div to `grid-cols-1 sm:grid-cols-2` when it's a period import, and keep `sm:grid-cols-3` for day imports. Simplest approach: split into two separate `<div className="grid ...">` blocks (one for dates, one for totals) and remove the outer grid wrapper:

```tsx
{/* Date row */}
{parsed.endDate ? (
  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
    {/* From / To / Period Type as above */}
  </div>
) : (
  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
    <div>{/* Date input */}</div>
    <div>{/* Total Net Sales */}</div>
    <div>{/* Food Sales */}</div>
  </div>
)}
{parsed.endDate && (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
    <div>{/* Total Net Sales */}</div>
    <div>{/* Food Sales */}</div>
  </div>
)}
```

- [ ] **Step 4: Update `handleSave` to pass `endDate` and `periodType`**

Replace the `await onImport(...)` call in `handleSave`:

```ts
await onImport({
  date,
  endDate: endDate || null,
  periodType,
  totalRevenue: totalSales,
  covers: '',
  foodSalesPct,
  notes: '',
  lineItems,
})
```

- [ ] **Step 5: Update the save button label**

Replace the save button text in the footer:

```tsx
<button onClick={handleSave} disabled={saving}
  className="flex-1 px-4 py-2.5 rounded-xl bg-gold text-white text-sm font-medium hover:bg-[#a88930] disabled:opacity-60">
  {saving ? 'Saving…' :
    periodType === 'week'  ? `Save weekly sales` :
    periodType === 'month' ? `Save monthly sales` :
    periodType === 'custom' ? `Save period sales` :
    `Save sales for ${date}`
  }
</button>
```

- [ ] **Step 6: Update `handleImport` in the main page**

Find `handleImport` (around line 769). The spread `...row` now includes `endDate` and `periodType` so no body change is needed — but update the type annotation to silence TypeScript:

```ts
const handleImport = async (row: Parameters<Parameters<typeof ImportModal>[0]['onImport']>[0]) => {
  await fetch('/api/sales', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...row, revenueCenterId: activeRcId }),
  })
  setShowImport(false)
  fetchSales()
}
```

This is unchanged from the original — the type is already inferred. Just verify it compiles.

- [ ] **Step 7: Verify build passes**

```bash
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add src/app/sales/page.tsx
git commit -m "feat: extend ImportModal to handle weekly/monthly period imports"
```

---

## Task 5: Sales page — split-panel layout with Day/Week/Month views

**Files:**
- Modify: `src/app/sales/page.tsx` — `Sale` type, new helper functions, new state, restructured list tab

This is the largest task. It replaces the full-width table in the list tab with a split-panel that has a granularity toggle (Day/Week/Month), a period list on the left, and a detail panel on the right.

- [ ] **Step 1: Update `Sale` interface**

Add `periodType` and `endDate` to the `Sale` interface (around line 32):

```ts
interface Sale {
  id: string
  date: string
  totalRevenue: number
  foodSalesPct: number
  covers: number | null
  notes: string | null
  periodType: string       // 'day' | 'week' | 'month' | 'custom'
  endDate: string | null   // null for day entries
  createdAt: string
  revenueCenterId: string | null
  revenueCenter: { id: string; name: string; color: string } | null
  lineItems: SaleLineItem[]
}
```

Also add the new types after the existing type aliases:

```ts
type Granularity = 'day' | 'week' | 'month'

interface PeriodRow {
  key: string
  label: string
  startDate: string
  endDate: string
  totalRevenue: number
  foodSalesPct: number
  covers: number | null
  badge: 'weekly-import' | 'monthly-import' | 'complete' | 'partial' | 'not-available'
  badgeText: string
  directSale: Sale | null
  dailySales: Sale[]
}
```

- [ ] **Step 2: Add `isoWeekStart` helper and aggregation functions**

Add these functions in the Helpers section (after the existing `getRange` function, around line 91):

```ts
function isoWeekStart(d: Date): Date {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  const day = r.getDay() // 0=Sun
  r.setDate(r.getDate() - ((day + 6) % 7)) // roll back to Monday
  return r
}

function buildWeekRows(sales: Sale[], rangeStart: string, rangeEnd: string): PeriodRow[] {
  const rows: PeriodRow[] = []
  let cursor = isoWeekStart(new Date(rangeStart))
  const rangeEndDate = new Date(rangeEnd + 'T23:59:59')

  while (cursor <= rangeEndDate) {
    const weekEnd = new Date(cursor)
    weekEnd.setDate(cursor.getDate() + 6)
    const weekStartISO = toISO(cursor)
    const weekEndISO   = toISO(weekEnd)

    const directImport = sales.find(
      s => s.periodType === 'week' &&
        toISO(isoWeekStart(new Date(s.date))) === weekStartISO
    )
    const dailies = sales.filter(
      s => s.periodType === 'day' &&
        s.date.slice(0, 10) >= weekStartISO &&
        s.date.slice(0, 10) <= weekEndISO
    )

    let badge: PeriodRow['badge']
    let badgeText: string
    let totalRevenue: number
    let foodSalesPct: number
    let covers: number | null

    if (directImport) {
      badge = 'weekly-import'; badgeText = 'Weekly import'
      totalRevenue = Number(directImport.totalRevenue)
      foodSalesPct = Number(directImport.foodSalesPct)
      covers = directImport.covers
    } else if (dailies.length === 0) {
      badge = 'not-available'; badgeText = 'Not available'
      totalRevenue = 0; foodSalesPct = 0.7; covers = null
    } else {
      const totalRev      = dailies.reduce((s, d) => s + Number(d.totalRevenue), 0)
      const totalFoodSales = dailies.reduce((s, d) => s + Number(d.totalRevenue) * Number(d.foodSalesPct), 0)
      badge     = dailies.length >= 7 ? 'complete' : 'partial'
      badgeText = `${dailies.length}/7 days`
      totalRevenue = totalRev
      foodSalesPct = totalRev > 0 ? totalFoodSales / totalRev : 0.7
      covers       = dailies.reduce((s, d) => s + (d.covers ?? 0), 0) || null
    }

    const lStart = cursor.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
    const lEnd   = weekEnd.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })

    rows.push({
      key: `w-${weekStartISO}`,
      label: `${lStart} – ${lEnd}`,
      startDate: weekStartISO,
      endDate: weekEndISO,
      totalRevenue,
      foodSalesPct,
      covers,
      badge,
      badgeText,
      directSale: directImport ?? null,
      dailySales: dailies,
    })

    cursor = new Date(cursor)
    cursor.setDate(cursor.getDate() + 7)
  }

  return rows.reverse()
}

function buildMonthRows(sales: Sale[], rangeStart: string, rangeEnd: string): PeriodRow[] {
  const rows: PeriodRow[] = []
  const rangeStartDate = new Date(rangeStart)
  const rangeEndDate   = new Date(rangeEnd + 'T23:59:59')

  let cursor = new Date(rangeStartDate.getFullYear(), rangeStartDate.getMonth(), 1)
  while (cursor <= rangeEndDate) {
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)
    const monthStartISO = toISO(cursor)
    const monthEndISO   = toISO(monthEnd)

    const directImport = sales.find(
      s => s.periodType === 'month' &&
        new Date(s.date).getFullYear() === cursor.getFullYear() &&
        new Date(s.date).getMonth()    === cursor.getMonth()
    )

    // All non-monthly entries whose start date falls in this month
    const contributing = sales.filter(
      s => s.periodType !== 'month' &&
        s.date.slice(0, 10) >= monthStartISO &&
        s.date.slice(0, 10) <= monthEndISO
    )
    const dailies = contributing.filter(s => s.periodType === 'day')

    let badge: PeriodRow['badge']
    let badgeText: string
    let totalRevenue: number
    let foodSalesPct: number
    let covers: number | null

    if (directImport) {
      badge = 'monthly-import'; badgeText = 'Monthly import'
      totalRevenue = Number(directImport.totalRevenue)
      foodSalesPct = Number(directImport.foodSalesPct)
      covers = directImport.covers
    } else if (contributing.length === 0) {
      badge = 'not-available'; badgeText = 'Not available'
      totalRevenue = 0; foodSalesPct = 0.7; covers = null
    } else {
      const totalRev      = contributing.reduce((s, e) => s + Number(e.totalRevenue), 0)
      const totalFoodSales = contributing.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
      const coveredDays   = new Set(dailies.map(d => d.date.slice(0, 10)))
      const daysInMonth   = monthEnd.getDate()
      badge     = coveredDays.size >= daysInMonth ? 'complete' : 'partial'
      badgeText = `${coveredDays.size}/${daysInMonth} days`
      totalRevenue = totalRev
      foodSalesPct = totalRev > 0 ? totalFoodSales / totalRev : 0.7
      covers       = contributing.reduce((s, e) => s + (e.covers ?? 0), 0) || null
    }

    rows.push({
      key: `m-${monthStartISO}`,
      label: cursor.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' }),
      startDate: monthStartISO,
      endDate: monthEndISO,
      totalRevenue,
      foodSalesPct,
      covers,
      badge,
      badgeText,
      directSale: directImport ?? null,
      dailySales: dailies,
    })

    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  }

  return rows.reverse()
}
```

- [ ] **Step 3: Add the `PeriodBadge` component**

Add this small helper component near `KpiCard` (around line 95):

```tsx
function PeriodBadge({ badge, text }: { badge: PeriodRow['badge']; text: string }) {
  const cls = {
    'weekly-import':  'bg-blue-100 text-blue-700',
    'monthly-import': 'bg-purple-100 text-purple-700',
    'complete':       'bg-green-100 text-green-700',
    'partial':        'bg-amber-100 text-amber-700',
    'not-available':  'bg-gray-100 text-gray-400',
  }[badge]
  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${cls}`}>{text}</span>
}
```

- [ ] **Step 4: Add `granularity` state and `selectedSale` / `selectedPeriodKey` state to `SalesPage`**

In the `SalesPage` component (around line 655), add three new state variables and rename `viewSale` to `selectedSale`:

Find `const [viewSale, setViewSale] = useState<Sale | null>(null)` and replace with:

```ts
const [selectedSale,      setSelectedSale]      = useState<Sale | null>(null)
const [selectedPeriodKey, setSelectedPeriodKey] = useState<string | null>(null)
const [granularity,       setGranularity]       = useState<Granularity>('day')
```

Then update every reference to `viewSale` / `setViewSale` in the component:
- `handleDelete`: `if (viewSale?.id === id) setViewSale(null)` → `if (selectedSale?.id === id) setSelectedSale(null)`
- `setViewSale(sale)` on row click → `setSelectedSale(sale)`
- `setViewSale(null)` in onEdit → `setSelectedSale(null)`
- The `DayDetail` modal render block (near line 1015) — remove it entirely (replaced in step 6)

- [ ] **Step 5: Compute `periodRows` with `useMemo`**

Add this memoized computation after the existing `topItems` useMemo (around line 721):

```ts
const periodRows = useMemo((): PeriodRow[] => {
  if (granularity === 'week')  return buildWeekRows(sales, startDate, endDate)
  if (granularity === 'month') return buildMonthRows(sales, startDate, endDate)
  return []
}, [sales, granularity, startDate, endDate])
```

- [ ] **Step 6: Restructure the list tab to use split-panel layout**

Replace the entire `{activeTab === 'list' && (...)}` block (lines ~861–960) with:

```tsx
{activeTab === 'list' && (
  <>
    {/* Granularity toggle + search */}
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
        {(['day', 'week', 'month'] as Granularity[]).map(g => (
          <button key={g}
            onClick={() => { setGranularity(g); setSelectedSale(null); setSelectedPeriodKey(null) }}
            className={`px-3 py-1.5 text-xs font-medium transition-colors capitalize ${
              granularity === g ? 'bg-gold text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}>
            {g}
          </button>
        ))}
      </div>
      {granularity === 'day' && (
        <div className="relative max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search days…"
            className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
        </div>
      )}
    </div>

    {/* Split panel */}
    <div className="flex gap-4 items-start">

      {/* Left panel */}
      <div className={`${(selectedSale || selectedPeriodKey) ? 'w-[360px] shrink-0' : 'w-full'} transition-all`}>

        {/* Day mode — existing table */}
        {granularity === 'day' && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 cursor-pointer" onClick={() => toggleSort('date')}>
                    Date <SortIcon col="date" />
                  </th>
                  <th className="px-3 py-3 text-right font-medium text-gray-500 cursor-pointer" onClick={() => toggleSort('revenue')}>
                    Revenue <SortIcon col="revenue" />
                  </th>
                  <th className="px-3 py-3 text-right font-medium text-gray-500 hidden sm:table-cell cursor-pointer" onClick={() => toggleSort('covers')}>
                    Covers <SortIcon col="covers" />
                  </th>
                  <th className="px-3 py-3 text-right font-medium text-gray-500 hidden md:table-cell cursor-pointer" onClick={() => toggleSort('items')}>
                    Portions <SortIcon col="items" />
                  </th>
                  <th className="px-3 py-3 w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {loading && (
                  <tr><td colSpan={5} className="text-center py-12 text-gray-400">Loading…</td></tr>
                )}
                {!loading && displayed.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center py-12">
                      <div className="text-gray-400 mb-3">No sales recorded for this period</div>
                      <button onClick={() => setShowAdd(true)}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-gold text-white rounded-lg text-sm hover:bg-[#a88930]">
                        <Plus size={14} /> Add Sales Day
                      </button>
                    </td>
                  </tr>
                )}
                {displayed.map(sale => {
                  const rev      = Number(sale.totalRevenue)
                  const portions = sale.lineItems.reduce((s, l) => s + l.qtySold, 0)
                  const isSelected = selectedSale?.id === sale.id
                  return (
                    <tr key={sale.id}
                      onClick={() => setSelectedSale(isSelected ? null : sale)}
                      className={`cursor-pointer transition-colors ${isSelected ? 'bg-gold/10' : 'hover:bg-gray-50'}`}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-800">{fmtDate(sale.date)}</span>
                          {sale.revenueCenter && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-600">
                              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: rcHex(sale.revenueCenter.color) }} />
                              {sale.revenueCenter.name}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-400">{fmtDay(sale.date)}{sale.notes ? ` · ${sale.notes}` : ''}</div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="font-semibold text-gray-900">{formatCurrency(rev)}</div>
                        <div className="text-xs text-gray-400">{Math.round(Number(sale.foodSalesPct) * 100)}% food</div>
                      </td>
                      <td className="px-3 py-3 text-right hidden sm:table-cell">
                        <div className="font-medium text-gray-700">{sale.covers ?? '—'}</div>
                      </td>
                      <td className="px-3 py-3 text-right hidden md:table-cell">
                        <div className="font-medium text-gray-700">{portions > 0 ? portions : '—'}</div>
                      </td>
                      <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1 justify-end">
                          <button onClick={() => setEditSale(sale)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gold">
                            <Pencil size={13} />
                          </button>
                          <button onClick={() => setDeleteId(sale.id)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-red-500">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Week / Month mode — period list */}
        {granularity !== 'day' && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            {loading && (
              <div className="py-12 text-center text-gray-400">Loading…</div>
            )}
            {!loading && periodRows.length === 0 && (
              <div className="py-12 text-center text-gray-400">No sales data for this period</div>
            )}
            {periodRows.map(period => {
              const isSelected = selectedPeriodKey === period.key
              return (
                <div key={period.key}
                  onClick={() => setSelectedPeriodKey(isSelected ? null : period.key)}
                  className={`flex items-center gap-3 px-4 py-3.5 border-b border-gray-50 last:border-0 cursor-pointer transition-colors ${isSelected ? 'bg-gold/10' : 'hover:bg-gray-50'}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium text-gray-800">{period.label}</span>
                      <PeriodBadge badge={period.badge} text={period.badgeText} />
                    </div>
                    {period.totalRevenue > 0 && (
                      <div className="text-xs text-gray-400">
                        {formatCurrency(period.totalRevenue)} · {Math.round(period.foodSalesPct * 100)}% food
                      </div>
                    )}
                  </div>
                  {period.covers != null && period.covers > 0 && (
                    <div className="text-right shrink-0">
                      <div className="text-sm font-semibold text-gray-700">{period.covers}</div>
                      <div className="text-[10px] text-gray-400">covers</div>
                    </div>
                  )}
                  {period.badge === 'not-available' && (
                    <div className="text-sm text-gray-300">—</div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Right panel */}
      {(selectedSale || selectedPeriodKey) && (
        <div className="flex-1 min-w-0">

          {/* Day detail panel */}
          {selectedSale && (() => {
            const sale = selectedSale
            const revenue    = Number(sale.totalRevenue)
            const foodSales  = revenue * Number(sale.foodSalesPct)
            const totalSold  = sale.lineItems.reduce((s, li) => s + li.qtySold, 0)
            const avgPerCover = sale.covers && sale.covers > 0 ? revenue / sale.covers : null
            return (
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-gray-100">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-900">{fmtDate(sale.date)}</span>
                      {sale.revenueCenter && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-700">
                          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: rcHex(sale.revenueCenter.color) }} />
                          {sale.revenueCenter.name}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-400">{fmtDay(sale.date)}</div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => { setEditSale(sale); setSelectedSale(null) }}
                      className="flex items-center gap-1 px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-gray-50">
                      <Pencil size={11} /> Edit
                    </button>
                    <button onClick={() => setSelectedSale(null)}
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={16} /></button>
                  </div>
                </div>
                <div className="px-4 py-4 space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-gray-50 rounded-xl p-3 text-center">
                      <div className="text-lg font-bold text-gray-900">{formatCurrency(revenue)}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Revenue</div>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-3 text-center">
                      <div className="text-lg font-bold text-gray-900">{sale.covers ?? '—'}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Covers</div>
                    </div>
                    <div className="bg-gray-50 rounded-xl p-3 text-center">
                      <div className="text-lg font-bold text-gray-900">{avgPerCover ? formatCurrency(avgPerCover) : '—'}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Avg/Cover</div>
                    </div>
                  </div>
                  <div className="text-xs text-gray-500">
                    Food sales: <span className="font-medium text-gray-700">{formatCurrency(foodSales)}</span>
                    <span className="mx-1">·</span>{Math.round(Number(sale.foodSalesPct) * 100)}%
                    <span className="mx-1">·</span>{totalSold} portions
                  </div>
                  {sale.notes && (
                    <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-sm text-amber-800">{sale.notes}</div>
                  )}
                  {sale.lineItems.length > 0 ? (
                    <div>
                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Items sold</div>
                      <div className="divide-y divide-gray-50 border border-gray-100 rounded-xl overflow-hidden max-h-80 overflow-y-auto">
                        {sale.lineItems.map(li => {
                          const lineRevenue = li.recipe.menuPrice ? Number(li.recipe.menuPrice) * li.qtySold : null
                          return (
                            <div key={li.id} className="flex items-center gap-3 px-3 py-2.5">
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-gray-800 truncate">{li.recipe.name}</div>
                                {li.recipe.category && <div className="text-xs text-gray-400">{li.recipe.category.name}</div>}
                              </div>
                              <div className="text-right shrink-0">
                                <div className="text-sm font-semibold text-gray-800">×{li.qtySold}</div>
                                {lineRevenue && <div className="text-xs text-gray-400">{formatCurrency(lineRevenue)}</div>}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-4 text-sm text-gray-400">No menu items recorded</div>
                  )}
                </div>
              </div>
            )
          })()}

          {/* Period detail panel */}
          {selectedPeriodKey && (() => {
            const period = periodRows.find(p => p.key === selectedPeriodKey)
            if (!period) return null
            const foodSalesAmt = period.totalRevenue * period.foodSalesPct
            return (
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-gray-100">
                  <div>
                    <div className="text-sm font-semibold text-gray-900">{period.label}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <PeriodBadge badge={period.badge} text={period.badgeText} />
                    </div>
                  </div>
                  <button onClick={() => setSelectedPeriodKey(null)}
                    className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X size={16} /></button>
                </div>
                <div className="px-4 py-4 space-y-4">
                  {/* Summary card */}
                  {period.totalRevenue > 0 && (
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-gray-50 rounded-xl p-3 text-center">
                        <div className="text-lg font-bold text-gray-900">{formatCurrency(period.totalRevenue)}</div>
                        <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Revenue</div>
                      </div>
                      <div className="bg-gray-50 rounded-xl p-3 text-center">
                        <div className="text-lg font-bold text-gray-900">{formatCurrency(foodSalesAmt)}</div>
                        <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Food Sales</div>
                      </div>
                      <div className="bg-gray-50 rounded-xl p-3 text-center">
                        <div className="text-lg font-bold text-gray-900">{period.covers ?? '—'}</div>
                        <div className="text-[10px] text-gray-500 mt-0.5 uppercase tracking-wide">Covers</div>
                      </div>
                    </div>
                  )}
                  {period.badge === 'not-available' && (
                    <div className="text-center py-4 text-sm text-gray-400">No sales data for this period</div>
                  )}
                  {/* Direct import note */}
                  {(period.badge === 'weekly-import' || period.badge === 'monthly-import') && (
                    <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-xs text-blue-700">
                      Imported as {period.badge === 'weekly-import' ? 'Weekly' : 'Monthly'} — no per-day breakdown available.
                    </div>
                  )}
                  {/* Day breakdown (aggregated entries only) */}
                  {period.badge !== 'weekly-import' && period.badge !== 'monthly-import' && period.dailySales.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Day breakdown</div>
                      <div className="divide-y divide-gray-50 border border-gray-100 rounded-xl overflow-hidden">
                        {(() => {
                          // Generate all dates in the period range
                          const days: string[] = []
                          const cur = new Date(period.startDate)
                          const periodEndDate = new Date(period.endDate)
                          while (cur <= periodEndDate) {
                            days.push(toISO(cur))
                            cur.setDate(cur.getDate() + 1)
                          }
                          return days.map(day => {
                            const sale = period.dailySales.find(s => s.date.slice(0, 10) === day)
                            return (
                              <div key={day} className="flex items-center justify-between px-3 py-2">
                                <span className="text-sm text-gray-700">{fmtDate(day)}</span>
                                {sale ? (
                                  <span className="text-sm font-medium text-gray-900">{formatCurrency(Number(sale.totalRevenue))}</span>
                                ) : (
                                  <span className="text-sm text-gray-300">—</span>
                                )}
                              </div>
                            )
                          })
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })()}

        </div>
      )}
    </div>
  </>
)}
```

- [ ] **Step 7: Remove the old `DayDetail` modal**

Find the `{viewSale && <DayDetail .../>}` block (around line 1015) and delete it. The `DayDetail` component definition (around line 300–389) can remain in the file for now or be deleted — since the inline panel above duplicates its content, delete it to avoid dead code.

Also delete the `DayDetail` function definition (lines ~300–389).

- [ ] **Step 8: Verify build passes**

```bash
npm run build
```

Fix any TypeScript errors before committing.

- [ ] **Step 9: Commit**

```bash
git add src/app/sales/page.tsx
git commit -m "feat: add Day/Week/Month split-panel view with client-side period aggregation"
```

---

## Post-implementation verification

After all tasks are done:

- [ ] Start the dev server: `npm run dev`
- [ ] Navigate to `/sales`
- [ ] Verify Day mode shows the existing table, clicking a row opens the right panel
- [ ] Switch to Week mode — confirm week rows appear with correct revenue totals and badges
- [ ] Switch to Month mode — confirm month rows appear
- [ ] Click Import → upload a single-day ProductMix file → confirm single Date field shown
- [ ] Click Import → upload a multi-day ProductMix file (or rename any file to `ProductMix_2026-04-01_2026-04-30.xlsx`) → confirm From/To/Period Type fields appear
- [ ] Save a period import → verify it appears in the week/month list with the correct badge ("Weekly import" / "Monthly import")
- [ ] `npm run build` — final clean build check

---

## Out of Scope

- Per-day breakdown within a Toast weekly/monthly export (Toast doesn't include this)
- Overlap warnings when both a period import and daily entries exist
- Server-side aggregation for week/month rollups
- Editing `periodType` after import
- COGS / inventory usage route changes
