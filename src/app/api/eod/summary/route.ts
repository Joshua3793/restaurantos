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

  const [sales, waste, priceAlerts, purchases] = await Promise.all([
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
    // Intentionally GLOBAL (not RC/location-scoped): PriceAlert has no revenueCenterId,
    // so — like the sibling reports/dashboard price-signal queries — it is deliberately unscoped.
    prisma.priceAlert.findMany({
      where: { createdAt: win },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: {
        id: true, previousPrice: true, newPrice: true, changePct: true, direction: true,
        inventoryItem: { select: { itemName: true } },
      },
    }),
    // Food cost $ today = today's approved purchases (numerator basis used elsewhere).
    prisma.invoiceScanItem.aggregate({
      where: {
        approved: true, splitToSessionId: null,
        session: {
          approvedAt: win,
          // InvoiceSession.revenueCenterId is NULLABLE → location lens also surfaces null rows.
          ...(locRcIds
            ? { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] }
            : rcId ? { revenueCenterId: rcId } : {}),
        },
      },
      _sum: { rawLineTotal: true },
    }),
  ])

  // ── Headline numbers ──────────────────────────────────────────────────────
  const netSales = sales.reduce((s, e) => s + Number(e.totalRevenue), 0)
  const foodSales = sales.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
  const covers = sales.reduce((s, e) => s + (e.covers ?? 0), 0)
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
  // Slow movers = lowest sellers NOT already shown as top sellers (may be empty on a
  // small-menu day — that's correct; the UI handles an empty array).
  const topIds = new Set(topSellers.map(m => m.id))
  const slowMovers = [...movers].filter(m => !topIds.has(m.id)).sort((a, b) => a.units - b.units).slice(0, 4)

  const wasteFlags = waste.map(w => ({
    id: w.id,
    name: w.inventoryItem?.itemName ?? 'Unknown item',
    meta: `${Number(w.qtyWasted)} ${w.unit} · ${w.reason.toLowerCase()}`,
    loggedBy: w.loggedBy,
    cost: Number(w.costImpact),
  }))

  const priceFlags = priceAlerts.map(p => ({
    id: p.id,
    name: p.inventoryItem?.itemName ?? 'Unknown item',
    pct: p.changePct == null ? null : Number(p.changePct),
    direction: p.direction,
    previousPrice: Number(p.previousPrice),
    newPrice: Number(p.newPrice),
  }))

  return NextResponse.json({
    date: win.gte.toISOString().slice(0, 10),
    netSales, foodSales, covers,
    foodCostDollars, foodCostPct, avgSpend,
    topSellers, slowMovers, wasteFlags, priceFlags,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
