// src/app/api/invoices/kpis/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { invoiceSpendByRc, type RcSpendResult } from '@/lib/invoice-spend'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveLocationRcIds } from '@/lib/rc-scope'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'
  const locationId = searchParams.get('locationId')
  const locRcIds = locationId ? await resolveLocationRcIds(user, locationId) : null

  // Session-scoped RC filter for the secondary counts (alerts / review / exceptions).
  // Default RC also sees legacy null-RC sessions; non-default RC sees only its own.
  const rcWhere = locRcIds
    ? { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] }
    : rcId
      ? (isDefault
          ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
          : { revenueCenterId: rcId })
      : {}

  const now = new Date()

  // ISO week: Monday-based
  const dayOfWeek = now.getDay()
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const weekStart = new Date(now)
  weekStart.setDate(now.getDate() + diffToMonday)
  weekStart.setHours(0, 0, 0, 0)

  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekStart.getDate() + 7)  // Sunday 23:59:59 (exclusive upper bound = next Monday)

  const prevWeekStart = new Date(weekStart)
  prevWeekStart.setDate(weekStart.getDate() - 7)
  const prevWeekEnd = new Date(weekStart) // prevWeekEnd === weekStart (exclusive end for previous ISO week)

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  // Spend is attributed per-RC by `invoiceSpendByRc` (the single source of truth):
  // each line → its effective RC, skip/pending → default RC, invoice tax/extra →
  // the invoice's active RC. This matches what lands in the RC's expenses.
  const [week, prevWeek, month, priceAlertCount, awaitingCount, catLines] = await Promise.all([
    invoiceSpendByRc(weekStart, weekEnd),
    invoiceSpendByRc(prevWeekStart, prevWeekEnd),
    invoiceSpendByRc(monthStart, monthEnd),
    prisma.priceAlert.count({
      where: {
        acknowledged: false,
        ...(rcId || locRcIds ? { session: rcWhere } : {}),
      },
    }),
    prisma.invoiceSession.count({
      where: { AND: [{ status: 'REVIEW' }, rcWhere] },
    }),
    // Category breakdown for the month, scoped to the requested RC via the line-level
    // split (clone) mechanism — approved, non-split lines grouped by item category.
    prisma.invoiceScanItem.findMany({
      where: {
        approved: true,
        splitToSessionId: null,
        session: { status: 'APPROVED', purchaseDate: { gte: monthStart, lt: monthEnd }, ...rcWhere },
      },
      select: { rawLineTotal: true, matchedItem: { select: { category: true } } },
    }),
  ])

  // Exceptions: unmatched scan items in REVIEW sessions
  const exceptionsCount = await prisma.invoiceScanItem.count({
    where: { matchedItemId: null, session: { status: 'REVIEW' } },
  })

  const pickSpend = (r: RcSpendResult): number => {
    if (!rcId) {
      let t = 0
      for (const v of r.byRc.values()) t += v
      return t
    }
    return r.byRc.get(rcId) ?? 0
  }
  const pickCount = (r: RcSpendResult): number =>
    rcId ? (r.invoiceCountByRc.get(rcId) ?? 0) : r.totalInvoices

  const weekSpend = pickSpend(week)
  const prevWeekSpend = pickSpend(prevWeek)
  const weekSpendChangePct = prevWeekSpend === 0
    ? 0
    : Math.round(((weekSpend - prevWeekSpend) / prevWeekSpend) * 100)

  // Group line items by category
  const categoryMap: Record<string, number> = {}
  for (const item of catLines) {
    const cat = item.matchedItem?.category
    if (!cat) continue
    categoryMap[cat] = (categoryMap[cat] ?? 0) + Number(item.rawLineTotal ?? 0)
  }
  const topCategories = Object.entries(categoryMap)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([category, spend]) => ({ category, spend }))

  return NextResponse.json({
    weekSpend,
    weekSpendChangePct,
    monthSpend: pickSpend(month),
    monthInvoiceCount: pickCount(month),
    priceAlertCount,
    awaitingApprovalCount: awaitingCount,
    exceptionsCount,
    topCategories,
  }, {
    headers: { 'Cache-Control': 'private, max-age=10, stale-while-revalidate=60' },
  })
}
