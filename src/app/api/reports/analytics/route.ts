import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

function startOf(daysAgo: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(0, 0, 0, 0)
  return d
}

function isoDate(d: Date) {
  return d.toISOString().split('T')[0]
}

// ── GET /api/reports/analytics?section=overview|sales|inventory|purchasing&days=30 ──
export async function GET(req: NextRequest) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const section = searchParams.get('section') ?? 'overview'
  const days    = parseInt(searchParams.get('days') ?? '30', 10)
  const since   = startOf(days)
  const prevSince = startOf(days * 2)

  try {
    if (section === 'overview') return NextResponse.json(await getOverview(since, prevSince, days))
    if (section === 'sales')    return NextResponse.json(await getSales(since, days))
    if (section === 'inventory') return NextResponse.json(await getInventory(since))
    if (section === 'purchasing') return NextResponse.json(await getPurchasing(since, days))
    return NextResponse.json({ error: 'Unknown section' }, { status: 400 })
  } catch (err) {
    console.error('[analytics]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// ── Overview ─────────────────────────────────────────────────────────────────
async function getOverview(since: Date, prevSince: Date, days: number) {
  const [
    salesCur, salesPrev,
    wastageCur, wastagePrev,
    inventoryItems,
    priceAlerts,
    countSessions,
    purchasesCur, purchasesPrev,
  ] = await Promise.all([
    prisma.salesEntry.aggregate({ where: { date: { gte: since } }, _sum: { totalRevenue: true, foodSalesPct: true }, _count: true }),
    prisma.salesEntry.aggregate({ where: { date: { gte: prevSince, lt: since } }, _sum: { totalRevenue: true }, _count: true }),
    prisma.wastageLog.aggregate({ where: { date: { gte: since } }, _sum: { costImpact: true } }),
    prisma.wastageLog.aggregate({ where: { date: { gte: prevSince, lt: since } }, _sum: { costImpact: true } }),
    prisma.inventoryItem.findMany({
      where: { isActive: true },
      select: { stockOnHand: true, pricePerBaseUnit: true, category: true,
        stockAllocations: { select: { quantity: true } } },
    }),
    prisma.priceAlert.findMany({
      where: { acknowledged: false },
      select: { id: true, inventoryItemId: true, changePct: true, direction: true, newPrice: true, previousPrice: true, createdAt: true,
        inventoryItem: { select: { itemName: true } },
        session: { select: { supplierName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.countSession.findMany({
      where: { status: 'FINALIZED', finalizedAt: { gte: since } },
      select: { finalizedAt: true, totalCountedValue: true, label: true },
      orderBy: { finalizedAt: 'desc' },
      take: 1,
    }),
    // Purchases current period
    prisma.invoiceScanItem.aggregate({
      where: { approved: true, session: { approvedAt: { gte: since } } },
      _sum: { rawLineTotal: true },
    }),
    prisma.invoiceScanItem.aggregate({
      where: { approved: true, session: { approvedAt: { gte: prevSince, lt: since } } },
      _sum: { rawLineTotal: true },
    }),
  ])

  const totalRevenue   = Number(salesCur._sum.totalRevenue ?? 0)
  const prevRevenue    = Number(salesPrev._sum.totalRevenue ?? 0)
  const totalWastage   = Number(wastageCur._sum.costImpact ?? 0)
  const prevWastage    = Number(wastagePrev._sum.costImpact ?? 0)
  const purchasesCurVal  = Number(purchasesCur._sum.rawLineTotal ?? 0)
  const purchasesPrevVal = Number(purchasesPrev._sum.rawLineTotal ?? 0)

  const inventoryValue = inventoryItems.reduce((s, i) => {
    const totalStock = Number(i.stockOnHand) + i.stockAllocations.reduce((a, r) => a + Number(r.quantity), 0)
    return s + totalStock * Number(i.pricePerBaseUnit)
  }, 0)

  // Average food cost % from sales entries in period
  const salesEntries = await prisma.salesEntry.findMany({
    where: { date: { gte: since } },
    select: { totalRevenue: true, foodSalesPct: true },
  })
  let totalFoodSales = 0, totalFoodCost = 0
  // We don't have totalCost per entry; estimate from wastage is a proxy
  const avgFoodCostPct = salesEntries.length > 0
    ? salesEntries.reduce((s, e) => s + Number(e.foodSalesPct) * 100, 0) / salesEntries.length
    : 0

  // Revenue trend (daily for last N days)
  const dailySales = await prisma.salesEntry.groupBy({
    by: ['date'],
    where: { date: { gte: since } },
    _sum: { totalRevenue: true },
    orderBy: { date: 'asc' },
  })
  const revenueTrend = dailySales.map(d => ({
    date: isoDate(d.date),
    revenue: Number(d._sum.totalRevenue ?? 0),
  }))

  // Inventory by category
  const byCategory: Record<string, number> = {}
  for (const i of inventoryItems) {
    const val = Number(i.stockOnHand) * Number(i.pricePerBaseUnit)
    byCategory[i.category] = (byCategory[i.category] ?? 0) + val
  }

  return {
    period: days,
    kpis: {
      revenue:       { value: totalRevenue,     prev: prevRevenue,    change: prevRevenue > 0 ? ((totalRevenue - prevRevenue) / prevRevenue) * 100 : null },
      wastage:       { value: totalWastage,     prev: prevWastage,    change: prevWastage > 0 ? ((totalWastage - prevWastage) / prevWastage) * 100 : null },
      inventoryValue:{ value: inventoryValue,   prev: null,           change: null },
      purchases:     { value: purchasesCurVal,  prev: purchasesPrevVal, change: purchasesPrevVal > 0 ? ((purchasesCurVal - purchasesPrevVal) / purchasesPrevVal) * 100 : null },
      priceAlerts:   { value: priceAlerts.length, prev: null, change: null },
    },
    revenueTrend,
    inventoryByCategory: Object.entries(byCategory).map(([cat, value]) => ({ cat, value })).sort((a, b) => b.value - a.value),
    recentAlerts: priceAlerts,
    lastCount: countSessions[0] ?? null,
  }
}

// ── Sales ─────────────────────────────────────────────────────────────────────
async function getSales(since: Date, days: number) {
  const [salesEntries, topItems, weeklyData] = await Promise.all([
    prisma.salesEntry.findMany({
      where: { date: { gte: since } },
      include: { lineItems: { include: { recipe: { select: { name: true, menuPrice: true } } } } },
      orderBy: { date: 'asc' },
    }),
    // top menu items by qty sold
    prisma.saleLineItem.groupBy({
      by: ['recipeId'],
      where: { sale: { date: { gte: since } } },
      _sum: { qtySold: true },
      orderBy: { _sum: { qtySold: 'desc' } },
      take: 15,
    }),
    // weekly revenue + food sales
    prisma.salesEntry.findMany({
      where: { date: { gte: since } },
      select: { date: true, totalRevenue: true, foodSalesPct: true },
      orderBy: { date: 'asc' },
    }),
  ])

  // Enrich top items with recipe details
  const recipeIds = topItems.map(t => t.recipeId)
  const recipes = await prisma.recipe.findMany({
    where: { id: { in: recipeIds } },
    select: { id: true, name: true, menuPrice: true },
  })
  const recipeMap = Object.fromEntries(recipes.map(r => [r.id, r]))

  const topMenuItems = topItems.map(t => {
    const recipe = recipeMap[t.recipeId]
    const qty    = Number(t._sum.qtySold ?? 0)
    const revenue = recipe?.menuPrice ? Number(recipe.menuPrice) * qty : 0
    return {
      recipeId: t.recipeId,
      name:     recipe?.name ?? 'Unknown',
      qty,
      revenue,
      cost:        0,
      menuPrice:   recipe?.menuPrice ? Number(recipe.menuPrice) : null,
      foodCostPct: null as number | null,
    }
  }).sort((a, b) => b.qty - a.qty)

  // Group daily sales into weekly buckets
  const weekMap = new Map<string, { revenue: number; foodSales: number; count: number }>()
  for (const s of weeklyData) {
    const d   = new Date(s.date)
    const dow = d.getDay()
    const mon = new Date(d)
    mon.setDate(d.getDate() - ((dow + 6) % 7))
    const key = isoDate(mon)
    const existing = weekMap.get(key) ?? { revenue: 0, foodSales: 0, count: 0 }
    existing.revenue   += Number(s.totalRevenue)
    existing.foodSales += Number(s.totalRevenue) * Number(s.foodSalesPct)
    existing.count++
    weekMap.set(key, existing)
  }

  const weeklyRevenue = Array.from(weekMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, d]) => ({
      week: `w/e ${new Date(new Date(week).setDate(new Date(week).getDate() + 6)).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`,
      revenue: d.revenue,
      foodSales: d.foodSales,
    }))

  // Food cost alerts: menu items where foodCostPct > 35%
  const foodCostAlerts = topMenuItems.filter(i => i.foodCostPct !== null && i.foodCostPct > 35)

  // Revenue summary
  const totalRevenue = salesEntries.reduce((s, e) => s + Number(e.totalRevenue), 0)
  const totalFoodSales = salesEntries.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
  const totalOrders = salesEntries.length

  return {
    summary: { totalRevenue, totalFoodSales, totalOrders },
    topMenuItems,
    weeklyRevenue,
    foodCostAlerts,
    period: days,
  }
}

// ── Inventory ─────────────────────────────────────────────────────────────────
async function getInventory(since: Date) {
  const [priceAlerts, items, countSessions] = await Promise.all([
    prisma.priceAlert.findMany({
      where: { createdAt: { gte: since } },
      include: { inventoryItem: { select: { itemName: true, category: true, supplier: { select: { name: true } } } },
        session: { select: { supplierName: true, invoiceDate: true } } },
      orderBy: { changePct: 'desc' },
    }),
    prisma.inventoryItem.findMany({
      where: { isActive: true },
      select: {
        id: true, itemName: true, category: true,
        stockOnHand: true, pricePerBaseUnit: true,
        purchasePrice: true, lastCountDate: true,
        supplier: { select: { name: true } },
      },
      orderBy: { itemName: 'asc' },
    }),
    prisma.countSession.findMany({
      where: { status: 'FINALIZED' },
      select: { id: true, sessionDate: true, finalizedAt: true, totalCountedValue: true, label: true },
      orderBy: { sessionDate: 'desc' },
      take: 6,
    }),
  ])

  const now = new Date()

  // Items never counted or not counted in 30+ days
  const notCounted30 = items.filter(i => {
    if (!i.lastCountDate) return true
    const diff = (now.getTime() - new Date(i.lastCountDate).getTime()) / (1000 * 60 * 60 * 24)
    return diff > 30
  }).length

  // Price increases vs decreases
  const priceIncreases = priceAlerts.filter(a => a.direction === 'UP')
  const priceDecreases = priceAlerts.filter(a => a.direction === 'DOWN')

  // Top price changes (biggest % change)
  const topPriceChanges = priceAlerts
    .sort((a, b) => Math.abs(Number(b.changePct)) - Math.abs(Number(a.changePct)))
    .slice(0, 10)
    .map(a => ({
      item:        a.inventoryItem.itemName,
      category:    a.inventoryItem.category,
      supplier:    a.session?.supplierName ?? a.inventoryItem.supplier?.name ?? '—',
      previousPrice: Number(a.previousPrice),
      newPrice:    Number(a.newPrice),
      changePct:   Number(a.changePct),
      direction:   a.direction,
      date:        a.createdAt,
    }))

  // Suppliers with most price changes
  const supplierChanges: Record<string, { ups: number; downs: number; totalChangePct: number }> = {}
  for (const a of priceAlerts) {
    const sup = a.session?.supplierName ?? a.inventoryItem.supplier?.name ?? 'Unknown'
    if (!supplierChanges[sup]) supplierChanges[sup] = { ups: 0, downs: 0, totalChangePct: 0 }
    if (a.direction === 'UP') supplierChanges[sup].ups++
    else supplierChanges[sup].downs++
    supplierChanges[sup].totalChangePct += Math.abs(Number(a.changePct))
  }
  const supplierVolatility = Object.entries(supplierChanges)
    .map(([name, d]) => ({ name, changes: d.ups + d.downs, ups: d.ups, downs: d.downs, avgChange: d.totalChangePct / (d.ups + d.downs) }))
    .sort((a, b) => b.changes - a.changes)
    .slice(0, 8)

  // Inventory value by category
  const byCategory: Record<string, { value: number; count: number }> = {}
  for (const i of items) {
    const val = Number(i.stockOnHand) * Number(i.pricePerBaseUnit)
    if (!byCategory[i.category]) byCategory[i.category] = { value: 0, count: 0 }
    byCategory[i.category].value += val
    byCategory[i.category].count++
  }

  // Top value items
  const topValueItems = items
    .map(i => ({ ...i, invValue: Number(i.stockOnHand) * Number(i.pricePerBaseUnit) }))
    .sort((a, b) => b.invValue - a.invValue)
    .slice(0, 10)
    .map(i => ({ name: i.itemName, category: i.category, supplier: i.supplier?.name ?? '—', value: i.invValue, stock: Number(i.stockOnHand) }))

  // Inventory value trend from count sessions
  const valueTrend = countSessions.map(s => ({
    label: s.label,
    date:  isoDate(s.sessionDate),
    value: Number(s.totalCountedValue),
  })).reverse()

  const totalValue = items.reduce((s, i) => s + Number(i.stockOnHand) * Number(i.pricePerBaseUnit), 0)

  return {
    summary: { totalValue, totalItems: items.length, notCounted30, priceChanges: priceAlerts.length, priceIncreases: priceIncreases.length, priceDecreases: priceDecreases.length },
    topPriceChanges,
    supplierVolatility,
    topValueItems,
    valueTrend,
    byCategory: Object.entries(byCategory).map(([cat, d]) => ({ cat, ...d })).sort((a, b) => b.value - a.value),
  }
}

// ── Purchasing ────────────────────────────────────────────────────────────────
async function getPurchasing(since: Date, days: number) {
  const [scanItems, supplierPrices] = await Promise.all([
    prisma.invoiceScanItem.findMany({
      where: { approved: true, session: { approvedAt: { gte: since } } },
      select: {
        rawDescription: true, rawQty: true, rawUnitPrice: true, rawLineTotal: true,
        matchedItem: { select: { itemName: true, category: true } },
        session: { select: { supplierName: true, supplierId: true, approvedAt: true } },
      },
    }),
    prisma.inventorySupplierPrice.findMany({
      where: { lastUpdated: { gte: since } },
      include: { inventoryItem: { select: { itemName: true, category: true } }, supplier: { select: { name: true } } },
      orderBy: { lastUpdated: 'desc' },
      take: 50,
    }),
  ])

  // Spend by supplier
  const bySupplier: Record<string, { spend: number; invoices: Set<string>; lines: number }> = {}
  for (const item of scanItems) {
    const sup = item.session.supplierName ?? 'Unknown'
    if (!bySupplier[sup]) bySupplier[sup] = { spend: 0, invoices: new Set(), lines: 0 }
    bySupplier[sup].spend += Number(item.rawLineTotal ?? 0)
    bySupplier[sup].lines++
  }
  const supplierSpend = Object.entries(bySupplier)
    .map(([name, d]) => ({ name, spend: d.spend, lines: d.lines }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10)

  // Top items by spend
  const byItem: Record<string, { spend: number; qty: number; category: string }> = {}
  for (const item of scanItems) {
    const name = item.matchedItem?.itemName ?? item.rawDescription
    const cat  = item.matchedItem?.category ?? '—'
    if (!byItem[name]) byItem[name] = { spend: 0, qty: 0, category: cat }
    byItem[name].spend += Number(item.rawLineTotal ?? 0)
    byItem[name].qty   += Number(item.rawQty ?? 0)
  }
  const topItems = Object.entries(byItem)
    .map(([name, d]) => ({ name, ...d }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 15)

  const totalSpend = scanItems.reduce((s, i) => s + Number(i.rawLineTotal ?? 0), 0)
  const totalLines = scanItems.length

  // Weekly spend trend
  const weeklySpend: Record<string, number> = {}
  for (const item of scanItems) {
    if (!item.session.approvedAt) continue
    const d = new Date(item.session.approvedAt)
    const dow = d.getDay()
    const mon = new Date(d)
    mon.setDate(d.getDate() - ((dow + 6) % 7))
    const key = isoDate(mon)
    weeklySpend[key] = (weeklySpend[key] ?? 0) + Number(item.rawLineTotal ?? 0)
  }
  const spendTrend = Object.entries(weeklySpend)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, spend]) => ({
      week: `w/e ${new Date(new Date(week).setDate(new Date(week).getDate() + 6)).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`,
      spend,
    }))

  return {
    summary: { totalSpend, totalLines, supplierCount: supplierSpend.length },
    supplierSpend,
    topItems,
    spendTrend,
    period: days,
  }
}
