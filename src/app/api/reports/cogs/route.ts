import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// ── GET /api/reports/cogs ─────────────────────────────────────────────────────
// Without params → legacy dashboard data (weekly trends, wastage, inventory)
// With ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD → COGS calculation
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const startDateStr = searchParams.get('startDate')
  const endDateStr   = searchParams.get('endDate')

  // ── Legacy dashboard mode ─────────────────────────────────────────────────
  if (!startDateStr || !endDateStr) {
    const now = new Date()
    const eightWeeksAgo = new Date(now)
    eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56)

    const [sales, wastage, inventory] = await Promise.all([
      prisma.salesEntry.findMany({ where: { date: { gte: eightWeeksAgo } }, orderBy: { date: 'asc' } }),
      prisma.wastageLog.findMany({ where: { date: { gte: eightWeeksAgo } }, include: { inventoryItem: true } }),
      prisma.inventoryItem.findMany(),
    ])

    const weeklyData: Record<string, { week: string; revenue: number; wastage: number; foodCostPct: number }> = {}
    for (const s of sales) {
      const ws = new Date(s.date); ws.setDate(ws.getDate() - ws.getDay())
      const key = ws.toISOString().slice(0, 10)
      if (!weeklyData[key]) weeklyData[key] = { week: key, revenue: 0, wastage: 0, foodCostPct: 0 }
      weeklyData[key].revenue += Number(s.totalRevenue)
    }
    for (const w of wastage) {
      const ws = new Date(w.date); ws.setDate(ws.getDate() - ws.getDay())
      const key = ws.toISOString().slice(0, 10)
      if (!weeklyData[key]) weeklyData[key] = { week: key, revenue: 0, wastage: 0, foodCostPct: 0 }
      weeklyData[key].wastage += Number(w.costImpact)
    }
    const weeklyArray = Object.values(weeklyData)
      .map(w => ({ ...w, foodCostPct: w.revenue > 0 ? (w.wastage / w.revenue) * 100 : 0 }))
      .sort((a, b) => a.week.localeCompare(b.week))

    const wastageByCategory: Record<string, number> = {}
    for (const w of wastage) {
      const cat = w.inventoryItem.category
      wastageByCategory[cat] = (wastageByCategory[cat] || 0) + Number(w.costImpact)
    }
    const inventoryByCategory: Record<string, number> = {}
    for (const item of inventory) {
      const cat = item.category
      inventoryByCategory[cat] = (inventoryByCategory[cat] || 0) +
        Number(item.stockOnHand) * Number(item.pricePerBaseUnit)
    }
    const wastageByItem: Record<string, { name: string; cost: number }> = {}
    for (const w of wastage) {
      if (!wastageByItem[w.inventoryItemId])
        wastageByItem[w.inventoryItemId] = { name: w.inventoryItem.itemName, cost: 0 }
      wastageByItem[w.inventoryItemId].cost += Number(w.costImpact)
    }
    const topWasted = Object.values(wastageByItem).sort((a, b) => b.cost - a.cost).slice(0, 10)
    return NextResponse.json({ weeklyData: weeklyArray, wastageByCategory, inventoryByCategory, topWasted })
  }

  // ── COGS mode ─────────────────────────────────────────────────────────────
  const rangeStart = new Date(startDateStr)
  const rangeEnd   = new Date(endDateStr + 'T23:59:59.999Z')

  // All finalized sessions ordered by finalizedAt asc (Prisma returns Date objects)
  const allSessions = await prisma.countSession.findMany({
    where:   { status: 'FINALIZED' },
    orderBy: { finalizedAt: 'asc' },
    include: { snapshots: true },
  })

  // Helper: get ms from either a Prisma Date or raw integer (legacy TEXT rows)
  const ms = (v: Date | number | string | null | undefined): number => {
    if (!v) return 0
    if (v instanceof Date) return v.getTime()
    if (typeof v === 'number') return v
    return new Date(String(v).replace(' ', 'T')).getTime()
  }

  const startMs = rangeStart.getTime()
  const endMs   = rangeEnd.getTime()

  // Sort by finalizedAt ms (handles mixed storage formats)
  allSessions.sort((a, b) => ms(a.finalizedAt as never) - ms(b.finalizedAt as never))

  // Beginning: most recent session finalizedAt ≤ startDate
  const beginSession = [...allSessions].reverse().find(s => ms(s.finalizedAt as never) <= startMs) ?? null

  // Ending: most recent session finalizedAt ≤ endDate
  const endSession = [...allSessions].reverse().find(s => ms(s.finalizedAt as never) <= endMs) ?? null

  // Compute beginning inventory value
  let beginningValue = 0
  let beginningFallback = false
  const beginByCategory: Record<string, number> = {}
  if (beginSession) {
    for (const snap of beginSession.snapshots) {
      const v = Number(snap.totalValue)
      beginningValue += v
      beginByCategory[snap.category] = (beginByCategory[snap.category] || 0) + v
    }
  } else {
    beginningFallback = true
    const items = await prisma.inventoryItem.findMany()
    for (const item of items) {
      const v = Number(item.stockOnHand) * Number(item.pricePerBaseUnit)
      beginningValue += v
      beginByCategory[item.category] = (beginByCategory[item.category] || 0) + v
    }
  }

  // Compute ending inventory value
  let endingValue = 0
  let endingFallback = false
  const endByCategory: Record<string, number> = {}
  if (endSession) {
    for (const snap of endSession.snapshots) {
      const v = Number(snap.totalValue)
      endingValue += v
      endByCategory[snap.category] = (endByCategory[snap.category] || 0) + v
    }
  } else {
    endingFallback = true
  }

  // Purchases in range — from legacy Invoice model
  const invoices = await prisma.invoice.findMany({
    where: {
      invoiceDate: { gte: rangeStart, lte: rangeEnd },
      status:      { not: 'CANCELLED' },
    },
    include: {
      lineItems: { include: { inventoryItem: { select: { category: true } } } },
    },
  })
  let totalPurchases = 0
  const purchasesByCategory: Record<string, number> = {}
  for (const inv of invoices) {
    for (const li of inv.lineItems) {
      const amt = Number(li.lineTotal)
      totalPurchases += amt
      const cat = li.inventoryItem.category
      purchasesByCategory[cat] = (purchasesByCategory[cat] || 0) + amt
    }
  }

  // Also include purchases from approved InvoiceSessions (scanner invoices)
  const invoiceSessions = await prisma.invoiceSession.findMany({
    where: {
      status:    'APPROVED',
      approvedAt: { gte: rangeStart, lte: rangeEnd },
    },
    include: {
      scanItems: {
        where: { approved: true, action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] } },
        include: { matchedItem: { select: { category: true } } },
      },
    },
  })
  for (const sess of invoiceSessions) {
    for (const item of sess.scanItems) {
      if (item.rawLineTotal !== null) {
        const amt = Number(item.rawLineTotal)
        totalPurchases += amt
        const cat = item.matchedItem?.category || 'UNCATEGORIZED'
        purchasesByCategory[cat] = (purchasesByCategory[cat] || 0) + amt
      } else if (item.rawQty !== null && item.newPrice !== null) {
        const amt = Number(item.rawQty) * Number(item.newPrice)
        totalPurchases += amt
        const cat = item.matchedItem?.category || 'UNCATEGORIZED'
        purchasesByCategory[cat] = (purchasesByCategory[cat] || 0) + amt
      }
    }
  }

  // Food sales
  const salesEntries = await prisma.salesEntry.findMany({
    where: { date: { gte: rangeStart, lte: rangeEnd } },
  })
  const foodSales = salesEntries.reduce(
    (s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0
  )

  const cogs = Math.round((beginningValue + totalPurchases - endingValue) * 100) / 100
  const foodCostPct = foodSales > 0 ? Math.round((cogs / foodSales) * 10000) / 100 : 0

  // By category breakdown
  const allCats = new Set([
    ...Object.keys(beginByCategory),
    ...Object.keys(endByCategory),
    ...Object.keys(purchasesByCategory),
  ])
  const byCategory = Array.from(allCats).map(category => {
    const bv = beginByCategory[category] || 0
    const ev = endByCategory[category] || 0
    const pv = purchasesByCategory[category] || 0
    return { category, beginningValue: bv, endingValue: ev, purchases: pv, cogs: Math.round((bv + pv - ev) * 100) / 100 }
  }).sort((a, b) => a.category.localeCompare(b.category))

  return NextResponse.json({
    startDate: startDateStr,
    endDate:   endDateStr,
    beginningInventory: beginSession
      ? { value: beginningValue, sessionDate: beginSession.sessionDate, sessionId: beginSession.id, fallback: false }
      : { value: beginningValue, sessionDate: null, sessionId: null, fallback: beginningFallback },
    purchases: { total: totalPurchases, invoiceCount: invoices.length + invoiceSessions.length },
    endingInventory: endSession
      ? { value: endingValue, sessionDate: endSession.sessionDate, sessionId: endSession.id, fallback: false }
      : { value: 0, sessionDate: null, sessionId: null, fallback: endingFallback },
    cogs,
    foodSales,
    foodCostPct,
    byCategory,
  })
}
