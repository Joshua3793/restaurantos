import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { PROVENANCE } from '@/lib/report-provenance'

// Reuse the live report handlers so the workbook matches the pages byte-for-byte.
// Auth flows through the ambient request cookies (requireSession reads next/headers),
// so invoking these within THIS request authenticates as the real user.
import { GET as dashboardGET } from '../dashboard/route'
import { GET as analyticsGET } from '../analytics/route'
import { GET as cogsGET } from '../cogs/route'
import { GET as prepGET } from '../prep/route'
import { GET as menuGET } from '../menu-engineering/route'
import { GET as theoreticalGET } from '../theoretical-usage/route'

export const dynamic = 'force-dynamic'

type AnyObj = Record<string, unknown>
const n = (v: unknown) => (v == null ? 0 : Number(v))
const money = (v: unknown) => Math.round(n(v) * 100) / 100

/**
 * GET /api/reports/export?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   &rcId=<id>&isDefault=true | &locationId=<id>
 *
 * Streams a multi-sheet .xlsx spanning every report (Summary, COGS, Sales,
 * Purchasing, Inventory, Prep, Menu Engineering) for the selected scope + range,
 * plus a Definitions sheet documenting how each number is derived. Every sheet is
 * produced by the same handlers the pages use, so exported figures always agree
 * with what's on screen.
 */
export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from') ?? ''
  const to   = searchParams.get('to')   ?? ''
  const rcId = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'
  const locationId = searchParams.get('locationId')

  // Human-readable scope label for the Summary sheet.
  let scopeLabel = 'All revenue centers'
  if (rcId) {
    const rc = await prisma.revenueCenter.findUnique({ where: { id: rcId }, select: { name: true } })
    scopeLabel = rc ? `Revenue center — ${rc.name}` : 'Revenue center'
  } else if (locationId) {
    const loc = await prisma.location.findUnique({ where: { id: locationId }, select: { name: true } })
    scopeLabel = loc ? `Location — ${loc.name}` : 'Location'
  }

  // Shared scope params + the two date-param conventions the handlers use.
  const scope = new URLSearchParams()
  if (rcId) { scope.set('rcId', rcId); if (isDefault) scope.set('isDefault', 'true') }
  else if (locationId) scope.set('locationId', locationId)

  const withFromTo = (extra?: Record<string, string>) => {
    const p = new URLSearchParams(scope); p.set('from', from); p.set('to', to)
    for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v)
    return p
  }
  const withStartEnd = () => {
    const p = new URLSearchParams(scope); p.set('startDate', from); p.set('endDate', to)
    return p
  }

  const call = async (
    handler: (r: NextRequest) => Promise<Response>, path: string, params: URLSearchParams,
  ): Promise<AnyObj | null> => {
    try {
      const res = await handler(new NextRequest(`http://internal${path}?${params.toString()}`))
      if (!res.ok) return null
      return (await res.json()) as AnyObj
    } catch { return null }
  }

  // Fetch every report in parallel.
  const [dashboard, cogs, sales, inventory, purchasing, prep, menu, theoretical] = await Promise.all([
    call(dashboardGET,   '/api/reports/dashboard',        withFromTo()),
    call(cogsGET,        '/api/reports/cogs',             withStartEnd()),
    call(analyticsGET,   '/api/reports/analytics',        withFromTo({ section: 'sales' })),
    call(analyticsGET,   '/api/reports/analytics',        withFromTo({ section: 'inventory' })),
    call(analyticsGET,   '/api/reports/analytics',        withFromTo({ section: 'purchasing' })),
    call(prepGET,        '/api/reports/prep',             withStartEnd()),
    call(menuGET,        '/api/reports/menu-engineering', withFromTo()),
    call(theoreticalGET, '/api/reports/theoretical-usage', withFromTo()),
  ])

  const wb = XLSX.utils.book_new()
  const addSheet = (name: string, rows: (string | number | null)[][]) => {
    const ws = XLSX.utils.aoa_to_sheet(rows)
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31)) // Excel sheet-name limit
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const summary: (string | number | null)[][] = [
    ["Fergie's OS — Reports Export"],
    ['Generated', new Date().toISOString()],
    ['Scope', scopeLabel],
    ['Date range', `${from} → ${to}`],
    [],
    ['KPI', 'Value', 'How it is computed'],
  ]
  if (dashboard) {
    summary.push(
      ['Revenue', money(dashboard.weeklyRevenue), PROVENANCE.revenue],
      ['Food sales (est.)', money(dashboard.weeklyFoodSales), PROVENANCE.salesFoodSales],
      ['Purchases', money(dashboard.weeklyPurchaseCost), PROVENANCE.purchases],
      ['Wastage', money(dashboard.weeklyWastageCost), PROVENANCE.wastage],
      ['Food cost % (purchases ÷ food sales)', dashboard.purchaseFoodCostPct == null ? '—' : Math.round(n(dashboard.purchaseFoodCostPct) * 10) / 10, PROVENANCE.heroFoodCost],
      ['Inventory value (on hand)', money(dashboard.totalInventoryValue), PROVENANCE.invValue],
    )
  }
  if (cogs) {
    summary.push(
      ['COGS', money(cogs.cogs), PROVENANCE.cogs],
      ['COGS %', Math.round(n(cogs.foodCostPct) * 10) / 10, PROVENANCE.cogsPct],
    )
  }
  addSheet('Summary', summary)

  // ── COGS ─────────────────────────────────────────────────────────────────
  if (cogs) {
    const begin = (cogs.beginningInventory ?? {}) as AnyObj
    const end = (cogs.endingInventory ?? {}) as AnyObj
    const purch = (cogs.purchases ?? {}) as AnyObj
    const rows: (string | number | null)[][] = [
      ['COGS', `${from} → ${to}`, scopeLabel],
      [],
      ['Component', 'Value', 'Basis'],
      ['Beginning inventory', money(begin.value), begin.sessionDate ? `Full count ${String(begin.sessionDate).slice(0, 10)}` : 'No count — purchases only'],
      ['+ Purchases', money(purch.total), `${n(purch.invoiceCount)} invoices`],
      ['− Ending inventory', money(end.value), end.sessionDate ? `Full count ${String(end.sessionDate).slice(0, 10)}` : 'No count'],
      ['= COGS', money(cogs.cogs), ''],
      ['Food sales', money(cogs.foodSales), ''],
      ['COGS %', Math.round(n(cogs.foodCostPct) * 10) / 10, ''],
      [],
      ['By category', 'Beginning', 'Purchases', 'Ending', 'COGS'],
    ]
    for (const c of (cogs.byCategory as AnyObj[] ?? [])) {
      rows.push([String(c.category), money(c.beginningValue), money(c.purchases), money(c.endingValue), money(c.cogs)])
    }
    addSheet('COGS', rows)
  }

  // ── Sales ────────────────────────────────────────────────────────────────
  if (sales) {
    const s = (sales.summary ?? {}) as AnyObj
    const rows: (string | number | null)[][] = [
      ['Sales', `${from} → ${to}`, scopeLabel],
      [],
      ['Total revenue', money(s.totalRevenue)],
      ['Food sales (est.)', money(s.totalFoodSales)],
      ['Service days (entries)', n(s.totalOrders)],
      [],
      ['Top menu items', 'Qty sold', 'Revenue', 'Menu price', 'Cost', 'Cost %'],
    ]
    for (const it of (sales.topMenuItems as AnyObj[] ?? [])) {
      rows.push([
        String(it.name), n(it.qty), money(it.revenue),
        it.menuPrice == null ? '—' : money(it.menuPrice),
        money(it.cost),
        it.foodCostPct == null ? '—' : Math.round(n(it.foodCostPct) * 10) / 10,
      ])
    }
    rows.push([], ['Weekly revenue', 'Revenue', 'Food sales'])
    for (const w of (sales.weeklyRevenue as AnyObj[] ?? [])) {
      rows.push([String(w.week), money(w.revenue), money(w.foodSales)])
    }
    addSheet('Sales', rows)
  }

  // ── Purchasing ─────────────────────────────────────────────────────────────
  if (purchasing) {
    const s = (purchasing.summary ?? {}) as AnyObj
    const rows: (string | number | null)[][] = [
      ['Purchasing', `${from} → ${to}`, scopeLabel],
      [],
      ['Total spend', money(s.totalSpend)],
      ['Invoice lines', n(s.totalLines)],
      ['Suppliers', n(s.supplierCount)],
      [],
      ['Spend by supplier', 'Spend', 'Lines'],
    ]
    for (const sp of (purchasing.supplierSpend as AnyObj[] ?? [])) {
      rows.push([String(sp.name), money(sp.spend), n(sp.lines)])
    }
    rows.push([], ['Top items by spend', 'Spend', 'Qty', 'Category'])
    for (const it of (purchasing.topItems as AnyObj[] ?? [])) {
      rows.push([String(it.name), money(it.spend), n(it.qty), String(it.category ?? '')])
    }
    addSheet('Purchasing', rows)
  }

  // ── Inventory ──────────────────────────────────────────────────────────────
  if (inventory) {
    const s = (inventory.summary ?? {}) as AnyObj
    const rows: (string | number | null)[][] = [
      ['Inventory', `as of export`, scopeLabel],
      [],
      ['Inventory value', money(s.totalValue)],
      ['Active items', n(s.totalItems)],
      ['Not counted 30d+', n(s.notCounted30)],
      ['Price changes in range', n(s.priceChanges)],
      [],
      ['Top value items', 'Category', 'Supplier', 'Stock', 'Value'],
    ]
    for (const it of (inventory.topValueItems as AnyObj[] ?? [])) {
      rows.push([String(it.name), String(it.category ?? ''), String(it.supplier ?? ''), Math.round(n(it.stock) * 100) / 100, money(it.value)])
    }
    rows.push([], ['Value by category', 'Value', 'Item count'])
    for (const c of (inventory.byCategory as AnyObj[] ?? [])) {
      rows.push([String(c.cat), money(c.value), n(c.count)])
    }
    addSheet('Inventory', rows)
  }

  // ── Prep ───────────────────────────────────────────────────────────────────
  if (prep) {
    const t = (prep.totals ?? {}) as AnyObj
    const rows: (string | number | null)[][] = [
      ['Prep', `${from} → ${to}`, scopeLabel],
      [],
      ['Total logged', n(t.total)],
      ['Completed (done + partial)', n(t.done) + n(t.partial)],
      ['Blocked', n(t.blocked)],
      ['Completion rate %', n(t.completionRate)],
      [],
      ['Most prepped items', 'Times done', 'Total qty', 'Avg qty', 'Unit'],
    ]
    for (const it of (prep.topItems as AnyObj[] ?? [])) {
      rows.push([String(it.name), n(it.doneCount), Math.round(n(it.totalQty) * 100) / 100, Math.round(n(it.avgQty) * 100) / 100, String(it.unit ?? '')])
    }
    addSheet('Prep', rows)
  }

  // ── Menu Engineering ───────────────────────────────────────────────────────
  if (menu) {
    const rows: (string | number | null)[][] = [
      ['Menu Engineering', `${from} → ${to}`, scopeLabel],
      ['Median popularity', n(menu.medianPopularity), 'Median margin', money(menu.medianMargin)],
      [],
      ['Dish', 'Quadrant', 'Qty sold', 'Menu price', 'Cost/portion', 'Margin', 'Cost %'],
    ]
    for (const d of (menu.dishes as AnyObj[] ?? [])) {
      rows.push([
        String(d.name), String(d.quadrant ?? '—'), n(d.qtySold),
        d.menuPrice == null ? '—' : money(d.menuPrice),
        d.costPerPortion == null ? '—' : money(d.costPerPortion),
        d.margin == null ? '—' : money(d.margin),
        d.foodCostPct == null ? '—' : Math.round(n(d.foodCostPct) * 10) / 10,
      ])
    }
    addSheet('Menu Engineering', rows)
  }

  // ── Theoretical usage (if counts bracket the range) ────────────────────────
  if (theoretical && Array.isArray(theoretical.rows)) {
    const meta = (theoretical.meta ?? {}) as AnyObj
    const rows: (string | number | null)[][] = [
      ['Theoretical vs Actual Usage', `${from} → ${to}`, scopeLabel],
      ['Portions sold', n(meta.totalSales), 'Theoretical COGS', money(meta.totalTheoreticalCost)],
      [],
      ['Ingredient', 'Theoretical use', 'Unit', 'Theoretical cost', 'Actual use', 'Gap', 'Gap cost'],
    ]
    for (const r of (theoretical.rows as AnyObj[])) {
      rows.push([
        String(r.itemName), n(r.theoreticalQty), String(r.baseUnit ?? ''),
        money(r.theoreticalCost),
        r.actualQty == null ? '—' : n(r.actualQty),
        r.gap == null ? '—' : n(r.gap),
        r.gapCost == null ? '—' : money(r.gapCost),
      ])
    }
    addSheet('Theoretical Usage', rows)
  }

  // ── Definitions ────────────────────────────────────────────────────────────
  const defRows: (string | number | null)[][] = [
    ['Definitions — how each number is derived'],
    ['All money figures derive $/base-unit from each item’s pack chain at read time (never a stored price).'],
    [],
    ['KPI', 'Derivation'],
  ]
  const DEF_LABELS: Record<keyof typeof PROVENANCE, string> = {
    heroFoodCost: 'Food cost % (overview)', revenue: 'Revenue', purchases: 'Purchases', wastage: 'Wastage',
    onHand: 'On hand', targetPct: 'Target %', topValueDrivers: 'Top inventory value drivers', recipeDrift: 'Recipe drift',
    cogsBeginning: 'COGS — beginning inventory', cogsPurchases: 'COGS — purchases', cogsEnding: 'COGS — ending inventory', cogs: 'COGS', cogsPct: 'COGS %',
    salesTotalRevenue: 'Sales — total revenue', salesFoodSales: 'Sales — food sales', salesServiceDays: 'Sales — service days', salesTopItems: 'Sales — top menu items', salesFoodCostAlerts: 'Sales — food cost alerts',
    purchTotalSpend: 'Purchasing — total spend', purchBySupplier: 'Purchasing — spend by supplier', purchTopItems: 'Purchasing — top items', purchMultiSupplier: 'Purchasing — multi-supplier',
    invValue: 'Inventory value', invActiveItems: 'Inventory — active items', invNotCounted30: 'Inventory — not counted 30d', invPriceChanges: 'Inventory — price changes', invValueTrend: 'Inventory — value trend',
    prepTotalLogged: 'Prep — total logged', prepCompleted: 'Prep — completed', prepBlocked: 'Prep — blocked', prepCompletionRate: 'Prep — completion rate', prepMostPrepped: 'Prep — most prepped',
    menuQuadrants: 'Menu engineering — quadrants',
    tuPortionsSold: 'Theoretical usage — portions sold', tuTheoreticalCost: 'Theoretical usage — theoretical cost', tuUnaccountedLoss: 'Theoretical usage — unaccounted loss',
  }
  for (const [key, text] of Object.entries(PROVENANCE)) {
    defRows.push([DEF_LABELS[key as keyof typeof PROVENANCE] ?? key, text])
  }
  addSheet('Definitions', defRows)

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const scopeSlug = rcId ? 'rc' : locationId ? 'location' : 'all'
  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="reports-${scopeSlug}-${from}_to_${to}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  })
}
