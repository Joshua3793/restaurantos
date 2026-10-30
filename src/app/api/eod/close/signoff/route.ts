import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal, computeTempsReady, computeProgress, loadStationsClosed } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const user = await requireSession('LEAD')
    const rcId = String((await req.json()).rcId ?? '')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const date = businessDateLocal()

    const close = await prisma.eodClose.upsert({
      where: { revenueCenterId_businessDate: { revenueCenterId: rcId, businessDate: date } },
      create: { revenueCenterId: rcId, businessDate: date },
      update: {},
      select: { id: true },
    })
    // The gate: temps ready AND every station's closing run signed off.
    const [stations, temps] = await Promise.all([
      loadStationsClosed(rcId),
      computeTempsReady(rcId, date),
    ])
    const progress = computeProgress(stations, temps)
    if (!progress.ready) return NextResponse.json({ error: 'Not ready to close', progress }, { status: 409 })

    const dayStart = new Date(`${date}T00:00:00.000Z`)
    const dayEnd = new Date(`${date}T23:59:59.999Z`)
    const [sales, purchases] = await Promise.all([
      prisma.salesEntry.findMany({ where: { date: { gte: dayStart, lte: dayEnd }, revenueCenterId: rcId }, select: { totalRevenue: true, foodSalesPct: true, covers: true } }),
      prisma.invoiceScanItem.aggregate({
        where: { approved: true, splitToSessionId: null, session: { purchaseDate: { gte: dayStart, lte: dayEnd }, revenueCenterId: rcId } },
        _sum: { rawLineTotal: true },
      }),
    ])
    const netSales = sales.reduce((s, e) => s + Number(e.totalRevenue), 0)
    const foodSales = sales.reduce((s, e) => s + Number(e.totalRevenue) * Number(e.foodSalesPct), 0)
    const covers = sales.reduce((s, e) => s + (e.covers ?? 0), 0)
    const foodCostDollars = Number(purchases._sum.rawLineTotal ?? 0)
    const signedOffAt = new Date()
    const snapshot = {
      netSales, covers, foodCostDollars,
      foodCostPct: foodSales > 0 ? (foodCostDollars / foodSales) * 100 : null,
      checklist: { done: progress.done, total: progress.total },
      stations: { signed: progress.stationsSigned, total: progress.stationsTotal },
      tempsReady: progress.tempsReady,
      signedOffByName: user.name ?? user.email ?? null,
      signedOffAt: signedOffAt.toISOString(),
    }

    const updated = await prisma.eodClose.update({
      where: { id: close.id },
      data: { status: 'CLOSED', signedOffBy: user.id, signedOffByName: user.name ?? user.email ?? null, signedOffAt, snapshot },
      select: { id: true, status: true, signedOffByName: true, signedOffAt: true, snapshot: true },
    })
    return NextResponse.json({
      close: {
        id: updated.id, status: updated.status,
        signedOffByName: updated.signedOffByName, signedOffAt: updated.signedOffAt,
        // Shift Leads run the close but never see money (see the clearance
        // ladder: "No cost or money"). `snapshot` still gets WRITTEN above —
        // it's the point-in-time valuation the close captures — but a Lead
        // signing off their own close must not have netSales/foodCostDollars/
        // foodCostPct echoed straight back in the response body. Omitted
        // entirely rather than nulled, matching GET .../close.
        ...(user.role === 'LEAD' ? {} : { snapshot: updated.snapshot }),
      },
      progress,
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/eod/close/signoff', e)
    return NextResponse.json({ error: 'Failed to sign off' }, { status: 500 })
  }
}
