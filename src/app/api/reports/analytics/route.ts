import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { volatilityOf, stabilityOf, scanLinePricePerBase, offerPricePerBase } from '@/lib/supplier-offers'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'
import { resolveLocationRcIds } from '@/lib/rc-scope'
import { fetchRecipeWithCost, dishServingCost } from '@/lib/recipeCosts'
import { dedupeSalesEntries } from '@/lib/sales-dedup'

function startOf(daysAgo: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(0, 0, 0, 0)
  return d
}

function isoDate(d: Date) {
  return d.toISOString().split('T')[0]
}

/**
 * Analytics request context. The time window is either an absolute calendar range
 * (`from`/`to`, parsed at UTC boundaries — same convention as Overview/COGS) or the
 * legacy rolling `days` window. `win` is the inclusive [since, until] filter every
 * windowed query uses; `prevWin` is the immediately-preceding equal-length window for
 * period-over-period deltas.
 *
 * RC scoping: `rcEq` filters NOT-NULL rc columns (SalesEntry/WastageLog/PrepLog);
 * `sessionRc` filters the nullable InvoiceSession.revenueCenterId (default RC also
 * matches legacy null sessions); `countRc` is the snapshot/count scope (default + All
 * read global counts, a non-default RC reads its own). Empty objects = no scope (All).
 */
interface Ctx {
  since: Date; until: Date; days: number
  win:     { gte: Date; lte: Date }
  prevWin: { gte: Date; lt: Date }
  rcId: string | null
  isDefault: boolean
  // A location lens widens these from a single rcId to an `{ in: [...] }` set.
  rcEq: { revenueCenterId?: string | { in: string[] } }
  sessionRc: Record<string, unknown>
  countRc: { revenueCenterId: string | null | { in: string[] } } | Record<string, never>
  // Location lens: the child RC ids, and whether the location owns the default
  // stock-pool RC (decides whether pooled `stockOnHand` counts toward its stock).
  locRcIds: string[] | null
  locOwnsDefault: boolean
}

// ── GET /api/reports/analytics?section=overview|sales|inventory|purchasing ──
//   &from=YYYY-MM-DD&to=YYYY-MM-DD  (absolute range, preferred)  OR  &days=30 (legacy)
//   &rcId=<id>&isDefault=true       (scope to a revenue center; omit for All)
export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const section = searchParams.get('section') ?? 'overview'
  const days    = parseInt(searchParams.get('days') ?? '30', 10)

  const fromParam = searchParams.get('from')
  const toParam   = searchParams.get('to')
  const hasRange  = !!fromParam && !!toParam
  const since = hasRange ? new Date(`${fromParam}T00:00:00.000Z`) : startOf(days)
  const until = hasRange ? new Date(`${toParam}T23:59:59.999Z`)   : new Date()
  const spanMs = until.getTime() - since.getTime()
  const prevSince = hasRange ? new Date(since.getTime() - spanMs) : startOf(days * 2)

  const rcId      = searchParams.get('rcId') || null
  const isDefault = searchParams.get('isDefault') === 'true'
  const locationId = searchParams.get('locationId')
  const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null
  // Does the location own the default stock-pool RC? (B5 — decides whether the
  // pooled stockOnHand belongs to this location's inventory value.)
  const locDefaultRcIds = locRcIds
    ? (await prisma.revenueCenter.findMany({
        where: { id: { in: locRcIds }, isDefault: true }, select: { id: true },
      })).map(r => r.id)
    : []

  const ctx: Ctx = locRcIds
    ? {
        since, until, days,
        win:     { gte: since, lte: until },
        prevWin: { gte: prevSince, lt: since },
        rcId: null, isDefault: false,
        // Location lens: aggregate across all child RCs. NOT NULL models use a
        // plain `in`; NULLABLE models (sessions) also surface shared null rows.
        rcEq:      { revenueCenterId: { in: locRcIds } },
        sessionRc: { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] },
        countRc:   { revenueCenterId: { in: locRcIds } },
        locRcIds, locOwnsDefault: locDefaultRcIds.length > 0,
      }
    : {
        since, until, days,
        win:     { gte: since, lte: until },
        prevWin: { gte: prevSince, lt: since },
        rcId, isDefault,
        rcEq:      rcId ? { revenueCenterId: rcId } : {},
        sessionRc: rcId ? (isDefault ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] } : { revenueCenterId: rcId }) : {},
        countRc:   rcId && !isDefault ? { revenueCenterId: rcId } : { revenueCenterId: null },
        locRcIds: null, locOwnsDefault: false,
      }

  try {
    if (section === 'sales')    return NextResponse.json(await getSales(ctx))
    if (section === 'inventory') return NextResponse.json(await getInventory(ctx))
    if (section === 'purchasing') return NextResponse.json(await getPurchasing(ctx))
    return NextResponse.json({ error: 'Unknown section' }, { status: 400 })
  } catch (err) {
    console.error('[analytics]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// ── Sales ─────────────────────────────────────────────────────────────────────
async function getSales(ctx: Ctx) {
  const { win, days, rcEq } = ctx
  const [salesEntries, topItems, weeklyData] = await Promise.all([
    prisma.salesEntry.findMany({
      where: { date: win, ...rcEq },
      include: { lineItems: { include: { recipe: { select: { name: true, menuPrice: true } } } } },
      orderBy: { date: 'asc' },
    }),
    // top menu items by qty sold
    prisma.saleLineItem.groupBy({
      by: ['recipeId'],
      where: { sale: { date: win, ...rcEq } },
      _sum: { qtySold: true },
      orderBy: { _sum: { qtySold: 'desc' } },
      take: 15,
    }),
    // weekly revenue + food sales
    prisma.salesEntry.findMany({
      where: { date: win, ...rcEq },
      select: { date: true, totalRevenue: true, foodSalesPct: true, revenueCenterId: true, periodType: true, source: true },
      orderBy: { date: 'asc' },
    }),
  ])

  // Enrich top items with spine-derived recipe cost (B6 — cost/foodCostPct were
  // hardcoded 0/null, leaving the cost-% column and the alerts card permanently
  // empty). fetchRecipeWithCost derives costPerPortion from the pack chain at read
  // time (nested-PREP safe). ≤15 recipes, fetched in parallel.
  const recipeIds = topItems.map(t => t.recipeId)
  const costed = await Promise.all(recipeIds.map(id => fetchRecipeWithCost(id)))
  const recipeMap = new Map(costed.filter((r): r is NonNullable<typeof r> => !!r).map(r => [r.id, r]))

  const topMenuItems = topItems.map(t => {
    const recipe = recipeMap.get(t.recipeId)
    const qty    = Number(t._sum.qtySold ?? 0)
    const menuPrice = recipe?.menuPrice ?? null
    // Per-serving cost with the totalCost/baseYieldQty fallback for menu dishes
    // that carry no portionSize (otherwise costPerPortion — and this column — is null).
    const { cost: perServing, foodCostPct } = recipe
      ? dishServingCost(recipe)
      : { cost: null, foodCostPct: null }
    const revenue = menuPrice != null ? menuPrice * qty : 0
    return {
      recipeId: t.recipeId,
      name:     recipe?.name ?? 'Unknown',
      qty,
      revenue,
      // Total line cost = per-serving cost × qty (comparable to `revenue`).
      cost:        perServing != null ? perServing * qty : 0,
      menuPrice,
      foodCostPct,
    }
  }).sort((a, b) => b.qty - a.qty)

  // Group daily sales into weekly buckets (dedupe manual↔Toast overlap first — B3)
  const weekMap = new Map<string, { revenue: number; foodSales: number; count: number }>()
  for (const s of dedupeSalesEntries(weeklyData)) {
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

  // Revenue summary (dedupe manual↔Toast overlap before summing — B3)
  const dedupedEntries = dedupeSalesEntries(salesEntries)
  const totalRevenue = dedupedEntries.reduce((s, e) => s + Number(e.totalRevenue), 0)
  const totalFoodSales = dedupedEntries.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
  const totalOrders = dedupedEntries.length

  return {
    summary: { totalRevenue, totalFoodSales, totalOrders },
    topMenuItems,
    weeklyRevenue,
    foodCostAlerts,
    period: days,
  }
}

// ── Inventory ─────────────────────────────────────────────────────────────────
async function getInventory(ctx: Ctx) {
  const { win, rcId, isDefault, countRc, locRcIds, locOwnsDefault } = ctx
  const [priceAlerts, items, countSessions] = await Promise.all([
    // Price changes are GLOBAL — PriceAlert has no RC column (a price change is
    // item-level, not revenue-center-specific). Windowed by the selected range.
    prisma.priceAlert.findMany({
      where: { createdAt: win },
      include: { inventoryItem: { select: { itemName: true, category: true, supplier: { select: { name: true } } } },
        session: { select: { supplierName: true, invoiceDate: true } } },
      orderBy: { changePct: 'desc' },
    }),
    prisma.inventoryItem.findMany({
      where: { isActive: true, isStocked: true },
      select: {
        id: true, itemName: true, category: true,
        stockOnHand: true, ...PRICING_SELECT,
        purchasePrice: true, lastCountDate: true,
        supplier: { select: { name: true } },
        stockAllocations: { select: { quantity: true, revenueCenterId: true } },
      },
      orderBy: { itemName: 'asc' },
    }),
    prisma.countSession.findMany({
      where: { status: 'FINALIZED', type: 'FULL', ...countRc },
      select: { id: true, sessionDate: true, finalizedAt: true, totalCountedValue: true, label: true },
      orderBy: { sessionDate: 'desc' },
      take: 6,
    }),
  ])

  // RC-aware current stock (point-in-time): default RC = stockOnHand; non-default =
  // its allocation; All = stockOnHand + every allocation. Mirrors the inventory page.
  const effStock = (i: typeof items[number]) => {
    // B5: Location lens sums only the location's child-RC stock — its own
    // allocations, plus the pooled stockOnHand iff the location owns the default RC.
    if (locRcIds) {
      const allocSum = i.stockAllocations
        .filter(a => locRcIds.includes(a.revenueCenterId))
        .reduce((s, a) => s + Number(a.quantity), 0)
      return (locOwnsDefault ? Number(i.stockOnHand) : 0) + allocSum
    }
    if (!rcId) return Number(i.stockOnHand) + i.stockAllocations.reduce((a, r) => a + Number(r.quantity), 0)
    if (isDefault) return Number(i.stockOnHand)
    const a = i.stockAllocations.find(x => x.revenueCenterId === rcId)
    return a ? Number(a.quantity) : 0
  }

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

  // Inventory value by category (RC-aware current stock)
  const byCategory: Record<string, { value: number; count: number }> = {}
  for (const i of items) {
    const val = effStock(i) * pricePerBaseUnit(asChainItem(i))
    if (!byCategory[i.category]) byCategory[i.category] = { value: 0, count: 0 }
    byCategory[i.category].value += val
    byCategory[i.category].count++
  }

  // Top value items (RC-aware current stock)
  const topValueItems = items
    .map(i => ({ ...i, invValue: effStock(i) * pricePerBaseUnit(asChainItem(i)) }))
    .sort((a, b) => b.invValue - a.invValue)
    .slice(0, 10)
    .map(i => ({ name: i.itemName, category: i.category, supplier: i.supplier?.name ?? '—', value: i.invValue, stock: effStock(i) }))

  // Inventory value trend from count sessions
  const valueTrend = countSessions.map(s => ({
    label: s.label,
    date:  isoDate(s.sessionDate),
    value: Number(s.totalCountedValue),
  })).reverse()

  const totalValue = items.reduce((s, i) => s + effStock(i) * pricePerBaseUnit(asChainItem(i)), 0)

  return {
    summary: { totalValue, totalItems: items.length, notCounted30, priceChanges: priceAlerts.length, priceIncreases: priceIncreases.length, priceDecreases: priceDecreases.length },
    topPriceChanges,
    supplierVolatility,
    topValueItems,
    valueTrend,
    byCategory: Object.entries(byCategory).map(([cat, d]) => ({ cat, ...d })).sort((a, b) => b.value - a.value),
    // Price changes & supplier volatility are global (no RC dimension on PriceAlert).
    priceChangesGlobal: true,
  }
}

// ── Purchasing ────────────────────────────────────────────────────────────────
async function getPurchasing(ctx: Ctx) {
  const { win, days, sessionRc } = ctx
  const [scanItems, supplierPrices] = await Promise.all([
    prisma.invoiceScanItem.findMany({
      where: { approved: true, splitToSessionId: null, session: { purchaseDate: win, ...sessionRc } },
      select: {
        rawDescription: true, rawQty: true, rawUnitPrice: true, rawLineTotal: true,
        matchedItem: { select: { itemName: true, category: true } },
        session: { select: { supplierName: true, supplierId: true, purchaseDate: true, supplier: { select: { name: true } } } },
      },
    }),
    prisma.inventorySupplierPrice.findMany({
      where: { lastUpdated: win },
      include: { inventoryItem: { select: { itemName: true, category: true } }, supplier: { select: { name: true } } },
      orderBy: { lastUpdated: 'desc' },
      take: 50,
    }),
  ])

  // Spend by supplier — fold OCR name variants ("SYSCO Canada, Inc." vs
  // "Sysco Canada, Inc. - Vancouver") into ONE row by grouping on supplierId and
  // showing the canonical Supplier.name. Only sessions with no linked supplier fall
  // back to their raw OCR name (each distinct unlinked name stays its own row).
  const bySupplier: Record<string, { name: string; spend: number; lines: number }> = {}
  for (const item of scanItems) {
    const s = item.session
    const key  = s.supplierId ?? s.supplierName ?? 'Unknown'
    const name = s.supplier?.name ?? s.supplierName ?? 'Unknown'
    if (!bySupplier[key]) bySupplier[key] = { name, spend: 0, lines: 0 }
    bySupplier[key].spend += Number(item.rawLineTotal ?? 0)
    bySupplier[key].lines++
  }
  const supplierSpend = Object.values(bySupplier)
    .map(d => ({ name: d.name, spend: d.spend, lines: d.lines }))
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
    if (!item.session.purchaseDate) continue
    const d = new Date(item.session.purchaseDate)
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
    multiSupplier: await buildMultiSupplierBlock(ctx.win),
    period: days,
    // Multi-supplier price comparison & volatility are global (offers have no RC).
    multiSupplierGlobal: true,
  }
}

// ── Multi-supplier comparison (purchasing section) ───────────────────────────
// Global by nature — supplier offers (InventorySupplierPrice) carry no revenue center.
async function buildMultiSupplierBlock(win: { gte: Date; lte: Date }) {
  // Items with offers from 2+ suppliers
  const offers = await prisma.inventorySupplierPrice.findMany({
    include: { inventoryItem: { select: { id: true, itemName: true, baseUnit: true, packChain: true } } },
  })
  const byItem = new Map<string, typeof offers>()
  for (const o of offers) {
    if (!byItem.has(o.inventoryItemId)) byItem.set(o.inventoryItemId, [])
    byItem.get(o.inventoryItemId)!.push(o)
  }

  const lines = await prisma.invoiceScanItem.findMany({
    where: {
      approved: true,
      splitToSessionId: null,
      // CREATE_NEW = the invoice that created the item also received its first stock.
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] },
      matchedItemId: { in: [...byItem.keys()] },
      session: { status: 'APPROVED', purchaseDate: win },
    },
    select: {
      matchedItemId: true, rawLineTotal: true,
      newPrice: true, rate: true, rateUOM: true, pricingMode: true,
      invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
      session: { select: { supplierName: true, supplierId: true } },
    },
  })

  // Same reliability rule as the backfill: a per-case line without its own
  // pack data can't be normalized trustworthily — exclude from report math.
  const reliableLines = lines.filter(l =>
    l.pricingMode === 'per_weight' || (l.invoicePackQty !== null && l.invoicePackSize !== null)
  )

  // Canonical display names for volatility keys that are supplier ids.
  const supplierNameById = new Map(
    (await prisma.supplier.findMany({ select: { id: true, name: true } })).map(s => [s.id, s.name]),
  )

  const items: Array<{
    itemId: string; name: string; baseUnit: string | null
    offers: Array<{ supplier: string; ppb: number; isPrimary: boolean }>
    spreadPct: number
    potentialSaving: number
  }> = []
  let totalSaving = 0

  for (const [itemId, itemOffers] of byItem) {
    if (itemOffers.length < 2) continue
    const inv = itemOffers[0].inventoryItem
    const offerList = itemOffers
      .map(o => ({ supplier: o.supplierName, ppb: offerPricePerBase(o), isPrimary: o.isPrimary }))
      .filter(o => o.ppb > 0)
      .sort((a, b) => a.ppb - b.ppb)
    if (offerList.length < 2) continue
    const minPPB = offerList[0].ppb
    const maxPPB = offerList[offerList.length - 1].ppb
    const spreadPct = Math.round(((maxPPB - minPPB) / minPPB) * 100)

    // Savings: for every line of this item in the window, what you paid above
    // the cheapest offer's $/base. lineTotal × (1 − minPPB / paidPPB).
    let saving = 0
    for (const l of reliableLines) {
      if (l.matchedItemId !== itemId || !l.rawLineTotal) continue
      const paidPPB = scanLinePricePerBase(l, inv)
      if (!paidPPB || paidPPB <= minPPB) continue
      saving += Number(l.rawLineTotal) * (1 - minPPB / paidPPB)
    }
    totalSaving += saving
    items.push({ itemId, name: inv.itemName, baseUnit: inv.baseUnit, offers: offerList, spreadPct, potentialSaving: Math.round(saving * 100) / 100 })
  }
  items.sort((a, b) => b.potentialSaving - a.potentialSaving)

  // Most volatile (item, supplier) pairs over the window, from line history.
  const histKey = (id: string, s: string) => `${id}|${s}`
  const hist = new Map<string, number[]>()
  const itemMeta = new Map<string, { name: string; inv: { packChain: unknown; baseUnit: string | null } }>()
  for (const o of offers) itemMeta.set(o.inventoryItemId, { name: o.inventoryItem.itemName, inv: o.inventoryItem })
  for (const l of reliableLines) {
    // Key by supplier identity (id when the session resolved one) so raw OCR
    // name variants of the same supplier land in one histogram.
    const s = l.session?.supplierId ?? l.session?.supplierName
    const meta = l.matchedItemId ? itemMeta.get(l.matchedItemId) : null
    if (!s || !meta) continue
    const ppb = scanLinePricePerBase(l, meta.inv)
    if (ppb === null) continue
    const k = histKey(l.matchedItemId!, s)
    if (!hist.has(k)) hist.set(k, [])
    hist.get(k)!.push(ppb)
  }
  const volatile = [...hist.entries()]
    .map(([k, prices]) => {
      // Split on the FIRST separator only — item ids never contain '|', but
      // free-text supplier names could.
      const sep = k.indexOf('|')
      const itemId = k.slice(0, sep)
      const supplierKey = k.slice(sep + 1)
      const supplier = supplierNameById.get(supplierKey) ?? supplierKey
      const v = volatilityOf(prices)
      return { name: itemMeta.get(itemId)?.name ?? '?', supplier, volatility: v, stability: stabilityOf(v), purchases: prices.length }
    })
    .filter(e => e.volatility !== null)
    .sort((a, b) => (b.volatility ?? 0) - (a.volatility ?? 0))
    .slice(0, 8)

  return { items: items.slice(0, 12), totalSaving: Math.round(totalSaving * 100) / 100, volatile }
}
