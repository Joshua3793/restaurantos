import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { businessDateLocal, computeTempsReady, computeProgress } from '@/lib/eod-close'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const user = await requireSession('MANAGER')
    const rcId = String((await req.json()).rcId ?? '')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const date = businessDateLocal()

    const close = await prisma.eodClose.upsert({
      where: { revenueCenterId_businessDate: { revenueCenterId: rcId, businessDate: date } },
      create: { revenueCenterId: rcId, businessDate: date },
      update: {},
      select: { id: true },
    })
    const [items, entries, temps] = await Promise.all([
      prisma.eodCheckItem.findMany({ where: { revenueCenterId: rcId, isActive: true }, select: { id: true, isBlocker: true } }),
      prisma.eodCheckEntry.findMany({ where: { closeId: close.id, done: true }, select: { itemId: true } }),
      computeTempsReady(rcId, date),
    ])
    const doneIds = new Set(entries.map(e => e.itemId))
    const progress = computeProgress(items, doneIds, temps)
    if (!progress.ready) return NextResponse.json({ error: 'Not ready to close', progress }, { status: 409 })

    const dayStart = new Date(`${date}T00:00:00.000Z`)
    const dayEnd = new Date(`${date}T23:59:59.999Z`)
    const [sales, purchases] = await Promise.all([
      prisma.salesEntry.findMany({ where: { date: { gte: dayStart, lte: dayEnd }, revenueCenterId: rcId }, select: { totalRevenue: true, foodSalesPct: true, covers: true } }),
      prisma.invoiceScanItem.aggregate({
        where: { approved: true, splitToSessionId: null, session: { approvedAt: { gte: dayStart, lte: dayEnd }, revenueCenterId: rcId } },
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
      tempsReady: progress.tempsReady,
      signedOffByName: user.name ?? user.email ?? null,
      signedOffAt: signedOffAt.toISOString(),
    }

    const updated = await prisma.eodClose.update({
      where: { id: close.id },
      data: { status: 'CLOSED', signedOffBy: user.id, signedOffByName: user.name ?? user.email ?? null, signedOffAt, snapshot },
      select: { id: true, status: true, signedOffByName: true, signedOffAt: true, snapshot: true },
    })
    return NextResponse.json({ close: updated, progress })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/eod/close/signoff', e)
    return NextResponse.json({ error: 'Failed to sign off' }, { status: 500 })
  }
}
