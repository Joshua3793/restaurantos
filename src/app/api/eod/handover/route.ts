import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

// The most recent CLOSED close BEFORE today for the RC — the artifact the next
// morning's Pass opens with ("From last night's close" band). Returns the close
// regardless of whether a handover note was written: the reconciled snapshot
// (netSales/covers/foodCostPct) and sign-off time are useful on their own, and
// the note is just one optional field of the payload.
//
// The sign-off snapshot froze the day's sales at the instant the manager clicked
// close — often BEFORE the overnight Toast sync landed the real numbers, leaving
// netSales/covers stuck at 0. So we RE-COMPUTE netSales/covers/foodCost live for
// the close's business date (same RC-scoped math as sign-off) and merge them over
// the frozen snapshot: the figures self-heal as sales arrive, while who/when and
// the checklist/temps state stay as-recorded at close.
export async function GET(req: NextRequest) {
  try {
    await requireSession('MANAGER')
    const rcId = new URL(req.url).searchParams.get('rcId')
    if (!rcId) return NextResponse.json(null)
    const today = businessDateLocal()
    const close = await prisma.eodClose.findFirst({
      where: { revenueCenterId: rcId, status: 'CLOSED', businessDate: { lt: today } },
      orderBy: { businessDate: 'desc' },
      select: {
        handoverNote: true,
        signedOffByName: true,
        signedOffAt: true,
        businessDate: true,
        snapshot: true,
      },
    })
    if (!close) return NextResponse.json(null)

    // Live-reconcile the close's business date. Sales are stored date-only at UTC
    // midnight, so bracket the business date at UTC — identical window to sign-off.
    const dayStart = new Date(`${close.businessDate}T00:00:00.000Z`)
    const dayEnd = new Date(`${close.businessDate}T23:59:59.999Z`)
    const [sales, purchases] = await Promise.all([
      prisma.salesEntry.findMany({
        where: { date: { gte: dayStart, lte: dayEnd }, revenueCenterId: rcId },
        select: { totalRevenue: true, foodSalesPct: true, covers: true },
      }),
      prisma.invoiceScanItem.aggregate({
        where: { approved: true, splitToSessionId: null, session: { purchaseDate: { gte: dayStart, lte: dayEnd }, revenueCenterId: rcId } },
        _sum: { rawLineTotal: true },
      }),
    ])
    const netSales = sales.reduce((s, e) => s + Number(e.totalRevenue), 0)
    const foodSales = sales.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
    const covers = sales.reduce((s, e) => s + (e.covers ?? 0), 0)
    const foodCostDollars = Number(purchases._sum.rawLineTotal ?? 0)
    // Only override once the day actually has sales — an empty live window (a
    // closed day, or sales not yet synced) shouldn't blank a snapshot that had figures.
    const frozen = (close.snapshot ?? {}) as Record<string, unknown>
    const reconciled = sales.length > 0
      ? {
          netSales, covers, foodCostDollars,
          foodCostPct: foodSales > 0 ? (foodCostDollars / foodSales) * 100 : null,
        }
      : {}

    return NextResponse.json(
      { ...close, snapshot: { ...frozen, ...reconciled } },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/eod/handover', e)
    return NextResponse.json(null)
  }
}
